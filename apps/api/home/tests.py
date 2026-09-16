"""Home aggregate API tests.

Proves the behavioral contract of ``GET /api/home/``
(``home.views.HomeAggregateView``):

- read-only, authenticated, user-scoped, non-paginated aggregate
  (anonymous rejected; exactly four section keys, always present,
  never ``null``; empty Home returns four empty arrays)
- composition only: each section serializes the corresponding
  existing read model (``work_items.home_attention``,
  ``home_timeline.timeline``, ``work_items.home_my_work``,
  ``home_continue.continue_working``) field-for-field, in the
  read model's authoritative order — no re-sorting, no
  re-derivation, no cross-section deduplication, no row limits
- fail-closed authorization preserved through composition:
  inaccessible Work Items / Meetings never surface in any section;
  participant removal and Project / Research Group access removal
  affect the aggregate immediately
- completion/overlap semantics: a Work Item may appear in multiple
  applicable sections; a ``done`` Work Item can still appear in
  Continue working while absent from the active Home sections
- query behavior: the fully populated aggregate stays bounded at the
  measured service-composition cost (1 + 2 + 1 + 5 = 9 service
  queries) plus the measured steady-state request overhead of
  exactly 3 queries (django_session load, user load, UserSession
  registry lookup), and candidate-row growth does not add queries
  (no N+1). Query captures compare EQUIVALENT request states:
  ``force_login`` and a warm-up GET run outside every capture, so
  the one-time per-session ``UserSession`` registration and all
  test-client login/session mechanics never enter the measured
  window.

Time is frozen exactly where the read models observe it:
``work_items.home_attention._current_application_date`` and
``home_timeline.timeline._observe_clock`` are patched to a fixed
Today (2026-09-15) and 7-day window. Continue working has no clock
seam: personal-action timestamps are pinned with queryset
``.update(created_at=...)`` (the established Activity-feed test
technique), so no test depends on the wall clock.
"""

from datetime import date, datetime, time, timedelta, timezone as datetime_timezone
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from audit_history.models import AuditEvent
from meetings.models import Meeting, MeetingParticipant
from meetings.services import (
    create_meeting,
    create_meeting_item,
    create_meeting_note,
    start_meeting,
)
from projects.models import ProjectMembership
from projects.services import add_project_membership, create_project
from research_groups.models import ResearchGroup, ResearchGroupMembership
from research_groups.services import (
    ResearchGroupProjectOffboardingResolution,
    offboard_research_group_member,
)

from work_items.models import WorkItemAssignee
from work_items.services import create_work_item, update_work_item

from home_continue.continue_working import get_continue_working_candidates
from home_timeline.timeline import get_home_timeline_candidates
from work_items.home_attention import get_work_item_attention_candidates
from work_items.home_my_work import get_home_my_work_candidates

# Frozen application date for every test in this module (identical to
# the Home read-model suites).
TODAY = date(2026, 9, 15)
# Frozen Today-&-next single clock observation: half-open window
# [2026-09-15T00:00, 2026-09-22T00:00).
WINDOW_START = timezone.make_aware(datetime(2026, 9, 15))
WINDOW_END = WINDOW_START + timedelta(days=7)

HOME_URL = "/api/home/"
SECTION_KEYS = {
    "needsAttention",
    "todayAndNext",
    "myWork",
    "continueWorking",
}

User = get_user_model()

SEED_PASSWORD = "DevPass1!"

# Fixed personal-action timestamps for Continue working (integer
# minute offsets, wall-clock independent).
T1 = timezone.make_aware(datetime(2026, 9, 15, 12, 30, 0))
T2 = timezone.make_aware(datetime(2026, 9, 15, 15, 0, 0))


def _at(day: date, hour: int = 10, minute: int = 0) -> datetime:
    """Aware application-timezone datetime at ``day hour:minute``."""
    return timezone.make_aware(datetime.combine(day, time(hour, minute)))


def _iso(d: date) -> str:
    return d.isoformat()


def _iso_z(dt: datetime) -> str:
    """ISO-8601 UTC string as DRF's JSON encoder renders aware
    datetimes (``...Z``). Uses the standard-library UTC timezone
    (``django.utils.timezone`` has no ``utc`` attribute)."""
    return dt.astimezone(datetime_timezone.utc).isoformat().replace(
        "+00:00", "Z",
    )


def _create_standard_data():
    """Create the standard Foundation 4 test scenario + an outsider.

    Paper XYZ:
      Alex: owner (Research Group admin)
      Chris: member
      Laura: viewer
      Maria: no ProjectMembership (Research Group member only)
      Outsider: no memberships at all
    """
    alex = User.objects.create_user(username="alex", password=SEED_PASSWORD)
    chris = User.objects.create_user(username="chris", password=SEED_PASSWORD)
    maria = User.objects.create_user(username="maria", password=SEED_PASSWORD)
    laura = User.objects.create_user(username="laura", password=SEED_PASSWORD)
    outsider = User.objects.create_user(
        username="outsider", password=SEED_PASSWORD,
    )

    group = ResearchGroup.objects.create(name="FG Example", created_by=alex)
    for user, role in (
        (alex, ResearchGroupMembership.Role.ADMIN),
        (chris, ResearchGroupMembership.Role.MEMBER),
        (maria, ResearchGroupMembership.Role.MEMBER),
        (laura, ResearchGroupMembership.Role.MEMBER),
    ):
        ResearchGroupMembership.objects.create(
            research_group=group, user=user, role=role,
        )

    paper_xyz = create_project(
        research_group=group, creator=alex, name="Paper XYZ"
    )
    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=chris, role=ProjectMembership.Role.MEMBER,
    )
    add_project_membership(
        project=paper_xyz, actor=alex,
        target_user=laura, role=ProjectMembership.Role.VIEWER,
    )

    return {
        "group": group,
        "alex": alex,
        "chris": chris,
        "maria": maria,
        "laura": laura,
        "outsider": outsider,
        "paper_xyz": paper_xyz,
    }


class _HomeAggregateBase(TestCase):
    """Base with the frozen clocks of the two time-sensitive read
    models."""

    def setUp(self):
        super().setUp()
        self.data = _create_standard_data()
        self.project = self.data["paper_xyz"]
        self.group = self.data["group"]
        self.task_type = self.project.type_definitions.get(name="Task")
        self.done_status = self.project.status_definitions.get(name="Done")
        self._na_clock = mock.patch(
            "work_items.home_attention._current_application_date",
            return_value=TODAY,
        )
        self._tn_clock = mock.patch(
            "home_timeline.timeline._observe_clock",
            return_value=(TODAY, WINDOW_START, WINDOW_END),
        )
        self._na_clock.start()
        self._tn_clock.start()
        self.addCleanup(self._na_clock.stop)
        self.addCleanup(self._tn_clock.stop)

    # ── fixtures ──

    def _make_wi(self, *, title, assignees=(), actor=None,
                 due_date=None, blocked_reason=None, status_id=None):
        return create_work_item(
            project=self.project,
            actor=actor or self.data["chris"],
            type_definition_id=self.task_type.pk,
            title=title,
            status_definition_id=status_id,
            assignee_ids=[u.pk for u in assignees],
            due_date=_iso(due_date) if due_date is not None else None,
            blocked_reason=blocked_reason,
        )

    def _make_meeting(self, *, title, scheduled_at, actor=None,
                      participants=()):
        return create_meeting(
            research_group=self.group,
            actor=actor or self.data["alex"],
            title=title,
            scheduled_at=scheduled_at,
            participants=participants,
        )

    def _pin(self, user, when, **filters):
        """Pin every matching AuditEvent of ``user`` to ``when``."""
        AuditEvent.objects.filter(actor=user, **filters).update(
            created_at=when,
        )

    def _note_on(self, meeting, *, actor, content):
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=meeting.meeting_sections.first(),
            actor=actor,
            title="Item",
        )
        return create_meeting_note(
            meeting_item=item, actor=actor, content=content,
        )

    # ── projection helpers ──

    def _get(self, user):
        self.client.force_login(user)
        return self.client.get(HOME_URL)

    @staticmethod
    def _attention_ids(data):
        return [row["workItemId"] for row in data["needsAttention"]]

    @staticmethod
    def _today_ids(data):
        return [row["objectId"] for row in data["todayAndNext"]]

    @staticmethod
    def _my_work_ids(data):
        return [row["workItemId"] for row in data["myWork"]]

    @staticmethod
    def _continue_ids(data):
        return [row["objectId"] for row in data["continueWorking"]]

    def _capture(self, fn):
        with CaptureQueriesContext(connection) as ctx:
            fn()
        return len(ctx.captured_queries)


def _assert_no_key(node, forbidden):
    """Recursively assert that ``forbidden`` never appears as a JSON
    key (no raw AuditEvent payload in the response)."""
    if isinstance(node, dict):
        for key, value in node.items():
            assert key != forbidden, f"raw Activity key {forbidden!r} leaked"
            _assert_no_key(value, forbidden)
    elif isinstance(node, list):
        for item in node:
            _assert_no_key(item, forbidden)


# ── Contract: authentication, shape, emptiness ──


class HomeAggregateContractTest(_HomeAggregateBase):

    def test_anonymous_request_is_rejected(self):
        response = self.client.get(HOME_URL)
        self.assertEqual(response.status_code, 401)

    def test_authenticated_user_receives_200(self):
        response = self._get(self.data["alex"])
        self.assertEqual(response.status_code, 200)

    def test_response_contains_exactly_the_four_section_keys(self):
        data = self._get(self.data["chris"]).json()
        self.assertEqual(set(data.keys()), SECTION_KEYS)
        for key in SECTION_KEYS:
            self.assertIsInstance(data[key], list)

    def test_completely_empty_home_returns_four_empty_arrays(self):
        data = self._get(self.data["outsider"]).json()
        for key in SECTION_KEYS:
            self.assertEqual(data[key], [], f"{key} must be []")


# ── Needs attention ──


class NeedsAttentionSerializationTest(_HomeAggregateBase):

    def test_candidate_serialization_matches_the_read_model(self):
        chris = self.data["chris"]
        self._make_wi(
            title="Draft introduction",
            assignees=[chris],
            due_date=TODAY - timedelta(days=1),
            blocked_reason="Waiting on reviewer",
        )

        candidates = get_work_item_attention_candidates(user=chris)
        data = self._get(chris).json()
        section = data["needsAttention"]

        self.assertEqual(len(candidates), 1)
        self.assertEqual(len(section), 1)
        c = candidates[0]
        self.assertEqual(
            section[0],
            {
                "workItemId": c.work_item_id,
                "title": c.title,
                "projectId": c.project_id,
                "projectName": c.project_name,
                "dueDate": _iso(c.due_date),
                "statusCategory": c.status_category,
                "blockedReason": c.blocked_reason,
                "attentionReasons": list(c.attention_reasons),
            },
        )
        # Explicit contract spot-check (stable reason codes, ISO date).
        self.assertEqual(section[0]["title"], "Draft introduction")
        self.assertEqual(section[0]["projectName"], "Paper XYZ")
        self.assertEqual(section[0]["dueDate"], _iso(TODAY - timedelta(days=1)))
        self.assertEqual(section[0]["statusCategory"], "todo")
        self.assertEqual(section[0]["attentionReasons"], ["overdue", "blocked"])

    def test_ordering_is_preserved(self):
        chris = self.data["chris"]
        earliest = self._make_wi(
            title="Overdue oldest",
            assignees=[chris],
            due_date=TODAY - timedelta(days=2),
        )
        recent = self._make_wi(
            title="Overdue newest",
            assignees=[chris],
            due_date=TODAY - timedelta(days=1),
        )
        blocked_only = self._make_wi(
            title="Blocked only",
            assignees=[chris],
            blocked_reason="Stuck",
        )

        data = self._get(chris).json()
        self.assertEqual(
            self._attention_ids(data),
            [earliest.pk, recent.pk, blocked_only.pk],
        )


# ── Today & next ──


class TodayAndNextSerializationTest(_HomeAggregateBase):

    def test_work_item_candidate_serializes_correctly(self):
        chris = self.data["chris"]
        wi = self._make_wi(
            title="Ship milestone",
            assignees=[chris],
            due_date=TODAY + timedelta(days=2),
        )

        data = self._get(chris).json()
        section = data["todayAndNext"]
        self.assertEqual(len(section), 1)
        self.assertEqual(
            section[0],
            {
                "domain": "work_item",
                "objectId": wi.pk,
                "title": "Ship milestone",
                "calendarDate": _iso(TODAY + timedelta(days=2)),
                # Date-only Work Item = all-day entry: the sort point
                # is the START of the due date (midnight, application
                # timezone).
                "sortAt": _iso_z(_at(TODAY + timedelta(days=2), hour=0)),
                "workItem": {
                    "workItemId": wi.pk,
                    "projectId": self.project.pk,
                    "projectName": "Paper XYZ",
                    "dueDate": _iso(TODAY + timedelta(days=2)),
                    "statusCategory": "todo",
                    "blockedReason": None,
                },
                "meeting": None,
            },
        )

    def test_meeting_candidate_serializes_correctly(self):
        chris = self.data["chris"]
        meeting = self._make_meeting(
            title="Group sync",
            scheduled_at=_at(TODAY + timedelta(days=1)),
            participants=[chris],
        )

        data = self._get(chris).json()
        section = data["todayAndNext"]
        self.assertEqual(len(section), 1)
        self.assertEqual(
            section[0],
            {
                "domain": "meeting",
                "objectId": meeting.pk,
                "title": "Group sync",
                "calendarDate": _iso(TODAY + timedelta(days=1)),
                "sortAt": _iso_z(_at(TODAY + timedelta(days=1))),
                "workItem": None,
                "meeting": {
                    "meetingId": meeting.pk,
                    "scheduledAt": _iso_z(_at(TODAY + timedelta(days=1))),
                    "status": Meeting.Status.UPCOMING,
                    "scope": Meeting.Scope.GROUP,
                    "researchGroupId": self.group.pk,
                    "projectId": None,
                },
            },
        )

    def test_exactly_one_detail_object_is_non_null(self):
        chris = self.data["chris"]
        self._make_wi(
            title="All-day work",
            assignees=[chris],
            due_date=TODAY + timedelta(days=1),
        )
        self._make_meeting(
            title="Timed meeting",
            scheduled_at=_at(TODAY, hour=15),
            participants=[chris],
        )

        section = self._get(chris).json()["todayAndNext"]
        self.assertEqual(len(section), 2)
        for row in section:
            self.assertTrue(
                (row["workItem"] is None) != (row["meeting"] is None),
                "exactly one detail object must be non-null",
            )

    def test_ordering_is_preserved(self):
        chris = self.data["chris"]
        first_meeting = self._make_meeting(
            title="Early today",
            scheduled_at=_at(TODAY, hour=15),
            participants=[chris],
        )
        work_item = self._make_wi(
            title="Due tomorrow",
            assignees=[chris],
            due_date=TODAY + timedelta(days=1),
        )
        second_meeting = self._make_meeting(
            title="Tomorrow late",
            scheduled_at=_at(TODAY + timedelta(days=1), hour=10),
            participants=[chris],
        )

        data = self._get(chris).json()
        self.assertEqual(
            [row["objectId"] for row in data["todayAndNext"]],
            [first_meeting.pk, work_item.pk, second_meeting.pk],
        )


# ── My work ──


class MyWorkSerializationTest(_HomeAggregateBase):

    def test_candidate_serializes_correctly(self):
        chris = self.data["chris"]
        wi = self._make_wi(
            title="Write literature review",
            assignees=[chris],
        )

        data = self._get(chris).json()
        section = data["myWork"]
        self.assertEqual(len(section), 1)
        self.assertEqual(
            section[0],
            {
                "workItemId": wi.pk,
                "title": "Write literature review",
                "projectId": self.project.pk,
                "projectName": "Paper XYZ",
                "typeDefinitionId": self.task_type.pk,
                "typeName": "Task",
                "statusCategory": "todo",
                "dueDate": None,
                "blockedReason": None,
            },
        )

    def test_done_work_item_exclusion_remains_unchanged(self):
        chris = self.data["chris"]
        wi = self._make_wi(
            title="Finished item",
            assignees=[chris],
            due_date=TODAY + timedelta(days=1),
        )
        update_work_item(
            work_item=wi, actor=self.data["alex"],
            status_definition_id=self.done_status.pk,
        )

        data = self._get(chris).json()
        self.assertNotIn(wi.pk, self._my_work_ids(data))
        # Also absent from the other active Home sections ...
        self.assertNotIn(wi.pk, self._attention_ids(data))
        self.assertNotIn(wi.pk, self._today_ids(data))
        # ... while the Work Item itself is still live.
        self.assertTrue(WorkItemAssignee.objects.filter(
            work_item=wi, user=chris,
        ).exists())

    def test_ordering_is_preserved(self):
        chris = self.data["chris"]
        first = self._make_wi(
            title="First responsibility",
            assignees=[chris],
        )
        second = self._make_wi(
            title="Second responsibility",
            assignees=[chris],
        )

        data = self._get(chris).json()
        self.assertEqual(
            self._my_work_ids(data), [first.pk, second.pk],
        )


# ── Continue working ──


class ContinueWorkingSerializationTest(_HomeAggregateBase):

    def test_work_item_candidate_serializes_correctly(self):
        chris = self.data["chris"]
        wi = self._make_wi(
            title="Touched work item",
            assignees=[chris],
            actor=chris,
        )
        self._pin(chris, T1, work_item=wi)

        data = self._get(chris).json()
        section = data["continueWorking"]
        self.assertEqual(len(section), 1)
        self.assertEqual(
            section[0],
            {
                "domain": "work_item",
                "objectId": wi.pk,
                "title": "Touched work item",
                "latestPersonalActivityAt": _iso_z(T1),
                "workItem": {
                    "workItemId": wi.pk,
                    "projectId": self.project.pk,
                    "projectName": "Paper XYZ",
                    "statusCategory": "todo",
                    "dueDate": None,
                },
                "meeting": None,
            },
        )

    def test_meeting_candidate_serializes_correctly(self):
        chris = self.data["chris"]
        meeting = self._make_meeting(
            title="Touched meeting",
            scheduled_at=_at(TODAY + timedelta(days=5)),
            actor=chris,
        )
        self._pin(chris, T2, meeting=meeting)

        data = self._get(chris).json()
        section = data["continueWorking"]
        self.assertEqual(len(section), 1)
        self.assertEqual(
            section[0],
            {
                "domain": "meeting",
                "objectId": meeting.pk,
                "title": "Touched meeting",
                "latestPersonalActivityAt": _iso_z(T2),
                "workItem": None,
                "meeting": {
                    "meetingId": meeting.pk,
                    "status": Meeting.Status.UPCOMING,
                    "scheduledAt": _iso_z(_at(TODAY + timedelta(days=5))),
                },
            },
        )

    def test_latest_personal_activity_at_is_serialized(self):
        chris = self.data["chris"]
        wi = self._make_wi(
            title="Created then updated",
            assignees=[chris],
            actor=chris,
        )
        update_work_item(work_item=wi, actor=chris, title="Renamed again")
        self._pin(chris, T1, event_type="work_item.created", work_item=wi)
        self._pin(chris, T2, event_type="work_item.updated", work_item=wi)

        data = self._get(chris).json()
        section = data["continueWorking"]
        self.assertEqual(len(section), 1)
        self.assertEqual(section[0]["objectId"], wi.pk)
        # The LATEST qualifying personal action wins (dedup preserved
        # through composition).
        self.assertEqual(section[0]["latestPersonalActivityAt"], _iso_z(T2))

    def test_no_raw_activity_payload_leaks(self):
        chris = self.data["chris"]
        wi = self._make_wi(
            title="Leak check item",
            assignees=[chris],
            actor=chris,
        )
        update_work_item(
            work_item=wi, actor=chris,
            due_date=_iso(TODAY + timedelta(days=1)),
        )
        # Overwrite the stored event payload with a marker that must
        # never reach the response.
        AuditEvent.objects.filter(
            actor=chris, work_item=wi,
            event_type="work_item.updated",
        ).update(data={"marker": "ZZ-RAW-AUDIT-PAYLOAD-ZZ"})

        meeting = self._make_meeting(
            title="Leak check meeting",
            scheduled_at=_at(TODAY + timedelta(days=5)),
            actor=chris,
        )
        # Canonical lifecycle: Notes are only writable on a LIVE
        # Meeting (upcoming rejects, completed is read-only) — enter
        # the live state through the real lifecycle service before
        # creating the Note.
        start_meeting(meeting=meeting, actor=chris)
        self._note_on(
            meeting, actor=chris, content="ZZ-NOTE-TEXT-ZZ",
        )

        response = self._get(chris)
        body = response.content.decode()
        data = response.json()
        # The Work Item and Meeting candidates are present ...
        self.assertIn(wi.pk, self._continue_ids(data))
        self.assertIn(meeting.pk, self._continue_ids(data))
        # ... but no raw AuditEvent payload and no Activity/Note text.
        self.assertNotIn("ZZ-RAW-AUDIT-PAYLOAD-ZZ", body)
        self.assertNotIn("ZZ-NOTE-TEXT-ZZ", body)
        _assert_no_key(data, "data")

    def test_ordering_is_preserved(self):
        chris = self.data["chris"]
        wi = self._make_wi(
            title="Older action",
            assignees=[chris],
            actor=chris,
        )
        self._pin(chris, T1, work_item=wi)
        meeting = self._make_meeting(
            title="Newer action",
            scheduled_at=_at(TODAY + timedelta(days=5)),
            actor=chris,
        )
        self._pin(chris, T2, meeting=meeting)

        data = self._get(chris).json()
        self.assertEqual(
            [row["objectId"] for row in data["continueWorking"]],
            [meeting.pk, wi.pk],
        )


# ── Authorization / fail-closed through composition ──


class HomeAggregateAuthorizationTest(_HomeAggregateBase):

    def _qualifying_wi(self, chris):
        """Overdue+blocked, due in window: qualifies for Needs
        attention, Today & next, and My work at once."""
        return self._make_wi(
            title="Qualifying item",
            assignees=[chris],
            due_date=TODAY + timedelta(days=1),
            blocked_reason="Waiting on data",
        )

    def _all_sections_contain(self, data, work_item_id):
        return (
            work_item_id in self._attention_ids(data)
            or work_item_id in self._today_ids(data)
            or work_item_id in self._my_work_ids(data)
            or work_item_id in self._continue_ids(data)
        )

    def test_inaccessible_work_item_does_not_surface_in_any_section(self):
        chris = self.data["chris"]
        wi = self._qualifying_wi(chris)
        # Positive control: the candidate is visible while accessible.
        before = self._get(chris).json()
        self.assertTrue(self._all_sections_contain(before, wi.pk))

        # Revoke Project membership; the assignment row goes stale.
        ProjectMembership.objects.filter(
            project=self.project, user=chris,
        ).delete()
        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=wi, user=chris,
            ).exists(),
        )

        data = self._get(chris).json()
        self.assertFalse(
            self._all_sections_contain(data, wi.pk),
            "stale assignment must fail closed in every section",
        )

    def test_inaccessible_meeting_does_not_surface(self):
        chris = self.data["chris"]
        # Alex's Meeting without Chris as creator/participant: group
        # and Project membership alone never grant MEETING_READ.
        meeting = self._make_meeting(
            title="Closed group sync",
            scheduled_at=_at(TODAY + timedelta(days=1)),
        )

        data = self._get(chris).json()
        self.assertNotIn(meeting.pk, self._today_ids(data))
        self.assertNotIn(meeting.pk, self._continue_ids(data))

    def test_participant_removal_affects_the_aggregate_immediately(self):
        chris = self.data["chris"]
        meeting = self._make_meeting(
            title="Participant sync",
            scheduled_at=_at(TODAY + timedelta(days=1)),
            participants=[chris],
        )
        before = self._get(chris).json()
        self.assertIn(meeting.pk, self._today_ids(before))

        MeetingParticipant.objects.filter(
            meeting=meeting, user=chris,
        ).delete()

        data = self._get(chris).json()
        self.assertNotIn(meeting.pk, self._today_ids(data))
        self.assertNotIn(meeting.pk, self._continue_ids(data))

    def test_project_membership_removal_affects_the_aggregate_immediately(
        self,
    ):
        chris = self.data["chris"]
        wi = self._qualifying_wi(chris)
        before = self._get(chris).json()
        self.assertIn(wi.pk, self._attention_ids(before))
        self.assertIn(wi.pk, self._today_ids(before))
        self.assertIn(wi.pk, self._my_work_ids(before))

        ProjectMembership.objects.filter(
            project=self.project, user=chris,
        ).delete()

        data = self._get(chris).json()
        self.assertNotIn(wi.pk, self._attention_ids(data))
        self.assertNotIn(wi.pk, self._today_ids(data))
        self.assertNotIn(wi.pk, self._my_work_ids(data))
        self.assertNotIn(wi.pk, self._continue_ids(data))

    def test_research_group_membership_removal_affects_the_aggregate_immediately(
        self,
    ):
        chris = self.data["chris"]
        wi = self._qualifying_wi(chris)
        before = self._get(chris).json()
        self.assertIn(wi.pk, self._attention_ids(before))

        # Canonical access loss: the explicit Research Group
        # offboarding workflow atomically removes the group
        # membership AND revokes the child ProjectMembership (a raw
        # ResearchGroupMembership delete while a pinned
        # ProjectMembership references it is an impossible state the
        # database forbids). Assignments are resolved explicitly.
        membership = ResearchGroupMembership.objects.get(
            research_group=self.group, user=chris,
        )
        result = offboard_research_group_member(
            membership=membership,
            actor=self.data["alex"],
            project_resolutions=[
                ResearchGroupProjectOffboardingResolution(
                    project_id=self.project.pk,
                    assignment_resolution="unassign",
                ),
            ],
        )
        self.assertEqual(result.removed_project_membership_count, 1)
        self.assertFalse(ResearchGroupMembership.objects.filter(
            research_group=self.group, user=chris,
        ).exists())
        self.assertFalse(ProjectMembership.objects.filter(
            project=self.project, user=chris,
        ).exists())

        # Final observable authorization result: no current access,
        # nothing surfaces in Home.
        data = self._get(chris).json()
        self.assertNotIn(wi.pk, self._attention_ids(data))
        self.assertNotIn(wi.pk, self._today_ids(data))
        self.assertNotIn(wi.pk, self._my_work_ids(data))
        self.assertNotIn(wi.pk, self._continue_ids(data))

    def test_view_role_demotion_fails_closed_in_active_sections(self):
        chris = self.data["chris"]
        # Chris's own Work Item (personal action → Continue working).
        wi = self._make_wi(
            title="Demoted viewer item",
            assignees=[chris],
            actor=chris,
            due_date=TODAY + timedelta(days=1),
        )
        before = self._get(chris).json()
        self.assertIn(wi.pk, self._my_work_ids(before))
        self.assertIn(wi.pk, self._today_ids(before))
        self.assertIn(wi.pk, self._continue_ids(before))

        ProjectMembership.objects.filter(
            project=self.project, user=chris,
        ).update(role=ProjectMembership.Role.VIEWER)

        data = self._get(chris).json()
        # Responsibility sections fail closed (owner/member only) ...
        self.assertNotIn(wi.pk, self._attention_ids(data))
        self.assertNotIn(wi.pk, self._today_ids(data))
        self.assertNotIn(wi.pk, self._my_work_ids(data))
        # ... while current read access (viewer) keeps the recency
        # candidate visible.
        self.assertIn(wi.pk, self._continue_ids(data))


# ── Completion / overlap ──


class HomeAggregateOverlapTest(_HomeAggregateBase):

    def test_same_work_item_appears_in_multiple_applicable_sections(self):
        chris = self.data["chris"]
        wi = self._make_wi(
            title="Blocked with due date in window",
            assignees=[chris],
            due_date=TODAY + timedelta(days=1),
            blocked_reason="Waiting on data",
        )

        data = self._get(chris).json()
        self.assertIn(wi.pk, self._attention_ids(data))
        self.assertIn(wi.pk, self._today_ids(data))
        self.assertIn(wi.pk, self._my_work_ids(data))

    def test_endpoint_does_not_deduplicate_across_sections(self):
        chris = self.data["chris"]
        wi = self._make_wi(
            title="Blocked with due date in window",
            assignees=[chris],
            due_date=TODAY + timedelta(days=1),
            blocked_reason="Waiting on data",
        )

        data = self._get(chris).json()
        for ids in (
            self._attention_ids(data),
            self._today_ids(data),
            self._my_work_ids(data),
        ):
            self.assertEqual(
                ids.count(wi.pk), 1,
                "one occurrence per section, never suppressed",
            )
        self.assertEqual(
            self._attention_ids(data), [wi.pk],
        )

    def test_done_work_item_still_in_continue_working_while_absent_from_active_sections(
        self,
    ):
        chris = self.data["chris"]
        wi = self._make_wi(
            title="Completed but touched",
            assignees=[chris],
            actor=chris,
            due_date=TODAY + timedelta(days=1),
            blocked_reason="Stale blocked note",
        )
        self._pin(chris, T1, work_item=wi)
        update_work_item(
            work_item=wi, actor=self.data["alex"],
            status_definition_id=self.done_status.pk,
        )

        data = self._get(chris).json()
        self.assertNotIn(wi.pk, self._attention_ids(data))
        self.assertNotIn(wi.pk, self._today_ids(data))
        self.assertNotIn(wi.pk, self._my_work_ids(data))

        section = [
            row for row in data["continueWorking"]
            if row["objectId"] == wi.pk
        ]
        self.assertEqual(len(section), 1)
        self.assertEqual(section[0]["latestPersonalActivityAt"], _iso_z(T1))


# ── Query behavior ──


class HomeAggregateQueryBehaviorTest(_HomeAggregateBase):

    def _build_fully_populated_home(self, chris):
        """Candidates in all four sections, including both Continue
        working domains (fully populated = 5 CW queries)."""
        # Needs attention (overdue, outside the T&N forward window).
        self._make_wi(
            title="Overdue item",
            assignees=[chris],
            actor=chris,
            due_date=TODAY - timedelta(days=1),
        )
        # Today & next + My work (due inside the window).
        self._make_wi(
            title="Due inside window",
            assignees=[chris],
            actor=chris,
            due_date=TODAY + timedelta(days=1),
        )
        # Continue working Work Item domain (personal action).
        self._make_wi(
            title="Recently touched item",
            assignees=[chris],
            actor=chris,
        )
        # Today & next Meeting domain (readable: participant).
        self._make_meeting(
            title="Upcoming group sync",
            scheduled_at=_at(TODAY + timedelta(days=2), hour=10),
            participants=[chris],
        )
        # Continue working Meeting domain (personal action + readable:
        # creator).
        self._make_meeting(
            title="Creator meeting",
            scheduled_at=_at(TODAY + timedelta(days=3), hour=11),
            actor=chris,
        )

    def _warm_client(self, chris):
        """Authenticate OUTSIDE any capture and consume the one-time
        per-session ``UserSession`` registration with a warm-up
        request, so every later capture measures the same
        steady-state request (measured: exactly 3 overhead queries —
        ``django_session`` load, ``accounts_user`` load, and
        ``accounts_usersession`` registry lookup — plus the service
        composition)."""
        self.client.force_login(chris)
        self.client.get(HOME_URL)

    def test_fully_populated_aggregate_request_remains_bounded(self):
        chris = self.data["chris"]
        self._build_fully_populated_home(chris)
        self._warm_client(chris)

        with CaptureQueriesContext(connection) as http_ctx:
            response = self.client.get(HOME_URL)
        self.assertEqual(response.status_code, 200)
        n_http = len(http_ctx.captured_queries)

        # Isolate the service-composition cost (measured baseline:
        # 1 + 2 + 1 + 5 = 9 bounded queries).
        n_na = self._capture(
            lambda: get_work_item_attention_candidates(user=chris),
        )
        n_tn = self._capture(
            lambda: get_home_timeline_candidates(user=chris),
        )
        n_mw = self._capture(
            lambda: get_home_my_work_candidates(user=chris),
        )
        n_cw = self._capture(
            lambda: get_continue_working_candidates(user=chris),
        )
        self.assertEqual(n_na, 1)
        self.assertEqual(n_tn, 2)
        self.assertEqual(n_mw, 1)
        self.assertEqual(n_cw, 5)
        service_total = n_na + n_tn + n_mw + n_cw
        self.assertEqual(service_total, 9)

        # The warmed HTTP request is the service composition plus
        # exactly the measured steady-state request/authentication
        # overhead (django_session load + user load + UserSession
        # registry lookup = 3 queries). Any additional query here
        # would indicate per-candidate or per-request drift.
        self.assertEqual(
            n_http, service_total + 3,
            "warmed aggregate request = 9 service queries + 3 "
            "measured steady-state request/authentication queries",
        )

    def test_candidate_row_growth_does_not_create_n_plus_one(self):
        chris = self.data["chris"]
        # Small: two due-in-window Work Items (Today & next + My work
        # + Continue working candidates).
        for i in (1, 2):
            self._make_wi(
                title=f"Small {i}",
                assignees=[chris],
                actor=chris,
                due_date=TODAY + timedelta(days=i),
            )
        # Both captures measure equivalent warmed request states
        # (login and one-time session registration excluded).
        self._warm_client(chris)
        with CaptureQueriesContext(connection) as small_ctx:
            small = self.client.get(HOME_URL)
        self.assertEqual(len(small.json()["todayAndNext"]), 2)
        self.assertEqual(len(small.json()["myWork"]), 2)

        # Large: twelve such candidates (6x the row count).
        for i in range(3, 13):
            self._make_wi(
                title=f"Large {i}",
                assignees=[chris],
                actor=chris,
                due_date=TODAY + timedelta(days=(i % 6) + 1),
            )
        with CaptureQueriesContext(connection) as large_ctx:
            large = self.client.get(HOME_URL)
        self.assertEqual(len(large.json()["todayAndNext"]), 12)
        self.assertEqual(len(large.json()["myWork"]), 12)

        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "aggregate query count must not scale with candidate row "
            "count; every relation must be eager-loaded in the "
            "read models.",
        )
