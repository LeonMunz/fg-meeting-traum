"""Backend tests for canonical Note -> Work Item traceability.

Covers:
- creating a WorkItem from the exact persisted MeetingNote
- the link points at the exact Note (not another one)
- selected Project is respected; Project Meeting restricted to its Project
- Type / Status / Label definitions must belong to the selected Project
- Research Group Meeting requires an explicit Project
- unauthorized users (viewer / non-member) rejected
- one primary WorkItem per Note (service + unique constraint)
- deletion semantics: Note / WorkItem / MeetingItem / Meeting deletion
  keeps the other side and only removes the link row
- linkedWorkItem exposed on Note (permission-filtered)
- meetingOrigin exposed on WorkItem (permission-filtered)
"""

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from rest_framework import status
from rest_framework.test import APIClient

from projects.models import (
    ProjectMembership,
    WorkItemLabelDefinition,
    WorkItemStatusDefinition,
)
from projects.services import (
    add_project_membership,
    create_project,
)
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.models import WorkItem
from work_items.services import (
    create_work_item,
    delete_work_item,
    resolve_work_item_meeting_origin,
)

from .models import (
    Meeting,
    MeetingItem,
    MeetingItemWorkItem,
    MeetingNote,
    MeetingSection,
)
from .services import (
    MeetingDomainError,
    create_meeting,
    create_meeting_item,
    create_meeting_note,
    create_work_item_from_meeting_item,
    delete_meeting,
    delete_meeting_note,
    end_meeting,
    start_meeting,
)


User = get_user_model()


class NoteWorkItemBase(TestCase):
    def setUp(self):
        self.alex = User.objects.create_user(
            username="note-wi-alex",
            password="Pass1!",
            first_name="Alex",
        )
        self.chris = User.objects.create_user(
            username="note-wi-chris",
            password="Pass1!",
            first_name="Chris",
        )
        self.laura = User.objects.create_user(
            username="note-wi-laura",
            password="Pass1!",
            first_name="Laura",
        )
        self.maria = User.objects.create_user(
            username="note-wi-maria",
            password="Pass1!",
            first_name="Maria",
        )

        self.group = ResearchGroup.objects.create(
            name="Note Work Item Group",
            created_by=self.alex,
        )

        for user, role in [
            (self.alex, ResearchGroupMembership.Role.ADMIN),
            (self.chris, ResearchGroupMembership.Role.MEMBER),
            (self.laura, ResearchGroupMembership.Role.MEMBER),
            (self.maria, ResearchGroupMembership.Role.MEMBER),
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
        self.other_project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Procurement",
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

        self.scheduled_at = timezone.now()

        self.meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="FG Weekly",
            scheduled_at=self.scheduled_at,
        )
        start_meeting(meeting=self.meeting, actor=self.alex)
        self.meeting.refresh_from_db()

        section = MeetingSection.objects.get(
            meeting=self.meeting,
        )

        self.item = create_meeting_item(
            meeting=self.meeting,
            meeting_section=section,
            actor=self.alex,
            title="Rewrite Introduction",
        )
        self.item2 = create_meeting_item(
            meeting=self.meeting,
            meeting_section=section,
            actor=self.alex,
            title="Budget Check",
        )

        self.note = create_meeting_note(
            meeting_item=self.item,
            actor=self.alex,
            content="Check new quotation tomorrow",
        )
        self.note2 = create_meeting_note(
            meeting_item=self.item2,
            actor=self.chris,
            content="Budget line 42 looks off",
        )

        self.task_type = self.project.type_definitions.get(
            name="Task",
        )

    def _create_from_note(
        self,
        *,
        note=None,
        item=None,
        project=None,
        actor=None,
        title="From Note",
        type_definition_id=None,
        status_definition_id=None,
        label_definition_ids=None,
        assignee_ids=None,
    ):
        return create_work_item_from_meeting_item(
            meeting_item=item or self.item,
            project=project or self.project,
            actor=actor or self.alex,
            type_definition_id=(
                type_definition_id or self.task_type.pk
            ),
            title=title,
            description=(note.content if note else ""),
            status_definition_id=status_definition_id,
            assignee_ids=assignee_ids or [],
            label_definition_ids=label_definition_ids,
            meeting_note=note,
        )


class NoteWorkItemDomainTest(NoteWorkItemBase):
    def test_service_creates_work_item_linked_to_exact_note(self):
        work_item = self._create_from_note(
            note=self.note,
            assignee_ids=[self.chris.pk],
        )

        self.assertEqual(
            work_item.project,
            self.project,
        )

        link = MeetingItemWorkItem.objects.get(
            meeting_item=self.item,
            work_item=work_item,
        )
        self.assertEqual(
            link.meeting_note_id,
            self.note.pk,
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

    def test_link_points_to_exact_note_only(self):
        work_item = self._create_from_note(
            note=self.note,
            title="Exact Note A",
        )

        # The other Note stays unlinked.
        self.assertFalse(
            MeetingItemWorkItem.objects.filter(
                meeting_note=self.note2,
            ).exists()
        )

        link = MeetingItemWorkItem.objects.get(
            meeting_note=self.note,
        )
        self.assertEqual(link.work_item_id, work_item.pk)
        self.assertEqual(link.meeting_item_id, self.item.pk)

    def test_note_from_different_item_is_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self._create_from_note(
                note=self.note,
                item=self.item2,
                title="Wrong Item",
            )

        self.assertFalse(
            WorkItem.objects.filter(
                title="Wrong Item",
            ).exists()
        )

    def test_duplicate_primary_creation_rejected(self):
        self._create_from_note(
            note=self.note,
            title="First",
        )

        with self.assertRaises(MeetingDomainError) as ctx:
            self._create_from_note(
                note=self.note,
                title="Second",
            )

        self.assertIn(
            "already has a linked Work Item",
            str(ctx.exception),
        )
        self.assertFalse(
            WorkItem.objects.filter(title="Second").exists()
        )
        self.assertEqual(
            WorkItem.objects.filter(title="First").count(),
            1,
        )

    def test_unique_constraint_blocks_duplicate_note_link(self):
        """The DB constraint is the last line of defense against a
        concurrent duplicate request."""
        first = self._create_from_note(
            note=self.note,
            title="First",
        )

        manual = create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.task_type.pk,
            title="Manual",
        )

        with self.assertRaises(IntegrityError):
            # The inner atomic block rolls the constraint violation
            # back to a savepoint so the TestCase transaction stays
            # usable for the assertions below.
            with transaction.atomic():
                MeetingItemWorkItem.objects.create(
                    meeting_item=self.item,
                    work_item=manual,
                    meeting_note=self.note,
                    created_by=self.alex,
                )

        self.assertEqual(
            MeetingItemWorkItem.objects.filter(
                meeting_note=self.note,
            ).count(),
            1,
        )
        self.assertEqual(
            MeetingItemWorkItem.objects.get(
                meeting_note=self.note,
            ).work_item_id,
            first.pk,
        )

    def test_selected_project_is_respected(self):
        other_task = self.other_project.type_definitions.get(
            name="Task",
        )

        work_item = self._create_from_note(
            note=self.note,
            project=self.other_project,
            type_definition_id=other_task.pk,
            title="In Procurement",
        )

        self.assertEqual(
            work_item.project,
            self.other_project,
        )
        self.assertTrue(
            MeetingItemWorkItem.objects.filter(
                meeting_note=self.note,
                work_item=work_item,
            ).exists()
        )

    def test_type_definition_must_belong_to_selected_project(self):
        other_task = self.other_project.type_definitions.get(
            name="Task",
        )

        with self.assertRaises(MeetingDomainError):
            self._create_from_note(
                note=self.note,
                type_definition_id=other_task.pk,
                title="Foreign Type",
            )

        self.assertFalse(
            WorkItem.objects.filter(
                title="Foreign Type",
            ).exists()
        )

    def test_status_definition_must_belong_to_selected_project(self):
        other_status = (
            WorkItemStatusDefinition.objects.get(
                project=self.other_project,
                is_default=True,
            )
        )

        with self.assertRaises(MeetingDomainError):
            self._create_from_note(
                note=self.note,
                status_definition_id=other_status.pk,
                title="Foreign Status",
            )

        self.assertFalse(
            WorkItem.objects.filter(
                title="Foreign Status",
            ).exists()
        )

    def test_label_definition_must_belong_to_selected_project(self):
        foreign_label = WorkItemLabelDefinition.objects.create(
            project=self.other_project,
            name="Foreign",
            order=0,
        )

        with self.assertRaises(MeetingDomainError):
            self._create_from_note(
                note=self.note,
                label_definition_ids=[foreign_label.pk],
                title="Foreign Label",
            )

        self.assertFalse(
            WorkItem.objects.filter(
                title="Foreign Label",
            ).exists()
        )

    # ── Deletion semantics ────────────────────────────────────

    def _linked(self):
        return self._create_from_note(
            note=self.note,
            title="Kept Work",
            assignee_ids=[self.chris.pk],
        )

    def test_deleting_note_leaves_work_item(self):
        work_item = self._linked()

        delete_meeting_note(note=self.note, actor=self.alex)

        self.assertFalse(
            MeetingNote.objects.filter(pk=self.note.pk).exists()
        )
        self.assertTrue(
            WorkItem.objects.filter(pk=work_item.pk).exists()
        )
        self.assertFalse(
            MeetingItemWorkItem.objects.filter(
                work_item=work_item,
            ).exists()
        )

    def test_deleting_work_item_leaves_note(self):
        work_item = self._linked()

        delete_work_item(work_item=work_item, actor=self.alex)

        self.assertTrue(
            MeetingNote.objects.filter(pk=self.note.pk).exists()
        )
        self.assertFalse(
            WorkItem.objects.filter(pk=work_item.pk).exists()
        )
        self.assertFalse(
            MeetingItemWorkItem.objects.filter(
                meeting_note=self.note,
            ).exists()
        )

    def test_deleting_meeting_item_leaves_work_item(self):
        work_item = self._linked()

        self.item.delete()

        self.assertTrue(
            WorkItem.objects.filter(pk=work_item.pk).exists()
        )
        self.assertFalse(
            MeetingItemWorkItem.objects.filter(
                work_item=work_item,
            ).exists()
        )
        # The Note is owned by the item and cascades; the WorkItem
        # is not.
        self.assertFalse(
            MeetingNote.objects.filter(pk=self.note.pk).exists()
        )

    def test_deleting_meeting_leaves_work_item(self):
        work_item = self._linked()

        delete_meeting(meeting=self.meeting, actor=self.alex)

        self.assertTrue(
            WorkItem.objects.filter(pk=work_item.pk).exists()
        )
        self.assertFalse(
            MeetingItemWorkItem.objects.filter(
                work_item=work_item,
            ).exists()
        )

    def test_unrelated_work_items_untouched(self):
        self._linked()

        unrelated = create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.task_type.pk,
            title="Unrelated",
        )

        delete_meeting_note(note=self.note, actor=self.alex)

        self.assertTrue(
            WorkItem.objects.filter(pk=unrelated.pk).exists()
        )


class NoteWorkItemApiTest(NoteWorkItemBase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def post_note_work_item(self, user=None, payload=None):
        self.login(user or self.alex)

        base = {
            "projectId": self.project.pk,
            "typeDefinitionId": self.task_type.pk,
            "title": "From Note API",
            "description": self.note.content,
            "assigneeIds": [self.chris.pk],
            "meetingNoteId": self.note.pk,
        }
        if payload is not None:
            base = payload

        return self.client.post(
            f"/api/meeting-items/{self.item.pk}/work-items/",
            base,
            format="json",
        )

    def test_endpoint_creates_work_item_from_note(self):
        response = self.post_note_work_item()

        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )

        data = response.json()
        self.assertEqual(data["projectId"], self.project.pk)

        link = MeetingItemWorkItem.objects.get(
            meeting_note=self.note,
        )
        self.assertEqual(link.work_item_id, data["id"])
        self.assertEqual(link.meeting_item_id, self.item.pk)

        # The created WorkItem exposes its Meeting source.
        origin = data["meetingOrigin"]
        self.assertEqual(origin["meetingId"], self.meeting.pk)
        self.assertEqual(origin["meetingTitle"], "FG Weekly")
        self.assertEqual(
            origin["meetingItemId"],
            self.item.pk,
        )
        self.assertEqual(
            origin["meetingItemTitle"],
            "Rewrite Introduction",
        )
        self.assertEqual(origin["noteId"], self.note.pk)
        self.assertEqual(
            origin["noteContent"],
            self.note.content,
        )

    def test_note_of_other_item_is_rejected(self):
        response = self.post_note_work_item(
            payload={
                "projectId": self.project.pk,
                "typeDefinitionId": self.task_type.pk,
                "title": "Wrong Note",
                "meetingNoteId": self.note2.pk,
            },
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertFalse(
            WorkItem.objects.filter(
                title="Wrong Note",
            ).exists()
        )

    def test_duplicate_note_work_item_rejected_via_api(self):
        first = self.post_note_work_item()
        self.assertEqual(
            first.status_code,
            status.HTTP_201_CREATED,
        )

        second = self.post_note_work_item()

        self.assertEqual(
            second.status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertIn(
            "already has a linked Work Item",
            second.json()["error"],
        )
        self.assertEqual(
            WorkItem.objects.filter(
                title="From Note API",
            ).count(),
            1,
        )

    def test_group_meeting_requires_explicit_project(self):
        response = self.post_note_work_item(
            payload={
                "typeDefinitionId": self.task_type.pk,
                "title": "No Project",
                "meetingNoteId": self.note.pk,
            },
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertIn("projectId", response.json())
        self.assertFalse(
            WorkItem.objects.filter(
                title="No Project",
            ).exists()
        )

    def test_project_meeting_only_creates_work_in_its_project(self):
        project_meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="XYZ Sync",
            scheduled_at=timezone.now(),
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        start_meeting(
            meeting=project_meeting,
            actor=self.alex,
        )
        item = create_meeting_item(
            meeting=project_meeting,
            meeting_section=MeetingSection.objects.get(
                meeting=project_meeting,
            ),
            actor=self.alex,
            title="Sync Item",
        )
        note = create_meeting_note(
            meeting_item=item,
            actor=self.alex,
            content="Sync follow-up",
        )

        other_task = self.other_project.type_definitions.get(
            name="Task",
        )

        self.login(self.alex)
        rejected = self.client.post(
            f"/api/meeting-items/{item.pk}/work-items/",
            {
                "projectId": self.other_project.pk,
                "typeDefinitionId": other_task.pk,
                "title": "Wrong Project",
                "meetingNoteId": note.pk,
            },
            format="json",
        )
        self.assertEqual(
            rejected.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        allowed = self.client.post(
            f"/api/meeting-items/{item.pk}/work-items/",
            {
                "projectId": self.project.pk,
                "typeDefinitionId": self.task_type.pk,
                "title": "Right Project",
                "meetingNoteId": note.pk,
            },
            format="json",
        )
        self.assertEqual(
            allowed.status_code,
            status.HTTP_201_CREATED,
        )
        self.assertEqual(
            allowed.json()["projectId"],
            self.project.pk,
        )

    def test_project_meeting_viewer_cannot_create(self):
        project_meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="XYZ Sync Viewer",
            scheduled_at=timezone.now(),
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        start_meeting(
            meeting=project_meeting,
            actor=self.alex,
        )
        item = create_meeting_item(
            meeting=project_meeting,
            meeting_section=MeetingSection.objects.get(
                meeting=project_meeting,
            ),
            actor=self.alex,
            title="Viewer Item",
        )
        note = create_meeting_note(
            meeting_item=item,
            actor=self.alex,
            content="Viewer note",
        )

        response = self._login_and_post(
            self.laura,
            item,
            note,
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertFalse(
            WorkItem.objects.filter(
                title="Viewer Work",
            ).exists()
        )

    def _login_and_post(self, user, item, note):
        self.login(user)
        return self.client.post(
            f"/api/meeting-items/{item.pk}/work-items/",
            {
                "projectId": self.project.pk,
                "typeDefinitionId": self.task_type.pk,
                "title": "Viewer Work",
                "meetingNoteId": note.pk,
            },
            format="json",
        )

    def test_non_group_member_cannot_create(self):
        outsider = User.objects.create_user(
            username="note-wi-outsider",
            password="Pass1!",
        )

        response = self.post_note_work_item(user=outsider)

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertFalse(
            WorkItem.objects.filter(
                title="From Note API",
            ).exists()
        )

    def test_completed_meeting_stalls_note_authoring_but_allows_work(self):
        self.login(self.alex)
        end_meeting(meeting=self.meeting, actor=self.alex)
        self.meeting.refresh_from_db()

        # Note authoring stays closed...
        rejected_note = self.client.post(
            f"/api/meeting-items/{self.item.pk}/notes/",
            {"content": "Late note"},
            format="json",
        )
        self.assertEqual(
            rejected_note.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        # ...but a persisted, unlinked Note can still become the
        # primary WorkItem of a writable Project.
        response = self.post_note_work_item()
        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )

    def test_item_list_exposes_linked_work_on_note(self):
        self.post_note_work_item()

        response = self.client.get(
            f"/api/meetings/{self.meeting.pk}/items/",
        )
        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        by_id = {
            item["id"]: item
            for item in response.json()
        }
        item_payload = by_id[self.item.pk]

        notes = {
            note["id"]: note
            for note in item_payload["notes"]
        }
        note_payload = notes[self.note.pk]

        linked = note_payload["linkedWorkItem"]
        self.assertIsNotNone(linked)
        self.assertEqual(linked["projectId"], self.project.pk)
        self.assertEqual(linked["projectName"], "Paper XYZ")
        self.assertEqual(linked["title"], "From Note API")
        self.assertIn("Chris", linked["assigneeNames"])

        # The other Note has no linked WorkItem.
        item2_payload = by_id[self.item2.pk]
        note2_payload = {
            note["id"]: note
            for note in item2_payload["notes"]
        }[self.note2.pk]
        self.assertIsNone(
            note2_payload["linkedWorkItem"],
        )

    def test_item_list_hides_linked_work_without_project_access(self):
        self.post_note_work_item()
        work_item_id = (
            MeetingItemWorkItem.objects.get(
                meeting_note=self.note,
            ).work_item_id
        )

        self.login(self.maria)
        response = self.client.get(
            f"/api/meetings/{self.meeting.pk}/items/",
        )
        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        by_id = {
            item["id"]: item
            for item in response.json()
        }
        note_payload = {
            note["id"]: note
            for note in by_id[self.item.pk]["notes"]
        }[self.note.pk]

        self.assertIsNone(
            note_payload["linkedWorkItem"],
        )
        # The WorkItem itself stays hidden through workItemIds too.
        self.assertNotIn(
            work_item_id,
            by_id[self.item.pk]["workItemIds"],
        )

    def test_work_item_detail_exposes_origin_for_authorized_user(self):
        data = self.post_note_work_item().json()

        response = self.client.get(
            f"/api/work-items/{data['id']}/",
        )
        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )
        origin = response.json()["meetingOrigin"]
        self.assertEqual(
            origin["meetingTitle"],
            "FG Weekly",
        )
        self.assertEqual(
            origin["noteContent"],
            self.note.content,
        )

    def test_work_item_without_note_origin_is_null(self):
        work_item = create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.task_type.pk,
            title="Plain",
        )

        self.login(self.alex)
        response = self.client.get(
            f"/api/work-items/{work_item.pk}/",
        )
        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(
            response.json()["meetingOrigin"],
            None,
        )

    def test_origin_hidden_without_meeting_read_access(self):
        work_item = self._create_from_note(
            note=self.note,
            title="Origin Guard",
        )

        # A crafted Project membership without Research Group
        # membership can read the WorkItem but not the group
        # Meeting, so the origin must stay hidden.
        outsider = User.objects.create_user(
            username="note-wi-cross",
            password="Pass1!",
        )
        ProjectMembership.objects.create(
            project=self.project,
            user=outsider,
            role=ProjectMembership.Role.MEMBER,
            added_by=self.alex,
        )

        self.assertIsNone(
            resolve_work_item_meeting_origin(
                work_item,
                outsider,
            )
        )
        self.assertIsNotNone(
            resolve_work_item_meeting_origin(
                work_item,
                self.alex,
            )
        )
