"""Pre-resolved scope identity validation in
``resolve_meeting_scope`` (stabilization).

The optional ``group_scope`` / ``project_scopes`` inputs are
consumed by the kernel only after an identity check against the
Meeting they are applied to. These behavioral tests invoke the
resolver directly with actual ``ScopeContext`` fixtures and pin:

- a VALID pre-resolved scope grants exactly the same capabilities
  as ordinary resolution;
- a scope belonging to a DIFFERENT Research Group / Project, a
  MISSING mapping entry, or an incorrect ``ScopeKind`` grants NO
  Meeting access (fail closed, no implicit fallback);
- ordinary resolution without pre-resolved inputs is unchanged.
"""

from dataclasses import replace
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from meetings.models import Meeting
from meetings.services import create_meeting
from projects.models import ProjectMembership
from projects.services import (
    add_project_membership,
    create_project,
)
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from .capabilities import Capability
from .context import ScopeKind
from .service import (
    resolve_group_scope,
    resolve_meeting_scope,
    resolve_project_scope,
)

User = get_user_model()


class MeetingScopeValidationBase(TestCase):
    """Two Research Groups and two Projects:

    Group A: alex (admin), chris (member), laura (member).
    Group B: bruno (admin).
    Project P in A: alex owner, chris member, laura viewer.
    Project Q in B: bruno owner.
    Group Meeting GM in A; Project Meeting PM in A (Project P;
    alex creator, chris + laura participants).
    """

    def setUp(self):
        self.alex = User.objects.create_user(
            username="scv-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="scv-chris", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="scv-laura", password="Pass1!",
        )
        self.bruno = User.objects.create_user(
            username="scv-bruno", password="Pass1!",
        )

        self.group_a = ResearchGroup.objects.create(
            name="Scope Validation A", created_by=self.alex,
        )
        self.group_b = ResearchGroup.objects.create(
            name="Scope Validation B", created_by=self.bruno,
        )
        for user, role in [
            (self.alex, ResearchGroupMembership.Role.ADMIN),
            (self.chris, ResearchGroupMembership.Role.MEMBER),
            (self.laura, ResearchGroupMembership.Role.MEMBER),
        ]:
            ResearchGroupMembership.objects.create(
                research_group=self.group_a,
                user=user,
                role=role,
            )
        ResearchGroupMembership.objects.create(
            research_group=self.group_b,
            user=self.bruno,
            role=ResearchGroupMembership.Role.ADMIN,
        )

        self.project_p = create_project(
            research_group=self.group_a,
            creator=self.alex,
            name="Scope Validation P",
        )
        add_project_membership(
            project=self.project_p,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project_p,
            actor=self.alex,
            target_user=self.laura,
            role=ProjectMembership.Role.VIEWER,
        )
        self.project_q = create_project(
            research_group=self.group_b,
            creator=self.bruno,
            name="Scope Validation Q",
        )

        self.scheduled_at = (
            timezone.now().replace(microsecond=0)
            + timedelta(days=1)
        )

        self.group_meeting = create_meeting(
            research_group=self.group_a,
            actor=self.alex,
            title="Group Meeting",
            scheduled_at=self.scheduled_at,
        )
        self.project_meeting = create_meeting(
            research_group=self.group_a,
            actor=self.alex,
            title="Project Meeting",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project_p,
            participants=[self.chris, self.laura],
        )


class GroupScopeIdentityValidationTest(MeetingScopeValidationBase):
    """``group_scope`` identity checks on a group-scope Meeting."""

    def test_valid_pre_resolved_group_scope_matches_ordinary_resolution(
        self,
    ):
        ordinary = resolve_meeting_scope(
            self.chris, self.group_meeting,
        )
        pre_resolved = resolve_meeting_scope(
            self.chris,
            self.group_meeting,
            group_scope=resolve_group_scope(
                self.chris, self.group_a.pk,
            ),
        )

        self.assertIsNotNone(ordinary)
        self.assertIsNotNone(pre_resolved)
        self.assertEqual(
            ordinary.capabilities, pre_resolved.capabilities,
        )
        for capability in (
            Capability.MEETING_READ,
            Capability.MEETING_WRITE,
            Capability.MEETING_ADMIN,
        ):
            self.assertIn(capability, pre_resolved.capabilities)

    def test_group_scope_from_different_research_group_denies(self):
        # bruno's scope in Group B is a perfectly valid group
        # scope — but it does not belong to Group A, so it must
        # never grant capabilities on Group A's Meeting (even for
        # chris, who legitimately belongs to Group A: NO fallback
        # to re-resolving the user's actual scope).
        foreign = resolve_group_scope(self.bruno, self.group_b.pk)
        self.assertIsNotNone(foreign)
        self.assertEqual(
            foreign.research_group_id, self.group_b.pk,
        )

        scope = resolve_meeting_scope(
            self.chris,
            self.group_meeting,
            group_scope=foreign,
        )

        self.assertIsNone(scope)

    def test_group_scope_with_incorrect_kind_denies(self):
        valid = resolve_group_scope(self.chris, self.group_a.pk)
        wrong_kind = replace(valid, kind=ScopeKind.PROJECT)

        scope = resolve_meeting_scope(
            self.chris,
            self.group_meeting,
            group_scope=wrong_kind,
        )

        self.assertIsNone(scope)


class ProjectScopeIdentityValidationTest(MeetingScopeValidationBase):
    """``project_scopes`` identity checks on a project-scope
    Meeting."""

    def test_valid_pre_resolved_project_scope_matches_ordinary_resolution(
        self,
    ):
        ordinary = resolve_meeting_scope(
            self.chris, self.project_meeting,
        )
        pre_resolved = resolve_meeting_scope(
            self.chris,
            self.project_meeting,
            project_scopes={
                self.project_p.pk: resolve_project_scope(
                    self.chris, self.project_p.pk,
                ),
            },
        )

        self.assertIsNotNone(ordinary)
        self.assertIsNotNone(pre_resolved)
        self.assertEqual(
            ordinary.capabilities, pre_resolved.capabilities,
        )
        for capability in (
            Capability.MEETING_READ,
            Capability.MEETING_WRITE,
            Capability.MEETING_ADMIN,
        ):
            self.assertIn(capability, pre_resolved.capabilities)

    def test_project_scope_missing_from_mapping_denies(self):
        # The mapping covers Project Q only — the Meeting's Project
        # P is absent. Missing entry fails closed; no implicit
        # resolution of P (or Q) as a fallback.
        scope = resolve_meeting_scope(
            self.chris,
            self.project_meeting,
            project_scopes={
                self.project_q.pk: resolve_project_scope(
                    self.bruno, self.project_q.pk,
                ),
            },
        )

        self.assertIsNone(scope)

    def test_project_scope_from_another_project_denies(self):
        # The mapping is keyed by the Meeting's Project P but CARRIES
        # a scope whose project identity is Project Q.
        foreign = resolve_project_scope(self.bruno, self.project_q.pk)
        self.assertEqual(foreign.project_id, self.project_q.pk)

        scope = resolve_meeting_scope(
            self.chris,
            self.project_meeting,
            project_scopes={self.project_p.pk: foreign},
        )

        self.assertIsNone(scope)

    def test_project_scope_with_mismatched_research_group_denies(self):
        # Correct kind + correct Project identity, but the Research
        # Group identity does not match the Meeting's group.
        valid = resolve_project_scope(self.chris, self.project_p.pk)
        wrong_group = replace(
            valid, research_group_id=self.group_b.pk,
        )

        scope = resolve_meeting_scope(
            self.chris,
            self.project_meeting,
            project_scopes={self.project_p.pk: wrong_group},
        )

        self.assertIsNone(scope)

    def test_project_scope_with_incorrect_kind_denies(self):
        valid = resolve_project_scope(self.chris, self.project_p.pk)
        wrong_kind = replace(valid, kind=ScopeKind.GROUP)

        scope = resolve_meeting_scope(
            self.chris,
            self.project_meeting,
            project_scopes={self.project_p.pk: wrong_kind},
        )

        self.assertIsNone(scope)


class OrdinaryResolutionUnchangedTest(MeetingScopeValidationBase):
    """Without pre-resolved inputs the kernel behaves exactly as
    before the batched-resolution extension."""

    def test_group_member_on_group_meeting_grants_full_set(self):
        scope = resolve_meeting_scope(
            self.chris, self.group_meeting,
        )

        self.assertIsNotNone(scope)
        for capability in (
            Capability.MEETING_READ,
            Capability.MEETING_WRITE,
            Capability.MEETING_ADMIN,
        ):
            self.assertIn(capability, scope.capabilities)

    def test_member_participant_on_project_meeting_grants_full_set(
        self,
    ):
        scope = resolve_meeting_scope(
            self.chris, self.project_meeting,
        )

        self.assertIsNotNone(scope)
        for capability in (
            Capability.MEETING_READ,
            Capability.MEETING_WRITE,
            Capability.MEETING_ADMIN,
        ):
            self.assertIn(capability, scope.capabilities)

    def test_viewer_participant_gets_write_but_not_admin(self):
        scope = resolve_meeting_scope(
            self.laura, self.project_meeting,
        )

        self.assertIsNotNone(scope)
        self.assertTrue(
            scope.has(Capability.MEETING_READ),
        )
        self.assertTrue(scope.has(Capability.MEETING_WRITE))
        self.assertFalse(scope.has(Capability.MEETING_ADMIN))

    def test_outside_user_gets_no_meeting_scope(self):
        # bruno: no Group A membership, not a collaborator on PM.
        self.assertIsNone(
            resolve_meeting_scope(self.bruno, self.group_meeting),
        )
        self.assertIsNone(
            resolve_meeting_scope(self.bruno, self.project_meeting),
        )
