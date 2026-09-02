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
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.models import WorkItem

from .models import MeetingItemWorkItem, MeetingSection
from .services import (
    MeetingDomainError,
    create_meeting,
    create_meeting_item,
    create_work_item_from_meeting_item,
)


User = get_user_model()


class MeetingWorkItemLinkBase(TestCase):
    def setUp(self):
        self.alex = User.objects.create_user(
            username="meeting-link-alex",
            password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="meeting-link-chris",
            password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="meeting-link-laura",
            password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="meeting-link-maria",
            password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Meeting Link Group",
            created_by=self.alex,
        )

        for user, role in [
            (
                self.alex,
                ResearchGroupMembership.Role.ADMIN,
            ),
            (
                self.chris,
                ResearchGroupMembership.Role.MEMBER,
            ),
            (
                self.laura,
                ResearchGroupMembership.Role.MEMBER,
            ),
        ]:
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=role,
            )

        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Paper XYZ",
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

        self.meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="FG Weekly",
            scheduled_at=timezone.now(),
        )

        self.section = MeetingSection.objects.get(meeting=self.meeting)

        self.item = create_meeting_item(
            meeting=self.meeting,
            meeting_section=self.section,
            actor=self.alex,
            title="Rewrite Introduction",
        )

        self.task_type = self.project.type_definitions.get(name="Task")


class MeetingWorkItemLinkDomainTest(
    MeetingWorkItemLinkBase
):
    def test_service_creates_work_item_and_link(self):
        work_item = create_work_item_from_meeting_item(
            meeting_item=self.item,
            project=self.project,
            actor=self.alex,
            type_definition_id=self.task_type.pk,
            title="Rewrite Introduction",
            assignee_ids=[self.chris.pk],
        )

        self.assertEqual(
            work_item.project,
            self.project,
        )
        self.assertEqual(
            list(
                work_item.assignee_relations.values_list(
                    "user_id",
                    flat=True,
                )
            ),
            [self.chris.pk],
        )
        self.assertTrue(
            MeetingItemWorkItem.objects.filter(
                meeting_item=self.item,
                work_item=work_item,
                created_by=self.alex,
            ).exists()
        )

    def test_cross_group_project_is_rejected(self):
        other_group = ResearchGroup.objects.create(
            name="Other Group",
            created_by=self.alex,
        )

        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )

        other_project = create_project(
            research_group=other_group,
            creator=self.alex,
            name="Other Project",
        )

        with self.assertRaises(MeetingDomainError):
            create_work_item_from_meeting_item(
                meeting_item=self.item,
                project=other_project,
                actor=self.alex,
                type_definition_id=self.task_type.pk,
                title="Cross Group Task",
            )

        self.assertFalse(
            WorkItem.objects.filter(
                title="Cross Group Task",
            ).exists()
        )

    def test_invalid_assignee_creates_neither_work_item_nor_link(
        self,
    ):
        before_links = (
            MeetingItemWorkItem.objects.count()
        )

        with self.assertRaises(MeetingDomainError):
            create_work_item_from_meeting_item(
                meeting_item=self.item,
                project=self.project,
                actor=self.alex,
                type_definition_id=self.task_type.pk,
                title="Invalid Assignment",
                assignee_ids=[self.laura.pk],
            )

        self.assertFalse(
            WorkItem.objects.filter(
                title="Invalid Assignment",
            ).exists()
        )
        self.assertEqual(
            MeetingItemWorkItem.objects.count(),
            before_links,
        )


class MeetingWorkItemLinkApiTest(
    MeetingWorkItemLinkBase
):
    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def post_work_item(
        self,
        *,
        user=None,
        payload=None,
    ):
        self.login(user or self.alex)

        return self.client.post(
            (
                f"/api/meeting-items/"
                f"{self.item.pk}/work-items/"
            ),
            payload or {
                "projectId": self.project.pk,
                "typeDefinitionId": self.task_type.pk,
                "title": "Rewrite Introduction",
                "assigneeIds": [self.chris.pk],
            },
            format="json",
        )

    def test_missing_project_id_is_rejected_clearly(self):
        # The frontend must always resolve a target Project. Without one,
        # the request is invalid and the item is left untouched.
        self.login(self.alex)

        response = self.client.post(
            f"/api/meeting-items/{self.item.pk}/work-items/",
            {
                "typeDefinitionId": self.task_type.pk,
                "title": "No project",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("projectId", response.json())

    def test_stale_string_type_payload_is_rejected(self):
        # Regression for the "Work item could not be created" bug: the
        # frontend used to send a string `type` instead of a
        # `typeDefinitionId`. That must be rejected clearly.
        self.login(self.alex)

        response = self.client.post(
            f"/api/meeting-items/{self.item.pk}/work-items/",
            {
                "projectId": self.project.pk,
                "type": "task",
                "title": "Stale type",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("typeDefinitionId", response.json())
        self.assertFalse(
            WorkItem.objects.filter(title="Stale type").exists()
        )

    def test_viewer_cannot_target_their_own_project(self):
        # laura is a member of the research group (can read the group
        # meeting) but a VIEWER of the project, so she cannot create work.
        self.login(self.laura)
        response = self.client.post(
            f"/api/meeting-items/{self.item.pk}/work-items/",
            {
                "projectId": self.project.pk,
                "typeDefinitionId": self.task_type.pk,
                "title": "Viewer forbidden",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(
            WorkItem.objects.filter(title="Viewer forbidden").exists()
        )

    def test_group_meeting_work_item_belongs_to_selected_project(self):
        response = self.post_work_item()
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        data = response.json()
        self.assertEqual(data["projectId"], self.project.pk)

        work_item = WorkItem.objects.get(pk=data["id"])
        self.assertEqual(work_item.project, self.project)

    def test_endpoint_creates_canonical_work_item(self):
        response = self.post_work_item()

        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )

        data = response.json()

        self.assertEqual(
            data["projectId"],
            self.project.pk,
        )
        self.assertEqual(data["typeDefinitionId"], self.task_type.pk)
        self.assertEqual(
            data["title"],
            "Rewrite Introduction",
        )
        self.assertEqual(
            data["assigneeIds"],
            [self.chris.pk],
        )
        self.assertEqual(
            data["createdById"],
            self.alex.pk,
        )

        self.assertTrue(
            MeetingItemWorkItem.objects.filter(
                meeting_item=self.item,
                work_item_id=data["id"],
            ).exists()
        )

    def test_created_work_item_is_exposed_on_meeting_item(
        self,
    ):
        created = self.post_work_item()

        work_item_id = created.json()["id"]

        response = self.client.get(
            f"/api/meeting-items/{self.item.pk}/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(
            response.json()["workItemIds"],
            [work_item_id],
        )

    def test_created_work_item_is_visible_in_target_project_list(
        self,
    ):
        # Regression: a Work Item created through the Meeting
        # quick-create flow must immediately be visible in the target
        # Project's canonical Work Item list (the same list the Board
        # and List render from), without requiring a client-side
        # refresh or hard reload.
        created = self.post_work_item()
        self.assertEqual(
            created.status_code,
            status.HTTP_201_CREATED,
        )
        work_item_id = created.json()["id"]

        response = self.client.get(
            f"/api/projects/{self.project.pk}/work-items/"
        )
        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        listed_ids = [item["id"] for item in response.json()]
        self.assertIn(work_item_id, listed_ids)

        # The listed item must carry the canonical definition IDs so
        # the frontend can resolve its type/status from the Project's
        # Work Item configuration.
        created_in_list = next(
            item
            for item in response.json()
            if item["id"] == work_item_id
        )
        self.assertEqual(
            created_in_list["projectId"],
            self.project.pk,
        )
        self.assertEqual(
            created_in_list["typeDefinitionId"],
            self.task_type.pk,
        )
        self.assertIsInstance(
            created_in_list["statusDefinitionId"],
            int,
        )

    def test_group_meeting_hides_linked_project_ids_from_group_only_member(
        self,
    ):
        created = self.post_work_item()
        work_item_id = created.json()["id"]
        group_only = User.objects.create_user(
            username="meeting-link-group-only",
            password="Pass1!",
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=group_only,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.login(group_only)
        response = self.client.get(
            f"/api/meeting-items/{self.item.pk}/"
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertNotIn(work_item_id, response.json()["workItemIds"])
        self.assertEqual(response.json()["workItemIds"], [])

    def test_created_work_item_appears_in_assignee_my_work(
        self,
    ):
        created = self.post_work_item()
        work_item_id = created.json()["id"]

        self.login(self.chris)

        response = self.client.get(
            (
                f"/api/research-groups/"
                f"{self.group.pk}/my-work/"
            )
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )
        self.assertIn(
            work_item_id,
            [
                item["id"]
                for item in response.json()
            ],
        )

    def test_viewer_cannot_create_work_item(self):
        response = self.post_work_item(
            user=self.laura,
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_403_FORBIDDEN,
        )

    def test_inaccessible_project_is_hidden(self):
        private_project = create_project(
            research_group=self.group,
            creator=self.chris,
            name="Chris Private Project",
        )

        response = self.post_work_item(
            payload={
                "projectId": private_project.pk,
                "typeDefinitionId": self.task_type.pk,
                "title": "Private Project Task",
            },
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_cross_group_project_is_hidden(self):
        other_group = ResearchGroup.objects.create(
            name="Other API Group",
            created_by=self.alex,
        )

        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )

        other_project = create_project(
            research_group=other_group,
            creator=self.alex,
            name="Other API Project",
        )

        response = self.post_work_item(
            payload={
                "projectId": other_project.pk,
                "typeDefinitionId": self.task_type.pk,
                "title": "Cross Group API Task",
            },
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_invalid_assignee_rolls_back_creation(self):
        response = self.post_work_item(
            payload={
                "projectId": self.project.pk,
                "typeDefinitionId": self.task_type.pk,
                "title": "Invalid API Assignment",
                "assigneeIds": [self.laura.pk],
            },
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        self.assertFalse(
            WorkItem.objects.filter(
                title="Invalid API Assignment",
            ).exists()
        )

        self.assertFalse(
            MeetingItemWorkItem.objects.filter(
                meeting_item=self.item,
            ).exists()
        )

    def test_non_group_member_cannot_use_meeting_item(
        self,
    ):
        response = self.post_work_item(
            user=self.maria,
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_project_id_is_required(self):
        response = self.post_work_item(
            payload={
                "typeDefinitionId": self.task_type.pk,
                "title": "Missing Project",
            },
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_authentication_is_required(self):
        self.client.logout()

        response = self.client.post(
            (
                f"/api/meeting-items/"
                f"{self.item.pk}/work-items/"
            ),
            {
                "projectId": self.project.pk,
                "typeDefinitionId": self.task_type.pk,
                "title": "Anonymous Task",
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_401_UNAUTHORIZED,
        )

    def test_endpoint_requires_csrf_for_session_auth(self):
        client = APIClient(
            enforce_csrf_checks=True,
        )
        client.force_login(self.alex)

        url = (
            f"/api/meeting-items/"
            f"{self.item.pk}/work-items/"
        )

        payload = {
            "projectId": self.project.pk,
            "typeDefinitionId": self.task_type.pk,
            "title": "CSRF Meeting Task",
        }

        denied = client.post(
            url,
            payload,
            format="json",
        )

        self.assertEqual(
            denied.status_code,
            status.HTTP_403_FORBIDDEN,
        )

        client.get("/api/auth/csrf/")
        csrf_token = client.cookies[
            "csrftoken"
        ].value

        allowed = client.post(
            url,
            payload,
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(
            allowed.status_code,
            status.HTTP_201_CREATED,
        )
