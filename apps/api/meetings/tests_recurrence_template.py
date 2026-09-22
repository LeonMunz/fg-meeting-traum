"""Tests for the canonical MeetingRecurrence → MeetingSeries (Meeting
Template) linkage.

Pins the slice invariants:

- every NEW domain-created recurrence references a valid, persisted,
  scope-consistent Meeting Template (the content source for future
  materializations);
- the actor needs the canonical Template write rule of the scope
  (read-only/viewer actors are denied);
- a new materialized occurrence is initialized from the recurrence's
  Template with the normal Meeting-from-Template semantics;
- a materialized Meeting is an independent snapshot: Template edits
  and recurrence Template re-association never rewrite it;
- Template deletion preserves the recurrence (SET_NULL) and its
  materialized Meetings;
- a legacy template-less recurrence (NULL reference) survives the
  linkage migration, stays fully usable for what needs no content
  source, and rejects new virtual materialization with an explicit
  domain error.
"""

from datetime import date, datetime, time

from django.db import migrations

from projects.services import create_project
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import (
    Meeting,
    MeetingRecurrence,
    MeetingRecurrenceExclusion,
    MeetingSection,
    MeetingSeries,
)
from .services import (
    MeetingDomainError,
    cancel_meeting_recurrence_occurrence,
    create_meeting_recurrence,
    create_meeting_series,
    create_series_section,
    delete_meeting_series,
    exclude_meeting_recurrence_occurrence,
    materialize_meeting_recurrence_occurrence,
    reschedule_meeting_recurrence_occurrence,
    update_meeting,
    update_meeting_series,
)
from .tests_recurrence import BERLIN, MeetingRecurrenceBase, _utc


class MeetingRecurrenceTemplateCreationTest(MeetingRecurrenceBase):
    """New-recurring-series invariant: a valid canonical template."""

    def test_template_is_a_required_parameter(self):
        with self.assertRaises(TypeError):
            create_meeting_recurrence(
                research_group=self.group,
                actor=self.alex,
                title="Daily Standup",
                frequency="daily",
                interval=1,
                start_date=date(2026, 1, 5),
                local_time=time(9, 30),
                timezone_name="Europe/Berlin",
            )
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_unsaved_template_rejected(self):
        template = MeetingSeries(
            research_group=self.group,
            title="Unsaved Template",
        )
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(meeting_series=template)
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_nonexistent_template_rejected(self):
        template = self._create_series()
        template.delete()
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(meeting_series=template)
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_valid_template_reference_is_persisted(self):
        template = self._create_series()
        recurrence = self._create_recurrence(meeting_series=template)
        self.assertEqual(recurrence.series, template)
        recurrence.refresh_from_db()
        self.assertEqual(recurrence.series, template)

    def test_project_scope_recurrence_persists_project_template(self):
        template = self._create_series(
            scope="project", project=self.project,
        )
        recurrence = self._create_recurrence(
            meeting_series=template,
            scope="project",
            project=self.project,
        )
        self.assertEqual(recurrence.series, template)
        self.assertEqual(recurrence.project, self.project)


class MeetingRecurrenceTemplateTitleIndependenceTest(MeetingRecurrenceBase):
    """Recurrence title and Template title are independent concepts."""

    def test_recurrence_title_is_not_derived_from_template(self):
        template = self._create_series(title="FG Weekly Template")
        recurrence = self._create_recurrence(
            meeting_series=template,
            title="Daily Standup",
        )
        self.assertEqual(recurrence.title, "Daily Standup")
        self.assertNotEqual(recurrence.title, template.title)

    def test_template_rename_never_changes_recurrence_title(self):
        template = self._create_series(title="FG Weekly Template")
        recurrence = self._create_recurrence(
            meeting_series=template,
            title="Daily Standup",
        )
        update_meeting_series(
            meeting_series=template, actor=self.alex, title="Renamed",
        )
        recurrence.refresh_from_db()
        self.assertEqual(recurrence.title, "Daily Standup")

    def test_materialized_meeting_defaults_to_recurrence_title_not_template(
            self,
    ):
        template = self._create_series(title="Template Title")
        recurrence = self._create_recurrence(
            meeting_series=template,
            title="Series Title",
        )
        occurrence = self._first_occurrence(recurrence)
        meeting = materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.alex,
        )
        self.assertEqual(meeting.title, "Series Title")


class MeetingRecurrenceTemplateScopeTest(MeetingRecurrenceBase):
    """Scope consistency: the Template must match the recurrence scope."""

    def _second_group_with_template(self):
        group2 = ResearchGroup.objects.create(
            name="Second Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=group2, user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        template = create_meeting_series(
            research_group=group2,
            actor=self.alex,
            title="Other Group Template",
        )
        return group2, template

    def test_group_recurrence_rejects_project_template_of_same_group(self):
        template = self._create_series(
            scope="project", project=self.project,
        )
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(meeting_series=template)
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_group_recurrence_rejects_template_of_another_group(self):
        _, template = self._second_group_with_template()
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(meeting_series=template)
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_project_recurrence_rejects_group_template(self):
        template = self._create_series()
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                meeting_series=template,
                scope="project",
                project=self.project,
            )
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_project_recurrence_rejects_template_of_another_project(self):
        project2 = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Second Project",
        )
        template = self._create_series(
            scope="project", project=project2,
        )
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                meeting_series=template,
                scope="project",
                project=self.project,
            )
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_project_recurrence_rejects_template_of_another_group(self):
        _, template = self._second_group_with_template()
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                meeting_series=template,
                scope="project",
                project=self.project,
            )
        self.assertEqual(MeetingRecurrence.objects.count(), 0)


class MeetingRecurrenceTemplateAuthorizationTest(MeetingRecurrenceBase):
    """Creating a recurrence against a template reuses the canonical
    scoped Template write rule (read-only/viewer denial pinned)."""

    def test_group_member_can_create_recurrence_with_template(self):
        template = self._create_series()
        recurrence = self._create_recurrence(
            meeting_series=template,
            actor=self.chris,
        )
        self.assertEqual(recurrence.series, template)
        self.assertEqual(recurrence.created_by, self.chris)

    def test_project_owner_can_create_recurrence_with_project_template(
            self,
    ):
        template = self._create_series(
            scope="project", project=self.project,
        )
        recurrence = self._create_recurrence(
            meeting_series=template,
            scope="project",
            project=self.project,
            actor=self.alex,
        )
        self.assertEqual(recurrence.series, template)

    def test_project_member_can_create_recurrence_with_project_template(
            self,
    ):
        template = self._create_series(
            scope="project", project=self.project,
        )
        recurrence = self._create_recurrence(
            meeting_series=template,
            scope="project",
            project=self.project,
            actor=self.chris,
        )
        self.assertEqual(recurrence.series, template)

    def test_project_viewer_cannot_create_recurrence_with_template(self):
        template = self._create_series(
            scope="project", project=self.project,
        )
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                meeting_series=template,
                scope="project",
                project=self.project,
                actor=self.laura,
            )
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_outsider_cannot_create_recurrence_with_template(self):
        template = self._create_series()
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                meeting_series=template,
                actor=self.maria,
            )
        self.assertEqual(MeetingRecurrence.objects.count(), 0)


class MeetingRecurrenceTemplateMaterializationTest(MeetingRecurrenceBase):
    """New materializations use the recurrence's canonical Template."""

    def _template_with_sections(self, extra_sections=()):
        template = self._create_series(title="Materialization Template")
        for name, is_active in extra_sections:
            create_series_section(
                meeting_series=template,
                actor=self.alex,
                name=name,
            )
            if not is_active:
                section = template.series_sections.get(name=name)
                section.is_active = False
                section.save(update_fields=["is_active"])
        return template

    def test_materialization_snapshots_active_template_sections(self):
        template = self._template_with_sections(
            extra_sections=[("Updates", True), ("Archived", False)],
        )
        recurrence = self._create_recurrence(meeting_series=template)
        meeting = self._materialize(
            recurrence, self._first_occurrence(recurrence),
        )

        # Normal Meeting-from-Template semantics: exactly the ACTIVE
        # Template Sections, in Template order, each keeping its
        # source pointer; the Meeting carries the Template.
        self.assertEqual(meeting.series, template)
        sections = list(meeting.meeting_sections.order_by("position"))
        self.assertEqual([s.name for s in sections],
                         ["Agenda", "Updates"])
        self.assertEqual(
            [s.source_series_section.name for s in sections],
            ["Agenda", "Updates"],
        )
        self.assertEqual(
            [s.position for s in sections], [0, 1],
        )

    def test_template_edit_after_materialization_does_not_rewrite_meeting(
            self,
    ):
        template = self._create_series()
        recurrence = self._create_recurrence(meeting_series=template)
        meeting = self._materialize(
            recurrence, self._first_occurrence(recurrence),
        )
        (section,) = meeting.meeting_sections.all()

        # Later Template edits: rename + description, plus a new
        # section.
        series_section = template.series_sections.get()
        series_section.name = "Renamed Section"
        series_section.description = "New description"
        series_section.save()
        create_series_section(
            meeting_series=template, actor=self.alex, name="Extra",
        )

        meeting.refresh_from_db()
        (snapshot,) = meeting.meeting_sections.all()
        self.assertEqual(snapshot.pk, section.pk)
        self.assertEqual(snapshot.name, "Agenda")
        self.assertEqual(snapshot.description, "")
        self.assertIsNotNone(snapshot.source_series_section_id)
        self.assertEqual(meeting.meeting_sections.count(), 1)

    def test_changing_recurrence_template_does_not_rewrite_existing_meetings(
            self,
    ):
        template_a = self._create_series(title="Template A")
        create_series_section(
            meeting_series=template_a, actor=self.alex, name="Only A",
        )
        template_b = self._create_series(title="Template B")
        create_series_section(
            meeting_series=template_b, actor=self.alex, name="Only B",
        )
        recurrence = self._create_recurrence(meeting_series=template_a)

        first = self._first_occurrence(recurrence)
        meeting = self._materialize(recurrence, first)
        self.assertEqual(
            [s.name for s in meeting.meeting_sections.order_by("position")],
            ["Agenda", "Only A"],
        )

        # Narrowest valid model-level re-association (no public edit-
        # series API in this slice).
        recurrence.series = template_b
        recurrence.save(update_fields=["series"])

        # The already-materialized Meeting is untouched.
        meeting.refresh_from_db()
        self.assertEqual(meeting.series, template_a)
        self.assertEqual(
            [s.name for s in meeting.meeting_sections.order_by("position")],
            ["Agenda", "Only A"],
        )

    def test_future_materialization_uses_the_new_template_association(self):
        template_a = self._create_series(title="Template A")
        create_series_section(
            meeting_series=template_a, actor=self.alex, name="Only A",
        )
        template_b = self._create_series(title="Template B")
        create_series_section(
            meeting_series=template_b, actor=self.alex, name="Only B",
        )
        recurrence = self._create_recurrence(meeting_series=template_a)

        self._materialize(recurrence, self._first_occurrence(recurrence))
        recurrence.series = template_b
        recurrence.save(update_fields=["series"])

        # A still-virtual occurrence materializes from the NEW template.
        (second,) = self._expand(
            recurrence,
            _utc(2026, 1, 6, 0, 0),
            _utc(2026, 1, 6, 23, 59),
        )
        meeting_b = self._materialize(recurrence, second)
        self.assertEqual(meeting_b.series, template_b)
        self.assertEqual(
            [s.name for s in meeting_b.meeting_sections.order_by("position")],
            ["Agenda", "Only B"],
        )


class MeetingRecurrenceTemplateDeletionTest(MeetingRecurrenceBase):
    """Template deletion preserves the recurrence and its Meetings."""

    def test_template_deletion_preserves_recurrence_and_meetings(self):
        template = self._create_series()
        create_series_section(
            meeting_series=template, actor=self.alex, name="Notes",
        )
        recurrence = self._create_recurrence(meeting_series=template)
        meeting = self._materialize(
            recurrence, self._first_occurrence(recurrence),
        )
        meeting_id = meeting.pk

        delete_meeting_series(meeting_series=template, actor=self.alex)

        # The Template (and its editable sections) is gone.
        self.assertFalse(
            MeetingSeries.objects.filter(pk=template.pk).exists()
        )

        # The recurrence SURVIVES with its reference cleared.
        recurrence.refresh_from_db()
        self.assertIsNone(recurrence.series)
        self.assertEqual(recurrence.title, "Daily Standup")

        # The materialized Meeting is untouched: content preserved,
        # only its provenance pointers cleared (SET_NULL).
        meeting.refresh_from_db()
        self.assertEqual(meeting.pk, meeting_id)
        self.assertIsNone(meeting.series)
        sections = list(meeting.meeting_sections.order_by("position"))
        self.assertEqual([s.name for s in sections], ["Agenda", "Notes"])
        self.assertTrue(all(s.source_series_section is None for s in sections))

    def test_template_deletion_blocks_future_materialization(self):
        template = self._create_series()
        recurrence = self._create_recurrence(meeting_series=template)
        delete_meeting_series(meeting_series=template, actor=self.alex)

        with self.assertRaises(MeetingDomainError):
            self._materialize(recurrence, self._first_occurrence(recurrence))
        self.assertEqual(Meeting.objects.count(), 0)


class MeetingRecurrenceLegacyTemplateTest(MeetingRecurrenceBase):
    """Legacy template-less recurrences (series IS NULL) survive the
    linkage: everything that needs no content source keeps working,
    and new virtual materialization is an explicit domain error."""

    def _legacy_recurrence(self, **overrides):
        """A recurrence row in its PRE-linkage shape (no template).

        Created directly at the model level because the domain creation
        service now requires a template — exactly the shape a migrated
        historical row has.
        """
        params = dict(
            research_group=self.group,
            scope="group",
            project=None,
            title="Legacy Standup",
            frequency="daily",
            interval=1,
            weekdays=[],
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
            created_by=self.alex,
        )
        params.update(overrides)
        return MeetingRecurrence.objects.create(**params)

    def _legacy_materialized_meeting(self, recurrence, day):
        """A materialized Meeting in its pre-linkage shape (no series)."""
        original = datetime(2026, 1, day, 9, 30, tzinfo=BERLIN)
        meeting = Meeting.objects.create(
            research_group=self.group,
            scope="group",
            recurrence=recurrence,
            original_scheduled_at=original,
            title=f"Legacy Meeting {day}",
            scheduled_at=original,
            created_by=self.alex,
        )
        MeetingSection.objects.create(
            meeting=meeting,
            name="Agenda",
            description="",
            position=0,
            is_visible=True,
        )
        return meeting

    def _occurrence_on(self, recurrence, day):
        (occurrence,) = self._expand(
            recurrence,
            _utc(2026, 1, day, 0, 0),
            _utc(2026, 1, day, 23, 59),
        )
        return occurrence

    def test_legacy_recurrence_without_template_survives(self):
        recurrence = self._legacy_recurrence()
        recurrence.refresh_from_db()
        self.assertIsNone(recurrence.series)
        # Reads keep working: the rule expands normally.
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 8, 0, 0),
        )
        self.assertEqual(len(occurrences), 3)

    def test_migration_does_not_invent_a_template(self):
        import importlib

        m19 = importlib.import_module(
            "meetings.migrations.0019_meetingrecurrence_series"
        )
        # The migration is a pure nullable column addition: no data
        # step exists that could fabricate or guess a Template.
        for operation in m19.Migration.operations:
            self.assertNotIsInstance(
                operation, (migrations.RunPython, migrations.RunSQL),
            )
        add_field = m19.Migration.operations[0]
        self.assertTrue(add_field.field.null)

        # A legacy row keeps its NULL reference and no Template is
        # created for it.
        self._legacy_recurrence()
        self.assertEqual(MeetingSeries.objects.count(), 0)

    def test_legacy_materialized_meeting_is_readable_and_usable(self):
        recurrence = self._legacy_recurrence()
        meeting = self._legacy_materialized_meeting(recurrence, day=5)

        # Readable through the canonical materialization mapping.
        occurrence = self._occurrence_on(recurrence, day=5)
        self.assertEqual(occurrence.original_start,
                         meeting.original_scheduled_at)
        # Usable: ordinary Meeting editing works.
        update_meeting(
            meeting=meeting, actor=self.alex, title="Edited Legacy",
        )
        self.assertEqual(
            Meeting.objects.get(pk=meeting.pk).title, "Edited Legacy",
        )

    def test_legacy_materialized_meeting_can_be_cancelled(self):
        recurrence = self._legacy_recurrence()
        meeting = self._legacy_materialized_meeting(recurrence, day=6)

        cancelled = cancel_meeting_recurrence_occurrence(
            meeting=meeting, actor=self.alex,
        )
        self.assertEqual(cancelled.status, Meeting.Status.CANCELLED)
        # The row, title, and content are preserved.
        self.assertEqual(cancelled.title, "Legacy Meeting 6")
        self.assertEqual(cancelled.meeting_sections.count(), 1)

    def test_legacy_materialized_meeting_can_be_rescheduled(self):
        recurrence = self._legacy_recurrence()
        meeting = self._legacy_materialized_meeting(recurrence, day=6)
        moved = _utc(2026, 1, 8, 11, 0)

        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=self._occurrence_on(recurrence, day=6),
            scheduled_at=moved,
            actor=self.alex,
            title="Legacy Standup",
        )
        meeting.refresh_from_db()
        self.assertEqual(meeting.scheduled_at, moved)
        # A reschedule never renames an existing Meeting.
        self.assertEqual(meeting.title, "Legacy Meeting 6")

    def test_legacy_virtual_occurrence_exclusion_remains_valid(self):
        recurrence = self._legacy_recurrence()
        occurrence = self._occurrence_on(recurrence, day=7)
        # Exclusion is virtual-occurrence state only: no template
        # needed.
        exclude_meeting_recurrence_occurrence(
            recurrence=recurrence, occurrence=occurrence, actor=self.alex,
        )
        # The exclusion persists and the rule is untouched; nothing
        # was materialized.
        self.assertTrue(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
                original_scheduled_at=occurrence.original_start,
            ).exists()
        )
        self.assertEqual(Meeting.objects.count(), 0)

    def test_legacy_virtual_occurrence_materialization_is_rejected(self):
        recurrence = self._legacy_recurrence()
        occurrence = self._occurrence_on(recurrence, day=5)
        with self.assertRaises(MeetingDomainError):
            self._materialize(recurrence, occurrence)
        self.assertEqual(Meeting.objects.count(), 0)
        # The rule is untouched and the occurrence stays virtual.
        self.assertEqual(len(self._expand(
            recurrence, _utc(2026, 1, 5, 0, 0), _utc(2026, 1, 5, 23, 59),
        )), 1)

    def test_legacy_materialized_replay_still_works(self):
        recurrence = self._legacy_recurrence()
        meeting = self._legacy_materialized_meeting(recurrence, day=5)
        occurrence = self._occurrence_on(recurrence, day=5)
        # Replaying an already-materialized occurrence returns the
        # existing Meeting — template or not.
        again = materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.alex,
        )
        self.assertEqual(again.pk, meeting.pk)
        self.assertEqual(Meeting.objects.count(), 1)
