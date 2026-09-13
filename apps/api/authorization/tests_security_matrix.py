"""Security regression matrix (M5) — behavioral ALLOW/DENY.

Behavioral (HTTP-level) regression tests for the canonical
ALLOW/DENY matrix of the ResearchGroup / Project membership and
authorization foundation (``docs/domain/authorization.md`` §5–§6).

Proof goals:
- no GroupMembership → group READ DENY
- no ProjectMembership → private Project READ DENY
- group Owner without ProjectMembership → private Project DENY
- Project VIEWER → allowed reads / denied writes per the central
  capability matrix
- removed Project member + known resource ID → DENY
- removed Group member + known child Project/resource ID → DENY
- final Owner self-remove / downgrade → DENY
- two Owners, one leaves → ALLOW
- cross-ResearchGroup ProjectMembership attempt → rejected
- group removal clears/revokes child ProjectMemberships
- rejoin does not restore them
- suspended (inactive) user → DENY
"""

from django.contrib.auth import get_user_model
from django.utils import timezone

from rest_framework.test import APITestCase

from meetings.models import Meeting, MeetingParticipant
from projects.models import ProjectMembership
from projects.services import add_project_membership, create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from research_groups.services import (
    add_research_group_membership,
    offboard_research_group_member,
)
from work_items.services import create_work_item

from .capabilities import Capability
from .service import resolve_group_scope, resolve_project_scope

User = get_user_model()


def _now():
    return timezone.now()


def _group_membership(group, user, role):
    return ResearchGroupMembership.objects.create(
        research_group=group,
        user=user,
        role=role,
    )


class SecurityMatrixBase(APITestCase):
    """Standard scenario:

    Group A ("Alpha"):
      alex   — group Owner (admin), Project P Owner
      dana   — group Owner (admin), no ProjectMembership
      chris  — group member, Project P member
      laura  — group member, Project P viewer
      maria  — group member, no ProjectMembership
    Group B ("Beta"):
      bruno  — sole group Owner, Project Q sole Owner
      carol  — group member
    outsider — no memberships at all

    Project P in A: WorkItem W; Project meeting PM (chris participant).
    Project Q in B: no WorkItems.
    Group meeting GM in A (chris not a participant).
    """

    def setUp(self):
        self.alex = User.objects.create_user("mx-alex", password="Pass1!")
        self.dana = User.objects.create_user("mx-dana", password="Pass1!")
        self.chris = User.objects.create_user("mx-chris", password="Pass1!")
        self.laura = User.objects.create_user("mx-laura", password="Pass1!")
        self.maria = User.objects.create_user("mx-maria", password="Pass1!")
        self.outsider = User.objects.create_user("mx-outsider", password="Pass1!")
        self.bruno = User.objects.create_user("mx-bruno", password="Pass1!")
        self.carol = User.objects.create_user("mx-carol", password="Pass1!")

        self.group_a = ResearchGroup.objects.create(
            name="Alpha", created_by=self.alex
        )
        _group_membership(self.group_a, self.alex, ResearchGroupMembership.Role.ADMIN)
        _group_membership(self.group_a, self.dana, ResearchGroupMembership.Role.ADMIN)
        _group_membership(self.group_a, self.chris, ResearchGroupMembership.Role.MEMBER)
        _group_membership(self.group_a, self.laura, ResearchGroupMembership.Role.MEMBER)
        _group_membership(self.group_a, self.maria, ResearchGroupMembership.Role.MEMBER)

        self.group_b = ResearchGroup.objects.create(
            name="Beta", created_by=self.bruno
        )
        _group_membership(self.group_b, self.bruno, ResearchGroupMembership.Role.ADMIN)
        _group_membership(self.group_b, self.carol, ResearchGroupMembership.Role.MEMBER)

        self.project_p = create_project(
            research_group=self.group_a,
            creator=self.alex,
            name="Project P",
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
        self.task_type = self.project_p.type_definitions.get(name="Task")
        self.work_item = create_work_item(
            project=self.project_p,
            actor=self.alex,
            type_definition_id=self.task_type.pk,
            title="Task 1",
        )

        self.project_q = create_project(
            research_group=self.group_b,
            creator=self.bruno,
            name="Project Q",
        )

        self.project_meeting = Meeting.objects.create(
            research_group=self.group_a,
            scope=Meeting.Scope.PROJECT,
            project=self.project_p,
            title="Project Meeting",
            scheduled_at=_now(),
            created_by=self.alex,
        )
        MeetingParticipant.objects.create(
            meeting=self.project_meeting,
            user=self.chris,
        )

        self.group_meeting = Meeting.objects.create(
            research_group=self.group_a,
            scope=Meeting.Scope.GROUP,
            title="Group Meeting",
            scheduled_at=_now(),
            created_by=self.alex,
        )

    def _login(self, user):
        self.client.force_login(user)

    def _offboard_chris(self):
        """Remove chris from group A through the canonical offboarding path."""
        membership = ResearchGroupMembership.objects.get(
            research_group=self.group_a,
            user=self.chris,
        )
        offboard_research_group_member(
            membership=membership,
            actor=self.alex,
        )
        return membership


class GroupReadMatrixTest(SecurityMatrixBase):
    """Group READ: ALLOW for members, DENY for non-members and removed members."""

    def test_group_member_reads_group_resources(self):
        self._login(self.chris)

        response = self.client.get(
            f"/api/research-groups/{self.group_a.pk}/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["role"], "member")

        response = self.client.get("/api/research-groups/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(self.group_a.pk, [g["id"] for g in response.json()])

        response = self.client.get(
            f"/api/research-groups/{self.group_a.pk}/members/"
        )
        self.assertEqual(response.status_code, 200)
        usernames = [m["username"] for m in response.json()]
        self.assertIn("mx-alex", usernames)
        self.assertIn("mx-chris", usernames)

    def test_no_group_membership_denies_group_reads(self):
        self._login(self.outsider)

        # Non-leaking 404 on the known group ID.
        response = self.client.get(
            f"/api/research-groups/{self.group_a.pk}/"
        )
        self.assertEqual(response.status_code, 404)

        # Collection does not leak the group.
        response = self.client.get("/api/research-groups/")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(
            self.group_a.pk, [g["id"] for g in response.json()]
        )

        # Group directory and membership collection: non-leaking 404.
        response = self.client.get(
            f"/api/research-groups/{self.group_a.pk}/members/"
        )
        self.assertEqual(response.status_code, 404)
        response = self.client.get(
            f"/api/research-groups/{self.group_a.pk}/memberships/"
        )
        self.assertEqual(response.status_code, 404)

        # Group project list is empty (no existence leak).
        response = self.client.get(
            f"/api/research-groups/{self.group_a.pk}/projects/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_removed_group_member_denied_on_known_ids(self):
        self._offboard_chris()
        self._login(self.chris)

        # Group resource with the known ID.
        response = self.client.get(
            f"/api/research-groups/{self.group_a.pk}/"
        )
        self.assertEqual(response.status_code, 404)

        # Child Project resources with the known IDs.
        response = self.client.get(
            f"/api/projects/{self.project_p.pk}/"
        )
        self.assertEqual(response.status_code, 404)
        response = self.client.get(
            f"/api/projects/{self.project_p.pk}/work-items/"
        )
        self.assertEqual(response.status_code, 404)
        response = self.client.get(
            f"/api/work-items/{self.work_item.pk}/"
        )
        self.assertEqual(response.status_code, 404)

        # Group meeting the user is not part of: DENY.
        response = self.client.get(
            f"/api/meetings/{self.group_meeting.pk}/"
        )
        self.assertEqual(response.status_code, 404)

        # Kernel agrees: no scope at all.
        self.assertIsNone(
            resolve_group_scope(self.chris, self.group_a.pk)
        )
        self.assertIsNone(
            resolve_project_scope(self.chris, self.project_p.pk)
        )

    def test_removed_group_member_participant_read_but_no_write(self):
        """Settled Meeting rule: read is creator-or-participant and
        orthogonal to membership; scoped WRITE is revoked on removal."""
        self._offboard_chris()
        self._login(self.chris)

        # chris is still an explicit participant of PM: read stays.
        response = self.client.get(
            f"/api/meetings/{self.project_meeting.pk}/"
        )
        self.assertEqual(response.status_code, 200)

        # But the scoped write capability is gone: write is DENY.
        response = self.client.post(
            f"/api/meetings/{self.project_meeting.pk}/start"
        )
        self.assertEqual(response.status_code, 403)


class ProjectReadMatrixTest(SecurityMatrixBase):
    """Private Project READ: membership required; group membership alone
    (even group Owner) is insufficient."""

    def test_project_member_reads_project_resources(self):
        self._login(self.chris)

        response = self.client.get(f"/api/projects/{self.project_p.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["currentUserRole"], "member")

        response = self.client.get(
            f"/api/projects/{self.project_p.pk}/work-items/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn(
            self.work_item.pk, [w["id"] for w in response.json()]
        )

        response = self.client.get(f"/api/work-items/{self.work_item.pk}/")
        self.assertEqual(response.status_code, 200)

    def test_group_member_without_project_membership_denied(self):
        self._login(self.maria)

        response = self.client.get(f"/api/projects/{self.project_p.pk}/")
        self.assertEqual(response.status_code, 404)
        response = self.client.get(
            f"/api/projects/{self.project_p.pk}/work-items/"
        )
        self.assertEqual(response.status_code, 404)
        # Known WorkItem ID never bypasses scope.
        response = self.client.get(f"/api/work-items/{self.work_item.pk}/")
        self.assertEqual(response.status_code, 404)

    def test_group_owner_without_project_membership_denied(self):
        """Invariant 19: group Owners do not implicitly gain private
        Project content access without ProjectMembership."""
        self._login(self.dana)

        response = self.client.get(f"/api/projects/{self.project_p.pk}/")
        self.assertEqual(response.status_code, 404)
        response = self.client.get(
            f"/api/work-items/{self.work_item.pk}/"
        )
        self.assertEqual(response.status_code, 404)
        # The group project list must not leak the private project.
        response = self.client.get(
            f"/api/research-groups/{self.group_a.pk}/projects/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_removed_project_member_denied_on_known_ids(self):
        self._login(self.alex)
        membership = ProjectMembership.objects.get(
            project=self.project_p, user=self.chris
        )
        response = self.client.delete(
            f"/api/projects/{self.project_p.pk}/memberships/{membership.pk}/"
        )
        self.assertEqual(response.status_code, 200)

        # chris keeps group membership — project access is gone anyway.
        self._login(self.chris)
        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                research_group=self.group_a, user=self.chris
            ).exists()
        )

        response = self.client.get(f"/api/projects/{self.project_p.pk}/")
        self.assertEqual(response.status_code, 404)
        response = self.client.get(
            f"/api/projects/{self.project_p.pk}/work-items/"
        )
        self.assertEqual(response.status_code, 404)
        response = self.client.get(f"/api/work-items/{self.work_item.pk}/")
        self.assertEqual(response.status_code, 404)


class ProjectCapabilityMatrixTest(SecurityMatrixBase):
    """The central role → capability matrix at the behavioral level."""

    def test_viewer_allowed_reads(self):
        self._login(self.laura)

        response = self.client.get(f"/api/projects/{self.project_p.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["currentUserRole"], "viewer")

        response = self.client.get(
            f"/api/projects/{self.project_p.pk}/work-items/"
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.get(f"/api/work-items/{self.work_item.pk}/")
        self.assertEqual(response.status_code, 200)
        response = self.client.get(
            f"/api/projects/{self.project_p.pk}/memberships/"
        )
        self.assertEqual(response.status_code, 200)

    def test_viewer_denied_writes(self):
        self._login(self.laura)

        payload = {
            "title": "Viewer attempt",
            "typeDefinitionId": self.task_type.pk,
        }
        response = self.client.post(
            f"/api/projects/{self.project_p.pk}/work-items/",
            data=payload,
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

        response = self.client.patch(
            f"/api/work-items/{self.work_item.pk}/",
            data={"title": "Viewer attempt"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

        response = self.client.post(
            f"/api/projects/{self.project_p.pk}/memberships/",
            data={"userId": self.maria.pk, "role": "member"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

        response = self.client.post(
            f"/api/projects/{self.project_p.pk}/archive/"
        )
        self.assertEqual(response.status_code, 403)

        response = self.client.post(
            f"/api/projects/{self.project_p.pk}/work-item-configuration/types/",
            data={"name": "Viewer type"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

        # Nothing was created.
        self.assertEqual(
            self.project_p.work_items.count(), 1
        )
        self.assertFalse(
            self.project_p.type_definitions.filter(
                name="Viewer type"
            ).exists()
        )

    def test_member_allowed_work_denied_manage(self):
        self._login(self.chris)

        response = self.client.post(
            f"/api/projects/{self.project_p.pk}/work-items/",
            data={
                "title": "Member task",
                "typeDefinitionId": self.task_type.pk,
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)

        response = self.client.post(
            f"/api/projects/{self.project_p.pk}/memberships/",
            data={"userId": self.maria.pk, "role": "member"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
        response = self.client.post(
            f"/api/projects/{self.project_p.pk}/archive/"
        )
        self.assertEqual(response.status_code, 403)

    def test_owner_allowed_manage(self):
        self._login(self.alex)

        newbie = User.objects.create_user("mx-newbie", password="Pass1!")
        add_research_group_membership(
            research_group=self.group_a,
            actor=self.alex,
            target_user=newbie,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        response = self.client.post(
            f"/api/projects/{self.project_p.pk}/memberships/",
            data={"userId": newbie.pk, "role": "member"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            ProjectMembership.objects.filter(
                project=self.project_p, user=newbie
            ).count(),
            1,
        )


class OwnershipMatrixTest(SecurityMatrixBase):
    """Final Owner removal/downgrade is DENY; with two Owners one may leave."""

    def test_final_project_owner_self_remove_denied(self):
        self._login(self.alex)
        membership = ProjectMembership.objects.get(
            project=self.project_p, user=self.alex
        )
        response = self.client.delete(
            f"/api/projects/{self.project_p.pk}/memberships/{membership.pk}/"
        )
        self.assertEqual(response.status_code, 400)
        self.assertTrue(
            ProjectMembership.objects.filter(
                project=self.project_p,
                user=self.alex,
                role=ProjectMembership.Role.OWNER,
            ).exists()
        )

    def test_final_project_owner_downgrade_denied(self):
        self._login(self.alex)
        membership = ProjectMembership.objects.get(
            project=self.project_p, user=self.alex
        )
        response = self.client.patch(
            f"/api/projects/{self.project_p.pk}/memberships/{membership.pk}/",
            data={"role": "member"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            ProjectMembership.objects.get(
                project=self.project_p, user=self.alex
            ).role,
            ProjectMembership.Role.OWNER,
        )

    def test_second_project_owner_can_leave(self):
        self._login(self.alex)

        response = self.client.post(
            f"/api/projects/{self.project_p.pk}/memberships/",
            data={"userId": self.dana.pk, "role": "owner"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        dana_membership = ProjectMembership.objects.get(
            project=self.project_p, user=self.dana
        )

        response = self.client.delete(
            f"/api/projects/{self.project_p.pk}/memberships/{dana_membership.pk}/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project_p, user=self.dana
            ).exists()
        )
        # alex remains the sole Owner — the invariant held.
        self.assertEqual(
            ProjectMembership.objects.filter(
                project=self.project_p,
                role=ProjectMembership.Role.OWNER,
            ).count(),
            1,
        )

    def test_final_group_owner_self_remove_denied(self):
        self._login(self.bruno)
        membership = ResearchGroupMembership.objects.get(
            research_group=self.group_b, user=self.bruno
        )
        response = self.client.delete(
            f"/api/research-groups/{self.group_b.pk}/memberships/{membership.pk}/"
        )
        self.assertEqual(response.status_code, 400)
        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                research_group=self.group_b,
                user=self.bruno,
                role=ResearchGroupMembership.Role.ADMIN,
            ).exists()
        )

    def test_final_group_owner_downgrade_denied(self):
        self._login(self.bruno)
        membership = ResearchGroupMembership.objects.get(
            research_group=self.group_b, user=self.bruno
        )
        response = self.client.patch(
            f"/api/research-groups/{self.group_b.pk}/memberships/{membership.pk}/",
            data={"role": "member"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            ResearchGroupMembership.objects.get(
                research_group=self.group_b, user=self.bruno
            ).role,
            ResearchGroupMembership.Role.ADMIN,
        )

    def test_second_group_owner_can_leave(self):
        self._login(self.alex)
        dana_membership = ResearchGroupMembership.objects.get(
            research_group=self.group_a, user=self.dana
        )
        response = self.client.delete(
            f"/api/research-groups/{self.group_a.pk}/memberships/{dana_membership.pk}/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group_a, user=self.dana
            ).exists()
        )
        # alex remains a group Owner — the invariant held.
        self.assertEqual(
            ResearchGroupMembership.objects.filter(
                research_group=self.group_a,
                role=ResearchGroupMembership.Role.ADMIN,
            ).count(),
            1,
        )


class CrossGroupMatrixTest(SecurityMatrixBase):
    """ProjectMembership may only reference users of the parent group."""

    def test_cross_group_project_membership_rejected(self):
        self._login(self.alex)
        response = self.client.post(
            f"/api/projects/{self.project_p.pk}/memberships/",
            data={"userId": self.bruno.pk, "role": "member"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn(
            "Research Group", response.json()["error"]
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project_p, user=self.bruno
            ).exists()
        )

    def test_database_rejects_cross_group_project_membership(self):
        from django.db import IntegrityError, transaction

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                ProjectMembership.objects.create(
                    project=self.project_p,
                    user=self.bruno,
                    role=ProjectMembership.Role.MEMBER,
                    added_by=self.alex,
                )


class RemovalRevocationMatrixTest(SecurityMatrixBase):
    """Group removal revokes child ProjectMemberships; rejoin restores
    nothing."""

    def test_group_removal_revokes_child_project_memberships(self):
        self._offboard_chris()

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project_p, user=self.chris
            ).exists()
        )
        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group_a, user=self.chris
            ).exists()
        )

    def test_rejoin_does_not_restore_project_memberships(self):
        self._offboard_chris()

        add_research_group_membership(
            research_group=self.group_a,
            actor=self.alex,
            target_user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                research_group=self.group_a, user=self.chris
            ).exists()
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project_p, user=self.chris
            ).exists()
        )

        self._login(self.chris)
        response = self.client.get(f"/api/projects/{self.project_p.pk}/")
        self.assertEqual(response.status_code, 404)
        response = self.client.get(f"/api/work-items/{self.work_item.pk}/")
        self.assertEqual(response.status_code, 404)


class AccountStateMatrixTest(SecurityMatrixBase):
    """The current account lifecycle: an inactive (suspended) account
    grants no access. (Full account lifecycle is later authentication
    work; is_active is the state the current system represents.)"""

    def test_inactive_user_denied_at_api(self):
        self.chris.is_active = False
        self.chris.save(update_fields=["is_active"])

        self._login(self.chris)
        response = self.client.get(
            f"/api/research-groups/{self.group_a.pk}/"
        )
        self.assertIn(response.status_code, (401, 403))
        response = self.client.get(f"/api/projects/{self.project_p.pk}/")
        self.assertIn(response.status_code, (401, 403))
        response = self.client.get(f"/api/work-items/{self.work_item.pk}/")
        self.assertIn(response.status_code, (401, 403))

    def test_inactive_user_denied_by_kernel_even_with_memberships(self):
        self.chris.is_active = False
        self.chris.save(update_fields=["is_active"])

        self.assertIsNone(
            resolve_group_scope(self.chris, self.group_a.pk)
        )
        self.assertIsNone(
            resolve_project_scope(self.chris, self.project_p.pk)
        )


class GroupCreationMatrixTest(SecurityMatrixBase):
    """Every active account may create a ResearchGroup and becomes its
    first Owner atomically (invariant 8), via the same foundation."""

    def test_active_account_creates_group_and_becomes_owner(self):
        self._login(self.outsider)
        response = self.client.post(
            "/api/research-groups/",
            data={"name": "Gamma"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["role"], "admin")

        group_id = response.json()["id"]
        membership = ResearchGroupMembership.objects.get(
            research_group_id=group_id, user=self.outsider
        )
        self.assertEqual(
            membership.role, ResearchGroupMembership.Role.ADMIN
        )
        scope = resolve_group_scope(self.outsider, group_id)
        self.assertTrue(scope.has(Capability.GROUP_MANAGE))
        self.assertTrue(scope.has(Capability.GROUP_CREATE_PROJECT))
