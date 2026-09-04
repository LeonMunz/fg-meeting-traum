from rest_framework import serializers

from projects.models import ProjectMembership

from .models import (
    Meeting,
    MeetingItem,
    MeetingNote,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)


# ── MeetingSeries ────────────────────────────────────────────────


class MeetingSeriesSerializer(serializers.ModelSerializer):
    researchGroupId = serializers.IntegerField(
        source="research_group_id",
        read_only=True,
    )
    projectId = serializers.IntegerField(
        source="project_id",
        read_only=True,
        allow_null=True,
    )
    isArchived = serializers.BooleanField(
        source="is_archived",
        read_only=True,
    )
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
        model = MeetingSeries
        fields = [
            "id",
            "researchGroupId",
            "scope",
            "projectId",
            "title",
            "description",
            "isArchived",
            "createdById",
            "createdAt",
            "updatedAt",
        ]


class MeetingSeriesCreateSerializer(serializers.Serializer):
    scope = serializers.ChoiceField(
        choices=MeetingSeries.Scope.choices,
        default=MeetingSeries.Scope.GROUP,
    )
    projectId = serializers.IntegerField(
        min_value=1,
        required=False,
        allow_null=True,
    )
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )
    description = serializers.CharField(
        required=False,
        allow_blank=True,
    )


class MeetingSeriesPatchSerializer(serializers.Serializer):
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
        required=False,
    )
    description = serializers.CharField(
        required=False,
        allow_blank=True,
    )
    isArchived = serializers.BooleanField(
        required=False,
    )


# ── MeetingSeriesSection ─────────────────────────────────────────


class MeetingSeriesSectionSerializer(serializers.ModelSerializer):
    meetingSeriesId = serializers.IntegerField(
        source="meeting_series_id",
        read_only=True,
    )
    isActive = serializers.BooleanField(
        source="is_active",
        read_only=True,
    )

    class Meta:
        model = MeetingSeriesSection
        fields = [
            "id",
            "meetingSeriesId",
            "name",
            "description",
            "position",
            "isActive",
        ]


class MeetingSeriesSectionCreateSerializer(serializers.Serializer):
    name = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )
    description = serializers.CharField(
        required=False,
        allow_blank=True,
    )


class MeetingSeriesSectionPatchSerializer(serializers.Serializer):
    name = serializers.CharField(
        max_length=255,
        allow_blank=False,
        required=False,
    )
    description = serializers.CharField(
        required=False,
        allow_blank=True,
    )
    isActive = serializers.BooleanField(
        required=False,
    )


class MeetingSeriesSectionReorderSerializer(serializers.Serializer):
    sectionIds = serializers.ListField(
        child=serializers.IntegerField(min_value=1),
    )


# ── MeetingSection (snapshot) ────────────────────────────────────


class MeetingSectionSerializer(serializers.ModelSerializer):
    meetingId = serializers.IntegerField(
        source="meeting_id",
        read_only=True,
    )
    sourceSeriesSectionId = serializers.IntegerField(
        source="source_series_section_id",
        read_only=True,
        allow_null=True,
    )
    isVisible = serializers.BooleanField(
        source="is_visible",
        read_only=True,
    )

    class Meta:
        model = MeetingSection
        fields = [
            "id",
            "meetingId",
            "sourceSeriesSectionId",
            "name",
            "description",
            "position",
            "isVisible",
        ]


class MeetingSectionCreateSerializer(serializers.Serializer):
    name = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )
    description = serializers.CharField(
        required=False,
        allow_blank=True,
    )


class MeetingSectionPatchSerializer(serializers.Serializer):
    name = serializers.CharField(
        max_length=255,
        allow_blank=False,
        required=False,
    )
    description = serializers.CharField(
        required=False,
        allow_blank=True,
    )
    isVisible = serializers.BooleanField(
        required=False,
    )


class MeetingSectionReorderSerializer(serializers.Serializer):
    sectionIds = serializers.ListField(
        child=serializers.IntegerField(min_value=1),
    )


# ── Meeting ──────────────────────────────────────────────────────


class MeetingSerializer(serializers.ModelSerializer):
    researchGroupId = serializers.IntegerField(
        source="research_group_id",
        read_only=True,
    )
    projectId = serializers.IntegerField(
        source="project_id",
        read_only=True,
        allow_null=True,
    )
    seriesId = serializers.IntegerField(
        source="series_id",
        read_only=True,
        allow_null=True,
    )
    scheduledAt = serializers.DateTimeField(
        source="scheduled_at",
    )
    startedAt = serializers.DateTimeField(
        source="started_at",
        read_only=True,
        allow_null=True,
    )
    endedAt = serializers.DateTimeField(
        source="ended_at",
        read_only=True,
        allow_null=True,
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
            "scope",
            "projectId",
            "seriesId",
            "title",
            "scheduledAt",
            "startedAt",
            "endedAt",
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
    scope = serializers.ChoiceField(
        choices=Meeting.Scope.choices,
        default=Meeting.Scope.GROUP,
    )
    projectId = serializers.IntegerField(
        min_value=1,
        required=False,
        allow_null=True,
    )
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )
    scheduledAt = serializers.DateTimeField()


class MeetingPatchSerializer(serializers.Serializer):
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
        required=False,
    )
    scheduledAt = serializers.DateTimeField(
        required=False,
    )


class CreateMeetingFromSeriesSerializer(serializers.Serializer):
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
        required=False,
    )
    scheduledAt = serializers.DateTimeField(
        required=False,
    )


class MeetingNoteSerializer(serializers.ModelSerializer):
    """Presentation of one persistent MeetingNote.

    Exposes the identity, owner MeetingItem, author display data,
    content, and timestamps needed by the Meeting UI. The author is
    never writable.

    ``linkedWorkItem`` exposes the primary WorkItem of this exact Note
    (when one exists) as a compact, permission-filtered summary: the
    summary is only returned when the requesting user can read the
    WorkItem's Project, so private Project work never leaks through
    Meeting views.
    """

    meetingItemId = serializers.IntegerField(
        source="meeting_item_id",
        read_only=True,
    )
    author = serializers.SerializerMethodField()
    linkedWorkItem = serializers.SerializerMethodField()
    createdAt = serializers.DateTimeField(
        source="created_at",
        read_only=True,
    )
    updatedAt = serializers.DateTimeField(
        source="updated_at",
        read_only=True,
    )

    class Meta:
        model = MeetingNote
        fields = [
            "id",
            "meetingItemId",
            "author",
            "linkedWorkItem",
            "content",
            "createdAt",
            "updatedAt",
        ]

    def get_author(self, obj):
        author = obj.author
        return {
            "id": author.pk,
            "username": author.username,
            "firstName": author.first_name,
            "lastName": author.last_name,
        }

    def get_linkedWorkItem(self, obj):
        relation = (
            obj.work_item_relations
            .select_related(
                "work_item",
                "work_item__project",
                "work_item__status_definition",
            )
            .order_by("id")
            .first()
        )
        if relation is None:
            return None

        work_item = relation.work_item
        request = self.context.get("request")
        if request is not None:
            has_project_access = ProjectMembership.objects.filter(
                project_id=work_item.project_id,
                user=request.user,
            ).exists()
            if not has_project_access:
                return None

        return {
            "id": work_item.id,
            "title": work_item.title,
            "projectId": work_item.project_id,
            "projectName": work_item.project.name,
            "statusName": work_item.status_definition.name,
            "assigneeNames": [
                assignee.user.get_full_name()
                or assignee.user.username
                for assignee in (
                    work_item.assignee_relations
                    .select_related("user")
                    .order_by("id")
                )
            ],
        }


class MeetingNoteCreateSerializer(serializers.Serializer):
    content = serializers.CharField(
        allow_blank=False,
    )


class MeetingNotePatchSerializer(serializers.Serializer):
    content = serializers.CharField(
        allow_blank=False,
    )


class MeetingItemSerializer(serializers.ModelSerializer):
    meetingId = serializers.IntegerField(
        source="meeting_id",
        read_only=True,
    )
    meetingSectionId = serializers.IntegerField(
        source="meeting_section_id",
        read_only=True,
    )
    contextNotes = serializers.CharField(
        source="notes",
        read_only=True,
        allow_blank=True,
    )
    workItemIds = serializers.SerializerMethodField()
    notes = MeetingNoteSerializer(
        source="note_relations",
        many=True,
        read_only=True,
    )
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
            "meetingSectionId",
            "title",
            "contextNotes",
            "position",
            "status",
            "workItemIds",
            "notes",
            "createdById",
            "createdAt",
            "updatedAt",
        ]


    def get_workItemIds(self, obj):
        relations = obj.work_item_relations.order_by("id")
        request = self.context.get("request")
        if request is not None:
            relations = relations.filter(
                work_item__project__memberships__user=request.user,
            )

        return list(
            relations.values_list("work_item_id", flat=True)
        )


class MeetingItemCreateSerializer(serializers.Serializer):
    meetingSectionId = serializers.IntegerField(min_value=1)
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )
    notes = serializers.CharField(
        required=False,
        allow_blank=True,
    )


class MeetingItemPatchSerializer(serializers.Serializer):
    # ``status`` is intentionally NOT part of the generic PATCH
    # contract: Live MeetingItem status is driven exclusively by the
    # canonical domain actions (start / focus / done / follow-up).
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
        required=False,
    )
    notes = serializers.CharField(
        required=False,
        allow_blank=True,
    )



class MeetingWorkItemCreateSerializer(serializers.Serializer):
    projectId = serializers.IntegerField(
        min_value=1,
    )
    typeDefinitionId = serializers.IntegerField(
        min_value=1,
    )
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )
    meetingNoteId = serializers.IntegerField(
        min_value=1,
        required=False,
        allow_null=True,
    )
    description = serializers.CharField(
        required=False,
        allow_blank=True,
    )
    statusDefinitionId = serializers.IntegerField(
        min_value=1,
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
    labelDefinitionIds = serializers.ListField(
        child=serializers.IntegerField(
            min_value=1,
        ),
        required=False,
    )
