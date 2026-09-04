"""Note -> Work Item primary link on MeetingItemWorkItem.

Adds the nullable ``meeting_note`` reference (canonical
MeetingItem -> MeetingNote -> WorkItem traceability) and the
unique constraint enforcing at most one primary WorkItem per
MeetingNote.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("meetings", "0007_add_meeting_note"),
    ]

    operations = [
        migrations.AddField(
            model_name="meetingitemworkitem",
            name="meeting_note",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.CASCADE,
                related_name="work_item_relations",
                to="meetings.meetingnote",
            ),
        ),
        migrations.AddConstraint(
            model_name="meetingitemworkitem",
            constraint=models.UniqueConstraint(
                fields=["meeting_note"],
                name="meetings_item_work_item_unique_note",
            ),
        ),
    ]
