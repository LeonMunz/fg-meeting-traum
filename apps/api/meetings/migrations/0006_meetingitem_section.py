# Finalize MeetingItem -> MeetingSection enforcement.

# Migration 0006 (of 0005/0006):
#   1. Guarantee every MeetingItem has a valid occurrence MeetingSection
#      (any still-unassigned legacy item is attached to a safe "Unsectioned"
#      section for its own Meeting -- never to an arbitrary snapshotted
#      Series section).
#   2. Flip `meeting_section` to NOT NULL.
#   3. Swap the legacy per-Meeting unique constraint for the final
#      per-Section unique constraint.
#
# Why the explicit FK drop/recreate around the NOT NULL change:
# Setting `meeting_section` NOT NULL is done via Django's AlterField, which
# for an FK field (1) drops the outgoing foreign-key constraint, (2) runs
# `ALTER COLUMN ... SET NOT NULL` (a table scan), and (3) re-creates the FK
# with `ADD CONSTRAINT ... FOREIGN KEY`. That recreation makes PostgreSQL
# validate every row in the child table; when legacy rows were just assigned
# in the 0005 backfill, that raises deferred trigger events that the
# in-transaction ALTER cannot complete (has pending trigger events).
#
# Deferring the NOT NULL to this migration alone is not enough, because those
# deferred events persist across commits. So the NOT NULL step is decoupled
# from the FK using SeparateDatabaseAndState: drop the FK, run
# `SET NOT NULL` (no FK to revalidate during the scan), then re-add the FK.
# With the FK gone when `SET NOT NULL` scans the table, no deferred FK
# trigger events are raised and the alter succeeds on a populated database.
#
# Combined with 0005 (nullable AddField + backfill), the final end state of
# `meeting_section` is exactly the model field: a NOT NULL FK to
# MeetingSection -- which is why `makemigrations --check` reports no changes.

from django.db import migrations, models
import django.db.models.deletion


def _ensure_all_items_sectioned(apps, schema_editor):
    """Attach any remaining unassigned MeetingItems to a valid section.

    0005 already handled Meetings that had no sections at all (they got an
    "Unsectioned" section and their flat items were attached). The only items
    that can still be NULL here are flat legacy items belonging to a Meeting
    that already has sections (e.g. snapshotted Series sections). We
    deliberately do NOT assign those to an arbitrary snapshotted section; we
    give their Meeting a dedicated occurrence-level "Unsectioned" section.

    Idempotent: re-running this never duplicates a section or reassigns an
    already-linked item.
    """
    MeetingSection = apps.get_model("meetings", "MeetingSection")
    MeetingItem = apps.get_model("meetings", "MeetingItem")
    Meeting = apps.get_model("meetings", "Meeting")

    unsectioned_pk_by_meeting = {}

    meeting_ids = list(
        MeetingItem.objects.filter(meeting_section__isnull=True)
        .values_list("meeting_id", flat=True)
        .distinct()
    )

    for meeting_id in meeting_ids:
        meeting = Meeting.objects.get(pk=meeting_id)
        section = MeetingSection.objects.filter(
            meeting=meeting, name="Unsectioned",
        ).first()
        if section is None:
            max_position = (
                MeetingSection.objects.filter(meeting=meeting)
                .aggregate(m=models.Max("position"))["m"]
            )
            section = MeetingSection.objects.create(
                meeting=meeting,
                name="Unsectioned",
                description="",
                position=(max_position + 1) if max_position is not None else 0,
                is_visible=True,
            )
        unsectioned_pk_by_meeting[meeting_id] = section.pk

    for meeting_id, section_pk in unsectioned_pk_by_meeting.items():
        MeetingItem.objects.filter(
            meeting_id=meeting_id,
            meeting_section__isnull=True,
        ).update(meeting_section_id=section_pk)

    remaining = MeetingItem.objects.filter(
        meeting_section__isnull=True
    ).count()
    if remaining:
        raise RuntimeError(
            "Legacy MeetingItem migration left %d item(s) without a "
            "MeetingSection; refusing to enforce NOT NULL." % remaining
        )


def _unensure_all_items_sectioned(apps, schema_editor):
    """Reverse: detach items from any "Unsectioned" sections we created."""
    MeetingItem = apps.get_model("meetings", "MeetingItem")
    MeetingSection = apps.get_model("meetings", "MeetingSection")

    unsectioned = MeetingSection.objects.filter(name="Unsectioned")
    ids = list(unsectioned.values_list("pk", flat=True))
    MeetingItem.objects.filter(meeting_section_id__in=ids).update(
        meeting_section_id=None
    )
    unsectioned.delete()


FK_DROP_SQL = (
    "ALTER TABLE \"meetings_item\" DROP CONSTRAINT IF EXISTS "
    "\"meetings_item_meeting_section_id_fkey\";"
)
FK_ADD_SQL = (
    "ALTER TABLE \"meetings_item\" ADD CONSTRAINT "
    "\"meetings_item_meeting_section_id_fkey\" FOREIGN KEY "
    "(\"meeting_section_id\") REFERENCES \"meetings_section\" (\"id\");"
)


class Migration(migrations.Migration):
    # 0005's backfill leaves deferred FK trigger events on meetings_item (its
    # own AddField validates the FK against existing rows). When 0006 re-adds
    # the meeting_section FK it validates all rows again, which queues more
    # deferred events; the final UNIQUE-constraint scan then cannot run while
    # those events are pending. Running 0006 non-atomic lets the FK re-add
    # commit its events before the unique constraint is created, so the whole
    # NOT NULL + constraint finalization succeeds on a populated database.
    #
    # 0005 + 0006 together are idempotent and ordered; a failure here would
    # leave the field still nullable (safe -- no NOT NULL lost), and re-running
    # the migration re-does the data fixup before retrying the schema change.
    atomic = False

    dependencies = [
        ("meetings", "0005_meetingitem_section_nullable"),
    ]

    operations = [
        migrations.RunPython(
            _ensure_all_items_sectioned,
            _unensure_all_items_sectioned,
        ),
        # Decouple the NOT NULL change from the FK so the table scan does not
        # revalidate a foreign key (avoids deferred trigger events).
        # Database: decouple the NOT NULL change from the FK (see above).
        migrations.RunSQL(sql=FK_DROP_SQL, reverse_sql=FK_ADD_SQL),
        migrations.RunSQL(
            sql="ALTER TABLE \"meetings_item\" ALTER COLUMN "
                "\"meeting_section_id\" SET NOT NULL;",
            reverse_sql="ALTER TABLE \"meetings_item\" ALTER COLUMN "
                "\"meeting_section_id\" DROP NOT NULL;",
        ),
        migrations.RunSQL(sql=FK_ADD_SQL, reverse_sql=FK_DROP_SQL),
        # State: record that the field is now NOT NULL so the migration
        # state matches the model (keeps makemigrations --check clean).
        migrations.AlterField(
            model_name="meetingitem",
            name="meeting_section",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="items",
                to="meetings.meetingsection",
            ),
        ),
        migrations.RemoveConstraint(
            model_name="meetingitem",
            name="meetings_item_unique_meeting_position",
        ),
        migrations.AddConstraint(
            model_name="meetingitem",
            constraint=models.UniqueConstraint(
                fields=("meeting_section", "position"),
                name="meetings_item_unique_section_position",
            ),
        ),
    ]
