from django.db.models import F
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

from audit_history.models import AuditEvent
from projects.models import Project, ProjectMembership
from research_groups.models import ResearchGroupMembership

from .models import WorkItem, WorkItemAssignee, WorkItemComment
from .serializers import (
    WorkItemCommentSerializer,
    WorkItemHistoryEventSerializer,
    WorkItemSerializer,
)
from .services import (
    WorkItemAuditEventType,
    WorkItemDomainError,
    create_work_item,
    create_work_item_comment,
    delete_work_item,
    delete_work_item_comment,
    update_work_item,
    update_work_item_comment,
    reposition_work_item,
    resolve_work_item_meeting_origin,
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


def serialize_work_item(work_item, user=None):
    """Serialize a WorkItem to the API response shape.

    When ``user`` is provided, the response also carries
    ``meetingOrigin`` — the persisted Meeting -> MeetingItem ->
    MeetingNote source (when this WorkItem was created from a Note),
    resolved through the source relation and permission-filtered so
    Meeting content never leaks to users who cannot read that
    Meeting.
    """
    serializer = WorkItemSerializer(work_item)
    data = serializer.data
    result = {
        "id": data["id"],
        "projectId": data["projectId"],
        "title": data["title"],
        "description": data["description"],
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
        "typeDefinitionId": data["typeDefinitionId"],
        "statusDefinitionId": data["statusDefinitionId"],
        "boardPosition": data["boardPosition"],
        "labelDefinitionIds": data["labelDefinitionIds"],
    }
    if user is not None:
        result["meetingOrigin"] = (
            resolve_work_item_meeting_origin(work_item, user)
        )
    return result


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

        # Query scoped to this project. Board columns are rendered in
        # this order: persisted manual position (WorkItem.board_position)
        # first, with unsorted items (NULL) following in canonical
        # creation order. The same list the Project Board and List
        # render from, so a WorkItem created through the Meeting
        # quick-create flow is immediately visible here without
        # requiring a client-side refresh.
        work_items = WorkItem.objects.filter(
            project_id=project_id,
        ).select_related("project", "created_by", "parent").order_by(
            F("board_position").asc(nulls_last=True),
            "created_at",
            "id",
        )

        data = [serialize_work_item(wi, user=request.user) for wi in work_items]
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
        title = request.data.get("title", "").strip()
        description = request.data.get("description", "").strip()
        assignee_ids = request.data.get("assigneeIds") or []
        parent_id = request.data.get("parentId")
        due_date = request.data.get("dueDate")
        blocked_reason = request.data.get("blockedReason") or ""
        type_definition_id = request.data.get("typeDefinitionId")
        status_definition_id = request.data.get("statusDefinitionId")
        label_definition_ids = request.data.get("labelDefinitionIds") or []

        if not title:
            return Response(
                {"error": "WorkItem title is required."},
                status=400,
            )

        if not type_definition_id:
            return Response(
                {"error": "typeDefinitionId is required."},
                status=400,
            )

        try:
            wi = create_work_item(
                project=project,
                actor=request.user,
                type_definition_id=type_definition_id,
                title=title,
                description=description,
                status_definition_id=status_definition_id,
                assignee_ids=assignee_ids,
                parent_id=parent_id,
                due_date=due_date,
                blocked_reason=blocked_reason,
                label_definition_ids=label_definition_ids,
            )
        except WorkItemDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(serialize_work_item(wi, user=request.user), status=201)


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

        return Response(serialize_work_item(work_item, user=request.user))

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
            ("title", "title"),
            ("description", "description"),
            ("assigneeIds", "assignee_ids"),
            ("dueDate", "due_date"),
            ("blockedReason", "blocked_reason"),
            ("typeDefinitionId", "type_definition_id"),
            ("statusDefinitionId", "status_definition_id"),
            ("labelDefinitionIds", "label_definition_ids"),
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
        return Response(serialize_work_item(work_item, user=request.user))

    def delete(self, request, work_item_id):
        try:
            work_item = WorkItem.objects.get(pk=work_item_id)
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

        # Viewer cannot delete
        if membership.role == ProjectMembership.Role.VIEWER:
            return Response(
                {"error": "A viewer cannot delete WorkItems."},
                status=403,
            )

        try:
            delete_work_item(work_item=work_item, actor=request.user)
        except WorkItemDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(status=204)



# ── WorkItem Board reorder (drag/drop) ──


class WorkItemReorderView(APIView):
    """POST /api/work-items/{work_item_id}/reorder/

    Single atomic Board drag/drop operation: moves the Work Item to an
    exact position inside a Board column. When the target column differs
    from the Work Item's current column, the canonical status_definition
    moves with it, so a cross-column drop is never split into a race-prone
    status PATCH followed by a position PATCH.

    Body (both fields optional):
    - statusDefinitionId: target column (Project status definition ID).
      Omit to keep the Work Item's current status.
    - beforeWorkItemId: Work Item that should follow the moved one in the
      target column. Omit / null to place it at the end of the column.

    Requires ProjectMembership owner/member (not viewer).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, work_item_id):
        try:
            work_item = WorkItem.objects.get(pk=work_item_id)
        except WorkItem.DoesNotExist:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )

        result = _require_project_access(request, work_item.project_id)
        if result is None:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )
        project, membership = result

        if membership.role == ProjectMembership.Role.VIEWER:
            return Response(
                {"error": "A viewer cannot modify WorkItems."},
                status=403,
            )

        status_definition_id = request.data.get("statusDefinitionId")
        if status_definition_id is not None:
            try:
                status_definition_id = int(status_definition_id)
            except (TypeError, ValueError):
                return Response(
                    {"error": "statusDefinitionId is invalid."},
                    status=400,
                )

        before_work_item_id = request.data.get("beforeWorkItemId")
        if before_work_item_id is not None:
            try:
                before_work_item_id = int(before_work_item_id)
            except (TypeError, ValueError):
                return Response(
                    {"error": "beforeWorkItemId is invalid."},
                    status=400,
                )

        if (
            status_definition_id is None
            and before_work_item_id is None
        ):
            return Response(
                {"error": "Nothing to reorder: provide a target status, "
                          "a before Work Item, or both."},
                status=400,
            )

        try:
            repositioned = reposition_work_item(
                work_item=work_item,
                actor=request.user,
                status_definition_id=status_definition_id,
                before_work_item_id=before_work_item_id,
            )
        except WorkItemDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(serialize_work_item(repositioned, user=request.user))


# ── WorkItem History (read-only) ──


class WorkItemHistoryView(APIView):
    """GET /api/work-items/{work_item_id}/history/

    Read-only WorkItem audit history. This is specifically WorkItem
    history, not a generic AuditEvent API — it only ever returns
    work_item.created / work_item.updated events for exactly this
    WorkItem.

    Uses the SAME effective read-access rule as GET on the WorkItem
    itself (ProjectMembership owner/member/viewer AND current
    ResearchGroupMembership). Research Group admin status alone does
    not grant access to a private Project, matching WorkItem reads.

    Returns newest first (AuditEvent's default ordering), bounded to
    the latest HISTORY_LIMIT events. The API has no pagination
    convention elsewhere, so this first slice intentionally keeps a
    small, explicit, tested bound instead of inventing one.
    """

    permission_classes = [IsAuthenticated]

    HISTORY_LIMIT = 50

    def get(self, request, work_item_id):
        try:
            work_item = WorkItem.objects.select_related(
                "project",
            ).get(pk=work_item_id)
        except WorkItem.DoesNotExist:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )

        # Check access through Project — identical rule to
        # WorkItemDetailView.get, so a user who cannot view the
        # WorkItem cannot read its history either.
        result = _require_project_access(request, work_item.project_id)
        if result is None:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )

        events = (
            AuditEvent.objects
            .filter(
                work_item_id=work_item.pk,
                event_type__in=[
                    WorkItemAuditEventType.CREATED,
                    WorkItemAuditEventType.UPDATED,
                ],
            )
            .select_related("actor")
            [: self.HISTORY_LIMIT]
        )

        serializer = WorkItemHistoryEventSerializer(
            events, many=True,
        )
        return Response(serializer.data)


# ── WorkItem Comments ──


def serialize_work_item_comment(comment):
    """Serialize a WorkItemComment to the API response shape."""
    return WorkItemCommentSerializer(comment).data


class WorkItemCommentListCreateView(APIView):
    """GET/POST /api/work-items/{work_item_id}/comments/

    GET: List comments for a WorkItem, newest first. Uses the SAME
    effective read-access rule as GET on the WorkItem itself.

    POST: Create a comment on a WorkItem.
    Requires ProjectMembership owner/member (not viewer) — matching
    WorkItem mutation semantics.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, work_item_id):
        try:
            work_item = WorkItem.objects.select_related(
                "project",
            ).get(pk=work_item_id)
        except WorkItem.DoesNotExist:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )

        result = _require_project_access(request, work_item.project_id)
        if result is None:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )

        comments = (
            WorkItemComment.objects
            .filter(work_item_id=work_item.pk)
            .select_related("author")
        )

        data = [
            serialize_work_item_comment(comment)
            for comment in comments
        ]
        return Response(data)

    def post(self, request, work_item_id):
        try:
            work_item = WorkItem.objects.select_related(
                "project",
            ).get(pk=work_item_id)
        except WorkItem.DoesNotExist:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )

        result = _require_project_access(request, work_item.project_id)
        if result is None:
            return Response(
                {"error": "WorkItem not found"},
                status=404,
            )
        project, membership = result

        # Viewer cannot comment — same boundary as WorkItem writes.
        if membership.role == ProjectMembership.Role.VIEWER:
            return Response(
                {"error": "A viewer cannot comment on WorkItems."},
                status=403,
            )

        body = request.data.get("body", "")

        try:
            comment = create_work_item_comment(
                work_item=work_item,
                actor=request.user,
                body=body,
            )
        except WorkItemDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(
            serialize_work_item_comment(comment), status=201,
        )


class WorkItemCommentDetailView(APIView):
    """PATCH/DELETE /api/work-item-comments/{comment_id}/

    Resolving the comment at all requires the same effective read
    access as its parent WorkItem (non-leaking 404). Editing or
    deleting additionally requires being the comment's own author —
    no moderator/admin bypass.
    """

    permission_classes = [IsAuthenticated]

    def _get_visible_comment(self, request, comment_id):
        """Return the comment if it exists and is visible to the
        requester, else None. Never distinguishes "doesn't exist"
        from "not visible" in the response."""
        try:
            comment = WorkItemComment.objects.select_related(
                "work_item__project", "author",
            ).get(pk=comment_id)
        except WorkItemComment.DoesNotExist:
            return None

        result = _require_project_access(
            request, comment.work_item.project_id,
        )
        if result is None:
            return None

        return comment

    def patch(self, request, comment_id):
        comment = self._get_visible_comment(request, comment_id)
        if comment is None:
            return Response(
                {"error": "Comment not found"}, status=404,
            )

        if comment.author_id != request.user.pk:
            return Response(
                {"error": "You can only edit your own comment."},
                status=403,
            )

        body = request.data.get("body", "")

        try:
            comment = update_work_item_comment(
                comment=comment, actor=request.user, body=body,
            )
        except WorkItemDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(serialize_work_item_comment(comment))

    def delete(self, request, comment_id):
        comment = self._get_visible_comment(request, comment_id)
        if comment is None:
            return Response(
                {"error": "Comment not found"}, status=404,
            )

        if comment.author_id != request.user.pk:
            return Response(
                {"error": "You can only delete your own comment."},
                status=403,
            )

        try:
            delete_work_item_comment(
                comment=comment, actor=request.user,
            )
        except WorkItemDomainError as exc:
            return Response({"error": exc.message}, status=400)

        return Response(status=204)


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

        data = [serialize_work_item(wi, user=request.user) for wi in work_items]
        return Response(data)


# ── Personal My Work Projection ──


class PersonalMyWorkView(APIView):
    """GET /api/me/work-items/

    Personal projection of all WorkItems assigned to the current user
    across every Research Group they currently belong to.

    Optional:
        ?group=<research_group_id>

    Authorization remains based on canonical memberships:
    - current ResearchGroupMembership
    - current ProjectMembership with owner/member role
    - current WorkItem assignment

    Project privacy is unchanged. Research Group membership alone never
    grants access to Project work.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        group_param = request.query_params.get("group")

        group_id = None

        if group_param is not None:
            try:
                group_id = int(group_param)
            except (TypeError, ValueError):
                return Response(
                    {"error": "group must be a valid Research Group ID."},
                    status=400,
                )

            if group_id <= 0:
                return Response(
                    {"error": "group must be a valid Research Group ID."},
                    status=400,
                )

            if not ResearchGroupMembership.objects.filter(
                research_group_id=group_id,
                user=request.user,
            ).exists():
                # Do not leak whether another Research Group exists.
                return Response(
                    {"error": "Research group not found"},
                    status=404,
                )

        work_items = (
            WorkItem.objects
            .filter(
                assignee_relations__user=request.user,
                project__memberships__user=request.user,
                project__memberships__role__in=[
                    ProjectMembership.Role.OWNER,
                    ProjectMembership.Role.MEMBER,
                ],
                project__research_group__memberships__user=request.user,
            )
            .distinct()
            .select_related(
                "project",
                "project__research_group",
                "created_by",
                "parent",
            )
        )

        if group_id is not None:
            work_items = work_items.filter(
                project__research_group_id=group_id,
            )

        data = []

        for work_item in work_items:
            item = serialize_work_item(work_item, user=request.user)

            item.update({
                "projectName": work_item.project.name,
                "researchGroupId": (
                    work_item.project.research_group_id
                ),
                "researchGroupName": (
                    work_item.project.research_group.name
                ),
            })

            data.append(item)

        return Response(data)
