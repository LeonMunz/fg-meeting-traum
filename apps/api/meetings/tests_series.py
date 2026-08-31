"""Tests for MeetingSeries, MeetingSeriesSection, and MeetingSection snapshots."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from .models import (
    Meeting,
    MeetingParticipant,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)
from .services import (
    MeetingDomainError,
    create_meeting,
    create_meeting_from_series,
    create_meeting_series,
    create_series_section,
    reorder_series_sections,
    update_meeting_series,
    update_series_section,
)


User = get_user_model()


class MeetingSeriesDomainTest(TestCase):
    """MeetingSeries create / update / authorization."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="series-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="series-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="series-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Series Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

    def test_group_member_can_create_series(self):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="FG Weekly",
            description="Weekly research group meeting.",
        )
        self.assertEqual(series.title, "FG Weekly")
        self.assertEqual(series.description, "Weekly research group meeting.")
        self.assertFalse(series.is_archived)
        self.assertEqual(series.created_by, self.alex)

    def test_non_member_cannot_create_series(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting_series(
                research_group=self.group,
                actor=self.maria,
                title="Forbidden",
            )

    def test_series_requires_title(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting_series(
                research_group=self.group,
                actor=self.alex,
                title="   ",
            )

    def test_group_member_can_update_series(self):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="FG Weekly",
        )

        update_meeting_series(
            meeting_series=series,
            actor=self.chris,
            title="FG Weekly Updated",
            description="Updated description.",
            is_archived=True,
        )
        series.refresh_from_db()
        self.assertEqual(series.title, "FG Weekly Updated")
        self.assertEqual(series.description, "Updated description.")
        self.assertTrue(series.is_archived)

    def test_non_member_cannot_update_series(self):
        series = create_meeting_series(
            research_group=self.group,
            actor=self.alex,
            title="FG Weekly",
        )
        with self.assertRaises(MeetingDomainError):
            update_meeting_series(
                meeting_series=series,
                actor=self.maria,
                title="Hacked",
            )


class MeetingSeriesSectionDomainTest(TestCase):
    """MeetingSeriesSection CRUD and reordering."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="section-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="section-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="section-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Section Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.series = MeetingSeries.objects.create(
            research_group=self.group,
            title="FG Weekly",
            created_by=self.alex,
        )

    def test_group_member_can_create_section(self):
        section = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Check-In",
            description="Quick round.",
        )
        self.assertEqual(section.name, "Check-In")
        self.assertEqual(section.description, "Quick round.")
        self.assertEqual(section.position, 0)
        self.assertTrue(section.is_active)

    def test_sections_receive_sequential_positions(self):
        s1 = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="First",
        )
        s2 = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Second",
        )
        s3 = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Third",
        )
        self.assertEqual(s1.position, 0)
        self.assertEqual(s2.position, 1)
        self.assertEqual(s3.position, 2)

    def test_non_member_cannot_create_section(self):
        with self.assertRaises(MeetingDomainError):
            create_series_section(
                meeting_series=self.series,
                actor=self.maria,
                name="Forbidden",
            )

    def test_section_requires_name(self):
        with self.assertRaises(MeetingDomainError):
            create_series_section(
                meeting_series=self.series,
                actor=self.alex,
                name="   ",
            )

    def test_group_member_can_update_section(self):
        section = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Check-In",
        )

        update_series_section(
            series_section=section,
            actor=self.chris,
            name="Quick Check-In",
            description="Updated.",
            is_active=False,
        )
        section.refresh_from_db()
        self.assertEqual(section.name, "Quick Check-In")
        self.assertEqual(section.description, "Updated.")
        self.assertFalse(section.is_active)

    def test_non_member_cannot_update_section(self):
        section = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Check-In",
        )
        with self.assertRaises(MeetingDomainError):
            update_series_section(
                series_section=section,
                actor=self.maria,
                name="Hacked",
            )

    def test_reorder_sections(self):
        s1 = create_series_section(
            meeting_series=self.series, actor=self.alex, name="A",
        )
        s2 = create_series_section(
            meeting_series=self.series, actor=self.alex, name="B",
        )
        s3 = create_series_section(
            meeting_series=self.series, actor=self.alex, name="C",
        )

        # Reorder: C, A, B
        reorder_series_sections(
            meeting_series=self.series,
            actor=self.alex,
            section_ids=[s3.pk, s1.pk, s2.pk],
        )

        positions = {
            s.pk: MeetingSeriesSection.objects.get(pk=s.pk).position
            for s in [s1, s2, s3]
        }
        self.assertEqual(positions[s3.pk], 0)
        self.assertEqual(positions[s1.pk], 1)
        self.assertEqual(positions[s2.pk], 2)

    def test_reorder_rejects_foreign_section(self):
        other_series = MeetingSeries.objects.create(
            research_group=self.group,
            title="Other",
            created_by=self.alex,
        )
        foreign = create_series_section(
            meeting_series=other_series,
            actor=self.alex,
            name="Foreign",
        )
        local = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Local",
        )

        with self.assertRaises(MeetingDomainError):
            reorder_series_sections(
                meeting_series=self.series,
                actor=self.alex,
                section_ids=[local.pk, foreign.pk],
            )

    def test_reorder_requires_non_empty_list(self):
        with self.assertRaises(MeetingDomainError):
            reorder_series_sections(
                meeting_series=self.series,
                actor=self.alex,
                section_ids=[],
            )

    def test_reorder_requires_all_sections(self):
        """A partial section ID list must be rejected with a 400 error."""
        s1 = create_series_section(
            meeting_series=self.series, actor=self.alex, name="A",
        )
        s2 = create_series_section(
            meeting_series=self.series, actor=self.alex, name="B",
        )

        # Only include one section — should be rejected.
        with self.assertRaises(MeetingDomainError) as ctx:
            reorder_series_sections(
                meeting_series=self.series,
                actor=self.alex,
                section_ids=[s2.pk],
            )
        self.assertIn("all sections", str(ctx.exception.message))


class MeetingOccurrenceSnapshotTest(TestCase):
    """Creating a Meeting from a Series snapshots active sections."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="snap-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="snap-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="snap-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Snapshot Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.series = MeetingSeries.objects.create(
            research_group=self.group,
            title="FG Weekly",
            created_by=self.alex,
        )

        self.scheduled_at = timezone.now() + timedelta(days=1)

    def _create_sections(self, names, active=True):
        sections = []
        for name in names:
            s = create_series_section(
                meeting_series=self.series,
                actor=self.alex,
                name=name,
            )
            if not active:
                s.is_active = False
                s.save(update_fields=["is_active"])
            sections.append(s)
        return sections

    def test_occurrence_snapshots_active_sections(self):
        sections = self._create_sections(["Check-In", "TOPs", "Projekte"])

        meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )

        self.assertEqual(meeting.series, self.series)
        self.assertEqual(meeting.research_group, self.group)
        self.assertEqual(meeting.title, "FG Weekly")

        meeting_sections = (
            MeetingSection.objects
            .filter(meeting=meeting)
            .order_by("position")
        )
        self.assertEqual(meeting_sections.count(), 3)

        names = [ms.name for ms in meeting_sections]
        self.assertEqual(names, ["Check-In", "TOPs", "Projekte"])

        # Verify source references
        for ms, ss in zip(meeting_sections, sections):
            self.assertEqual(ms.source_series_section, ss)
            self.assertEqual(ms.name, ss.name)
            self.assertEqual(ms.description, ss.description)
            self.assertTrue(ms.is_visible)

    def test_inactive_sections_are_not_copied(self):
        s1 = create_series_section(
            meeting_series=self.series, actor=self.alex, name="Active",
        )
        s2 = create_series_section(
            meeting_series=self.series, actor=self.alex, name="Inactive",
        )
        s2.is_active = False
        s2.save(update_fields=["is_active"])

        meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )

        meeting_sections = list(
            MeetingSection.objects.filter(meeting=meeting)
        )
        self.assertEqual(len(meeting_sections), 1)
        self.assertEqual(meeting_sections[0].name, "Active")

    def test_creator_becomes_participant(self):
        meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        self.assertTrue(
            MeetingParticipant.objects.filter(
                meeting=meeting, user=self.alex,
            ).exists()
        )

    def test_later_series_rename_does_not_mutate_snapshot(self):
        sections = self._create_sections(["Check-In", "TOPs"])

        meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )

        # Rename the series section after the meeting was created.
        series_section = MeetingSeriesSection.objects.get(
            meeting_series=self.series, name="Check-In",
        )
        series_section.name = "Renamed Check-In"
        series_section.save(update_fields=["name"])

        # The snapshot must remain unchanged.
        meeting_section = MeetingSection.objects.get(
            meeting=meeting,
            source_series_section=series_section,
        )
        self.assertEqual(meeting_section.name, "Check-In")

    def test_later_series_deactivation_does_not_mutate_snapshot(self):
        sections = self._create_sections(["Check-In"])

        meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )

        # Deactivate the series section after the meeting was created.
        series_section = MeetingSeriesSection.objects.get(
            meeting_series=self.series, name="Check-In",
        )
        series_section.is_active = False
        series_section.save(update_fields=["is_active"])

        # The snapshot must still exist and be visible.
        meeting_section = MeetingSection.objects.get(
            meeting=meeting,
            source_series_section=series_section,
        )
        self.assertTrue(meeting_section.is_visible)

    def test_later_occurrence_gets_current_series_structure(self):
        # Create first occurrence with initial structure.
        self._create_sections(["Check-In", "TOPs"])

        meeting1 = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )

        # Now modify the series: add a new section, deactivate one.
        new_section = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Projekte",
        )
        top_section = MeetingSeriesSection.objects.get(
            meeting_series=self.series, name="TOPs",
        )
        top_section.is_active = False
        top_section.save(update_fields=["is_active"])

        # Create second occurrence.
        meeting2 = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at + timedelta(days=7),
        )

        # First meeting still has original structure.
        m1_sections = list(
            MeetingSection.objects
            .filter(meeting=meeting1)
            .order_by("position")
            .values_list("name", flat=True)
        )
        self.assertEqual(m1_sections, ["Check-In", "TOPs"])

        # Second meeting has current active structure.
        m2_sections = list(
            MeetingSection.objects
            .filter(meeting=meeting2)
            .order_by("position")
            .values_list("name", flat=True)
        )
        self.assertEqual(m2_sections, ["Check-In", "Projekte"])

    def test_non_member_cannot_create_occurrence(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting_from_series(
                meeting_series=self.series,
                actor=self.maria,
                scheduled_at=self.scheduled_at,
            )

    def test_occurrence_can_override_title(self):
        meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            title="FG Weekly — Special Edition",
            scheduled_at=self.scheduled_at,
        )
        self.assertEqual(meeting.title, "FG Weekly — Special Edition")

    def test_occurrence_requires_scheduled_at(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting_from_series(
                meeting_series=self.series,
                actor=self.alex,
            )

    def test_snapshot_sections_are_in_deterministic_order(self):
        self._create_sections(["Zebra", "Alpha", "Middle"])

        meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )

        names = list(
            MeetingSection.objects
            .filter(meeting=meeting)
            .order_by("position")
            .values_list("name", flat=True)
        )
        # Sections were created in order Zebra, Alpha, Middle
        # and positions are 0, 1, 2 respectively.
        self.assertEqual(names, ["Zebra", "Alpha", "Middle"])
