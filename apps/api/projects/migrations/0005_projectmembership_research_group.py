"""Persisted membership/scope integrity for ProjectMembership.

- Adds ProjectMembership.research_group (denormalized scope link,
  always equal to project.research_group).
- Adds UniqueConstraint (id, research_group) on projects_project as the
  composite-FK target.
- Adds composite foreign keys so a ProjectMembership can never validly
  reference a user outside the Project's Research Group:
    (project_id, research_group_id) -> projects_project
        (id, research_group_id)  ON DELETE CASCADE
    (research_group_id, user_id) -> research_groups_membership
        (research_group_id, user_id)  ON DELETE RESTRICT

The ON DELETE RESTRICT side makes ResearchGroupMembership removal
require explicit ProjectMembership cleanup (the offboarding service
performs that cleanup in the same transaction).

Non-destructive: only backfills the new column from existing
(project -> research_group) relationships.
"""

import django.db.models.deletion
from django.db import migrations, models


def backfill_research_group(apps, schema_editor):
    ProjectMembership = apps.get_model("projects", "ProjectMembership")
    for membership in ProjectMembership.objects.select_related("project"):
        membership.research_group_id = membership.project.research_group_id
        membership.save(update_fields=["research_group_id"])


def unbackfill_research_group(apps, schema_editor):
    ProjectMembership = apps.get_model("projects", "ProjectMembership")
    ProjectMembership.objects.update(research_group_id=None)


ADD_COMPOSITE_FKS = """
ALTER TABLE projects_membership
    ADD CONSTRAINT projects_membership_project_group_pinned
    FOREIGN KEY (project_id, research_group_id)
    REFERENCES projects_project (id, research_group_id)
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE projects_membership
    ADD CONSTRAINT projects_membership_group_user_pinned
    FOREIGN KEY (research_group_id, user_id)
    REFERENCES research_groups_membership (research_group_id, user_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION;
"""

DROP_COMPOSITE_FKS = """
ALTER TABLE projects_membership
    DROP CONSTRAINT IF EXISTS projects_membership_group_user_pinned;

ALTER TABLE projects_membership
    DROP CONSTRAINT IF EXISTS projects_membership_project_group_pinned;
"""


class Migration(migrations.Migration):

    dependencies = [
        ("projects", "0004_workitemlabeldefinition_workitemstatusdefinition_and_more"),
        ("research_groups", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="projectmembership",
            name="research_group",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.RESTRICT,
                related_name="+",
                to="research_groups.researchgroup",
            ),
        ),
        migrations.RunPython(backfill_research_group, unbackfill_research_group),
        migrations.AlterField(
            model_name="projectmembership",
            name="research_group",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.RESTRICT,
                related_name="+",
                to="research_groups.researchgroup",
            ),
        ),
        migrations.AddConstraint(
            model_name="project",
            constraint=models.UniqueConstraint(
                fields=["id", "research_group"],
                name="projects_project_id_research_group_uniq",
            ),
        ),
        migrations.RunSQL(ADD_COMPOSITE_FKS, DROP_COMPOSITE_FKS),
    ]
