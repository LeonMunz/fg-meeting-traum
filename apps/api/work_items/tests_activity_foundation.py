"""Tests for the Activity event foundation, proven through Work Items.

The canonical persisted Activity event concept is
``audit_history.AuditEvent``, recorded through
``audit_history.services.record_audit_event`` — see
``docs/domain/activity.md`` for the contract.

These tests pin the first-slice Work Item event set and prove each
persisted event carries enough *structured* context (no rendered
English strings as source of truth) for a later Activity projection
to reconstruct:

- WHO   — ``event.actor`` (FK to the acting User)
- WHAT  — ``event.event_type`` (stable code) +
          ``event.data["changes"]`` (structured diff; status summaries
          include the fixed semantic ``category``, so a completion is
          distinguishable from an ordinary status change)
- WHICH — ``event.work_item`` (FK to the affected WorkItem)
- WHERE — ``event.project`` + ``event.event.research_group``
          (access-control scope the later Activity feed must enforce,
          identical to the underlying object's boundaries)
- WHEN  — ``event.created_at`` (occurrence timestamp)

They also pin the transactional guarantee: an Activity event
participates in the same logical transaction as the Work Item
mutation — when the mutation rolls back, the event rolls back too.
"""

from django.db import transaction
from django.test import TestCase

from audit_history.models import AuditEvent

from .models import WorkItem
from .services import create_work_item, update_work_item
from .tests_api import _setup_test_data


def _events_for(work_item):
    """All AuditEvents for one WorkItem, oldest first."""
    return list(
        AuditEvent.objects
        .filter(work_item=work_item)
        .order_by("id")
    )


def _latest_event(work_item):
    return _events_for(work_item)[-1]


class ActivityWorkItemEventSliceTest(TestCase):
    """The required first-slice Work Item events, one per domain action."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        cls.group = cls.data["group"]
        cls.alex = cls.data["alex"]
        cls.chris = cls.data["chris"]
        cls.project = cls.data["paper_xyz"]
        cls.task_type = cls.data["task_type"]
        cls.review_status = cls.data["review_status"]
        # Fresh WorkItem (default status: project's active default,
        # category todo) so every test starts from exactly one
        # work_item.created event.
        cls.wi = create_work_item(
            project=cls.project,
            actor=cls.alex,
            type_definition_id=cls.task_type.pk,
            title="Activity Slice Task",
        )

    def _status(self, name):
        return self.project.status_definitions.get(name=name)

    def _assert_event_scope_and_identity(self, event):
        """WHICH + WHERE + WHEN: the event is bound to the affected
        WorkItem and to its own Project/Research Group scope, with an
        occurrence timestamp — the exact references a later Activity
        feed needs to enforce the object's authorization boundary."""
        self.assertEqual(event.work_item_id, self.wi.pk)
        self.assertEqual(event.project_id, self.project.pk)
        self.assertEqual(event.research_group_id, self.group.pk)
        self.assertIsNotNone(event.created_at)

    # ── Work Item created ──

    def test_created_event_reconstructs_who_what_which_where_when(self):
        events = _events_for(self.wi)
        self.assertEqual(len(events), 1)
        event = events[0]
        # WHAT: a stable machine code, not a rendered sentence.
        self.assertEqual(event.event_type, "work_item.created")
        # WHO
        self.assertEqual(event.actor_id, self.alex.pk)
        # WHICH + WHERE + WHEN
        self._assert_event_scope_and_identity(event)

    # ── Work Item status changed ──

    def test_status_change_event_is_structured_and_not_a_completion(self):
        in_progress = self._status("In Progress")
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            status_definition_id=in_progress.pk,
        )

        event = _latest_event(self.wi)
        self.assertEqual(event.event_type, "work_item.updated")
        self.assertEqual(event.actor_id, self.alex.pk)
        self._assert_event_scope_and_identity(event)

        status_change = event.data["changes"]["statusDefinition"]
        self.assertEqual(
            status_change,
            {
                "from": {
                    "id": self._status("Todo").pk,
                    "name": "Todo",
                    "category": "todo",
                },
                "to": {
                    "id": in_progress.pk,
                    "name": "In Progress",
                    "category": "in_progress",
                },
            },
        )
        # An ordinary status change is NOT a completion.
        self.assertNotEqual(status_change["to"]["category"], "done")
        self.wi.refresh_from_db()
        self.assertIsNone(self.wi.completed_at)

    # ── Work Item completed (semantically distinct) ──

    def test_completion_is_distinguishable_in_the_persisted_event(self):
        done = self._status("Done")
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            status_definition_id=done.pk,
        )

        event = _latest_event(self.wi)
        self.assertEqual(event.actor_id, self.alex.pk)
        self._assert_event_scope_and_identity(event)

        status_change = event.data["changes"]["statusDefinition"]
        # The persisted event alone marks this as a completion —
        # no join back to the StatusDefinition is required.
        self.assertEqual(status_change["from"]["category"], "todo")
        self.assertEqual(status_change["to"]["category"], "done")

        # Same logical transaction: the server-managed completed_at
        # lands with the change.
        self.wi.refresh_from_db()
        self.assertIsNotNone(self.wi.completed_at)

    def test_transition_away_from_done_is_a_status_change_not_a_completion(self):
        done = self._status("Done")
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            status_definition_id=done.pk,
        )
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            status_definition_id=self.review_status.pk,
        )

        event = _latest_event(self.wi)
        status_change = event.data["changes"]["statusDefinition"]
        self.assertEqual(status_change["from"]["category"], "done")
        self.assertEqual(status_change["to"]["category"], "review")

        self.wi.refresh_from_db()
        self.assertIsNone(self.wi.completed_at)

    # ── Assignee changed ──

    def test_assignee_change_event_names_who_was_added_and_removed(self):
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            assignee_ids=[self.chris.pk],
        )
        event = _latest_event(self.wi)
        self.assertEqual(event.actor_id, self.alex.pk)
        self._assert_event_scope_and_identity(event)
        assignees = event.data["changes"]["assignees"]
        self.assertEqual(
            [entry["id"] for entry in assignees["added"]],
            [self.chris.pk],
        )
        self.assertEqual(assignees["removed"], [])

        # Removal is the same action boundary with the other side set.
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            assignee_ids=[],
        )
        event = _latest_event(self.wi)
        assignees = event.data["changes"]["assignees"]
        self.assertEqual(assignees["added"], [])
        self.assertEqual(
            [entry["id"] for entry in assignees["removed"]],
            [self.chris.pk],
        )

    # ── Due date changed ──

    def test_due_date_change_event_includes_clearing(self):
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            due_date="2026-10-02",
        )
        event = _latest_event(self.wi)
        self.assertEqual(event.actor_id, self.alex.pk)
        self._assert_event_scope_and_identity(event)
        self.assertEqual(
            event.data["changes"]["dueDate"],
            {"from": None, "to": "2026-10-02"},
        )

        # Clearing the due date is still a due-date change (to null).
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            due_date=None,
        )
        event = _latest_event(self.wi)
        self.assertEqual(
            event.data["changes"]["dueDate"],
            {"from": "2026-10-02", "to": None},
        )

    # ── Domain-level action boundary ──

    def test_one_atomic_update_with_all_slice_actions_records_one_event(self):
        """One atomic update is one domain-level action: no fan-out to
        one event per changed field. The single event carries every
        related change so a later Activity projection can summarize
        them sensibly."""
        done = self._status("Done")
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            status_definition_id=done.pk,
            assignee_ids=[self.chris.pk],
            due_date="2026-10-02",
        )

        events = _events_for(self.wi)
        self.assertEqual(len(events), 2)  # created + one update event
        self.assertEqual(events[-1].actor_id, self.alex.pk)
        self._assert_event_scope_and_identity(events[-1])

        changes = events[-1].data["changes"]
        self.assertEqual(
            set(changes.keys()),
            {"statusDefinition", "assignees", "dueDate"},
        )
        self.assertEqual(
            changes["statusDefinition"]["to"]["category"], "done",
        )
        self.assertEqual(
            [entry["id"] for entry in changes["assignees"]["added"]],
            [self.chris.pk],
        )
        self.assertEqual(changes["dueDate"]["to"], "2026-10-02")


class ActivityEventTransactionTest(TestCase):
    """An Activity event lives and dies with the mutation's logical
    transaction — a rollback must never leave an orphaned event."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        cls.alex = cls.data["alex"]
        cls.project = cls.data["paper_xyz"]
        cls.task_type = cls.data["task_type"]
        cls.wi = create_work_item(
            project=cls.project,
            actor=cls.alex,
            type_definition_id=cls.task_type.pk,
            title="Transaction Slice Task",
        )

    def test_rolled_back_update_leaves_no_event_and_no_change(self):
        in_progress = self.project.status_definitions.get(
            name="In Progress",
        )
        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                update_work_item(
                    work_item=self.wi,
                    actor=self.alex,
                    status_definition_id=in_progress.pk,
                    title="Must Not Persist",
                )
                raise RuntimeError("simulated failure after mutation")

        self.wi.refresh_from_db()
        self.assertEqual(self.wi.title, "Transaction Slice Task")
        # Only the original work_item.created event survives.
        events = list(
            AuditEvent.objects
            .filter(work_item=self.wi)
            .order_by("id")
        )
        self.assertEqual(
            [event.event_type for event in events],
            ["work_item.created"],
        )

    def test_rolled_back_create_leaves_no_work_item_and_no_event(self):
        before = AuditEvent.objects.filter(
            event_type="work_item.created",
        ).count()

        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                create_work_item(
                    project=self.project,
                    actor=self.alex,
                    type_definition_id=self.task_type.pk,
                    title="Rolled Back Task",
                )
                raise RuntimeError("simulated failure after create")

        self.assertFalse(
            WorkItem.objects
            .filter(title="Rolled Back Task")
            .exists(),
        )
        self.assertEqual(
            AuditEvent.objects
            .filter(event_type="work_item.created")
            .count(),
            before,
        )
