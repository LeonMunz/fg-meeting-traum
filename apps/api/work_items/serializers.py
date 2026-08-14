from rest_framework import serializers

from .models import WorkItem, WorkItemAssignee


class WorkItemSerializer(serializers.ModelSerializer):
    """Serialize a WorkItem with assignee IDs and parent ID."""

    projectId = serializers.PrimaryKeyRelatedField(
        source="project", read_only=True,
    )
    assigneeIds = serializers.SerializerMethodField()
    parentId = serializers.PrimaryKeyRelatedField(
        source="parent", read_only=True,
    )
    dueDate = serializers.DateField(
        source="due_date", read_only=True,
    )
    blockedReason = serializers.CharField(
        source="blocked_reason", read_only=True,
    )
    completedAt = serializers.DateTimeField(
        source="completed_at", read_only=True,
    )
    createdAt = serializers.DateTimeField(
        source="created_at", read_only=True,
    )
    updatedAt = serializers.DateTimeField(
        source="updated_at", read_only=True,
    )
    createdById = serializers.PrimaryKeyRelatedField(
        source="created_by", read_only=True,
    )

    class Meta:
        model = WorkItem
        fields = (
            "id",
            "projectId",
            "type",
            "title",
            "description",
            "status",
            "assigneeIds",
            "parentId",
            "dueDate",
            "blockedReason",
            "completedAt",
            "createdAt",
            "updatedAt",
            "createdById",
        )
        read_only_fields = fields

    def get_assigneeIds(self, obj):
        return list(
            obj.assignee_relations.values_list("user__pk", flat=True)
        )
