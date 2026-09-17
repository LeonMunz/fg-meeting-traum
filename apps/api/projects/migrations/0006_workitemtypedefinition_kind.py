"""Stable semantic kind for canonical Work Item type definitions.

The display ``name`` of a WorkItemTypeDefinition is presentation
metadata and is never an authoritative source for semantic kind —
including during data migration. This migration only adds the stable,
machine-readable ``kind`` column (task / epic / milestone /
deliverable), nullable.

Why there is no data backfill
-----------------------------

Semantic provenance for pre-existing rows cannot be recovered from
any machine-readable historical source:

- The only legacy machine-readable type values ever persisted were
  the ``WorkItem.type`` choices (``epic`` / ``milestone`` /
  ``deliverable`` / ``task``, ``work_items/0001``).
  ``work_items/0003`` created the canonical default definitions per
  Project and mapped WorkItems from those values onto definitions by
  display name; ``work_items/0004`` then dropped the legacy ``type``
  column. The machine values never lived on the definitions, and no
  column on ``projects_workitem_type_definition`` records which legacy
  value a row was created from (or whether the system — as opposed to
  an owner — created it).
- The surviving fields on a definition row (``name``, ``order``,
  ``active``, ``created_at``, and the sequence ``id``) are mutable
  presentation/configuration state or creation-order state.
  Classifying by any combination of them — exact name, name + order,
  name + project age, the "exact four-name set", lowest-ID order —
  would attribute semantics from configuration state: an
  owner-created custom type named exactly "Task" would be
  misclassified, and a renamed canonical default would be lost.

Therefore every pre-existing row keeps ``kind = NULL``. This is the
deliberately conservative outcome: false negatives are acceptable,
false semantic attribution is not. Canonical kinds are assigned only
going forward, at Project creation (the service creates the very rows
it classifies); legacy definitions without provable semantic
provenance remain unclassified.

Existing Projects that need canonical kinds for local visual testing
can be repaired by a separate, explicitly-run local data fix — never
by this schema migration.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("projects", "0005_projectmembership_research_group"),
    ]

    operations = [
        migrations.AddField(
            model_name="workitemtypedefinition",
            name="kind",
            field=models.CharField(
                blank=True,
                choices=[
                    ("task", "Task"),
                    ("epic", "Epic"),
                    ("milestone", "Milestone"),
                    ("deliverable", "Deliverable"),
                ],
                max_length=16,
                null=True,
            ),
        ),
    ]
