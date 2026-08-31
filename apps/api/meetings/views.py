from django.contrib.auth import get_user_model

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from projects.models import ProjectMembership
from work_items.views import serialize_work_item

from research_groups.models import (
    ResearchGroupMembership,
)

from .models import (
    Meeting,
    MeetingItem,
    MeetingParticipant,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)
from .serializers import (
    CreateMeetingFromSeriesSerializer,
    MeetingCreateSerializer,
    MeetingItemCreateSerializer,
    MeetingItemPatchSerializer,
    MeetingItemSerializer,
    MeetingPatchSerializer,
    MeetingSectionSerializer,
    MeetingSerializer,
    MeetingSeriesCreateSerializer,
    MeetingSeriesPatchSerializer,
    MeetingSeriesSectionCreateSerializer,
    MeetingSeriesSectionPatchSerializer,
    MeetingSeriesSectionReorderSerializer,
    MeetingSeriesSectionSerializer,
    MeetingSeriesSerializer,
    MeetingWorkItemCreateSerializer,
)
from .services import (
    MeetingDomainError,
    add_meeting_participant,
    create_meeting,
    create_meeting_from_series,
    create_meeting_item,
    create_meeting_series,
    create_series_section,
    create_work_item_from_meeting_item,
    reorder_series_sections,
    remove_meeting_participant,
    update_meeting,
    update_meeting_series,
    update_meeting_item,
    update_series_section,
)


User = get_user_model()


def _require_research_group_access(request, group_id):
    try:
        membership = ResearchGroupMembership.objects.select_related(
            "research_group",
        ).get(
            research_group_id=group_id,
            user=request.user,
        )
    except ResearchGroupMembership.DoesNotExist:
        return None

    return membership.research_group


def _require_meeting_access(request, meeting_id):
    try:
        meeting = Meeting.objects.select_related(
            "research_group",
            "created_by",
        ).get(pk=meeting_id)
    except Meeting.DoesNotExist:
        return None

    if not ResearchGroupMembership.objects.filter(
        research_group=meeting.research_group,
        user=request.user,
    ).exists():
        return None

    return meeting


def _require_meeting_item_access(request, meeting_item_id):
    try:
        item = MeetingItem.objects.select_related(
            "meeting",
            "meeting__research_group",
            "created_by",
        ).get(pk=meeting_item_id)
    except MeetingItem.DoesNotExist:
        return None

    if not ResearchGroupMembership.objects.filter(
        research_group=item.meeting.research_group,
        user=request.user,
    ).exists():
        return None

    return item


def _require_meeting_series_access(request, series_id):
    try:
        series = MeetingSeries.objects.select_related(
            "research_group",
            "created_by",
        ).get(pk=series_id)
    except MeetingSeries.DoesNotExist:
        return None

    if not ResearchGroupMembership.objects.filter(
        research_group=series.research_group,
        user=request.user,
    ).exists():
        return None

    return series


def _require_series_section_access(request, section_id):
    try:
        section = MeetingSeriesSection.objects.select_related(
            "meeting_series",
            "meeting_series__research_group",
        ).get(pk=section_id)
    except MeetingSeriesSection.DoesNotExist:
        return None

    if not ResearchGroupMembership.objects.filter(
        research_group=section.meeting_series.research_group,
        user=request.user,
    ).exists():
        return None

    return section


# ── MeetingSeries endpoints ──────────────────────────────────────


class MeetingSeriesListCreateView(APIView):
    """GET/POST /api/research-groups/{group_id}/meeting-series/"""

    permission_classes = [IsAuthenticated]

    def get(self, request, group_id):
        group = _require_research_group_access(request, group_id)
        if group is None:
            return Response([])

        series = (
            MeetingSeries.objects
            .filter(research_group=group)
            .select_related("research_group", "created_by")
        )

        return Response(
            MeetingSeriesSerializer(series, many=True).data
        )

    def post(self, request, group_id):
        group = _require_research_group_access(request, group_id)
        if group is None:
            return Response(
                {"error": "Research group not found"},
                status=404,
            )

        serializer = MeetingSeriesCreateSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        data = serializer.validated_data

        try:
            series = create_meeting_series(
                research_group=group,
                actor=request.user,
                title=data["title"],
                description=data.get("description", ""),
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(
            MeetingSeriesSerializer(series).data,
            status=201,
        )


class MeetingSeriesDetailView(APIView):
    """GET/PATCH /api/meeting-series/{series_id}/"""

    permission_classes = [IsAuthenticated]

    def get(self, request, series_id):
        series = _require_meeting_series_access(request, series_id)
        if series is None:
            return Response(
                {"error": "Meeting series not found"},
                status=404,
            )

        return Response(MeetingSeriesSerializer(series).data)

    def patch(self, request, series_id):
        if any(
            field in request.data
            for field in [
                "researchGroupId",
                "research_group",
                "createdById",
                "created_by",
            ]
        ):
            return Response(
                {
                    "error": (
                        "Cannot directly change Meeting series "
                        "relationships or creator."
                    )
                },
                status=400,
            )

        series = _require_meeting_series_access(request, series_id)
        if series is None:
            return Response(
                {"error": "Meeting series not found"},
                status=404,
            )

        serializer = MeetingSeriesPatchSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        data = serializer.validated_data

        try:
            update_meeting_series(
                meeting_series=series,
                actor=request.user,
                title=data.get("title"),
                description=data.get("description"),
                is_archived=data.get("isArchived"),
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        series.refresh_from_db()
        return Response(MeetingSeriesSerializer(series).data)


# ── MeetingSeriesSection endpoints ───────────────────────────────


class MeetingSeriesSectionListCreateView(APIView):
    """GET/POST /api/meeting-series/{series_id}/sections/"""

    permission_classes = [IsAuthenticated]

    def get(self, request, series_id):
        series = _require_meeting_series_access(request, series_id)
        if series is None:
            return Response(
                {"error": "Meeting series not found"},
                status=404,
            )

        sections = (
            MeetingSeriesSection.objects
            .filter(meeting_series=series)
            .order_by("position", "id")
        )

        return Response(
            MeetingSeriesSectionSerializer(sections, many=True).data
        )

    def post(self, request, series_id):
        series = _require_meeting_series_access(request, series_id)
        if series is None:
            return Response(
                {"error": "Meeting series not found"},
                status=404,
            )

        serializer = MeetingSeriesSectionCreateSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        data = serializer.validated_data

        try:
            section = create_series_section(
                meeting_series=series,
                actor=request.user,
                name=data["name"],
                description=data.get("description", ""),
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(
            MeetingSeriesSectionSerializer(section).data,
            status=201,
        )


class MeetingSeriesSectionDetailView(APIView):
    """GET/PATCH /api/meeting-series-sections/{section_id}/"""

    permission_classes = [IsAuthenticated]

    def get(self, request, section_id):
        section = _require_series_section_access(request, section_id)
        if section is None:
            return Response(
                {"error": "Series section not found"},
                status=404,
            )

        return Response(
            MeetingSeriesSectionSerializer(section).data
        )

    def patch(self, request, section_id):
        if any(
            field in request.data
            for field in [
                "meetingSeriesId",
                "meeting_series",
                "position",
            ]
        ):
            return Response(
                {
                    "error": (
                        "Cannot directly change Series section "
                        "relationships or position."
                    )
                },
                status=400,
            )

        section = _require_series_section_access(request, section_id)
        if section is None:
            return Response(
                {"error": "Series section not found"},
                status=404,
            )

        serializer = MeetingSeriesSectionPatchSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        data = serializer.validated_data

        try:
            update_series_section(
                series_section=section,
                actor=request.user,
                name=data.get("name"),
                description=data.get("description"),
                is_active=data.get("isActive"),
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        section.refresh_from_db()
        return Response(
            MeetingSeriesSectionSerializer(section).data
        )


class MeetingSeriesSectionReorderView(APIView):
    """PATCH /api/meeting-series/{series_id}/sections/reorder/"""

    permission_classes = [IsAuthenticated]

    def patch(self, request, series_id):
        series = _require_meeting_series_access(request, series_id)
        if series is None:
            return Response(
                {"error": "Meeting series not found"},
                status=404,
            )

        serializer = MeetingSeriesSectionReorderSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        data = serializer.validated_data

        try:
            reorder_series_sections(
                meeting_series=series,
                actor=request.user,
                section_ids=data["sectionIds"],
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        # Return the updated section list.
        sections = (
            MeetingSeriesSection.objects
            .filter(meeting_series=series)
            .order_by("position", "id")
        )

        return Response(
            MeetingSeriesSectionSerializer(sections, many=True).data
        )


# ── Meeting occurrence from Series ───────────────────────────────


class MeetingSeriesCreateOccurrenceView(APIView):
    """POST /api/meeting-series/{series_id}/occurrences/"""

    permission_classes = [IsAuthenticated]

    def post(self, request, series_id):
        series = _require_meeting_series_access(request, series_id)
        if series is None:
            return Response(
                {"error": "Meeting series not found"},
                status=404,
            )

        serializer = CreateMeetingFromSeriesSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        data = serializer.validated_data

        try:
            meeting = create_meeting_from_series(
                meeting_series=series,
                actor=request.user,
                title=data.get("title"),
                scheduled_at=data.get("scheduledAt"),
                status=data.get("status"),
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(MeetingSerializer(meeting).data, status=201)


# ── MeetingSection (snapshot) endpoints ──────────────────────────


class MeetingSectionListView(APIView):
    """GET /api/meetings/{meeting_id}/sections/"""

    permission_classes = [IsAuthenticated]

    def get(self, request, meeting_id):
        meeting = _require_meeting_access(request, meeting_id)
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        sections = (
            MeetingSection.objects
            .filter(meeting=meeting)
            .order_by("position", "id")
        )

        return Response(
            MeetingSectionSerializer(sections, many=True).data
        )


class ResearchGroupMeetingListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, group_id):
        group = _require_research_group_access(
            request,
            group_id,
        )
        if group is None:
            return Response([])

        meetings = (
            Meeting.objects
            .filter(research_group=group)
            .select_related(
                "research_group",
                "created_by",
            )
            .prefetch_related(
                "participant_relations",
            )
        )

        return Response(
            MeetingSerializer(
                meetings,
                many=True,
            ).data
        )

    def post(self, request, group_id):
        group = _require_research_group_access(
            request,
            group_id,
        )
        if group is None:
            return Response(
                {"error": "Research group not found"},
                status=404,
            )

        serializer = MeetingCreateSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=400,
            )

        data = serializer.validated_data

        try:
            meeting = create_meeting(
                research_group=group,
                actor=request.user,
                title=data["title"],
                scheduled_at=data["scheduledAt"],
                status=data.get("status"),
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(
            MeetingSerializer(meeting).data,
            status=201,
        )


class MeetingDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, meeting_id):
        meeting = _require_meeting_access(
            request,
            meeting_id,
        )
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        return Response(
            MeetingSerializer(meeting).data
        )

    def patch(self, request, meeting_id):
        if any(
            field in request.data
            for field in [
                "researchGroupId",
                "research_group",
                "createdById",
                "created_by",
                "participantIds",
            ]
        ):
            return Response(
                {
                    "error": (
                        "Cannot directly change Meeting "
                        "relationships or creator."
                    )
                },
                status=400,
            )

        meeting = _require_meeting_access(
            request,
            meeting_id,
        )
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        serializer = MeetingPatchSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=400,
            )

        data = serializer.validated_data

        try:
            update_meeting(
                meeting=meeting,
                actor=request.user,
                title=data.get("title"),
                scheduled_at=data.get("scheduledAt"),
                status=data.get("status"),
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        meeting.refresh_from_db()

        return Response(
            MeetingSerializer(meeting).data
        )


class MeetingParticipantListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, meeting_id):
        meeting = _require_meeting_access(
            request,
            meeting_id,
        )
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        participants = (
            MeetingParticipant.objects
            .filter(meeting=meeting)
            .select_related("user")
            .order_by("id")
        )

        return Response([
            {
                "id": participant.pk,
                "user": {
                    "id": participant.user.pk,
                    "username": participant.user.username,
                    "firstName": participant.user.first_name,
                    "lastName": participant.user.last_name,
                },
                "addedAt": participant.added_at.isoformat(),
            }
            for participant in participants
        ])

    def post(self, request, meeting_id):
        meeting = _require_meeting_access(
            request,
            meeting_id,
        )
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        user_id = request.data.get("userId")
        if user_id is None:
            return Response(
                {"error": "userId is required."},
                status=400,
            )

        try:
            target_user = User.objects.get(
                pk=user_id,
            )
        except User.DoesNotExist:
            return Response(
                {"error": "User not found."},
                status=400,
            )

        try:
            participant = add_meeting_participant(
                meeting=meeting,
                actor=request.user,
                target_user=target_user,
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(
            {
                "id": participant.pk,
                "user": {
                    "id": participant.user.pk,
                    "username": participant.user.username,
                    "firstName": participant.user.first_name,
                    "lastName": participant.user.last_name,
                },
                "addedAt": participant.added_at.isoformat(),
            },
            status=201,
        )


class MeetingParticipantDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(
        self,
        request,
        meeting_id,
        participant_id,
    ):
        meeting = _require_meeting_access(
            request,
            meeting_id,
        )
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        try:
            participant = MeetingParticipant.objects.get(
                pk=participant_id,
                meeting=meeting,
            )
        except MeetingParticipant.DoesNotExist:
            return Response(
                {"error": "Meeting participant not found"},
                status=404,
            )

        try:
            remove_meeting_participant(
                participant=participant,
                actor=request.user,
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(status=204)


class MeetingItemListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, meeting_id):
        meeting = _require_meeting_access(
            request,
            meeting_id,
        )
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        items = (
            MeetingItem.objects
            .filter(meeting=meeting)
            .select_related(
                "meeting",
                "created_by",
            )
            .prefetch_related(
                "work_item_relations",
            )
        )

        return Response(
            MeetingItemSerializer(
                items,
                many=True,
            ).data
        )

    def post(self, request, meeting_id):
        meeting = _require_meeting_access(
            request,
            meeting_id,
        )
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        serializer = MeetingItemCreateSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=400,
            )

        data = serializer.validated_data

        try:
            item = create_meeting_item(
                meeting=meeting,
                actor=request.user,
                title=data["title"],
                notes=data.get("notes", ""),
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(
            MeetingItemSerializer(item).data,
            status=201,
        )


class MeetingItemDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, meeting_item_id):
        item = _require_meeting_item_access(
            request,
            meeting_item_id,
        )
        if item is None:
            return Response(
                {"error": "Meeting item not found"},
                status=404,
            )

        return Response(
            MeetingItemSerializer(item).data
        )

    def patch(self, request, meeting_item_id):
        if any(
            field in request.data
            for field in [
                "meetingId",
                "meeting",
                "position",
                "workItemIds",
                "createdById",
                "created_by",
            ]
        ):
            return Response(
                {
                    "error": (
                        "Cannot directly change Meeting item "
                        "relationships, position, or creator."
                    )
                },
                status=400,
            )

        item = _require_meeting_item_access(
            request,
            meeting_item_id,
        )
        if item is None:
            return Response(
                {"error": "Meeting item not found"},
                status=404,
            )

        serializer = MeetingItemPatchSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=400,
            )

        data = serializer.validated_data

        try:
            update_meeting_item(
                meeting_item=item,
                actor=request.user,
                title=data.get("title"),
                notes=data.get("notes"),
                status=data.get("status"),
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        item.refresh_from_db()

        return Response(
            MeetingItemSerializer(item).data
        )



class MeetingItemWorkItemCreateView(APIView):
    """POST /api/meeting-items/{meeting_item_id}/work-items/

    Create one canonical WorkItem from a MeetingItem and retain the
    historical MeetingItem -> WorkItem relationship.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, meeting_item_id):
        item = _require_meeting_item_access(
            request,
            meeting_item_id,
        )
        if item is None:
            return Response(
                {"error": "Meeting item not found"},
                status=404,
            )

        serializer = MeetingWorkItemCreateSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=400,
            )

        data = serializer.validated_data

        membership = (
            ProjectMembership.objects
            .select_related(
                "project",
                "project__research_group",
            )
            .filter(
                project_id=data["projectId"],
                project__research_group_id=(
                    item.meeting.research_group_id
                ),
                user=request.user,
            )
            .first()
        )

        if membership is None:
            return Response(
                {"error": "Project not found"},
                status=404,
            )

        if membership.role == ProjectMembership.Role.VIEWER:
            return Response(
                {
                    "error": (
                        "A viewer cannot create WorkItems."
                    )
                },
                status=403,
            )

        try:
            work_item = create_work_item_from_meeting_item(
                meeting_item=item,
                project=membership.project,
                actor=request.user,
                type_definition_id=data["typeDefinitionId"],
                title=data["title"],
                description=data.get(
                    "description",
                    "",
                ),
                status_definition_id=data.get("statusDefinitionId"),
                assignee_ids=data.get(
                    "assigneeIds",
                    [],
                ),
                parent_id=data.get("parentId"),
                due_date=data.get("dueDate"),
                blocked_reason=data.get(
                    "blockedReason",
                ),
                label_definition_ids=data.get(
                    "labelDefinitionIds",
                    [],
                ),
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(
            serialize_work_item(work_item),
            status=201,
        )
