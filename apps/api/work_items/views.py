"""Work Item API views.

Read authorization uses the existing Project security boundary:
- GET list: requires ProjectMembership (owner/member/viewer)
- GET detail: requires ProjectMembership (owner/member/viewer)
- POST create: requires ProjectMembership owner/member (not viewer)
- PATCH update: requires ProjectMembership owner/member (not viewer)
"""

from datetime import date, datetime

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from projects.models import Project, ProjectMembership
from research_groups.models import ResearchGroupMembership

from .models import WorkItem, WorkItemAssignee
from .serializers import WorkItemSerializer
from .services import (
    WorkItemDomainError,
    create_work_item,
    update_work_item,
)


def _require_project_access(request, project_id):
    """Return (Project, membership) if user has effective access, else None.

    Effective access requires BOTH:
    - ResearchGroupMembership in the Project's Research Group
    - ProjectMembership in the Project
    """
    try:
        membership = ProjectMembership.objects.select_related(
            "project",
        ).get(
            project_id=project_id,
            user=request.user,
        )
    except (ProjectMembership.DoesNotExist, Project.DoesNotExist):
        return None

    # Verify current ResearchGroupMembership — membership may be stale
    if not ResearchGroupMembership.objects.filter(
        research_group=membership.project.research_group,
        user=request.user,
    ).exists():
        return None

    return membership.project, membership


def _serialize_work_item(work_item):
    """Serialize a WorkItem to the API response shape."""
    serializer = WorkItemSerializer(work_item)
    data = serializer.data
    return {
        "id": data["id"],
        "projectId": data["projectId"],
        "type": data["type"],
        "title": data["title"],
        "description": data["description"],
        "status": data["status"],
        "assigneeIds": data["assigneeIds"],
        "parentId": data["parentId"],
        "dueDate": data["dueDate"].isoformat()
        if isinstance(data["dueDate"], (date, datetime))
        else data["dueDate"],
        "blockedReason": data["blockedReason"] or None,
        "completedAt": data["completedAt"],
        "createdAt": data["createdAt"],
        "updatedAt": data["updatedAt"],
        "createdById": data["createdById"],
    }


# ── Project WorkItem List ──


class ProjectWorkItemListCreateView(APIView):
    """GET/POST /api/projects/{project_id}/work-items/

    GET: List WorkItems for a Project.
    Requires ProjectMembership (owner/member/viewer).

    POST: Create a WorkItem in a Project.
    Requires ProjectMembership owner/member (not viewer).
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

        # Query scoped to this project
        work_items = WorkItem.objects.filter(
            project_id=project_id,
        ).select_related("project", "created_by", "parent")

        data = [_serialize_work_item(wi) for wi in work_items]
        return Response(data)

    def post(self, request, project_id):
        result = _require_project_access(request, project_id)
        if result is None:
            return Response(
                {"error": "Project not found"},
                status=404,
            )
        project, membership = result

        # Viewer cannot create
        if membership.role == ProjectMembership.Role.VIEWER:
            return Response(
                {"error": "A viewer cannot create WorkItems."},
                status=403,
            )

        # Extract data from request — ignore projectId, createdById, completedAt
        work_item_type = request.data.get("type")
        title = request.data.get("title", "").strip()
        description = request.data.get("description", "").strip()
        status = request.data.get("status")
        assignee_ids = request.data.get("assigneeIds") or []
        parent_id = request.data.get("parentId")
        due_date = request.data.get("dueDate")
        blocked_reason = request.data.get("blockedReason") or ""

        if not title:
            return Response(
                {"error": "WorkItem title is required."},
                status=400,
            )

        if not work_item_type:
            return Response(
                {"error": "WorkItem type is required."},
                status=400,
            )

        try:
            wi = create_work_item(
                project=project,
                actor=request.user,
                type=work_item_type,
                title=title,
                description=description,
                status=status,
                assignee_ids=assignee_ids,
                parent_id=parent_id,
                due_date=due_date,
                blocked_reason=blocked_reason,
            )
        except WorkItemDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(_serialize_work_item(wi), status=201)


# ── WorkItem Detail (Read/Update) ──


class WorkItemDetailView(APIView):
    """GET/PATCH /api/work-items/{work_item_id}/

    GET: Read a WorkItem.
    Requires ProjectMembership in the WorkItem's Project.

    PATCH: Update a WorkItem.
    Requires ProjectMembership owner/member (not viewer).
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, work_item_id):
        try:
            work_item = WorkItem.objects.select_related(
                "project", "created_by", "parent",
            ).get(pk=work_item_id)
        except WorkItem.DoesNotExist:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )

        # Check access through Project
        result = _require_project_access(request, work_item.project_id)
        if result is None:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )

        return Response(_serialize_work_item(work_item))

    def patch(self, request, work_item_id):
        try:
            work_item = WorkItem.objects.select_related(
                "project",
            ).get(pk=work_item_id)
        except WorkItem.DoesNotExist:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )

        # Check access through Project
        result = _require_project_access(request, work_item.project_id)
        if result is None:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )
        project, membership = result

        # Viewer cannot update
        if membership.role == ProjectMembership.Role.VIEWER:
            return Response(
                {"error": "A viewer cannot modify WorkItems."},
                status=403,
            )

        # Reject attempts to change project
        if "projectId" in request.data or "project" in request.data:
            return Response(
                {"error": "Cannot change the Project of a WorkItem."},
                status=400,
            )

        # Reject attempts to change created_by
        if "createdById" in request.data or "created_by" in request.data:
            return Response(
                {"error": "Cannot change the creator of a WorkItem."},
                status=400,
            )

        # Reject attempts to change completed_at directly
        if "completedAt" in request.data or "completed_at" in request.data:
            return Response(
                {"error": "Cannot directly change completedAt. Use status transitions."},
                status=400,
            )

        # Build kwargs for update — only include fields that are present
        update_kwargs = {"work_item": work_item, "actor": request.user}
        for field_name, param_name in [
            ("type", "type"),
            ("title", "title"),
            ("description", "description"),
            ("status", "status"),
            ("assigneeIds", "assignee_ids"),
            ("dueDate", "due_date"),
            ("blockedReason", "blocked_reason"),
        ]:
            if field_name in request.data:
                update_kwargs[param_name] = request.data[field_name]

        # Handle parentId separately: None is a valid value to clear parent
        if "parentId" in request.data:
            update_kwargs["parent_id"] = request.data["parentId"]

        try:
            update_work_item(**update_kwargs)
        except WorkItemDomainError as exc:
            return Response({"error": exc.message}, status=400)

        work_item.refresh_from_db()
        return Response(_serialize_work_item(work_item))


# ── My Work Authorized Projection ──


class MyWorkView(APIView):
    """GET /api/research-groups/{group_id}/my-work/

    Returns WorkItems assigned to the current user in Projects they
    have access to within the specified Research Group.

    My Work is a QUERY / PROJECTION over canonical WorkItems:
    - No separate MyWork model
    - No duplicated WorkItem rows
    - Same WorkItem IDs as Project WorkItem views

    Authorization:
    - Requires authentication (IsAuthenticated)
    - Requires ResearchGroupMembership in the requested group
    - Requires ProjectMembership (owner or member) on each WorkItem's project
    - Returns 404 if user is not a member of the Research Group
      (non-leaking behavior)

    The response uses the same canonical WorkItem API representation
    as GET /api/projects/{project_id}/work-items/
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, group_id):
        # Verify ResearchGroupMembership — non-leaking 404
        try:
            ResearchGroupMembership.objects.get(
                research_group_id=group_id,
                user=request.user,
            )
        except (ResearchGroupMembership.DoesNotExist,
                ResearchGroupMembership.MultipleObjectsReturned):
            return Response(
                {"error": "Research group not found"},
                status=404,
            )

        # Query: WorkItems assigned to current user where:
        # 1. WorkItemAssignee.user == request.user
        # 2. WorkItem.project.research_group_id == group_id
        # 3. ProjectMembership exists for request.user on the project
        # 4. ProjectMembership role is owner or member (defense-in-depth)
        work_items = (
            WorkItem.objects
            .filter(
                assignee_relations__user=request.user,
                project__research_group_id=group_id,
                project__memberships__user=request.user,
                project__memberships__role__in=[
                    ProjectMembership.Role.OWNER,
                    ProjectMembership.Role.MEMBER,
                ],
            )
            .distinct()
            .select_related("project", "created_by", "parent")
        )

        data = [_serialize_work_item(wi) for wi in work_items]
        return Response(data)
