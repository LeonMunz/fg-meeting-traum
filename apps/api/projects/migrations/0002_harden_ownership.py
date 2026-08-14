"""Harden ProjectMembership ownership invariants.

- added_by: nullable -> required (fill existing NULLs with project creator)
- user: on_delete=CASCADE -> on_delete=RESTRICT (prevent ownerless projects)
"""

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def backfill_added_by(apps, schema_editor):
    """Set added_by to project.created_by for existing NULL rows."""
    ProjectMembership = apps.get_model("projects", "ProjectMembership")
    Project = apps.get_model("projects", "Project")
    for pm in ProjectMembership.objects.filter(added_by__isnull=True):
        try:
            project = Project.objects.get(pk=pm.project_id)
            pm.added_by_id = project.created_by_id
            pm.save(update_fields=["added_by"])
        except Project.DoesNotExist:
            pass


class Migration(migrations.Migration):

    dependencies = [
        ("projects", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # Backfill NULL added_by values before making the column required
        migrations.RunPython(backfill_added_by, migrations.RunPython.noop),

        # Make added_by non-nullable
        migrations.AlterField(
            model_name="projectmembership",
            name="added_by",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.RESTRICT,
                related_name="project_memberships_added",
                to=settings.AUTH_USER_MODEL,
            ),
        ),

        # Change user on_delete from CASCADE to RESTRICT
        migrations.AlterField(
            model_name="projectmembership",
            name="user",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.RESTRICT,
                related_name="project_memberships",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
