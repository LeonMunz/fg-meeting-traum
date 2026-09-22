"""Canonical Meeting Template reference for MeetingRecurrence.

A NEW MeetingRecurrence owns one canonical reference to the existing
Meeting Template aggregate (``MeetingSeries``): the Template whose
active Sections are the content source for FUTURE materializations of
the schedule's occurrences.

The column is added NULLABLE and NO data step is executed. Every
recurrence row created before this slice legitimately predates the
Template linkage and keeps ``series = NULL`` — a documented legacy
compatibility state, not a defect: the migration deliberately does NOT
fabricate, guess, or backfill a Template reference, does not create
placeholder Templates, and touches no historical row (no deletions, no
rewrites). A legacy template-less recurrence keeps working for
everything that needs no content source (reads, virtual-occurrence
exclusion, and lifecycle operations on ALREADY-materialized Meetings),
and the domain creation service from this point on requires a valid,
persisted, scope-consistent Template for every NEW recurrence.

On-delete semantics are preservation, not destruction: deleting a
Template clears the referencing recurrence's reference (``SET_NULL``,
exactly like ``Meeting.series`` and ``MeetingSection.
source_series_section``) and never deletes the recurrence, its rule,
or its materialized Meetings.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("meetings", "0018_meetingrecurrence_title"),
    ]

    operations = [
        migrations.AddField(
            model_name="meetingrecurrence",
            name="series",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.deletion.SET_NULL,
                related_name="recurrences",
                to="meetings.meetingseries",
            ),
        ),
    ]
