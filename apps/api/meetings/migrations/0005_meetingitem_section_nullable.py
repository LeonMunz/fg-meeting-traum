# MeetingItem now belongs to exactly one MeetingSection.

# Migration 0005 (of 0005/0006):
#   - add the meeting_section FK as NULLABLE
#   - backfill legacy flat MeetingItems
#
# The backfill is DATA ONLY. It intentionally performs no NOT NULL change
# and no constraint change, because on PostgreSQL setting a column NOT NULL
# revalidates the related foreign key, which cannot run while the deferred
# FK trigger events raised by this backfill are still pending. Enforcing
# NOT NULL + the final uniqueness constraint is deferred to 0006, which runs
# in a separate migration (separate transaction), after those events are
# resolved.

from django.db import migrations, models
import django.db.models.deletion


def _backfill_legacy_items(apps, schema_editor):
    """Attach pre-existing flat MeetingItems to a safe occurrence section.

    Idempotent by construction:
      * A Meeting that has NO sections at all gets exactly one
        occurrence-level "Unsectioned" section (position 0).
      * A Meeting that already has sections (e.g. snapshotted Series
        sections) does NOT get a new section; its flat items are left
        unassigned here (still NULL) and 0006 guarantees a valid section
        exists for them. We deliberately do NOT semantically assign legacy
        items to an arbitrary snapshotted Series section.
      * Items already linked to a section are never touched.
    """
    MeetingSection = apps.get_model("meetings", "MeetingSection")
    MeetingItem = apps.get_model("meetings", "MeetingItem")
    Meeting = apps.get_model("meetings", "Meeting")

    # Case 1: Meetings with flat items but no sections at all.
    meetings_without_sections = (
        Meeting.objects
        .filter(items__meeting_section__isnull=True)
        .annotate(section_count=models.Count("meeting_sections"))
        .filter(section_count=0)
        .distinct()
    )

    for meeting in meetings_without_sections:
        # Create exactly one occurrence-level section for this meeting.
        section = MeetingSection.objects.create(
            meeting=meeting,
            name="Unsectioned",
            description="",
            position=0,
            is_visible=True,
        )
        # Attach every unassigned flat item to it.
        MeetingItem.objects.filter(
            meeting=meeting,
            meeting_section__isnull=True,
        ).update(meeting_section=section)


def _unbackfill_legacy_items(apps, schema_editor):
    """Reverse: un-attach items that the backfill created."""
    MeetingItem = apps.get_model("meetings", "MeetingItem")
    MeetingSection = apps.get_model("meetings", "MeetingSection")

    # Only revert items that point at a section we created.
    unsectioned = MeetingSection.objects.filter(name="Unsectioned")
    ids = list(unsectioned.values_list("pk", flat=True))
    MeetingItem.objects.filter(
        meeting_section_id__in=ids,
    ).update(meeting_section=None)
    unsectioned.delete()


class Migration(migrations.Migration):
    # This migration's data backfill assigns meeting_section_id on rows that
    # already carry other deferred FK constraints, which raises deferred
    # trigger events on meetings_item. If 0005 were atomic (default), those
    # events would persist past the migration's commit and block 0006's
    # `ALTER TABLE` on the same table. Marking 0005 non-atomic lets the
    # backfill commit its trigger events so the subsequent 0006 (NOT NULL +
    # constraint swap, in its own transaction) can run cleanly.
    #
    # The only DDL here is the nullable AddField, which is safe on its own.
    atomic = False

    dependencies = [
        ("meetings", "0004_meeting_ended_at_meeting_started_at"),
    ]

    operations = [
        migrations.AddField(
            model_name="meetingitem",
            name="meeting_section",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="items",
                to="meetings.meetingsection",
            ),
        ),
        migrations.RunPython(
            _backfill_legacy_items,
            _unbackfill_legacy_items,
        ),
    ]
