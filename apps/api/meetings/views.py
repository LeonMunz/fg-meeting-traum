from django.contrib.auth import get_user_model
from django.db.models import Q

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
    MeetingNote,
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
    MeetingNoteCreateSerializer,
    MeetingNotePatchSerializer,
    MeetingNoteSerializer,
    MeetingPatchSerializer,
    MeetingSectionCreateSerializer,
    MeetingSectionPatchSerializer,
    MeetingSectionReorderSerializer,
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
    PROJECT_READ_ROLES,
    PROJECT_WRITE_ROLES,
    add_meeting_participant,
    create_meeting,
    delete_meeting,
    create_meeting_from_series,
    create_meeting_item,
    create_meeting_note,
    focus_meeting_item,
    mark_meeting_item_done,
    mark_meeting_item_follow_up,
    create_meeting_section,
    create_meeting_series,
    create_series_section,
    create_work_item_from_meeting_item,
    delete_meeting_note,
    end_meeting,
    list_meeting_item_notes,
    reopen_meeting,
    reorder_meeting_sections,
    reorder_series_sections,
    remove_meeting_participant,
    start_meeting,
    update_meeting,
    update_meeting_note,
    update_meeting_section,
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
            "project",
            "created_by",
        ).get(pk=meeting_id)
    except Meeting.DoesNotExist:
        return None

    if not _has_scoped_read_access(request.user, meeting):
        return None

    return meeting


def _require_meeting_item_access(request, meeting_item_id):
    try:
        item = MeetingItem.objects.select_related(
            "meeting",
            "meeting__research_group",
            "meeting__project",
            "created_by",
        ).prefetch_related(
            "note_relations__author",
        ).get(pk=meeting_item_id)
    except MeetingItem.DoesNotExist:
        return None

    if not _has_scoped_read_access(request.user, item.meeting):
        return None

    return item


def _require_meeting_note_access(request, note_id):
    try:
        note = MeetingNote.objects.select_related(
            "meeting_item",
            "meeting_item__meeting",
            "meeting_item__meeting__research_group",
            "meeting_item__meeting__project",
            "author",
        ).get(pk=note_id)
    except MeetingNote.DoesNotExist:
        return None

    if not _has_scoped_read_access(
        request.user, note.meeting_item.meeting
    ):
        return None

    return note


def _require_meeting_series_access(request, series_id):
    try:
        series = MeetingSeries.objects.select_related(
            "research_group",
            "project",
            "created_by",
        ).get(pk=series_id)
    except MeetingSeries.DoesNotExist:
        return None

    if not _has_scoped_read_access(request.user, series):
        return None

    return series


def _require_series_section_access(request, section_id):
    try:
        section = MeetingSeriesSection.objects.select_related(
            "meeting_series",
            "meeting_series__research_group",
            "meeting_series__project",
        ).get(pk=section_id)
    except MeetingSeriesSection.DoesNotExist:
        return None

    if not _has_scoped_read_access(request.user, section.meeting_series):
        return None

    return section


def _require_meeting_section_access(request, section_id):
    try:
        section = MeetingSection.objects.select_related(
            "meeting",
            "meeting__research_group",
            "meeting__project",
        ).get(pk=section_id)
    except MeetingSection.DoesNotExist:
        return None

    if not _has_scoped_read_access(request.user, section.meeting):
        return None

    return section


def _has_scoped_read_access(user, resource):
    if not ResearchGroupMembership.objects.filter(
        research_group_id=resource.research_group_id,
        user=user,
    ).exists():
        return False

    if resource.scope == Meeting.Scope.GROUP:
        return resource.project_id is None

    return (
        resource.scope == Meeting.Scope.PROJECT
        and resource.project_id is not None
        and ProjectMembership.objects.filter(
            project_id=resource.project_id,
            user=user,
            role__in=PROJECT_READ_ROLES,
        ).exists()
    )


def _has_project_write_access(user, project):
    if project.archived_at is not None:
        return False

    return ProjectMembership.objects.filter(
        project=project,
        user=user,
        role__in=PROJECT_WRITE_ROLES,
    ).exists()


def _has_scoped_write_access(user, resource):
    if not _has_scoped_read_access(user, resource):
        return False

    if resource.scope == Meeting.Scope.GROUP:
        return True

    return _has_project_write_access(user, resource.project)


def _mutation_forbidden_response():
    return Response(
        {
            "error": (
                "You do not have permission to modify "
                "this Project Meeting resource."
            )
        },
        status=403,
    )


def _run_meeting_lifecycle_action(request, meeting, action):
    """Shared handler for explicit Start/End lifecycle actions.

    Enforces the scope-aware Meeting write rule, runs the domain
    transition, and returns the updated canonical Meeting.
    """
    if not _has_scoped_write_access(request.user, meeting):
        return _mutation_forbidden_response()

    try:
        return Response(
            MeetingSerializer(
                action(meeting=meeting, actor=request.user)
            ).data
        )
    except MeetingDomainError as exc:
        return Response({"error": exc.message}, status=400)


def _accessible_scope_filter(user):
    return (
        Q(scope=Meeting.Scope.GROUP, project__isnull=True)
        | Q(
            scope=Meeting.Scope.PROJECT,
            project__memberships__user=user,
            project__memberships__role__in=PROJECT_READ_ROLES,
        )
    )


def _resolve_project_for_scope_read(*, group, user, scope, project_id):
    if scope == Meeting.Scope.GROUP:
        if project_id is not None:
            raise MeetingDomainError(
                "A group-scoped Meeting cannot reference a Project."
            )
        return None

    if project_id is None:
        raise MeetingDomainError(
            "A project-scoped Meeting requires projectId."
        )

    membership = (
        ProjectMembership.objects
        .select_related("project", "project__research_group")
        .filter(
            project_id=project_id,
            project__research_group=group,
            user=user,
            role__in=PROJECT_READ_ROLES,
        )
        .first()
    )
    if membership is None:
        return None

    return membership.project


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
            .filter(_accessible_scope_filter(request.user))
            .select_related("research_group", "project", "created_by")
            .distinct()
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
            project = _resolve_project_for_scope_read(
                group=group,
                user=request.user,
                scope=data["scope"],
                project_id=data.get("projectId"),
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        if data["scope"] == Meeting.Scope.PROJECT and project is None:
            return Response({"error": "Project not found"}, status=404)

        if project is not None and not _has_project_write_access(
            request.user,
            project,
        ):
            return _mutation_forbidden_response()

        try:
            series = create_meeting_series(
                research_group=group,
                actor=request.user,
                title=data["title"],
                description=data.get("description", ""),
                scope=data["scope"],
                project=project,
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
        series = _require_meeting_series_access(request, series_id)
        if series is None:
            return Response(
                {"error": "Meeting series not found"},
                status=404,
            )

        if not _has_scoped_write_access(request.user, series):
            return _mutation_forbidden_response()

        if any(
            field in request.data
            for field in [
                "researchGroupId",
                "research_group",
                "scope",
                "projectId",
                "project",
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

        if not _has_scoped_write_access(request.user, series):
            return _mutation_forbidden_response()

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
        section = _require_series_section_access(request, section_id)
        if section is None:
            return Response(
                {"error": "Series section not found"},
                status=404,
            )

        if not _has_scoped_write_access(
            request.user,
            section.meeting_series,
        ):
            return _mutation_forbidden_response()

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

        if not _has_scoped_write_access(request.user, series):
            return _mutation_forbidden_response()

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

        if not _has_scoped_write_access(request.user, series):
            return _mutation_forbidden_response()

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


class MeetingSectionListCreateView(APIView):
    """GET/POST /api/meetings/{meeting_id}/sections/"""

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

    def post(self, request, meeting_id):
        meeting = _require_meeting_access(request, meeting_id)
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        if not _has_scoped_write_access(request.user, meeting):
            return _mutation_forbidden_response()

        serializer = MeetingSectionCreateSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        data = serializer.validated_data

        try:
            section = create_meeting_section(
                meeting=meeting,
                actor=request.user,
                name=data["name"],
                description=data.get("description", ""),
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(
            MeetingSectionSerializer(section).data,
            status=201,
        )


class MeetingSectionReorderView(APIView):
    """PATCH /api/meetings/{meeting_id}/sections/reorder/"""

    permission_classes = [IsAuthenticated]

    def patch(self, request, meeting_id):
        meeting = _require_meeting_access(request, meeting_id)
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        if not _has_scoped_write_access(request.user, meeting):
            return _mutation_forbidden_response()

        serializer = MeetingSectionReorderSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        data = serializer.validated_data

        try:
            reorder_meeting_sections(
                meeting=meeting,
                actor=request.user,
                section_ids=data["sectionIds"],
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        sections = (
            MeetingSection.objects
            .filter(meeting=meeting)
            .order_by("position", "id")
        )

        return Response(
            MeetingSectionSerializer(sections, many=True).data
        )


class MeetingSectionDetailView(APIView):
    """GET/PATCH /api/meeting-sections/{section_id}/"""

    permission_classes = [IsAuthenticated]

    def get(self, request, section_id):
        section = _require_meeting_section_access(
            request,
            section_id,
        )
        if section is None:
            return Response(
                {"error": "Meeting section not found"},
                status=404,
            )

        return Response(
            MeetingSectionSerializer(section).data
        )

    def patch(self, request, section_id):
        section = _require_meeting_section_access(
            request,
            section_id,
        )
        if section is None:
            return Response(
                {"error": "Meeting section not found"},
                status=404,
            )

        if not _has_scoped_write_access(request.user, section.meeting):
            return _mutation_forbidden_response()

        if any(
            field in request.data
            for field in [
                "meetingId",
                "meeting",
                "position",
                "sourceSeriesSectionId",
            ]
        ):
            return Response(
                {
                    "error": (
                        "Cannot directly change Meeting section "
                        "relationships or position."
                    )
                },
                status=400,
            )

        serializer = MeetingSectionPatchSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        data = serializer.validated_data

        try:
            update_meeting_section(
                section=section,
                actor=request.user,
                name=data.get("name"),
                description=data.get("description"),
                is_visible=data.get("isVisible"),
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        section.refresh_from_db()

        return Response(
            MeetingSectionSerializer(section).data
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
            .filter(_accessible_scope_filter(request.user))
            .select_related(
                "research_group",
                "project",
                "created_by",
            )
            .prefetch_related(
                "participant_relations",
            )
            .distinct()
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
            project = _resolve_project_for_scope_read(
                group=group,
                user=request.user,
                scope=data["scope"],
                project_id=data.get("projectId"),
            )
        except MeetingDomainError as exc:
            return Response({"error": exc.message}, status=400)

        if data["scope"] == Meeting.Scope.PROJECT and project is None:
            return Response({"error": "Project not found"}, status=404)

        if project is not None and not _has_project_write_access(
            request.user,
            project,
        ):
            return _mutation_forbidden_response()

        try:
            meeting = create_meeting(
                research_group=group,
                actor=request.user,
                title=data["title"],
                scheduled_at=data["scheduledAt"],
                status=data.get("status"),
                scope=data["scope"],
                project=project,
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
        meeting = _require_meeting_access(
            request,
            meeting_id,
        )
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        if not _has_scoped_write_access(request.user, meeting):
            return _mutation_forbidden_response()

        if any(
            field in request.data
            for field in [
                "researchGroupId",
                "research_group",
                "scope",
                "projectId",
                "project",
                "createdById",
                "created_by",
                "participantIds",
                "status",
                "startedAt",
                "endedAt",
            ]
        ):
            return Response(
                {
                    "error": (
                        "Cannot change Meeting lifecycle or "
                        "relationships directly. Use the Start "
                        "and End actions."
                    )
                },
                status=400,
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

    def delete(self, request, meeting_id):
        meeting = _require_meeting_access(
            request,
            meeting_id,
        )
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        if not _has_scoped_write_access(request.user, meeting):
            return _mutation_forbidden_response()

        try:
            delete_meeting(meeting=meeting, actor=request.user)
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(status=204)


class MeetingStartView(APIView):
    """POST /api/meetings/{id}/start — explicit upcoming -> live action."""

    permission_classes = [IsAuthenticated]

    def post(self, request, meeting_id):
        meeting = _require_meeting_access(request, meeting_id)
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        return _run_meeting_lifecycle_action(
            request,
            meeting,
            start_meeting,
        )


class MeetingEndView(APIView):
    """POST /api/meetings/{id}/end — explicit live -> completed action."""

    permission_classes = [IsAuthenticated]

    def post(self, request, meeting_id):
        meeting = _require_meeting_access(request, meeting_id)
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        return _run_meeting_lifecycle_action(
            request,
            meeting,
            end_meeting,
        )


class MeetingReopenView(APIView):
    """POST /api/meetings/{id}/reopen — explicit completed -> live action."""

    permission_classes = [IsAuthenticated]

    def post(self, request, meeting_id):
        meeting = _require_meeting_access(request, meeting_id)
        if meeting is None:
            return Response(
                {"error": "Meeting not found"},
                status=404,
            )

        return _run_meeting_lifecycle_action(
            request,
            meeting,
            reopen_meeting,
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

        if not _has_scoped_write_access(request.user, meeting):
            return _mutation_forbidden_response()

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

        if not _has_scoped_write_access(request.user, meeting):
            return _mutation_forbidden_response()

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
                "note_relations__author",
                "note_relations__work_item_relations__work_item__project",
                "note_relations__work_item_relations__work_item__status_definition",
                "note_relations__work_item_relations__work_item__assignee_relations__user",
            )
        )

        return Response(
            MeetingItemSerializer(
                items,
                many=True,
                context={"request": request},
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

        if not _has_scoped_write_access(request.user, meeting):
            return _mutation_forbidden_response()

        serializer = MeetingItemCreateSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=400,
            )

        data = serializer.validated_data

        section = (
            MeetingSection.objects
            .filter(
                pk=data["meetingSectionId"],
                meeting=meeting,
            )
            .first()
        )
        if section is None:
            return Response(
                {
                    "error": (
                        "The section does not belong to this "
                        "meeting."
                    )
                },
                status=400,
            )

        try:
            item = create_meeting_item(
                meeting=meeting,
                meeting_section=section,
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
            MeetingItemSerializer(
                item,
                context={"request": request},
            ).data,
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
            MeetingItemSerializer(
                item,
                context={"request": request},
            ).data
        )

    def patch(self, request, meeting_item_id):
        item = _require_meeting_item_access(
            request,
            meeting_item_id,
        )
        if item is None:
            return Response(
                {"error": "Meeting item not found"},
                status=404,
            )

        if not _has_scoped_write_access(request.user, item.meeting):
            return _mutation_forbidden_response()

        if any(
            field in request.data
            for field in [
                "meetingId",
                "meeting",
                "meetingSectionId",
                "meeting_section",
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

        serializer = MeetingItemPatchSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=400,
            )

        data = serializer.validated_data

        if "status" in request.data:
            return Response(
                {
                    "error": (
                        "Meeting item status is driven by the "
                        "Live Meeting actions (start, focus, "
                        "done, follow-up)."
                    )
                },
                status=400,
            )

        try:
            update_meeting_item(
                meeting_item=item,
                actor=request.user,
                title=data.get("title"),
                notes=data.get("notes"),
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        item.refresh_from_db()

        return Response(
            MeetingItemSerializer(
                item,
                context={"request": request},
            ).data
        )



class MeetingItemWorkItemCreateView(APIView):
    """POST /api/meeting-items/{meeting_item_id}/work-items/

    Create one canonical WorkItem from a MeetingItem and retain the
    historical MeetingItem -> WorkItem relationship.

    When the payload carries ``meetingNoteId``, the WorkItem becomes
    the primary WorkItem of that exact persisted MeetingNote (one
    primary WorkItem per Note).
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

        if not _has_scoped_write_access(request.user, item.meeting):
            return _mutation_forbidden_response()

        serializer = MeetingWorkItemCreateSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=400,
            )

        data = serializer.validated_data

        note = None
        note_id = data.get("meetingNoteId")
        if note_id is not None:
            note = MeetingNote.objects.filter(
                pk=note_id,
                meeting_item=item,
            ).first()
            if note is None:
                return Response(
                    {
                        "error": (
                            "The Note does not belong to "
                            "this Meeting item."
                        )
                    },
                    status=400,
                )

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
                meeting_note=note,
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(
            serialize_work_item(work_item, user=request.user),
            status=201,
        )


def _run_meeting_item_action(request, item, action):
    """Shared handler for canonical Live MeetingItem actions.

    Enforces the existing Meeting write authorization and returns
    the updated canonical MeetingItem.
    """
    if not _has_scoped_write_access(request.user, item.meeting):
        return _mutation_forbidden_response()

    try:
        updated = action(meeting_item=item, actor=request.user)
    except MeetingDomainError as exc:
        return Response({"error": exc.message}, status=400)

    return Response(
        MeetingItemSerializer(
            updated,
            context={"request": request},
        ).data
    )


class MeetingItemFocusView(APIView):
    """POST /api/meeting-items/{id}/focus — make the selected
    not_discussed item the current item of a Live Meeting."""

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

        return _run_meeting_item_action(
            request,
            item,
            focus_meeting_item,
        )


class MeetingItemDoneView(APIView):
    """POST /api/meeting-items/{id}/done — mark the current item
    done and advance to the next not_discussed item."""

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

        return _run_meeting_item_action(
            request,
            item,
            mark_meeting_item_done,
        )


class MeetingItemFollowUpView(APIView):
    """POST /api/meeting-items/{id}/follow-up — mark the current
    item as a follow-up and advance to the next not_discussed
    item."""

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

        return _run_meeting_item_action(
            request,
            item,
            mark_meeting_item_follow_up,
        )


class MeetingItemNoteListCreateView(APIView):
    """GET/POST /api/meeting-items/{meeting_item_id}/notes/

    GET: list the Notes owned by this MeetingItem (deterministic
    order). Uses the same effective read access as the MeetingItem.

    POST: create one persistent Note. Requires the existing Meeting
    write authorization model and a Live Meeting (Upcoming and
    Completed Meetings reject Note authoring).
    """

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

        notes = list_meeting_item_notes(
            meeting_item=item,
            user=request.user,
        )

        return Response(
            MeetingNoteSerializer(
                notes,
                many=True,
                context={"request": request},
            ).data
        )

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

        if not _has_scoped_write_access(request.user, item.meeting):
            return _mutation_forbidden_response()

        serializer = MeetingNoteCreateSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=400,
            )

        try:
            note = create_meeting_note(
                meeting_item=item,
                actor=request.user,
                content=serializer.validated_data["content"],
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(
            MeetingNoteSerializer(
                note,
                context={"request": request},
            ).data,
            status=201,
        )


class MeetingNoteDetailView(APIView):
    """GET/PATCH/DELETE /api/meeting-notes/{note_id}/

    Resolving the Note at all requires the same effective read access
    as its parent MeetingItem (non-leaking 404). Editing or deleting
    additionally requires the existing Meeting write authorization
    and a Live Meeting.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, note_id):
        note = _require_meeting_note_access(
            request,
            note_id,
        )
        if note is None:
            return Response(
                {"error": "Meeting note not found"},
                status=404,
            )

        return Response(
            MeetingNoteSerializer(
                note,
                context={"request": request},
            ).data
        )

    def patch(self, request, note_id):
        note = _require_meeting_note_access(
            request,
            note_id,
        )
        if note is None:
            return Response(
                {"error": "Meeting note not found"},
                status=404,
            )

        if not _has_scoped_write_access(
            request.user, note.meeting_item.meeting
        ):
            return _mutation_forbidden_response()

        if any(
            field in request.data
            for field in [
                "id",
                "meetingItemId",
                "meeting_item",
                "author",
                "createdAt",
                "created_at",
                "updatedAt",
                "updated_at",
            ]
        ):
            return Response(
                {
                    "error": (
                        "Cannot directly change Meeting Note "
                        "identity, author, or timestamps."
                    )
                },
                status=400,
            )

        serializer = MeetingNotePatchSerializer(
            data=request.data,
        )
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=400,
            )

        try:
            note = update_meeting_note(
                note=note,
                actor=request.user,
                content=serializer.validated_data["content"],
            )
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(
            MeetingNoteSerializer(
                note,
                context={"request": request},
            ).data
        )

    def delete(self, request, note_id):
        note = _require_meeting_note_access(
            request,
            note_id,
        )
        if note is None:
            return Response(
                {"error": "Meeting note not found"},
                status=404,
            )

        if not _has_scoped_write_access(
            request.user, note.meeting_item.meeting
        ):
            return _mutation_forbidden_response()

        try:
            delete_meeting_note(note=note, actor=request.user)
        except MeetingDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(status=204)
