from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.models import (
    WorkItem,
    WorkItemAssignee,
)
from work_items.services import create_work_item

from .models import ProjectMembership
from .services import (
    add_project_membership,
    create_project,
)


User = get_user_model()


class ProjectAssignmentResolutionAPITest(APITestCase):
    def setUp(self):
        self.alex = User.objects.create_user(
            username="resolution_api_alex",
            password="DevPass1!",
        )
        self.chris = User.objects.create_user(
            username="resolution_api_chris",
            password="DevPass1!",
        )
        self.maria = User.objects.create_user(
            username="resolution_api_maria",
            password="DevPass1!",
        )
        self.laura = User.objects.create_user(
            username="resolution_api_laura",
            password="DevPass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Resolution API Group",
            created_by=self.alex,
        )

        for user in (
            self.alex,
            self.chris,
            self.maria,
            self.laura,
        ):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Resolution API Project",
        )

        for user, role in (
            (self.chris, ProjectMembership.Role.MEMBER),
            (self.maria, ProjectMembership.Role.MEMBER),
            (self.laura, ProjectMembership.Role.VIEWER),
        ):
            add_project_membership(
                project=self.project,
                actor=self.alex,
                target_user=user,
                role=role,
            )

        self.client.force_login(self.alex)

    def membership(self, user):
        return ProjectMembership.objects.get(
            project=self.project,
            user=user,
        )

    def create_task(self, title, assignees):
        return create_work_item(
            project=self.project,
            actor=self.alex,
            type=WorkItem.Type.TASK,
            title=title,
            assignee_ids=[
                user.pk
                for user in assignees
            ],
        )

    def membership_url(self):
        return (
            f"/api/projects/{self.project.pk}/memberships/"
            f"{self.membership(self.chris).pk}/"
        )

    def test_patch_can_unassign_and_make_viewer(self):
        task = self.create_task(
            "API Unassign",
            [self.chris, self.alex],
        )

        response = self.client.patch(
            self.membership_url(),
            data={
                "role": "viewer",
                "assignmentResolution": "unassign",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["role"], "viewer")

        self.assertFalse(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.alex,
            ).exists()
        )

    def test_patch_can_transfer_and_make_viewer(self):
        task = self.create_task(
            "API Transfer",
            [self.chris, self.alex],
        )

        response = self.client.patch(
            self.membership_url(),
            data={
                "role": "viewer",
                "assignmentResolution": "transfer",
                "replacementUserId": self.maria.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)

        self.assertFalse(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.maria,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.alex,
            ).exists()
        )

    def test_delete_can_unassign(self):
        task = self.create_task(
            "Delete Unassign",
            [self.chris],
        )

        response = self.client.delete(
            self.membership_url(),
            data={
                "assignmentResolution": "unassign",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.chris,
            ).exists()
        )

        self.assertFalse(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

    def test_delete_can_transfer(self):
        task = self.create_task(
            "Delete Transfer",
            [self.chris],
        )

        response = self.client.delete(
            self.membership_url(),
            data={
                "assignmentResolution": "transfer",
                "replacementUserId": self.maria.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.chris,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.maria,
            ).exists()
        )

    def test_transfer_without_replacement_returns_400(self):
        task = self.create_task(
            "Missing Replacement",
            [self.chris],
        )

        response = self.client.patch(
            self.membership_url(),
            data={
                "role": "viewer",
                "assignmentResolution": "transfer",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

        self.assertEqual(
            self.membership(self.chris).role,
            ProjectMembership.Role.MEMBER,
        )

    def test_viewer_replacement_returns_400(self):
        task = self.create_task(
            "Viewer Replacement",
            [self.chris],
        )

        response = self.client.delete(
            self.membership_url(),
            data={
                "assignmentResolution": "transfer",
                "replacementUserId": self.laura.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

        self.assertTrue(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.chris,
            ).exists()
        )

    def test_unknown_replacement_user_returns_400(self):
        task = self.create_task(
            "Unknown Replacement",
            [self.chris],
        )

        response = self.client.patch(
            self.membership_url(),
            data={
                "role": "viewer",
                "assignmentResolution": "transfer",
                "replacementUserId": 999999999,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"],
            "Replacement user not found.",
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

    def test_invalid_replacement_user_id_returns_400(self):
        task = self.create_task(
            "Invalid Replacement ID",
            [self.chris],
        )

        response = self.client.delete(
            self.membership_url(),
            data={
                "assignmentResolution": "transfer",
                "replacementUserId": "not-an-id",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.chris,
            ).exists()
        )

    def test_legacy_patch_without_resolution_still_blocks(self):
        self.create_task(
            "Legacy PATCH",
            [self.chris],
        )

        response = self.client.patch(
            self.membership_url(),
            data={"role": "viewer"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)

    def test_legacy_delete_without_resolution_still_blocks(self):
        self.create_task(
            "Legacy DELETE",
            [self.chris],
        )

        response = self.client.delete(
            self.membership_url(),
        )

        self.assertEqual(response.status_code, 400)
