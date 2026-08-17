from rest_framework import serializers

from work_items.models import WorkItem

from .models import Meeting, MeetingItem


class MeetingSerializer(serializers.ModelSerializer):
    researchGroupId = serializers.IntegerField(
        source="research_group_id",
        read_only=True,
    )
    scheduledAt = serializers.DateTimeField(
        source="scheduled_at",
    )
    participantIds = serializers.SerializerMethodField()
    createdById = serializers.IntegerField(
        source="created_by_id",
        read_only=True,
    )
    createdAt = serializers.DateTimeField(
        source="created_at",
        read_only=True,
    )
    updatedAt = serializers.DateTimeField(
        source="updated_at",
        read_only=True,
    )

    class Meta:
        model = Meeting
        fields = [
            "id",
            "researchGroupId",
            "title",
            "scheduledAt",
            "status",
            "participantIds",
            "createdById",
            "createdAt",
            "updatedAt",
        ]

    def get_participantIds(self, obj):
        return list(
            obj.participant_relations
            .order_by("id")
            .values_list("user_id", flat=True)
        )


class MeetingCreateSerializer(serializers.Serializer):
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )
    scheduledAt = serializers.DateTimeField()
    status = serializers.ChoiceField(
        choices=Meeting.Status.choices,
        required=False,
    )


class MeetingPatchSerializer(serializers.Serializer):
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
        required=False,
    )
    scheduledAt = serializers.DateTimeField(
        required=False,
    )
    status = serializers.ChoiceField(
        choices=Meeting.Status.choices,
        required=False,
    )


class MeetingItemSerializer(serializers.ModelSerializer):
    meetingId = serializers.IntegerField(
        source="meeting_id",
        read_only=True,
    )
    workItemIds = serializers.SerializerMethodField()
    createdById = serializers.IntegerField(
        source="created_by_id",
        read_only=True,
    )
    createdAt = serializers.DateTimeField(
        source="created_at",
        read_only=True,
    )
    updatedAt = serializers.DateTimeField(
        source="updated_at",
        read_only=True,
    )

    class Meta:
        model = MeetingItem
        fields = [
            "id",
            "meetingId",
            "title",
            "notes",
            "position",
            "status",
            "workItemIds",
            "createdById",
            "createdAt",
            "updatedAt",
        ]


    def get_workItemIds(self, obj):
        return list(
            obj.work_item_relations
            .order_by("id")
            .values_list("work_item_id", flat=True)
        )


class MeetingItemCreateSerializer(serializers.Serializer):
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )
    notes = serializers.CharField(
        required=False,
        allow_blank=True,
    )


class MeetingItemPatchSerializer(serializers.Serializer):
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
        required=False,
    )
    notes = serializers.CharField(
        required=False,
        allow_blank=True,
    )
    status = serializers.ChoiceField(
        choices=MeetingItem.Status.choices,
        required=False,
    )



class MeetingWorkItemCreateSerializer(serializers.Serializer):
    projectId = serializers.IntegerField(
        min_value=1,
    )
    type = serializers.ChoiceField(
        choices=WorkItem.Type.choices,
    )
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )
    description = serializers.CharField(
        required=False,
        allow_blank=True,
    )
    status = serializers.ChoiceField(
        choices=WorkItem.Status.choices,
        required=False,
    )
    assigneeIds = serializers.ListField(
        child=serializers.IntegerField(
            min_value=1,
        ),
        required=False,
    )
    parentId = serializers.IntegerField(
        min_value=1,
        required=False,
        allow_null=True,
    )
    dueDate = serializers.DateField(
        required=False,
        allow_null=True,
    )
    blockedReason = serializers.CharField(
        required=False,
        allow_blank=True,
        allow_null=True,
    )
