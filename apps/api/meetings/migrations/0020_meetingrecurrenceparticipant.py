"""Canonical intended-participant persistence for MeetingRecurrence.

A MeetingRecurrence now owns a persisted set of intended Participants
for its FUTURE materialized occurrences (``MeetingRecurrenceParticipant``):
participant identity only, no per-occurrence attendance, RSVP, or
presence state.

The migration is a PURE table creation: no data step exists and none is
needed. Every existing recurrence row legitimately predates the
participant linkage and therefore carries an EMPTY participant set —
a documented legacy compatibility state, exactly like the nullable
Template reference (migration ``meetings/0019``). The migration
deliberately does NOT backfill the creator or any Meeting participant
into historical recurrences: there is no canonical invariant that a
legacy recurrence's intended set equals anything but empty, and no
historical row is touched (no deletions, no rewrites, no destructive
steps). All existing recurrences remain valid.

On-delete semantics follow the repository conventions: deleting a
recurrence removes its participant intent (CASCADE, the same
owner-deletion semantics as ``MeetingRecurrenceExclusion.recurrence``),
and deleting a User is blocked while an intent references it
(RESTRICT, the same convention as ``MeetingParticipant.user``).
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('meetings', '0019_meetingrecurrence_series'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='MeetingRecurrenceParticipant',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('recurrence', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='participant_relations', to='meetings.meetingrecurrence')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='recurrence_participations', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'meetings_recurrence_participant',
                'constraints': [models.UniqueConstraint(fields=('recurrence', 'user'), name='meetings_recurrence_participant_unique_recurrence_user')],
            },
        ),
    ]
