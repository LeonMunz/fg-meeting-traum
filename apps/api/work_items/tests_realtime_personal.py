"""Integration tests for the RT-03D personal-scope realtime
invalidations: canonical Work Item mutations and the personal My Work
board move publish commit-attached ``my_work_changed`` notifications
for exactly the affected users, and an already-connected, authorized
SSE client receives them through the real PostgreSQL LISTEN/NOTIFY
transport.

Real database transactions and real dedicated LISTEN connections are
used throughout (``TransactionTestCase`` so service mutations commit);
mock assertions against the publisher do NOT substitute for the
PostgreSQL commit/rollback/delivery evidence.

Contract under test (RT-03D required behavior):
- create, assignee add/remove/replace, status change, field change,
  and delete publish the personal invalidation for exactly the
  affected users (recipients from persisted pre/post state only);
- a same-category personal My Work reorder publishes exactly one
  personal event for the acting user and NO project event;
- a cross-category personal move publishes the project event plus one
  personal event per affected assignee, with the acting user never
  notified twice despite the nested service calls;
- unchanged assignments and genuine no-ops publish nothing;
- a rollback of the outer transaction (or a failed savepoint)
  publishes nothing — a rolled-back INNER savepoint does not
  suppress a later valid publication in the same outer transaction
  (exactly one event after commit); failed authorization /
  validation publish nothing;
- two independent committed transactions deliver the same personal
  event once each;
- an uninvolved user's stream observes no personal event; multiple
  authorized SSE clients of one affected user all receive it;
- the RT-03C project event contract stays unchanged alongside.
"""

import json
import unittest.mock as mock

from django.contrib.auth import get_user_model
from django.db import transaction
from django.test import Client, TransactionTestCase

from projects.models import (
    ProjectMembership,
    WorkItemLabelDefinition,
    WorkItemStatusDefinition,
)
from projects.services import add_project_membership
from research_groups.models import ResearchGroupMembership

import work_items.realtime as realtime
from work_items.models import MyWorkBoardPosition, WorkItem
from work_items.my_work_board_order import move_my_work_item
from work_items.realtime import open_listener
from work_items.services import (
    WorkItemDomainError,
    create_work_item,
    delete_work_item,
    reposition_work_item,
    transition_work_item_status,
    update_work_item,
)
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

# How many SSE frames (keep-alives at FAST_KEEPALIVE cadence) to scan
# when asserting that a personal event is NOT delivered on a stream.
SUPPRESSION_SCAN_FRAMES = 8


def _project_payload(project_id):
    return {"scope": "project", "projectId": project_id}


def _user_payload(user):
    return {"scope": "user", "userId": user.pk}


def _sorted_payloads(payloads):
    return sorted(payloads, key=json.dumps)


class PersonalRealtimeBase(TransactionTestCase):
    """Fixture: the standard scenario (alex owner, chris member, laura
    viewer, maria group member WITHOUT Project membership) plus a
    third eligible assignee (dave, member), a label definition, and
    the seeded status definitions."""

    def setUp(self):
        self.data = _create_test_scenario()
        self.project = self.data["paper_xyz"]
        self.alex = self.data["alex"]
        self.chris = self.data["chris"]
        self.laura = self.data["laura"]
        self.maria = self.data["maria"]
        self.task_type = self.data["task_type"]

        # A third eligible assignee so multi-assignee recipient rules
        # can be observed with more than two users.
        self.dave = User.objects.create_user(
            username="dave", password="Pass1!"
        )
        ResearchGroupMembership.objects.create(
            research_group=self.data["group"],
            user=self.dave,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.dave,
            role=ProjectMembership.Role.MEMBER,
        )

        self.todo_status = self.project.status_definitions.get(
            category=WorkItemStatusDefinition.Category.TODO
        )
        self.in_progress_status = self.project.status_definitions.get(
            category=WorkItemStatusDefinition.Category.IN_PROGRESS
        )
        self.label_def = WorkItemLabelDefinition.objects.create(
            project=self.project,
            name="RT Personal Label",
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
        handshake. Returns ``_Stream`` (the handshake frame is
        already consumed)."""
        client = self._client(user)
        response = client.get(EVENTS_URL)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/event-stream")
        stream = _Stream(client, response)
        stream.next_frame()  # open handshake
        return stream

    def _create_item(self, title, actor=None, **kwargs):
        return create_work_item(
            project=self.project,
            actor=actor or self.alex,
            type_definition_id=self.task_type.pk,
            title=title,
            **kwargs,
        )

    def _drain_listener(self, listener, timeout=None):
        """Collect the parsed channel payloads within ``timeout``
        seconds on a real dedicated LISTEN connection."""
        return [
            json.loads(notification.payload)
            for notification in listener.iter_notifications(
                timeout=timeout or POSITIVE_DRAIN_SECONDS
            )
        ]

    def _assert_exact_events(self, listener, expected, note=""):
        """The commit delivered EXACTLY these channel payloads —
        nothing more (no duplicates, no uninvolved users), nothing
        less."""
        got = self._drain_listener(listener)
        self.assertEqual(
            _sorted_payloads(got),
            _sorted_payloads(expected),
            f"unexpected notification set{note}: {got}",
        )

    def _assert_no_events(self, listener, note=""):
        notifications = self._drain_listener(
            listener, timeout=NEGATIVE_DRAIN_SECONDS
        )
        self.assertEqual(
            notifications, [], f"expected no notification{note}: {notifications}"
        )

    def _iter_stream_events(self, stream, frames):
        """Yield the non-keep-alive ``(event, payload)`` pairs as
        they arrive, reading at most ``frames`` frames. Frames are
        consumed lazily: the reader stops as soon as the caller stops
        iterating."""
        for _ in range(frames):
            frame = stream.next_frame()
            event, data = _parse_sse_frame(frame)
            if event is not None:
                yield event, json.loads(data)

    def _stream_events(self, stream, frames):
        """Read up to ``frames`` frames; return the non-keep-alive
        ``(event, payload)`` pairs in arrival order."""
        return list(self._iter_stream_events(stream, frames))

    def _stream_has_event(self, stream, event, payload=None, frames=12):
        """True when the stream delivers ``event`` within ``frames``
        frames; ``payload`` must match when given. Reads lazily:
        stops as soon as the event is found."""
        for event_name, data in self._iter_stream_events(stream, frames):
            if event_name == event and (
                payload is None or data == payload
            ):
                return True
        return False

    def _stream_has_no_event(
        self, stream, event, frames=SUPPRESSION_SCAN_FRAMES, msg=None
    ):
        """Assert the stream delivers NO ``event`` within the scan
        window (keep-alives at FAST_KEEPALIVE cadence bound the
        window; committed notifications deliver in milliseconds)."""
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            for event_name, _data in self._stream_events(stream, frames):
                self.assertNotEqual(
                    event_name,
                    event,
                    msg or (
                        f"stream must not receive {event} within the "
                        f"suppression scan window"
                    ),
                )


class CreatePersonalRealtimeTests(PersonalRealtimeBase):
    """1. create with assignees: each new assignee gets one personal
    event; the project event stays exactly one."""

    def test_create_with_multiple_assignees_publishes_one_personal_event_each(self):
        listener = open_listener()
        try:
            self._create_item(
                "Create multi", assignee_ids=[self.chris.pk, self.dave.pk]
            )
            # The actor (alex) is NOT an assignee: no personal event
            # for him. The uninvolved viewer (laura) gets none either.
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                    _user_payload(self.dave),
                ],
                note=" for a create with multiple assignees",
            )
        finally:
            listener.close()

    def test_create_personal_payload_is_a_scope_pointer_only(self):
        # No Work Item data (id, title, ...) may ride the channel:
        # the personal payload carries the addressed user id only.
        listener = open_listener()
        try:
            self._create_item(
                "Create pointer", assignee_ids=[self.chris.pk]
            )
            got = self._drain_listener(listener)
            personal = [p for p in got if p.get("scope") == "user"]
            self.assertEqual(personal, [_user_payload(self.chris)])
            self.assertEqual(set(personal[0]), {"scope", "userId"})
        finally:
            listener.close()

    def test_create_delivers_personal_event_to_connected_assignee(self):
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            stream = self._open_stream(self.chris)
            try:
                self._create_item(
                    "Create SSE", assignee_ids=[self.chris.pk]
                )

                events = self._stream_events(stream, frames=12)
                self.assertIn(
                    ("work_item_changed", {"projectId": self.project.pk}),
                    events,
                    "RT-03C project event must still be delivered",
                )
                self.assertIn(
                    ("my_work_changed", {}),
                    events,
                    "connected assignee must receive the personal event "
                    "with an empty payload",
                )
                self.assertEqual(
                    events.count(("my_work_changed", {})), 1
                )
            finally:
                stream.close()

    def test_create_unassigned_item_publishes_no_personal_event(self):
        listener = open_listener()
        try:
            self._create_item("Create unassigned")
            got = self._drain_listener(listener)
            self.assertEqual(
                got, [_project_payload(self.project.pk)],
                "an unassigned create must publish the project event "
                "only",
            )
        finally:
            listener.close()


class AssignmentChangePersonalRealtimeTests(PersonalRealtimeBase):
    """2./3. assignee add, remove, replace — union of the affected
    assignees, each user once; unchanged assignments publish nothing."""

    def test_assignee_added_publishes_personal_event_for_new_assignee(self):
        work_item = self._create_item("Assign add")
        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                assignee_ids=[self.chris.pk],
            )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                ],
                note=" for an assignee addition",
            )
        finally:
            listener.close()

    def test_assignee_removed_publishes_personal_event_for_removed_assignee(self):
        work_item = self._create_item(
            "Assign remove", assignee_ids=[self.chris.pk, self.dave.pk]
        )
        listener = open_listener()
        try:
            # dave is removed, chris keeps the item UNCHANGED: only
            # dave is addressed (no notification for uninvolved users).
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                assignee_ids=[self.chris.pk],
            )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.dave),
                ],
                note=" for an assignee removal",
            )
        finally:
            listener.close()

    def test_assignee_replaced_publishes_for_added_and_removed_once_each(self):
        work_item = self._create_item(
            "Assign replace", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                assignee_ids=[self.dave.pk],
            )
            # Union of previous and new affected assignees; each user
            # exactly once.
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                    _user_payload(self.dave),
                ],
                note=" for an assignee replacement",
            )
        finally:
            listener.close()

    def test_assignment_unchanged_publishes_nothing(self):
        work_item = self._create_item(
            "Assign unchanged", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            # Same assignment set, no other field supplied: a genuine
            # no-op — no project AND no personal event.
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                assignee_ids=[self.chris.pk],
            )
            self._assert_no_events(
                listener, note=" for an unchanged assignment"
            )
        finally:
            listener.close()

    def test_assignment_unchanged_with_title_change_publishes_for_current_assignees(self):
        work_item = self._create_item(
            "Assign + title", assignee_ids=[self.chris.pk, self.dave.pk]
        )
        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                title="Assign + title v2",
                assignee_ids=[self.chris.pk, self.dave.pk],
            )
            # The assignment set is unchanged, but the item's My Work
            # projection data (title) changed for the current
            # assignees: they are addressed, nobody else.
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                    _user_payload(self.dave),
                ],
                note=" for a title change with unchanged assignment",
            )
        finally:
            listener.close()


class StatusChangePersonalRealtimeTests(PersonalRealtimeBase):
    """4. a canonical status change of a (multiply) assigned item
    addresses every current assignee."""

    def test_status_change_publishes_for_all_current_assignees(self):
        work_item = self._create_item(
            "Status multi",
            assignee_ids=[self.alex.pk, self.chris.pk, self.dave.pk],
        )
        listener = open_listener()
        try:
            transition_work_item_status(
                work_item=work_item,
                actor=self.alex,
                status_definition_id=self.in_progress_status.pk,
            )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.alex),
                    _user_payload(self.chris),
                    _user_payload(self.dave),
                ],
                note=" for a status change of a multiply assigned item",
            )
        finally:
            listener.close()

    def test_status_change_via_update_path_publishes_for_current_assignees(self):
        # The editor/drawer status PATCH is the other canonical
        # status-change path.
        work_item = self._create_item(
            "Status update path",
            assignee_ids=[self.chris.pk, self.dave.pk],
        )
        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                status_definition_id=self.in_progress_status.pk,
            )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                    _user_payload(self.dave),
                ],
                note=" for an update-path status change",
            )
        finally:
            listener.close()

    def test_no_op_status_transition_publishes_nothing(self):
        work_item = self._create_item(
            "Status no-op", assignee_ids=[self.chris.pk]
        )
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

    def test_status_change_unassigned_item_publishes_no_personal_event(self):
        work_item = self._create_item("Status unassigned")
        listener = open_listener()
        try:
            transition_work_item_status(
                work_item=work_item,
                actor=self.alex,
                status_definition_id=self.in_progress_status.pk,
            )
            self._assert_exact_events(
                listener,
                [_project_payload(self.project.pk)],
                note=" for a status change of an unassigned item",
            )
        finally:
            listener.close()


class FieldChangePersonalRealtimeTests(PersonalRealtimeBase):
    """5. visible My Work projection data changes (title, due date,
    labels) of an assigned item address the current assignees."""

    def test_title_change_publishes_for_current_assignees(self):
        work_item = self._create_item(
            "Title RT", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item, actor=self.alex, title="Title RT v2"
            )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                ],
                note=" for a title change of an assigned item",
            )
        finally:
            listener.close()

    def test_due_date_change_publishes_for_current_assignees(self):
        work_item = self._create_item(
            "Due RT", assignee_ids=[self.chris.pk, self.dave.pk]
        )
        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                due_date="2026-12-31",
            )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                    _user_payload(self.dave),
                ],
                note=" for a due date change of an assigned item",
            )
        finally:
            listener.close()

    def test_label_change_publishes_for_current_assignees(self):
        work_item = self._create_item(
            "Label RT", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                label_definition_ids=[self.label_def.pk],
            )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                ],
                note=" for a label change of an assigned item",
            )
        finally:
            listener.close()


class DeletePersonalRealtimeTests(PersonalRealtimeBase):
    """6. delete addresses the persisted former assignees."""

    def test_delete_assigned_item_publishes_for_former_assignees(self):
        work_item = self._create_item(
            "Delete RT", assignee_ids=[self.chris.pk, self.dave.pk]
        )
        listener = open_listener()
        try:
            delete_work_item(work_item=work_item, actor=self.alex)
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                    _user_payload(self.dave),
                ],
                note=" for a delete of an assigned item",
            )
        finally:
            listener.close()
        self.assertFalse(WorkItem.objects.filter(pk=work_item.pk).exists())

    def test_delete_unassigned_item_publishes_no_personal_event(self):
        work_item = self._create_item("Delete unassigned")
        listener = open_listener()
        try:
            delete_work_item(work_item=work_item, actor=self.alex)
            self._assert_exact_events(
                listener,
                [_project_payload(self.project.pk)],
                note=" for a delete of an unassigned item",
            )
        finally:
            listener.close()


class SameCategoryPersonalReorderRealtimeTests(PersonalRealtimeBase):
    """7. a same-category personal My Work reorder publishes exactly
    one personal event for the acting user and NO project event; a
    genuine no-op move publishes nothing."""

    def test_same_category_move_publishes_personal_event_only(self):
        first = self._create_item("Personal A", assignee_ids=[self.alex.pk])
        second = self._create_item(
            "Personal B", assignee_ids=[self.alex.pk]
        )

        listener = open_listener()
        try:
            move_my_work_item(
                user=self.alex,
                work_item=second,
                status_category=self.todo_status.category,
                before_work_item_id=first.pk,
            )
            # Only the acting user's personal projection changed:
            # exactly one personal event, NO project event.
            self._assert_exact_events(
                listener,
                [_user_payload(self.alex)],
                note=" for a same-category personal reorder",
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

    def test_same_category_move_delivers_personal_event_to_acting_user(self):
        first = self._create_item("Personal SSE A", assignee_ids=[self.alex.pk])
        second = self._create_item(
            "Personal SSE B", assignee_ids=[self.alex.pk]
        )
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            stream = self._open_stream(self.alex)
            try:
                move_my_work_item(
                    user=self.alex,
                    work_item=second,
                    status_category=self.todo_status.category,
                    before_work_item_id=first.pk,
                )
                self.assertTrue(
                    self._stream_has_event(
                        stream, "my_work_changed", {}
                    ),
                    "the acting user must receive the personal event "
                    "on their own stream",
                )
                self._stream_has_no_event(
                    stream,
                    "work_item_changed",
                    msg="a same-category personal reorder must "
                    "publish no project event",
                )
            finally:
                stream.close()

    def test_same_category_no_op_move_publishes_nothing(self):
        first = self._create_item("No-op A", assignee_ids=[self.alex.pk])
        second = self._create_item("No-op B", assignee_ids=[self.alex.pk])

        listener = open_listener()
        try:
            # First move: establishes explicit positions -> a real
            # personal change -> exactly one event.
            move_my_work_item(
                user=self.alex,
                work_item=second,
                status_category=self.todo_status.category,
                before_work_item_id=first.pk,
            )
            self._assert_exact_events(
                listener,
                [_user_payload(self.alex)],
                note=" for the first (real) personal move",
            )

            # The identical drop again: the resulting position map is
            # byte-for-byte the stored one -> a genuine no-op ->
            # nothing.
            move_my_work_item(
                user=self.alex,
                work_item=second,
                status_category=self.todo_status.category,
                before_work_item_id=first.pk,
            )
            self._assert_no_events(
                listener, note=" for a no-op personal move"
            )
        finally:
            listener.close()


class CrossCategoryPersonalMoveRealtimeTests(PersonalRealtimeBase):
    """8./9. a cross-category personal move publishes the project
    event plus one personal event per affected assignee — the acting
    user is never notified twice despite the nested service calls."""

    def test_cross_category_move_publishes_project_and_personal_once_each(self):
        work_item = self._create_item(
            "Cross personal", assignee_ids=[self.alex.pk, self.chris.pk]
        )
        self.assertIsNone(work_item.board_position)

        listener = open_listener()
        try:
            moved = move_my_work_item(
                user=self.alex,
                work_item=work_item,
                status_category=self.in_progress_status.category,
            )
            # The canonical status change invalidates the project
            # scope once; every current assignee (incl. the acting
            # user, exactly once) receives one personal event.
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.alex),
                    _user_payload(self.chris),
                ],
                note=" for a cross-category personal move",
            )
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

    def test_cross_category_move_delivers_events_to_both_assignees(self):
        work_item = self._create_item(
            "Cross SSE", assignee_ids=[self.alex.pk, self.chris.pk]
        )
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            alex_stream = self._open_stream(self.alex)
            chris_stream = self._open_stream(self.chris)
            try:
                move_my_work_item(
                    user=self.alex,
                    work_item=work_item,
                    status_category=self.in_progress_status.category,
                )
                # The acting user: project + exactly one personal
                # event.
                alex_events = self._stream_events(alex_stream, frames=12)
                self.assertIn(
                    ("work_item_changed", {"projectId": self.project.pk}),
                    alex_events,
                )
                self.assertEqual(
                    alex_events.count(("my_work_changed", {})),
                    1,
                    "the acting user must not receive the personal "
                    "event twice despite the nested service calls",
                )
                # The co-assignee (not the actor): project + personal.
                chris_events = self._stream_events(
                    chris_stream, frames=12
                )
                self.assertIn(
                    ("work_item_changed", {"projectId": self.project.pk}),
                    chris_events,
                )
                self.assertEqual(
                    chris_events.count(("my_work_changed", {})), 1
                )
            finally:
                alex_stream.close()
                chris_stream.close()

    def test_nested_service_calls_publish_personal_event_once(self):
        # Explicit nested-call contract: two REAL canonical mutations
        # of the same assigned item inside ONE outermost transaction
        # (each with its own service-level ``transaction.atomic()``)
        # deliver at most ONE personal event per affected user and at
        # most ONE project event for the affected scope for the whole
        # transaction — PostgreSQL coalesces identical NOTIFY
        # payloads within one transaction, matching the documented
        # "one notification per affected scope" contract.
        work_item = self._create_item(
            "Nested personal", assignee_ids=[self.alex.pk, self.chris.pk]
        )
        listener = open_listener()
        try:
            with transaction.atomic():
                transition_work_item_status(
                    work_item=work_item,
                    actor=self.alex,
                    status_definition_id=self.in_progress_status.pk,
                )
                update_work_item(
                    work_item=work_item,
                    actor=self.alex,
                    title="Nested personal v2",
                )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.alex),
                    _user_payload(self.chris),
                ],
                note=" for nested service calls in one transaction",
            )
        finally:
            listener.close()


class RepositionPersonalRealtimeTests(PersonalRealtimeBase):
    """Project Board drags: a cross-category drag is a real status
    change (project + personal); a same-category drag changes only
    the Project-local board_position (project only, no personal)."""

    def test_cross_category_board_drag_publishes_project_and_personal(self):
        work_item = self._create_item(
            "Drag cross", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            reposition_work_item(
                work_item=work_item,
                actor=self.alex,
                status_definition_id=self.in_progress_status.pk,
            )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                ],
                note=" for a cross-category Board drag",
            )
        finally:
            listener.close()

    def test_same_category_board_drag_publishes_no_personal_event(self):
        first = self._create_item(
            "Drag same A", assignee_ids=[self.chris.pk]
        )
        second = self._create_item(
            "Drag same B", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            reposition_work_item(
                work_item=first,
                actor=self.alex,
                before_work_item_id=second.pk,
            )
            # Only the shared Project-local board_position changed —
            # not My Work projection data: the assignee is NOT
            # addressed personally.
            self._assert_exact_events(
                listener,
                [_project_payload(self.project.pk)],
                note=" for a same-category Board drag",
            )
        finally:
            listener.close()


class TransactionContractPersonalRealtimeTests(PersonalRealtimeBase):
    """10./11. commit-attached publication: rollbacks and failed
    mutations publish nothing."""

    def test_rolled_back_create_publishes_nothing(self):
        listener = open_listener()
        try:
            with self.assertRaises(RuntimeError):
                with transaction.atomic():
                    create_work_item(
                        project=self.project,
                        actor=self.alex,
                        type_definition_id=self.task_type.pk,
                        title="Doomed create personal",
                        assignee_ids=[self.chris.pk],
                    )
                    raise RuntimeError("simulated post-write failure")

            self._assert_no_events(
                listener, note=" after a rolled-back create"
            )
        finally:
            listener.close()
        self.assertFalse(
            WorkItem.objects.filter(
                title="Doomed create personal"
            ).exists()
        )

    def test_rolled_back_update_publishes_nothing(self):
        work_item = self._create_item(
            "Doomed update personal", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            with self.assertRaises(RuntimeError):
                with transaction.atomic():
                    update_work_item(
                        work_item=work_item,
                        actor=self.alex,
                        title="Doomed title",
                        assignee_ids=[self.chris.pk, self.dave.pk],
                    )
                    raise RuntimeError("simulated post-write failure")

            self._assert_no_events(
                listener, note=" after a rolled-back update"
            )
        finally:
            listener.close()
        work_item.refresh_from_db()
        self.assertEqual(work_item.title, "Doomed update personal")
        self.assertEqual(
            list(
                work_item.assignee_relations.values_list(
                    "user_id", flat=True
                )
            ),
            [self.chris.pk],
        )

    def test_rolled_back_personal_move_publishes_nothing(self):
        first = self._create_item(
            "Doomed move A", assignee_ids=[self.alex.pk]
        )
        second = self._create_item(
            "Doomed move B", assignee_ids=[self.alex.pk]
        )
        listener = open_listener()
        try:
            with self.assertRaises(RuntimeError):
                with transaction.atomic():
                    move_my_work_item(
                        user=self.alex,
                        work_item=second,
                        status_category=self.todo_status.category,
                        before_work_item_id=first.pk,
                    )
                    raise RuntimeError("simulated post-write failure")

            self._assert_no_events(
                listener, note=" after a rolled-back personal move"
            )
        finally:
            listener.close()
        self.assertFalse(
            MyWorkBoardPosition.objects.filter(
                user=self.alex, work_item=second
            ).exists()
        )

    def test_failed_authorization_publishes_nothing(self):
        work_item = self._create_item(
            "Viewer blocked personal", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            # A viewer cannot update: the mutation is rejected and
            # nothing is published (the assignee's state is intact).
            with self.assertRaises(WorkItemDomainError):
                update_work_item(
                    work_item=work_item,
                    actor=self.laura,
                    title="Hacked",
                )
            self._assert_no_events(
                listener, note=" after a failed authorization"
            )
        finally:
            listener.close()
        work_item.refresh_from_db()
        self.assertEqual(work_item.title, "Viewer blocked personal")

    def test_failed_assignee_validation_publishes_nothing(self):
        work_item = self._create_item(
            "Invalid assignee", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            # Maria has no ProjectMembership: the assignment
            # replacement is rejected and rolled back as a whole.
            with self.assertRaises(WorkItemDomainError):
                update_work_item(
                    work_item=work_item,
                    actor=self.alex,
                    assignee_ids=[self.maria.pk],
                )
            self._assert_no_events(
                listener, note=" after failed assignee validation"
            )
        finally:
            listener.close()
        work_item.refresh_from_db()
        self.assertEqual(
            list(
                work_item.assignee_relations.values_list(
                    "user_id", flat=True
                )
            ),
            [self.chris.pk],
        )

    def test_failed_personal_move_publishes_nothing(self):
        first = self._create_item(
            "Bad anchor A", assignee_ids=[self.alex.pk]
        )
        # The anchor is in chris's projection, NOT in alex's: the
        # move is rejected.
        anchor = self._create_item(
            "Bad anchor item", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            with self.assertRaises(WorkItemDomainError):
                move_my_work_item(
                    user=self.alex,
                    work_item=first,
                    status_category=self.todo_status.category,
                    before_work_item_id=anchor.pk,
                )
            self._assert_no_events(
                listener, note=" after a failed personal move"
            )
        finally:
            listener.close()

    def test_inner_savepoint_rollback_then_valid_publish_delivers_exactly_one_event(self):
        # A rolled-back INNER savepoint must not suppress a later
        # VALID publication of the same personal event in the same
        # outer transaction: PostgreSQL discards the rolled-back
        # pg_notify, and the second (committed) publish must be the
        # one — and only the one — notification delivered.
        work_item = self._create_item(
            "Savepoint repro", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            with transaction.atomic():
                try:
                    with transaction.atomic():
                        update_work_item(
                            work_item=work_item,
                            actor=self.alex,
                            title="Savepoint inner v1",
                        )
                        raise RuntimeError(
                            "inner savepoint failure"
                        )
                except RuntimeError:
                    # The inner savepoint (write AND its pg_notify)
                    # is rolled back; the outer transaction is still
                    # active and valid.
                    pass
                # The second, valid publication in the same outer
                # transaction.
                update_work_item(
                    work_item=work_item,
                    actor=self.alex,
                    title="Savepoint outer v2",
                )

            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                ],
                note=" after inner savepoint rollback + valid "
                "outer publish",
            )
        finally:
            listener.close()
        # The rolled-back inner write is gone; the outer one
        # committed.
        work_item.refresh_from_db()
        self.assertEqual(work_item.title, "Savepoint outer v2")

    def test_two_independent_committed_transactions_each_deliver_one_event(self):
        # Coalescing is strictly per committed transaction: the SAME
        # personal event published in two INDEPENDENT committed
        # transactions is delivered exactly once per transaction.
        work_item = self._create_item(
            "Two tx", assignee_ids=[self.chris.pk]
        )
        listener = open_listener()
        try:
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                title="Two tx v1",
            )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                ],
                note=" for the first committed transaction",
            )
            update_work_item(
                work_item=work_item,
                actor=self.alex,
                title="Two tx v2",
            )
            self._assert_exact_events(
                listener,
                [
                    _project_payload(self.project.pk),
                    _user_payload(self.chris),
                ],
                note=" for the second committed transaction",
            )
        finally:
            listener.close()
        work_item.refresh_from_db()
        self.assertEqual(work_item.title, "Two tx v2")


class DeliveryPersonalRealtimeTests(PersonalRealtimeBase):
    """12./13. delivery semantics: an uninvolved user observes no
    personal event; several authorized SSE clients of one affected
    user all receive it; a personal event never crosses user
    boundaries."""

    def test_uninvolved_user_receives_no_personal_event(self):
        # Laura is a viewer of the Project (authorized for the
        # PROJECT event) but is not an assignee: she must observe the
        # project invalidation and NO personal invalidation.
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            laura_stream = self._open_stream(self.laura)
            try:
                self._create_item(
                    "Uninvolved RT", assignee_ids=[self.chris.pk]
                )

                events = self._stream_events(
                    laura_stream, frames=SUPPRESSION_SCAN_FRAMES
                )
                self.assertIn(
                    ("work_item_changed", {"projectId": self.project.pk}),
                    events,
                    "the viewer keeps receiving the project event",
                )
                self.assertNotIn(
                    ("my_work_changed", {}),
                    events,
                    "an uninvolved (non-assignee) user must not "
                    "receive a personal event",
                )
            finally:
                laura_stream.close()

    def test_outsider_receives_nothing(self):
        # Maria is in the Research Group but has NO ProjectMembership:
        # nothing about the inaccessible Project may become
        # observable — no project event, no personal event, no
        # timing.
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            maria_stream = self._open_stream(self.maria)
            try:
                self._create_item(
                    "Outsider RT", assignee_ids=[self.chris.pk]
                )

                events = self._stream_events(
                    maria_stream, frames=SUPPRESSION_SCAN_FRAMES
                )
                self.assertEqual(events, [])
            finally:
                maria_stream.close()

    def test_personal_event_never_reaches_another_users_stream(self):
        # Chris is the only assignee: Alex (the Project owner,
        # connected, authorized for project events) receives the
        # project event but NOT Chris's personal event.
        work_item = self._create_item(
            "Cross-user RT", assignee_ids=[self.chris.pk]
        )
        alex_stream = self._open_stream(self.alex)
        try:
            update_work_item(
                work_item=work_item, actor=self.alex, title="Cross-user v2"
            )

            events = self._stream_events(
                alex_stream, frames=SUPPRESSION_SCAN_FRAMES
            )
            self.assertIn(
                ("work_item_changed", {"projectId": self.project.pk}),
                events,
            )
            self.assertNotIn(
                ("my_work_changed", {}),
                events,
                "a personal event is addressed to exactly one user",
            )
        finally:
            alex_stream.close()

    def test_multiple_streams_of_same_user_all_receive_personal_event(self):
        work_item = self._create_item(
            "Multi stream RT", assignee_ids=[self.chris.pk]
        )
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            first_stream = self._open_stream(self.chris)
            second_stream = self._open_stream(self.chris)
            try:
                update_work_item(
                    work_item=work_item,
                    actor=self.alex,
                    title="Multi stream v2",
                )
                self.assertTrue(
                    self._stream_has_event(
                        first_stream, "my_work_changed", {}
                    ),
                    "first SSE client of the affected user must "
                    "receive the personal event",
                )
                self.assertTrue(
                    self._stream_has_event(
                        second_stream, "my_work_changed", {}
                    ),
                    "second SSE client of the same affected user must "
                    "receive the personal event",
                )
            finally:
                first_stream.close()
                second_stream.close()
