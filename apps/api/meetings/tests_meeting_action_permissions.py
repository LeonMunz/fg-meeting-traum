"""Action-permission read model for concrete Meetings.

Covers the canonical ``actionPermissions`` projection on the concrete
Meeting representation:

- the exact semantics of ``canEdit`` / ``canDelete`` / ``canCancel``
  against the canonical authorization kernel (MEETING_WRITE /
  MEETING_ADMIN) and the existing destructive-operation eligibility
  rules;
- the permission boundary matrix (group member, Project Meeting
  creator, owner/member participant, viewer participant, archived
  Project, inaccessible Meetings);
- the deletion/cancellation distinction (standalone hard deletion vs
  materialized-occurrence cancellation, lifecycle-gated);
- list + detail response contract and non-leaking behavior;
- the list endpoint's constant query count (no per-Meeting or
  per-Project N+1).
"""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from datetime import date, time

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership
from projects.services import (
    add_project_membership,
    archive_project,
    create_project,
)
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from .models import Meeting
from .services import (
    add_meeting_participant,
    cancel_meeting_recurrence_occurrence,
    create_meeting,
    create_meeting_recurrence,
    create_meeting_series,
    create_series_section,
    expand_meeting_recurrence_occurrences,
    end_meeting,
    materialize_meeting_recurrence_occurrence,
    start_meeting,
)

User = get_user_model()

ACTION_PERMISSION_KEYS = {"canEdit", "canDelete", "canCancel"}


def _action_permissions(entry):
    """The actionPermissions block of one serialized Meeting."""
    assert isinstance(entry.get("actionPermissions"), dict)
    permissions = entry["actionPermissions"]
    assert set(permissions) == ACTION_PERMISSION_KEYS
    for value in permissions.values():
        assert isinstance(value, bool)
    return permissions


class MeetingActionPermissionsBase(TestCase):
    """Shared fixtures: group (alex admin, chris member, laura member,
    dave member), project (alex owner, chris member, laura viewer,
    dave member), and an outsider (maria)."""

    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="perm-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="perm-chris", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="perm-laura", password="Pass1!",
        )
        self.dave = User.objects.create_user(
            username="perm-dave", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="perm-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Permission Group", created_by=self.alex,
        )
        for user, role in [
            (self.alex, ResearchGroupMembership.Role.ADMIN),
            (self.chris, ResearchGroupMembership.Role.MEMBER),
            (self.laura, ResearchGroupMembership.Role.MEMBER),
            (self.dave, ResearchGroupMembership.Role.MEMBER),
        ]:
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=role,
            )

        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Permission Project",
        )
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.laura,
            role=ProjectMembership.Role.VIEWER,
        )
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.dave,
            role=ProjectMembership.Role.MEMBER,
        )

        self.scheduled_at = (
            timezone.now().replace(microsecond=0)
            + timedelta(days=1)
        )

    # ── fixtures ───────────────────────────────────────────────

    def create_group_meeting(self, **kwargs):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=kwargs.pop("title", "Group Meeting"),
            scheduled_at=self.scheduled_at,
            **kwargs,
        )

    def create_project_meeting(self, **kwargs):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=kwargs.pop("title", "Project Meeting"),
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
            **kwargs,
        )

    def _create_series(self, **overrides):
        params = dict(
            research_group=self.group,
            actor=self.alex,
            title="Permission Standup Template",
        )
        params.update(overrides)
        series = create_meeting_series(**params)
        create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="Agenda",
        )
        return series

    def _create_recurrence(self, **overrides):
        params = dict(
            research_group=self.group,
            actor=self.alex,
            meeting_series=self._create_series(),
            title="Permission Standup",
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
        )
        params.update(overrides)
        return create_meeting_recurrence(**params)

    def _materialize_occurrence(self, recurrence, local_date, *,
                                title="Mat"):
        """Materialize the rule occurrence whose local date is given."""
        tz = ZoneInfo(recurrence.timezone_name)
        day_start = datetime(*local_date, tzinfo=tz)
        (occurrence,) = expand_meeting_recurrence_occurrences(
            meeting_recurrence=recurrence,
            range_start=day_start,
            range_end=day_start + timedelta(hours=23, minutes=59),
        )
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.alex,
            title=title,
        )

    # ── API helpers ────────────────────────────────────────────

    def login(self, user):
        self.client.force_login(user)

    def detail_permissions(self, user, meeting):
        self.login(user)
        response = self.client.get(f"/api/meetings/{meeting.pk}/")
        assert response.status_code == status.HTTP_200_OK
        return _action_permissions(response.json())

    def list_entries(self, user):
        self.login(user)
        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )
        assert response.status_code == status.HTTP_200_OK
        return {entry["id"]: entry for entry in response.json()}


class MeetingActionPermissionsContractTest(
    MeetingActionPermissionsBase,
):
    """Response shape: the projection is present, boolean, exact."""

    def test_list_entry_carries_action_permissions(self):
        meeting = self.create_group_meeting()

        entries = self.list_entries(self.chris)

        entry = entries[meeting.pk]
        permissions = _action_permissions(entry)
        self.assertEqual(
            (permissions["canEdit"],
             permissions["canDelete"],
             permissions["canCancel"]),
            (True, True, False),
        )

    def test_list_preserves_existing_representation_fields(self):
        meeting = self.create_group_meeting(title="Field Check")

        entries = self.list_entries(self.chris)
        entry = entries[meeting.pk]

        for field in [
            "id", "researchGroupId", "scope", "projectId", "seriesId",
            "title", "scheduledAt", "startedAt", "endedAt", "status",
            "currentMeetingItemId", "participantIds", "createdById",
            "createdAt", "updatedAt",
        ]:
            self.assertIn(field, entry)
        self.assertEqual(entry["title"], "Field Check")
        self.assertEqual(entry["scope"], "group")
        self.assertIsNone(entry["projectId"])

    def test_detail_carries_action_permissions(self):
        meeting = self.create_group_meeting()

        self.login(self.chris)
        response = self.client.get(f"/api/meetings/{meeting.pk}/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        permissions = _action_permissions(response.json())
        self.assertTrue(permissions["canEdit"])
        self.assertTrue(permissions["canDelete"])
        self.assertFalse(permissions["canCancel"])

    def test_serializer_without_request_context_denies_everything(self):
        from .serializers import MeetingSerializer

        meeting = self.create_group_meeting()
        data = MeetingSerializer(meeting).data

        self.assertEqual(
            data["actionPermissions"],
            {"canEdit": False, "canDelete": False, "canCancel": False},
        )


class MeetingActionPermissionsBoundaryTest(
    MeetingActionPermissionsBase,
):
    """The permission boundary matrix over the canonical kernel."""

    # ── Research Group Meetings ───────────────────────────────

    def test_current_group_member_gets_all_actions_on_group_meeting(
        self,
    ):
        meeting = self.create_group_meeting()

        permissions = self.detail_permissions(self.chris, meeting)

        self.assertEqual(
            permissions,
            {"canEdit": True, "canDelete": True, "canCancel": False},
        )

    def test_group_meeting_standalone_is_deletable_not_cancellable(
        self,
    ):
        meeting = self.create_group_meeting()

        permissions = self.detail_permissions(self.alex, meeting)

        self.assertTrue(permissions["canDelete"])
        self.assertFalse(permissions["canCancel"])

    # ── Project Meetings: collaboration vs administration ──────

    def test_project_meeting_creator_gets_all_actions(self):
        meeting = self.create_project_meeting()

        permissions = self.detail_permissions(self.alex, meeting)

        self.assertEqual(
            permissions,
            {"canEdit": True, "canDelete": True, "canCancel": False},
        )

    def test_owner_or_member_participant_gets_all_actions(self):
        meeting = self.create_project_meeting(participants=[self.chris])

        permissions = self.detail_permissions(self.chris, meeting)

        self.assertEqual(
            permissions,
            {"canEdit": True, "canDelete": True, "canCancel": False},
        )

    def test_viewer_participant_can_edit_but_not_administer(self):
        meeting = self.create_project_meeting(participants=[self.laura])

        permissions = self.detail_permissions(self.laura, meeting)

        # The edit/administration distinction is preserved: a
        # viewer who may edit the Meeting gets NO destructive
        # administration rights.
        self.assertEqual(
            permissions,
            {"canEdit": True, "canDelete": False, "canCancel": False},
        )

    def test_archived_project_meeting_denies_all_actions(self):
        meeting = self.create_project_meeting(
            participants=[self.chris, self.laura],
        )
        archive_project(project=self.project, actor=self.alex)

        for user in [self.alex, self.chris, self.laura]:
            permissions = self.detail_permissions(user, meeting)
            self.assertEqual(
                permissions,
                {"canEdit": False, "canDelete": False,
                 "canCancel": False},
                msg=f"unexpected permissions for {user.username}",
            )

    # ── Inaccessible Meetings never leak ───────────────────────

    def test_project_member_without_participation_cannot_see_meeting(
        self,
    ):
        meeting = self.create_project_meeting(participants=[self.chris])

        # dave is a Project member but not the creator or a
        # participant: the Meeting is invisible to him.
        entries = self.list_entries(self.dave)
        self.assertNotIn(meeting.pk, entries)

        self.login(self.dave)
        response = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_outsider_cannot_see_project_meeting(self):
        meeting = self.create_project_meeting(participants=[self.chris])

        entries = self.list_entries(self.maria)
        self.assertNotIn(meeting.pk, entries)

        self.login(self.maria)
        response = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_stale_participant_without_project_access_cannot_see(
        self,
    ):
        meeting = self.create_project_meeting(participants=[self.laura])

        # Remove laura's Project access: her participant row stays
        # persisted, but the Meeting is no longer readable.
        ProjectMembership.objects.filter(
            project=self.project, user=self.laura,
        ).delete()

        entries = self.list_entries(self.laura)
        self.assertNotIn(meeting.pk, entries)

        self.login(self.laura)
        response = self.client.get(f"/api/meetings/{meeting.pk}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)


class MeetingActionPermissionsRecurrenceTest(
    MeetingActionPermissionsBase,
):
    """Recurring provenance: hard delete vs cancellation, lifecycle."""

    def setUp(self):
        super().setUp()
        self.recurrence = self._create_recurrence()
        self.upcoming_meeting = self._materialize_occurrence(
            self.recurrence, (2026, 1, 5),
        )
        self.assertEqual(
            self.upcoming_meeting.status, Meeting.Status.UPCOMING,
        )

    def test_materialized_upcoming_occurrence_cancel_not_delete(self):
        permissions = self.detail_permissions(
            self.chris, self.upcoming_meeting,
        )

        # A concrete recurring Meeting must NOT advertise the
        # generic hard deletion — even though every current group
        # member holds MEETING_ADMIN.
        self.assertEqual(
            permissions,
            {"canEdit": True, "canDelete": False, "canCancel": True},
        )

    def test_materialized_live_occurrence_not_cancellable(self):
        start_meeting(meeting=self.upcoming_meeting, actor=self.alex)
        self.upcoming_meeting.refresh_from_db()

        permissions = self.detail_permissions(
            self.chris, self.upcoming_meeting,
        )

        self.assertEqual(
            permissions,
            {"canEdit": True, "canDelete": False, "canCancel": False},
        )

    def test_materialized_completed_occurrence_not_cancellable(self):
        start_meeting(meeting=self.upcoming_meeting, actor=self.alex)
        end_meeting(meeting=self.upcoming_meeting, actor=self.alex)
        self.upcoming_meeting.refresh_from_db()
        self.assertEqual(
            self.upcoming_meeting.status, Meeting.Status.COMPLETED,
        )

        permissions = self.detail_permissions(
            self.chris, self.upcoming_meeting,
        )

        self.assertEqual(
            permissions,
            {"canEdit": True, "canDelete": False, "canCancel": False},
        )

    def test_cancelled_occurrence_offers_no_further_cancel(self):
        cancel_meeting_recurrence_occurrence(
            meeting=self.upcoming_meeting, actor=self.alex,
        )
        self.upcoming_meeting.refresh_from_db()
        self.assertEqual(
            self.upcoming_meeting.status, Meeting.Status.CANCELLED,
        )

        permissions = self.detail_permissions(
            self.chris, self.upcoming_meeting,
        )

        self.assertEqual(
            permissions,
            {"canEdit": True, "canDelete": False, "canCancel": False},
        )

    def test_project_recurrence_viewer_participant_cannot_administer(
        self,
    ):
        series = self._create_series(
            scope=Meeting.Scope.PROJECT, project=self.project,
        )
        project_recurrence = create_meeting_recurrence(
            research_group=self.group,
            actor=self.alex,
            meeting_series=series,
            title="Project Standup",
            frequency="daily",
            interval=1,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
        )
        meeting = self._materialize_occurrence(
            project_recurrence, (2026, 1, 5),
        )
        add_meeting_participant(
            meeting=meeting, actor=self.alex, target_user=self.laura,
        )

        permissions = self.detail_permissions(self.laura, meeting)

        self.assertEqual(
            permissions,
            {"canEdit": True, "canDelete": False, "canCancel": False},
        )


class MeetingActionPermissionsListTest(MeetingActionPermissionsBase):
    """The Research Group Meetings list exposes correct per-Meeting
    permissions in one response."""

    def test_list_exposes_correct_permissions_per_meeting(self):
        group_meeting = self.create_group_meeting(title="Group One")
        project_meeting = self.create_project_meeting(
            title="Project One", participants=[self.laura],
        )
        recurrence = self._create_recurrence()
        recurring_meeting = self._materialize_occurrence(
            recurrence, (2026, 1, 5),
        )

        # For alex (group admin, project owner, collaborator on
        # every fixture): the three Meetings carry three DIFFERENT
        # permission profiles in the SAME list response.
        entries = self.list_entries(self.alex)

        self.assertEqual(
            _action_permissions(entries[group_meeting.pk]),
            {"canEdit": True, "canDelete": True, "canCancel": False},
        )
        self.assertEqual(
            _action_permissions(entries[project_meeting.pk]),
            {"canEdit": True, "canDelete": True, "canCancel": False},
        )
        self.assertEqual(
            _action_permissions(entries[recurring_meeting.pk]),
            {"canEdit": True, "canDelete": False, "canCancel": True},
        )

    def test_list_permissions_are_per_user(self):
        project_meeting = self.create_project_meeting(
            participants=[self.laura],
        )

        alex_entries = self.list_entries(self.alex)
        laura_entries = self.list_entries(self.laura)

        self.assertEqual(
            _action_permissions(alex_entries[project_meeting.pk]),
            {"canEdit": True, "canDelete": True, "canCancel": False},
        )
        self.assertEqual(
            _action_permissions(laura_entries[project_meeting.pk]),
            {"canEdit": True, "canDelete": False, "canCancel": False},
        )


class MeetingActionPermissionsQueryCountTest(TestCase):
    """Behavioral query-count regression for the Meetings list.

    The action-permission read model must not add one query per
    returned Meeting (or per represented Project): the group scope
    is resolved once per request, the user's Project scopes are
    resolved with ONE batched canonical resolution per request, and
    every per-Meeting input (participant relations, Project row,
    recurrence provenance, status) is eager-loaded or row-local.
    """

    @classmethod
    def setUpTestData(cls):
        cls.alex = User.objects.create_user(
            username="qcperm-alex", password="Pass1!",
        )
        cls.chris = User.objects.create_user(
            username="qcperm-chris", password="Pass1!",
        )
        cls.laura = User.objects.create_user(
            username="qcperm-laura", password="Pass1!",
        )

        cls.group = ResearchGroup.objects.create(
            name="QC Permission Group", created_by=cls.alex,
        )
        for user in [cls.alex, cls.chris, cls.laura]:
            ResearchGroupMembership.objects.create(
                research_group=cls.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

        cls.project = create_project(
            research_group=cls.group,
            creator=cls.alex,
            name="QC Permission Project",
        )
        add_project_membership(
            project=cls.project,
            actor=cls.alex,
            target_user=cls.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        add_project_membership(
            project=cls.project,
            actor=cls.alex,
            target_user=cls.laura,
            role=ProjectMembership.Role.VIEWER,
        )

        cls.scheduled_at = (
            timezone.now().replace(microsecond=0)
            + timedelta(days=1)
        )

    def setUp(self):
        self.client = APIClient()
        self.client.force_login(self.chris)
        # Warm-up: the FIRST request from a fresh client also creates
        # the custom UserSession row (3 extra queries). Fetch once
        # outside the measured window so both measured requests
        # compare like for like.
        self._fetch()

    def _make_group_meeting(self, offset_days):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=f"QC group {offset_days}",
            scheduled_at=self.scheduled_at + timedelta(days=offset_days),
        )

    def _make_project_meeting(self, offset_days):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title=f"QC project {offset_days}",
            scheduled_at=self.scheduled_at + timedelta(days=offset_days),
            scope=Meeting.Scope.PROJECT,
            project=self.project,
            participants=[self.chris, self.laura],
        )

    def _fetch(self):
        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.json()

    def test_query_count_does_not_scale_with_meeting_count(self):
        # Request 1: 2 Meetings (one group, one project-scoped).
        self._make_group_meeting(1)
        self._make_project_meeting(2)

        with CaptureQueriesContext(connection) as small_ctx:
            entries = self._fetch()
        self.assertEqual(len(entries), 2)
        for entry in entries:
            _action_permissions(entry)

        # Request 2: 14 Meetings (7x the rows, same shape mix).
        for offset in range(3, 11):
            self._make_group_meeting(offset)
            if offset % 2 == 0:
                self._make_project_meeting(offset)

        with CaptureQueriesContext(connection) as large_ctx:
            entries = self._fetch()
        self.assertEqual(len(entries), 14)
        for entry in entries:
            _action_permissions(entry)

        # Invariant: 7x the rows add ZERO queries — a per-Meeting
        # scope lookup (group scope, participant check, Project
        # membership / Research Group membership) would make the
        # second request issue 12 more queries.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "Meetings list query count must not scale with the "
            "returned row count; the action-permission read model "
            "must resolve the group scope once and batch the "
            "Project scopes per request.",
        )

    def test_query_count_does_not_scale_with_project_count(self):
        # Request 1: 2 Meetings in 2 scopes (one group Meeting +
        # one project Meeting in the fixture Project — chris is a
        # member of it, so the Meeting is visible to him).
        self._make_group_meeting(1)
        self._make_project_meeting(2)

        with CaptureQueriesContext(connection) as two_ctx:
            entries = self._fetch()
        self.assertEqual(len(entries), 2)

        # Request 2: 6 Meetings in 5 Projects — four NEW single-
        # Meeting Projects in the SAME Research Group (the list
        # endpoint is group-scoped), each with chris as member so
        # his Meeting is visible.
        for index in range(3, 7):
            project = create_project(
                research_group=self.group,
                creator=self.alex,
                name=f"QC Permission Project {index}",
            )
            add_project_membership(
                project=project,
                actor=self.alex,
                target_user=self.chris,
                role=ProjectMembership.Role.MEMBER,
            )
            create_meeting(
                research_group=self.group,
                actor=self.alex,
                title=f"QC project {index}",
                scheduled_at=self.scheduled_at + timedelta(days=index),
                scope=Meeting.Scope.PROJECT,
                project=project,
                participants=[self.chris],
            )

        with CaptureQueriesContext(connection) as four_ctx:
            entries = self._fetch()
        self.assertEqual(len(entries), 6)
        for entry in entries:
            _action_permissions(entry)

        # Invariant: multiplying the represented Projects adds ZERO
        # queries — the canonical Project scope resolution is
        # batched over exactly the represented Projects.
        self.assertEqual(
            len(two_ctx.captured_queries),
            len(four_ctx.captured_queries),
            "Meetings list query count must not scale with the "
            "number of represented Projects; the batched canonical "
            "Project scope resolution must stay a constant number "
            "of queries per request.",
        )
