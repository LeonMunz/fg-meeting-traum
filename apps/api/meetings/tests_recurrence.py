"""Tests for MeetingRecurrence: V1 recurring-meeting schedules and bounded
occurrence expansion (domain layer; no API/UI in this slice)."""

from datetime import date, datetime, time, timezone as dt_timezone
from uuid import UUID
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.test import TestCase

from projects.models import ProjectMembership
from projects.services import add_project_membership, create_project
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import Meeting, MeetingRecurrence
from .recurrence import derive_occurrence_identity
from .services import (
    MeetingDomainError,
    create_meeting_recurrence,
    expand_meeting_recurrence_occurrences,
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