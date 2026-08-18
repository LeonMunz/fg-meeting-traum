from django.contrib.auth import get_user_model

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ResearchGroup, ResearchGroupMembership
from .services import (
    ResearchGroupDomainError,
    add_research_group_membership,
    change_research_group_membership_role,
    remove_research_group_membership,
    update_research_group,
)

User = get_user_model()


def _require_group_membership(
    request,
    group_id,
):
    """Return (ResearchGroup, membership) for accessible groups.

    Returns None when the caller is not a member so group existence
    is not leaked.
    """
    try:
        membership = (
            ResearchGroupMembership.objects
            .select_related("research_group")
            .get(
                research_group_id=group_id,
                user=request.user,
            )
        )
    except ResearchGroupMembership.DoesNotExist:
        return None

    return membership.research_group, membership


def _serialize_group(
    research_group,
    membership,
):
    return {
        "id": research_group.pk,
        "name": research_group.name,
        "role": membership.role,
    }


def _serialize_membership(
    membership,
):
    return {
        "id": membership.pk,
        "role": membership.role,
        "joinedAt": (
            membership.joined_at.isoformat()
            if membership.joined_at
            else None
        ),
        "user": {
            "id": membership.user.pk,
            "username": membership.user.username,
            "firstName": membership.user.first_name,
            "lastName": membership.user.last_name,
        },
    }


class ResearchGroupListView(APIView):
    """List Research Groups the current user belongs to."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        memberships = (
            ResearchGroupMembership.objects
            .filter(user=request.user)
            .select_related("research_group")
        )

        groups = [
            _serialize_group(
                membership.research_group,
                membership,
            )
            for membership in memberships
        ]

        return Response(groups)


class ResearchGroupDetailView(APIView):
    """Read or update a Research Group.

    GET:
    - any Research Group member

    PATCH:
    - Research Group admin only

    Inaccessible groups return 404.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        result = _require_group_membership(
            request,
            pk,
        )

        if result is None:
            return Response(
                {"error": "Research group not found"},
                status=404,
            )

        group, membership = result

        return Response(
            _serialize_group(
                group,
                membership,
            )
        )

    def patch(self, request, pk):
        result = _require_group_membership(
            request,
            pk,
        )

        if result is None:
            return Response(
                {"error": "Research group not found"},
                status=404,
            )

        group, membership = result

        if (
            membership.role
            != ResearchGroupMembership.Role.ADMIN
        ):
            return Response(
                {
                    "error":
                    "Only a Research Group admin can manage this Research Group."
                },
                status=403,
            )

        if "createdById" in request.data:
            return Response(
                {
                    "error":
                    "Cannot change the creator of a Research Group."
                },
                status=400,
            )

        name = request.data.get("name")

        try:
            update_research_group(
                research_group=group,
                actor=request.user,
                name=name,
            )
        except ResearchGroupDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        group.refresh_from_db()

        return Response(
            _serialize_group(
                group,
                membership,
            )
        )


class ResearchGroupMembershipListView(
    APIView,
):
    """Administrative Research Group membership collection.

    GET:
    - admin only
    - lists current memberships

    POST:
    - admin only
    - adds an existing user to the Research Group

    This endpoint is intentionally separate from /members/, which is
    the normal group directory / picker endpoint.
    """

    permission_classes = [IsAuthenticated]

    def _require_admin(
        self,
        request,
        group_id,
    ):
        result = _require_group_membership(
            request,
            group_id,
        )

        if result is None:
            return None, Response(
                {"error": "Research group not found"},
                status=404,
            )

        group, membership = result

        if (
            membership.role
            != ResearchGroupMembership.Role.ADMIN
        ):
            return None, Response(
                {
                    "error":
                    "Only a Research Group admin can manage memberships."
                },
                status=403,
            )

        return group, None

    def get(self, request, group_id):
        group, error_response = (
            self._require_admin(
                request,
                group_id,
            )
        )

        if error_response is not None:
            return error_response

        memberships = (
            ResearchGroupMembership.objects
            .filter(research_group=group)
            .select_related("user")
            .order_by("joined_at", "pk")
        )

        return Response(
            [
                _serialize_membership(membership)
                for membership in memberships
            ]
        )

    def post(self, request, group_id):
        group, error_response = (
            self._require_admin(
                request,
                group_id,
            )
        )

        if error_response is not None:
            return error_response

        user_id = request.data.get("userId")
        role = (
            request.data.get("role")
            or ResearchGroupMembership.Role.MEMBER
        )

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
            membership = (
                add_research_group_membership(
                    research_group=group,
                    actor=request.user,
                    target_user=target_user,
                    role=role,
                )
            )
        except ResearchGroupDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        membership = (
            ResearchGroupMembership.objects
            .select_related("user")
            .get(pk=membership.pk)
        )

        return Response(
            _serialize_membership(membership),
            status=201,
        )


class ResearchGroupMembershipDetailView(
    APIView,
):
    """Administrative Research Group membership detail.

    PATCH:
    - change admin/member role

    DELETE:
    - remove an uncomplicated membership

    Complex Project dependencies are deliberately rejected here and
    will later be handled by the explicit offboarding workflow.
    """

    permission_classes = [IsAuthenticated]

    def _get_target(
        self,
        request,
        group_id,
        membership_id,
    ):
        result = _require_group_membership(
            request,
            group_id,
        )

        if result is None:
            return None, None, Response(
                {"error": "Research group not found"},
                status=404,
            )

        group, actor_membership = result

        if (
            actor_membership.role
            != ResearchGroupMembership.Role.ADMIN
        ):
            return None, None, Response(
                {
                    "error":
                    "Only a Research Group admin can manage memberships."
                },
                status=403,
            )

        try:
            target_membership = (
                ResearchGroupMembership.objects
                .select_related("user")
                .get(
                    pk=membership_id,
                    research_group=group,
                )
            )
        except ResearchGroupMembership.DoesNotExist:
            return None, None, Response(
                {"error": "Membership not found."},
                status=404,
            )

        return (
            group,
            target_membership,
            None,
        )

    def patch(
        self,
        request,
        group_id,
        membership_id,
    ):
        (
            group,
            target_membership,
            error_response,
        ) = self._get_target(
            request,
            group_id,
            membership_id,
        )

        if error_response is not None:
            return error_response

        new_role = request.data.get("role")

        if new_role is None:
            return Response(
                {"error": "role is required."},
                status=400,
            )

        try:
            changed = (
                change_research_group_membership_role(
                    membership=target_membership,
                    actor=request.user,
                    new_role=new_role,
                )
            )
        except ResearchGroupDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        changed = (
            ResearchGroupMembership.objects
            .select_related("user")
            .get(pk=changed.pk)
        )

        return Response(
            _serialize_membership(changed)
        )

    def delete(
        self,
        request,
        group_id,
        membership_id,
    ):
        (
            group,
            target_membership,
            error_response,
        ) = self._get_target(
            request,
            group_id,
            membership_id,
        )

        if error_response is not None:
            return error_response

        try:
            remove_research_group_membership(
                membership=target_membership,
                actor=request.user,
            )
        except ResearchGroupDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(
            {"detail": "Membership removed"},
            status=200,
        )
