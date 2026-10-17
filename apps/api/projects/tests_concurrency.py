"""Concurrency tests: simultaneous final-owner mutations never leave
an active Project without an Owner.

The Project row lock serializes owner-set validation and mutation; the
second operation revalidates the owner set after acquiring the lock.

Also: StatusDefinition configuration vs. Board reorder (AP-01) —
update_status_definition() and reposition_work_item() must serialize
under the same Project row lock so a category change can never commit
while a reorder already decided against the definition's old category.
The parallelism test proves that actual contention at the database
level: the config backend is observed via pg_blocking_pids() and
pg_locks waiting for the Project row lock held by the reorder
backend, and the held reorder is then released by event (no fixed
hold). A serial companion test covers the config-commits-first
outcome deterministically.
"""

import threading
import time
from unittest import mock

from django.db import connection as _db

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership

import work_items.services as work_item_services
from work_items.models import WorkItem
from work_items.services import (
    WorkItemDomainError,
    create_work_item,
    reposition_work_item,
)

from .configuration_services import (
    ConfigurationError,
    update_status_definition,
)
from .models import Project, ProjectMembership, WorkItemStatusDefinition
from .services import (
    ProjectDomainError,
    change_membership_role,
    create_project,
    remove_membership,
)

User = get_user_model()


class FinalOwnerConcurrencyTest(TransactionTestCase):
    def setUp(self):
        self.owner_a = User.objects.create_user(username="owner_a", password="Pass1!")
        self.owner_b = User.objects.create_user(username="owner_b", password="Pass1!")
        self.group = ResearchGroup.objects.create(name="G", created_by=self.owner_a)
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner_a,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner_b,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.owner_a,
            name="P",
        )
        ProjectMembership.objects.create(
            project=self.project,
            user=self.owner_b,
            role=ProjectMembership.Role.OWNER,
            added_by=self.owner_a,
        )

    def _owner_count(self):
        return (
            ProjectMembership.objects.filter(
                project=self.project,
                role=ProjectMembership.Role.OWNER,
            ).count()
        )

    def test_simultaneous_final_owner_removal_and_downgrade(
        self,
    ):
        # Two Owners. T1 (actor B) removes A; T2 (actor A) downgrades B.
        # Whichever commits second must be rejected: the owner set it
        # validated must have changed under the lock.
        membership_a = ProjectMembership.objects.get(
            project=self.project, user=self.owner_a
        )
        membership_b = ProjectMembership.objects.get(
            project=self.project, user=self.owner_b
        )

        results = {}
        barrier = threading.Barrier(2)

        def worker_remove():
            barrier.wait()
            try:
                remove_membership(
                    membership=membership_a,
                    actor=self.owner_b,
                )
                results["remove"] = None
            except ProjectDomainError as exc:
                results["remove"] = exc.message
            finally:
                _db.close()

        def worker_downgrade():
            barrier.wait()
            try:
                change_membership_role(
                    membership=membership_b,
                    actor=self.owner_a,
                    new_role=ProjectMembership.Role.MEMBER,
                )
                results["downgrade"] = None
            except ProjectDomainError as exc:
                results["downgrade"] = exc.message
            finally:
                _db.close()

        threads = [
            threading.Thread(target=worker_remove),
            threading.Thread(target=worker_downgrade),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        # The invariant: at least one owner always remains.
        self.assertGreaterEqual(self._owner_count(), 1)

        # Exactly one of the two conflicting operations succeeded.
        succeeded = sum(1 for value in results.values() if value is None)
        self.assertEqual(succeeded, 1)
        self.assertEqual(len(results), 2)


class StatusConfigVsReorderConcurrencyTest(TransactionTestCase):
    """update_status_definition() vs. reposition_work_item() on one
    still-unreferenced StatusDefinition — the category-change race.

    The two operations must serialize under the same Project row lock,
    so a category change can never commit while a reorder has already
    decided against the definition's old category. Two tests, with
    precisely distinct claims:

    - ``test_category_change_serialized_against_reorder`` is the TRUE
      PARALLELISM test. Two independent PostgreSQL sessions
      (thread-local Django connections, proven by distinct backend
      PIDs) interleave: the reorder holds the Project row lock at its
      decision point, and the config side requests the same lock. The
      contention is proven from PostgreSQL itself — the test polls
      ``pg_blocking_pids()`` and ``pg_locks`` until the config backend
      is observed actually waiting for the lock held by the reorder
      backend, on the Project row. Only after that observation is the
      held reorder released (event-based; no fixed hold). Both
      operations then finish controlled, and the serialized end state
      is asserted.

    - ``test_serial_config_committed_before_reorder_uses_fresh_category``
      is a purely SERIAL regression test: no threads, no independent
      sessions. The category change commits completely before the
      reorder starts, and the reorder must use the fresh definition
      state.
    """

    #: Main-thread bound for the reorder worker reaching the decision
    #: point (holding the Project row lock).
    REACH_DECISION_TIMEOUT_SECONDS = 30.0
    #: Main-thread bound for the config worker opening its own
    #: database session before requesting the Project row lock.
    CONFIG_START_TIMEOUT_SECONDS = 30.0
    #: Main-thread bound for observing the config backend's actual
    #: lock wait (bounded polling of pg_blocking_pids()/pg_locks).
    LOCK_OBSERVE_TIMEOUT_SECONDS = 15.0
    #: Poll interval of the lock observation (short, bounded).
    LOCK_POLL_INTERVAL_SECONDS = 0.05
    #: Safety bound for the held reorder waiting for release. The
    #: test's finally block always releases, so this never triggers in
    #: normal operation.
    RELEASE_WAIT_TIMEOUT_SECONDS = 30.0
    #: Join bound per worker thread.
    THREAD_JOIN_TIMEOUT_SECONDS = 60.0

    def setUp(self):
        self.owner = User.objects.create_user(
            username="config_race_owner", password="Pass1!"
        )
        self.group = ResearchGroup.objects.create(
            name="G", created_by=self.owner
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.owner,
            name="P",
        )
        # The seeded 'Review' definition: active, unreferenced.
        self.review_def = self.project.status_definitions.get(
            category=WorkItemStatusDefinition.Category.REVIEW
        )
        task_type = self.project.type_definitions.get(name="Task")
        self.work_item = create_work_item(
            project=self.project,
            actor=self.owner,
            type_definition_id=task_type.pk,
            title="Raced Item",
        )

    def _observe_lock_wait(self, waiter_pid, holder_pid):
        """Boundedly poll the server until the waiter backend is
        observed waiting for a lock held by the holder backend, on
        the Project row.

        The evidence comes from PostgreSQL itself, not from
        application signals. One server-side query per poll:

        - ``pg_blocking_pids(waiter_pid)``: the server-computed set
          of backend PIDs currently blocking the waiter (primary
          proof of the lock wait).
        - ``pg_stat_activity.wait_event_type`` of the waiter: the
          waiter must be blocked in the lock manager ('Lock').
        - a ``pg_locks`` pin of the contended resource to the
          Project row, covering both contention paths of PostgreSQL
          row locks:
          * heavyweight path — the waiter holds an ungranted TUPLE
            lock on ``projects_project`` and the holder a granted
            tuple lock on the same table;
          * fast-path path — the holder's row lock is a fast-path
            tuple lock (invisible in pg_locks), and the waiter
            queues on the holder's TRANSACTION (ungranted
            transactionid lock on the holder's xid) while holding
            its own heavyweight tuple lock on the Project row it
            requests (the first lock acquisition of the config
            transaction).

        Returns an evidence dict as soon as the holder is listed as
        a blocker of the waiter, or ``None`` if that wait is not
        observed within ``LOCK_OBSERVE_TIMEOUT_SECONDS``.
        """
        deadline = time.monotonic() + self.LOCK_OBSERVE_TIMEOUT_SECONDS
        evidence = None
        while True:
            with _db.connection.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT
                        pg_blocking_pids(%(waiter)s) AS blocking_pids,
                        (
                            SELECT wait_event_type
                            FROM pg_stat_activity
                            WHERE pid = %(waiter)s
                        ) AS waiter_wait_event_type,
                        EXISTS (
                            SELECT 1
                            FROM pg_locks waiting
                            WHERE waiting.pid = %(waiter)s
                              AND NOT waiting.granted
                              AND (
                                  (
                                      -- heavyweight tuple lock wait
                                      -- on the Project row
                                      waiting.locktype = 'tuple'
                                      AND waiting.relation =
                                          '{Project._meta.db_table}'::regclass
                                      AND EXISTS (
                                          SELECT 1
                                          FROM pg_locks holding
                                          WHERE holding.pid =
                                              %(holder)s
                                            AND holding.granted
                                            AND holding.locktype
                                                = 'tuple'
                                            AND holding.relation =
                                                waiting.relation
                                      )
                                  )
                                  OR (
                                      -- fast-path row lock wait: the
                                      -- holder's row lock is invisible
                                      -- in pg_locks; the waiter queues
                                      -- on the holder's transaction
                                      -- while holding its own
                                      -- heavyweight tuple lock on the
                                      -- requested Project row
                                      waiting.locktype =
                                          'transactionid'
                                      AND waiting.transactionid = (
                                          SELECT holding.transactionid
                                          FROM pg_locks holding
                                          WHERE holding.pid =
                                              %(holder)s
                                            AND holding.granted
                                            AND holding.locktype
                                                = 'transactionid'
                                            AND holding.mode =
                                                'ExclusiveLock'
                                          LIMIT 1
                                      )
                                      AND EXISTS (
                                          SELECT 1
                                          FROM pg_locks requested
                                          WHERE requested.pid =
                                              %(waiter)s
                                            AND requested.granted
                                            AND NOT requested.fastpath
                                            AND requested.locktype
                                                = 'tuple'
                                            AND requested.relation =
                                                '{Project._meta.db_table}'::regclass
                                      )
                                  )
                              )
                        ) AS waiting_on_holder_project_row
                    """,
                    {"waiter": waiter_pid, "holder": holder_pid},
                )
                row = cursor.fetchone()
            evidence = {
                "blocking_pids": list(row[0] or []),
                "waiter_wait_event_type": row[1],
                "waiting_on_holder_project_row": bool(row[2]),
            }
            if holder_pid in evidence["blocking_pids"]:
                return evidence
            if time.monotonic() >= deadline:
                return None
            time.sleep(self.LOCK_POLL_INTERVAL_SECONDS)

    def test_category_change_serialized_against_reorder(self):
        """True parallelism: prove the Project row lock contention at
        the database level.

        T1 (reorder) holds the Project row lock at its decision point
        (inside the reorder transaction, at the status-definition
        resolution that decides the move) and is held there by event.
        T2 (config) opens its own PostgreSQL session and requests the
        same Project row lock. The test observes — from PostgreSQL
        itself, via ``pg_blocking_pids()`` and ``pg_locks`` — that the
        config backend is actually WAITING for the lock held by the
        reorder backend, on the Project row. Only after that
        observation is the held reorder released (event-based; no
        fixed hold). T1 commits first (the deterministic winner of
        this interleaving), T2 then revalidates under the lock and
        must be rejected by the existing reference rule.
        """
        t1_at_decision = threading.Event()
        t2_ready = threading.Event()
        release = threading.Event()
        results = {}
        backend_pids = {}
        real_resolve = work_item_services._resolve_status_definition

        def hooked_resolve(project, status_def_id):
            defn = real_resolve(project, status_def_id)
            if defn.pk == self.review_def.pk:
                # Decision point: T1 holds the Project row lock and
                # has just resolved the target definition's category.
                # Hold the reorder transaction open until the test
                # observes T2's lock wait and releases (bounded; the
                # test's finally block always releases).
                t1_at_decision.set()
                release.wait(timeout=self.RELEASE_WAIT_TIMEOUT_SECONDS)
            return defn

        def worker_reorder():
            try:
                # Open this thread's own database session and record
                # its server-assigned PID (independent session proof).
                _db.ensure_connection()
                backend_pids["reorder"] = _db.connection.info.backend_pid
                reposition_work_item(
                    work_item=self.work_item,
                    actor=self.owner,
                    status_definition_id=self.review_def.pk,
                    before_work_item_id=None,
                )
                results["reorder"] = None
            except (WorkItemDomainError, ConfigurationError) as exc:
                results["reorder"] = exc
            except Exception as exc:  # recorded, asserted below
                results["reorder"] = exc
            finally:
                _db.close()

        def worker_config():
            try:
                # Open this thread's own database session and record
                # its server-assigned PID (independent session proof).
                _db.ensure_connection()
                backend_pids["config"] = _db.connection.info.backend_pid
                # Own session is open; the next service call requests
                # the Project row lock inside its transaction.
                t2_ready.set()
                update_status_definition(
                    definition=self.review_def,
                    actor=self.owner,
                    category=WorkItemStatusDefinition.Category.DONE,
                )
                results["config"] = None
            except ConfigurationError as exc:
                results["config"] = exc
            except Exception as exc:  # recorded, asserted below
                results["config"] = exc
            finally:
                _db.close()

        t1 = threading.Thread(target=worker_reorder)
        t2 = threading.Thread(target=worker_config)

        try:
            with mock.patch.object(
                work_item_services,
                "_resolve_status_definition",
                hooked_resolve,
            ):
                t1.start()
                self.assertTrue(
                    t1_at_decision.wait(
                        timeout=self.REACH_DECISION_TIMEOUT_SECONDS
                    ),
                    "reorder worker did not reach the decision point; "
                    f"results={results!r}",
                )

                # T1 holds the Project row lock. Start the config
                # side on its own session.
                t2.start()
                self.assertTrue(
                    t2_ready.wait(
                        timeout=self.CONFIG_START_TIMEOUT_SECONDS
                    ),
                    "config worker did not open its database session; "
                    f"results={results!r}",
                )

                # Prove the actual lock wait at the database level:
                # the config backend must be observed waiting for a
                # lock held by the reorder backend, on the Project
                # row. A signal before the ORM call would not prove
                # that the database lock was actually requested.
                observed = self._observe_lock_wait(
                    waiter_pid=backend_pids["config"],
                    holder_pid=backend_pids["reorder"],
                )
                self.assertIsNotNone(
                    observed,
                    "config backend "
                    f"{backend_pids.get('config')} was never observed "
                    "waiting for a lock held by the reorder backend "
                    f"{backend_pids.get('reorder')}",
                )
                self.assertIn(
                    backend_pids["reorder"],
                    observed["blocking_pids"],
                    "the reorder backend is not listed as the blocker "
                    f"of the config backend: {observed!r}",
                )
                self.assertEqual(
                    observed["waiter_wait_event_type"],
                    "Lock",
                    "the config backend is not blocked in the lock "
                    f"manager: {observed!r}",
                )
                self.assertTrue(
                    observed["waiting_on_holder_project_row"],
                    "the config backend's lock wait is not on the "
                    "Project row held by the reorder backend: "
                    f"{observed!r}",
                )

                # Event-based release, now that the lock wait is
                # proven: the held reorder commits first.
                release.set()
        finally:
            # Cleanup on every path — including assertion and timeout
            # failures: always release the held decision point, then
            # terminate both workers in a controlled, bounded way.
            release.set()
            for thread in (t1, t2):
                thread.join(timeout=self.THREAD_JOIN_TIMEOUT_SECONDS)

        for thread in (t1, t2):
            self.assertFalse(
                thread.is_alive(),
                f"worker still alive after join: {thread.name}",
            )

        # Only controlled outcomes: both workers finished, neither
        # raised an unhandled error (a controlled domain rejection
        # is a valid outcome).
        self.assertEqual(set(results), {"reorder", "config"})
        self.assertIn(
            type(results["reorder"]), (type(None), WorkItemDomainError)
        )
        self.assertIn(
            type(results["config"]), (type(None), ConfigurationError)
        )
        # Two genuinely independent database sessions.
        self.assertEqual(
            len(set(backend_pids.values())), 2,
            "expected two independent database sessions",
        )

        # Fresh database reads (never the stale fixture instances).
        work_item = WorkItem.objects.get(pk=self.work_item.pk)
        definition = WorkItemStatusDefinition.objects.get(
            pk=self.review_def.pk
        )

        # Canonical completion invariant: a Work Item whose current
        # status category is 'done' must carry completed_at. The
        # pre-fix interleaving violates exactly this (move decided
        # for 'review', committed after the definition became
        # 'done').
        if (
            definition.category
            == WorkItemStatusDefinition.Category.DONE
            and work_item.status_definition_id == definition.pk
        ):
            self.assertIsNotNone(
                work_item.completed_at,
                "Work Item in a 'done' category without completed_at",
            )

        # The serialized contract: the reorder held the Project row
        # lock at the decision point, so it commits first and the
        # category change must be rejected by the existing reference
        # rule (the definition is referenced now).
        self.assertIsNone(results["reorder"])
        self.assertIsInstance(results["config"], ConfigurationError)
        self.assertIn(
            "referenced", str(results["config"])
        )
        self.assertEqual(
            definition.category,
            WorkItemStatusDefinition.Category.REVIEW,
        )

        # The move is a valid cross-category move to the CURRENT
        # (review) definition: referenced, uncompleted, first
        # position of the (then) empty review column.
        self.assertEqual(
            work_item.status_definition_id, definition.pk
        )
        self.assertIsNone(work_item.completed_at)
        self.assertEqual(work_item.board_position, 1)

    def test_serial_config_committed_before_reorder_uses_fresh_category(
        self,
    ):
        """SERIAL regression test — NOT a parallelism test.

        No threads and no independent sessions: the category change
        commits COMPLETELY before the reorder starts (single session,
        no interleaving). The reorder must then use the fresh
        definition state — target category, position, and completed_at
        all follow the CURRENT definition. This deterministically
        covers the config-commits-first outcome, which the true
        parallelism test above pins to the reorder-commits-first
        interleaving (the reorder deterministically holds the Project
        lock at its decision point).
        """
        updated = update_status_definition(
            definition=self.review_def,
            actor=self.owner,
            category=WorkItemStatusDefinition.Category.DONE,
        )
        self.assertEqual(
            updated.category, WorkItemStatusDefinition.Category.DONE
        )

        moved = reposition_work_item(
            work_item=self.work_item,
            actor=self.owner,
            status_definition_id=self.review_def.pk,
            before_work_item_id=None,
        )

        moved.refresh_from_db()
        definition = WorkItemStatusDefinition.objects.get(
            pk=self.review_def.pk
        )
        self.assertEqual(
            moved.status_definition_id, definition.pk
        )
        self.assertEqual(
            definition.category,
            WorkItemStatusDefinition.Category.DONE,
        )
        # Entered the done category: completion semantics applied
        # against the CURRENT definition.
        self.assertIsNotNone(moved.completed_at)
        self.assertEqual(moved.board_position, 1)
