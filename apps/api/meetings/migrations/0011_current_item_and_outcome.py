# Intentional replacement of the "discussing-as-item-status" model.
#
# - Meeting gains a persisted, optional current MeetingItem
#   (OneToOne, SET_NULL when the item is deleted).
# - MeetingItem.status is replaced by the canonical MeetingItem.outcome
#   ("not_discussed" | "done" | "follow_up").
# - Existing "discussing" rows represent the current agenda position,
#   not a completed outcome: the migration sets them as the Meeting's
#   current item and converts their outcome to "not_discussed".
# - The discussing-only unique constraint is removed.
#
# The legacy status column is kept until the data mapping (RunPython)
# has run, so no outcome data is lost.

import django.db.models.deletion
from django.db import migrations, models


def map_discussing_to_current_and_outcome(apps, schema_editor):
    Meeting = apps.get_model("meetings", "Meeting")
    MeetingItem = apps.get_model("meetings", "MeetingItem")

    # 1) A Meeting whose single discussing item marks the current
    #    agenda position gets that item as its current item. This
    #    must run BEFORE the outcome update, because "discussing"
    #    rows are mapped to "not_discussed" below.
    current_by_meeting = {}
    for meeting_id, item_pk in (
        MeetingItem.objects.filter(status="discussing")
        .values_list("meeting_id", "pk")
        .order_by("pk")
    ):
        current_by_meeting.setdefault(meeting_id, item_pk)
    for meeting_id, item_pk in current_by_meeting.items():
        Meeting.objects.filter(pk=meeting_id).update(
            current_meeting_item_id=item_pk
        )

    # 2) Carry the old status over as the new outcome for every item.
    #    "discussing" is a position marker, not an outcome, and maps
    #    to "not_discussed". done / follow_up / not_discussed survive.
    MeetingItem.objects.all().update(
        outcome=models.Case(
            models.When(
                status="discussing", then=models.Value("not_discussed")
            ),
            default=models.F("status"),
            output_field=models.CharField(max_length=16),
        )
    )



def reverse_data_mapping(apps, schema_editor):
    """Best-effort reverse: the exact pre-migration status of
    not_discussed rows (open vs. discussed is indistinguishable once
    mapped) is not reconstructable; only the deterministic parts are
    restored. Reversible in the schema sense via ``status`` restore
    below."""
    Meeting = apps.get_model("meetings", "Meeting")
    MeetingItem = apps.get_model("meetings", "MeetingItem")

    # Restore a usable status column: every current item becomes
    # "discussing" again (that is how "discussing" arose); all other
    # rows keep their outcome as the status.
    MeetingItem.objects.all().update(status=models.F("outcome"))
    for meeting in Meeting.objects.filter(
        current_meeting_item__isnull=False
    ).select_related("current_meeting_item"):
        MeetingItem.objects.filter(pk=meeting.current_meeting_item_id).update(
            status="discussing"
        )


class Migration(migrations.Migration):

    dependencies = [
        ("meetings", "0010_meetingitem_status_data_mapping"),
    ]

    operations = [
        # 1. Remove the old discussing-only unique constraint first:
        #    the data mapping below writes "not_discussed" outcomes,
        #    but the constraint must not apply to the new model.
        migrations.RemoveConstraint(
            model_name="meetingitem",
            name="meetings_item_single_discussing_per_meeting",
        ),
        # 2. Persist the current MeetingItem on the Meeting.
        migrations.AddField(
            model_name="meeting",
            name="current_meeting_item",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to="meetings.meetingitem",
            ),
        ),
        # 3. Canonical outcome field on MeetingItem.
        migrations.AddField(
            model_name="meetingitem",
            name="outcome",
            field=models.CharField(
                choices=[
                    ("not_discussed", "Not discussed"),
                    ("done", "Done"),
                    ("follow_up", "Follow-up"),
                ],
                default="not_discussed",
                max_length=16,
            ),
        ),
        # 4. Map legacy "discussing" rows:
        #    discussing -> current_meeting_item + outcome not_discussed.
        migrations.RunPython(
            map_discussing_to_current_and_outcome,
            reverse_data_mapping,
        ),
        # 5. Remove the now-redundant legacy status column.
        migrations.RemoveField(
            model_name="meetingitem",
            name="status",
        ),
    ]
