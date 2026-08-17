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
)
from .serializers import (
    MeetingCreateSerializer,
    MeetingItemCreateSerializer,
    MeetingItemPatchSerializer,
    MeetingItemSerializer,
    MeetingPatchSerializer,
    MeetingSerializer,
    MeetingWorkItemCreateSerializer,
)
from .services import (
    MeetingDomainError,
    add_meeting_participant,
    create_meeting,
    create_meeting_item,
    create_work_item_from_meeting_item,
    remove_meeting_participant,
    update_meeting,
    update_meeting_item,
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
                type=data["type"],
                title=data["title"],
                description=data.get(
                    "description",
                    "",
                ),
                status=data.get("status"),
                assignee_ids=data.get(
                    "assigneeIds",
                    [],
                ),
                parent_id=data.get("parentId"),
                due_date=data.get("dueDate"),
                blocked_reason=data.get(
                    "blockedReason",
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
