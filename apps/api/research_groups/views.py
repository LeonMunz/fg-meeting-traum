from django.contrib.auth import get_user_model
from django.db.models import Q

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ResearchGroup, ResearchGroupMembership
from .services import (
    ResearchGroupDomainError,
    add_research_group_membership,
    change_research_group_membership_role,
    get_research_group_member_offboarding_preview,
    offboard_research_group_member,
    ResearchGroupProjectOffboardingResolution,
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


def _serialize_offboarding_candidate(
    candidate,
):
    return {
        "id": candidate.user.pk,
        "username": candidate.user.username,
        "firstName": candidate.user.first_name,
        "lastName": candidate.user.last_name,
        "projectRole": candidate.project_role,
    }


def _serialize_offboarding_preview(
    preview,
):
    return {
        "membershipId": preview.membership_id,
        "user": {
            "id": preview.user.pk,
            "username": preview.user.username,
            "firstName": preview.user.first_name,
            "lastName": preview.user.last_name,
        },
        "researchGroupRole": (
            preview.research_group_role
        ),
        "finalResearchGroupAdmin": (
            preview.final_research_group_admin
        ),
        "projects": [
            {
                "projectId": project.project_id,
                "name": project.name,
                "status": project.status,
                "archivedAt": (
                    project.archived_at.isoformat()
                    if project.archived_at is not None
                    else None
                ),
                "membershipRole": (
                    project.membership_role
                ),
                "assignmentCount": (
                    project.assignment_count
                ),
                "finalOwner": project.final_owner,
                "requiresOwnershipResolution": (
                    project.requires_ownership_resolution
                ),
                "ownershipCandidates": [
                    _serialize_offboarding_candidate(
                        candidate
                    )
                    for candidate
                    in project.ownership_candidates
                ],
                "assignmentCandidates": [
                    _serialize_offboarding_candidate(
                        candidate
                    )
                    for candidate
                    in project.assignment_candidates
                ],
            }
            for project in preview.projects
        ],
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


class ResearchGroupMemberCandidateListView(
    APIView,
):
    """Search users who may be added to a Research Group.

    - Research Group admin only.
    - Existing members are excluded.
    - Inactive users are excluded.
    - Short or empty queries return no results to avoid broad
      account enumeration.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, group_id):
        result = _require_group_membership(
            request,
            group_id,
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
                    "Only a Research Group admin can manage memberships."
                },
                status=403,
            )

        query = (
            request.query_params
            .get("q", "")
            .strip()
        )

        if len(query) < 2:
            return Response([])

        existing_user_ids = (
            ResearchGroupMembership.objects
            .filter(
                research_group=group,
            )
            .values_list(
                "user_id",
                flat=True,
            )
        )

        candidates = (
            User.objects
            .filter(is_active=True)
            .exclude(
                pk__in=existing_user_ids,
            )
            .filter(
                Q(
                    username__icontains=query,
                )
                | Q(
                    first_name__icontains=query,
                )
                | Q(
                    last_name__icontains=query,
                )
            )
            .order_by(
                "username",
                "pk",
            )[:20]
        )

        return Response(
            [
                {
                    "id": candidate.pk,
                    "username":
                        candidate.username,
                    "firstName":
                        candidate.first_name,
                    "lastName":
                        candidate.last_name,
                }
                for candidate
                in candidates
            ]
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


class ResearchGroupMembershipOffboardingView(
    APIView,
):
    """Preview or execute explicit Research Group offboarding."""

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
            return None, Response(
                {"error": "Research group not found"},
                status=404,
            )

        group, actor_membership = result

        if (
            actor_membership.role
            != ResearchGroupMembership.Role.ADMIN
        ):
            return None, Response(
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
            return None, Response(
                {"error": "Membership not found."},
                status=404,
            )

        return target_membership, None

    def get(
        self,
        request,
        group_id,
        membership_id,
    ):
        target_membership, error_response = (
            self._get_target(
                request,
                group_id,
                membership_id,
            )
        )

        if error_response is not None:
            return error_response

        try:
            preview = (
                get_research_group_member_offboarding_preview(
                    membership=target_membership,
                    actor=request.user,
                )
            )
        except ResearchGroupDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(
            _serialize_offboarding_preview(
                preview
            )
        )

    def post(
        self,
        request,
        group_id,
        membership_id,
    ):
        target_membership, error_response = (
            self._get_target(
                request,
                group_id,
                membership_id,
            )
        )

        if error_response is not None:
            return error_response

        raw_projects = request.data.get(
            "projects",
            [],
        )

        if not isinstance(raw_projects, list):
            return Response(
                {
                    "error":
                    "projects must be a list."
                },
                status=400,
            )

        resolutions = []

        for raw_project in raw_projects:
            if not isinstance(raw_project, dict):
                return Response(
                    {
                        "error":
                        "Each Project resolution must be an object."
                    },
                    status=400,
                )

            project_id = raw_project.get(
                "projectId"
            )

            if project_id is None:
                return Response(
                    {
                        "error":
                        "projectId is required."
                    },
                    status=400,
                )

            (
                ownership_mode,
                ownership_replacement,
                parse_error,
            ) = self._parse_resolution(
                raw_project.get(
                    "ownershipResolution"
                ),
                label="ownershipResolution",
            )

            if parse_error is not None:
                return parse_error

            (
                assignment_mode,
                assignment_replacement,
                parse_error,
            ) = self._parse_resolution(
                raw_project.get(
                    "assignmentResolution"
                ),
                label="assignmentResolution",
            )

            if parse_error is not None:
                return parse_error

            resolutions.append(
                ResearchGroupProjectOffboardingResolution(
                    project_id=project_id,
                    assignment_resolution=(
                        assignment_mode
                    ),
                    assignment_replacement_user=(
                        assignment_replacement
                    ),
                    ownership_resolution=(
                        ownership_mode
                    ),
                    ownership_replacement_user=(
                        ownership_replacement
                    ),
                )
            )

        try:
            result = offboard_research_group_member(
                membership=target_membership,
                actor=request.user,
                project_resolutions=resolutions,
            )
        except ResearchGroupDomainError as exc:
            return Response(
                {"error": exc.message},
                status=400,
            )

        return Response(
            {
                "detail": "Member offboarded",
                "summary": {
                    "removedProjectMembershipCount": (
                        result.removed_project_membership_count
                    ),
                    "affectedWorkItemCount": (
                        result.affected_work_item_count
                    ),
                    "transferredAssignmentCount": (
                        result.transferred_assignment_count
                    ),
                    "unassignedAssignmentCount": (
                        result.unassigned_assignment_count
                    ),
                    "ownershipTransferCount": (
                        result.ownership_transfer_count
                    ),
                    "archivedProjectCount": (
                        result.archived_project_count
                    ),
                },
            },
            status=200,
        )

    def _parse_resolution(
        self,
        raw_resolution,
        *,
        label,
    ):
        if raw_resolution is None:
            return None, None, None

        if not isinstance(
            raw_resolution,
            dict,
        ):
            return (
                None,
                None,
                Response(
                    {
                        "error":
                        f"{label} must be an object."
                    },
                    status=400,
                ),
            )

        mode = raw_resolution.get("mode")

        if (
            not isinstance(mode, str)
            or not mode.strip()
        ):
            return (
                None,
                None,
                Response(
                    {
                        "error":
                        f"{label}.mode is required."
                    },
                    status=400,
                ),
            )

        mode = mode.strip()

        replacement_user_id = (
            raw_resolution.get(
                "replacementUserId"
            )
        )

        replacement_user = None

        if replacement_user_id is not None:
            try:
                replacement_user = User.objects.get(
                    pk=replacement_user_id
                )
            except (
                User.DoesNotExist,
                TypeError,
                ValueError,
            ):
                return (
                    None,
                    None,
                    Response(
                        {
                            "error":
                            "Replacement user not found."
                        },
                        status=400,
                    ),
                )

        return (
            mode,
            replacement_user,
            None,
        )
