"""Whole-series termination state for MeetingRecurrence.

``MeetingRecurrence`` gains ONE nullable column: ``terminated_at``,
the IMMUTABLE effective termination instant of the whole series.

The column is added NULLABLE and NO data step is executed: every
existing recurrence row keeps ``terminated_at = NULL`` — i.e. it
migrates to the ACTIVE state unchanged (no historical row is touched,
no rule field is rewritten, and a naturally ended schedule is not
confused with an explicitly terminated one). From this migration on,
the single domain operation
``meetings.services.terminate_meeting_recurrence`` is the ONLY writer
of a non-NULL value: it observes the termination instant exactly once
and persists it atomically with the cancellation of every still-
upcoming materialized occurrence whose effective ``scheduled_at``
lies at or after it. There is no restore / reactivation, so a non-NULL
value is never cleared and never changed (no UPDATE data step, no
second writer).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("meetings", "0021_meetingitem_content"),
    ]

    operations = [
        migrations.AddField(
            model_name="meetingrecurrence",
            name="terminated_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
