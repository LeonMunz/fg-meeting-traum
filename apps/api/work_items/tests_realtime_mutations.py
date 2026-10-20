"""Integration tests for the RT-03C project-scoped realtime
invalidations: the canonical Project Work Item mutation services
publish exactly one commit-attached ``work_item_changed`` per real
change, and an already-connected, authorized SSE client receives it
through the real PostgreSQL LISTEN/NOTIFY transport.

Real database transactions and real dedicated LISTEN connections are
used throughout (``TransactionTestCase`` so service mutations commit);
mock assertions against the publisher do NOT substitute for the
PostgreSQL commit/rollback/delivery evidence.

Contract under test (RT-03C required behavior — project scope; the
personal-scope events coexisting on the same channel since RT-03D are
pinned by tests_realtime_personal.py):
- create, real update, delete, board reorder, and status transition
  publish the correct project invalidation;
- an authorized, already-connected SSE client receives the real
  mutation event; an unauthorized client receives nothing;
- a rollback of the outer transaction suppresses the event;
- a failed mutation and a no-op publish nothing;
- a nested service call (cross-category My Work move) publishes no
  duplicate project event;
- a same-category personal My Work reorder never touches the
  canonical Work Item state and publishes no project event;
- the existing audit history and mutation contracts are preserved.
"""

import json
import unittest.mock as mock

from django.contrib.auth import get_user_model
from django.db import transaction
from django.test import Client, TransactionTestCase

from audit_history.models import AuditEvent
from projects.models import WorkItemLabelDefinition, WorkItemStatusDefinition
from work_items.models import MyWorkBoardPosition, WorkItem
from work_items.my_work_board_order import move_my_work_item
from work_items.services import (
    WorkItemAuditEventType,
    WorkItemDomainError,
    create_work_item,
    delete_work_item,
    reposition_work_item,
    transition_work_item_status,
    update_work_item,
)

import work_items.realtime as realtime
from work_items.realtime import open_listener
from work_items.tests_invariants import _create_test_scenario
from work_items.tests_realtime import _Stream, _parse_sse_frame

User = get_user_model()

EVENTS_URL = "/api/work-items/events/"

# Scaled-down keep-alive interval for fast suppression tests
# (production default stays 15 s in work_items.realtime).
FAST_KEEPALIVE = 0.15

# Notification drain windows on a real dedicated LISTEN connection:
# committed notifications are delivered by PostgreSQL promptly, so the
# positive window also bounds "no duplicate event" and the negative
# window is long enough to make "no event" meaningful.
POSITIVE_DRAIN_SECONDS = 2.0
NEGATIVE_DRAIN_SECONDS = 0.8


def _project_payload(project_id):
    return {"scope": "project", "projectId": project_id}


class RealtimeMutationBase(TransactionTestCase):
    """Fixture: the standard scenario (alex owner, chris member, laura
    viewer, maria group member WITHOUT Project membership) plus a
    label definition and the seeded status definitions."""

    def setUp(self):
        self.data = _create_test_scenario()
        self.project = self.data["paper_xyz"]
        self.alex = self.data["alex"]
        self.chris = self.data["chris"]
        self.laura = self.data["laura"]
        self.maria = self.data["maria"]
        self.task_type = self.data["task_type"]

        self.todo_status = self.project.status_definitions.get(
            category=WorkItemStatusDefinition.Category.TODO
        )
        self.in_progress_status = self.project.status_definitions.get(
            category=WorkItemStatusDefinition.Category.IN_PROGRESS
        )
        self.label_def = WorkItemLabelDefinition.objects.create(
            project=self.project,
            name="RT Label",
        )

    # ── helpers ─────────────────────────────────────────────────────

    def _client(self, user):
        client = Client()
        self.assertTrue(
            client.login(username=user.username, password="Pass1!")
        )
        return client

    def _open_stream(self, user):
        """Open an authenticated stream and consume the open
        handshake. Returns ``(_Stream, open_frame)``."""
        client = self._client(user)
        response = client.get(EVENTS_URL)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/event-stream")
        stream = _Stream(client, response)
        return stream, stream.next_frame()

    def _create_item(self, title, actor=None, **kwargs):
        return create_work_item(
            project=self.project,
            actor=actor or self.alex,
            type_definition_id=self.task_type.pk,
            title=title,
            **kwargs,
        )

    def _drain_listener(self, listener, timeout=None):
        """Collect all channel notifications within ``timeout``
        seconds on a real dedicated LISTEN connection."""
        return list(
            listener.iter_notifications(
                timeout=timeout or POSITIVE_DRAIN_SECONDS
            )
        )

    def _assert_one_project_event(self, listener):
        """Exactly one PROJECT-scope notification with the project
        payload. Since RT-03D personal-scope notifications may
        coexist on the same channel for the affected users; they are
        pinned by tests_realtime_personal.py."""
        notifications = self._drain_listener(listener)
        project_notifications = [
            notification
            for notification in notifications
            if json.loads(notification.payload)
            == _project_payload(self.project.pk)
        ]
        self.assertEqual(
            len(project_notifications), 1,
            f"expected exactly one project notification, got "
            f"{[json.loads(n.payload) for n in notifications]}",
        )
        self.assertEqual(
            project_notifications[0].channel, realtime.NOTIFY_CHANNEL
        )

    def _assert_no_events(self, listener, note=""):
        notifications = self._drain_listener(
            listener, timeout=NEGATIVE_DRAIN_SECONDS
        )
        self.assertEqual(
            notifications, [], f"expected no notification{note}"
        )

    def _audit_events(self, work_item):
        return AuditEvent.objects.filter(work_item=work_item)


class CreateRealtimeTests(RealtimeMutationBase):
    """1. create publishes the project invalidation."""

    def test_create_delivers_project_event_to_connected_owner(self):
        stream, _ = self._open_stream(self.alex)
        try:
            self._create_item("Create RT")

            event, data = _parse_sse_frame(stream.next_frame())
            self.assertEqual(event, "work_item_changed")
            self.assertEqual(
                json.loads(data), {"projectId": self.project.pk}
            )
        finally:
            stream.close()

    def test_create_delivers_project_event_to_connected_member(self):
        stream, _ = self._open_stream(self.chris)
        try:
            self._create_item("Create RT for member")

            event, data = _parse_sse_frame(stream.next_frame())
            self.assertEqual(event, "work_item_changed")
            self.assertEqual(
                json.loads(data), {"projectId": self.project.pk}
            )
        finally:
            stream.close()

    def test_create_notification_is_a_scope_pointer_only(self):
        # No Work Item data (id, title, ...) may ride the channel:
        # exactly one notification with the minimal scope payload.
        listener = open_listener()
        try:
            self._create_item("Create RT scope pointer")
            notifications = self._drain_listener(listener)
            self.assertEqual(len(notifications), 1)
            self.assertEqual(
                json.loads(notifications[0].payload),
                _project_payload(self.project.pk),
            )
        finally:
            listener.close()


class UpdateRealtimeTests(RealtimeMutationBase):
    """2. real updates publish; no-ops and failed updates do not."""

    def test_real_update_delivers_project_event_to_connected_member(self):
        work_item = self._create_item("Update RT")
        stream, _ = self._open_stream(self.chris)
        try:
            update_work_item(
                work_item=work_item, actor=self.alex, title="Updated RT"
            )

            event, data = _parse_sse_frame(stream.next_frame())
            self.assertEqual(event, "work_item_changed")
            self.assertEqual(
                json.loads(data), {"projectId": self.project.pk}
            )
        finally:
            stream.close()

    def test_no_op_update_publishes_nothing(self):
        work_item = self._create_item("No-op RT")
        before_count = self._audit_events(work_item).count()

        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item, actor=self.alex, title=work_item.title
            )
            self._assert_no_events(listener, note=" for a no-op update")
        finally:
            listener.close()

        # Audit contract preserved: a no-op update records no event.
        self.assertEqual(self._audit_events(work_item).count(), before_count)
        work_item.refresh_from_db()
        self.assertEqual(work_item.title, "No-op RT")

    def test_assignee_change_delivers_project_event(self):
        work_item = self._create_item("Assign RT")
        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                assignee_ids=[self.chris.pk],
            )
            self._assert_one_project_event(listener)
        finally:
            listener.close()
        self.assertEqual(
            list(work_item.assignee_relations.values_list("user_id", flat=True)),
            [self.chris.pk],
        )

    def test_label_only_change_delivers_project_event(self):
        # Labels are persisted canonical Work Item state
        # (labelDefinitionIds is part of the Work Item API contract)
        # although they are deliberately not audited: the change must
        # invalidate the project scope without creating an audit
        # event.
        work_item = self._create_item("Label RT")
        before_count = self._audit_events(work_item).count()

        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                label_definition_ids=[self.label_def.pk],
            )
            self._assert_one_project_event(listener)
        finally:
            listener.close()

        self.assertEqual(
            self._audit_events(work_item).count(),
            before_count,
            "label-only changes are deliberately not audited",
        )
        self.assertEqual(
            list(work_item.label_relations.values_list("label_id", flat=True)),
            [self.label_def.pk],
        )


class DeleteRealtimeTests(RealtimeMutationBase):
    """3. delete publishes the project invalidation."""

    def test_delete_delivers_project_event_to_connected_viewer(self):
        work_item = self._create_item("Delete RT")
        stream, _ = self._open_stream(self.laura)
        try:
            delete_work_item(work_item=work_item, actor=self.alex)

            event, data = _parse_sse_frame(stream.next_frame())
            self.assertEqual(event, "work_item_changed")
            self.assertEqual(
                json.loads(data), {"projectId": self.project.pk}
            )
        finally:
            stream.close()

        self.assertFalse(WorkItem.objects.filter(pk=work_item.pk).exists())


class RepositionRealtimeTests(RealtimeMutationBase):
    """4. board reorders publish; no-op drops do not."""

    def test_board_reorder_delivers_project_event_to_connected_member(self):
        first = self._create_item("Reorder A")
        second = self._create_item("Reorder B")
        stream, _ = self._open_stream(self.chris)
        try:
            reposition_work_item(
                work_item=first,
                actor=self.alex,
                before_work_item_id=second.pk,
            )

            event, data = _parse_sse_frame(stream.next_frame())
            self.assertEqual(event, "work_item_changed")
            self.assertEqual(
                json.loads(data), {"projectId": self.project.pk}
            )
        finally:
            stream.close()

        # The move was persisted (sanity of the real change).
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual(first.board_position, 1)
        self.assertEqual(second.board_position, 2)

    def test_no_op_reorder_publishes_nothing(self):
        first = self._create_item("No-op A")
        second = self._create_item("No-op B")

        listener = open_listener()
        try:
            # First reorder of the column: normalization assigns
            # explicit positions -> a real change -> exactly one
            # event.
            reposition_work_item(
                work_item=first,
                actor=self.alex,
                before_work_item_id=second.pk,
            )
            self._assert_one_project_event(listener)

            # The identical drop again: the final committed state is
            # byte-for-byte unchanged -> no event (a genuine no-op).
            reposition_work_item(
                work_item=first,
                actor=self.alex,
                before_work_item_id=second.pk,
            )
            self._assert_no_events(listener, note=" for a no-op reorder")
        finally:
            listener.close()

        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual(first.board_position, 1)
        self.assertEqual(second.board_position, 2)

    def test_cross_category_reorder_publishes_exactly_one_project_event(self):
        work_item = self._create_item("Cross RT")
        listener = open_listener()
        try:
            reposition_work_item(
                work_item=work_item,
                actor=self.alex,
                status_definition_id=self.in_progress_status.pk,
            )
            self._assert_one_project_event(listener)
        finally:
            listener.close()

        work_item.refresh_from_db()
        self.assertEqual(
            work_item.status_definition_id, self.in_progress_status.pk
        )
        self.assertIsNotNone(work_item.board_position)


class TransitionRealtimeTests(RealtimeMutationBase):
    """5. status transitions publish; no-op transitions do not."""

    def test_status_transition_delivers_project_event_to_connected_member(self):
        work_item = self._create_item("Transition RT")
        stream, _ = self._open_stream(self.chris)
        try:
            transition_work_item_status(
                work_item=work_item,
                actor=self.alex,
                status_definition_id=self.in_progress_status.pk,
            )

            event, data = _parse_sse_frame(stream.next_frame())
            self.assertEqual(event, "work_item_changed")
            self.assertEqual(
                json.loads(data), {"projectId": self.project.pk}
            )
        finally:
            stream.close()

    def test_no_op_status_transition_publishes_nothing(self):
        work_item = self._create_item("No-op transition RT")
        before_count = self._audit_events(work_item).count()

        listener = open_listener()
        try:
            transition_work_item_status(
                work_item=work_item,
                actor=self.alex,
                status_definition_id=self.todo_status.pk,
            )
            self._assert_no_events(
                listener, note=" for a no-op status transition"
            )
        finally:
            listener.close()

        # Audit contract preserved: a no-op transition records no
        # history event.
        self.assertEqual(self._audit_events(work_item).count(), before_count)
        work_item.refresh_from_db()
        self.assertEqual(work_item.status_definition_id, self.todo_status.pk)


class AuthorizationAndFailureRealtimeTests(RealtimeMutationBase):
    """6. unauthorized clients receive nothing; failed mutations and
    failed authorization publish nothing."""

    def test_unauthorized_client_receives_nothing(self):
        # Maria is in the Research Group but has NO ProjectMembership:
        # nothing about the inaccessible Project may become observable
        # (no event, no project id, no timing).
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            stream, _ = self._open_stream(self.maria)
            try:
                self._create_item("Unauthorized RT")

                frame = stream.next_frame()
                self.assertEqual(frame, ": ping\n\n")
                self.assertNotIn(str(self.project.pk), frame)
                # The stream stays open for the client's other scopes.
                self.assertEqual(stream.next_frame(), ": ping\n\n")
            finally:
                stream.close()

    def test_failed_mutation_publishes_nothing(self):
        work_item = self._create_item("Viewer blocked RT")

        listener = open_listener()
        try:
            # Invalid type definition: the mutation is rejected and
            # rolled back.
            with self.assertRaises(WorkItemDomainError):
                create_work_item(
                    project=self.project,
                    actor=self.alex,
                    type_definition_id=999999,
                    title="Should fail",
                )

            # Failed authorization: a viewer cannot update.
            with self.assertRaises(WorkItemDomainError):
                update_work_item(
                    work_item=work_item, actor=self.laura, title="Hacked"
                )

            self._assert_no_events(
                listener, note=" after failed mutations"
            )
        finally:
            listener.close()

        work_item.refresh_from_db()
        self.assertEqual(work_item.title, "Viewer blocked RT")
        self.assertFalse(
            WorkItem.objects.filter(title="Should fail").exists()
        )


class RollbackRealtimeTests(RealtimeMutationBase):
    """7. a rollback of the outer transaction suppresses the event
    (commit-attached publication, real PostgreSQL semantics)."""

    def test_rolled_back_create_publishes_nothing(self):
        listener = open_listener()
        try:
            with self.assertRaises(RuntimeError):
                with transaction.atomic():
                    create_work_item(
                        project=self.project,
                        actor=self.alex,
                        type_definition_id=self.task_type.pk,
                        title="Doomed create",
                    )
                    raise RuntimeError("simulated post-write failure")

            self._assert_no_events(
                listener, note=" after a rolled-back create"
            )
        finally:
            listener.close()

        # The rollback really undid the write.
        self.assertFalse(
            WorkItem.objects.filter(title="Doomed create").exists()
        )

    def test_rolled_back_update_publishes_nothing(self):
        work_item = self._create_item("Doomed update")
        before_count = self._audit_events(work_item).count()

        listener = open_listener()
        try:
            with self.assertRaises(RuntimeError):
                with transaction.atomic():
                    update_work_item(
                        work_item=work_item,
                        actor=self.alex,
                        title="Doomed title",
                    )
                    raise RuntimeError("simulated post-write failure")

            self._assert_no_events(
                listener, note=" after a rolled-back update"
            )
        finally:
            listener.close()

        work_item.refresh_from_db()
        self.assertEqual(work_item.title, "Doomed update")
        self.assertEqual(self._audit_events(work_item).count(), before_count)


class NestedCallRealtimeTests(RealtimeMutationBase):
    """8. a nested service call (the cross-category My Work move
    calling the canonical status transition inside one transaction)
    publishes exactly ONE project event — no duplicates."""

    def test_cross_category_my_work_move_publishes_exactly_one_project_event(self):
        work_item = self._create_item(
            "Nested RT", assignee_ids=[self.alex.pk]
        )
        self.assertIsNone(work_item.board_position)

        listener = open_listener()
        try:
            moved = move_my_work_item(
                user=self.alex,
                work_item=work_item,
                status_category=self.in_progress_status.category,
            )
            self._assert_one_project_event(listener)
        finally:
            listener.close()

        # The canonical status transition happened ...
        self.assertEqual(
            moved.status_definition_id, self.in_progress_status.pk
        )
        # ... without touching the Project-board position ...
        self.assertIsNone(moved.board_position)
        # ... and with the personal position persisted.
        personal = MyWorkBoardPosition.objects.get(
            user=self.alex, work_item=work_item
        )
        self.assertEqual(
            personal.status_category,
            self.in_progress_status.category,
        )
        self.assertEqual(personal.position, 1)


class SameCategoryMyWorkRealtimeTests(RealtimeMutationBase):
    """9. a same-category personal My Work reorder touches ONLY the
    user's MyWorkBoardPosition rows — never the canonical Work Item
    state — and therefore publishes no project event."""

    def test_same_category_my_work_reorder_publishes_no_project_event(self):
        first = self._create_item(
            "Personal A", assignee_ids=[self.alex.pk]
        )
        second = self._create_item(
            "Personal B", assignee_ids=[self.alex.pk]
        )

        listener = open_listener()
        try:
            # Move B before A inside the user's personal todo column.
            move_my_work_item(
                user=self.alex,
                work_item=second,
                status_category=self.todo_status.category,
                before_work_item_id=first.pk,
            )
            # No PROJECT event: the canonical Work Item state is
            # untouched. (RT-03D: the real personal reorder does
            # publish exactly one personal event for the acting user —
            # pinned here and in tests_realtime_personal.py.)
            notifications = self._drain_listener(listener)
            project_notifications = [
                n for n in notifications
                if json.loads(n.payload)
                == _project_payload(self.project.pk)
            ]
            self.assertEqual(
                project_notifications, [],
                "a same-category My Work reorder must publish no "
                "project event",
            )
            self.assertEqual(
                [json.loads(n.payload) for n in notifications],
                [{"scope": "user", "userId": self.alex.pk}],
            )
        finally:
            listener.close()

        # The personal ordering was persisted ...
        self.assertEqual(
            MyWorkBoardPosition.objects.get(
                user=self.alex, work_item=second
            ).position,
            1,
        )
        self.assertEqual(
            MyWorkBoardPosition.objects.get(
                user=self.alex, work_item=first
            ).position,
            2,
        )
        # ... while the canonical Work Item state is untouched.
        for work_item in (first, second):
            work_item.refresh_from_db()
            self.assertIsNone(work_item.board_position)
            self.assertEqual(
                work_item.status_definition_id, self.todo_status.pk
            )


class AuditContractRealtimeTests(RealtimeMutationBase):
    """10. the existing audit history contract is preserved alongside
    the new publication."""

    def test_real_update_records_one_audit_event_and_publishes_once(self):
        work_item = self._create_item("Audit RT")
        created_events = self._audit_events(work_item).filter(
            event_type=WorkItemAuditEventType.CREATED
        )
        self.assertEqual(created_events.count(), 1)

        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item, actor=self.alex, title="Audit RT v2"
            )
            self._assert_one_project_event(listener)
        finally:
            listener.close()

        updated_events = self._audit_events(work_item).filter(
            event_type=WorkItemAuditEventType.UPDATED
        )
        self.assertEqual(updated_events.count(), 1)
        changes = updated_events.get().data.get("changes", {})
        self.assertIn("title", changes)
        self.assertEqual(
            changes["title"], {"from": "Audit RT", "to": "Audit RT v2"}
        )

    def test_cross_category_move_records_one_audit_event(self):
        work_item = self._create_item("Audit cross RT")

        reposition_work_item(
            work_item=work_item,
            actor=self.alex,
            status_definition_id=self.in_progress_status.pk,
        )

        updated_events = self._audit_events(work_item).filter(
            event_type=WorkItemAuditEventType.UPDATED
        )
        self.assertEqual(updated_events.count(), 1)
        changes = updated_events.get().data.get("changes", {})
        self.assertIn("statusDefinition", changes)
