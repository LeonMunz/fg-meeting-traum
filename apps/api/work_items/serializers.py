from rest_framework import serializers

from .models import WorkItem, WorkItemAssignee, WorkItemComment


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


class WorkItemHistoryEventSerializer(serializers.Serializer):
    """Presentation-neutral WorkItem history entry.

    Serializes an audit_history.AuditEvent for the WorkItem history API
    ONLY — deliberately narrower than the generic AuditEvent record: no
    research_group internals, no raw subject_user, no opaque/unrelated
    AuditEvent.data. `changes` is exactly AuditEvent.data["changes"]
    (see work_items.services for the structured contract), or {} for
    events (e.g. work_item.created) that carry none.
    """

    id = serializers.IntegerField()
    eventType = serializers.CharField(source="event_type")
    actor = serializers.SerializerMethodField()
    changes = serializers.SerializerMethodField()
    createdAt = serializers.DateTimeField(source="created_at")

    def get_actor(self, obj):
        actor = obj.actor

        if actor is None:
            return None

        return {
            "id": actor.pk,
            "username": actor.username,
            "firstName": actor.first_name,
            "lastName": actor.last_name,
        }

    def get_changes(self, obj):
        data = obj.data or {}
        return data.get("changes", {})


class WorkItemCommentSerializer(serializers.ModelSerializer):
    """Presentation-neutral WorkItem comment entry.

    Deliberately narrow: only what the Activity feed needs to render a
    comment, matching the WorkItem/history serializers' convention of
    exposing no unrelated internal fields.
    """

    workItemId = serializers.PrimaryKeyRelatedField(
        source="work_item", read_only=True,
    )
    author = serializers.SerializerMethodField()
    createdAt = serializers.DateTimeField(
        source="created_at", read_only=True,
    )
    updatedAt = serializers.DateTimeField(
        source="updated_at", read_only=True,
    )

    class Meta:
        model = WorkItemComment
        fields = (
            "id",
            "workItemId",
            "author",
            "body",
            "createdAt",
            "updatedAt",
        )
        read_only_fields = fields

    def get_author(self, obj):
        author = obj.author
        return {
            "id": author.pk,
            "username": author.username,
            "firstName": author.first_name,
            "lastName": author.last_name,
        }
