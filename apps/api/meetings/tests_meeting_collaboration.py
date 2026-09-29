"""Behavioral contract tests for the Meeting collaboration rules.

Canonical slice: align Meeting collaboration permissions with the FG
Workspace concept.

- Group-scoped Meetings are fully collaborative for EVERY current
  Research Group member (admin is not required).
- Project-scoped Meetings are collaborative for the creator and every
  explicit valid participant — any Project role (owner/member/viewer)
  with a valid current ProjectMembership while the Project is not
  archived.
- Meeting collaboration NEVER grants Project or Work Item rights.
- Participant eligibility: group Meetings require current Research
  Group membership; project Meetings require valid current Project
  access. Nothing is created as a side effect.
- The moderator is not an authorization gate.

Stabilization (destructive administration split):

- Project Meeting READ additionally requires a valid CURRENT
  ProjectMembership: a stale creator/participant relation without
  current Project access grants neither read nor write access.
- Destructive Project Meeting administration (permanently deleting
  the Meeting, cancelling a materialized recurrence occurrence,
  removing a participant) additionally requires the pre-existing
  scoped Project write rule (PROJECT_WORK: owner/member, non-archived).
  Collaboration (edit/start/lifecycle/add participants) stays open to
  any valid participant role, including viewer.
- Group Meetings are unaffected: every current Research Group member
  keeps the full Meeting surface, including destructive actions.
"""

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership
from projects.services import (
    add_project_membership,
    create_project,
)
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import Meeting, MeetingParticipant
from .services import (
    add_meeting_participant,
    create_meeting,
    create_meeting_recurrence,
    create_meeting_series,
    expand_meeting_recurrence_occurrences,
    materialize_meeting_recurrence_occurrence,
)


User = get_user_model()


class MeetingCollaborationContractTest(TestCase):
    """The 14 canonical behavioral cases for the new contract."""

    def setUp(self):
        self.client = APIClient()

        # ── Research Group: Collab Group ─────────────────────────
        # owner  — ADMIN (project owner)
        # member — plain MEMBER (the "normal Research Group member")
        # member2 — plain MEMBER (eligible add target)
        # pm     — MEMBER + Project MEMBER
        # pv     — MEMBER + Project VIEWER
        # outsider — no group, no Project access
        self.owner = User.objects.create_user(
            username="collab-owner", password="Pass1!",
        )
        self.member = User.objects.create_user(
            username="collab-member", password="Pass1!",
        )
        self.member2 = User.objects.create_user(
            username="collab-member2", password="Pass1!",
        )
        self.pm = User.objects.create_user(
            username="collab-pm", password="Pass1!",
        )
        self.pv = User.objects.create_user(
            username="collab-pv", password="Pass1!",
        )
        self.outsider = User.objects.create_user(
            username="collab-outsider", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Collab Group",
            created_by=self.owner,
        )
        for user, role in (
            (self.owner, ResearchGroupMembership.Role.ADMIN),
            (self.member, ResearchGroupMembership.Role.MEMBER),
            (self.member2, ResearchGroupMembership.Role.MEMBER),
            (self.pm, ResearchGroupMembership.Role.MEMBER),
            (self.pv, ResearchGroupMembership.Role.MEMBER),
        ):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=role,
            )

        # ── Project: owner + member + viewer ─────────────────────
        self.project = create_project(
            research_group=self.group,
            creator=self.owner,
            name="Collab Project",
        )
        add_project_membership(
            project=self.project,
            actor=self.owner,
            target_user=self.pm,
            role=ProjectMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project,
            actor=self.owner,
            target_user=self.pv,
            role=ProjectMembership.Role.VIEWER,
        )
        self.task_type = self.project.type_definitions.get(name="Task")

        self.scheduled_at = timezone.now() + timedelta(days=1)

        # ── Meetings ─────────────────────────────────────────────
        # Group meeting created by the admin; NO other participants.
        self.group_meeting = create_meeting(
            research_group=self.group,
            actor=self.owner,
            title="Collab Group Weekly",
            scheduled_at=self.scheduled_at,
        )
        # Project meeting with BOTH eligible roles as explicit
        # participants.
        self.project_meeting = create_meeting(
            research_group=self.group,
            actor=self.owner,
            title="Collab Project Sync",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        add_meeting_participant(
            meeting=self.project_meeting,
            actor=self.owner,
            target_user=self.pm,
        )
        add_meeting_participant(
            meeting=self.project_meeting,
            actor=self.owner,
            target_user=self.pv,
        )
        # Project meeting with NO explicit participants beyond the
        # creator (for the non-participant visibility case).
        self.closed_project_meeting = create_meeting(
            research_group=self.group,
            actor=self.owner,
            title="Closed Project Sync",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    # ── A. Group-scoped Meeting ──────────────────────────────────

    def test_group_member_can_read_group_meeting_without_participation(self):
        # 1. A normal Research Group MEMBER reads a group Meeting even
        #    when not an explicit participant (detail + discovery).
        self.login(self.member)
        detail = self.client.get(
            f"/api/meetings/{self.group_meeting.pk}/",
        )
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/",
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertIn(
            self.group_meeting.pk,
            [m["id"] for m in listing.json()],
        )

    def test_group_member_can_edit_group_meeting(self):
        # 2. A normal Research Group MEMBER edits Meeting content
        #    (title, section, item) — no admin required.
        self.login(self.member)

        patch = self.client.patch(
            f"/api/meetings/{self.group_meeting.pk}/",
            {"title": "Edited by member"},
            format="json",
        )
        self.assertEqual(patch.status_code, status.HTTP_200_OK)
        self.group_meeting.refresh_from_db()
        self.assertEqual(self.group_meeting.title, "Edited by member")

        section = self.client.post(
            f"/api/meetings/{self.group_meeting.pk}/sections/",
            {"name": "Member section"},
            format="json",
        )
        self.assertEqual(section.status_code, status.HTTP_201_CREATED)

        item = self.client.post(
            f"/api/meetings/{self.group_meeting.pk}/items/",
            {
                "meetingSectionId": section.json()["id"],
                "title": "Member item",
            },
            format="json",
        )
        self.assertEqual(item.status_code, status.HTTP_201_CREATED)

    def test_group_member_can_run_lifecycle(self):
        # 3. A normal Research Group MEMBER starts, ends, and reopens
        #    the group Meeting according to the lifecycle.
        self.login(self.member)

        start = self.client.post(
            f"/api/meetings/{self.group_meeting.pk}/start",
        )
        self.assertEqual(start.status_code, status.HTTP_200_OK)
        self.group_meeting.refresh_from_db()
        self.assertEqual(self.group_meeting.status, Meeting.Status.LIVE)

        end = self.client.post(f"/api/meetings/{self.group_meeting.pk}/end")
        self.assertEqual(end.status_code, status.HTTP_200_OK)
        self.group_meeting.refresh_from_db()
        self.assertEqual(self.group_meeting.status, Meeting.Status.COMPLETED)

        reopen = self.client.post(
            f"/api/meetings/{self.group_meeting.pk}/reopen",
        )
        self.assertEqual(reopen.status_code, status.HTTP_200_OK)
        self.group_meeting.refresh_from_db()
        self.assertEqual(self.group_meeting.status, Meeting.Status.LIVE)

    def test_group_member_can_add_another_eligible_member(self):
        # 4. A normal Research Group MEMBER adds another eligible
        #    current Research Group member.
        self.login(self.member)
        response = self.client.post(
            f"/api/meetings/{self.group_meeting.pk}/participants/",
            {"userId": self.member2.pk},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertTrue(
            MeetingParticipant.objects.filter(
                meeting=self.group_meeting,
                user=self.member2,
            ).exists()
        )

    def test_group_meeting_rejects_user_outside_research_group(self):
        # 5. A group Meeting rejects a user outside the Research
        #    Group; nothing is persisted and no membership is created
        #    as a side effect.
        self.login(self.member)
        response = self.client.post(
            f"/api/meetings/{self.group_meeting.pk}/participants/",
            {"userId": self.outsider.pk},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(
            MeetingParticipant.objects.filter(
                meeting=self.group_meeting,
                user=self.outsider,
            ).exists()
        )
        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group,
                user=self.outsider,
            ).exists()
        )

    def test_group_candidate_search_does_not_leak_outside_group(self):
        # 6. Group Meeting candidate discovery exposes only eligible
        #    current Research Group members.
        self.login(self.member)
        response = self.client.get(
            f"/api/meetings/{self.group_meeting.pk}/participant-candidates/",
            {"q": "collab"},
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            {c["id"] for c in response.json()},
            {
                self.owner.pk,
                self.member.pk,
                self.member2.pk,
                self.pm.pk,
                self.pv.pk,
            },
        )
        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group,
                user=self.outsider,
            ).exists()
        )

    # ── C/D. Project-scoped Meeting ──────────────────────────────

    def test_project_member_participant_can_edit_and_start(self):
        # 7. An explicit participant with the Project MEMBER role
        #    edits and starts the Project Meeting.
        self.login(self.pm)

        patch = self.client.patch(
            f"/api/meetings/{self.project_meeting.pk}/",
            {"title": "Edited by member"},
            format="json",
        )
        self.assertEqual(patch.status_code, status.HTTP_200_OK)

        start = self.client.post(
            f"/api/meetings/{self.project_meeting.pk}/start",
        )
        self.assertEqual(start.status_code, status.HTTP_200_OK)
        self.project_meeting.refresh_from_db()
        self.assertEqual(self.project_meeting.status, Meeting.Status.LIVE)

    def test_project_viewer_participant_can_edit_and_start(self):
        # 8. An explicit participant with the Project VIEWER role
        #    edits and starts the Project Meeting — no Project write
        #    role is required to operate the Meeting.
        self.login(self.pv)

        patch = self.client.patch(
            f"/api/meetings/{self.project_meeting.pk}/",
            {"title": "Edited by viewer"},
            format="json",
        )
        self.assertEqual(patch.status_code, status.HTTP_200_OK)

        start = self.client.post(
            f"/api/meetings/{self.project_meeting.pk}/start",
        )
        self.assertEqual(start.status_code, status.HTTP_200_OK)
        self.project_meeting.refresh_from_db()
        self.assertEqual(self.project_meeting.status, Meeting.Status.LIVE)

    def test_project_viewer_participant_cannot_perform_project_work(self):
        # 9. The same viewer participant gains NO Project/Work Item
        #    rights from the Meeting collaboration.
        self.login(self.pv)

        # No Work Item creation (PROJECT_WORK boundary).
        wi = self.client.post(
            f"/api/projects/{self.project.pk}/work-items/",
            {
                "title": "Hijack",
                "typeDefinitionId": self.task_type.pk,
            },
            format="json",
        )
        self.assertEqual(wi.status_code, status.HTTP_403_FORBIDDEN)

        # No Project metadata edit.
        patch = self.client.patch(
            f"/api/projects/{self.project.pk}/",
            {"name": "Hijacked"},
            format="json",
        )
        self.assertEqual(patch.status_code, status.HTTP_403_FORBIDDEN)
        self.project.refresh_from_db()
        self.assertEqual(self.project.name, "Collab Project")

        # The viewer is still not an eligible Work Item assignee.
        self.login(self.owner)
        wi_assign = self.client.post(
            f"/api/projects/{self.project.pk}/work-items/",
            {
                "title": "With viewer assignee",
                "typeDefinitionId": self.task_type.pk,
                "assigneeIds": [self.pv.pk],
            },
            format="json",
        )
        self.assertEqual(wi_assign.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_participant_project_member_cannot_see_meeting(self):
        # 10. A Project user who is NOT a Meeting participant gains no
        #     Meeting visibility from Project membership.
        self.login(self.pm)
        detail = self.client.get(
            f"/api/meetings/{self.closed_project_meeting.pk}/",
        )
        self.assertEqual(detail.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            detail.json(),
            {"error": "Meeting not found"},
        )
        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/",
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertNotIn(
            self.closed_project_meeting.pk,
            [m["id"] for m in listing.json()],
        )
        # The creator keeps access.
        self.login(self.owner)
        self.assertEqual(
            self.client.get(
                f"/api/meetings/{self.closed_project_meeting.pk}/",
            ).status_code,
            status.HTTP_200_OK,
        )

    def test_project_meeting_rejects_user_without_project_membership(self):
        # 11. A Project Meeting rejects a user without
        #     ProjectMembership as a participant; no Project
        #     membership is created as a side effect.
        self.login(self.pm)
        response = self.client.post(
            f"/api/meetings/{self.project_meeting.pk}/participants/",
            {"userId": self.member.pk},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(
            MeetingParticipant.objects.filter(
                meeting=self.project_meeting,
                user=self.member,
            ).exists()
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.member,
            ).exists()
        )

    def test_project_candidate_discovery_respects_project_membership(self):
        # 12. Project Meeting candidate discovery exposes only users
        #     with a valid current ProjectMembership.
        self.login(self.pm)
        response = self.client.get(
            f"/api/meetings/{self.project_meeting.pk}/participant-candidates/",
            {"q": "collab"},
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            {c["id"] for c in response.json()},
            {self.owner.pk, self.pm.pk, self.pv.pk},
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.member,
            ).exists()
        )

    # ── E. Project isolation / non-leaking responses ─────────────

    def test_outsider_receives_non_leaking_response(self):
        # 13. An unrelated user (outside the Research Group) gets the
        #     existing non-leaking responses: 404 on the Meeting and
        #     no group Meeting listing.
        self.login(self.outsider)
        detail = self.client.get(
            f"/api/meetings/{self.group_meeting.pk}/",
        )
        self.assertEqual(detail.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            detail.json(),
            {"error": "Meeting not found"},
        )
        # The group Meeting listing is the existing non-leaking
        # response for non-members: 200 with an empty list.
        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/",
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertEqual(listing.json(), [])
        detail_project = self.client.get(
            f"/api/meetings/{self.project_meeting.pk}/",
        )
        self.assertEqual(
            detail_project.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_lifecycle_state_machine_invariants_unchanged(self):
        # 14. The lifecycle state machine invariants are unchanged
        #     under the collaboration rules (group Meeting, driven by
        #     a normal member).
        self.login(self.member)
        base = f"/api/meetings/{self.group_meeting.pk}"

        # upcoming -> end is rejected.
        end_upcoming = self.client.post(f"{base}/end")
        self.assertEqual(end_upcoming.status_code, status.HTTP_400_BAD_REQUEST)

        # upcoming -> live is valid; a second start is rejected.
        self.assertEqual(self.client.post(f"{base}/start").status_code,
                         status.HTTP_200_OK)
        repeat_start = self.client.post(f"{base}/start")
        self.assertEqual(repeat_start.status_code, status.HTTP_400_BAD_REQUEST)
        # live cannot be reopened.
        reopen_live = self.client.post(f"{base}/reopen")
        self.assertEqual(reopen_live.status_code, status.HTTP_400_BAD_REQUEST)

        # live -> completed; a second end is rejected.
        self.assertEqual(self.client.post(f"{base}/end").status_code,
                         status.HTTP_200_OK)
        repeat_end = self.client.post(f"{base}/end")
        self.assertEqual(repeat_end.status_code, status.HTTP_400_BAD_REQUEST)

        # completed -> live is valid; the reopened Meeting can be
        # ended again.
        self.assertEqual(self.client.post(f"{base}/reopen").status_code,
                         status.HTTP_200_OK)
        self.assertEqual(self.client.post(f"{base}/end").status_code,
                         status.HTTP_200_OK)
        self.group_meeting.refresh_from_db()
        self.assertEqual(self.group_meeting.status, Meeting.Status.COMPLETED)

    # ── Read boundary: current Project access is required ────────

    def test_project_participant_loses_read_after_membership_revoked(self):
        # Removing the ProjectMembership makes the Meeting detail
        # answer a non-leaking 404: the creator/participant
        # relationship AND current Project access are both required.
        self.login(self.pv)
        readable = self.client.get(
            f"/api/meetings/{self.project_meeting.pk}/",
        )
        self.assertEqual(readable.status_code, status.HTTP_200_OK)

        ProjectMembership.objects.filter(
            project=self.project, user=self.pv,
        ).delete()

        detail = self.client.get(
            f"/api/meetings/{self.project_meeting.pk}/",
        )
        self.assertEqual(detail.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            detail.json(), {"error": "Meeting not found"},
        )
        # Write is revoked as well (non-leaking 404, not 403).
        patch = self.client.patch(
            f"/api/meetings/{self.project_meeting.pk}/",
            {"title": "Stale write"},
            format="json",
        )
        self.assertEqual(patch.status_code, status.HTTP_404_NOT_FOUND)
        self.project_meeting.refresh_from_db()
        self.assertEqual(self.project_meeting.title, "Collab Project Sync")

    def test_stale_participant_relation_does_not_restore_discovery(self):
        # The stale participant relation alone does not restore
        # list/discovery access, while untouched access sources
        # (group membership) keep working.
        ProjectMembership.objects.filter(
            project=self.project, user=self.pm,
        ).delete()

        self.login(self.pm)
        listing = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/",
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        listed = [m["id"] for m in listing.json()]
        self.assertNotIn(self.project_meeting.pk, listed)
        self.assertNotIn(self.closed_project_meeting.pk, listed)
        # Group Meeting discovery is membership-based and intact.
        self.assertIn(self.group_meeting.pk, listed)

    # ── Destructive administration split ─────────────────────────

    def test_project_viewer_participant_cannot_delete_meeting(self):
        # A viewer-participant collaborates but may NOT permanently
        # delete the Meeting (scoped Project write rule required).
        self.login(self.pv)
        response = self.client.delete(
            f"/api/meetings/{self.project_meeting.pk}/",
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(
            Meeting.objects.filter(pk=self.project_meeting.pk).exists()
        )

    def test_project_viewer_participant_cannot_remove_participant(self):
        # A viewer-participant may NOT remove another participant.
        participant = MeetingParticipant.objects.get(
            meeting=self.project_meeting, user=self.pm,
        )
        self.login(self.pv)
        response = self.client.delete(
            f"/api/meetings/{self.project_meeting.pk}/participants/"
            f"{participant.pk}/",
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(
            MeetingParticipant.objects.filter(pk=participant.pk).exists()
        )

    def _project_recurrence_meeting_with_viewer_participant(self):
        """A materialized project-scoped recurring occurrence whose
        explicit participants include the Project viewer."""
        series = create_meeting_series(
            research_group=self.group,
            actor=self.owner,
            title="Project Daily",
            scope="project",
            project=self.project,
        )
        recurrence = create_meeting_recurrence(
            research_group=self.group,
            actor=self.owner,
            meeting_series=series,
            title="Project Daily",
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
            scope="project",
            project=self.project,
        )
        tz = ZoneInfo("Europe/Berlin")
        start = datetime(2026, 1, 5, 9, 30, tzinfo=tz)
        (occurrence,) = expand_meeting_recurrence_occurrences(
            meeting_recurrence=recurrence,
            range_start=start,
            range_end=start + timedelta(minutes=1),
        )
        meeting = materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.owner,
            title="Materialized Project Daily",
        )
        add_meeting_participant(
            meeting=meeting,
            actor=self.owner,
            target_user=self.pv,
        )
        return recurrence, meeting

    def test_project_viewer_participant_cannot_cancel_materialized_occurrence(self):
        # Cancellation of a materialized recurring occurrence is
        # destructive administration: a viewer-participant is
        # denied, nothing is persisted.
        recurrence, meeting = (
            self._project_recurrence_meeting_with_viewer_participant()
        )
        self.login(self.pv)
        response = self.client.post(
            f"/api/meetings/{meeting.pk}/cancel",
            data="{}",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)

    def test_project_member_participant_keeps_destructive_administration(self):
        # A Project MEMBER participant retains the destructive
        # operations through the existing scoped Project write rule:
        # participant removal and permanent deletion.
        participant = MeetingParticipant.objects.get(
            meeting=self.project_meeting, user=self.pv,
        )
        self.login(self.pm)

        removed = self.client.delete(
            f"/api/meetings/{self.project_meeting.pk}/participants/"
            f"{participant.pk}/",
        )
        self.assertEqual(removed.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            MeetingParticipant.objects.filter(pk=participant.pk).exists()
        )

        deleted = self.client.delete(
            f"/api/meetings/{self.project_meeting.pk}/",
        )
        self.assertEqual(deleted.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            Meeting.objects.filter(pk=self.project_meeting.pk).exists()
        )

    def test_group_member_keeps_full_destructive_administration(self):
        # Group Meetings stay fully collaborative: a normal member
        # removes a participant and permanently deletes the Meeting.
        self.login(self.member)
        added = self.client.post(
            f"/api/meetings/{self.group_meeting.pk}/participants/",
            {"userId": self.member2.pk},
            format="json",
        )
        self.assertEqual(added.status_code, status.HTTP_201_CREATED)
        participant = MeetingParticipant.objects.get(
            meeting=self.group_meeting, user=self.member2,
        )

        removed = self.client.delete(
            f"/api/meetings/{self.group_meeting.pk}/participants/"
            f"{participant.pk}/",
        )
        self.assertEqual(removed.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            MeetingParticipant.objects.filter(pk=participant.pk).exists()
        )

        deleted = self.client.delete(
            f"/api/meetings/{self.group_meeting.pk}/",
        )
        self.assertEqual(deleted.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            Meeting.objects.filter(pk=self.group_meeting.pk).exists()
        )
