from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership
from projects.services import (
    add_project_membership,
    archive_project,
    create_project,
)
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import Meeting, MeetingItem, MeetingParticipant, MeetingSeries, MeetingSection
from .services import (
    MeetingDomainError,
    add_meeting_participant,
    create_meeting,
    create_meeting_from_series,
    create_meeting_item,
    create_meeting_series,
    create_series_section,
    end_meeting,
    remove_meeting_participant,
    reopen_meeting,
    reorder_series_sections,
    start_meeting,
    update_meeting,
    update_meeting_item,
    update_meeting_series,
    update_series_section,
)


User = get_user_model()


class MeetingScopeBase(TestCase):
    def setUp(self):
        self.alex = User.objects.create_user(
            username="scope-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="scope-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="scope-maria", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="scope-laura", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Scope Group", created_by=self.alex,
        )
        for user in (self.alex, self.chris, self.maria, self.laura):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Private Project",
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
        self.scheduled_at = timezone.now() + timedelta(days=1)


class MeetingScopeDomainTest(MeetingScopeBase):
    def test_project_series_requires_project_access(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting_series(
                research_group=self.group,
                actor=self.maria,
                title="Private Weekly",
                scope=MeetingSeries.Scope.PROJECT,
                project=self.project,
            )

    def test_group_series_rejects_project(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting_series(
                research_group=self.group,
                actor=self.alex,
                title="Invalid Weekly",
                scope=MeetingSeries.Scope.GROUP,
                project=self.project,
            )

    def test_occurrence_inherits_series_scope_and_project(self):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Project Weekly",
            scope=MeetingSeries.Scope.PROJECT,
            project=self.project,
        )

        meeting = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )

        self.assertEqual(meeting.scope, Meeting.Scope.PROJECT)
        self.assertEqual(meeting.project, self.project)

    def test_project_meeting_participant_requires_project_access(self):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Project Weekly",
            scope=MeetingSeries.Scope.PROJECT,
            project=self.project,
        )
        meeting = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )

        # A Project Meeting participant must hold a valid current
        # ProjectMembership. A user without Project access (maria) is
        # rejected and no ProjectMembership is created as a side
        # effect.
        with self.assertRaises(MeetingDomainError):
            add_meeting_participant(
                meeting=meeting,
                actor=self.alex,
                target_user=self.maria,
            )
        self.assertFalse(
            MeetingParticipant.objects.filter(
                meeting=meeting,
                user=self.maria,
            ).exists()
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.maria,
            ).exists()
        )

        # A user with a valid ProjectMembership (chris, MEMBER) can be
        # added as a participant.
        participant = add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )
        self.assertEqual(participant.user, self.chris)

    def test_project_access_revocation_blocks_nested_mutation(self):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Project Weekly",
            scope=MeetingSeries.Scope.PROJECT,
            project=self.project,
        )
        self.project.memberships.filter(user=self.chris).delete()

        with self.assertRaises(MeetingDomainError):
            create_series_section(
                meeting_series=series,
                actor=self.chris,
                name="Private section",
            )

    def test_viewer_cannot_mutate_project_scope_through_services(self):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Project Weekly",
            scope=MeetingSeries.Scope.PROJECT,
            project=self.project,
        )
        first = create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="First",
        )
        second = create_series_section(
            meeting_series=series,
            actor=self.alex,
            name="Second",
        )
        meeting = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        participant = add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.laura,
        )
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.filter(meeting=meeting).first(),
            actor=self.alex,
            title="Original item",
        )

        # Template (series) operations remain governed by the Project
        # write role: the viewer cannot create or mutate the Template,
        # its Sections, or occurrences.
        series_operations = {
            "series create": lambda: create_meeting_series(
                research_group=self.group,
                actor=self.laura,
                title="Viewer series",
                scope=MeetingSeries.Scope.PROJECT,
                project=self.project,
            ),
            "series update": lambda: update_meeting_series(
                meeting_series=series,
                actor=self.laura,
                title="Viewer title",
                is_archived=True,
            ),
            "section create": lambda: create_series_section(
                meeting_series=series,
                actor=self.laura,
                name="Viewer section",
            ),
            "section update": lambda: update_series_section(
                series_section=first,
                actor=self.laura,
                name="Viewer first",
            ),
            "section reorder": lambda: reorder_series_sections(
                meeting_series=series,
                actor=self.laura,
                section_ids=[second.pk, first.pk],
            ),
            "occurrence create": lambda: create_meeting_from_series(
                meeting_series=series,
                actor=self.laura,
                scheduled_at=self.scheduled_at + timedelta(days=7),
            ),
            "direct meeting create": lambda: create_meeting(
                research_group=self.group,
                actor=self.laura,
                title="Viewer meeting",
                scheduled_at=self.scheduled_at,
                scope=Meeting.Scope.PROJECT,
                project=self.project,
            ),
        }

        for label, operation in series_operations.items():
            with self.subTest(operation=label):
                with self.assertRaises(MeetingDomainError):
                    operation()

        # Meeting-level collaboration on an explicit Meeting: laura
        # is an explicit participant and may edit and run this
        # Meeting; her Project VIEWER role is sufficient for
        # collaboration and is not upgraded by doing so. Destructive
        # administration (participant removal) is asserted separately
        # below as viewer-denied.
        update_meeting(
            meeting=meeting,
            actor=self.laura,
            title="Viewer meeting title",
        )
        added = add_meeting_participant(
            meeting=meeting,
            actor=self.laura,
            target_user=self.chris,
        )
        self.assertEqual(added.user, self.chris)
        # Adding is collaboration (viewer OK); removing is
        # administration — done here by the Project owner.
        remove_meeting_participant(participant=added, actor=self.alex)
        create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.filter(
                meeting=meeting,
            ).first(),
            actor=self.laura,
            title="Viewer item",
        )
        update_meeting_item(
            meeting_item=item,
            actor=self.laura,
            title="Viewer item title",
        )

        # Participant removal is destructive Meeting administration:
        # the viewer-participant may NOT remove participants (neither
        # others nor her own row); the Project write role is required.
        readded = add_meeting_participant(
            meeting=meeting,
            actor=self.laura,
            target_user=self.chris,
        )
        with self.assertRaises(MeetingDomainError):
            remove_meeting_participant(
                participant=readded, actor=self.laura,
            )
        remove_meeting_participant(participant=readded, actor=self.alex)
        with self.assertRaises(MeetingDomainError):
            remove_meeting_participant(
                participant=participant, actor=self.laura,
            )
        # The Project owner removes laura's participation.
        remove_meeting_participant(participant=participant, actor=self.alex)

        series.refresh_from_db()
        first.refresh_from_db()
        second.refresh_from_db()
        meeting.refresh_from_db()
        item.refresh_from_db()
        self.assertEqual(series.title, "Project Weekly")
        self.assertFalse(series.is_archived)
        self.assertEqual(first.name, "First")
        self.assertEqual([first.position, second.position], [0, 1])
        self.assertEqual(meeting.title, "Viewer meeting title")
        self.assertEqual(item.title, "Viewer item title")
        self.assertEqual(
            Meeting.objects.filter(project=self.project).count(),
            1,
        )
        self.assertEqual(
            MeetingItem.objects.filter(meeting=meeting).count(),
            2,
        )
        self.assertFalse(
            MeetingParticipant.objects.filter(pk=added.pk).exists()
        )
        self.assertFalse(
            MeetingParticipant.objects.filter(pk=participant.pk).exists()
        )
        laura_membership = ProjectMembership.objects.get(
            project=self.project,
            user=self.laura,
        )
        self.assertEqual(laura_membership.role, ProjectMembership.Role.VIEWER)


class MeetingScopeApiTest(MeetingScopeBase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.group_series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Group Weekly",
        )
        self.project_series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Project Weekly",
            scope=MeetingSeries.Scope.PROJECT,
            project=self.project,
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def test_series_list_filters_project_scope(self):
        self.login(self.maria)

        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [series["id"] for series in response.json()],
            [self.group_series.pk],
        )

    def test_owner_and_member_can_read_and_patch_project_series(self):
        for user, title in [
            (self.alex, "Owner update"),
            (self.chris, "Member update"),
        ]:
            with self.subTest(user=user.username):
                self.login(user)
                read_response = self.client.get(
                    f"/api/meeting-series/{self.project_series.pk}/",
                )
                patch_response = self.client.patch(
                    f"/api/meeting-series/{self.project_series.pk}/",
                    {"title": title},
                    format="json",
                )

                self.assertEqual(
                    read_response.status_code,
                    status.HTTP_200_OK,
                )
                self.assertEqual(
                    patch_response.status_code,
                    status.HTTP_200_OK,
                )
                self.project_series.refresh_from_db()
                self.assertEqual(self.project_series.title, title)

    def test_viewer_can_read_project_scope(self):
        section = create_series_section(
            meeting_series=self.project_series,
            actor=self.alex,
            name="Readable section",
        )
        meeting = create_meeting_from_series(
            meeting_series=self.project_series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.filter(meeting=meeting).first(),
            actor=self.alex,
            title="Readable item",
        )
        add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.laura,
        )
        self.login(self.laura)

        urls = [
            f"/api/meeting-series/{self.project_series.pk}/",
            f"/api/meeting-series/{self.project_series.pk}/sections/",
            f"/api/meeting-series-sections/{section.pk}/",
            f"/api/meetings/{meeting.pk}/",
            f"/api/meetings/{meeting.pk}/items/",
            f"/api/meeting-items/{item.pk}/",
        ]
        for url in urls:
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(
                    response.status_code,
                    status.HTTP_200_OK,
                )

    def test_project_member_can_create_project_series(self):
        self.login(self.chris)

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
            {
                "title": "Project Planning",
                "scope": "project",
                "projectId": self.project.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.json()["scope"], "project")
        self.assertEqual(response.json()["projectId"], self.project.pk)

    def test_project_owner_can_create_project_series(self):
        self.login(self.alex)

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
            {
                "title": "Owner Project Planning",
                "scope": "project",
                "projectId": self.project.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_viewer_cannot_create_or_patch_project_series(self):
        before_count = MeetingSeries.objects.count()
        original_title = self.project_series.title
        self.login(self.laura)

        create_response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
            {
                "title": "Viewer Project Planning",
                "scope": "project",
                "projectId": self.project.pk,
            },
            format="json",
        )
        patch_response = self.client.patch(
            f"/api/meeting-series/{self.project_series.pk}/",
            {"title": "Viewer update", "isArchived": True},
            format="json",
        )

        self.assertEqual(create_response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(patch_response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(MeetingSeries.objects.count(), before_count)
        self.project_series.refresh_from_db()
        self.assertEqual(self.project_series.title, original_title)
        self.assertFalse(self.project_series.is_archived)

    def test_viewer_cannot_mutate_or_reorder_series_sections(self):
        first = create_series_section(
            meeting_series=self.project_series,
            actor=self.alex,
            name="First",
        )
        second = create_series_section(
            meeting_series=self.project_series,
            actor=self.alex,
            name="Second",
        )
        before_count = self.project_series.series_sections.count()
        self.login(self.laura)

        create_response = self.client.post(
            f"/api/meeting-series/{self.project_series.pk}/sections/",
            {"name": "Viewer section"},
            format="json",
        )
        patch_response = self.client.patch(
            f"/api/meeting-series-sections/{first.pk}/",
            {"name": "Viewer first", "isActive": False},
            format="json",
        )
        reorder_response = self.client.patch(
            f"/api/meeting-series/{self.project_series.pk}/sections/reorder/",
            {"sectionIds": [second.pk, first.pk]},
            format="json",
        )

        for response in [create_response, patch_response, reorder_response]:
            self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(
            self.project_series.series_sections.count(),
            before_count,
        )
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual(first.name, "First")
        self.assertTrue(first.is_active)
        self.assertEqual([first.position, second.position], [0, 1])

    def test_viewer_cannot_create_occurrence_or_direct_meeting(self):
        before_count = Meeting.objects.count()
        self.login(self.laura)

        occurrence_response = self.client.post(
            f"/api/meeting-series/{self.project_series.pk}/occurrences/",
            {"scheduledAt": self.scheduled_at.isoformat()},
            format="json",
        )
        direct_response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meetings/",
            {
                "title": "Viewer meeting",
                "scheduledAt": self.scheduled_at.isoformat(),
                "scope": "project",
                "projectId": self.project.pk,
            },
            format="json",
        )

        self.assertEqual(
            occurrence_response.status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(direct_response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(Meeting.objects.count(), before_count)

    def test_project_meeting_participants_require_project_access(self):
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.maria,
            ).exists()
        )
        self.login(self.alex)

        # A user without ProjectMembership cannot be an initial
        # participant of a Project Meeting; nothing is persisted and
        # no ProjectMembership is created as a side effect.
        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meetings/",
            {
                "title": "Project meeting with guest",
                "scheduledAt": self.scheduled_at.isoformat(),
                "scope": "project",
                "projectId": self.project.pk,
                "participantIds": [self.maria.pk],
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            Meeting.objects.filter(
                title="Project meeting with guest"
            ).count(),
            0,
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project,
                user=self.maria,
            ).exists()
        )

        # A user with a valid ProjectMembership (chris) can be an
        # initial participant and gains Meeting read access — never
        # Project access beyond the membership already held.
        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meetings/",
            {
                "title": "Project meeting with member",
                "scheduledAt": self.scheduled_at.isoformat(),
                "scope": "project",
                "projectId": self.project.pk,
                "participantIds": [self.chris.pk],
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        meeting_id = response.json()["id"]
        self.assertTrue(
            MeetingParticipant.objects.filter(
                meeting_id=meeting_id,
                user=self.chris,
            ).exists()
        )

        self.login(self.chris)
        self.assertEqual(
            self.client.get(f"/api/meetings/{meeting_id}/").status_code,
            status.HTTP_200_OK,
        )

    def test_viewer_participant_can_mutate_meeting_participants_and_items(self):
        create_series_section(
            meeting_series=self.project_series,
            actor=self.alex,
            name="Agenda",
        )
        meeting = create_meeting_from_series(
            meeting_series=self.project_series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.laura,
        )
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.filter(meeting=meeting).first(),
            actor=self.alex,
            title="Original item",
        )
        item_count = meeting.items.count()
        self.login(self.laura)

        # Meeting collaboration is explicit-participant-governed, not
        # Project-write-role-governed: laura (Project VIEWER, explicit
        # participant) may add/remove participants, edit the Meeting,
        # and mutate its items and sections.
        responses = [
            self.client.post(
                f"/api/meetings/{meeting.pk}/participants/",
                {"userId": self.chris.pk},
                format="json",
            ),
            self.client.patch(
                f"/api/meetings/{meeting.pk}/",
                {"title": "Viewer meeting update"},
                format="json",
            ),
            self.client.post(
                f"/api/meetings/{meeting.pk}/items/",
                {
                    "meetingSectionId": MeetingSection.objects.filter(
                        meeting=meeting,
                    ).first().pk,
                    "title": "Viewer item",
                },
                format="json",
            ),
            self.client.patch(
                f"/api/meeting-items/{item.pk}/",
                {"title": "Viewer item update"},
                format="json",
            ),
        ]

        expected = (
            status.HTTP_201_CREATED,
            status.HTTP_200_OK,
            status.HTTP_201_CREATED,
            status.HTTP_200_OK,
        )
        for response, expected_code in zip(responses, expected):
            self.assertEqual(response.status_code, expected_code)

        meeting.refresh_from_db()
        item.refresh_from_db()
        self.assertEqual(meeting.title, "Viewer meeting update")
        self.assertEqual(item.title, "Viewer item update")
        self.assertEqual(
            MeetingParticipant.objects.filter(
                meeting=meeting,
                user=self.chris,
            ).exists(),
            True,
        )
        self.assertEqual(meeting.items.count(), item_count + 1)
        # Meeting collaboration did not upgrade laura's Project role.
        laura_membership = ProjectMembership.objects.get(
            project=self.project,
            user=self.laura,
        )
        self.assertEqual(laura_membership.role, ProjectMembership.Role.VIEWER)
        # Nor did it grant Project writes: the viewer still cannot
        # mutate the Project itself.
        project_patch = self.client.patch(
            f"/api/projects/{self.project.pk}/",
            {"name": "Hijacked project"},
            format="json",
        )
        self.assertEqual(project_patch.status_code, status.HTTP_403_FORBIDDEN)

    def test_group_only_member_cannot_create_project_series(self):
        self.login(self.maria)

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
            {
                "title": "Forbidden Project Planning",
                "scope": "project",
                "projectId": self.project.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_project_series_nested_endpoints_are_not_leaked(self):
        section = create_series_section(
            meeting_series=self.project_series,
            actor=self.alex,
            name="Private section",
        )
        self.login(self.maria)

        urls = [
            f"/api/meeting-series/{self.project_series.pk}/",
            f"/api/meeting-series/{self.project_series.pk}/sections/",
            f"/api/meeting-series-sections/{section.pk}/",
        ]
        for url in urls:
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(
                    response.status_code,
                    status.HTTP_404_NOT_FOUND,
                )

    def test_project_a_membership_does_not_authorize_project_b(self):
        other_project = create_project(
            research_group=self.group,
            creator=self.maria,
            name="Other Private Project",
        )
        other_series = create_meeting_series(
            research_group=self.group,
            actor=self.maria,
            title="Other Project Weekly",
            scope=MeetingSeries.Scope.PROJECT,
            project=other_project,
        )
        original_title = other_series.title
        self.login(self.alex)

        list_response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
        )
        detail_response = self.client.get(
            f"/api/meeting-series/{other_series.pk}/",
        )
        patch_response = self.client.patch(
            f"/api/meeting-series/{other_series.pk}/",
            {"title": "Cross-project update"},
            format="json",
        )

        self.assertNotIn(
            other_series.pk,
            [series["id"] for series in list_response.json()],
        )
        self.assertEqual(detail_response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(patch_response.status_code, status.HTTP_404_NOT_FOUND)
        other_series.refresh_from_db()
        self.assertEqual(other_series.title, original_title)

    def test_project_occurrence_inherits_scope_and_is_filtered(self):
        meeting = create_meeting_from_series(
            meeting_series=self.project_series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )

        self.login(self.maria)
        list_response = self.client.get(
            f"/api/research-groups/{self.group.pk}/meetings/",
        )
        detail_response = self.client.get(f"/api/meetings/{meeting.pk}/")

        self.assertNotIn(
            meeting.pk,
            [item["id"] for item in list_response.json()],
        )
        self.assertEqual(
            detail_response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_scope_and_project_are_immutable(self):
        self.login(self.alex)

        response = self.client.patch(
            f"/api/meeting-series/{self.group_series.pk}/",
            {"scope": "project", "projectId": self.project.pk},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_group_scope_rejects_project_id(self):
        self.login(self.alex)

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
            {
                "title": "Invalid Group Weekly",
                "scope": "group",
                "projectId": self.project.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cross_group_project_cannot_create_series_or_meeting(self):
        other_group = ResearchGroup.objects.create(
            name="Other Scope Group",
            created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=other_group,
            user=self.alex,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        other_project = create_project(
            research_group=other_group,
            creator=self.alex,
            name="Other Group Project",
        )
        series_count = MeetingSeries.objects.count()
        meeting_count = Meeting.objects.count()
        self.login(self.alex)

        series_response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meeting-series/",
            {
                "title": "Cross-group series",
                "scope": "project",
                "projectId": other_project.pk,
            },
            format="json",
        )
        meeting_response = self.client.post(
            f"/api/research-groups/{self.group.pk}/meetings/",
            {
                "title": "Cross-group meeting",
                "scheduledAt": self.scheduled_at.isoformat(),
                "scope": "project",
                "projectId": other_project.pk,
            },
            format="json",
        )

        self.assertEqual(series_response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(meeting_response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(MeetingSeries.objects.count(), series_count)
        self.assertEqual(Meeting.objects.count(), meeting_count)

    def test_archived_project_scope_is_read_only_for_owner_and_member(self):
        section = create_series_section(
            meeting_series=self.project_series,
            actor=self.alex,
            name="Original section",
        )
        meeting = create_meeting_from_series(
            meeting_series=self.project_series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        participant = add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.laura,
        )
        add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.filter(meeting=meeting).first(),
            actor=self.alex,
            title="Original item",
        )
        archive_project(project=self.project, actor=self.alex)
        series_count = MeetingSeries.objects.count()
        meeting_count = Meeting.objects.count()
        participant_count = meeting.participant_relations.count()
        item_count = meeting.items.count()

        for user in (self.alex, self.chris):
            with self.subTest(user=user.username):
                self.login(user)

                read_responses = [
                    self.client.get(
                        f"/api/meeting-series/{self.project_series.pk}/",
                    ),
                    self.client.get(f"/api/meetings/{meeting.pk}/"),
                ]
                mutation_responses = [
                    self.client.post(
                        f"/api/research-groups/{self.group.pk}/meeting-series/",
                        {
                            "title": "Archived project series",
                            "scope": "project",
                            "projectId": self.project.pk,
                        },
                        format="json",
                    ),
                    self.client.patch(
                        f"/api/meeting-series/{self.project_series.pk}/",
                        {"title": "Archived series update"},
                        format="json",
                    ),
                    self.client.post(
                        f"/api/meeting-series/{self.project_series.pk}/sections/",
                        {"name": "Archived section"},
                        format="json",
                    ),
                    self.client.post(
                        f"/api/meeting-series/{self.project_series.pk}/occurrences/",
                        {
                            "scheduledAt": (
                                self.scheduled_at + timedelta(days=7)
                            ).isoformat(),
                        },
                        format="json",
                    ),
                    self.client.post(
                        f"/api/research-groups/{self.group.pk}/meetings/",
                        {
                            "title": "Archived project meeting",
                            "scheduledAt": self.scheduled_at.isoformat(),
                            "scope": "project",
                            "projectId": self.project.pk,
                        },
                        format="json",
                    ),
                    self.client.patch(
                        f"/api/meetings/{meeting.pk}/",
                        {"title": "Archived meeting update"},
                        format="json",
                    ),
                    self.client.delete(
                        (
                            f"/api/meetings/{meeting.pk}/participants/"
                            f"{participant.pk}/"
                        ),
                    ),
                    self.client.post(
                        f"/api/meetings/{meeting.pk}/items/",
                        {"title": "Archived item"},
                        format="json",
                    ),
                    self.client.patch(
                        f"/api/meeting-items/{item.pk}/",
                        {"title": "Archived item update"},
                        format="json",
                    ),
                ]

                for response in read_responses:
                    self.assertEqual(response.status_code, status.HTTP_200_OK)
                for response in mutation_responses:
                    self.assertEqual(
                        response.status_code,
                        status.HTTP_403_FORBIDDEN,
                    )

        self.project_series.refresh_from_db()
        section.refresh_from_db()
        meeting.refresh_from_db()
        item.refresh_from_db()
        self.assertEqual(self.project_series.title, "Project Weekly")
        self.assertEqual(section.name, "Original section")
        self.assertEqual(meeting.title, "Project Weekly")
        self.assertEqual(item.title, "Original item")
        self.assertEqual(MeetingSeries.objects.count(), series_count)
        self.assertEqual(Meeting.objects.count(), meeting_count)
        self.assertEqual(
            meeting.participant_relations.count(),
            participant_count,
        )
        self.assertEqual(meeting.items.count(), item_count)
        self.assertTrue(
            MeetingParticipant.objects.filter(pk=participant.pk).exists()
        )


class MeetingLifecycleScopeApiTest(MeetingScopeBase):
    """Lifecycle Start/End reuse the scope-aware Meeting write rule."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.group_meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Group Weekly",
            scheduled_at=self.scheduled_at,
        )
        self.project_meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Project Weekly",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def test_project_owner_and_member_can_start_end(self):
        for user in (self.alex, self.chris):
            with self.subTest(user=user.username):
                meeting = create_meeting(
                    research_group=self.group,
                    actor=self.alex,
                    title="Lifecycle Weekly",
                    scheduled_at=self.scheduled_at,
                    scope=Meeting.Scope.PROJECT,
                    project=self.project,
                )
                if user != self.alex:
                    add_meeting_participant(
                        meeting=meeting,
                        actor=self.alex,
                        target_user=user,
                    )
                self.login(user)
                self.assertEqual(
                    self.client.post(
                        f"/api/meetings/{meeting.pk}/start",
                        {},
                        format="json",
                    ).status_code,
                    status.HTTP_200_OK,
                )
                self.assertEqual(
                    self.client.post(
                        f"/api/meetings/{meeting.pk}/end",
                        {},
                        format="json",
                    ).status_code,
                    status.HTTP_200_OK,
                )
                meeting.refresh_from_db()
                self.assertEqual(
                    meeting.status,
                    Meeting.Status.COMPLETED,
                )
                self.assertIsNotNone(meeting.ended_at)

    def test_viewer_cannot_start_or_end_project_meeting(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Lifecycle Weekly",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        self.login(self.laura)
        self.assertEqual(
            self.client.post(
                f"/api/meetings/{meeting.pk}/start",
                {},
                format="json",
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)

    def test_project_owner_can_reopen_and_viewer_cannot(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Lifecycle Weekly",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )

        # Complete it first.
        self.login(self.alex)
        self.client.post(f"/api/meetings/{meeting.pk}/start", {}, format="json")
        self.client.post(f"/api/meetings/{meeting.pk}/end", {}, format="json")
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.COMPLETED)

        # Owner can reopen.
        self.assertEqual(
            self.client.post(
                f"/api/meetings/{meeting.pk}/reopen",
                {},
                format="json",
            ).status_code,
            status.HTTP_200_OK,
        )
        meeting.refresh_from_db()
        self.assertEqual(meeting.status, Meeting.Status.LIVE)

        # A viewer (non-participant) cannot reopen (or start/end)
        # a project meeting — 404 (meeting not visible to her).
        self.login(self.laura)
        for action in ("start", "end", "reopen"):
            self.assertEqual(
                self.client.post(
                    f"/api/meetings/{meeting.pk}/{action}",
                    {},
                    format="json",
                ).status_code,
                status.HTTP_404_NOT_FOUND,
            )
