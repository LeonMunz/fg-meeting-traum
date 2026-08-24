# Foundation 5A — complete canonical WorkItem definition migration.
#
# This migration:
# 1. Verifies that every WorkItem has type_definition and status_definition
#    populated from the legacy type/status columns (done in migration 0002).
#    If any are still NULL, maps them using the same legacy→definition mapping.
# 2. Alters type_definition and status_definition to NOT NULL.
# 3. Removes the legacy `type` and `status` columns.

from django.db import migrations, models


def ensure_definitions_populated(apps, schema_editor):
    """Safety pass: populate any remaining NULL definition FKs."""
    WorkItem = apps.get_model("work_items", "WorkItem")
    Project = apps.get_model("projects", "Project")
    WorkItemTypeDefinition = apps.get_model("projects", "WorkItemTypeDefinition")
    WorkItemStatusDefinition = apps.get_model("projects", "WorkItemStatusDefinition")

    type_map = {
        "epic": "Epic",
        "milestone": "Milestone",
        "deliverable": "Deliverable",
        "task": "Task",
    }
    status_map = {
        "todo": ("Todo", "todo"),
        "in_progress": ("In Progress", "in_progress"),
        "review": ("Review", "review"),
        "done": ("Done", "done"),
    }

    for project in Project.objects.all():
        # Build lookup maps for this project
        type_defs = {}
        for old_val, name in type_map.items():
            try:
                type_defs[old_val] = WorkItemTypeDefinition.objects.get(
                    project=project, name=name
                )
            except WorkItemTypeDefinition.DoesNotExist:
                pass

        status_defs = {}
        for old_val, (name, category) in status_map.items():
            try:
                status_defs[old_val] = WorkItemStatusDefinition.objects.get(
                    project=project, name=name
                )
            except WorkItemStatusDefinition.DoesNotExist:
                pass

        # Fix NULL type_definition
        wis_null_type = WorkItem.objects.filter(
            project=project, type_definition__isnull=True
        )
        updates = []
        for wi in wis_null_type:
            if wi.type in type_defs:
                wi.type_definition = type_defs[wi.type]
                updates.append(wi)
        if updates:
            WorkItem.objects.bulk_update(updates, ["type_definition"], batch_size=500)

        # Fix NULL status_definition
        wis_null_status = WorkItem.objects.filter(
            project=project, status_definition__isnull=True
        )
        updates = []
        for wi in wis_null_status:
            if wi.status in status_defs:
                wi.status_definition = status_defs[wi.status]
                updates.append(wi)
        if updates:
            WorkItem.objects.bulk_update(updates, ["status_definition"], batch_size=500)


class Migration(migrations.Migration):

    dependencies = [
        ("projects", "0004_workitemlabeldefinition_workitemstatusdefinition_and_more"),
        ("work_items", "0003_workitem_status_definition_workitem_type_definition_and_more"),
    ]

    operations = [
        # Safety pass: ensure no NULL definition FKs remain
        migrations.RunPython(
            ensure_definitions_populated,
            migrations.RunPython.noop,
        ),

        # Make FKs NOT NULL
        migrations.AlterField(
            model_name="workitem",
            name="type_definition",
            field=models.ForeignKey(
                on_delete=models.deletion.RESTRICT,
                related_name="work_items",
                to="projects.workitemtypedefinition",
            ),
        ),
        migrations.AlterField(
            model_name="workitem",
            name="status_definition",
            field=models.ForeignKey(
                on_delete=models.deletion.RESTRICT,
                related_name="work_items",
                to="projects.workitemstatusdefinition",
            ),
        ),

        # Remove legacy columns
        migrations.RemoveField(
            model_name="workitem",
            name="type",
        ),
        migrations.RemoveField(
            model_name="workitem",
            name="status",
        ),
    ]
