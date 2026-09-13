"""Authorization kernel tests: capability matrix and default DENY.

Covers:
- central role → capability mapping (group + project)
- default DENY (no membership, unknown role, inactive account)
- Project scope requires BOTH memberships
- Meeting creator-or-participant read + scope write capability
- Meeting Series scope capabilities
"""

from django.utils import timezone as django_timezone

from django.contrib.auth import get_user_model
from django.test import TestCase

from meetings.models import Meeting, MeetingParticipant, MeetingSeries
from projects.models import Project, ProjectMembership
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .capabilities import Capability, capabilities_for_group_role, capabilities_for_project_role
from .context import ScopeKind
from .service import (
    AuthorizationDenied,
    require_group_capability,
    require_meeting_write,
    require_project_capability,
    resolve_group_scope,
    resolve_meeting_scope,
    resolve_meeting_series_scope,
    resolve_project_scope,
)

User = get_user_model()


def _now():
    return django_timezone.now()


class CapabilityMappingTest(TestCase):
    """The central role → capability table itself (pure function)."""

    def test_group_member_capabilities(self):
        self.assertEqual(
            capabilities_for_group_role(
                ResearchGroupMembership.Role.MEMBER
            ),
            frozenset(
                {
                    Capability.GROUP_READ,
                    Capability.GROUP_CREATE_PROJECT,
                }
            ),
        )

    def test_group_admin_capabilities(self):
        self.assertEqual(
            capabilities_for_group_role(
                ResearchGroupMembership.Role.ADMIN
            ),
            frozenset(
                {
                    Capability.GROUP_READ,
                    Capability.GROUP_CREATE_PROJECT,
                    Capability.GROUP_MANAGE,
                }
            ),
        )

    def test_group_unknown_role_denied(self):
        self.assertEqual(capabilities_for_group_role(None), frozenset())
        self.assertEqual(capabilities_for_group_role("superadmin"), frozenset())

    def test_project_role_capabilities(self):
        self.assertEqual(
            capabilities_for_project_role(
                ProjectMembership.Role.VIEWER
            ),
            frozenset({Capability.PROJECT_READ}),
        )
        self.assertEqual(
            capabilities_for_project_role(
                ProjectMembership.Role.MEMBER
            ),
            frozenset(
                {Capability.PROJECT_READ, Capability.PROJECT_WORK}
            ),
        )
        self.assertEqual(
            capabilities_for_project_role(
                ProjectMembership.Role.OWNER
            ),
            frozenset(
                {
                    Capability.PROJECT_READ,
                    Capability.PROJECT_WORK,
                    Capability.PROJECT_MANAGE,
                }
            ),
        )

    def test_project_unknown_role_denied(self):
        self.assertEqual(capabilities_for_project_role(None), frozenset())
        self.assertEqual(
            capabilities_for_project_role("admin"),
            frozenset(),
        )


class ScopeResolutionScenario:
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="Pass1!")
        self.member = User.objects.create_user(username="member", password="Pass1!")
        self.viewer = User.objects.create_user(username="viewer", password="Pass1!")
        self.outsider = User.objects.create_user(username="outsider", password="Pass1!")

        self.group = ResearchGroup.objects.create(name="Group", created_by=self.admin)
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.admin,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.member,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.viewer,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.project = Project.objects.create(
            name="Project",
            research_group=self.group,
            created_by=self.admin,
        )
        for user, role in [
            (self.admin, ProjectMembership.Role.OWNER),
            (self.member, ProjectMembership.Role.MEMBER),
            (self.viewer, ProjectMembership.Role.VIEWER),
        ]:
            ProjectMembership.objects.create(
                project=self.project,
                user=user,
                role=role,
                added_by=self.admin,
            )


class GroupScopeTest(ScopeResolutionScenario, TestCase):
    def test_admin_has_manage(self):
        scope = resolve_group_scope(self.admin, self.group.pk)
        self.assertIsNotNone(scope)
        self.assertTrue(scope.has(Capability.GROUP_MANAGE))
        self.assertTrue(scope.has(Capability.GROUP_READ))

    def test_member_cannot_manage(self):
        scope = resolve_group_scope(self.member, self.group.pk)
        self.assertIsNotNone(scope)
        self.assertTrue(scope.has(Capability.GROUP_READ))
        self.assertFalse(scope.has(Capability.GROUP_MANAGE))

    def test_non_member_denied(self):
        self.assertIsNone(resolve_group_scope(self.outsider, self.group.pk))
        with self.assertRaises(AuthorizationDenied):
            require_group_capability(
                self.outsider, self.group.pk, Capability.GROUP_READ
            )

    def test_unknown_group_denied(self):
        self.assertIsNone(resolve_group_scope(self.admin, 999999))

    def test_inactive_user_denied(self):
        self.admin.is_active = False
        self.admin.save()
        self.assertIsNone(resolve_group_scope(self.admin, self.group.pk))


class ProjectScopeTest(ScopeResolutionScenario, TestCase):
    def test_viewer_read_only(self):
        scope = resolve_project_scope(self.viewer, self.project.pk)
        self.assertIsNotNone(scope)
        self.assertTrue(scope.has(Capability.PROJECT_READ))
        self.assertFalse(scope.has(Capability.PROJECT_WORK))
        self.assertFalse(scope.has(Capability.PROJECT_MANAGE))
        with self.assertRaises(AuthorizationDenied):
            require_project_capability(
                self.viewer, self.project.pk, Capability.PROJECT_WORK
            )

    def test_member_work_not_manage(self):
        scope = resolve_project_scope(self.member, self.project.pk)
        self.assertTrue(scope.has(Capability.PROJECT_WORK))
        self.assertFalse(scope.has(Capability.PROJECT_MANAGE))

    def test_owner_full(self):
        scope = resolve_project_scope(self.admin, self.project.pk)
        self.assertTrue(scope.has(Capability.PROJECT_MANAGE))

    def test_group_member_without_project_membership_denied(self):
        # `member`-level outsider: a group member of another group
        # knowing the Project ID still gets nothing.
        other_group = ResearchGroup.objects.create(
            name="Other", created_by=self.outsider
        )
        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=self.outsider,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.assertIsNone(resolve_project_scope(self.outsider, self.project.pk))

    def test_removed_project_membership_revokes_access(self):
        ProjectMembership.objects.filter(
            project=self.project, user=self.member
        ).delete()
        self.assertIsNone(resolve_project_scope(self.member, self.project.pk))


class MeetingScopeTest(ScopeResolutionScenario, TestCase):
    def _group_meeting(self, creator):
        return Meeting.objects.create(
            research_group=self.group,
            scope=Meeting.Scope.GROUP,
            title="Group Meeting",
            scheduled_at=_now(),
            created_by=creator,
        )

    def _project_meeting(self, creator):
        return Meeting.objects.create(
            research_group=self.group,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
            title="Project Meeting",
            scheduled_at=_now(),
            created_by=creator,
        )

    def test_creator_has_read_and_group_write(self):
        meeting = self._group_meeting(self.admin)
        scope = resolve_meeting_scope(self.admin, meeting)
        self.assertTrue(scope.has(Capability.MEETING_READ))
        self.assertTrue(scope.has(Capability.MEETING_WRITE))

    def test_participant_grants_read_only(self):
        meeting = self._group_meeting(self.admin)
        MeetingParticipant.objects.create(
            meeting=meeting, user=self.member
        )
        # member is a group member → also write for group Meetings.
        scope = resolve_meeting_scope(self.member, meeting)
        self.assertTrue(scope.has(Capability.MEETING_READ))
        self.assertTrue(scope.has(Capability.MEETING_WRITE))

    def test_non_participant_group_member_has_write_not_read(self):
        """Settled rule (docs/domain/authorization.md §5): MEETING_WRITE
        is the scoped write rule and is independent of the
        creator/participant MEETING_READ rule. A group member who is
        neither creator nor participant gets the scoped write
        capability but no read capability. API views still gate every
        mutation on read access first (non-participants get 404)."""
        meeting = self._group_meeting(self.admin)
        # viewer is a group member but neither creator nor participant.
        scope = resolve_meeting_scope(self.viewer, meeting)
        self.assertIsNotNone(scope)
        self.assertTrue(scope.has(Capability.MEETING_WRITE))
        self.assertFalse(scope.has(Capability.MEETING_READ))

    def test_outsider_participant_read_only(self):
        meeting = self._group_meeting(self.admin)
        MeetingParticipant.objects.create(
            meeting=meeting, user=self.outsider
        )
        scope = resolve_meeting_scope(self.outsider, meeting)
        self.assertTrue(scope.has(Capability.MEETING_READ))
        self.assertFalse(scope.has(Capability.MEETING_WRITE))
        with self.assertRaises(AuthorizationDenied):
            require_meeting_write(self.outsider, meeting)

    def test_project_meeting_viewer_read_only(self):
        meeting = self._project_meeting(self.admin)
        MeetingParticipant.objects.create(
            meeting=meeting, user=self.viewer
        )
        scope = resolve_meeting_scope(self.viewer, meeting)
        self.assertTrue(scope.has(Capability.MEETING_READ))
        self.assertFalse(scope.has(Capability.MEETING_WRITE))

    def test_project_meeting_member_write(self):
        meeting = self._project_meeting(self.admin)
        MeetingParticipant.objects.create(
            meeting=meeting, user=self.member
        )
        scope = resolve_meeting_scope(self.member, meeting)
        self.assertTrue(scope.has(Capability.MEETING_WRITE))

    def test_archived_project_blocks_write(self):
        from django.utils import timezone

        meeting = self._project_meeting(self.admin)
        MeetingParticipant.objects.create(
            meeting=meeting, user=self.member
        )
        self.project.archived_at = timezone.now()
        self.project.save(update_fields=["archived_at"])
        scope = resolve_meeting_scope(self.member, meeting)
        self.assertTrue(scope.has(Capability.MEETING_READ))
        self.assertFalse(scope.has(Capability.MEETING_WRITE))


class MeetingSeriesScopeTest(ScopeResolutionScenario, TestCase):
    def test_group_series_member_write(self):
        series = MeetingSeries.objects.create(
            research_group=self.group,
            scope=MeetingSeries.Scope.GROUP,
            title="Weekly",
            created_by=self.admin,
        )
        scope = resolve_meeting_series_scope(self.member, series)
        self.assertTrue(scope.has(Capability.MEETING_SERIES_READ))
        self.assertTrue(scope.has(Capability.MEETING_SERIES_WRITE))

    def test_non_member_denied(self):
        series = MeetingSeries.objects.create(
            research_group=self.group,
            scope=MeetingSeries.Scope.GROUP,
            title="Weekly",
            created_by=self.admin,
        )
        self.assertIsNone(resolve_meeting_series_scope(self.outsider, series))

    def test_project_series_viewer_read_only(self):
        series = MeetingSeries.objects.create(
            research_group=self.group,
            scope=MeetingSeries.Scope.PROJECT,
            project=self.project,
            title="Project Weekly",
            created_by=self.admin,
        )
        scope = resolve_meeting_series_scope(self.viewer, series)
        self.assertTrue(scope.has(Capability.MEETING_SERIES_READ))
        self.assertFalse(scope.has(Capability.MEETING_SERIES_WRITE))
