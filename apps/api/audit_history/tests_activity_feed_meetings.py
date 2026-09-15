"""Behavioral API tests: Meeting events in the permission-safe Activity
feed.

GET /api/activity/ now also projects the Meeting slice events
(``meeting.created`` / ``meeting.rescheduled`` / ``meeting.completed`` /
``meeting.agenda_item_added`` / ``meeting.follow_up_scheduled``).

Security contract under test (docs/domain/activity.md §5):

- Meeting read rule = creator-or-explicit-participant (the canonical
  MEETING_READ rule). Group/Project membership alone must NEVER grant
  Meeting Activity visibility.
- ``meeting.follow_up_scheduled`` references BOTH Meetings: it is
  returned only if the requester can read BOTH the source and the
  target Meeting today — target-only readability must not leak source
  Meeting metadata (title, id, item).
- Read-time revocation: removing a participant removes the Meeting's
  historical events from the feed immediately.
- A hard-deleted Meeting's events leave the feed (the meeting FK is
  nulled via SET_NULL; the event stays durable in the database).
- Inaccessible events leak nothing: no title, actor, context, event
  data, existence, count, or page behavior (filter runs in the database
  before pagination).
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase, APIClient

from projects.models import WorkItemTypeDefinition
from projects.services import create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.services import create_work_item
from meetings.models import (
    Meeting,
    MeetingParticipant,
    MeetingSection,
)
from meetings.services import (
    create_meeting,
    create_meeting_item,
    delete_meeting,
    end_meeting,
    schedule_meeting_item_follow_up,
    start_meeting,
    update_meeting,
)


User = get_user_model()

FEED_URL = "/api/activity/"


class _MeetingFeedBase(APITestCase):
    def setUp(self):
        self.client = APIClient()

        # Group "Feed Meetings":
        #   alice — member, creator of all Meetings below
        #   bob   — member, participant of M1 / M2 / M4
        #   carol — member, participant of M2 ONLY (non-participant of
        #           M1 / M3 / M4 — membership alone grants nothing)
        #   dave  — not a member of this group at all
        self.alice = User.objects.create_user(
            username="feed-mt-alice", password="Pass1!",
        )
        self.bob = User.objects.create_user(
            username="feed-mt-bob", password="Pass1!",
        )
        self.carol = User.objects.create_user(
            username="feed-mt-carol", password="Pass1!",
        )
        self.dave = User.objects.create_user(
            username="feed-mt-dave", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Feed Meetings Group",
            created_by=self.alice,
        )
        for user in (self.alice, self.bob, self.carol):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

        # Project for the project-scoped Meeting (alice is owner).
        self.project = create_project(
            research_group=self.group,
            creator=self.alice,
            name="Feed Project",
            description="",
        )

        # Meetings (group-scoped unless noted).
        self.m1 = self._create_meeting("Standup", days=1)
        self.m2 = self._create_meeting("Planning", days=3)
        self.m3 = self._create_meeting("Review", days=5)
        self.m4 = create_meeting(
            research_group=self.group,
            actor=self.alice,
            title="Project Sync",
            scheduled_at=timezone.now() + timedelta(days=2),
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )

        # Participants: bob in M1/M2/M4, carol in M2 only.
        for meeting in (self.m1, self.m2, self.m4):
            MeetingParticipant.objects.create(
                meeting=meeting, user=self.bob,
            )
        MeetingParticipant.objects.create(
            meeting=self.m2, user=self.carol,
        )

        # Event set:
        #   M1: created, rescheduled, agenda_item_added
        #   M2: created
        #   M3: created, completed
        #   M4: created
        #   follow_up_scheduled: source M1 item -> target M2
        update_meeting(
            meeting=self.m1,
            actor=self.alice,
            scheduled_at=self.m1.scheduled_at + timedelta(days=4),
        )
        self.m1_item = create_meeting_item(
            meeting=self.m1,
            meeting_section=MeetingSection.objects.get(meeting=self.m1),
            actor=self.alice,
            title="Continue the experiment",
        )
        start_meeting(meeting=self.m3, actor=self.alice)
        end_meeting(meeting=self.m3, actor=self.alice)
        schedule_meeting_item_follow_up(
            source_meeting_item=self.m1_item,
            target_meeting=self.m2,
            target_meeting_section=MeetingSection.objects.get(
                meeting=self.m2,
            ),
            actor=self.alice,
        )

    def _create_meeting(self, title, *, days):
        return create_meeting(
            research_group=self.group,
            actor=self.alice,
            title=title,
            scheduled_at=timezone.now() + timedelta(days=days),
        )

    def _login(self, user):
        self.client.force_login(user)

    def _feed_entries(self, user, **params):
        self._login(user)
        response = self.client.get(FEED_URL, params or None)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _entry_for(self, entries, event_type, meeting_id):
        matches = [
            entry
            for entry in entries
            if entry["eventType"] == event_type
            and entry["meetingId"] == meeting_id
        ]
        self.assertEqual(len(matches), 1, f"one {event_type} for {meeting_id}")
        return matches[0]

    def _meeting_event_types(self, entries, meeting_id):
        return {
            entry["eventType"]
            for entry in entries
            if entry["meetingId"] == meeting_id
        }


class MeetingFeedVisibilityTest(_MeetingFeedBase):
    def test_creator_sees_all_meeting_events(self):
        entries = self._feed_entries(self.alice)
        # M1: created + rescheduled + agenda_item_added
        self.assertEqual(
            self._meeting_event_types(entries, self.m1.pk),
            {
                "meeting.created",
                "meeting.rescheduled",
                "meeting.agenda_item_added",
            },
        )
        # M2: created + follow_up_scheduled (target)
        self.assertEqual(
            self._meeting_event_types(entries, self.m2.pk),
            {"meeting.created", "meeting.follow_up_scheduled"},
        )
        # M3: created + completed
        self.assertEqual(
            self._meeting_event_types(entries, self.m3.pk),
            {"meeting.created", "meeting.completed"},
        )
        # M4 (project-scoped): created
        self.assertEqual(
            self._meeting_event_types(entries, self.m4.pk),
            {"meeting.created"},
        )

    def test_participant_sees_their_meetings_only(self):
        entries = self._feed_entries(self.bob)
        self.assertEqual(
            self._meeting_event_types(entries, self.m1.pk),
            {
                "meeting.created",
                "meeting.rescheduled",
                "meeting.agenda_item_added",
            },
        )
        self.assertEqual(
            self._meeting_event_types(entries, self.m2.pk),
            {"meeting.created", "meeting.follow_up_scheduled"},
        )
        # M3: bob is not a participant — no event, no metadata.
        self.assertNotIn(self.m3.pk, {e["meetingId"] for e in entries})
        # M4: bob is a participant.
        self.assertEqual(
            self._meeting_event_types(entries, self.m4.pk),
            {"meeting.created"},
        )

    def test_group_membership_alone_grants_no_meeting_events(self):
        """carol is a full group member and a Project member would see
        project things — but Meetings follow creator/participant only.
        carol participates ONLY in M2."""
        entries = self._feed_entries(self.carol)
        meeting_ids = {e["meetingId"] for e in entries if e["meetingId"]}
        self.assertEqual(meeting_ids, {self.m2.pk})
        self.assertEqual(
            {e["eventType"] for e in entries},
            {"meeting.created"},
        )
        # No leak of M1/M3 titles or actors anywhere in the payload.
        payload = str(entries)
        self.assertNotIn("Standup", payload)
        self.assertNotIn("Review", payload)
        self.assertNotIn("Project Sync", payload)

    def test_group_outsider_gets_empty_meeting_feed(self):
        entries = self._feed_entries(self.dave)
        self.assertEqual(entries, [])


class MeetingFeedFollowUpVisibilityTest(_MeetingFeedBase):
    """A follow-up schedule references BOTH Meetings: readable only if
    BOTH the source and the target are readable today."""

    def _follow_up_entries(self, user):
        return [
            entry
            for entry in self._feed_entries(user)
            if entry["eventType"] == "meeting.follow_up_scheduled"
        ]

    def test_both_readable_sees_follow_up(self):
        # alice: creator of both. bob: participant of both.
        for user in (self.alice, self.bob):
            with self.subTest(user=user.username):
                entries = self._follow_up_entries(user)
                self.assertEqual(len(entries), 1)
                entry = entries[0]
                # Anchored to the target Meeting.
                self.assertEqual(entry["meetingId"], self.m2.pk)
                self.assertEqual(entry["meetingTitle"], "Planning")
                follow_up = entry["changes"]["followUp"]
                self.assertEqual(
                    follow_up["sourceMeeting"]["id"], self.m1.pk,
                )
                self.assertEqual(
                    follow_up["sourceMeeting"]["title"], "Standup",
                )

    def test_target_only_readable_does_not_see_follow_up(self):
        """carol can read the target (M2) but not the source (M1): the
        event must stay hidden — otherwise the source Meeting's title
        and id would leak."""
        entries = self._follow_up_entries(self.carol)
        self.assertEqual(entries, [])

    def test_source_only_readable_does_not_see_follow_up(self):
        """A user who can read the source but not the target must not
        see the event either (it is anchored to the target)."""
        erin = User.objects.create_user(
            username="feed-mt-erin", password="Pass1!",
        )
        MeetingParticipant.objects.create(
            meeting=self.m1, user=erin,
        )
        entries = self._follow_up_entries(erin)
        self.assertEqual(entries, [])

    def test_follow_up_payload_is_structured(self):
        entry = self._follow_up_entries(self.alice)[0]
        follow_up = entry["changes"]["followUp"]
        self.assertEqual(
            set(follow_up.keys()),
            {"sourceMeeting", "sourceItem", "targetSection", "targetItem"},
        )
        for key in ("sourceMeeting", "sourceItem", "targetItem"):
            self.assertEqual(
                set(follow_up[key].keys()), {"id", "title"},
            )
        self.assertEqual(set(follow_up["targetSection"].keys()),
                         {"id", "name"})


class MeetingFeedRevocationTest(_MeetingFeedBase):
    def test_participant_removal_removes_events_at_read_time(self):
        """Removing bob as a participant of M1 immediately removes M1's
        historical events from his feed — read-time, not creation-time."""
        MeetingParticipant.objects.filter(
            meeting=self.m1, user=self.bob,
        ).delete()

        entries = self._feed_entries(self.bob)
        self.assertNotIn(self.m1.pk, {e["meetingId"] for e in entries})
        # The follow-up event disappears too: bob can no longer read the
        # source Meeting.
        self.assertNotIn(
            "meeting.follow_up_scheduled",
            {e["eventType"] for e in entries},
        )
        # The events are still durable in the database.
        from audit_history.models import AuditEvent
        self.assertTrue(
            AuditEvent.objects.filter(meeting=self.m1).exists()
        )

    def test_target_participant_removal_removes_follow_up_event(self):
        MeetingParticipant.objects.filter(
            meeting=self.m2, user=self.bob,
        ).delete()
        entries = self._feed_entries(self.bob)
        self.assertNotIn(
            "meeting.follow_up_scheduled",
            {e["eventType"] for e in entries},
        )


class MeetingFeedDeletionTest(_MeetingFeedBase):
    def test_deleted_meeting_events_leave_the_feed_but_stay_durable(self):
        delete_meeting(meeting=self.m3, actor=self.alice)

        entries = self._feed_entries(self.alice)
        self.assertNotIn(self.m3.pk, {e["meetingId"] for e in entries})
        self.assertNotIn(
            "meeting.completed", {e["eventType"] for e in entries},
        )

        from audit_history.models import AuditEvent
        # Durable: the events survive with the meeting FK nulled.
        completed = AuditEvent.objects.filter(
            event_type="meeting.completed",
        ).get()
        self.assertIsNone(completed.meeting_id)
        self.assertEqual(completed.actor_id, self.alice.pk)


class MeetingFeedPayloadContractTest(_MeetingFeedBase):
    def test_meeting_entry_contract_and_null_project_for_group_scope(self):
        entries = self._feed_entries(self.alice)
        entry = self._entry_for(
            entries, "meeting.created", self.m1.pk,
        )

        # Exact contract: the Work Item slice keys plus the Meeting
        # identity pair (null on the non-matching side) plus the
        # additive subjectUser field (null on Meeting events).
        self.assertEqual(
            set(entry.keys()),
            {
                "id",
                "eventType",
                "actor",
                "subjectUser",
                "workItemId",
                "workItemTitle",
                "meetingId",
                "meetingTitle",
                "projectId",
                "projectName",
                "researchGroupId",
                "researchGroupName",
                "changes",
                "createdAt",
            },
        )
        self.assertIsNone(entry["workItemId"])
        self.assertIsNone(entry["workItemTitle"])
        self.assertEqual(entry["meetingTitle"], "Standup")
        # group-scoped Meeting: no Project context
        self.assertIsNone(entry["projectId"])
        self.assertIsNone(entry["projectName"])
        self.assertEqual(entry["researchGroupId"], self.group.pk)
        self.assertEqual(entry["researchGroupName"], "Feed Meetings Group")
        self.assertEqual(
            set(entry["actor"].keys()),
            {"id", "username", "firstName", "lastName"},
        )
        self.assertEqual(entry["changes"], {})

    def test_project_scoped_meeting_entry_carries_project_context(self):
        entries = self._feed_entries(self.bob)
        entry = self._entry_for(
            entries, "meeting.created", self.m4.pk,
        )
        self.assertEqual(entry["projectId"], self.project.pk)
        self.assertEqual(entry["projectName"], "Feed Project")
        self.assertEqual(entry["researchGroupId"], self.group.pk)

    def test_rescheduled_entry_carries_structured_datetime_change(self):
        entries = self._feed_entries(self.alice)
        entry = self._entry_for(
            entries, "meeting.rescheduled", self.m1.pk,
        )
        self.assertEqual(
            set(entry["changes"].keys()), {"scheduledAt"},
        )
        change = entry["changes"]["scheduledAt"]
        self.assertEqual(set(change.keys()), {"from", "to"})
        # Machine-readable ISO-8601 UTC strings, not rendered sentences.
        for value in (change["from"], change["to"]):
            self.assertIn("T", value)
            self.assertIn("+00:00", value)


class MeetingFeedMixedOrderingTest(_MeetingFeedBase):
    def test_meeting_and_work_item_events_interleave_newest_first(self):
        # A Work Item in the same Project: bob (not a project member)
        # cannot see it at all; alice sees both object kinds in one
        # deterministic reverse-chronological feed.
        task_type = (
            WorkItemTypeDefinition.objects.filter(
                project=self.project,
            ).first()
        )
        create_work_item(
            project=self.project,
            actor=self.alice,
            type_definition_id=task_type.pk,
            title="Feed Work Item",
        )

        entries = self._feed_entries(self.alice)
        types = [e["eventType"] for e in entries]
        self.assertIn("work_item.created", types)
        self.assertIn("meeting.created", types)

        # Deterministic reverse-chronological over the UNION: newest
        # created_at first, id tie-break — identical to ordering the
        # readable events directly.
        from audit_history.models import AuditEvent
        # Every event in this fixture is readable by alice, so the feed
        # must equal the full reverse-chronological event order.
        expected = list(
            AuditEvent.objects
            .order_by("-created_at", "-id")
            .values_list("id", flat=True)
        )
        self.assertEqual([e["id"] for e in entries], expected)

        # bob is not a Project member: his feed must contain the meeting
        # events but NOT the work item event.
        bob_entries = self._feed_entries(self.bob)
        self.assertNotIn(
            "work_item.created",
            [e["eventType"] for e in bob_entries],
        )
        self.assertIn(
            "meeting.created",
            [e["eventType"] for e in bob_entries],
        )
