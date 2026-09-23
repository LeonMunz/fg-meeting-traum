"""API tests for the MeetingRecurrence creation endpoint.

``POST /api/meeting-recurrences/`` creates a recurring-meeting schedule
from an existing Meeting Template plus an explicit series title and a V1
recurrence rule. The Template determines the recurrence's canonical
group/project scope (the client never sends ownership fields), the view
resolves and authorizes the Template with the existing MeetingSeries
conventions, and creation delegates entirely to
``create_meeting_recurrence``. Creating a recurrence persists exactly one
``MeetingRecurrence`` and NEVER materializes a Meeting.
"""

import json
from datetime import date, time

from audit_history.models import AuditEvent
from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APIClient

from projects.services import archive_project

from .models import (
    Meeting,
    MeetingParticipant,
    MeetingRecurrence,
    MeetingRecurrenceParticipant,
    MeetingSection,
)
from .services import materialize_meeting_recurrence_occurrence
from .tests_recurrence import MeetingRecurrenceBase, UTC, _utc

User = get_user_model()


class MeetingRecurrenceCreateApiTest(MeetingRecurrenceBase):
    """POST /api/meeting-recurrences/ — canonical creation contract."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        # A group-scoped Meeting Template (default content source).
        self.series = self._create_series()

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _daily_payload(self, **overrides):
        data = {
            "meetingSeriesId": self.series.pk,
            "title": "Daily Standup",
            "frequency": "daily",
            "interval": 1,
            "startDate": "2026-01-05",  # Monday
            "localTime": "09:30",
            "timezone": "Europe/Berlin",
        }
        data.update(overrides)
        return data

    def _weekly_payload(self, **overrides):
        data = {
            "meetingSeriesId": self.series.pk,
            "title": "Weekly Research Sync",
            "frequency": "weekly",
            "interval": 1,
            "weekdays": [1],  # Tuesday
            "startDate": "2026-09-29",  # Tuesday
            "localTime": "10:00",
            "timezone": "Europe/Berlin",
        }
        data.update(overrides)
        return data

    def _post(self, payload):
        return self.client.post(
            "/api/meeting-recurrences/",
            data=json.dumps(payload),
            content_type="application/json",
        )

    def _occurrence_path(self, recurrence):
        return (
            f"/api/meeting-recurrences/{recurrence.pk}"
            "/occurrences/materialize/"
        )

    def _utc_iso(self, occurrence):
        return (
            occurrence.original_start.astimezone(_utc(2026, 1, 1).tzinfo)
            .isoformat()
            .replace("+00:00", "Z")
        )

    def _materialize_first(self, recurrence, *, title=None):
        occurrence = self._first_occurrence(recurrence)
        payload = {
            "occurrenceId": str(occurrence.occurrence_id),
            "originalScheduledAt": self._utc_iso(occurrence),
        }
        if title is not None:
            payload["title"] = title
        return self.client.post(
            self._occurrence_path(recurrence),
            data=json.dumps(payload),
            content_type="application/json",
        )

    def _persistence_counts(self):
        return {
            "recurrences": MeetingRecurrence.objects.count(),
            "meetings": Meeting.objects.count(),
            "sections": MeetingSection.objects.count(),
            "participants": MeetingParticipant.objects.count(),
            "audit_events": AuditEvent.objects.count(),
        }

    # ── 1-7. Valid creation → 201 + response contract ─────────────

    def test_valid_daily_recurrence_created_with_201(self):
        self.login(self.alex)
        response = self._post(self._daily_payload())
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(MeetingRecurrence.objects.count(), 1)

    def test_valid_weekly_recurrence_created_with_201(self):
        self.login(self.alex)
        response = self._post(self._weekly_payload())
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(MeetingRecurrence.objects.count(), 1)

    def test_valid_monthly_recurrence_created_with_201(self):
        self.login(self.alex)
        # Day 31: a later month without day 31 is skipped on expansion.
        response = self._post(
            self._daily_payload(frequency="monthly", startDate="2026-01-31"),
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(recurrence.frequency, "monthly")

    def test_response_contains_canonical_recurrence_id(self):
        self.login(self.alex)
        response = self._post(self._daily_payload())
        self.assertEqual(response.json()["id"], MeetingRecurrence.objects.get().pk)

    def test_response_contains_explicit_series_title(self):
        self.login(self.alex)
        # Deliberately different from the Template name, and padded.
        response = self._post(self._daily_payload(title="  My Series Title  "))
        self.assertEqual(response.json()["title"], "My Series Title")

    def test_response_references_selected_template(self):
        self.login(self.alex)
        response = self._post(self._daily_payload())
        data = response.json()
        self.assertEqual(data["meetingSeriesId"], self.series.pk)
        self.assertEqual(data["id"], MeetingRecurrence.objects.get().pk)

    def test_response_carries_rule_fields(self):
        self.login(self.alex)
        response = self._post(
            self._weekly_payload(
                interval=2, weekdays=[1, 3], endDate="2026-12-15",
            ),
        )
        data = response.json()
        self.assertEqual(data["frequency"], "weekly")
        self.assertEqual(data["interval"], 2)
        self.assertEqual(data["weekdays"], [1, 3])
        self.assertEqual(data["startDate"], "2026-09-29")
        self.assertEqual(data["localTime"], "10:00:00")
        self.assertEqual(data["timezone"], "Europe/Berlin")
        self.assertEqual(data["endDate"], "2026-12-15")
        self.assertIsNone(data["count"])

    # ── 8-16. Persistence ────────────────────────────────────────

    def test_persisted_title_is_normalized(self):
        self.login(self.alex)
        self._post(self._daily_payload(title="  Trimmed Title  "))
        self.assertEqual(
            MeetingRecurrence.objects.get().title, "Trimmed Title",
        )

    def test_persisted_template_reference(self):
        self.login(self.alex)
        self._post(self._daily_payload())
        self.assertEqual(
            MeetingRecurrence.objects.get().series, self.series,
        )

    def test_group_scoped_template_derives_group_scope(self):
        self.login(self.alex)
        self._post(self._daily_payload())
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(recurrence.scope, "group")
        self.assertIsNone(recurrence.project)
        self.assertEqual(recurrence.research_group, self.group)

    def test_project_scoped_template_derives_project_scope(self):
        project_series = self._create_series(
            scope="project", project=self.project,
        )
        self.login(self.alex)
        self._post(
            self._daily_payload(meetingSeriesId=project_series.pk),
        )
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(recurrence.scope, "project")
        self.assertEqual(recurrence.project, self.project)
        self.assertEqual(recurrence.research_group, self.group)
        self.assertEqual(recurrence.series, project_series)

    def test_interval_persists(self):
        self.login(self.alex)
        self._post(self._daily_payload(interval=3))
        self.assertEqual(MeetingRecurrence.objects.get().interval, 3)

    def test_weekdays_persist_canonically(self):
        # Sent unsorted with a duplicate; the domain normalizes.
        self.login(self.alex)
        self._post(self._weekly_payload(weekdays=[3, 1, 1]))  # Thu, Tue, Tue
        self.assertEqual(MeetingRecurrence.objects.get().weekdays, [1, 3])

    def test_start_date_persists(self):
        self.login(self.alex)
        self._post(self._daily_payload())
        self.assertEqual(
            MeetingRecurrence.objects.get().start_date, date(2026, 1, 5),
        )

    def test_local_time_persists(self):
        self.login(self.alex)
        self._post(self._daily_payload(localTime="09:30"))
        self.assertEqual(
            MeetingRecurrence.objects.get().local_time, time(9, 30),
        )

    def test_iana_timezone_persists(self):
        self.login(self.alex)
        self._post(self._daily_payload(timezone="America/New_York"))
        self.assertEqual(
            MeetingRecurrence.objects.get().timezone_name, "America/New_York",
        )

    # ── 17-19. End semantics ─────────────────────────────────────

    def test_end_date_persists_and_is_inclusive(self):
        self.login(self.alex)
        self._post(self._daily_payload(endDate="2026-01-07"))  # Mon..Wed
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(recurrence.end_date, date(2026, 1, 7))
        self.assertEqual(recurrence.end_mode, "end_date")
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 8, 23, 59),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7)],
        )

    def test_count_persists_and_includes_first(self):
        self.login(self.alex)
        self._post(self._daily_payload(count=3))
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(recurrence.occurrence_count, 3)
        self.assertEqual(recurrence.end_mode, "count")
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 20),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7)],
        )

    def test_no_end_recurrence(self):
        self.login(self.alex)
        self._post(self._daily_payload())
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(recurrence.end_mode, "no_end")
        self.assertIsNone(recurrence.end_date)
        self.assertIsNone(recurrence.occurrence_count)

    # ── 35-39. No materialization on creation ────────────────────

    def test_creation_persists_exactly_one_recurrence_and_no_side_effects(self):
        self.login(self.alex)
        response = self._post(self._daily_payload())
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(self._persistence_counts(), {
            "recurrences": 1,
            "meetings": 0,
            "sections": 0,
            "participants": 0,
            "audit_events": 0,
        })

    # ── 40-45. Created recurrence works with the existing APIs ──

    def test_created_recurrence_readable_via_bounded_occurrence_get(self):
        self.login(self.alex)
        self._post(self._daily_payload())
        recurrence = MeetingRecurrence.objects.get()
        response = self.client.get(
            f"/api/meeting-recurrences/{recurrence.pk}/occurrences/",
            {
                "from": _utc(2026, 1, 5, 0, 0).isoformat(),
                "to": _utc(2026, 1, 6, 0, 0).isoformat(),
            },
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        items = response.json()
        self.assertEqual(len(items), 1)
        self.assertFalse(items[0]["materialized"])
        self.assertIsNone(items[0]["meetingId"])

    def test_daily_interval_expansion(self):
        self.login(self.alex)
        self._post(self._daily_payload(interval=2))
        recurrence = MeetingRecurrence.objects.get()
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 5), _utc(2026, 1, 12),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [
                date(2026, 1, 5), date(2026, 1, 7),
                date(2026, 1, 9), date(2026, 1, 11),
            ],
        )

    def test_weekly_multiple_weekday_expansion(self):
        self.login(self.alex)
        self._post(self._weekly_payload(weekdays=[1, 3]))  # Tue + Thu
        recurrence = MeetingRecurrence.objects.get()
        occurrences = self._expand(
            recurrence, _utc(2026, 9, 29), _utc(2026, 10, 9),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [
                date(2026, 9, 29), date(2026, 10, 1),
                date(2026, 10, 6), date(2026, 10, 8),
            ],
        )

    def test_monthly_invalid_day_of_month_is_skipped_not_clamped(self):
        self.login(self.alex)
        # Day 31: Jan 31 exists, Feb 2026 (28 days) is skipped, Mar 31 exists.
        self._post(self._daily_payload(frequency="monthly", startDate="2026-01-31"))
        recurrence = MeetingRecurrence.objects.get()
        occurrences = self._expand(
            recurrence, _utc(2026, 1, 31), _utc(2026, 4, 1),
        )
        self.assertEqual(
            [o.original_date for o in occurrences],
            [date(2026, 1, 31), date(2026, 3, 31)],
        )

    def test_second_valid_post_creates_distinct_recurrence(self):
        self.login(self.alex)
        first = self._post(self._daily_payload(title="Series"))
        second = self._post(self._daily_payload(title="Series"))
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)
        self.assertEqual(second.status_code, status.HTTP_201_CREATED)
        self.assertEqual(MeetingRecurrence.objects.count(), 2)
        self.assertNotEqual(first.json()["id"], second.json()["id"])

    # ── 46-48. Later materialization of an API-created recurrence ─

    def test_materialize_api_created_recurrence_via_existing_endpoint(self):
        self.login(self.alex)
        self._post(self._daily_payload(title="Standup Series"))
        recurrence = MeetingRecurrence.objects.get()
        response = self._materialize_first(recurrence, title="Standup Series")
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Meeting.objects.get().recurrence, recurrence)

    def test_materialized_meeting_defaults_to_recurrence_title(self):
        self.login(self.alex)
        self._post(self._daily_payload(title="Standup Series"))
        recurrence = MeetingRecurrence.objects.get()
        # Domain-level default: no explicit title → recurrence.title.
        occurrence = self._first_occurrence(recurrence)
        meeting = materialize_meeting_recurrence_occurrence(
            recurrence=recurrence,
            occurrence=occurrence,
            actor=self.alex,
        )
        self.assertEqual(meeting.title, "Standup Series")

    def test_materialized_meeting_snapshots_selected_template(self):
        self.login(self.alex)
        self._post(self._daily_payload(title="Standup Series"))
        recurrence = MeetingRecurrence.objects.get()
        response = self._materialize_first(recurrence, title="Standup Series")
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        meeting = Meeting.objects.get()
        # The Meeting carries the Template provenance and snapshots its
        # ACTIVE sections (the fixture Template has one "Agenda" section).
        self.assertEqual(meeting.series_id, self.series.pk)
        self.assertEqual(
            list(
                MeetingSection.objects.filter(meeting=meeting)
                .order_by("position", "id")
                .values_list("name", flat=True),
            ),
            ["Agenda"],
        )


class MeetingRecurrenceCreateValidationTest(MeetingRecurrenceBase):
    """Invalid requests → 400, with zero recurrence + zero Meeting side
    effects. Rule invariants are enforced by the domain service."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.series = self._create_series()
        self.client.force_login(self.alex)

    def _post(self, payload):
        return self.client.post(
            "/api/meeting-recurrences/",
            data=json.dumps(payload),
            content_type="application/json",
        )

    def _assert_rejected(self, payload):
        response = self._post(payload)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(MeetingRecurrence.objects.count(), 0)
        self.assertEqual(Meeting.objects.count(), 0)

    def _daily(self, **overrides):
        data = {
            "meetingSeriesId": self.series.pk,
            "title": "Daily Standup",
            "frequency": "daily",
            "interval": 1,
            "startDate": "2026-01-05",
            "localTime": "09:30",
            "timezone": "Europe/Berlin",
        }
        data.update(overrides)
        return data

    def test_missing_template_rejected(self):
        payload = self._daily()
        del payload["meetingSeriesId"]
        self._assert_rejected(payload)

    def test_blank_title_rejected(self):
        self._assert_rejected(self._daily(title="   "))

    def test_too_long_title_rejected(self):
        self._assert_rejected(self._daily(title="t" * 256))

    def test_unsupported_frequency_rejected(self):
        self._assert_rejected(self._daily(frequency="yearly"))

    def test_zero_interval_rejected(self):
        self._assert_rejected(self._daily(interval=0))

    def test_negative_interval_rejected(self):
        self._assert_rejected(self._daily(interval=-3))

    def test_malformed_date_rejected(self):
        self._assert_rejected(self._daily(startDate="2026-13-45"))

    def test_malformed_local_time_rejected(self):
        self._assert_rejected(self._daily(localTime="25:00"))

    def test_invalid_timezone_rejected(self):
        self._assert_rejected(self._daily(timezone="Not/AZone"))

    def test_zero_count_rejected(self):
        self._assert_rejected(self._daily(count=0))

    def test_negative_count_rejected(self):
        self._assert_rejected(self._daily(count=-1))

    def test_count_and_end_date_together_rejected(self):
        self._assert_rejected(
            self._daily(count=3, endDate="2026-01-10"),
        )

    def test_end_date_before_start_rejected(self):
        self._assert_rejected(self._daily(endDate="2026-01-01"))

    def test_weekly_empty_weekdays_rejected(self):
        self._assert_rejected(self._daily(
            frequency="weekly", startDate="2026-09-29", weekdays=[],
        ))

    def test_weekly_invalid_weekday_rejected(self):
        self._assert_rejected(self._daily(
            frequency="weekly", startDate="2026-09-29", weekdays=[9],
        ))

    def test_weekly_start_day_not_in_pattern_rejected(self):
        # Start is a Monday (weekday 0) but only Tuesday (1) is selected.
        self._assert_rejected(self._daily(
            frequency="weekly", startDate="2026-01-05", weekdays=[1],
        ))

    def test_monthly_with_weekdays_rejected(self):
        self._assert_rejected(
            self._daily(frequency="monthly", weekdays=[1]),
        )

    def test_unknown_template_is_non_leaking_404(self):
        response = self._post(self._daily(meetingSeriesId=999999))
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(response.json(), {"error": "Meeting series not found"})
        self.assertEqual(MeetingRecurrence.objects.count(), 0)
        self.assertEqual(Meeting.objects.count(), 0)


class MeetingRecurrenceCreateAuthorizationTest(MeetingRecurrenceBase):
    """Authorization: reuse the MeetingSeries visibility/write conventions
    before the write, then the canonical domain write rule."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.group_series = self._create_series()
        self.project_series = self._create_series(
            scope="project", project=self.project,
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _post(self, series):
        return self.client.post(
            "/api/meeting-recurrences/",
            data=json.dumps({
                "meetingSeriesId": series.pk,
                "title": "Series",
                "frequency": "daily",
                "interval": 1,
                "startDate": "2026-01-05",
                "localTime": "09:30",
                "timezone": "Europe/Berlin",
            }),
            content_type="application/json",
        )

    def test_anonymous_denied(self):
        self.client.logout()
        response = self._post(self.group_series)
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_authorized_group_member_succeeds(self):
        # chris is an ordinary group MEMBER: a group-scoped Template is
        # writable by any group read member.
        self.login(self.chris)
        response = self._post(self.group_series)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_authorized_project_owner_succeeds(self):
        self.login(self.alex)  # project owner
        response = self._post(self.project_series)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_authorized_project_member_succeeds(self):
        self.login(self.chris)  # project member
        response = self._post(self.project_series)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_visible_project_viewer_denied(self):
        # laura is a group member + project VIEWER: she can read the
        # project Template but not write it.
        self.login(self.laura)
        response = self._post(self.project_series)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_archived_project_denied(self):
        archive_project(project=self.project, actor=self.alex)
        self.login(self.chris)  # member, but the Project is read-only now
        response = self._post(self.project_series)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_outsider_gets_non_leaking_404(self):
        # maria is not a member of the Research Group at all: both the
        # group and project Templates are invisible.
        self.login(self.maria)
        group_response = self._post(self.group_series)
        project_response = self._post(self.project_series)
        self.assertEqual(
            group_response.status_code, status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            project_response.status_code, status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(group_response.json(),
                         {"error": "Meeting series not found"})
        self.assertEqual(project_response.json(),
                         {"error": "Meeting series not found"})
        self.assertEqual(MeetingRecurrence.objects.count(), 0)


class MeetingRecurrenceCreateParticipantApiTest(MeetingRecurrenceBase):
    """POST /api/meeting-recurrences/ with optional ``participantIds``.

    The optional field resolves to existing application users with the
    ordinary Meeting-participant conventions and delegates to the
    domain service as ``participants``: the intent is persisted on the
    recurrence, broadens no authorization, and snapshots into concrete
    ``MeetingParticipant`` rows only when a future occurrence is
    materialized through the existing endpoint.
    """

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.group_series = self._create_series()
        self.project_series = self._create_series(
            scope="project", project=self.project,
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _payload(self, series=None, **overrides):
        data = {
            "meetingSeriesId": (series or self.group_series).pk,
            "title": "Daily Standup",
            "frequency": "daily",
            "interval": 1,
            "startDate": "2026-01-05",  # Monday
            "localTime": "09:30",
            "timezone": "Europe/Berlin",
        }
        data.update(overrides)
        return data

    def _post(self, payload):
        return self.client.post(
            "/api/meeting-recurrences/",
            data=json.dumps(payload),
            content_type="application/json",
        )

    def _recurrence_user_ids(self, recurrence):
        return sorted(
            MeetingRecurrenceParticipant.objects.filter(
                recurrence=recurrence,
            ).values_list("user_id", flat=True)
        )

    def _meeting_user_ids(self, meeting):
        return sorted(
            MeetingParticipant.objects.filter(meeting=meeting)
            .values_list("user_id", flat=True)
        )

    def _materialize_first(self, recurrence, *, title="Standup Series"):
        occurrence = self._first_occurrence(recurrence)
        original = occurrence.original_start.astimezone(UTC)
        payload = {
            "occurrenceId": str(occurrence.occurrence_id),
            "originalScheduledAt": original.isoformat().replace(
                "+00:00", "Z",
            ),
            "title": title,
        }
        return self.client.post(
            f"/api/meeting-recurrences/{recurrence.pk}"
            "/occurrences/materialize/",
            data=json.dumps(payload),
            content_type="application/json",
        )

    # ── Valid creation with the optional field ───────────────────

    def test_omitted_participant_ids_default_to_empty_intent(self):
        self.login(self.alex)
        response = self._post(self._payload())
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(self._recurrence_user_ids(recurrence), [])

    def test_empty_participant_ids_persist_empty_intent(self):
        self.login(self.alex)
        response = self._post(self._payload(participantIds=[]))
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(self._recurrence_user_ids(recurrence), [])

    def test_single_participant_persists_intent(self):
        self.login(self.alex)
        response = self._post(
            self._payload(participantIds=[self.chris.pk]),
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(
            self._recurrence_user_ids(recurrence), [self.chris.pk],
        )

    def test_multiple_participants_persist_intent(self):
        self.login(self.alex)
        # maria is a group outsider: participant eligibility does not
        # require membership (same rule as ordinary Meeting creation).
        response = self._post(self._payload(
            participantIds=[self.chris.pk, self.maria.pk],
        ))
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(
            self._recurrence_user_ids(recurrence),
            [self.chris.pk, self.maria.pk],
        )

    def test_duplicate_participant_ids_persist_each_user_once(self):
        self.login(self.alex)
        response = self._post(self._payload(
            participantIds=[
                self.chris.pk, self.maria.pk, self.chris.pk,
            ],
        ))
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(
            MeetingRecurrenceParticipant.objects.filter(
                recurrence=recurrence,
            ).count(),
            2,
        )
        self.assertEqual(
            self._recurrence_user_ids(recurrence),
            [self.chris.pk, self.maria.pk],
        )

    def test_creator_id_in_participant_ids_is_valid(self):
        self.login(self.alex)
        response = self._post(self._payload(
            participantIds=[self.alex.pk, self.chris.pk],
        ))
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(
            self._recurrence_user_ids(recurrence),
            [self.alex.pk, self.chris.pk],
        )

    def test_participant_ids_persist_for_daily_weekly_and_monthly(self):
        self.login(self.alex)
        payloads = [
            self._payload(title="Daily"),
            self._payload(
                title="Weekly", frequency="weekly", weekdays=[0],
            ),
            self._payload(title="Monthly"),
        ]
        for payload in payloads:
            payload["participantIds"] = [self.chris.pk]
            response = self._post(payload)
            self.assertEqual(
                response.status_code, status.HTTP_201_CREATED,
            )
        recurrences = list(
            MeetingRecurrence.objects.order_by("id"),
        )
        self.assertEqual(len(recurrences), 3)
        for recurrence in recurrences:
            self.assertEqual(
                self._recurrence_user_ids(recurrence),
                [self.chris.pk],
            )

    # ── No materialization on creation ───────────────────────────

    def test_create_with_participants_persists_intent_but_no_meeting(self):
        self.login(self.alex)
        response = self._post(self._payload(
            participantIds=[self.chris.pk, self.maria.pk],
        ))
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(
            MeetingRecurrence.objects.count(), 1,
        )
        self.assertEqual(MeetingRecurrenceParticipant.objects.count(), 2)
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)

    # ── Invalid participant input ────────────────────────────────

    def _assert_participant_rejected(self, payload):
        response = self._post(payload)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("participantIds", response.json())
        # Nothing is persisted: no recurrence, no participant intent,
        # no Meeting.
        self.assertEqual(MeetingRecurrence.objects.count(), 0)
        self.assertEqual(MeetingRecurrenceParticipant.objects.count(), 0)
        self.assertEqual(Meeting.objects.count(), 0)
        self.assertEqual(MeetingParticipant.objects.count(), 0)

    def test_malformed_participant_id_rejected_atomically(self):
        self.login(self.alex)
        self._assert_participant_rejected(self._payload(
            participantIds=["not-a-user-id"],
        ))

    def test_unknown_participant_id_rejected_atomically(self):
        self.login(self.alex)
        missing_user_id = User.objects.order_by("-pk").first().pk + 1000
        self._assert_participant_rejected(self._payload(
            participantIds=[self.chris.pk, missing_user_id],
        ))

    # ── Scope derivation and authorization are unaffected ────────

    def test_participant_ids_do_not_affect_template_derived_scope(self):
        self.login(self.alex)
        group_response = self._post(self._payload(
            series=self.group_series,
            participantIds=[self.chris.pk, self.maria.pk],
        ))
        self.assertEqual(group_response.status_code, status.HTTP_201_CREATED)
        group_data = group_response.json()
        self.assertEqual(group_data["scope"], "group")
        self.assertIsNone(group_data["projectId"])

        project_response = self._post(self._payload(
            series=self.project_series,
            participantIds=[self.chris.pk, self.maria.pk],
        ))
        self.assertEqual(project_response.status_code, status.HTTP_201_CREATED)
        project_data = project_response.json()
        self.assertEqual(project_data["scope"], "project")
        self.assertEqual(project_data["projectId"], self.project.pk)

    def test_participant_ids_do_not_broaden_write_authorization(self):
        # A Project viewer listing participants is still denied...
        self.login(self.laura)
        response = self._post(self._payload(
            series=self.project_series,
            participantIds=[self.chris.pk, self.maria.pk],
        ))
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

        # ...and an archived Project stays read-only with or without
        # participants.
        archive_project(project=self.project, actor=self.alex)
        self.login(self.chris)
        response = self._post(self._payload(
            series=self.project_series,
            participantIds=[self.laura.pk],
        ))
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(MeetingRecurrence.objects.count(), 0)

    def test_listed_participant_gains_no_recurrence_access(self):
        # maria is listed as an intended participant of a
        # project-scoped series, but she is an outsider: the intent
        # grants no recurrence read/write access.
        self.login(self.alex)
        response = self._post(self._payload(
            series=self.project_series,
            participantIds=[self.maria.pk],
        ))
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()

        self.login(self.maria)
        occurrences_response = self.client.get(
            f"/api/meeting-recurrences/{recurrence.pk}/occurrences/",
            {
                "from": _utc(2026, 1, 5, 0, 0).isoformat(),
                "to": _utc(2026, 1, 6, 0, 0).isoformat(),
            },
        )
        self.assertEqual(
            occurrences_response.status_code, status.HTTP_404_NOT_FOUND,
        )

        occurrence = self._first_occurrence(recurrence)
        original = occurrence.original_start.astimezone(UTC)
        materialize_response = self.client.post(
            f"/api/meeting-recurrences/{recurrence.pk}"
            "/occurrences/materialize/",
            data=json.dumps({
                "occurrenceId": str(occurrence.occurrence_id),
                "originalScheduledAt": original.isoformat().replace(
                    "+00:00", "Z",
                ),
                "title": "No access",
            }),
            content_type="application/json",
        )
        self.assertEqual(
            materialize_response.status_code, status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(Meeting.objects.count(), 0)

    # ── API → materialization participant snapshot ───────────────

    def test_http_created_recurrence_materializes_participant_snapshot(self):
        self.login(self.alex)
        response = self._post(self._payload(
            participantIds=[self.chris.pk, self.maria.pk],
        ))
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(
            self._recurrence_user_ids(recurrence),
            [self.chris.pk, self.maria.pk],
        )

        materialize_response = self._materialize_first(recurrence)
        self.assertEqual(
            materialize_response.status_code, status.HTTP_201_CREATED,
        )
        meeting = Meeting.objects.get()
        # The concrete Meeting carries the creator plus the intended
        # participants, each exactly once (creator not duplicated).
        self.assertEqual(
            MeetingParticipant.objects.filter(meeting=meeting).count(),
            3,
        )
        self.assertEqual(
            self._meeting_user_ids(meeting),
            [self.alex.pk, self.chris.pk, self.maria.pk],
        )

    def test_creator_in_participant_ids_is_not_duplicated_on_materialization(self):
        self.login(self.alex)
        response = self._post(self._payload(
            participantIds=[self.alex.pk, self.chris.pk, self.alex.pk],
        ))
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(
            self._recurrence_user_ids(recurrence),
            [self.alex.pk, self.chris.pk],
        )

        materialize_response = self._materialize_first(recurrence)
        self.assertEqual(
            materialize_response.status_code, status.HTTP_201_CREATED,
        )
        meeting = Meeting.objects.get()
        self.assertEqual(
            MeetingParticipant.objects.filter(
                meeting=meeting, user=self.alex,
            ).count(),
            1,
        )
        self.assertEqual(
            self._meeting_user_ids(meeting),
            [self.alex.pk, self.chris.pk],
        )

    # ── Backward compatibility ───────────────────────────────────

    def test_old_client_without_participant_ids_remains_compatible(self):
        # A payload in the pre-participant contract still creates a
        # valid recurrence with an EMPTY intent set, and its
        # materialization yields exactly the creator.
        self.login(self.alex)
        response = self._post(self._payload())
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        recurrence = MeetingRecurrence.objects.get()
        self.assertEqual(self._recurrence_user_ids(recurrence), [])

        materialize_response = self._materialize_first(recurrence)
        self.assertEqual(
            materialize_response.status_code, status.HTTP_201_CREATED,
        )
        self.assertEqual(
            self._meeting_user_ids(Meeting.objects.get()),
            [self.alex.pk],
        )
