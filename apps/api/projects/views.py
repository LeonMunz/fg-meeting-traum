"""Project read/write API views."""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import Project, ProjectMembership
from .serializers import ProjectSerializer
from .services import (
    ProjectDomainError,
    add_project_membership,
    change_membership_role,
    create_project,
    get_accessible_project_qs,
    remove_membership,
    update_project,
)


def _require_research_group_membership(request, group_id):
    """Return the ResearchGroup if the user is a member, else None."""
    try:
        ResearchGroupMembership.objects.get(
            research_group_id=group_id,
            user=request.user,
        )
    except (ResearchGroupMembership.DoesNotExist, ResearchGroup.DoesNotExist):
        return None
    return ResearchGroup.objects.filter(pk=group_id).first()


def _require_project_access(request, project_id):
    """Return (Project, membership) if user has access, else None."""
    try:
        membership = ProjectMembership.objects.get(
            project_id=project_id,
            user=request.user,
        )
    except (ProjectMembership.DoesNotExist, Project.DoesNotExist):
        return None
    return membership.project, membership


# ── Research Group Project List ──


class ResearchGroupProjectListView(APIView):
    """GET /api/research-groups/{group_id}/projects/

    Returns only Projects where:
    - caller is a member of the Research Group AND
    - caller has ProjectMembership in the Project

    Research Group admin alone is insufficient.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, group_id):
        group = _require_research_group_membership(request, group_id)
        if group is None:
            # Return empty list — don't leak whether the Research Group exists
            return Response([])

        # Filter: Projects the user has ProjectMembership in,
        # AND that belong to this Research Group.
        projects = get_accessible_project_qs(request.user).filter(
            research_group_id=group_id,
        ).select_related("research_group")

        data = []
        for project in projects:
            membership = project.memberships.get(user=request.user)
            data.append({
                "id": project.pk,
                "researchGroupId": project.research_group.pk,
                "name": project.name,
                "description": project.description,
                "status": project.status,
                "currentUserRole": membership.role,
                "createdAt": project.created_at.isoformat(),
                "updatedAt": project.updated_at.isoformat(),
            })

        return Response(data)

    def post(self, request, group_id):
        """POST /api/research-groups/{group_id}/projects/

        Any Research Group member can create a Project.
        Creator becomes owner atomically.
        """
        group = _require_research_group_membership(request, group_id)
        if group is None:
            return Response(
                {"error": "Research group not found"},
                status=404,
            )

        name = request.data.get("name", "").strip()
        description = request.data.get("description", "").strip()
        status = request.data.get("status")

        if not name:
            return Response(
                {"error": "Project name is required."},
                status=400,
            )

        try:
            project = create_project(
                research_group=group,
                creator=request.user,
                name=name,
                description=description,
                status=status,
            )
        except ProjectDomainError as exc:
            return Response({"error": exc.message}, status=400)

        membership = project.memberships.get(user=request.user)
        return Response({
            "id": project.pk,
            "researchGroupId": project.research_group.pk,
            "name": project.name,
            "description": project.description,
            "status": project.status,
            "currentUserRole": membership.role,
            "createdAt": project.created_at.isoformat(),
            "updatedAt": project.updated_at.isoformat(),
        }, status=201)


# ── Project Detail (Read) ──


class ProjectDetailView(APIView):
    """GET /api/projects/{project_id}/

    Returns Project only if user has ProjectMembership.
    404 for inaccessible projects.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, project_id):
        result = _require_project_access(request, project_id)
        if result is None:
            return Response(
                {"error": "Project not found"},
                status=404,
            )
        project, membership = result

        return Response({
            "id": project.pk,
            "researchGroupId": project.research_group.pk,
            "name": project.name,
            "description": project.description,
            "status": project.status,
            "currentUserRole": membership.role,
            "createdAt": project.created_at.isoformat(),
            "updatedAt": project.updated_at.isoformat(),
        })

    def patch(self, request, project_id):
        """PATCH /api/projects/{project_id}/

        Only Project owners may update Project metadata.
        """
        result = _require_project_access(request, project_id)
        if result is None:
            return Response(
                {"error": "Project not found"},
                status=404,
            )
        project, membership = result

        if membership.role != ProjectMembership.Role.OWNER:
            return Response(
                {"error": "Only a Project owner can update a Project."},
                status=403,
            )

        name = request.data.get("name")
        description = request.data.get("description")
        status = request.data.get("status")

        # Prevent moving to another Research Group
        if "researchGroupId" in request.data or "research_group" in request.data:
            return Response(
                {"error": "Cannot change the Research Group of a Project."},
                status=400,
            )

        try:
            update_project(
                project=project,
                actor=request.user,
                name=name if name is not None else None,
                description=description if description is not None else None,
                status=status if status is not None else None,
            )
        except ProjectDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response({
            "id": project.pk,
            "researchGroupId": project.research_group.pk,
            "name": project.name,
            "description": project.description,
            "status": project.status,
            "currentUserRole": membership.role,
            "createdAt": project.created_at.isoformat(),
            "updatedAt": project.updated_at.isoformat(),
        })


# ── Project Membership List ──


class ProjectMembershipListView(APIView):
    """GET /api/projects/{project_id}/memberships/

    Allowed: owner, member, viewer.
    404 for no access.

    POST to add a membership.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, project_id):
        result = _require_project_access(request, project_id)
        if result is None:
            return Response(
                {"error": "Project not found"},
                status=404,
            )

        memberships = ProjectMembership.objects.filter(
            project_id=project_id,
        ).select_related("user")

        data = []
        for membership in memberships:
            data.append({
                "id": membership.pk,
                "role": membership.role,
                "addedAt": membership.added_at.isoformat() if membership.added_at else None,
                "user": {
                    "id": membership.user.pk,
                    "username": membership.user.username,
                    "firstName": membership.user.first_name,
                    "lastName": membership.user.last_name,
                },
            })

        return Response(data)

    def post(self, request, project_id):
        """POST /api/projects/{project_id}/memberships/

        Owner only.
        """
        result = _require_project_access(request, project_id)
        if result is None:
            return Response(
                {"error": "Project not found"},
                status=404,
            )
        project, membership = result

        if membership.role != ProjectMembership.Role.OWNER:
            return Response(
                {"error": "Only a Project owner can manage memberships."},
                status=403,
            )

        user_id = request.data.get("userId")
        role = request.data.get("role")

        if user_id is None:
            return Response(
                {"error": "userId is required."},
                status=400,
            )

        # Get target user
        from django.contrib.auth import get_user_model
        User = get_user_model()
        try:
            target_user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return Response(
                {"error": "User not found."},
                status=400,
            )

        try:
            new_membership = add_project_membership(
                project=project,
                actor=request.user,
                target_user=target_user,
                role=role or ProjectMembership.Role.MEMBER,
            )
        except ProjectDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response({
            "id": new_membership.pk,
            "role": new_membership.role,
            "addedAt": new_membership.added_at.isoformat() if new_membership.added_at else None,
            "user": {
                "id": new_membership.user.pk,
                "username": new_membership.user.username,
                "firstName": new_membership.user.first_name,
                "lastName": new_membership.user.last_name,
            },
        }, status=201)


# ── Project Membership Detail (Change/Remove) ──


class ProjectMembershipDetailView(APIView):
    """PATCH /api/projects/{project_id}/memberships/{membership_id}/

    Owner only: change role.
    """

    permission_classes = [IsAuthenticated]

    def patch(self, request, project_id, membership_id):
        result = _require_project_access(request, project_id)
        if result is None:
            return Response(
                {"error": "Project not found"},
                status=404,
            )
        project, membership = result

        if membership.role != ProjectMembership.Role.OWNER:
            return Response(
                {"error": "Only a Project owner can manage memberships."},
                status=403,
            )

        try:
            target_membership = ProjectMembership.objects.get(
                pk=membership_id,
                project=project,  # ID scoping: must belong to this project
            )
        except ProjectMembership.DoesNotExist:
            return Response(
                {"error": "Membership not found."},
                status=404,
            )

        new_role = request.data.get("role")
        if new_role is None:
            return Response(
                {"error": "role is required."},
                status=400,
            )

        try:
            change_membership_role(
                membership=target_membership,
                actor=request.user,
                new_role=new_role,
            )
        except ProjectDomainError as exc:
            return Response({"error": exc.message}, status=400)

        target_membership.refresh_from_db()

        return Response({
            "id": target_membership.pk,
            "role": target_membership.role,
            "addedAt": target_membership.added_at.isoformat() if target_membership.added_at else None,
            "user": {
                "id": target_membership.user.pk,
                "username": target_membership.user.username,
                "firstName": target_membership.user.first_name,
                "lastName": target_membership.user.last_name,
            },
        })

    def delete(self, request, project_id, membership_id):
        """DELETE /api/projects/{project_id}/memberships/{membership_id}/

        Owner only.
        """
        result = _require_project_access(request, project_id)
        if result is None:
            return Response(
                {"error": "Project not found"},
                status=404,
            )
        project, membership = result

        if membership.role != ProjectMembership.Role.OWNER:
            return Response(
                {"error": "Only a Project owner can manage memberships."},
                status=403,
            )

        try:
            target_membership = ProjectMembership.objects.get(
                pk=membership_id,
                project=project,  # ID scoping
            )
        except ProjectMembership.DoesNotExist:
            return Response(
                {"error": "Membership not found."},
                status=404,
            )

        try:
            remove_membership(
                membership=target_membership,
                actor=request.user,
            )
        except ProjectDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response({"detail": "Membership removed"}, status=200)


# ── Research Group Members List ──


class ResearchGroupMembersView(APIView):
    """GET /api/research-groups/{group_id}/members/

    List Research Group members (for Project membership selection).
    Caller must be a Research Group member.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, group_id):
        group = _require_research_group_membership(request, group_id)
        if group is None:
            return Response(
                {"error": "Research group not found"},
                status=404,
            )

        memberships = ResearchGroupMembership.objects.filter(
            research_group_id=group_id,
        ).select_related("user")

        data = []
        for m in memberships:
            data.append({
                "id": m.user.pk,
                "username": m.user.username,
                "firstName": m.user.first_name,
                "lastName": m.user.last_name,
                "researchGroupRole": m.role,
            })

        return Response(data)
