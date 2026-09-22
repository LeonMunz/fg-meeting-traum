"""Pure recurrence expansion engine for ``MeetingRecurrence`` (V1).

This module is deliberately free of Django models and ORM access: it
implements the V1 recurrence language as a deterministic pure function so
that occurrence calculation can be reasoned about and tested without a
database. ``meetings.services`` validates persisted schedules and calls
into this engine; the engine re-validates its inputs as a defense against
corrupted or hand-written rows.

V1 recurrence language
----------------------
- frequency: ``daily`` / ``weekly`` / ``monthly``
- positive integer interval (N days / N weeks / N months)
- weekly schedules select one or more ISO weekdays (0 = Monday .. 6 =
  Sunday, the ``datetime.date.weekday()`` convention); the start date's
  weekday must be part of the pattern, so the start date is ALWAYS the
  first actual occurrence
- start date + configured local time + IANA timezone
- end mode: no end, inclusive end date, or count (count INCLUDES the
  first occurrence); end date and count are mutually exclusive
- monthly recurrence means "the same calendar day as the start date";
  months without that day are SKIPPED (never shifted to the month end)

Time semantics
--------------
All calculation happens in local wall-clock time in the schedule's stored
IANA timezone. The configured local time is preserved across DST
transitions: the wall-clock time stays constant while the UTC instant
shifts with the offset. Expansion windows are timezone-aware datetimes;
they are converted into the schedule's stored timezone before wall-clock
comparison, so filtering is exact for the schedule's own calendar.

Occurrence identity
-------------------
Each calculated occurrence carries a stable, deterministic identity
derived from the ORIGINAL scheduled start (the wall-clock start the rule
produced), not from any later materialized Meeting. The identity is a
UUIDv5 over (schedule id, original local start, timezone name), so it is
stable across repeated expansion and across process restarts, and it stays
valid as the immutable original-start identity if a future override moves
a materialized Meeting.
"""

from __future__ import annotations

import calendar
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Frequency values (mirror MeetingRecurrence.Frequency).
DAILY = "daily"
WEEKLY = "weekly"
MONTHLY = "monthly"
FREQUENCIES = (DAILY, WEEKLY, MONTHLY)

# End mode values (mirror MeetingRecurrence.EndMode).
END_NO_END = "no_end"
END_END_DATE = "end_date"
END_COUNT = "count"
END_MODES = (END_NO_END, END_END_DATE, END_COUNT)

# ISO weekday convention: 0 = Monday .. 6 = Sunday.
WEEKDAY_MIN = 0
WEEKDAY_MAX = 6

# Fixed namespace for deterministic occurrence identity derivation.
# Derived from a stable URN so the constant itself is reproducible.
OCCURRENCE_ID_NAMESPACE = uuid.uuid5(
    uuid.NAMESPACE_URL,
    "urn:fg-workspace:meeting-recurrence-occurrence",
)


class RecurrenceError(ValueError):
    """Raised for invalid recurrence definitions or expansion requests."""


@dataclass(frozen=True)
class MeetingRecurrenceOccurrence:
    """One calculated occurrence of a recurrence schedule.

    ``original_local`` is the naive wall-clock start in the schedule's
    stored IANA timezone; ``original_start`` is the same instant as an
    aware datetime with the DST-correct offset. ``occurrence_id`` is the
    stable identity derived from the original scheduled start (see module
    docstring); it never changes if a later override moves a materialized
    Meeting.
    """

    occurrence_id: uuid.UUID
    original_local: datetime  # naive wall-clock in the stored timezone
    original_start: datetime  # aware (stored timezone, DST-correct offset)

    @property
    def original_date(self) -> date:
        return self.original_local.date()

    @property
    def local_time(self) -> time:
        return self.original_local.time()


def is_valid_iana_timezone(name: object) -> bool:
    """True iff ``name`` resolves to an IANA timezone (e.g. ZoneInfo)."""
    if not isinstance(name, str) or not name.strip():
        return False
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, KeyError, TypeError):
        return False
    return True


def derive_occurrence_identity(
    *,
    recurrence_id,
    original_local: datetime,
    timezone_name: str,
) -> uuid.UUID:
    """Deterministic UUIDv5 from (schedule id, original wall-clock start).

    The identity is derived from the ORIGINAL scheduled start only; a later
    override of a materialized Meeting does not change it.
    """
    key = (
        f"{recurrence_id}"
        f":{original_local:%Y-%m-%dT%H:%M:%S}"
        f"@{timezone_name}"
    )
    return uuid.uuid5(OCCURRENCE_ID_NAMESPACE, key)


def validate_recurrence_definition(
    *,
    frequency,
    interval,
    weekdays,
    start_date,
    local_time,
    timezone_name,
    end_mode,
    end_date,
    occurrence_count,
):
    """Validate a V1 recurrence definition; raise RecurrenceError if invalid.

    Returns the normalized (sorted, de-duplicated) weekday tuple. This is
    the single source of V1 recurrence validation truth; callers in the
    service layer translate RecurrenceError into their domain error type.
    """
    if frequency not in FREQUENCIES:
        raise RecurrenceError(f"Unsupported recurrence frequency: {frequency!r}.")

    if not isinstance(interval, int) or isinstance(interval, bool) or interval < 1:
        raise RecurrenceError("Recurrence interval must be a positive integer.")

    if not isinstance(start_date, date) or isinstance(start_date, datetime):
        raise RecurrenceError("Recurrence start must be a calendar date.")
    if not isinstance(local_time, time):
        raise RecurrenceError("Recurrence time must be a time of day.")

    if not is_valid_iana_timezone(timezone_name):
        raise RecurrenceError(
            f"Recurrence timezone must be a valid IANA timezone name: {timezone_name!r}."
        )

    normalized_weekdays = _normalize_weekdays(weekdays)

    if frequency == WEEKLY:
        if not normalized_weekdays:
            raise RecurrenceError("Weekly recurrence requires one or more weekdays.")
        if start_date.weekday() not in normalized_weekdays:
            raise RecurrenceError(
                "The weekly start date's weekday is not part of the recurrence pattern."
            )
    elif normalized_weekdays:
        raise RecurrenceError("Weekdays are only allowed for weekly recurrence.")

    if end_mode not in END_MODES:
        raise RecurrenceError(f"Unsupported end mode: {end_mode!r}.")

    if end_mode == END_END_DATE:
        if not isinstance(end_date, date) or isinstance(end_date, datetime):
            raise RecurrenceError("End-date mode requires a calendar end date.")
        if occurrence_count is not None:
            raise RecurrenceError("End date and occurrence count are mutually exclusive.")
        if end_date < start_date:
            raise RecurrenceError("The end date must not be before the start date.")
    elif end_mode == END_COUNT:
        if (
            not isinstance(occurrence_count, int)
            or isinstance(occurrence_count, bool)
            or occurrence_count < 1
        ):
            raise RecurrenceError("Count mode requires a positive occurrence count.")
        if end_date is not None:
            raise RecurrenceError("End date and occurrence count are mutually exclusive.")
    else:  # END_NO_END
        if end_date is not None or occurrence_count is not None:
            raise RecurrenceError(
                "No-end mode must not carry an end date or an occurrence count."
            )

    return normalized_weekdays


def _normalize_weekdays(weekdays) -> tuple[int, ...]:
    """Normalize a weekday selection to a sorted, de-duplicated tuple."""
    if weekdays is None:
        weekdays = ()
    if not isinstance(weekdays, (list, tuple, set, frozenset)):
        raise RecurrenceError("Weekdays must be a list/tuple/set of integers.")
    for value in weekdays:
        if not isinstance(value, int) or isinstance(value, bool):
            raise RecurrenceError("Weekdays must be integers (0 = Monday .. 6 = Sunday).")
        if not WEEKDAY_MIN <= value <= WEEKDAY_MAX:
            raise RecurrenceError(
                f"Weekday out of range 0..6: {value!r} (0 = Monday .. 6 = Sunday)."
            )
    return tuple(sorted(set(weekdays)))


def _iter_occurrence_dates(
    *,
    frequency,
    interval,
    weekdays,
    start_date,
    end_date,
):
    """Yield candidate calendar dates (local wall-clock) in ascending order.

    The sequence is rule-bounded: it stops after ``end_date`` when one is
    given, otherwise it is infinite and the caller MUST stop iterating via
    the bounded expansion window (or the count limit).
    """
    if frequency == DAILY:
        step = timedelta(days=interval)
        current = start_date
        while end_date is None or current <= end_date:
            yield current
            current += step
        return

    if frequency == WEEKLY:
        weekday_set = frozenset(weekdays)
        week_index = 0
        while True:
            # Weeks are anchored at the start date: week k begins
            # ``interval * k`` weeks after the start date, so the first
            # week is the start date's own week (occurrences only on days
            # at or after the start date, i.e. the start date is the first
            # actual occurrence).
            anchor = start_date + timedelta(weeks=interval * week_index)
            if end_date is not None and anchor > end_date:
                return
            for offset in range(7):
                current = anchor + timedelta(days=offset)
                if current.weekday() not in weekday_set:
                    continue
                if end_date is not None and current > end_date:
                    return
                yield current
            week_index += 1
        return

    # MONTHLY: same calendar day as the start date; months without that
    # day are skipped (never shifted to the month end).
    day = start_date.day
    start_month_index = start_date.year * 12 + (start_date.month - 1)
    month_index = 0
    while True:
        absolute_month = start_month_index + interval * month_index
        year, zero_based_month = divmod(absolute_month, 12)
        month = zero_based_month + 1
        if end_date is not None and date(year, month, 1) > end_date:
            return
        if day <= calendar.monthrange(year, month)[1]:
            current = date(year, month, day)
            if end_date is not None and current > end_date:
                return
            yield current
        month_index += 1


def calculate_recurrence_occurrences(
    *,
    recurrence_id,
    frequency,
    interval,
    weekdays,
    start_date,
    local_time,
    timezone_name,
    end_mode,
    end_date,
    occurrence_count,
    range_start,
    range_end,
) -> list[MeetingRecurrenceOccurrence]:
    """Expand a V1 recurrence for ONE explicitly bounded window.

    ``range_start`` / ``range_end`` are required, timezone-aware datetimes
    (an unbounded expansion is impossible by construction). The window is
    converted into the schedule's stored timezone before comparison.

    Returns the occurrences whose original local start falls inside the
    window (inclusive on both ends), in chronological order. Each carries
    the stable occurrence identity derived from its original scheduled
    start. Count semantics count ALL occurrences of the rule (including
    those before the window); end date semantics are inclusive.
    """
    if recurrence_id is None:
        raise RecurrenceError(
            "A persisted schedule id is required to derive stable occurrence identities."
        )
    if not isinstance(range_start, datetime) or not isinstance(range_end, datetime):
        raise RecurrenceError("Expansion range boundaries must be datetimes.")
    if range_start.tzinfo is None or range_end.tzinfo is None:
        raise RecurrenceError(
            "Expansion range boundaries must be timezone-aware datetimes."
        )

    normalized_weekdays = validate_recurrence_definition(
        frequency=frequency,
        interval=interval,
        weekdays=weekdays,
        start_date=start_date,
        local_time=local_time,
        timezone_name=timezone_name,
        end_mode=end_mode,
        end_date=end_date,
        occurrence_count=occurrence_count,
    )

    tz = ZoneInfo(timezone_name)
    range_start_local = range_start.astimezone(tz).replace(tzinfo=None)
    range_end_local = range_end.astimezone(tz).replace(tzinfo=None)
    if range_start_local > range_end_local:
        raise RecurrenceError(
            "The expansion range start must not be after the range end."
        )

    occurrences: list[MeetingRecurrenceOccurrence] = []
    emitted = 0
    for candidate_date in _iter_occurrence_dates(
        frequency=frequency,
        interval=interval,
        weekdays=normalized_weekdays,
        start_date=start_date,
        end_date=end_date if end_mode == END_END_DATE else None,
    ):
        if (
            end_mode == END_COUNT
            and emitted >= occurrence_count
        ):
            break

        local_start = datetime.combine(candidate_date, local_time)
        if local_start > range_end_local:
            break
        # Count is the TOTAL number of meetings of the rule, including the
        # first — occurrences before the window consume the count too.
        emitted += 1
        if local_start < range_start_local:
            continue

        occurrences.append(
            MeetingRecurrenceOccurrence(
                occurrence_id=derive_occurrence_identity(
                    recurrence_id=recurrence_id,
                    original_local=local_start,
                    timezone_name=timezone_name,
                ),
                original_local=local_start,
                original_start=local_start.replace(tzinfo=tz),
            )
        )

    return occurrences