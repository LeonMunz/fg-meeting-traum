"""Tests for MeetingRecurrence: V1 recurring-meeting schedules and bounded
occurrence expansion, and occurrence → concrete Meeting materialization
(domain layer; no API/UI in this slice)."""

import threading
import time as time_module
from dataclasses import replace
from datetime import date, datetime, time, timezone as dt_timezone
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model
from django.db import IntegrityError, connection as db_connection, transaction
from django.test import TestCase, TransactionTestCase

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
    MeetingSection,
)
from .recurrence import MeetingRecurrenceOccurrence, derive_occurrence_identity
from .services import (
    MeetingDomainError,
    create_meeting,
    create_meeting_recurrence,
    expand_meeting_recurrence_occurrences,
    materialize_meeting_recurrence_occurrence,
    reschedule_meeting_recurrence_occurrence,
    update_meeting,
)


User = get_user_model()

UTC = dt_timezone.utc
BERLIN = ZoneInfo("Europe/Berlin")
NEW_YORK = ZoneInfo("America/New_York")


def _utc(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


class MeetingRecurrenceBase(TestCase):
    """Shared fixtures: group (alex admin, chris member), project
    (alex owner, chris member, laura viewer), and an outsider (maria)."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="rec-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="rec-chris", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="rec-laura", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="rec-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Recurrence Group", created_by=self.alex,
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
        # laura joins the group so she can resolve project scope,
        # but is only a VIEWER of the project.
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.laura,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Recurrence Project",
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

    def _create_recurrence(self, **overrides):
        params = dict(
            research_group=self.group,
            actor=self.alex,
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 5),
            local_time=time(9, 30),
            timezone_name="Europe/Berlin",
        )
        params.update(overrides)
        return create_meeting_recurrence(**params)

    def _expand(self, recurrence, start, end):
        return expand_meeting_recurrence_occurrences(
            meeting_recurrence=recurrence,
            range_start=start,
            range_end=end,
        )


class MeetingRecurrenceValidationTest(MeetingRecurrenceBase):
    """Creation-time validation of the V1 recurrence language."""

    def test_daily_schedule_persists_rule(self):
        recurrence = self._create_recurrence(
            frequency="daily",
            interval=2,
            end_mode="count",
            occurrence_count=10,
        )

        self.assertEqual(recurrence.frequency, "daily")
        self.assertEqual(recurrence.interval, 2)
        self.assertEqual(recurrence.weekdays, [])
        self.assertEqual(recurrence.start_date, date(2026, 1, 5))
        self.assertEqual(recurrence.local_time, time(9, 30))
        self.assertEqual(recurrence.timezone_name, "Europe/Berlin")
        self.assertEqual(recurrence.end_mode, "count")
        self.assertIsNone(recurrence.end_date)
        self.assertEqual(recurrence.occurrence_count, 10)
        self.assertEqual(recurrence.scope, "group")
        self.assertIsNone(recurrence.project)
        self.assertEqual(recurrence.research_group, self.group)
        self.assertEqual(recurrence.created_by, self.alex)
        # Persistence of a schedule never creates concrete Meetings.
        self.assertEqual(Meeting.objects.count(), 0)

    def test_weekly_schedule_persists_normalized_weekdays(self):
        recurrence = self._create_recurrence(
            frequency="weekly",
            weekdays=[2, 0, 2],
            start_date=date(2026, 1, 5),  # Monday
        )
        self.assertEqual(recurrence.weekdays, [0, 2])

    def test_project_scope_schedule_persists_project(self):
        recurrence = self._create_recurrence(
            scope="project",
            project=self.project,
        )
        self.assertEqual(recurrence.scope, "project")
        self.assertEqual(recurrence.project, self.project)

    def test_end_date_equal_to_start_is_valid(self):
        recurrence = self._create_recurrence(
            end_mode="end_date",
            end_date=date(2026, 1, 5),
        )
        self.assertEqual(recurrence.end_date, date(2026, 1, 5))

    # ── frequency / interval ────────────────────────────────────

    def test_unsupported_frequency_rejected(self):
        for frequency in ("yearly", "FREQ=DAILY", "", "Daily"):
            with self.assertRaises(MeetingDomainError):
                self._create_recurrence(frequency=frequency)

    def test_interval_zero_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(interval=0)

    def test_interval_negative_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(interval=-1)

    # ── weekdays ────────────────────────────────────────────────

    def test_weekly_without_weekdays_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(frequency="weekly", weekdays=[])
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(frequency="weekly")

    def test_weekly_invalid_weekday_values_rejected(self):
        for weekdays in ([7], [0, 9], [-1], [1.5], ["monday"], {0, "x"}):
            with self.assertRaises(MeetingDomainError):
                self._create_recurrence(frequency="weekly", weekdays=weekdays)

    def test_weekly_weekdays_must_be_iterable(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(frequency="weekly", weekdays="monday")

    def test_weekly_start_weekday_not_in_pattern_rejected(self):
        # 2026-01-05 is a Monday; the pattern selects only Wednesdays.
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                frequency="weekly",
                weekdays=[2],
                start_date=date(2026, 1, 5),
            )

    def test_non_weekly_with_weekdays_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(frequency="daily", weekdays=[1])
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(frequency="monthly", weekdays=[1])

    # ── timezone ────────────────────────────────────────────────

    def test_invalid_timezone_rejected(self):
        for name in ("Not/AZone", "UTC+2", "", "   ", None, 42):
            with self.assertRaises(MeetingDomainError):
                self._create_recurrence(timezone_name=name)

    def test_valid_iana_timezone_accepted(self):
        for name in ("Europe/Berlin", "America/New_York", "Asia/Tokyo", "UTC"):
            recurrence = self._create_recurrence(timezone_name=name)
            self.assertEqual(recurrence.timezone_name, name)

    # ── end mode / count / end date ─────────────────────────────

    def test_count_zero_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                end_mode="count", occurrence_count=0,
            )

    def test_count_negative_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                end_mode="count", occurrence_count=-3,
            )

    def test_count_and_end_date_mutually_exclusive(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                end_mode="count",
                occurrence_count=5,
                end_date=date(2026, 2, 1),
            )
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                end_mode="end_date",
                end_date=date(2026, 2, 1),
                occurrence_count=5,
            )

    def test_end_date_before_start_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                end_mode="end_date",
                end_date=date(2026, 1, 4),
            )

    def test_end_mode_incompatible_fields_rejected(self):
        # no_end mode must not carry either limiter.
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(end_date=date(2026, 2, 1))
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(occurrence_count=5)
        # end_date mode requires the end date.
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(end_mode="end_date")
        # count mode requires the count.
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(end_mode="count")

    # ── scope / authorization ───────────────────────────────────

    def test_group_scope_with_project_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                scope="group", project=self.project,
            )

    def test_project_scope_requires_project(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(scope="project")

    def test_project_outside_group_rejected(self):
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
            self._create_recurrence(
                scope="project", project=other_project,
            )

    def test_non_group_member_cannot_create(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(actor=self.maria)

    def test_group_member_can_create(self):
        recurrence = self._create_recurrence(actor=self.chris)
        self.assertEqual(recurrence.created_by, self.chris)

    def test_project_viewer_cannot_create_project_scope_schedule(self):
        with self.assertRaises(MeetingDomainError):
            self._create_recurrence(
                scope="project", project=self.project, actor=self.laura,
            )


class MeetingRecurrenceExpansionTest(MeetingRecurrenceBase):
    """Bounded occurrence expansion behavior."""

    # ── daily ───────────────────────────────────────────────────

    def test_daily_interval_1(self):
        recurrence = self._create_recurrence(
            frequency="daily", interval=1,
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 1, 12),
        )
        # Window in Berlin wall-clock: Jan 1 01:00 .. Jan 12 01:00.
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, day) for day in range(5, 12)],
        )
        for occurrence in occurrences:
            self.assertEqual(occurrence.local_time, time(9, 30))

    def test_daily_interval_3(self):
        recurrence = self._create_recurrence(
            frequency="daily", interval=3,
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 1, 12),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, 5), date(2026, 1, 8), date(2026, 1, 11)],
        )

    # ── weekly ──────────────────────────────────────────────────

    def test_weekly_single_weekday(self):
        recurrence = self._create_recurrence(
            frequency="weekly",
            interval=1,
            weekdays=[0],
            start_date=date(2026, 1, 5),  # Monday
            local_time=time(10, 0),
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 2, 15),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [
                date(2026, 1, 5), date(2026, 1, 12), date(2026, 1, 19),
                date(2026, 1, 26), date(2026, 2, 2), date(2026, 2, 9),
            ],
        )

    def test_weekly_multiple_weekdays(self):
        recurrence = self._create_recurrence(
            frequency="weekly",
            interval=1,
            weekdays=[0, 2],  # Monday + Wednesday
            start_date=date(2026, 1, 5),  # Monday
            local_time=time(10, 0),
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 2, 1),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [
                date(2026, 1, 5), date(2026, 1, 7), date(2026, 1, 12),
                date(2026, 1, 14), date(2026, 1, 19), date(2026, 1, 21),
                date(2026, 1, 26), date(2026, 1, 28),
            ],
        )

    def test_weekly_interval_2(self):
        recurrence = self._create_recurrence(
            frequency="weekly",
            interval=2,
            weekdays=[0, 2],
            start_date=date(2026, 1, 5),  # Monday
            local_time=time(10, 0),
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 2, 1),
        )
        # Weeks are anchored at the start date: Jan 5 / Jan 19 / ...
        self.assertEqual(
            [o.original_date for o in occurrences],
            [
                date(2026, 1, 5), date(2026, 1, 7),
                date(2026, 1, 19), date(2026, 1, 21),
            ],
        )

    # ── start date / count / end date semantics ─────────────────

    def test_start_date_is_first_occurrence(self):
        recurrence = self._create_recurrence(
            frequency="daily", interval=1,
        )
        # Window starts weeks before the start date.
        occurrences = self._expand(
            recurrence, _utc(2025, 12, 20), _utc(2026, 1, 6),
        )
        self.assertEqual(len(occurrences), 1)
        self.assertEqual(occurrences[0].original_date, date(2026, 1, 5))

    def test_count_includes_first_occurrence(self):
        recurrence = self._create_recurrence(
            frequency="daily",
            interval=1,
            end_mode="count",
            occurrence_count=3,
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 2, 1),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7)],
        )

    def test_count_consumed_by_occurrences_before_window(self):
        recurrence = self._create_recurrence(
            frequency="daily",
            interval=1,
            end_mode="count",
            occurrence_count=3,
        )
        # Window entirely after the three occurrences: empty.
        self.assertEqual(
            self._expand(
                recurrence, _utc(2026, 1, 10), _utc(2026, 1, 20),
            ),
            [],
        )
        # Window covering occurrences 2 and 3 only.
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 6), _utc(2026, 1, 8),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, 6), date(2026, 1, 7)],
        )

    def test_end_date_inclusive(self):
        recurrence = self._create_recurrence(
            frequency="daily",
            interval=1,
            end_mode="end_date",
            end_date=date(2026, 1, 9),
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 1, 31),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, day) for day in range(5, 10)],
        )

    def test_end_date_on_non_occurrence_day(self):
        recurrence = self._create_recurrence(
            frequency="weekly",
            interval=1,
            weekdays=[0],
            start_date=date(2026, 1, 5),  # Monday
            end_mode="end_date",
            end_date=date(2026, 1, 8),  # Thursday — no occurrence that day
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 3, 1),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, 5)],
        )

    # ── monthly ─────────────────────────────────────────────────

    def test_monthly_ordinary_day(self):
        recurrence = self._create_recurrence(
            frequency="monthly",
            interval=1,
            start_date=date(2026, 1, 15),
            local_time=time(14, 0),
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 7, 1),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, month, 15) for month in range(1, 7)],
        )

    def test_monthly_day_31_skips_short_months(self):
        recurrence = self._create_recurrence(
            frequency="monthly",
            interval=1,
            start_date=date(2026, 1, 31),
            local_time=time(9, 0),
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 8, 1),
        )
        # Feb (28), Apr (30), Jun (30) have no 31st: skipped, never
        # shifted to the month end.
        self.assertEqual(
            [o.original_date for o in occurrences],
            [
                date(2026, 1, 31), date(2026, 3, 31),
                date(2026, 5, 31), date(2026, 7, 31),
            ],
        )
        for occurrence in occurrences:
            self.assertEqual(occurrence.original_date.day, 31)

    def test_monthly_day_30_skips_february(self):
        recurrence = self._create_recurrence(
            frequency="monthly",
            interval=1,
            start_date=date(2026, 1, 30),
            local_time=time(9, 0),
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 5, 1),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, 30), date(2026, 3, 30), date(2026, 4, 30)],
        )

    def test_monthly_day_29_skips_february_non_leap_year(self):
        recurrence = self._create_recurrence(
            frequency="monthly",
            interval=1,
            start_date=date(2026, 1, 29),
            local_time=time(9, 0),
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 5, 1),
        )
        # 2026 is not a leap year: February has no 29th.
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, 29), date(2026, 3, 29), date(2026, 4, 29)],
        )

    def test_monthly_interval_2(self):
        recurrence = self._create_recurrence(
            frequency="monthly",
            interval=2,
            start_date=date(2026, 1, 15),
            local_time=time(14, 0),
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 1), _utc(2026, 10, 1),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [
                date(2026, 1, 15), date(2026, 3, 15), date(2026, 5, 15),
                date(2026, 7, 15), date(2026, 9, 15),
            ],
        )

    # ── bounded window contract ─────────────────────────────────

    def test_occurrences_outside_window_not_returned(self):
        recurrence = self._create_recurrence(
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 1),
            local_time=time(10, 0),
        )
        # Window in Berlin wall-clock: Jan 10 07:00 .. Jan 15 07:00.
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 10, 6, 0), _utc(2026, 1, 15, 6, 0),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, day) for day in range(10, 15)],
        )
        self.assertEqual(
            occurrences[0].original_local,
            datetime(2026, 1, 10, 10, 0),
        )
        self.assertEqual(
            occurrences[-1].original_local,
            datetime(2026, 1, 14, 10, 0),
        )

    def test_no_end_rule_is_bounded_by_the_window(self):
        recurrence = self._create_recurrence(
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 1),
            local_time=time(10, 0),
            end_mode="no_end",
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 3, 1), _utc(2026, 3, 3),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 3, 1), date(2026, 3, 2)],
        )

    def test_expansion_requires_bounded_range(self):
        recurrence = self._create_recurrence(frequency="daily")
        window_start = _utc(2026, 1, 1)
        window_end = _utc(2026, 1, 31)

        # No range arguments at all: not possible by API shape.
        with self.assertRaises(TypeError):
            expand_meeting_recurrence_occurrences(
                meeting_recurrence=recurrence,
            )
        with self.assertRaises(TypeError):
            expand_meeting_recurrence_occurrences(
                meeting_recurrence=recurrence,
                range_start=window_start,
            )
        # Explicit None is rejected as well.
        with self.assertRaises(MeetingDomainError):
            expand_meeting_recurrence_occurrences(
                meeting_recurrence=recurrence,
                range_start=None,
                range_end=window_end,
            )
        with self.assertRaises(MeetingDomainError):
            expand_meeting_recurrence_occurrences(
                meeting_recurrence=recurrence,
                range_start=window_start,
                range_end=None,
            )

    def test_expansion_rejects_inverted_range(self):
        recurrence = self._create_recurrence(frequency="daily")
        with self.assertRaises(MeetingDomainError):
            self._expand(
                recurrence, _utc(2026, 1, 31), _utc(2026, 1, 1),
            )

    def test_expansion_rejects_naive_range(self):
        recurrence = self._create_recurrence(frequency="daily")
        with self.assertRaises(MeetingDomainError):
            self._expand(
                recurrence,
                datetime(2026, 1, 1),
                datetime(2026, 1, 31),
            )

    def test_unsaved_recurrence_cannot_be_expanded(self):
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
        with self.assertRaises(MeetingDomainError):
            self._expand(recurrence, _utc(2026, 1, 1), _utc(2026, 1, 31))

    def test_expansion_does_not_create_meeting_rows(self):
        recurrence = self._create_recurrence(
            frequency="daily", interval=1,
        )
        self.assertEqual(Meeting.objects.count(), 0)
        self._expand(recurrence, _utc(2026, 1, 1), _utc(2026, 3, 1))
        self._expand(recurrence, _utc(2026, 1, 1), _utc(2026, 12, 31))
        self.assertEqual(Meeting.objects.count(), 0)


class MeetingRecurrenceTimezoneTest(MeetingRecurrenceBase):
    """DST-correct local wall-clock behavior in the stored timezone."""

    def test_daily_across_spring_forward_keeps_local_time(self):
        # Europe/Berlin switches to CEST on 2026-03-29 (02:00 → 03:00).
        recurrence = self._create_recurrence(
            frequency="daily",
            interval=1,
            start_date=date(2026, 3, 27),
            local_time=time(10, 0),
            timezone_name="Europe/Berlin",
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 3, 27), _utc(2026, 4, 1),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 3, day) for day in range(27, 32)],
        )
        # The configured local clock time is preserved on every day...
        for occurrence in occurrences:
            self.assertEqual(occurrence.local_time, time(10, 0))
            self.assertIsNone(occurrence.original_local.tzinfo)
            self.assertEqual(
                occurrence.original_start.tzinfo, BERLIN,
            )
        # ...while the UTC instant shifts with the offset.
        self.assertEqual(
            occurrences[0].original_start.astimezone(UTC),
            _utc(2026, 3, 27, 9, 0),
        )
        self.assertEqual(
            occurrences[1].original_start.astimezone(UTC),
            _utc(2026, 3, 28, 9, 0),
        )
        self.assertEqual(
            occurrences[2].original_start.astimezone(UTC),
            _utc(2026, 3, 29, 8, 0),
        )

    def test_weekly_across_spring_forward_keeps_local_time(self):
        recurrence = self._create_recurrence(
            frequency="weekly",
            interval=1,
            weekdays=[4],  # Friday
            start_date=date(2026, 3, 27),  # Friday
            local_time=time(10, 0),
            timezone_name="Europe/Berlin",
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 3, 27), _utc(2026, 4, 15),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 3, 27), date(2026, 4, 3), date(2026, 4, 10)],
        )
        for occurrence in occurrences:
            self.assertEqual(occurrence.local_time, time(10, 0))
        self.assertEqual(
            occurrences[0].original_start.astimezone(UTC),
            _utc(2026, 3, 27, 9, 0),
        )
        self.assertEqual(
            occurrences[1].original_start.astimezone(UTC),
            _utc(2026, 4, 3, 8, 0),
        )
        self.assertEqual(
            occurrences[2].original_start.astimezone(UTC),
            _utc(2026, 4, 10, 8, 0),
        )

    def test_daily_across_fall_back_keeps_local_time(self):
        # Europe/Berlin switches back to CET on the last Sunday of
        # October: 2026-10-25 (03:00 CEST → 02:00 CET).
        recurrence = self._create_recurrence(
            frequency="daily",
            interval=1,
            start_date=date(2026, 10, 24),
            local_time=time(10, 0),
            timezone_name="Europe/Berlin",
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 10, 24), _utc(2026, 10, 27),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [
                date(2026, 10, 24), date(2026, 10, 25), date(2026, 10, 26),
            ],
        )
        for occurrence in occurrences:
            self.assertEqual(occurrence.local_time, time(10, 0))
        self.assertEqual(
            occurrences[0].original_start.astimezone(UTC),
            _utc(2026, 10, 24, 8, 0),
        )
        self.assertEqual(
            occurrences[1].original_start.astimezone(UTC),
            _utc(2026, 10, 25, 9, 0),
        )
        self.assertEqual(
            occurrences[2].original_start.astimezone(UTC),
            _utc(2026, 10, 26, 9, 0),
        )

    def test_window_is_converted_to_stored_timezone(self):
        recurrence = self._create_recurrence(
            frequency="daily",
            interval=1,
            start_date=date(2026, 3, 28),
            local_time=time(10, 0),
            timezone_name="Europe/Berlin",
        )
        # UTC window [Mar 28 08:00Z, Mar 29 09:00Z] is, in Berlin
        # wall-clock, [Mar 28 09:00 CET, Mar 29 11:00 CEST]: both 10:00
        # occurrences are inside (inclusive bounds).
        occurrences = self._expand(
            recurrence, _utc(2026, 3, 28, 8, 0), _utc(2026, 3, 29, 9, 0),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 3, 28), date(2026, 3, 29)],
        )
        # A narrower UTC window [Mar 29 07:00Z, 07:30Z] is
        # [Mar 29 09:00, 09:30] in Berlin wall-clock (CEST) and excludes
        # the Mar 29 10:00 occurrence.
        self.assertEqual(
            self._expand(
                recurrence, _utc(2026, 3, 29, 7, 0), _utc(2026, 3, 29, 7, 30),
            ),
            [],
        )

    def test_non_german_timezone_keeps_local_time(self):
        # America/New_York switches from EST to EDT on 2026-03-08
        # (02:00 → 03:00), so Mar 7 is still EST (UTC-5).
        recurrence = self._create_recurrence(
            frequency="daily",
            interval=1,
            start_date=date(2026, 3, 7),
            local_time=time(12, 0),
            timezone_name="America/New_York",
        )
        occurrences = self._expand(
            recurrence, _utc(2026, 3, 7), _utc(2026, 3, 11),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 3, day) for day in range(7, 11)],
        )
        for occurrence in occurrences:
            self.assertEqual(occurrence.local_time, time(12, 0))
        self.assertEqual(
            occurrences[0].original_start.astimezone(UTC),
            _utc(2026, 3, 7, 17, 0),
        )
        self.assertEqual(
            occurrences[1].original_start.astimezone(UTC),
            _utc(2026, 3, 8, 16, 0),
        )
        self.assertEqual(
            occurrences[2].original_start.astimezone(UTC),
            _utc(2026, 3, 9, 16, 0),
        )


class MeetingRecurrenceOccurrenceIdentityTest(MeetingRecurrenceBase):
    """Stable, deterministic occurrence identities."""

    def _wide_window_occurrences(self, recurrence):
        return self._expand(recurrence, _utc(2026, 1, 1), _utc(2026, 1, 31))

    def test_occurrence_id_is_uuid_and_stable_across_expansions(self):
        recurrence = self._create_recurrence(frequency="daily")
        first = self._wide_window_occurrences(recurrence)
        second = self._wide_window_occurrences(recurrence)

        self.assertGreater(len(first), 1)
        for occurrence in first:
            self.assertIsInstance(occurrence.occurrence_id, UUID)
        self.assertEqual(
            [o.occurrence_id for o in first],
            [o.occurrence_id for o in second],
        )
        self.assertEqual(
            [o.original_start for o in first],
            [o.original_start for o in second],
        )

    def test_identity_is_independent_of_the_window(self):
        recurrence = self._create_recurrence(frequency="daily")
        wide = {
            o.original_date: o.occurrence_id
            for o in self._wide_window_occurrences(recurrence)
        }
        narrow = self._expand(
            recurrence, _utc(2026, 1, 10, 6, 0), _utc(2026, 1, 15, 6, 0),
        )
        self.assertGreater(len(narrow), 0)
        for occurrence in narrow:
            self.assertEqual(
                wide[occurrence.original_date],
                occurrence.occurrence_id,
            )

    def test_identity_matches_derive_helper(self):
        recurrence = self._create_recurrence(frequency="daily")
        for occurrence in self._wide_window_occurrences(recurrence):
            self.assertEqual(
                occurrence.occurrence_id,
                derive_occurrence_identity(
                    recurrence_id=recurrence.pk,
                    original_local=occurrence.original_local,
                    timezone_name=recurrence.timezone_name,
                ),
            )

    def test_different_schedules_same_start_get_different_identities(self):
        first = self._create_recurrence(frequency="daily")
        second = self._create_recurrence(frequency="daily")
        self.assertNotEqual(first.pk, second.pk)

        occurrences_a = self._wide_window_occurrences(first)
        occurrences_b = self._wide_window_occurrences(second)
        self.assertEqual(
            [o.original_local for o in occurrences_a],
            [o.original_local for o in occurrences_b],
        )
        self.assertNotEqual(
            [o.occurrence_id for o in occurrences_a],
            [o.occurrence_id for o in occurrences_b],
        )


# ── Materialization ──────────────────────────────────────────────


class MeetingRecurrenceMaterializationTest(MeetingRecurrenceBase):
    """Occurrence → concrete Meeting materialization (domain layer)."""

    def _first_occurrence(self, recurrence):
        (occurrence,) = self._expand(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 6),
        )
        return occurrence

    def _materialize(
        self, recurrence, occurrence, *, actor=None, title="Materialized",
    ):
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=actor if actor is not None else self.alex,
            title=title,
        )

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

    # 1. A valid calculated occurrence materializes into a concrete Meeting.

    def test_materialize_creates_a_concrete_meeting(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)

        meeting = self._materialize(
            recurrence, occurrence, title="January 5 Standup",
        )

        self.assertIsInstance(meeting, Meeting)
        self.assertEqual(meeting.title, "January 5 Standup")
        self.assertEqual(meeting.scheduled_at, occurrence.original_start)
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        self.assertEqual(meeting.created_by_id, self.alex.pk)
        self.assertEqual(meeting.research_group_id, self.group.pk)
        self.assertEqual(meeting.scope, Meeting.Scope.GROUP)
        self.assertIsNone(meeting.project)
        # A usable standalone-style structure and the creator as the
        # first participant.
        section = meeting.meeting_sections.get()
        self.assertEqual(section.name, "Agenda")
        self.assertEqual(
            [p.user_id for p in meeting.participant_relations.all()],
            [self.alex.pk],
        )
        # One canonical meeting.created Activity event, no more.
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=meeting,
                event_type="meeting.created",
            ).count(),
            1,
        )

    # 2. The resulting Meeting is linked to its MeetingRecurrence.

    def test_materialized_meeting_is_linked_to_its_recurrence(self):
        recurrence = self._create_recurrence()
        meeting = self._materialize(
            recurrence, self._first_occurrence(recurrence),
        )

        self.assertEqual(meeting.recurrence, recurrence)
        self.assertEqual(
            list(recurrence.materialized_meetings.all()), [meeting],
        )

    # 3. The Meeting persists the original occurrence identity/start.

    def test_materialized_meeting_persists_original_occurrence_identity(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)

        self.assertEqual(
            meeting.original_scheduled_at, occurrence.original_start,
        )
        stored_local = meeting.original_scheduled_at.astimezone(
            BERLIN,
        ).replace(tzinfo=None)
        self.assertEqual(stored_local, occurrence.original_local)
        # The canonical Slice-1 occurrence identity is still derivable
        # from the persisted state alone.
        self.assertEqual(
            derive_occurrence_identity(
                recurrence_id=meeting.recurrence_id,
                original_local=stored_local,
                timezone_name=recurrence.timezone_name,
            ),
            occurrence.occurrence_id,
        )

    # 4. Non-recurring Meetings are unchanged (no recurrence metadata).

    def test_non_recurring_meetings_work_without_recurrence_metadata(self):
        plain = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Plain meeting",
            scheduled_at=_utc(2026, 2, 1, 12, 0),
        )
        self.assertIsNone(plain.recurrence)
        self.assertIsNone(plain.original_scheduled_at)

        recurrence = self._create_recurrence()
        meeting = self._materialize(
            recurrence, self._first_occurrence(recurrence),
        )
        self.assertIsNotNone(meeting.recurrence)
        self.assertIsNotNone(meeting.original_scheduled_at)
        self.assertEqual(Meeting.objects.count(), 2)

    # 5. Repeated materialization reuses exactly one Meeting row.

    def test_materializing_the_same_occurrence_twice_reuses_one_meeting(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)

        first = self._materialize(recurrence, occurrence, title="First title")
        second = self._materialize(
            recurrence, occurrence, title="Second title",
        )

        self.assertEqual(first.pk, second.pk)
        self.assertEqual(Meeting.objects.count(), 1)
        # The first creation's state wins; no duplicate structure.
        self.assertEqual(Meeting.objects.get(pk=first.pk).title, "First title")
        self.assertEqual(first.meeting_sections.count(), 1)
        self.assertEqual(
            MeetingParticipant.objects.filter(meeting=first).count(), 1,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=first, event_type="meeting.created",
            ).count(),
            1,
        )

    # 6. The database constraint stops duplicates even when the service
    #    level protection is bypassed.

    def test_db_unique_constraint_prevents_duplicate_occurrence_meetings(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        self._materialize(recurrence, occurrence)

        with self.assertRaises(IntegrityError), transaction.atomic():
            Meeting.objects.create(
                research_group=self.group,
                scope=Meeting.Scope.GROUP,
                title="Bypass",
                scheduled_at=occurrence.original_start,
                recurrence=recurrence,
                original_scheduled_at=occurrence.original_start,
                created_by=self.alex,
            )
        self.assertEqual(Meeting.objects.count(), 1)

    def test_db_check_constraint_requires_paired_provenance_fields(self):
        recurrence = self._create_recurrence()
        with self.assertRaises(IntegrityError), transaction.atomic():
            Meeting.objects.create(
                research_group=self.group,
                scope=Meeting.Scope.GROUP,
                title="Unpaired",
                scheduled_at=_utc(2026, 1, 5, 9, 30),
                recurrence=recurrence,
                # original_scheduled_at intentionally missing.
                created_by=self.alex,
            )
        # ... and an orphan original start on a non-recurring Meeting.
        with self.assertRaises(IntegrityError), transaction.atomic():
            Meeting.objects.create(
                research_group=self.group,
                scope=Meeting.Scope.GROUP,
                title="Orphan original",
                scheduled_at=_utc(2026, 1, 5, 9, 30),
                original_scheduled_at=_utc(2026, 1, 5, 9, 30),
                created_by=self.alex,
            )

    # 7. Two different occurrences materialize into separate Meetings.

    def test_distinct_occurrences_materialize_distinct_meetings(self):
        recurrence = self._create_recurrence()
        first, second = self._expand(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 7),
        )

        meeting_a = self._materialize(recurrence, first, title="A")
        meeting_b = self._materialize(recurrence, second, title="B")

        self.assertNotEqual(meeting_a.pk, meeting_b.pk)
        self.assertEqual(Meeting.objects.count(), 2)
        self.assertEqual(
            meeting_a.recurrence_id, meeting_b.recurrence_id,
        )
        self.assertNotEqual(
            meeting_a.original_scheduled_at,
            meeting_b.original_scheduled_at,
        )

    # 8. Occurrences from different recurrences never collide, even for
    #    identical scheduled timestamps.

    def test_identical_timestamps_across_recurrences_do_not_collide(self):
        first = self._create_recurrence()
        second = self._create_recurrence()
        occurrence_a = self._first_occurrence(first)
        occurrence_b = self._first_occurrence(second)

        self.assertEqual(
            occurrence_a.original_start, occurrence_b.original_start,
        )
        self.assertNotEqual(
            occurrence_a.occurrence_id, occurrence_b.occurrence_id,
        )

        meeting_a = self._materialize(first, occurrence_a)
        meeting_b = self._materialize(second, occurrence_b)

        self.assertEqual(Meeting.objects.count(), 2)
        self.assertNotEqual(meeting_a.pk, meeting_b.pk)
        self.assertEqual(
            meeting_a.original_scheduled_at,
            meeting_b.original_scheduled_at,
        )

    # 9. Forged or foreign occurrences are rejected.

    def test_occurrence_from_another_recurrence_is_rejected(self):
        a = self._create_recurrence()
        b = self._create_recurrence()
        foreign = self._first_occurrence(b)

        with self.assertRaises(MeetingDomainError):
            self._materialize(a, foreign)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_occurrence_with_forged_identity_is_rejected(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        forged = replace(occurrence, occurrence_id=uuid4())

        with self.assertRaises(MeetingDomainError):
            self._materialize(recurrence, forged)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_occurrence_at_a_time_the_rule_never_produces_is_rejected(self):
        recurrence = self._create_recurrence()  # daily at 09:30 Berlin
        occurrence = self._first_occurrence(recurrence)
        fake_local = occurrence.original_local.replace(hour=10, minute=0)
        fake = self._synthetic_occurrence(recurrence, fake_local)

        with self.assertRaises(MeetingDomainError):
            self._materialize(recurrence, fake)
        self.assertEqual(Meeting.objects.count(), 0)

    def test_occurrence_before_the_first_occurrence_is_rejected(self):
        recurrence = self._create_recurrence()  # first occurrence Jan 5
        fake = self._synthetic_occurrence(
            recurrence, datetime(2026, 1, 4, 9, 30),
        )

        with self.assertRaises(MeetingDomainError):
            self._materialize(recurrence, fake)
        self.assertEqual(Meeting.objects.count(), 0)

    # 10. Occurrences outside the end / count contract are rejected.

    def test_occurrence_beyond_the_count_contract_is_rejected(self):
        recurrence = self._create_recurrence(
            frequency="daily", interval=1,
            end_mode="count", occurrence_count=3,
        )
        # The rule's three occurrences are Jan 5/6/7; Jan 8 is outside.
        with self.assertRaises(MeetingDomainError):
            self._materialize(
                recurrence,
                self._synthetic_occurrence(
                    recurrence, datetime(2026, 1, 8, 9, 30),
                ),
            )
        self.assertEqual(Meeting.objects.count(), 0)

        # The last allowed (third) occurrence materializes fine.
        meeting = self._materialize(
            recurrence,
            self._synthetic_occurrence(
                recurrence, datetime(2026, 1, 7, 9, 30),
            ),
        )
        self.assertIsNotNone(meeting.pk)

    def test_occurrence_beyond_the_end_date_contract_is_rejected(self):
        recurrence = self._create_recurrence(
            frequency="daily", interval=1,
            end_mode="end_date", end_date=date(2026, 1, 6),
        )
        with self.assertRaises(MeetingDomainError):
            self._materialize(
                recurrence,
                self._synthetic_occurrence(
                    recurrence, datetime(2026, 1, 7, 9, 30),
                ),
            )
        self.assertEqual(Meeting.objects.count(), 0)

    # 11. Canonical scoped write/authorization rules apply.

    def test_materialization_requires_scoped_write_access(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)

        # An outsider (not a Research Group member) cannot materialize.
        with self.assertRaises(MeetingDomainError):
            self._materialize(recurrence, occurrence, actor=self.maria)
        self.assertEqual(Meeting.objects.count(), 0)

        # A Research Group member can.
        self.assertIsNotNone(
            self._materialize(
                recurrence, occurrence, actor=self.chris,
            ).pk,
        )

    def test_project_scoped_materialization_uses_project_write_rule(self):
        recurrence = self._create_recurrence(
            scope=MeetingRecurrence.Scope.PROJECT, project=self.project,
        )
        occurrence = self._first_occurrence(recurrence)

        # A Project viewer cannot materialize.
        with self.assertRaises(MeetingDomainError):
            self._materialize(recurrence, occurrence, actor=self.laura)
        self.assertEqual(Meeting.objects.count(), 0)

        # A Project member can, and the Meeting inherits the Project.
        meeting = self._materialize(recurrence, occurrence, actor=self.chris)
        self.assertEqual(meeting.scope, Meeting.Scope.PROJECT)
        self.assertEqual(meeting.project_id, self.project.pk)
        self.assertEqual(meeting.research_group_id, self.group.pk)

    def test_materialization_rejected_for_archived_project(self):
        recurrence = self._create_recurrence(
            scope=MeetingRecurrence.Scope.PROJECT, project=self.project,
        )
        archive_project(project=self.project, actor=self.alex)
        # Re-load the recurrence as a real request would: the creation
        # return value still caches the pre-archive Project instance.
        recurrence = MeetingRecurrence.objects.get(pk=recurrence.pk)
        occurrence = self._first_occurrence(recurrence)

        with self.assertRaises(MeetingDomainError):
            self._materialize(recurrence, occurrence, actor=self.chris)
        self.assertEqual(Meeting.objects.count(), 0)

    # 12./13. No eager materialization anywhere else.

    def test_recurrence_creation_creates_no_meeting_rows(self):
        self._create_recurrence()
        self._create_recurrence(
            scope=MeetingRecurrence.Scope.PROJECT, project=self.project,
        )
        self.assertEqual(Meeting.objects.count(), 0)

    def test_expansion_still_creates_no_meeting_rows(self):
        recurrence = self._create_recurrence()
        self._expand(recurrence, _utc(2026, 1, 1), _utc(2026, 12, 31))
        self.assertEqual(Meeting.objects.count(), 0)

    # 14. scheduled_at and the original occurrence identity are
    #     independent: a later move changes the former only.

    def test_original_identity_is_independent_of_scheduled_time(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)
        original = meeting.original_scheduled_at

        # Simulate a later override moving the concrete Meeting.
        moved = _utc(2026, 1, 12, 14, 0)
        update_meeting(meeting=meeting, actor=self.alex, scheduled_at=moved)
        meeting.refresh_from_db()

        self.assertEqual(meeting.scheduled_at, moved)
        self.assertEqual(meeting.original_scheduled_at, original)
        self.assertEqual(meeting.recurrence_id, recurrence.pk)
        stored_local = meeting.original_scheduled_at.astimezone(
            BERLIN,
        ).replace(tzinfo=None)
        self.assertEqual(
            derive_occurrence_identity(
                recurrence_id=meeting.recurrence_id,
                original_local=stored_local,
                timezone_name=recurrence.timezone_name,
            ),
            occurrence.occurrence_id,
        )

        # Re-materializing after the move still reuses the same row.
        again = self._materialize(recurrence, occurrence)
        self.assertEqual(again.pk, meeting.pk)
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(again.scheduled_at, moved)

    # 15. Template behavior: Recurrences have no Template association in
    #     V1, so materialization initializes standalone-style and the
    #     materialized Meeting owns its own persistent state.

    def test_materialized_meeting_is_initialized_standalone_style(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)

        self.assertIsNone(meeting.series)
        sections = list(meeting.meeting_sections.order_by("position"))
        self.assertEqual([s.name for s in sections], ["Agenda"])
        self.assertEqual(sections[0].position, 0)
        self.assertTrue(sections[0].is_visible)
        self.assertIsNone(sections[0].source_series_section)

        # The concrete Meeting owns its state: mutating it is ordinary
        # Meeting editing (no Template involved, nothing to cascade).
        update_meeting(
            meeting=meeting, actor=self.alex, title="Renamed occurrence",
        )
        self.assertEqual(Meeting.objects.get(pk=meeting.pk).title,
                         "Renamed occurrence")


class MeetingRecurrenceRescheduleTest(MeetingRecurrenceBase):
    """Single-occurrence reschedule ("only this meeting", domain layer).

    The move is represented by a concrete Meeting: ``scheduled_at``
    moves, while the immutable ``original_scheduled_at`` occurrence
    identity, the recurrence rule, and every other occurrence stay
    untouched. A still-virtual occurrence is first materialized
    through the canonical idempotent materialization path, then
    moved.
    """

    def _first_occurrence(self, recurrence):
        (occurrence,) = self._expand(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 6),
        )
        return occurrence

    def _materialize(
        self, recurrence, occurrence, *, actor=None, title="Materialized",
    ):
        return materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=actor if actor is not None else self.alex,
            title=title,
        )

    def _reschedule(
        self,
        recurrence,
        occurrence,
        scheduled_at,
        *,
        actor=None,
        title="Materialized",
    ):
        return reschedule_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            scheduled_at=scheduled_at,
            actor=actor if actor is not None else self.alex,
            title=title,
        )

    def _recurrence_rule_snapshot(self, recurrence):
        """Every field of the recurrence rule row."""
        return {
            "research_group_id": recurrence.research_group_id,
            "scope": recurrence.scope,
            "project_id": recurrence.project_id,
            "frequency": recurrence.frequency,
            "interval": recurrence.interval,
            "weekdays": recurrence.weekdays,
            "start_date": recurrence.start_date,
            "local_time": recurrence.local_time,
            "timezone_name": recurrence.timezone_name,
            "end_mode": recurrence.end_mode,
            "end_date": recurrence.end_date,
            "occurrence_count": recurrence.occurrence_count,
            "created_by_id": recurrence.created_by_id,
            "created_at": recurrence.created_at,
            "updated_at": recurrence.updated_at,
        }

    # 1. The move changes scheduled_at only.

    def test_reschedule_moves_only_scheduled_at(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)
        original = meeting.original_scheduled_at

        moved = _utc(2026, 3, 15, 14, 0)
        updated = self._reschedule(recurrence, occurrence, moved)
        updated.refresh_from_db()

        # The concrete Meeting moved to the new planned time...
        self.assertEqual(updated.scheduled_at, moved)
        # ...while the immutable occurrence identity is unchanged.
        self.assertEqual(updated.original_scheduled_at, original)
        self.assertEqual(updated.recurrence_id, recurrence.pk)
        # Nothing else about the Meeting changed.
        self.assertEqual(updated.title, "Materialized")
        self.assertEqual(updated.status, Meeting.Status.UPCOMING)
        self.assertEqual(updated.created_by_id, self.alex.pk)
        # The canonical occurrence identity is still derivable from
        # the persisted state alone.
        stored_local = updated.original_scheduled_at.astimezone(
            BERLIN,
        ).replace(tzinfo=None)
        self.assertEqual(
            derive_occurrence_identity(
                recurrence_id=updated.recurrence_id,
                original_local=stored_local,
                timezone_name=recurrence.timezone_name,
            ),
            occurrence.occurrence_id,
        )
        # Exactly one Meeting row still exists for the occurrence.
        self.assertEqual(Meeting.objects.count(), 1)

    # 2. A real move records exactly one structured event.

    def test_reschedule_records_one_structured_event(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)
        original = meeting.scheduled_at

        moved = _utc(2026, 3, 15, 14, 0)
        self._reschedule(recurrence, occurrence, moved)

        events = AuditEvent.objects.filter(
            meeting=meeting,
            event_type="meeting.rescheduled",
        ).order_by("id")
        self.assertEqual(events.count(), 1)
        event = events.get()
        self.assertEqual(event.actor, self.alex)
        # The persisted event uses the canonical _iso8601_utc form
        # (UTC ISO-8601 with the +00:00 offset, never a 'Z' suffix).
        def _stored_utc(dt):
            return dt.astimezone(UTC).isoformat()

        self.assertEqual(
            event.data["changes"]["scheduledAt"]["from"],
            _stored_utc(original),
        )
        self.assertEqual(
            event.data["changes"]["scheduledAt"]["to"],
            _stored_utc(moved),
        )

    # 3. A no-op reschedule changes nothing and records no event.

    def test_noop_reschedule_records_no_event_and_no_change(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)
        before_scheduled_at = meeting.scheduled_at

        self._reschedule(
            recurrence, occurrence, meeting.scheduled_at,
        )
        meeting.refresh_from_db()

        # Same planned time: nothing about the Meeting's state
        # (planned time, original identity, provenance) changes, and
        # no reschedule event is recorded.
        self.assertEqual(
            meeting.scheduled_at, before_scheduled_at,
        )
        self.assertEqual(
            meeting.original_scheduled_at, occurrence.original_start,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=meeting,
                event_type="meeting.rescheduled",
            ).count(),
            0,
        )

    # 4. The move does not create a second Meeting for the occurrence.

    def test_reschedule_keeps_the_single_meeting_row(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence)

        self._reschedule(recurrence, occurrence, _utc(2026, 3, 1, 10, 0))
        self._reschedule(recurrence, occurrence, _utc(2026, 3, 2, 11, 0))

        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(
            Meeting.objects.get(pk=meeting.pk).scheduled_at,
            _utc(2026, 3, 2, 11, 0),
        )
        # Re-materializing after the move still reuses the same row.
        again = self._materialize(recurrence, occurrence)
        self.assertEqual(again.pk, meeting.pk)
        self.assertEqual(Meeting.objects.count(), 1)

    # 5. The recurrence rule itself is not mutated.

    def test_reschedule_does_not_mutate_the_recurrence_rule(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        self._materialize(recurrence, occurrence)
        before = self._recurrence_rule_snapshot(recurrence)

        self._reschedule(recurrence, occurrence, _utc(2026, 3, 15, 14, 0))

        recurrence.refresh_from_db()
        self.assertEqual(
            self._recurrence_rule_snapshot(recurrence), before,
        )

    # 6. Every other occurrence in the series is untouched.

    def test_reschedule_leaves_other_occurrences_untouched(self):
        recurrence = self._create_recurrence()
        start, end = _utc(2026, 1, 5), _utc(2026, 1, 9)
        occurrences = {
            occ.original_local.date(): occ
            for occ in self._expand(recurrence, start, end)
        }
        jan6 = occurrences[date(2026, 1, 6)]
        jan7 = occurrences[date(2026, 1, 7)]
        jan8 = occurrences[date(2026, 1, 8)]
        moved_meeting = self._materialize(recurrence, jan6)
        untouched_meeting = self._materialize(recurrence, jan7)

        before_expansion = self._expand(recurrence, start, end)
        self._reschedule(
            recurrence, jan6, _utc(2026, 3, 15, 14, 0),
        )
        after_expansion = self._expand(recurrence, start, end)

        # The rule still produces the identical occurrence series.
        self.assertEqual(
            [occ.occurrence_id for occ in before_expansion],
            [occ.occurrence_id for occ in after_expansion],
        )
        # The sibling materialized Meeting did not move...
        untouched_meeting.refresh_from_db()
        self.assertEqual(
            untouched_meeting.scheduled_at, jan7.original_start,
        )
        # ...and the untouched sibling is still virtual as before.
        self.assertIsNone(
            Meeting.objects.filter(
                recurrence=recurrence,
                original_scheduled_at=jan8.original_start,
            ).first(),
        )
        moved_meeting.refresh_from_db()
        self.assertEqual(
            moved_meeting.scheduled_at, _utc(2026, 3, 15, 14, 0),
        )

    # 7. A virtual occurrence is materialized, then moved.

    def test_virtual_occurrence_is_materialized_then_moved(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        moved = _utc(2026, 3, 15, 14, 0)

        meeting = self._reschedule(
            recurrence, occurrence, moved, title="January 5 Standup",
        )

        # Exactly one concrete Meeting was created for the
        # occurrence — no other occurrence (adjacent/future) was
        # materialized.
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertIsInstance(meeting, Meeting)
        self.assertEqual(meeting.title, "January 5 Standup")
        # Recurrence provenance and the immutable identity.
        self.assertEqual(meeting.recurrence_id, recurrence.pk)
        self.assertEqual(
            meeting.original_scheduled_at, occurrence.original_start,
        )
        # The Meeting was moved to the requested time.
        self.assertEqual(meeting.scheduled_at, moved)
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)
        # Standalone-style initialization: one Agenda section, the
        # creator as participant.
        self.assertEqual(meeting.meeting_sections.count(), 1)
        self.assertEqual(
            [p.user_id for p in meeting.participant_relations.all()],
            [self.alex.pk],
        )
        # One canonical meeting.created event (materialization) plus
        # one meeting.rescheduled event (the move), nothing else.
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=meeting,
                event_type="meeting.created",
            ).count(),
            1,
        )
        rescheduled = AuditEvent.objects.filter(
            meeting=meeting,
            event_type="meeting.rescheduled",
        ).order_by("id")
        self.assertEqual(rescheduled.count(), 1)
        self.assertEqual(
            rescheduled.get().data["changes"]["scheduledAt"]["to"],
            moved.astimezone(UTC).isoformat(),
        )

    def test_virtual_reschedule_replay_reuses_the_same_meeting(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        moved = _utc(2026, 3, 15, 14, 0)

        first = self._reschedule(
            recurrence, occurrence, moved, title="First title",
        )
        # Repeating the SAME request (same actor, same new time) acts
        # on the same row: the move is a no-op, so no second
        # reschedule event and no duplicate structure.
        second = self._reschedule(
            recurrence, occurrence, moved, title="First title",
        )
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(MeetingSection.objects.count(), 1)
        self.assertEqual(MeetingParticipant.objects.count(), 1)
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type="meeting.created",
            ).count(),
            1,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type="meeting.rescheduled",
            ).count(),
            1,
        )

    def test_virtual_reschedule_second_move_moves_the_same_meeting(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)

        first = self._reschedule(
            recurrence, occurrence, _utc(2026, 3, 1, 10, 0),
        )
        # A second reschedule with a NEW time moves the SAME row.
        second = self._reschedule(
            recurrence, occurrence, _utc(2026, 3, 2, 11, 0),
        )
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(
            Meeting.objects.get(pk=first.pk).scheduled_at,
            _utc(2026, 3, 2, 11, 0),
        )
        self.assertEqual(
            Meeting.objects.get(pk=first.pk).original_scheduled_at,
            occurrence.original_start,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type="meeting.created",
            ).count(),
            1,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                event_type="meeting.rescheduled",
            ).count(),
            2,
        )

    def test_virtual_noop_reschedule_records_created_but_no_rescheduled(
        self,
    ):
        # Moving a virtual occurrence to its OWN original time still
        # materializes it (created event) but is a no-op move (no
        # reschedule event) — the canonical no-op behavior.
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)

        meeting = self._reschedule(
            recurrence, occurrence, occurrence.original_start,
        )
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(
            meeting.scheduled_at, occurrence.original_start,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=meeting,
                event_type="meeting.created",
            ).count(),
            1,
        )
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=meeting,
                event_type="meeting.rescheduled",
            ).count(),
            0,
        )

    def test_materialized_reschedule_never_overwrites_the_title(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        meeting = self._materialize(recurrence, occurrence, title="Original")

        updated = self._reschedule(
            recurrence, occurrence, _utc(2026, 3, 15, 14, 0),
            title="Renamed by reschedule",
        )
        self.assertEqual(updated.pk, meeting.pk)
        # The request title is ignored for an existing Meeting.
        self.assertEqual(
            Meeting.objects.get(pk=meeting.pk).title, "Original",
        )

    def test_blank_title_is_rejected_and_persists_nothing(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)

        with self.assertRaises(MeetingDomainError):
            self._reschedule(
                recurrence, occurrence, _utc(2026, 3, 15, 14, 0),
                title="  ",
            )
        # The virtual occurrence was NOT materialized as a side
        # effect of the rejected request.
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)

    # 8. Occurrence validation against the rule is enforced.

    def _synthetic_occurrence(self, recurrence, original_local):
        """A well-formed occurrence VALUE with the canonical derived
        identity, so rule membership (not identity) decides."""
        return MeetingRecurrenceOccurrence(
            occurrence_id=derive_occurrence_identity(
                recurrence_id=recurrence.pk,
                original_local=original_local,
                timezone_name=recurrence.timezone_name,
            ),
            original_local=original_local,
            original_start=original_local.replace(tzinfo=BERLIN),
        )

    def test_forged_wall_clock_time_is_rejected(self):
        recurrence = self._create_recurrence()
        self._materialize(
            recurrence, self._first_occurrence(recurrence),
        )
        # A self-consistent forged pair: the identity matches the
        # supplied (wrong) wall-clock time, but the rule never
        # produces 10:00 — the Meeting must not be moved.
        forged = self._synthetic_occurrence(
            recurrence, datetime(2026, 1, 6, 10, 0),
        )
        with self.assertRaises(MeetingDomainError):
            self._reschedule(
                recurrence, forged, _utc(2026, 3, 15, 14, 0),
            )
        self.assertEqual(
            Meeting.objects.get().scheduled_at,
            _utc(2026, 1, 5, 8, 30),
        )

    def test_foreign_recurrence_identity_is_rejected(self):
        recurrence = self._create_recurrence()
        other = self._create_recurrence()  # same rule, different id
        occurrence = self._first_occurrence(recurrence)
        self._materialize(recurrence, occurrence)

        # A genuine occurrence of a DIFFERENT schedule (same rule,
        # different schedule id → different identity) must not be
        # reschedulable through this recurrence.
        foreign = self._first_occurrence(other)
        self.assertNotEqual(foreign.occurrence_id, occurrence.occurrence_id)
        with self.assertRaises(MeetingDomainError):
            self._reschedule(
                recurrence, foreign, _utc(2026, 3, 15, 14, 0),
            )
        self.assertEqual(
            Meeting.objects.get().scheduled_at, occurrence.original_start,
        )

    def test_occurrence_beyond_the_count_contract_is_rejected(self):
        recurrence = self._create_recurrence(
            frequency="daily", interval=1,
            end_mode="count", occurrence_count=3,
        )
        first = self._first_occurrence(recurrence)
        self._materialize(recurrence, first)

        # Jan 8 is outside the count contract: no move, no change.
        beyond = self._synthetic_occurrence(
            recurrence, datetime(2026, 1, 8, 9, 30),
        )
        with self.assertRaises(MeetingDomainError):
            self._reschedule(
                recurrence, beyond, _utc(2026, 3, 15, 14, 0),
            )
        self.assertEqual(
            Meeting.objects.get().scheduled_at, first.original_start,
        )

    # 9. Canonical scoped write/authorization rules apply.

    def test_reschedule_requires_scoped_write_access(self):
        recurrence = self._create_recurrence()
        occurrence = self._first_occurrence(recurrence)
        self._materialize(recurrence, occurrence)

        # An outsider (not a Research Group member) cannot reschedule.
        with self.assertRaises(MeetingDomainError):
            self._reschedule(
                recurrence, occurrence, _utc(2026, 3, 15, 14, 0),
                actor=self.maria,
            )
        # A Research Group member can.
        updated = self._reschedule(
            recurrence, occurrence, _utc(2026, 3, 15, 14, 0),
            actor=self.chris,
        )
        self.assertEqual(
            updated.scheduled_at, _utc(2026, 3, 15, 14, 0),
        )

    def test_project_scoped_reschedule_uses_project_write_rule(self):
        recurrence = self._create_recurrence(
            scope=MeetingRecurrence.Scope.PROJECT, project=self.project,
        )
        occurrence = self._first_occurrence(recurrence)
        self._materialize(recurrence, occurrence)

        # A Project viewer cannot reschedule.
        with self.assertRaises(MeetingDomainError):
            self._reschedule(
                recurrence, occurrence, _utc(2026, 3, 15, 14, 0),
                actor=self.laura,
            )
        # A Project member can; the Meeting keeps its Project.
        updated = self._reschedule(
            recurrence, occurrence, _utc(2026, 3, 15, 14, 0),
            actor=self.chris,
        )
        self.assertEqual(updated.scope, Meeting.Scope.PROJECT)
        self.assertEqual(updated.project_id, self.project.pk)

    def test_reschedule_rejected_for_archived_project(self):
        recurrence = self._create_recurrence(
            scope=MeetingRecurrence.Scope.PROJECT, project=self.project,
        )
        occurrence = self._first_occurrence(recurrence)
        self._materialize(recurrence, occurrence)
        archive_project(project=self.project, actor=self.alex)
        # Re-load as a real request would: the creation return value
        # still caches the pre-archive Project instance.
        recurrence = MeetingRecurrence.objects.get(pk=recurrence.pk)

        with self.assertRaises(MeetingDomainError):
            self._reschedule(
                recurrence, occurrence, _utc(2026, 3, 15, 14, 0),
                actor=self.chris,
            )


class MeetingRecurrenceMaterializationConcurrencyTest(TransactionTestCase):
    """Concurrent materialization of one occurrence (real PostgreSQL).

    Repository concurrency harness: threaded service calls, a barrier to
    align the racers, and the unique
    ``(recurrence, original_scheduled_at)`` constraint as the last line
    of defense — exactly one Meeting row may survive.
    """

    def setUp(self):
        self.alex = User.objects.create_user(
            username="recrace-alex", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Race Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.recurrence = create_meeting_recurrence(
            research_group=self.group,
            actor=self.alex,
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

    def _materialize_in_thread(self, name, results, errors, barrier):
        def worker():
            barrier.wait()
            try:
                results[name] = materialize_meeting_recurrence_occurrence(
                    recurrence=self.recurrence,
                    occurrence=self.occurrence,
                    actor=self.alex,
                    title="Raced",
                )
            except Exception as exc:
                errors[name] = exc
            finally:
                db_connection.close()

        return worker

    def test_concurrent_materialization_creates_exactly_one_meeting(self):
        results, errors = {}, {}
        barrier = threading.Barrier(2)
        threads = [
            threading.Thread(
                target=self._materialize_in_thread(
                    name, results, errors, barrier,
                ),
            )
            for name in ("a", "b")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, {})
        meeting_a, meeting_b = results["a"], results["b"]
        self.assertEqual(meeting_a.pk, meeting_b.pk)
        self.assertEqual(Meeting.objects.count(), 1)
        meeting = Meeting.objects.first()
        self.assertEqual(meeting.title, "Raced")
        self.assertEqual(meeting.meeting_sections.count(), 1)
        self.assertEqual(
            MeetingParticipant.objects.filter(meeting=meeting).count(), 1,
        )
        # The losing racer (if any) rolled its transaction back: exactly
        # one meeting.created event survives.
        self.assertEqual(
            AuditEvent.objects.filter(
                meeting=meeting, event_type="meeting.created",
            ).count(),
            1,
        )

    def test_losing_racer_reuses_the_winner_row(self):
        """Deterministic race: a concurrent raw insert holds the
        occurrence's unique key until after the service call reaches its
        own insert, so the service must hit the constraint and return
        the winner's row instead of failing or duplicating.
        """
        winner_pk = {}
        winner_inserted = threading.Event()
        release_winner = threading.Event()

        def winner():
            # A concurrent duplicate insert that bypasses the service
            # (simulating the other racer's in-flight transaction).
            with transaction.atomic():
                meeting = Meeting.objects.create(
                    research_group=self.group,
                    scope=Meeting.Scope.GROUP,
                    title="Winner",
                    scheduled_at=self.occurrence.original_start,
                    recurrence=self.recurrence,
                    original_scheduled_at=self.occurrence.original_start,
                    status=Meeting.Status.UPCOMING,
                    created_by=self.alex,
                )
                winner_pk["pk"] = meeting.pk
                winner_inserted.set()
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
        self.assertTrue(winner_inserted.wait(timeout=30))

        loser_thread = threading.Thread(target=loser)
        loser_thread.start()
        # Give the loser time to reach its insert while the winner's
        # transaction is still open (its unique key is then held).
        time_module.sleep(0.25)
        release_winner.set()
        loser_thread.join()
        winner_thread.join()
        db_connection.close()

        self.assertEqual(loser_errors, {})
        self.assertEqual(
            loser_result["meeting"].pk, winner_pk["pk"],
        )
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(Meeting.objects.first().title, "Winner")
