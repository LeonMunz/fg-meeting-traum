from django.db import migrations


STATUS_MAPPING = {
    "open": "not_discussed",
    "discussed": "done",
}


def map_legacy_statuses(apps, schema_editor):
    MeetingItem = apps.get_model("meetings", "MeetingItem")
    for legacy, canonical in STATUS_MAPPING.items():
        MeetingItem.objects.filter(status=legacy).update(
            status=canonical
        )


def noop(apps, schema_editor):
    return None


class Migration(migrations.Migration):

    dependencies = [
        ("meetings", "0009_alter_meetingitem_status_and_more"),
    ]

    operations = [
        migrations.RunPython(map_legacy_statuses, noop),
    ]
