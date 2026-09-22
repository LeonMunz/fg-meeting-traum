"""Canonical series title for MeetingRecurrence.

MeetingRecurrence now owns the canonical title of the recurring series:
it identifies the series even when zero Meetings have been materialized
and is the default title of a Meeting when a future occurrence is
materialized.

The column is added NULLABLE first so the schema step is safe on an
existing table, a data step backfills each recurrence that has
materialized Meetings from the title of its EARLIEST materialized
Meeting (deterministic: smallest ``original_scheduled_at``, then id),
and a final ``SET NOT NULL`` enforces the new persisted invariant.

Before this slice the domain creation service took no title at all, so
for a zero-materialization recurrence no user-authored title ever
existed in the database. Such a recurrence is a VALID historical state
(the old service could create recurrences without materializing any
occurrence), so the backfill must not fail on it: a legacy recurrence
with no materialized Meeting receives a DETERMINISTIC, migration-only
descriptive title derived from its own persisted schedule
(``Recurring meeting · <start_date> <local_time HH:MM>``). The value is
derived from stored fields only (locale- and timezone-independent), is
shorter than the column's max length, and never claims a Meeting or
Template title that never existed. It is strictly legacy-data
remediation: the model keeps a required ``title`` with NO permanent
default, and every new recurrence must provide a real title through
the domain creation service. Rows that somehow already carry a title
are left untouched (the backfill only writes ``NULL`` rows).
"""

from django.db import migrations, models


def _legacy_schedule_title(start_date, local_time):
    """Deterministic migration-only title for a legacy recurrence that
    has no materialized Meeting to copy a real title from.

    Derived purely from the recurrence's own persisted schedule fields:
    locale-independent, timezone-independent, stable across re-runs,
    and bounded far below the column's max length.
    """
    return (
        f"Recurring meeting · {start_date.isoformat()} "
        f"{local_time.isoformat(timespec='minutes')}"
    )


def _backfill_recurrence_titles(apps, schema_editor):
    """Backfill each NULL-titled legacy recurrence.

    Preferred source: the title of the EARLIEST materialized Meeting
    (canonical occurrence order: smallest ``original_scheduled_at``,
    then id). Fallback (zero materialized Meetings): the deterministic
    migration-only schedule title. Already-populated titles are never
    rewritten.
    """
    meetingrecurrence = apps.get_model("meetings", "MeetingRecurrence")
    meeting = apps.get_model("meetings", "Meeting")

    for recurrence in meetingrecurrence.objects.filter(title__isnull=True):
        first_title = (
            meeting.objects.filter(recurrence=recurrence)
            .order_by("original_scheduled_at", "id")
            .values_list("title", flat=True)
            .first()
        )
        if not first_title:
            # Zero materialized Meetings: a valid pre-slice state with
            # no real title source. Persist the deterministic
            # migration-only schedule title instead of failing.
            first_title = _legacy_schedule_title(
                recurrence.start_date, recurrence.local_time,
            )
        recurrence.title = first_title
        recurrence.save(update_fields=["title"])


def _reverse_backfill_recurrence_titles(apps, schema_editor):
    meetingrecurrence = apps.get_model("meetings", "MeetingRecurrence")
    meetingrecurrence.objects.update(title=None)


class Migration(migrations.Migration):

    dependencies = [
        ("meetings", "0017_alter_meeting_status"),
    ]

    operations = [
        migrations.AddField(
            model_name="meetingrecurrence",
            name="title",
            field=models.CharField(max_length=255, null=True),
        ),
        migrations.RunPython(
            _backfill_recurrence_titles,
            _reverse_backfill_recurrence_titles,
        ),
        migrations.RunSQL(
            sql=(
                'ALTER TABLE "meetings_recurrence" '
                'ALTER COLUMN "title" SET NOT NULL;'
            ),
            reverse_sql=(
                'ALTER TABLE "meetings_recurrence" '
                'ALTER COLUMN "title" DROP NOT NULL;'
            ),
        ),
        # State: record that the field is now NOT NULL so the migration
        # state matches the model (keeps makemigrations --check clean).
        migrations.AlterField(
            model_name="meetingrecurrence",
            name="title",
            field=models.CharField(max_length=255),
        ),
    ]
