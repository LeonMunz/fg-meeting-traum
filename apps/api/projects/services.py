"""Project application/domain operations.

Centralizes domain rules so they are not duplicated across views.
Every operation receives the authenticated actor explicitly.
"""

from datetime import datetime, timezone as dt_timezone
from typing import Optional

from django.conf import settings
from django.db import transaction
from django.db.models import (
    Case,
    DateTimeField,
    F,
    IntegerField,
    OuterRef,
    Q,
    Subquery,
    Value,
    When,
)
from django.utils import timezone

from audit_history.services import record_audit_event
from authorization.capabilities import Capability
from authorization.service import (
    AuthorizationDenied,
    has_group_capability,
    require_project_capability,
    resolve_group_scope,
    resolve_project_scope,
)
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import (
    Project,
    ProjectMembership,
    ProjectNavigationRecency,
    WorkItemLabelDefinition,
    WorkItemStatusDefinition,
    WorkItemTypeDefinition,
)


ASSIGNMENT_RESOLUTION_UNASSIGN = "unassign"
ASSIGNMENT_RESOLUTION_TRANSFER = "transfer"
ASSIGNMENT_RESOLUTION_VALUES = {
    ASSIGNMENT_RESOLUTION_UNASSIGN,
    ASSIGNMENT_RESOLUTION_TRANSFER,
}


class ProjectAuditEventType:
    """Event types recorded for Project audit history.

    These events predate the aggregate Activity feed; the constants
    name the exact persisted event set (docs/domain/activity.md §4b).
    """

    MEMBER_ASSIGNMENTS_RESOLVED = "project.member_assignments_resolved"
    OWNERSHIP_RESOLVED_FOR_OFFBOARDING = (
        "project.ownership_resolved_for_offboarding"
    )
    ARCHIVED = "project.archived"
    RESTORED = "project.restored"
    DELETED = "project.deleted"


class ProjectDomainError(Exception):
    """Raised when a domain invariant is violated."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


def _ensure_project_not_archived(
    project: Project,
) -> None:
    """Archived Projects are retained as read-only history."""

    if project.archived_at is not None:
        raise ProjectDomainError(
            "Archived Projects are read-only. Restore the Project first."
        )


def create_project(
    *,
    research_group: ResearchGroup,
    creator,
    name: str,
    description: str = "",
    status: Optional[str] = None,
) -> Project:
    """Create a Project and atomically add creator as owner.

    The creator must have a ResearchGroupMembership in the target group.
    """
    # Validate: creator holds GROUP_CREATE_PROJECT (any active member)
    if not has_group_capability(
        creator,
        research_group.pk,
        Capability.GROUP_CREATE_PROJECT,
    ):
        raise ProjectDomainError(
            "User must be a member of this Research Group to create a Project."
        )

    # Validate status
    if status and status not in Project.Status.values:
        raise ProjectDomainError(f"Invalid project status: {status}")

    with transaction.atomic():
        project = Project.objects.create(
            name=name,
            description=description,
            status=status or Project.Status.ACTIVE,
            research_group=research_group,
            created_by=creator,
        )
        ProjectMembership.objects.create(
            project=project,
            user=creator,
            role=ProjectMembership.Role.OWNER,
            added_by=creator,
        )
        _create_default_work_item_configuration(project)

    return project


def _create_default_work_item_configuration(project: Project) -> None:
    """Create default WorkItem Types, Statuses for a new Project.

    The four default TypeDefinitions are the canonical semantic kinds:
    each carries its fixed ``kind`` (system-assigned). Custom types
    created later carry no kind (NULL).
    """
    type_defaults = [
        ("Epic", WorkItemTypeDefinition.Kind.EPIC),
        ("Milestone", WorkItemTypeDefinition.Kind.MILESTONE),
        ("Deliverable", WorkItemTypeDefinition.Kind.DELIVERABLE),
        ("Task", WorkItemTypeDefinition.Kind.TASK),
    ]
    for idx, (tname, tkind) in enumerate(type_defaults):
        WorkItemTypeDefinition.objects.create(
            project=project,
            name=tname,
            kind=tkind,
            order=idx,
        )

    status_defs = [
        ("Todo", WorkItemStatusDefinition.Category.TODO, 0, True),
        ("In Progress", WorkItemStatusDefinition.Category.IN_PROGRESS, 1, False),
        ("Review", WorkItemStatusDefinition.Category.REVIEW, 2, False),
        ("Done", WorkItemStatusDefinition.Category.DONE, 3, False),
    ]
    for name, category, order, is_default in status_defs:
        WorkItemStatusDefinition.objects.create(
            project=project,
            name=name,
            category=category,
            order=order,
            is_default=is_default,
        )


def add_project_membership(
    *,
    project: Project,
    actor,
    target_user,
    role: str,
) -> ProjectMembership:
    """Add a ProjectMembership.

    The actor must be a Project owner.
    The target user must have ResearchGroupMembership in the Project's
    Research Group.

    The Project row is locked so archiving and membership mutations
    cannot race.
    """

    if role not in ProjectMembership.Role.values:
        raise ProjectDomainError(
            f"Invalid membership role: {role}"
        )

    with transaction.atomic():
        locked_project = (
            Project.objects
            .select_for_update()
            .get(pk=project.pk)
        )

        _ensure_project_not_archived(
            locked_project,
        )

        try:
            require_project_capability(
                actor,
                locked_project.pk,
                Capability.PROJECT_MANAGE,
            )
        except AuthorizationDenied as exc:
            raise ProjectDomainError(
                "Only a Project owner can manage memberships."
            ) from exc

        if not has_group_capability(
            target_user,
            locked_project.research_group_id,
            Capability.GROUP_READ,
        ):
            raise ProjectDomainError(
                "Target user must be a member of the "
                "Project's Research Group."
            )

        if ProjectMembership.objects.filter(
            project=locked_project,
            user=target_user,
        ).exists():
            raise ProjectDomainError(
                "Target user already has a membership "
                "in this Project."
            )

        membership = ProjectMembership.objects.create(
            project=locked_project,
            user=target_user,
            role=role,
            added_by=actor,
        )

    return membership


def change_membership_role(
    *,
    membership: ProjectMembership,
    actor,
    new_role: str,
    assignment_resolution: Optional[str] = None,
    replacement_user=None,
) -> ProjectMembership:
    """Change a membership role.

    The actor must be a Project owner.
    The active Project final-owner invariant is enforced.
    If the target user is assigned to WorkItems in this project and
    the new role would make them ineligible (viewer), the change is blocked.

    Uses select_for_update() on the Project row to serialize
    concurrent ownership-changing operations.
    """
    # Validate role
    if new_role not in ProjectMembership.Role.values:
        raise ProjectDomainError(f"Invalid membership role: {new_role}")

    with transaction.atomic():
        # Lock the Project row to serialize concurrent owner mutations
        project = Project.objects.select_for_update().get(pk=membership.project.pk)

        # Reload membership under the lock to get the latest state
        membership = ProjectMembership.objects.select_for_update().get(
            pk=membership.pk
        )

        _ensure_project_not_archived(project)

        # Validate: actor holds PROJECT_MANAGE (Project owner)
        try:
            require_project_capability(
                actor, project.pk, Capability.PROJECT_MANAGE
            )
        except AuthorizationDenied as exc:
            raise ProjectDomainError(
                "Only a Project owner can manage memberships."
            ) from exc

        # Validate: final-owner invariant for active projects
        if project.status == Project.Status.ACTIVE:
            _check_final_owner_change(project, membership, new_role)

        previous_role = membership.role
        affected_assignment_count = 0

        if new_role == ProjectMembership.Role.VIEWER:
            if assignment_resolution is None:
                if replacement_user is not None:
                    raise ProjectDomainError(
                        "replacement_user requires an assignment resolution."
                    )

                _check_assignments_block_mutation(
                    project,
                    membership.user,
                )
            else:
                affected_assignment_count = (
                    _resolve_assignments_for_membership_mutation(
                        project=project,
                        target_user=membership.user,
                        resolution_mode=assignment_resolution,
                        replacement_user=replacement_user,
                    )
                )
        elif (
            assignment_resolution is not None
            or replacement_user is not None
        ):
            raise ProjectDomainError(
                "Assignment resolution is only valid when "
                "changing a membership to viewer."
            )

        membership.role = new_role
        membership.save(update_fields=["role"])

        if assignment_resolution is not None:
            record_audit_event(
                research_group=project.research_group,
                actor=actor,
                event_type=ProjectAuditEventType.MEMBER_ASSIGNMENTS_RESOLVED,
                subject_user=membership.user,
                project=project,
                data={
                    "resolution": assignment_resolution,
                    "affectedWorkItemCount": affected_assignment_count,
                    "replacementUserId": (
                        replacement_user.pk
                        if replacement_user is not None
                        else None
                    ),
                    "membershipAction": "role_changed",
                    "previousRole": previous_role,
                    "newRole": new_role,
                },
            )

    return membership


def remove_membership(
    *,
    membership: ProjectMembership,
    actor,
    assignment_resolution: Optional[str] = None,
    replacement_user=None,
) -> None:
    """Remove a ProjectMembership.

    The actor must be a Project owner.
    The active Project final-owner invariant is enforced.
    If the target user is assigned to WorkItems in this project,
    the removal is blocked.

    Uses select_for_update() on the Project row to serialize
    concurrent ownership-changing operations.
    """
    with transaction.atomic():
        # Lock the Project row to serialize concurrent owner mutations
        project = Project.objects.select_for_update().get(pk=membership.project.pk)

        # Reload membership under the lock to get the latest state
        membership = ProjectMembership.objects.select_for_update().get(
            pk=membership.pk
        )

        _ensure_project_not_archived(project)

        # Validate: actor holds PROJECT_MANAGE (Project owner)
        try:
            require_project_capability(
                actor, project.pk, Capability.PROJECT_MANAGE
            )
        except AuthorizationDenied as exc:
            raise ProjectDomainError(
                "Only a Project owner can manage memberships."
            ) from exc

        # Validate: final-owner invariant for active projects
        if project.status == Project.Status.ACTIVE:
            _check_final_owner_removal(project, membership)

        target_user = membership.user
        previous_role = membership.role
        affected_assignment_count = 0

        if assignment_resolution is None:
            if replacement_user is not None:
                raise ProjectDomainError(
                    "replacement_user requires an assignment resolution."
                )

            _check_assignments_block_mutation(
                project,
                target_user,
            )
        else:
            affected_assignment_count = (
                _resolve_assignments_for_membership_mutation(
                    project=project,
                    target_user=target_user,
                    resolution_mode=assignment_resolution,
                    replacement_user=replacement_user,
                )
            )

        membership.delete()

        if assignment_resolution is not None:
            record_audit_event(
                research_group=project.research_group,
                actor=actor,
                event_type=ProjectAuditEventType.MEMBER_ASSIGNMENTS_RESOLVED,
                subject_user=target_user,
                project=project,
                data={
                    "resolution": assignment_resolution,
                    "affectedWorkItemCount": affected_assignment_count,
                    "replacementUserId": (
                        replacement_user.pk
                        if replacement_user is not None
                        else None
                    ),
                    "membershipAction": "removed",
                    "previousRole": previous_role,
                    "newRole": None,
                },
            )


def update_project(
    *,
    project: Project,
    actor,
    name: Optional[str] = None,
    description: Optional[str] = None,
    status: Optional[str] = None,
) -> Project:
    """Update Project metadata.

    Only Project owners may update Project metadata.
    Archived Projects are read-only.

    The Project row is locked so metadata updates cannot race with
    archive/restore lifecycle operations.
    """

    if (
        status is not None
        and status not in Project.Status.values
    ):
        raise ProjectDomainError(
            f"Invalid project status: {status}"
        )

    with transaction.atomic():
        locked_project = (
            Project.objects
            .select_for_update()
            .get(pk=project.pk)
        )

        _ensure_project_not_archived(
            locked_project,
        )

        try:
            require_project_capability(
                actor,
                locked_project.pk,
                Capability.PROJECT_MANAGE,
            )
        except AuthorizationDenied as exc:
            raise ProjectDomainError(
                "Only a Project owner can update a Project."
            ) from exc

        update_fields = []

        if name is not None:
            locked_project.name = name
            update_fields.append("name")

        if description is not None:
            locked_project.description = description
            update_fields.append(
                "description"
            )

        if status is not None:
            locked_project.status = status
            update_fields.append("status")

        if update_fields:
            update_fields.append("updated_at")

            locked_project.save(
                update_fields=update_fields,
            )

    return locked_project


def archive_project(
    *,
    project: Project,
    actor,
) -> Project:
    """Archive a Project while preserving its complete history."""

    with transaction.atomic():
        project = (
            Project.objects
            .select_for_update()
            .get(pk=project.pk)
        )

        try:
            require_project_capability(
                actor,
                project.pk,
                Capability.PROJECT_MANAGE,
            )
        except AuthorizationDenied as exc:
            raise ProjectDomainError(
                "Only a Project owner can archive a Project."
            ) from exc

        if project.archived_at is not None:
            raise ProjectDomainError(
                "Project is already archived."
            )

        project.archived_at = timezone.now()
        project.save(
            update_fields=[
                "archived_at",
                "updated_at",
            ]
        )

        record_audit_event(
            research_group=project.research_group,
            actor=actor,
            event_type=ProjectAuditEventType.ARCHIVED,
            project=project,
            data={
                "status": project.status,
            },
        )

    return project


def restore_project(
    *,
    project: Project,
    actor,
) -> Project:
    """Restore an archived Project to normal editable use."""

    with transaction.atomic():
        project = (
            Project.objects
            .select_for_update()
            .get(pk=project.pk)
        )

        try:
            require_project_capability(
                actor,
                project.pk,
                Capability.PROJECT_MANAGE,
            )
        except AuthorizationDenied as exc:
            raise ProjectDomainError(
                "Only a Project owner can restore a Project."
            ) from exc

        if project.archived_at is None:
            raise ProjectDomainError(
                "Project is not archived."
            )

        project.archived_at = None
        project.save(
            update_fields=[
                "archived_at",
                "updated_at",
            ]
        )

        record_audit_event(
            research_group=project.research_group,
            actor=actor,
            event_type=ProjectAuditEventType.RESTORED,
            project=project,
            data={
                "status": project.status,
            },
        )

    return project


def delete_empty_project(
    *,
    project: Project,
    actor,
) -> None:
    """Permanently delete a disposable Project.

    Hard deletion is intentionally narrow: a Project containing any
    WorkItems is historical work and must be archived instead.
    """

    with transaction.atomic():
        project = (
            Project.objects
            .select_for_update()
            .get(pk=project.pk)
        )

        try:
            require_project_capability(
                actor,
                project.pk,
                Capability.PROJECT_MANAGE,
            )
        except AuthorizationDenied as exc:
            raise ProjectDomainError(
                "Only a Project owner can delete a Project."
            ) from exc

        if project.work_items.exists():
            raise ProjectDomainError(
                "Only Projects without WorkItems can be permanently deleted. "
                "Archive this Project instead."
            )

        project_id = project.pk
        project_name = project.name
        project_status = project.status
        archived_at = (
            project.archived_at.isoformat()
            if project.archived_at is not None
            else None
        )

        record_audit_event(
            research_group=project.research_group,
            actor=actor,
            event_type=ProjectAuditEventType.DELETED,
            project=project,
            data={
                "projectId": project_id,
                "projectName": project_name,
                "status": project_status,
                "archivedAt": archived_at,
            },
        )

        project.delete()


def get_accessible_project_qs(user):
    """Return a QuerySet of Projects the user can access.

    Effective access requires BOTH:
    - ResearchGroupMembership in the Project's Research Group
    - ProjectMembership in the Project

    The query filters only on ProjectMembership: the group-membership
    condition is enforced structurally by the composite FK added in
    migration 0005 (a ProjectMembership row cannot exist without a
    current ResearchGroupMembership in the Project's Research Group).
    Do not weaken this dependency without replacing the DB constraint.
    """
    return Project.objects.filter(
        memberships__user=user,
    ).distinct()


# ── Personal Project navigation recency (Quick Access) ──


PERSONAL_PROJECT_QUICK_ACCESS_LIMIT = 5

# Constant sort anchor: for PERSONALLY OPENED Projects the
# never-opened fallback key (created_at) must be a constant so the
# primary key DESC decides between equal recency timestamps.
_OPENED_SORT_ANCHOR = datetime.min.replace(tzinfo=dt_timezone.utc)


def record_project_open(*, actor, project) -> ProjectNavigationRecency:
    """Record that ``actor`` explicitly opened (navigated to) the Project.

    The V1 personal relevance signal for Project Quick Access.
    Requires the actor's CURRENT canonical Project read access
    (re-resolved inside the write transaction — default deny; a
    recency row is never created for a Project the actor cannot
    currently read).

    - resolves the caller's current ProjectMembership;
    - creates the personal recency row on the first open;
    - updates ``last_opened_at`` with SERVER time on every open
      (the client never supplies the timestamp);
    - never creates a second row (the OneToOne to the membership is
      the only uniqueness system; the membership row is locked so
      concurrent first-opens serialize instead of racing);
    - does NOT mutate the Project (no ``updated_at`` churn), the
      ProjectMembership, any WorkspaceNavigationPreferences, or any
      Activity event.
    """
    with transaction.atomic():
        scope = resolve_project_scope(actor, project.pk)
        if scope is None or not scope.has(Capability.PROJECT_READ):
            raise ProjectDomainError("Project not found.")

        try:
            membership = (
                ProjectMembership.objects
                .select_for_update()
                .get(project=project, user=actor)
            )
        except ProjectMembership.DoesNotExist:
            # Lost the canonical access between the scope resolution
            # and the membership lock — fail closed, persist nothing.
            raise ProjectDomainError("Project not found.")

        recency, _created = ProjectNavigationRecency.objects.update_or_create(
            project_membership=membership,
            defaults={"last_opened_at": timezone.now()},
        )

    return recency


def _personal_quick_access_candidates(projects, *, actor) -> list:
    """Rank and serialize the personal Project Quick Access candidates.

    Shared core of the per-Research-Group and the GLOBAL personal
    Quick Access read models. ``projects`` must already be the
    caller's CURRENT accessible, non-archived Project set (see
    ``get_accessible_project_qs``); this function only applies the
    canonical personal ranking, the server-owned
    ``PERSONAL_PROJECT_QUICK_ACCESS_LIMIT`` bound, and the compact
    serialization:

    - Projects with a personal ``last_opened_at`` first, newest first
      (equal timestamps by primary key DESC);
    - never-opened Projects afterwards, by ``created_at`` DESC,
      primary key DESC;
    - one compact item per Project:
      ``{"id", "researchGroupId", "name", "lastOpenedAt"}``
      (``lastOpenedAt`` is ``None`` for never-opened Projects).

    Only the CALLER's own recency rows are read
    (``project_membership__user = actor``) and recency is never read
    as authorization.
    """
    projects = (
        projects
        .annotate(
            personal_last_opened_at=Subquery(
                ProjectNavigationRecency.objects
                .filter(
                    project_membership__user=actor,
                    project_membership__project=OuterRef("pk"),
                )
                .values("last_opened_at"),
                output_field=DateTimeField(),
            ),
        )
        .order_by(
            # 1. personally opened Projects first, then never-opened
            Case(
                When(personal_last_opened_at__isnull=False, then=0),
                default=1,
                output_field=IntegerField(),
            ),
            # 2. newest personal open first (never-opened rows all
            #    tie here and fall through to the fallback keys)
            F("personal_last_opened_at").desc(nulls_last=True),
            # 3. never-opened fallback: created_at DESC — a constant
            #    anchor for opened rows so their equal-timestamp
            #    tie is decided by the primary key below
            Case(
                When(personal_last_opened_at__isnull=True, then=F("created_at")),
                default=Value(
                    _OPENED_SORT_ANCHOR,
                    output_field=DateTimeField(),
                ),
                output_field=DateTimeField(),
            ).desc(),
            # 4. primary key DESC as the final deterministic tie-breaker
            "-id",
        )[:PERSONAL_PROJECT_QUICK_ACCESS_LIMIT]
        .select_related("research_group")
    )

    return [
        {
            "id": project.pk,
            "researchGroupId": project.research_group_id,
            "name": project.name,
            "lastOpenedAt": (
                project.personal_last_opened_at.isoformat()
                if project.personal_last_opened_at is not None
                else None
            ),
        }
        for project in projects
    ]


def get_personal_project_quick_access(*, actor, research_group) -> list:
    """Personal Project Quick Access candidates for one Research Group.

    Read model for the Sidebar's future Project children (bounded to
    ``PERSONAL_PROJECT_QUICK_ACCESS_LIMIT`` candidates):

    - requires the actor's CURRENT Research Group read access;
    - includes only Projects the actor can CURRENTLY read
      (current ProjectMembership — the group-membership condition is
      enforced structurally by the composite FK, see
      ``get_accessible_project_qs``) that are NOT archived;
    - ordering: Projects with personal ``last_opened_at`` first,
      newest first (equal timestamps by primary key DESC), then
      never-opened Projects (``created_at`` DESC, primary key DESC);
    - recency rows are never read as authorization and no other
      user's recency is ever consulted.

    Returns a list of compact candidate dicts:
    ``{"id", "researchGroupId", "name", "lastOpenedAt"}``
    (``lastOpenedAt`` is ``None`` for never-opened Projects).
    """
    group_scope = resolve_group_scope(actor, research_group.pk)
    if group_scope is None or not group_scope.has(Capability.GROUP_READ):
        raise ProjectDomainError("Research group not found.")

    return _personal_quick_access_candidates(
        get_accessible_project_qs(actor).filter(
            research_group_id=research_group.pk,
            archived_at__isnull=True,
        ),
        actor=actor,
    )


def get_global_personal_project_quick_access(*, actor) -> list:
    """Personal Project Quick Access candidates across ALL Research Groups.

    GLOBAL read model for the Sidebar's Quick Access section (bounded
    to ``PERSONAL_PROJECT_QUICK_ACCESS_LIMIT`` candidates in TOTAL —
    never per Research Group):

    - requires only the caller's authentication; Research Group
      membership and order do NOT partition or influence the ranking —
      the eligible set is the actor's ENTIRE current accessible
      Project set (each membership's group-membership condition is
      enforced structurally by the composite FK, see
      ``get_accessible_project_qs``);
    - includes only Projects the actor can CURRENTLY read that are NOT
      archived;
    - ordering: identical to the per-Research-Group read model but
      computed GLOBALLY — Projects with personal ``last_opened_at``
      first, newest first (equal timestamps by primary key DESC), then
      never-opened Projects (``created_at`` DESC, primary key DESC);
    - recency rows are never read as authorization and no other
      user's recency is ever consulted;
    - empty eligible set → ``[]``.

    Returns a list of compact candidate dicts:
    ``{"id", "researchGroupId", "name", "lastOpenedAt"}``
    (``lastOpenedAt`` is ``None`` for never-opened Projects).
    """
    return _personal_quick_access_candidates(
        get_accessible_project_qs(actor).filter(
            archived_at__isnull=True,
        ),
        actor=actor,
    )

# ── Helper functions for final-owner invariant ──


def _check_final_owner_change(
    project: Project, membership: ProjectMembership, new_role: str
) -> None:
    """Check that changing a membership role doesn't leave the active project without an owner."""
    if membership.role != ProjectMembership.Role.OWNER:
        return  # Not changing an owner role

    if new_role == ProjectMembership.Role.OWNER:
        return  # Staying as owner

    # Counting OTHER owners (not this membership)
    other_owners = ProjectMembership.objects.filter(
        project=project,
        role=ProjectMembership.Role.OWNER,
    ).exclude(pk=membership.pk).count()

    if other_owners == 0:
        raise ProjectDomainError(
            "Cannot change the final owner of an active Project. "
            "Add another owner first."
        )


def _check_final_owner_removal(project: Project, membership: ProjectMembership) -> None:
    """Check that removing a membership doesn't leave the active project without an owner."""
    if membership.role != ProjectMembership.Role.OWNER:
        return

    other_owners = ProjectMembership.objects.filter(
        project=project,
        role=ProjectMembership.Role.OWNER,
    ).exclude(pk=membership.pk).count()

    if other_owners == 0:
        raise ProjectDomainError(
            "Cannot remove the final owner of an active Project. "
            "Add another owner first."
        )


# ── Assignment lifecycle protection ──


def _resolve_assignments_for_membership_mutation(
    *,
    project: Project,
    target_user,
    resolution_mode: str,
    replacement_user=None,
) -> int:
    """Resolve target assignments without touching unrelated assignees.

    The caller already holds the Project lock and transaction.
    """

    from work_items.models import WorkItemAssignee
    from work_items.services import (
        WorkItemDomainError,
        validate_assignee_eligibility,
    )

    if resolution_mode not in ASSIGNMENT_RESOLUTION_VALUES:
        raise ProjectDomainError(
            "Invalid assignment resolution. "
            "Use 'unassign' or 'transfer'."
        )

    if (
        resolution_mode
        == ASSIGNMENT_RESOLUTION_UNASSIGN
    ):
        if replacement_user is not None:
            raise ProjectDomainError(
                "Unassign resolution does not accept "
                "a replacement user."
            )

    if (
        resolution_mode
        == ASSIGNMENT_RESOLUTION_TRANSFER
    ):
        if replacement_user is None:
            raise ProjectDomainError(
                "Transfer resolution requires "
                "a replacement user."
            )

        if replacement_user.pk == target_user.pk:
            raise ProjectDomainError(
                "Assignments cannot be transferred "
                "to the same user."
            )

        try:
            validate_assignee_eligibility(
                project=project,
                user=replacement_user,
            )
        except WorkItemDomainError as exc:
            raise ProjectDomainError(
                exc.message
            ) from exc

    assignments = list(
        WorkItemAssignee.objects
        .select_for_update()
        .filter(
            work_item__project=project,
            user=target_user,
        )
        .order_by("pk")
    )

    if (
        resolution_mode
        == ASSIGNMENT_RESOLUTION_TRANSFER
    ):
        for assignment in assignments:
            WorkItemAssignee.objects.get_or_create(
                work_item_id=assignment.work_item_id,
                user=replacement_user,
            )

    if assignments:
        WorkItemAssignee.objects.filter(
            pk__in=[
                assignment.pk
                for assignment in assignments
            ]
        ).delete()

    return len(assignments)


def _check_assignments_block_mutation(project: Project, user) -> None:
    """Block a membership mutation if the user is assigned to WorkItems in this project.

    Prevents creating invalid canonical state where a WorkItemAssignee points
    to a user who is no longer an eligible assignee (viewer or non-member).

    Does NOT silently remove or reassign WorkItems. The owner must first
    unassign/reassign the user from the affected WorkItems.

    The check is performed inside the existing transaction with the Project
    row locked, preventing TOCTOU behavior.
    """
    # Lazy import to avoid import-time cycles
    from work_items.models import WorkItemAssignee

    if WorkItemAssignee.objects.filter(
        work_item__project=project,
        user=user,
    ).exists():
        raise ProjectDomainError(
            "User must be unassigned from project work items before "
            "this membership can become viewer or be removed."
        )
