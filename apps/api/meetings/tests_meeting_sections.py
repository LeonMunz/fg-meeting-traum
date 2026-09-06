"""Meeting occurrence Sections, MeetingItem -> MeetingSection binding,
standalone default structure, and legacy flat-item migration."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.core.management import call_command
from django.test import TestCase, TransactionTestCase
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

from .models import (
    Meeting,
    MeetingItem,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)
from .services import (
    MeetingDomainError,
    create_meeting,
    create_meeting_from_series,
    create_meeting_item,
    create_meeting_section,
    create_meeting_series,
    create_series_section,
    reorder_meeting_sections,
    update_meeting_item,
    update_meeting_section,
    update_series_section,
)


User = get_user_model()


class MeetingSectionBase(TestCase):
    def setUp(self):
        self.alex = User.objects.create_user(
            username="msec-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="msec-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="msec-maria", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="msec-laura", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Meeting Section Group", created_by=self.alex,
        )
        for user, role in [
            (self.alex, ResearchGroupMembership.Role.ADMIN),
            (self.chris, ResearchGroupMembership.Role.MEMBER),
            (self.maria, ResearchGroupMembership.Role.MEMBER),
            (self.laura, ResearchGroupMembership.Role.MEMBER),
        ]:
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=role,
            )

        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Meeting Section Project",
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


class StandaloneDefaultStructureTest(MeetingSectionBase):
    def test_standalone_meeting_receives_default_agenda_section(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Standalone",
            scheduled_at=self.scheduled_at,
        )

        sections = list(
            MeetingSection.objects.filter(meeting=meeting)
        )
        self.assertEqual(len(sections), 1)
        self.assertEqual(sections[0].name, "Agenda")
        self.assertEqual(sections[0].position, 0)
        self.assertTrue(sections[0].is_visible)
        self.assertIsNone(sections[0].source_series_section_id)

    def test_standalone_project_meeting_receives_agenda_section(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Project Standalone",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        self.assertEqual(
            MeetingSection.objects.filter(meeting=meeting).count(),
            1,
        )


class ScopeCreationTest(MeetingSectionBase):
    def test_standalone_group_meeting_has_no_project(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Group Meeting",
            scheduled_at=self.scheduled_at,
        )
        self.assertEqual(meeting.scope, Meeting.Scope.GROUP)
        self.assertIsNone(meeting.project_id)

    def test_standalone_project_meeting_uses_project(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Project Meeting",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        self.assertEqual(meeting.scope, Meeting.Scope.PROJECT)
        self.assertEqual(meeting.project_id, self.project.pk)

    def test_project_meeting_requires_accessible_project(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting(
                research_group=self.group,
                actor=self.alex,
                title="No Project",
                scheduled_at=self.scheduled_at,
                scope=Meeting.Scope.PROJECT,
                project=None,
            )

    def test_project_meeting_rejects_foreign_group_project(self):
        other_group = ResearchGroup.objects.create(
            name="Other Group", created_by=self.alex,
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
            create_meeting(
                research_group=self.group,
                actor=self.alex,
                title="Cross Project",
                scheduled_at=self.scheduled_at,
                scope=Meeting.Scope.PROJECT,
                project=other_project,
            )

    def test_viewer_cannot_create_project_meeting(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting(
                research_group=self.group,
                actor=self.laura,
                title="Viewer Project Meeting",
                scheduled_at=self.scheduled_at,
                scope=Meeting.Scope.PROJECT,
                project=self.project,
            )

    def test_series_occurrence_inherits_scope_and_project(self):
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
        self.assertEqual(
            meeting.research_group_id,
            self.group.pk,
        )
        self.assertEqual(meeting.scope, Meeting.Scope.PROJECT)
        self.assertEqual(meeting.project_id, self.project.pk)


class MeetingSectionApiTest(MeetingSectionBase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Section Meeting",
            scheduled_at=self.scheduled_at,
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def test_group_member_can_list_sections(self):
        self.login(self.chris)
        response = self.client.get(
            f"/api/meetings/{self.meeting.pk}/sections/"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["name"], "Agenda")
        self.assertIn("isVisible", data[0])

    def test_group_member_can_add_section(self):
        self.login(self.chris)
        response = self.client.post(
            f"/api/meetings/{self.meeting.pk}/sections/",
            {"name": "TOPs", "description": "Decisions"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.json()["name"], "TOPs")
        self.assertEqual(
            MeetingSection.objects.filter(meeting=self.meeting).count(),
            2,
        )

    def test_non_member_cannot_add_section(self):
        outsider = User.objects.create_user(
            username="msec-outsider", password="Pass1!",
        )
        self.login(outsider)
        response = self.client.post(
            f"/api/meetings/{self.meeting.pk}/sections/",
            {"name": "Nope"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_viewer_cannot_mutate_project_meeting_sections(self):
        project_meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Viewer Project Meeting",
            scheduled_at=self.scheduled_at,
            scope=Meeting.Scope.PROJECT,
            project=self.project,
        )
        self.login(self.laura)

        for method, url, payload in [
            (
                "post",
                f"/api/meetings/{project_meeting.pk}/sections/",
                {"name": "Hack"},
            ),
            (
                "patch",
                f"/api/meeting-sections/{project_meeting.meeting_sections.first().pk}/",
                {"name": "Hack"},
            ),
            (
                "patch",
                f"/api/meetings/{project_meeting.pk}/sections/reorder/",
                {"sectionIds": []},
            ),
        ]:
            response = getattr(self.client, method)(
                url, payload, format="json"
            )
            self.assertEqual(
                response.status_code,
                status.HTTP_403_FORBIDDEN,
            )

    def test_rename_section_persists_and_isolated_from_series(self):
        section = self.meeting.meeting_sections.first()
        self.login(self.alex)
        response = self.client.patch(
            f"/api/meeting-sections/{section.pk}/",
            {"name": "FYIs", "description": "Updates"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        section.refresh_from_db()
        self.assertEqual(section.name, "FYIs")
        self.assertEqual(section.description, "Updates")

    def test_hide_show_section_persists(self):
        section = self.meeting.meeting_sections.first()
        self.login(self.alex)

        response = self.client.patch(
            f"/api/meeting-sections/{section.pk}/",
            {"isVisible": False},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        section.refresh_from_db()
        self.assertFalse(section.is_visible)

        self.client.patch(
            f"/api/meeting-sections/{section.pk}/",
            {"isVisible": True},
            format="json",
        )
        section.refresh_from_db()
        self.assertTrue(section.is_visible)

    def test_reorder_sections_persists(self):
        section_a = self.meeting.meeting_sections.first()
        section_b = create_meeting_section(
            meeting=self.meeting,
            actor=self.alex,
            name="Second",
        )
        self.login(self.alex)
        response = self.client.patch(
            f"/api/meetings/{self.meeting.pk}/sections/reorder/",
            {
                "sectionIds": [section_b.pk, section_a.pk],
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        positions = {
            s.pk: s.position
            for s in MeetingSection.objects.filter(meeting=self.meeting)
        }
        self.assertEqual(positions[section_b.pk], 0)
        self.assertEqual(positions[section_a.pk], 1)

    def test_reorder_rejects_partial_list(self):
        create_meeting_section(
            meeting=self.meeting,
            actor=self.alex,
            name="Extra",
        )
        section = self.meeting.meeting_sections.first()
        self.login(self.alex)
        response = self.client.patch(
            f"/api/meetings/{self.meeting.pk}/sections/reorder/",
            {"sectionIds": [section.pk]},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)


class MeetingItemSectionApiTest(MeetingSectionBase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Item Section Meeting",
            scheduled_at=self.scheduled_at,
        )
        self.login(self.chris)

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def test_item_creation_requires_section(self):
        response = self.client.post(
            f"/api/meetings/{self.meeting.pk}/items/",
            {"title": "No section"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_item_requires_section_of_same_meeting(self):
        other_meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Other",
            scheduled_at=self.scheduled_at,
        )
        other_section = other_meeting.meeting_sections.first()
        response = self.client.post(
            f"/api/meetings/{self.meeting.pk}/items/",
            {
                "meetingSectionId": other_section.pk,
                "title": "Wrong section",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_item_created_under_section_and_listed(self):
        section = self.meeting.meeting_sections.first()
        response = self.client.post(
            f"/api/meetings/{self.meeting.pk}/items/",
            {
                "meetingSectionId": section.pk,
                "title": "Under section",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        data = response.json()
        self.assertEqual(data["meetingSectionId"], section.pk)

        list_response = self.client.get(
            f"/api/meetings/{self.meeting.pk}/items/"
        )
        self.assertEqual(list_response.status_code, status.HTTP_200_OK)
        listed = list_response.json()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["meetingSectionId"], section.pk)


class SnapshotIsolationTest(MeetingSectionBase):
    def test_series_edits_do_not_mutate_meeting_snapshot(self):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Isolated Weekly",
        )
        create_series_section(
            meeting_series=series, actor=self.alex, name="Check-In",
        )
        create_series_section(
            meeting_series=series, actor=self.alex, name="Research",
        )
        meeting = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )

        meeting_section_names = [
            s.name
            for s in MeetingSection.objects.filter(meeting=meeting)
        ]
        self.assertEqual(
            meeting_section_names,
            ["Check-In", "Research"],
        )

        # Later Series changes must not touch the snapshot.
        series_sections = list(
            MeetingSeriesSection.objects.filter(
                meeting_series=series,
            ).order_by("position", "id"),
        )
        update_series_section(
            series_section=series_sections[0],
            actor=self.alex,
            name="Renamed In Series",
        )
        create_series_section(
            meeting_series=series, actor=self.alex, name="Added Later",
        )

        updated_names = [
            s.name
            for s in MeetingSection.objects.filter(meeting=meeting)
        ]
        self.assertEqual(updated_names, ["Check-In", "Research"])

    def test_occurrence_section_rename_does_not_mutate_series(self):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Rename Weekly",
        )
        series_section = create_series_section(
            meeting_series=series, actor=self.alex, name="Agenda",
        )
        meeting = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        meeting_section = MeetingSection.objects.get(
            meeting=meeting,
            source_series_section=series_section,
        )

        update_meeting_section(
            section=meeting_section,
            actor=self.alex,
            name="Occurrence Rename",
        )

        meeting_section.refresh_from_db()
        series_section.refresh_from_db()
        self.assertEqual(meeting_section.name, "Occurrence Rename")
        self.assertEqual(series_section.name, "Agenda")

    def test_occurrence_section_add_does_not_mutate_series(self):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="Add Weekly",
        )
        create_series_section(
            meeting_series=series, actor=self.alex, name="Only",
        )
        meeting = create_meeting_from_series(
            meeting_series=series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        series_count_before = MeetingSeriesSection.objects.filter(
            meeting_series=series,
        ).count()

        create_meeting_section(
            meeting=meeting,
            actor=self.alex,
            name="One-off",
        )

        self.assertEqual(
            MeetingSeriesSection.objects.filter(
                meeting_series=series,
            ).count(),
            series_count_before,
        )
        self.assertEqual(
            MeetingSection.objects.filter(meeting=meeting).count(),
            2,
        )


class LegacyMigrationTest(TransactionTestCase):
    """Exercise the legacy flat-item backfill and final NOT NULL invariant.

    The authoritative end-to-end reproduction of the populated-database
    migration (the original production failure) is ``manage.py migrate``
    against a database that already holds flat legacy items at the pre-0005
    state. This test exercises the *data* behavior of the 0005/0006
    backfill functions on a real PostgreSQL table that already carries the
    final schema (NOT NULL ``meeting_section_id``). Because that schema
    rejects NULL sections, the test first drops the foreign key (which also
    clears any pending deferred trigger events), inserts legacy flat items,
    runs the migration data functions, then restores the foreign key and
    the final unique constraint.
    """

    _FK = ('"meetings_item_meeting_section_id_fkey"')
    _MEETING_FK = ('"meetings_meeting_current_meeting_item_id_fkey"')

    def _drop_item_fk(self):
        # Drop the FKs, NOT NULL constraint, and the final unique
        # constraint so flat (NULL-section) legacy items can be
        # inserted despite the final schema. The Meeting
        # current-pointer FK is dropped because deleting a Meeting
        # below would otherwise be blocked by the referencing row.
        with connection.schema_editor(atomic=False) as editor:
            editor.execute(
                'ALTER TABLE "meetings_item" DROP CONSTRAINT IF EXISTS '
                '"meetings_item_meeting_section_id_fkey";'
            )
            editor.execute(
                'ALTER TABLE "meetings_meeting" DROP CONSTRAINT IF EXISTS '
                '"meetings_meeting_current_meeting_item_id_fkey";'
            )
            editor.execute(
                'ALTER TABLE "meetings_item" DROP CONSTRAINT IF EXISTS '
                '"meetings_item_unique_section_position";'
            )
            editor.execute(
                'ALTER TABLE "meetings_item" ALTER COLUMN '
                '"meeting_section_id" DROP NOT NULL;'
            )

    def _restore_item_fk(self):
        with connection.schema_editor(atomic=False) as editor:
            editor.execute(
                'ALTER TABLE "meetings_item" ALTER COLUMN '
                '"meeting_section_id" SET NOT NULL;'
            )
            editor.execute(
                'ALTER TABLE "meetings_item" DROP CONSTRAINT IF EXISTS '
                '"meetings_item_meeting_section_id_fkey";'
            )
            editor.execute(
                'ALTER TABLE "meetings_item" ADD CONSTRAINT '
                '"meetings_item_meeting_section_id_fkey" FOREIGN KEY '
                '("meeting_section_id") REFERENCES "meetings_section" ("id");'
            )

    def _seed_legacy(self, now):
        """Create meetings/series/sections, then flat items (FK dropped)."""
        from django.contrib.auth import get_user_model
        from research_groups.models import ResearchGroup, ResearchGroupMembership
        from .models import (
            Meeting,
            MeetingSection,
            MeetingSeries,
            MeetingSeriesSection,
        )

        user_model = get_user_model()
        alex = user_model.objects.create_user(
            username="legacy-alex", email="legacy-alex@example.com",
            password="Pass1!",
        )
        group = ResearchGroup.objects.create(name="Legacy Group", created_by=alex)
        ResearchGroupMembership.objects.create(
            research_group=group, user=alex, role="admin",
        )

        meeting_a = Meeting.objects.create(
            research_group=group, scope="group", title="Legacy Flat Meeting",
            scheduled_at=now, status="upcoming", created_by=alex,
        )
        series = MeetingSeries.objects.create(
            research_group=group, scope="group", title="Dev Weekly",
            created_by=alex,
        )
        ss1 = MeetingSeriesSection.objects.create(
            meeting_series=series, name="Check-In", description="",
            position=0, is_active=True,
        )
        ss2 = MeetingSeriesSection.objects.create(
            meeting_series=series, name="Research", description="",
            position=1, is_active=True,
        )
        meeting_b = Meeting.objects.create(
            research_group=group, scope="group", series=series,
            title="Legacy Snapped Meeting", scheduled_at=now, status="upcoming",
            created_by=alex,
        )
        MeetingSection.objects.create(
            meeting=meeting_b, source_series_section=ss1, name="Check-In",
            description="", position=0, is_visible=True,
        )
        MeetingSection.objects.create(
            meeting=meeting_b, source_series_section=ss2, name="Research",
            description="", position=1, is_visible=True,
        )

        # Drop the FK so flat (NULL-section) items can be inserted despite
        # the NOT NULL column, then insert legacy flat items.
        self._drop_item_fk()
        with connection.cursor() as cursor:
            for position, title in enumerate(
                ["Legacy item A1", "Legacy item A2", "Legacy item A3"]
            ):
                cursor.execute(
                    "INSERT INTO meetings_item (title, notes, position,"
                    " outcome, created_at, updated_at, meeting_id,"
                    " meeting_section_id, created_by_id) VALUES"
                    " (%s, '', %s, 'not_discussed', %s, %s, %s, NULL, %s)",
                    [title, position, now.isoformat(), now.isoformat(),
                     meeting_a.pk, alex.pk],
                )
            for position, title in enumerate(["Orphan item B1", "Orphan item B2"]):
                cursor.execute(
                    "INSERT INTO meetings_item (title, notes, position,"
                    " outcome, created_at, updated_at, meeting_id,"
                    " meeting_section_id, created_by_id) VALUES"
                    " (%s, '', %s, 'not_discussed', %s, %s, %s, NULL, %s)",
                    [title, position, now.isoformat(), now.isoformat(),
                     meeting_b.pk, alex.pk],
                )
        return meeting_a, meeting_b

    def _run_migration_data_functions(self):
        import importlib
        from django.apps import apps as django_apps

        m05 = importlib.import_module(
            "meetings.migrations.0005_meetingitem_section_nullable")
        m06 = importlib.import_module(
            "meetings.migrations.0006_meetingitem_section")
        with connection.schema_editor(atomic=False) as editor:
            m05._backfill_legacy_items(django_apps, editor)
            m06._ensure_all_items_sectioned(django_apps, editor)

    def _restore_final_schema(self):
        """Re-add the FK and the final unique constraint (both present in the
        final schema). Idempotent so it can be called more than once."""
        self._restore_item_fk()
        with connection.schema_editor(atomic=False) as editor:
            editor.execute(
                'ALTER TABLE "meetings_item" DROP CONSTRAINT IF EXISTS '
                '"meetings_item_unique_section_position";'
            )
            editor.execute(
                'ALTER TABLE "meetings_item" ADD CONSTRAINT '
                '"meetings_item_unique_section_position" UNIQUE '
                '("meeting_section_id", "position");'
            )
            # Restore the Meeting current-pointer FK (referenced by
            # meetings_meeting.current_meeting_item_id).
            editor.execute(
                'ALTER TABLE "meetings_meeting" DROP CONSTRAINT IF EXISTS '
                '"meetings_meeting_current_meeting_item_id_fkey";'
            )
            editor.execute(
                'ALTER TABLE "meetings_meeting" ADD CONSTRAINT '
                '"meetings_meeting_current_meeting_item_id_fkey" FOREIGN KEY '
                '("current_meeting_item_id") REFERENCES "meetings_item" ("id");'
            )

    def test_legacy_items_get_valid_sections_and_final_not_null(self):
        from .models import MeetingItem, MeetingSection

        meeting_a, meeting_b = self._seed_legacy(timezone.now())
        self._run_migration_data_functions()
        self._restore_final_schema()

        # Meeting A: exactly one occurrence "Unsectioned" section, 3 items.
        sections_a = list(MeetingSection.objects.filter(meeting_id=meeting_a.pk))
        self.assertEqual(len(sections_a), 1)
        self.assertEqual(sections_a[0].name, "Unsectioned")
        self.assertIsNone(sections_a[0].source_series_section_id)
        items_a = list(
            MeetingItem.objects.filter(meeting_id=meeting_a.pk).order_by("position"))
        self.assertEqual(
            [i.title for i in items_a],
            ["Legacy item A1", "Legacy item A2", "Legacy item A3"])
        for item in items_a:
            self.assertEqual(item.meeting_section_id, sections_a[0].pk)

        # Meeting B: 3 sections; orphans NOT in the snapshotted sections.
        sections_b = list(MeetingSection.objects.filter(meeting_id=meeting_b.pk))
        self.assertEqual(len(sections_b), 3)
        self.assertEqual(
            {s.name for s in sections_b if s.source_series_section_id is not None},
            {"Check-In", "Research"},
        )
        unsectioned_b = [s for s in sections_b if s.name == "Unsectioned"]
        self.assertEqual(len(unsectioned_b), 1)
        snap_checkin = next(s for s in sections_b if s.name == "Check-In")
        snap_research = next(s for s in sections_b if s.name == "Research")
        self.assertEqual(
            MeetingItem.objects.filter(meeting_section_id=snap_checkin.pk).count(), 0)
        self.assertEqual(
            MeetingItem.objects.filter(meeting_section_id=snap_research.pk).count(), 0)
        self.assertEqual(
            MeetingItem.objects.filter(meeting_section_id=unsectioned_b[0].pk).count(), 2)
        items_b = list(
            MeetingItem.objects.filter(meeting_id=meeting_b.pk).order_by("position"))
        self.assertEqual([i.title for i in items_b], ["Orphan item B1", "Orphan item B2"])

        self.assertFalse(
            MeetingItem.objects.filter(meeting_section__isnull=True).exists())
        self.assertEqual(MeetingItem.objects.count(), 5)

    def test_backfill_is_idempotent_and_series_untouched(self):
        from .models import (
            MeetingItem,
            MeetingSection,
            MeetingSeries,
            MeetingSeriesSection,
        )

        meeting_a, meeting_b = self._seed_legacy(timezone.now())
        self._run_migration_data_functions()
        self._restore_final_schema()
        self.assertEqual(
            MeetingSection.objects.filter(meeting_id=meeting_a.pk).count(), 1)
        self.assertEqual(
            MeetingSection.objects.filter(meeting_id=meeting_b.pk).count(), 3)
        self.assertEqual(MeetingSeriesSection.objects.count(), 2)
        self.assertEqual(MeetingSeries.objects.count(), 1)

        # Re-run the data functions: no duplicates, no data change.
        self._run_migration_data_functions()
        self._restore_final_schema()
        self.assertEqual(
            MeetingSection.objects.filter(meeting_id=meeting_a.pk).count(), 1)
        self.assertEqual(
            MeetingSection.objects.filter(meeting_id=meeting_b.pk).count(), 3)
        self.assertEqual(MeetingItem.objects.count(), 5)
        self.assertFalse(
            MeetingItem.objects.filter(meeting_section__isnull=True).exists())
        self.assertEqual(MeetingSeriesSection.objects.count(), 2)
        self.assertEqual(MeetingSeries.objects.count(), 1)

    def test_final_column_is_not_null(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT is_nullable FROM information_schema.columns "
                "WHERE table_name = 'meetings_item' "
                "AND column_name = 'meeting_section_id'"
            )
            is_nullable = cursor.fetchone()[0]
        self.assertEqual(is_nullable, "NO")
