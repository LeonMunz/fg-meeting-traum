from django.contrib.auth import get_user_model

from rest_framework.test import (
    APIClient,
    APITestCase,
)

from audit_history.models import AuditEvent
from projects.models import ProjectMembership
from projects.services import (
    add_project_membership,
    create_project,
)
from work_items.models import (
    WorkItem,
    WorkItemAssignee,
)
from work_items.services import create_work_item

from .models import (
    ResearchGroup,
    ResearchGroupMembership,
)


User = get_user_model()


class ResearchGroupOffboardingApiTest(
    APITestCase,
):
    @classmethod
    def setUpTestData(cls):
        cls.admin = User.objects.create_user(
            username="off_api_admin",
            password="TestPass1!",
        )
        cls.target = User.objects.create_user(
            username="off_api_target",
            password="TestPass1!",
        )
        cls.maria = User.objects.create_user(
            username="off_api_maria",
            password="TestPass1!",
        )
        cls.viewer = User.objects.create_user(
            username="off_api_viewer",
            password="TestPass1!",
        )
        cls.group_only = User.objects.create_user(
            username="off_api_group_only",
            password="TestPass1!",
        )
        cls.outsider = User.objects.create_user(
            username="off_api_outsider",
            password="TestPass1!",
        )

        cls.group = ResearchGroup.objects.create(
            name="Offboarding API Group",
            created_by=cls.admin,
        )

        cls.admin_membership = (
            ResearchGroupMembership.objects.create(
                research_group=cls.group,
                user=cls.admin,
                role=ResearchGroupMembership.Role.ADMIN,
            )
        )

        cls.target_membership = (
            ResearchGroupMembership.objects.create(
                research_group=cls.group,
                user=cls.target,
                role=ResearchGroupMembership.Role.MEMBER,
            )
        )

        for user in (
            cls.maria,
            cls.viewer,
            cls.group_only,
        ):
            ResearchGroupMembership.objects.create(
                research_group=cls.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

        cls.other_group = (
            ResearchGroup.objects.create(
                name="Other Group",
                created_by=cls.outsider,
            )
        )

        cls.outsider_membership = (
            ResearchGroupMembership.objects.create(
                research_group=cls.other_group,
                user=cls.outsider,
                role=ResearchGroupMembership.Role.ADMIN,
            )
        )

    def setUp(self):
        self.client = APIClient()

    def login(self, username):
        self.client.get("/api/auth/csrf/")

        csrf_token = (
            self.client.cookies
            .get("csrftoken")
            .value
        )

        response = self.client.post(
            "/api/auth/login/",
            data={
                "username": username,
                "password": "TestPass1!",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(
            response.status_code,
            200,
        )

    def url(
        self,
        membership=None,
        group=None,
    ):
        membership = (
            membership
            or self.target_membership
        )
        group = group or self.group

        return (
            f"/api/research-groups/{group.pk}"
            f"/memberships/{membership.pk}"
            "/offboarding/"
        )

    def create_member_project(
        self,
        name="Member Project",
    ):
        project = create_project(
            research_group=self.group,
            creator=self.admin,
            name=name,
        )

        add_project_membership(
            project=project,
            actor=self.admin,
            target_user=self.target,
            role=ProjectMembership.Role.MEMBER,
        )

        return project

    def add_project_member(
        self,
        project,
        user,
        role=ProjectMembership.Role.MEMBER,
        actor=None,
    ):
        add_project_membership(
            project=project,
            actor=actor or self.admin,
            target_user=user,
            role=role,
        )

    def create_task(
        self,
        *,
        project,
        title,
        assignees,
        actor=None,
    ):
        return create_work_item(
            project=project,
            actor=actor or self.admin,
            type=WorkItem.Type.TASK,
            title=title,
            assignee_ids=[
                user.pk
                for user in assignees
            ],
        )

    def test_admin_preview_exposes_required_resolution_data(
        self,
    ):
        project = self.create_member_project(
            "Preview Project",
        )

        self.add_project_member(
            project,
            self.maria,
        )

        self.add_project_member(
            project,
            self.viewer,
            role=ProjectMembership.Role.VIEWER,
        )

        task = self.create_task(
            project=project,
            title="Preview Work",
            assignees=[self.target],
        )

        self.login("off_api_admin")

        response = self.client.get(
            self.url()
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        data = response.json()

        self.assertEqual(
            data["membershipId"],
            self.target_membership.pk,
        )
        self.assertEqual(
            data["user"]["username"],
            "off_api_target",
        )
        self.assertEqual(
            data["researchGroupRole"],
            "member",
        )
        self.assertFalse(
            data["finalResearchGroupAdmin"]
        )

        self.assertEqual(
            len(data["projects"]),
            1,
        )

        project_data = data["projects"][0]

        self.assertEqual(
            project_data["projectId"],
            project.pk,
        )
        self.assertEqual(
            project_data["assignmentCount"],
            1,
        )
        self.assertFalse(
            project_data["finalOwner"]
        )
        self.assertFalse(
            project_data[
                "requiresOwnershipResolution"
            ]
        )

        ownership_usernames = {
            candidate["username"]
            for candidate
            in project_data[
                "ownershipCandidates"
            ]
        }

        assignment_usernames = {
            candidate["username"]
            for candidate
            in project_data[
                "assignmentCandidates"
            ]
        }

        self.assertEqual(
            ownership_usernames,
            {
                "off_api_admin",
                "off_api_maria",
                "off_api_viewer",
            },
        )

        self.assertEqual(
            assignment_usernames,
            {
                "off_api_admin",
                "off_api_maria",
            },
        )

        self.assertNotIn(
            "off_api_group_only",
            ownership_usernames,
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.target,
            ).exists()
        )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.target_membership.pk,
            ).exists()
        )

    def test_member_cannot_preview_offboarding(
        self,
    ):
        self.login("off_api_maria")

        response = self.client.get(
            self.url()
        )

        self.assertEqual(
            response.status_code,
            403,
        )

    def test_outsider_cannot_discover_group(
        self,
    ):
        self.login("off_api_outsider")

        response = self.client.get(
            self.url()
        )

        self.assertEqual(
            response.status_code,
            404,
        )

    def test_membership_id_is_scoped_to_group(
        self,
    ):
        self.login("off_api_admin")

        response = self.client.get(
            self.url(
                membership=(
                    self.outsider_membership
                ),
            )
        )

        self.assertEqual(
            response.status_code,
            404,
        )

    def test_post_can_unassign_and_remove_member(
        self,
    ):
        project = self.create_member_project(
            "Unassign Project",
        )

        task = self.create_task(
            project=project,
            title="Unassign Work",
            assignees=[
                self.target,
                self.admin,
            ],
        )

        self.login("off_api_admin")

        response = self.client.post(
            self.url(),
            data={
                "projects": [
                    {
                        "projectId": project.pk,
                        "assignmentResolution": {
                            "mode": "unassign",
                        },
                    }
                ]
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        self.assertEqual(
            response.json()["summary"][
                "affectedWorkItemCount"
            ],
            1,
        )

        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                pk=self.target_membership.pk,
            ).exists()
        )

        self.assertFalse(
            ProjectMembership.objects.filter(
                project=project,
                user=self.target,
            ).exists()
        )

        self.assertFalse(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.target,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.admin,
            ).exists()
        )

        self.assertTrue(
            AuditEvent.objects.filter(
                event_type=(
                    "research_group.member_offboarded"
                ),
                subject_user=self.target,
            ).exists()
        )

    def test_post_can_transfer_ownership_and_work(
        self,
    ):
        project = create_project(
            research_group=self.group,
            creator=self.target,
            name="Transfer Project",
        )

        self.add_project_member(
            project,
            self.maria,
            actor=self.target,
        )

        task = self.create_task(
            project=project,
            title="Transfer Work",
            assignees=[self.target],
            actor=self.target,
        )

        self.login("off_api_admin")

        response = self.client.post(
            self.url(),
            data={
                "projects": [
                    {
                        "projectId": project.pk,
                        "ownershipResolution": {
                            "mode": "transfer",
                            "replacementUserId":
                                self.maria.pk,
                        },
                        "assignmentResolution": {
                            "mode": "transfer",
                            "replacementUserId":
                                self.maria.pk,
                        },
                    }
                ]
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            200,
        )

        summary = response.json()["summary"]

        self.assertEqual(
            summary["ownershipTransferCount"],
            1,
        )
        self.assertEqual(
            summary[
                "transferredAssignmentCount"
            ],
            1,
        )

        self.assertTrue(
            ProjectMembership.objects.filter(
                project=project,
                user=self.maria,
                role=ProjectMembership.Role.OWNER,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.maria,
            ).exists()
        )

        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                pk=self.target_membership.pk,
            ).exists()
        )

    def test_invalid_replacement_user_is_400_and_rolls_back(
        self,
    ):
        project = self.create_member_project(
            "Invalid Replacement",
        )

        task = self.create_task(
            project=project,
            title="Still Assigned",
            assignees=[self.target],
        )

        self.login("off_api_admin")

        response = self.client.post(
            self.url(),
            data={
                "projects": [
                    {
                        "projectId": project.pk,
                        "assignmentResolution": {
                            "mode": "transfer",
                            "replacementUserId":
                                999999,
                        },
                    }
                ]
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            400,
        )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.target_membership.pk,
            ).exists()
        )

        self.assertTrue(
            ProjectMembership.objects.filter(
                project=project,
                user=self.target,
            ).exists()
        )

        self.assertTrue(
            WorkItemAssignee.objects.filter(
                work_item=task,
                user=self.target,
            ).exists()
        )

    def test_unknown_project_is_rejected(
        self,
    ):
        self.create_member_project(
            "Known Project",
        )

        self.login("off_api_admin")

        response = self.client.post(
            self.url(),
            data={
                "projects": [
                    {
                        "projectId": 999999,
                        "assignmentResolution": {
                            "mode": "unassign",
                        },
                    }
                ]
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            400,
        )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=self.target_membership.pk,
            ).exists()
        )

    def test_final_admin_execute_is_rejected(
        self,
    ):
        solo_group = ResearchGroup.objects.create(
            name="Solo API Group",
            created_by=self.admin,
        )

        solo_membership = (
            ResearchGroupMembership.objects.create(
                research_group=solo_group,
                user=self.admin,
                role=ResearchGroupMembership.Role.ADMIN,
            )
        )

        self.login("off_api_admin")

        response = self.client.post(
            self.url(
                membership=solo_membership,
                group=solo_group,
            ),
            data={
                "projects": [],
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            400,
        )

        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                pk=solo_membership.pk,
            ).exists()
        )
