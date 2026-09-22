"""Tests for persistent single-occurrence exclusion of a virtual
recurrence occurrence (domain layer; no HTTP write API in this slice).

Excluding an occurrence persists exactly one ``MeetingRecurrenceExclusion``
row keyed by (recurrence, immutable original scheduled start) and removes
the occurrence from the recurrence's EFFECTIVE occurrence set without
materializing a Meeting, mutating the rule, or generating any replacement
occurrence.
"""

import threading
import time as time_module
from dataclasses import replace
from datetime import date, datetime, time
from zoneinfo import ZoneInfo
from uuid import uuid4

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model
from django.db import IntegrityError, connection as db_connection, transaction
from django.test import TransactionTestCase

from projects.models import ProjectMembership
from projects.services import (
    add_project_membership,
    archive_project,
    create_project,
)
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import (
    Meeting,
    MeetingParticipant,
    MeetingRecurrence,
    MeetingRecurrenceExclusion,
    MeetingSection,
)
from .recurrence import (
    MeetingRecurrenceOccurrence,
    derive_occurrence_identity,
)
from .services import (
    MeetingDomainError,
    MeetingAuditEventType,
    create_meeting_recurrence,
    exclude_meeting_recurrence_occurrence,
    expand_meeting_recurrence_occurrences,
    expand_effective_meeting_recurrence_occurrences,
    materialize_meeting_recurrence_occurrence,
    reschedule_meeting_recurrence_occurrence,
)
from .tests_recurrence import MeetingRecurrenceBase, _utc

User = get_user_model()
BERLIN = ZoneInfo("Europe/Berlin")


class MeetingRecurrenceExclusionBase(MeetingRecurrenceBase):
    """Shared helpers for virtual-occurrence exclusion tests."""

    def _expand_effective(self, recurrence, start, end):
        return expand_effective_meeting_recurrence_occurrences(
            meeting_recurrence=recurrence,
            range_start=start,
            range_end=end,
        )

    def _exclude(self, recurrence, occurrence, *, actor=None):
        return exclude_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=actor if actor is not None else self.alex,
        )

    def _occurrence_on(self, recurrence, day, hour=9, minute=30):
        """The rule-produced occurrence whose local date is ``day``."""
        (occurrence,) = self._expand(
            recurrence,
            _utc(*day),
            _utc(day[0], day[1], day[2], 23, 59),
        )
        self.assertEqual(occurrence.original_local.hour, hour)
        self.assertEqual(occurrence.original_local.minute, minute)
        return occurrence

    def _synthetic_occurrence(self, recurrence, original_local):
        """A well-formed occurrence VALUE for a date/time of our choice.

        The identity is the canonical one derived for this recurrence, so
        identity checks pass and rule membership (not identity) decides.
        """
        return MeetingRecurrenceOccurrence(
            occurrence_id=derive_occurrence_identity(
                recurrence_id=recurrence.pk,
                original_local=original_local,
                timezone_name=recurrence.timezone_name,
            ),
            original_local=original_local,
            original_start=original_local.replace(tzinfo=BERLIN),
        )


class MeetingRecurrenceExclusionTest(MeetingRecurrenceExclusionBase):
    """Virtual-occurrence exclusion (domain layer)."""

    # 1. A valid virtual occurrence can be excluded.

    def test_valid_virtual_occurrence_can_be_excluded(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        exclusion = self._exclude(recurrence, occurrence)

        self.assertIsInstance(exclusion, MeetingRecurrenceExclusion)
        self.assertIsNotNone(exclusion.pk)
        self.assertEqual(exclusion.recurrence_id, recurrence.pk)
        self.assertEqual(exclusion.original_scheduled_at, occurrence.original_start)
        self.assertEqual(exclusion.created_by_id, self.alex.pk)
        self.assertIsNotNone(exclusion.created_at)

    # 2. Exactly one exclusion row is persisted.

    def test_exactly_one_exclusion_row_is_persisted(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        self._exclude(recurrence, occurrence)

        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.filter(
                recurrence=recurrence,
                original_scheduled_at=occurrence.original_start,
            ).count(),
            1,
        )

    # 3-6. Exclusion creates nothing besides the exclusion row.

    def test_exclusion_creates_no_meeting(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        self._exclude(recurrence, occurrence)

        self.assertEqual(Meeting.objects.count(), 0)

    def test_exclusion_creates_no_sections(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        self._exclude(recurrence, occurrence)

        self.assertEqual(MeetingSection.objects.count(), 0)

    def test_exclusion_creates_no_participants(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        self._exclude(recurrence, occurrence)

        self.assertEqual(MeetingParticipant.objects.count(), 0)

    def test_exclusion_creates_no_audit_event(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        self._exclude(recurrence, occurrence)

        self.assertEqual(AuditEvent.objects.count(), 0)
        self.assertEqual(
            AuditEvent.objects.filter(
                research_group=self.group,
                event_type="meeting.created",
            ).count(),
            0,
        )

    # 7. Re-excluding the same occurrence is idempotent.

    def test_re_excluding_the_same_occurrence_is_idempotent(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        first = self._exclude(recurrence, occurrence)
        second = self._exclude(recurrence, occurrence)

        self.assertEqual(first.pk, second.pk)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        # A different authorized actor re-excluding stays one row too.
        third = self._exclude(recurrence, occurrence, actor=self.chris)
        self.assertEqual(first.pk, third.pk)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(Meeting.objects.count(), 0)

    # 8. The database constraint stops duplicates even when the service
    #    level protection is bypassed.

    def test_db_unique_constraint_prevents_duplicate_exclusions(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        self._exclude(recurrence, occurrence)

        with self.assertRaises(IntegrityError), transaction.atomic():
            MeetingRecurrenceExclusion.objects.create(
                recurrence=recurrence,
                original_scheduled_at=occurrence.original_start,
                created_by=self.chris,
            )
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)

    # 9-12. Effective expansion semantics.

    def test_excluding_b_leaves_siblings_a_and_c_unchanged(self):
        recurrence = self._create_recurrence()
        a = self._occurrence_on(recurrence, (2026, 1, 5))
        b = self._occurrence_on(recurrence, (2026, 1, 6))
        c = self._occurrence_on(recurrence, (2026, 1, 7))

        self._exclude(recurrence, b)

        effective = self._expand_effective(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 7, 23, 59),
        )
        self.assertEqual(
            [item.occurrence_id for item in effective],
            [a.occurrence_id, c.occurrence_id],
        )
        self.assertEqual(
            [item.original_start for item in effective],
            [a.original_start, c.original_start],
        )

    def test_parent_recurrence_is_unchanged(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        before = (
            recurrence.pk,
            recurrence.research_group_id,
            recurrence.scope,
            recurrence.project_id,
            recurrence.frequency,
            recurrence.interval,
            tuple(recurrence.weekdays),
            recurrence.start_date,
            recurrence.local_time,
            recurrence.timezone_name,
            recurrence.end_mode,
            recurrence.end_date,
            recurrence.occurrence_count,
        )

        self._exclude(recurrence, occurrence)

        recurrence.refresh_from_db()
        after = (
            recurrence.pk,
            recurrence.research_group_id,
            recurrence.scope,
            recurrence.project_id,
            recurrence.frequency,
            recurrence.interval,
            tuple(recurrence.weekdays),
            recurrence.start_date,
            recurrence.local_time,
            recurrence.timezone_name,
            recurrence.end_mode,
            recurrence.end_date,
            recurrence.occurrence_count,
        )
        self.assertEqual(before, after)

    def test_raw_recurrence_rule_semantics_remain_unchanged(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        self._exclude(recurrence, occurrence)

        # The RAW expansion still produces the full series.
        raw = self._expand(recurrence, _utc(2026, 1, 5), _utc(2026, 1, 7, 23, 59))
        self.assertEqual(len(raw), 3)
        # The EFFECTIVE set drops only the excluded occurrence.
        effective = self._expand_effective(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 7, 23, 59),
        )
        self.assertEqual(len(effective), 2)
        self.assertEqual(
            [item.occurrence_id for item in effective],
            [raw[0].occurrence_id, raw[2].occurrence_id],
        )

    # COUNT regression pin: daily COUNT = 3, exclude day 2 -> days 1 + 3,
    # NEVER day 4.

    def test_count_limited_exclusion_does_not_generate_replacement(self):
        recurrence = self._create_recurrence(
            end_mode="count", occurrence_count=3,
        )
        day1 = self._occurrence_on(recurrence, (2026, 1, 5))
        day2 = self._occurrence_on(recurrence, (2026, 1, 6))
        day3 = self._occurrence_on(recurrence, (2026, 1, 7))

        self._exclude(recurrence, day2)

        effective = self._expand_effective(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 9, 23, 59),
        )
        self.assertEqual(
            [item.original_local for item in effective],
            [day1.original_local, day3.original_local],
        )
        # No replacement: day 4 (Jan 8) must NOT appear.
        self.assertNotIn(
            datetime(2026, 1, 8, 9, 30),
            [item.original_local for item in effective],
        )
        # The raw rule still knows all three occurrences.
        raw = self._expand(recurrence, _utc(2026, 1, 5), _utc(2026, 1, 9, 23, 59))
        self.assertEqual(len(raw), 3)

    def test_end_date_limited_exclusion_does_not_extend(self):
        recurrence = self._create_recurrence(
            end_mode="end_date", end_date=date(2026, 1, 7),
        )
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        self._exclude(recurrence, occurrence)

        effective = self._expand_effective(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 9, 23, 59),
        )
        self.assertEqual(
            [item.original_local for item in effective],
            [datetime(2026, 1, 5, 9, 30), datetime(2026, 1, 7, 9, 30)],
        )

    def test_excluding_every_occurrence_yields_empty_effective_set(self):
        recurrence = self._create_recurrence(
            end_mode="count", occurrence_count=2,
        )
        for day in ((2026, 1, 5), (2026, 1, 6)):
            self._exclude(recurrence, self._occurrence_on(recurrence, day))

        effective = self._expand_effective(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 7, 23, 59),
        )
        self.assertEqual(effective, [])

    def test_exclusion_is_independent_of_scheduled_moves_of_siblings(self):
        recurrence = self._create_recurrence()
        a = self._occurrence_on(recurrence, (2026, 1, 5))
        c = self._occurrence_on(recurrence, (2026, 1, 7))

        # Move sibling C (materialize it + reschedule it away).
        reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=c,
            scheduled_at=_utc(2026, 2, 1, 12, 0),
            actor=self.alex,
            title="Moved C",
        )
        # Excluding A stays an exclusion of A's ORIGINAL slot.
        self._exclude(recurrence, a)

        effective = self._expand_effective(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 31, 23, 59),
        )
        # A is gone; C stays at its ORIGINAL slot (the read set never
        # re-places an occurrence at its moved scheduled_at).
        self.assertNotIn(a.occurrence_id, [o.occurrence_id for o in effective])
        self.assertIn(c.occurrence_id, [o.occurrence_id for o in effective])
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.first().original_scheduled_at,
            a.original_start,
        )

    # 17. Different recurrences with an occurrence at the same timestamp
    #     do not share exclusions.

    def test_same_timestamp_different_recurrences_stay_independent(self):
        a = self._create_recurrence()
        b = self._create_recurrence()
        occ_a = self._occurrence_on(a, (2026, 1, 6))
        occ_b = self._occurrence_on(b, (2026, 1, 6))
        self.assertEqual(occ_a.original_start, occ_b.original_start)
        # ... yet the stable identities differ per schedule.
        self.assertNotEqual(occ_a.occurrence_id, occ_b.occurrence_id)

        self._exclude(a, occ_a)

        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        effective_b = self._expand_effective(
            b, _utc(2026, 1, 5), _utc(2026, 1, 7, 23, 59),
        )
        self.assertEqual(len(effective_b), 3)

    # Validation: the candidate must be a genuine occurrence of the
    # recurrence.

    def test_forged_occurrence_identity_is_rejected(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        forged = replace(occurrence, occurrence_id=uuid4())

        with self.assertRaises(MeetingDomainError):
            self._exclude(recurrence, forged)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    def test_occurrence_from_another_recurrence_is_rejected(self):
        a = self._create_recurrence()
        b = self._create_recurrence()
        foreign = self._occurrence_on(b, (2026, 1, 6))

        with self.assertRaises(MeetingDomainError):
            self._exclude(a, foreign)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    def test_off_rule_original_timestamp_is_rejected(self):
        recurrence = self._create_recurrence()  # daily at 09:30 Berlin
        fake = self._synthetic_occurrence(
            recurrence, datetime(2026, 1, 6, 10, 0),
        )

        with self.assertRaises(MeetingDomainError):
            self._exclude(recurrence, fake)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    def test_occurrence_before_the_recurrence_start_is_rejected(self):
        recurrence = self._create_recurrence()  # first occurrence Jan 5
        fake = self._synthetic_occurrence(
            recurrence, datetime(2026, 1, 4, 9, 30),
        )

        with self.assertRaises(MeetingDomainError):
            self._exclude(recurrence, fake)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    def test_occurrence_beyond_the_count_contract_is_rejected(self):
        recurrence = self._create_recurrence(
            end_mode="count", occurrence_count=3,
        )
        fake = self._synthetic_occurrence(
            recurrence, datetime(2026, 1, 8, 9, 30),
        )

        with self.assertRaises(MeetingDomainError):
            self._exclude(recurrence, fake)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    def test_occurrence_beyond_the_end_date_contract_is_rejected(self):
        recurrence = self._create_recurrence(
            end_mode="end_date", end_date=date(2026, 1, 6),
        )
        fake = self._synthetic_occurrence(
            recurrence, datetime(2026, 1, 7, 9, 30),
        )

        with self.assertRaises(MeetingDomainError):
            self._exclude(recurrence, fake)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    def test_unsaved_recurrence_cannot_be_excluded(self):
        recurrence = MeetingRecurrence(
            research_group=self.group,
            scope="group",
            frequency="daily",
            interval=1,
            weekdays=[],
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
            end_mode="no_end",
            created_by=self.alex,
        )
        # The pk check runs before occurrence validation, so any
        # occurrence value suffices; the rejection must come from the
        # missing schedule id.
        placeholder = MeetingRecurrenceOccurrence(
            occurrence_id=uuid4(),
            original_local=datetime(2026, 1, 5, 9, 30),
            original_start=datetime(2026, 1, 5, 9, 30, tzinfo=BERLIN),
        )
        with self.assertRaises(MeetingDomainError):
            self._exclude(
                recurrence,
                placeholder,
            )
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    # Authorization: the canonical scoped Meeting write rule.

    def test_group_outsider_cannot_exclude(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        with self.assertRaises(MeetingDomainError):
            self._exclude(recurrence, occurrence, actor=self.maria)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    def test_group_member_can_exclude(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        exclusion = self._exclude(recurrence, occurrence, actor=self.chris)

        self.assertEqual(exclusion.created_by_id, self.chris.pk)

    def test_project_viewer_cannot_exclude_project_occurrence(self):
        project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Exclusion Viewer Project",
        )
        add_project_membership(
            project=project,
            actor=self.alex,
            target_user=self.laura,
            role=ProjectMembership.Role.VIEWER,
        )
        recurrence = self._create_recurrence(
            scope=MeetingRecurrence.Scope.PROJECT, project=project,
        )
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        # The viewer can read the recurrence but must not exclude.
        with self.assertRaises(MeetingDomainError):
            self._exclude(recurrence, occurrence, actor=self.laura)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    def test_project_owner_and_member_can_exclude_project_occurrence(self):
        project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Exclusion Project",
        )
        add_project_membership(
            project=project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        recurrence = self._create_recurrence(
            scope=MeetingRecurrence.Scope.PROJECT, project=project,
        )
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        owner_exclusion = self._exclude(recurrence, occurrence, actor=self.alex)
        member_occurrence = self._occurrence_on(recurrence, (2026, 1, 7))
        member_exclusion = self._exclude(
            recurrence, member_occurrence, actor=self.chris,
        )

        self.assertEqual(owner_exclusion.created_by_id, self.alex.pk)
        self.assertEqual(member_exclusion.created_by_id, self.chris.pk)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 2)

    def test_exclusion_rejected_for_archived_project(self):
        project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Exclusion Archived Project",
        )
        add_project_membership(
            project=project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        recurrence = self._create_recurrence(
            scope=MeetingRecurrence.Scope.PROJECT, project=project,
        )
        archive_project(project=project, actor=self.alex)
        # Re-load the recurrence as a real request would: the creation
        # return value still caches the pre-archive Project instance.
        recurrence = MeetingRecurrence.objects.get(pk=recurrence.pk)
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))

        with self.assertRaises(MeetingDomainError):
            self._exclude(recurrence, occurrence, actor=self.chris)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)

    # Materialized-occurrence boundary.

    def test_excluding_an_already_materialized_occurrence_is_rejected(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        meeting = materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.alex,
            title="Concrete",
        )

        with self.assertRaises(MeetingDomainError):
            self._exclude(recurrence, occurrence)

        # No exclusion persisted and the Meeting is completely unchanged.
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)
        self.assertEqual(Meeting.objects.count(), 1)
        meeting.refresh_from_db()
        self.assertEqual(meeting.title, "Concrete")
        self.assertEqual(meeting.scheduled_at, occurrence.original_start)
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=meeting, event_type="meeting.created",
            ).count(),
            1,
        )

    def test_virtual_siblings_excludable_alongside_materialized_sibling(self):
        recurrence = self._create_recurrence()
        materialized = self._occurrence_on(recurrence, (2026, 1, 6))
        materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=materialized,
            actor=self.alex,
            title="Concrete",
        )
        virtual = self._occurrence_on(recurrence, (2026, 1, 7))

        exclusion = self._exclude(recurrence, virtual)

        self.assertEqual(exclusion.original_scheduled_at, virtual.original_start)
        effective = self._expand_effective(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 8, 23, 59),
        )
        # Jan 5 + Jan 6 (materialized, still in the effective set) +
        # Jan 8; only Jan 7 is excluded.
        self.assertEqual(
            [item.original_local for item in effective],
            [
                datetime(2026, 1, 5, 9, 30),
                datetime(2026, 1, 6, 9, 30),
                datetime(2026, 1, 8, 9, 30),
            ],
        )


class MeetingRecurrenceExcludedWritePathsTest(MeetingRecurrenceExclusionBase):
    """An excluded virtual occurrence is not materializable or
    reschedulable: the exclusion gates the canonical write paths,
    while raw occurrence validation (and thus idempotent re-
    exclusion) is unchanged.
    """

    # 1. Direct domain materialization of an excluded occurrence is
    #    rejected and persists nothing.

    def test_materializing_excluded_occurrence_is_rejected(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        self._exclude(recurrence, occurrence)

        with self.assertRaises(MeetingDomainError):
            materialize_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=occurrence,
                actor=self.alex,
                title="Should not exist",
            )
        self.assertEqual(Meeting.objects.count(), 0)

    def test_materializing_excluded_occurrence_creates_nothing(
        self,
    ):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        exclusion = self._exclude(recurrence, occurrence)

        with self.assertRaises(MeetingDomainError):
            materialize_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=occurrence,
                actor=self.alex,
                title="Should not exist",
            )

        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingSection.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)
        self.assertEqual(
            AuditEvent.objects.filter(
                research_group=self.group,
                event_type="meeting.created",
            ).count(),
            0,
        )
        # The exclusion itself is untouched.
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.get().pk, exclusion.pk,
        )

    # 2. Virtual reschedule of an excluded occurrence is rejected and
    #    creates no Meeting or audit events (it would first
    #    materialize through the canonical path, which is gated).

    def test_rescheduling_excluded_virtual_occurrence_is_rejected(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        exclusion = self._exclude(recurrence, occurrence)

        with self.assertRaises(MeetingDomainError):
            reschedule_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=occurrence,
                scheduled_at=_utc(2026, 1, 9, 14, 0),
                actor=self.alex,
                title="Should not exist",
            )

        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingSection.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.CREATED,
            ).count(),
            0,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.RESCHEDULED,
            ).count(),
            0,
        )
        # The exclusion was not removed by the attempt.
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(
            MeetingRecurrenceExclusion.objects.get().pk, exclusion.pk,
        )

    # 3. Non-excluded occurrences and other recurrences are unaffected.

    def test_sibling_non_excluded_occurrence_still_materializes(self):
        recurrence = self._create_recurrence()
        excluded = self._occurrence_on(recurrence, (2026, 1, 6))
        sibling = self._occurrence_on(recurrence, (2026, 1, 7))
        self._exclude(recurrence, excluded)

        meeting = materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=sibling,
            actor=self.alex,
            title="Sibling",
        )

        self.assertEqual(meeting.original_scheduled_at, sibling.original_start)
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)

    def test_different_recurrence_same_timestamp_unaffected(self):
        a = self._create_recurrence()
        b = self._create_recurrence()
        occ_a = self._occurrence_on(a, (2026, 1, 6))
        occ_b = self._occurrence_on(b, (2026, 1, 6))
        self.assertEqual(occ_a.original_start, occ_b.original_start)
        self._exclude(a, occ_a)

        meeting = materialize_meeting_recurrence_occurrence(
            recurrence=b,
            occurrence=occ_b,
            actor=self.alex,
            title="Foreign recurrence",
        )

        self.assertEqual(meeting.recurrence_id, b.pk)
        self.assertEqual(Meeting.objects.count(), 1)

    # 4. Re-exclusion stays idempotent, also after a rejected write
    #    attempt (raw rule membership is still the validation basis).

    def test_re_exclusion_idempotent_after_rejected_materialization(self):
        recurrence = self._create_recurrence()
        occurrence = self._occurrence_on(recurrence, (2026, 1, 6))
        first = self._exclude(recurrence, occurrence)

        with self.assertRaises(MeetingDomainError):
            materialize_meeting_recurrence_occurrence(
                recurrence=recurrence,
                occurrence=occurrence,
                actor=self.alex,
                title="Should not exist",
            )

        second = self._exclude(recurrence, occurrence)
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(Meeting.objects.count(), 0)


class MeetingRecurrenceExclusionConcurrencyTest(TransactionTestCase):
    """Concurrent exclusion of one occurrence (real PostgreSQL).

    Same repository concurrency harness as materialization: threaded
    service calls, a barrier to align the racers, and the unique
    ``(recurrence, original_scheduled_at)`` constraint as the last line
    of defense — exactly one exclusion row may survive.
    """

    def setUp(self):
        self.alex = User.objects.create_user(
            username="excrace-alex", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Exclusion Race Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.recurrence = create_meeting_recurrence(
            research_group=self.group,
            actor=self.alex,
            title="Race",
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
        )
        (self.occurrence,) = expand_meeting_recurrence_occurrences(
            meeting_recurrence=self.recurrence,
            range_start=_utc(2026, 1, 5),
            range_end=_utc(2026, 1, 6),
        )

    def _exclude_in_thread(self, name, results, errors, barrier):
        def worker():
            barrier.wait()
            try:
                results[name] = exclude_meeting_recurrence_occurrence(
                    recurrence=self.recurrence,
                    occurrence=self.occurrence,
                    actor=self.alex,
                )
            except Exception as exc:
                errors[name] = exc
            finally:
                db_connection.close()

        return worker

    def test_concurrent_exclusion_creates_exactly_one_row(self):
        results, errors = {}, {}
        barrier = threading.Barrier(2)
        threads = [
            threading.Thread(
                target=self._exclude_in_thread(name, results, errors, barrier),
            )
            for name in ("a", "b")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, {})
        self.assertEqual(results["a"].pk, results["b"].pk)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_materialize_rejects_when_concurrent_exclusion_wins(self):
        """Deterministic cross-service race: a concurrent exclusion
        holds the recurrence row lock until after the materialization
        reaches its own lock, so the materialization must see the
        exclusion and be rejected — the final state never carries both
        a concrete Meeting and an exclusion for the same occurrence.
        """
        winner_locked = threading.Event()
        release_winner = threading.Event()

        def winner():
            # A concurrent exclusion that bypasses the service (the
            # other racer's in-flight transaction), serialized on the
            # same recurrence row lock.
            with transaction.atomic():
                MeetingRecurrence.objects.select_for_update().get(
                    pk=self.recurrence.pk,
                )
                winner_locked.set()
                MeetingRecurrenceExclusion.objects.create(
                    recurrence=self.recurrence,
                    original_scheduled_at=self.occurrence.original_start,
                    created_by=self.alex,
                )
                release_winner.wait(timeout=30)
            db_connection.close()

        loser_result = {}
        loser_errors = {}

        def loser():
            try:
                loser_result["meeting"] = (
                    materialize_meeting_recurrence_occurrence(
                        recurrence=self.recurrence,
                        occurrence=self.occurrence,
                        actor=self.alex,
                        title="Loser",
                    )
                )
            except Exception as exc:
                loser_errors["error"] = exc
            finally:
                db_connection.close()

        winner_thread = threading.Thread(target=winner)
        winner_thread.start()
        self.assertTrue(winner_locked.wait(timeout=30))

        loser_thread = threading.Thread(target=loser)
        loser_thread.start()
        # Give the loser time to reach the recurrence lock while the
        # winner's transaction is still open.
        time_module.sleep(0.25)
        release_winner.set()
        loser_thread.join()
        winner_thread.join()
        db_connection.close()

        self.assertIn("error", loser_errors)
        self.assertIsInstance(
            loser_errors["error"], MeetingDomainError,
        )
        self.assertNotIn("meeting", loser_result)
        # Only the exclusion survives: no Meeting for the occurrence.
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 1)

    def test_exclusion_rejects_when_concurrent_materialization_wins(self):
        """Deterministic cross-service race, other direction: a
        concurrent materialization holds the recurrence row lock until
        after the exclusion reaches its own lock, so the exclusion must
        see the committed Meeting and be rejected — the final state
        never carries both.
        """
        winner_locked = threading.Event()
        release_winner = threading.Event()

        def winner():
            # A concurrent materialization that bypasses the service,
            # serialized on the same recurrence row lock.
            with transaction.atomic():
                MeetingRecurrence.objects.select_for_update().get(
                    pk=self.recurrence.pk,
                )
                winner_locked.set()
                Meeting.objects.create(
                    research_group=self.group,
                    scope=Meeting.Scope.GROUP,
                    title="Winner",
                    scheduled_at=self.occurrence.original_start,
                    recurrence=self.recurrence,
                    original_scheduled_at=self.occurrence.original_start,
                    status=Meeting.Status.UPCOMING,
                    created_by=self.alex,
                )
                release_winner.wait(timeout=30)
            db_connection.close()

        loser_errors = {}

        def loser():
            try:
                exclude_meeting_recurrence_occurrence(
                    recurrence=self.recurrence,
                    occurrence=self.occurrence,
                    actor=self.alex,
                )
                loser_errors["no_error"] = True
            except Exception as exc:
                loser_errors["error"] = exc
            finally:
                db_connection.close()

        winner_thread = threading.Thread(target=winner)
        winner_thread.start()
        self.assertTrue(winner_locked.wait(timeout=30))

        loser_thread = threading.Thread(target=loser)
        loser_thread.start()
        # Give the loser time to reach the recurrence lock while the
        # winner's transaction is still open.
        time_module.sleep(0.25)
        release_winner.set()
        loser_thread.join()
        winner_thread.join()
        db_connection.close()

        self.assertIn("error", loser_errors)
        self.assertIsInstance(
            loser_errors["error"], MeetingDomainError,
        )
        # Only the Meeting survives: no exclusion for the occurrence.
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(MeetingRecurrenceExclusion.objects.count(), 0)
