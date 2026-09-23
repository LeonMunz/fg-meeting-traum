from datetime import timezone as dt_timezone

from django.contrib.auth import get_user_model

from rest_framework import serializers

from projects.models import ProjectMembership
from research_groups.models import ResearchGroupMembership

from .models import (
    Meeting,
    MeetingItem,
    MeetingItemFollowUp,
    MeetingNote,
    MeetingRecurrence,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)


User = get_user_model()


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
    currentMeetingItemId = serializers.IntegerField(
        source="current_meeting_item_id",
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
            "currentMeetingItemId",
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
    participantIds = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        many=True,
        required=False,
    )


class MeetingParticipantCandidateContextSerializer(serializers.Serializer):
    scope = serializers.ChoiceField(
        choices=Meeting.Scope.choices,
        default=Meeting.Scope.GROUP,
    )
    projectId = serializers.IntegerField(
        min_value=1,
        required=False,
        allow_null=True,
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


class CreateMeetingFromSeriesSerializer(serializers.Serializer):
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
        required=False,
    )
    scheduledAt = serializers.DateTimeField(
        required=False,
    )
    participantIds = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        many=True,
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


class MeetingItemFollowUpSerializer(serializers.ModelSerializer):
    sourceMeetingItemId = serializers.IntegerField(
        source="source_meeting_item_id",
        read_only=True,
    )
    sourceOutcome = serializers.CharField(
        source="source_meeting_item.outcome",
        read_only=True,
    )
    targetMeetingId = serializers.IntegerField(
        source="target_meeting_id",
        read_only=True,
    )
    targetMeetingTitle = serializers.CharField(
        source="target_meeting.title",
        read_only=True,
    )
    targetMeetingScheduledAt = serializers.DateTimeField(
        source="target_meeting.scheduled_at",
        read_only=True,
    )
    targetMeetingSectionId = serializers.IntegerField(
        source="target_meeting_section_id",
        read_only=True,
    )
    targetMeetingSectionName = serializers.CharField(
        source="target_meeting_section.name",
        read_only=True,
    )
    targetMeetingItemId = serializers.IntegerField(
        source="target_meeting_item_id",
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
        model = MeetingItemFollowUp
        fields = [
            "id",
            "status",
            "sourceMeetingItemId",
            "sourceOutcome",
            "targetMeetingId",
            "targetMeetingTitle",
            "targetMeetingScheduledAt",
            "targetMeetingSectionId",
            "targetMeetingSectionName",
            "targetMeetingItemId",
            "createdAt",
            "updatedAt",
        ]


class MeetingItemScheduleFollowUpSerializer(serializers.Serializer):
    targetMeetingId = serializers.IntegerField(min_value=1)
    targetMeetingSectionId = serializers.IntegerField(min_value=1)


class MeetingItemFollowUpCancelSerializer(serializers.ModelSerializer):
    """Compact result of cancelling one concrete FollowUp.

    ``targetItemDisposition`` is derived from the persisted target
    reference: a ``NULL`` target means the generated item was removed;
    a concrete target means it was preserved.
    """

    sourceMeetingItemId = serializers.IntegerField(
        source="source_meeting_item_id",
        read_only=True,
    )
    sourceOutcome = serializers.CharField(
        source="source_meeting_item.outcome",
        read_only=True,
    )
    targetMeetingItemId = serializers.IntegerField(
        source="target_meeting_item_id",
        read_only=True,
    )
    targetItemDisposition = serializers.SerializerMethodField()

    class Meta:
        model = MeetingItemFollowUp
        fields = [
            "id",
            "status",
            "sourceMeetingItemId",
            "sourceOutcome",
            "targetMeetingItemId",
            "targetItemDisposition",
        ]

    def get_targetItemDisposition(self, obj):
        if obj.target_meeting_item_id is None:
            return "removed"
        return "preserved"


class MeetingFollowUpTargetSectionSerializer(serializers.ModelSerializer):
    sourceSeriesSectionId = serializers.IntegerField(
        source="source_series_section_id",
        read_only=True,
        allow_null=True,
    )

    class Meta:
        model = MeetingSection
        fields = [
            "id",
            "name",
            "position",
            "sourceSeriesSectionId",
        ]


class MeetingFollowUpTargetSerializer(serializers.ModelSerializer):
    scheduledAt = serializers.DateTimeField(
        source="scheduled_at",
        read_only=True,
    )
    seriesId = serializers.IntegerField(
        source="series_id",
        read_only=True,
        allow_null=True,
    )
    recommendedSectionId = serializers.SerializerMethodField()
    sections = serializers.SerializerMethodField()

    class Meta:
        model = Meeting
        fields = [
            "id",
            "title",
            "scheduledAt",
            "seriesId",
            "recommendedSectionId",
            "sections",
        ]

    def get_recommendedSectionId(self, obj):
        source_section = self.context["source_section"]
        sections = obj.follow_up_target_sections

        if source_section.source_series_section_id is not None:
            structural_matches = [
                section
                for section in sections
                if section.source_series_section_id
                == source_section.source_series_section_id
            ]
            if len(structural_matches) == 1:
                return structural_matches[0].pk
            if structural_matches:
                return None

        name_matches = [
            section
            for section in sections
            if section.name == source_section.name
        ]
        if len(name_matches) == 1:
            return name_matches[0].pk
        return None

    def get_sections(self, obj):
        return MeetingFollowUpTargetSectionSerializer(
            obj.follow_up_target_sections,
            many=True,
        ).data


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
    followUpSchedule = serializers.SerializerMethodField()
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
            "outcome",
            "followUpSchedule",
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

    def get_followUpSchedule(self, obj):
        schedules = getattr(
            obj,
            "active_follow_up_schedules",
            None,
        )
        if schedules is None:
            schedule = (
                obj.follow_up_schedules
                .exclude(status=MeetingItemFollowUp.Status.CANCELLED)
                .select_related(
                    "source_meeting_item",
                    "target_meeting",
                    "target_meeting_section",
                )
                .first()
            )
        else:
            schedule = schedules[0] if schedules else None

        if schedule is None:
            return None

        request = self.context.get("request")
        if request is not None:
            target = schedule.target_meeting
            has_group_access = ResearchGroupMembership.objects.filter(
                research_group_id=target.research_group_id,
                user=request.user,
            ).exists()
            has_project_access = (
                target.scope == Meeting.Scope.GROUP
                or ProjectMembership.objects.filter(
                    project_id=target.project_id,
                    user=request.user,
                    role__in=(
                        ProjectMembership.Role.OWNER,
                        ProjectMembership.Role.MEMBER,
                        ProjectMembership.Role.VIEWER,
                    ),
                ).exists()
            )
            if not has_group_access or not has_project_access:
                return None

        return MeetingItemFollowUpSerializer(schedule).data


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
    # ``outcome`` is intentionally NOT part of the generic PATCH
    # contract: Live MeetingItem outcomes are driven exclusively by
    # the canonical domain actions (start / focus / done / follow-up).
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


# ── MeetingRecurrence (creation HTTP API) ───────────────────────


class MeetingRecurrenceSerializer(serializers.ModelSerializer):
    """Canonical read representation of one MeetingRecurrence schedule.

    Exposes the saved configuration a frontend can render without
    reconstructing it from the request: the explicit series title, the
    referenced Meeting Template, and the V1 recurrence rule. It exposes
    NO internal implementation state (no end-mode flag, no
    materialization/virtual state, no lock fields): ``endDate`` and
    ``count`` are the user-facing end semantics (both ``null`` while the
    schedule is open-ended), mirroring the request contract.
    """

    meetingSeriesId = serializers.IntegerField(
        source="series_id",
        read_only=True,
    )
    researchGroupId = serializers.IntegerField(
        source="research_group_id",
        read_only=True,
    )
    projectId = serializers.IntegerField(
        source="project_id",
        read_only=True,
        allow_null=True,
    )
    startDate = serializers.DateField(
        source="start_date",
        read_only=True,
    )
    localTime = serializers.TimeField(
        source="local_time",
        read_only=True,
    )
    timezone = serializers.CharField(
        source="timezone_name",
        read_only=True,
    )
    endDate = serializers.DateField(
        source="end_date",
        read_only=True,
        allow_null=True,
    )
    count = serializers.IntegerField(
        source="occurrence_count",
        read_only=True,
        allow_null=True,
    )

    class Meta:
        model = MeetingRecurrence
        fields = [
            "id",
            "title",
            "meetingSeriesId",
            "researchGroupId",
            "scope",
            "projectId",
            "frequency",
            "interval",
            "weekdays",
            "startDate",
            "localTime",
            "timezone",
            "endDate",
            "count",
        ]


class MeetingRecurrenceOverviewSerializer(MeetingRecurrenceSerializer):
    """Read model of ONE personally relevant recurring Series for the
    Meetings Series overview.

    Carries the canonical recurrence representation EXACTLY like the
    create/read contract (``id``, ``title``, ``meetingSeriesId``,
    ``scope``, ``researchGroupId``, ``projectId``, and the V1 rule
    ``frequency`` / ``interval`` / ``weekdays`` / ``startDate`` /
    ``localTime`` / ``timezone`` / ``endDate`` / ``count``) plus the
    minimal Series-overview context:

    - ``creator`` — the repository's canonical minimal User summary
      (``id``, ``username``, ``firstName``, ``lastName``), enough to
      render "Created by <display name>" without a second User DTO;
    - ``peopleCount`` — the exact people semantics a future
      materialized Meeting gets: the creator plus the unique persisted
      recurrence participants, creator duplication removed (never
      Research Group / Project membership);
    - ``status`` — a DERIVED presentation state, not a persisted
      lifecycle: ``"active"`` iff ``nextOccurrenceScheduledAt`` is
      non-null, ``"ended"`` otherwise (exclusions, cancellations, and
      finite rules are all reflected through it);
    - ``nextOccurrenceScheduledAt`` — the earliest effective,
      non-cancelled occurrence of the series whose effective scheduled
      time is at or after the server's current instant (aware ISO
      timestamp; a rescheduled materialized occurrence uses its
      effective moved Meeting time), or ``null`` when the series has
      no further effective occurrence.
    """

    creator = serializers.SerializerMethodField()
    peopleCount = serializers.SerializerMethodField()
    status = serializers.SerializerMethodField()
    nextOccurrenceScheduledAt = serializers.SerializerMethodField()

    class Meta(MeetingRecurrenceSerializer.Meta):
        fields = [
            *MeetingRecurrenceSerializer.Meta.fields,
            "creator",
            "peopleCount",
            "status",
            "nextOccurrenceScheduledAt",
        ]

    def get_creator(self, obj):
        creator = obj.created_by
        return {
            "id": creator.pk,
            "username": creator.username,
            "firstName": creator.first_name,
            "lastName": creator.last_name,
        }

    def get_peopleCount(self, obj):
        return self.context["people_count"]

    def get_status(self, obj):
        return self.context["status"]

    def get_nextOccurrenceScheduledAt(self, obj):
        value = self.context["next_scheduled_at"]
        if value is None:
            return None
        # Aware UTC: DRF's JSON encoder renders this as the
        # repository's ISO-8601 ``...Z`` convention.
        return value.astimezone(dt_timezone.utc)


class MeetingRecurrenceCreateSerializer(serializers.Serializer):
    """POST body for creating a MeetingRecurrence from a Meeting Template.

    The selected MeetingSeries is the canonical content source and
    DETERMINES the recurrence's group/project scope: the client supplies
    only the template reference, the explicit series title, and the V1
    recurrence rule — never ownership fields. This serializer performs
    syntactic validation and field parsing only. Every recurrence-rule
    invariant (frequency, positive interval, weekday validity and the
    weekly start-date rule, IANA timezone, end-mode mutual exclusion and
    ordering) is enforced by the domain creation service
    (``create_meeting_recurrence``), never duplicated here.

    ``weekdays`` are ISO weekday integers (0 = Monday .. 6 = Sunday) and
    are only meaningful for ``weekly`` schedules. ``endDate`` and
    ``count`` map to the domain end modes: both absent/null → open-ended;
    ``endDate`` → inclusive final calendar date; ``count`` → total
    occurrences including the first; both set → rejected by the domain.

    ``participantIds`` is the optional intended participant set of the
    recurring SERIES (omitted or an empty list is valid): it resolves to
    existing application users exactly like ordinary Meeting creation
    (``MeetingCreateSerializer.participantIds``) — a malformed or unknown
    id fails validation with nothing persisted. Eligibility is the
    canonical Meeting-participant rule (any existing user; Research
    Group / Project membership is not required), and the intent broadens
    no authorization. Duplicate ids are accepted and normalized by the
    domain service. The creator may be included; materialization
    deduplicates through the canonical creator-first initialization.
    """

    meetingSeriesId = serializers.IntegerField(min_value=1)
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )
    frequency = serializers.ChoiceField(
        choices=MeetingRecurrence.Frequency.choices,
    )
    interval = serializers.IntegerField()
    weekdays = serializers.ListField(
        child=serializers.IntegerField(),
        required=False,
        allow_empty=True,
        default=list,
    )
    startDate = serializers.DateField()
    localTime = serializers.TimeField()
    timezone = serializers.CharField(max_length=64)
    endDate = serializers.DateField(
        required=False,
        allow_null=True,
        default=None,
    )
    count = serializers.IntegerField(
        required=False,
        allow_null=True,
        default=None,
    )
    participantIds = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        many=True,
        required=False,
    )


# ── MeetingRecurrence occurrences (bounded read API) ───────────


class _AwareDateTimeField(serializers.DateTimeField):
    """A DateTimeField that rejects naive input datetimes.

    The bounded occurrence-expansion contract requires timezone-aware
    window boundaries; a naive value must be rejected, never silently
    interpreted in the server timezone.
    """

    default_error_messages = {
        **serializers.DateTimeField.default_error_messages,
        "naive": (
            "Datetime must be timezone-aware (include a UTC offset "
            "or timezone name)."
        ),
    }

    def enforce_timezone(self, value):
        if value.tzinfo is None:
            self.fail("naive")
        return value


class MeetingRecurrenceOccurrenceQuerySerializer(serializers.Serializer):
    """GET query contract for the bounded occurrence read.

    Both window boundaries are mandatory and must be timezone-aware.
    The field name ``from`` is a Python keyword, so the declared field
    map is returned from ``get_fields`` instead of class attributes.
    """

    def get_fields(self):
        return {
            "from": _AwareDateTimeField(),
            "to": _AwareDateTimeField(),
        }


class MeetingRecurrenceOccurrenceSerializer(serializers.Serializer):
    """Compact read-only representation of one calculated occurrence.

    ``occurrenceId`` is the stable Slice-1 occurrence identity (the
    same value for a virtual and a materialized occurrence);
    ``originalScheduledAt`` is the immutable original scheduled start
    (aware instant) and ``originalLocal`` / ``timezone`` carry the
    local wall-clock scheduling information of the stored timezone.
    A materialized occurrence additionally exposes the concrete
    ``meetingId`` without duplicating the Meeting payload.
    """

    occurrenceId = serializers.UUIDField()
    originalScheduledAt = serializers.DateTimeField()
    originalLocal = serializers.CharField()
    timezone = serializers.CharField()
    materialized = serializers.BooleanField()
    meetingId = serializers.IntegerField(allow_null=True)


class MeetingRecurrencePersonalOccurrenceSerializer(serializers.Serializer):
    """Compact read-only representation of ONE effective recurring
    occurrence in the current user's personal recurring-occurrence
    feed.

    Reuses the per-recurrence bounded occurrence read's occurrence
    identity contract: ``occurrenceId`` / ``originalScheduledAt`` are
    the SAME values that read reports for the same occurrence (the
    stable UUIDv5 identity derived from the original scheduled start,
    never from the materialized Meeting). ``scheduledAt`` is the
    ACTUAL scheduled time: the concrete Meeting's editable planned
    time when materialized (a rescheduled Meeting keeps its stable
    occurrence identity but reports its moved time) and the original
    scheduled start while virtual. ``title`` is the effective title:
    the materialized Meeting's own title when materialized, the
    canonical series title while virtual.

    The minimal Meeting-overview context: the owning ``recurrenceId``,
    the canonical Meeting Template id (``meetingSeriesId``, nullable
    for legacy template-less recurrences), ``researchGroupId``, and
    ``projectId`` (null for group scope). ``materialized`` /
    ``meetingId`` let the future frontend merge distinguish a virtual
    occurrence from a materialized one without duplicating the Meeting
    payload: a materialized occurrence appears EXACTLY ONCE, here, and
    the Meeting list keeps reporting the concrete Meeting separately.
    """

    occurrenceId = serializers.UUIDField()
    recurrenceId = serializers.IntegerField()
    title = serializers.CharField()
    originalScheduledAt = serializers.DateTimeField()
    scheduledAt = serializers.DateTimeField()
    materialized = serializers.BooleanField()
    meetingId = serializers.IntegerField(allow_null=True)
    meetingSeriesId = serializers.IntegerField(allow_null=True)
    researchGroupId = serializers.IntegerField()
    projectId = serializers.IntegerField(allow_null=True)


class MeetingRecurrenceMaterializeSerializer(serializers.Serializer):
    """POST body contract for materializing ONE calculated occurrence.

    The request must carry the stable occurrence identity (``occurrenceId``)
    and the canonical original scheduled timestamp (``originalScheduledAt``)
    exactly as reported by the bounded occurrence read API, plus the
    concrete Meeting ``title``. The occurrence identity is an opaque
    derived UUIDv5 that cannot be inverted, so the original scheduled
    start is part of the contract: the server revalidates the pair
    against the recurrence rule (derived identity match AND bounded rule
    membership) before anything is persisted. ``originalScheduledAt``
    must be timezone-aware — a naive value is rejected, never silently
    interpreted in a server timezone.
    """

    occurrenceId = serializers.UUIDField()
    originalScheduledAt = _AwareDateTimeField()
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )


class MeetingRecurrenceRescheduleSerializer(serializers.Serializer):
    """POST body contract for rescheduling ONE materialized occurrence.

    The request must carry the stable occurrence identity
    (``occurrenceId``) and the canonical original scheduled timestamp
    (``originalScheduledAt``) exactly as reported by the bounded
    occurrence read API, plus the new planned meeting time
    (``scheduledAt``). The occurrence identity is an opaque derived
    UUIDv5 that cannot be inverted, so the original scheduled start is
    part of the contract: the server revalidates the pair against the
    recurrence rule (derived identity match AND bounded rule
    membership) before anything is persisted. Both timestamps must be
    timezone-aware — a naive value is rejected, never silently
    interpreted in a server timezone. The new ``scheduledAt`` is the
    Meeting's own editable planned time; it does not have to match the
    recurrence rule (that is the point of a single-occurrence move).
    ``title`` is required for EVERY reschedule request: it is the
    Meeting title used when the reschedule must first materialize a
    virtual occurrence, and it is deliberately IGNORED when the
    occurrence is already materialized (a reschedule never renames an
    existing Meeting).
    """

    occurrenceId = serializers.UUIDField()
    originalScheduledAt = _AwareDateTimeField()
    scheduledAt = _AwareDateTimeField()
    title = serializers.CharField(
        max_length=255,
        allow_blank=False,
    )


class MeetingRecurrenceOccurrenceExcludeSerializer(serializers.Serializer):
    """POST body contract for excluding ONE virtual occurrence.

    The request must carry the stable occurrence identity
    (``occurrenceId``) and the canonical original scheduled timestamp
    (``originalScheduledAt``) exactly as reported by the bounded
    occurrence read API. The occurrence identity is an opaque derived
    UUIDv5 that cannot be inverted, so the original scheduled start is
    part of the contract: the server revalidates the pair against the
    recurrence rule (derived identity match AND bounded rule
    membership) before anything is persisted.
    ``originalScheduledAt`` must be timezone-aware — a naive value is
    rejected, never silently interpreted in a server timezone.

    Unlike the materialization and reschedule contracts, there is NO
    ``title`` and no other Meeting-level input: excluding a virtual
    occurrence never creates a Meeting.
    """

    occurrenceId = serializers.UUIDField()
    originalScheduledAt = _AwareDateTimeField()
