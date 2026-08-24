"""Work Item application/domain operations.

Centralizes domain rules for WorkItem creation and mutation.
Every operation receives the authenticated actor explicitly.
"""

from typing import Optional

from django.db import transaction
from django.db.models import QuerySet

from audit_history.services import record_audit_event
from projects.models import (
    Project,
    ProjectMembership,
    WorkItemLabelDefinition,
    WorkItemStatusDefinition,
    WorkItemTypeDefinition,
)
from research_groups.models import ResearchGroupMembership

from .models import WorkItem, WorkItemAssignee, WorkItemComment, WorkItemLabel


class WorkItemAuditEventType:
    """Event types recorded for WorkItem history.

    Intentionally coarse: ONE event per logical operation (not one per
    changed field). Update details live in AuditEvent.data["changes"].
    """

    CREATED = "work_item.created"
    UPDATED = "work_item.updated"


class WorkItemDomainError(Exception):
    """Raised when a WorkItem domain invariant is violated."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


# Sentinel to distinguish "not provided" from "explicitly None"
_UNSET = object()


# ── Assignee validation ──


def _validate_assignee_eligibility(project: Project, user) -> None:
    """Validate that a user is eligible to be assigned to a WorkItem in the project.

    The user must have BOTH:
    - ResearchGroupMembership in the Project's Research Group
    - ProjectMembership in the Project with role 'owner' or 'member'

    A viewer or non-member cannot be assigned.
    Stale ProjectMembership (whose ResearchGroupMembership no longer exists)
    is rejected.
    """
    # Check current ResearchGroupMembership
    if not ResearchGroupMembership.objects.filter(
        research_group=project.research_group,
        user=user,
    ).exists():
        raise WorkItemDomainError(
            f"User '{user.username}' does not have a current "
            "ResearchGroupMembership and cannot be assigned."
        )

    membership = ProjectMembership.objects.filter(
        project=project,
        user=user,
    ).first()
    if membership is None:
        raise WorkItemDomainError(
            f"User '{user.username}' does not have ProjectMembership and cannot be assigned."
        )
    if membership.role == ProjectMembership.Role.VIEWER:
        raise WorkItemDomainError(
            f"User '{user.username}' is a viewer and cannot be assigned to a WorkItem."
        )


def validate_assignee_eligibility(
    *,
    project: Project,
    user,
) -> None:
    """Validate whether a user may currently receive Project work."""

    _validate_assignee_eligibility(
        project,
        user,
    )


def _validate_assignees(project: Project, user_ids: list[int]) -> None:
    """Validate all assignees are eligible for the project."""
    from django.contrib.auth import get_user_model
    User = get_user_model()

    if not user_ids:
        return

    users = User.objects.filter(pk__in=user_ids)
    user_ids_in_db = set(users.values_list("pk", flat=True))

    # Check all requested IDs exist
    missing = set(user_ids) - user_ids_in_db
    if missing:
        raise WorkItemDomainError(
            f"User IDs not found: {sorted(missing)}"
        )

    for user in users:
        _validate_assignee_eligibility(project, user)


# ── Hierarchy validation ──


def _validate_parent(project: Project, parent_id: Optional[int]) -> None:
    """Validate parent relationship for a WorkItem.

    Rules:
    - Parent must belong to the same Project
    - Cannot parent self
    - No cycles allowed
    """
    if parent_id is None:
        return

    try:
        parent = WorkItem.objects.get(pk=parent_id)
    except WorkItem.DoesNotExist:
        raise WorkItemDomainError("Parent WorkItem does not exist.")

    if parent.project_id != project.pk:
        raise WorkItemDomainError(
            "Parent WorkItem must belong to the same Project."
        )

    # Cycle detection: walk up the parent chain from the parent
    visited = {parent_id}
    current = parent
    while current.parent is not None:
        if current.parent_id in visited:
            raise WorkItemDomainError(
                "Adding this parent would create a cycle in the WorkItem hierarchy."
            )
        visited.add(current.parent_id)
        current = current.parent


def _validate_parent_with_new_item(
    project: Project, parent_id: Optional[int], work_item_id: int
) -> None:
    """Validate parent relationship for a new WorkItem that doesn't exist yet.

    Used during creation when we know the item ID is not yet in the tree.
    The new item's ID should not appear in the ancestry chain (it won't,
    since it's new).
    """
    if parent_id is None:
        return

    try:
        parent = WorkItem.objects.get(pk=parent_id)
    except WorkItem.DoesNotExist:
        raise WorkItemDomainError("Parent WorkItem does not exist.")

    if parent.project_id != project.pk:
        raise WorkItemDomainError(
            "Parent WorkItem must belong to the same Project."
        )

    # Self-parent check (shouldn't happen for new items but defensive)
    if parent_id == work_item_id:
        raise WorkItemDomainError("A WorkItem cannot be its own parent.")

    # Cycle detection from the parent upward
    visited = {parent_id}
    current = parent
    while current.parent is not None:
        if current.parent_id == work_item_id:
            raise WorkItemDomainError(
                "Adding this parent would create a cycle in the WorkItem hierarchy."
            )
        if current.parent_id in visited:
            raise WorkItemDomainError(
                "Adding this parent would create a cycle in the WorkItem hierarchy."
            )
        visited.add(current.parent_id)
        current = current.parent


# ── Definition validation (same-project invariant) ──


def _resolve_type_definition(project: Project, type_def_id: int) -> WorkItemTypeDefinition:
    """Resolve a type definition ID, enforcing same-project invariant."""
    try:
        defn = WorkItemTypeDefinition.objects.get(pk=type_def_id)
    except WorkItemTypeDefinition.DoesNotExist:
        raise WorkItemDomainError("Type definition does not exist.")
    if defn.project_id != project.pk:
        raise WorkItemDomainError("Type definition must belong to the same Project.")
    return defn


def _resolve_status_definition(
    project: Project, status_def_id: int
) -> WorkItemStatusDefinition:
    """Resolve a status definition ID, enforcing same-project invariant."""
    try:
        defn = WorkItemStatusDefinition.objects.get(pk=status_def_id)
    except WorkItemStatusDefinition.DoesNotExist:
        raise WorkItemDomainError("Status definition does not exist.")
    if defn.project_id != project.pk:
        raise WorkItemDomainError("Status definition must belong to the same Project.")
    return defn


def _resolve_label_definitions(
    project: Project, label_def_ids: list[int]
) -> list[WorkItemLabelDefinition]:
    """Resolve label definition IDs, enforcing same-project invariant."""
    if not label_def_ids:
        return []
    definitions = WorkItemLabelDefinition.objects.filter(
        pk__in=label_def_ids, project=project
    )
    found_ids = {d.pk for d in definitions}
    missing = set(label_def_ids) - found_ids
    if missing:
        raise WorkItemDomainError(
            f"Label definition IDs not found or not in this Project: {sorted(missing)}"
        )
    return list(definitions)


# ── Status / completion handling ──


def _resolve_default_status_definition(project: Project) -> WorkItemStatusDefinition:
    """Resolve the Project's single active default status (category 'todo').

    Every Project is guaranteed exactly one active default status by the
    configuration invariants (see projects.configuration_services). Used
    when a WorkItem is created without an explicit status_definition_id.
    """
    defn = WorkItemStatusDefinition.objects.filter(
        project=project, active=True, is_default=True,
    ).first()
    if defn is None:
        raise WorkItemDomainError(
            "Project has no active default status definition."
        )
    return defn


def _apply_status_completion(work_item: WorkItem, status_def: WorkItemStatusDefinition) -> None:
    """Apply completion semantics based on status category.

    When status category transitions to 'done', set completed_at if not
    already set. When status category transitions from 'done' to another
    category, clear completed_at.

    Transition done→done preserves the existing completed_at timestamp.
    """
    is_done = status_def.category == WorkItemStatusDefinition.Category.DONE

    if is_done:
        if work_item.completed_at is None:
            from django.utils import timezone
            work_item.completed_at = timezone.now()
    else:
        work_item.completed_at = None


# ── History diffing ──
#
# Snapshot the canonical fields that make up WorkItem history before and
# after a mutation, then diff them into a structured "changes" object
# for AuditEvent.data. Naming convention for every entry:
#   {"from": <old>, "to": <new>}
# except "description" (privacy/size — no bodies, just {"changed": True})
# and "assignees" (membership diff — {"added": [...], "removed": [...]}).


def _snapshot_work_item_state(work_item: WorkItem) -> dict:
    """Capture the canonical, user-facing fields relevant to history.

    Must be called BEFORE any mutation for a "before" snapshot, and
    after work_item.refresh_from_db() for an "after" snapshot.
    """
    return {
        "title": work_item.title,
        "description": work_item.description,
        "type_definition_id": work_item.type_definition_id,
        "status_definition_id": work_item.status_definition_id,
        "due_date": work_item.due_date,
        # Canonical semantics: "" means unblocked, same as null.
        "blocked_reason": work_item.blocked_reason or None,
        "parent_id": work_item.parent_id,
        "assignee_ids": sorted(
            work_item.assignee_relations.values_list(
                "user_id", flat=True,
            )
        ),
    }


def _summarize_user(user) -> dict:
    """Display-safe user summary, matching the app's existing user
    representation convention (see accounts.views.LoginView)."""
    return {
        "id": user.pk,
        "username": user.username,
        "firstName": user.first_name,
        "lastName": user.last_name,
    }


def _summarize_parent(
    project_id: int, parent_id: Optional[int],
) -> Optional[dict]:
    """Display-safe summary of a parent WorkItem for history.

    Defensively scoped to project_id even though parent assignment is
    already validated to stay within the same Project — never resolve
    (or leak the title of) a WorkItem from another Project.
    """
    if parent_id is None:
        return None

    parent = (
        WorkItem.objects
        .filter(pk=parent_id, project_id=project_id)
        .only("id", "title")
        .first()
    )

    if parent is None:
        return {"id": parent_id, "title": None}

    return {"id": parent.pk, "title": parent.title}


def _summarize_type_definition(
    project_id: int, type_definition_id: Optional[int],
) -> Optional[dict]:
    """Display-safe summary of a TypeDefinition for history."""
    if type_definition_id is None:
        return None

    defn = (
        WorkItemTypeDefinition.objects
        .filter(pk=type_definition_id, project_id=project_id)
        .only("id", "name")
        .first()
    )

    if defn is None:
        return {"id": type_definition_id, "name": None}

    return {"id": defn.pk, "name": defn.name}


def _summarize_status_definition(
    project_id: int, status_definition_id: Optional[int],
) -> Optional[dict]:
    """Display-safe summary of a StatusDefinition for history."""
    if status_definition_id is None:
        return None

    defn = (
        WorkItemStatusDefinition.objects
        .filter(pk=status_definition_id, project_id=project_id)
        .only("id", "name")
        .first()
    )

    if defn is None:
        return {"id": status_definition_id, "name": None}

    return {"id": defn.pk, "name": defn.name}


def _diff_work_item_changes(
    *, project_id: int, before: dict, after: dict,
) -> dict:
    """Diff two WorkItem snapshots into a structured changes object.

    Only includes keys for fields that actually changed. Returns {}
    when nothing changed (callers must not record an audit event then).
    """
    changes: dict = {}

    if before["title"] != after["title"]:
        changes["title"] = {
            "from": before["title"],
            "to": after["title"],
        }

    if before["description"] != after["description"]:
        # Never store description bodies — size/privacy.
        changes["description"] = {"changed": True}

    if before["type_definition_id"] != after["type_definition_id"]:
        changes["typeDefinition"] = {
            "from": _summarize_type_definition(
                project_id, before["type_definition_id"],
            ),
            "to": _summarize_type_definition(
                project_id, after["type_definition_id"],
            ),
        }

    if before["status_definition_id"] != after["status_definition_id"]:
        changes["statusDefinition"] = {
            "from": _summarize_status_definition(
                project_id, before["status_definition_id"],
            ),
            "to": _summarize_status_definition(
                project_id, after["status_definition_id"],
            ),
        }

    if before["due_date"] != after["due_date"]:
        changes["dueDate"] = {
            "from": (
                before["due_date"].isoformat()
                if before["due_date"] else None
            ),
            "to": (
                after["due_date"].isoformat()
                if after["due_date"] else None
            ),
        }

    if before["blocked_reason"] != after["blocked_reason"]:
        # from/to alone already distinguish unblocked->blocked,
        # blocked->unblocked, and reason-changed-while-blocked.
        changes["blockedReason"] = {
            "from": before["blocked_reason"],
            "to": after["blocked_reason"],
        }

    if before["parent_id"] != after["parent_id"]:
        changes["parent"] = {
            "from": _summarize_parent(
                project_id, before["parent_id"],
            ),
            "to": _summarize_parent(
                project_id, after["parent_id"],
            ),
        }

    before_assignee_ids = set(before["assignee_ids"])
    after_assignee_ids = set(after["assignee_ids"])

    if before_assignee_ids != after_assignee_ids:
        added_ids = sorted(
            after_assignee_ids - before_assignee_ids
        )
        removed_ids = sorted(
            before_assignee_ids - after_assignee_ids
        )

        from django.contrib.auth import get_user_model
        User = get_user_model()

        users_by_id = {
            user.pk: user
            for user in User.objects.filter(
                pk__in=[*added_ids, *removed_ids],
            )
        }

        changes["assignees"] = {
            "added": [
                _summarize_user(users_by_id[user_id])
                for user_id in added_ids
                if user_id in users_by_id
            ],
            "removed": [
                _summarize_user(users_by_id[user_id])
                for user_id in removed_ids
                if user_id in users_by_id
            ],
        }

    return changes


# ── Core operations ──


def create_work_item(
    *,
    project: Project,
    actor,
    type_definition_id: int,
    title: str,
    description: str = "",
    status_definition_id: Optional[int] = None,
    assignee_ids: Optional[list[int]] = None,
    parent_id: Optional[int] = None,
    due_date: Optional[str] = None,
    blocked_reason: Optional[str] = None,
    label_definition_ids: Optional[list[int]] = None,
) -> WorkItem:
    """Create a WorkItem atomically with assignees.

    The actor must have current ProjectMembership with role 'owner' or 'member'
    AND current ResearchGroupMembership in the Project's Research Group.
    All assignees must be eligible.
    Parent relationship must be valid.

    type_definition_id is required. status_definition_id is optional —
    when omitted, the Project's active default status is used.

    Uses transaction.atomic() with select_for_update() on the Project row
    to serialize writes against concurrent membership changes.
    """
    if not type_definition_id:
        raise WorkItemDomainError("type_definition_id is required.")

    with transaction.atomic():
        # Lock the Project row to serialize against concurrent membership changes
        locked_project = Project.objects.select_for_update().get(pk=project.pk)

        # Re-check write access under the lock
        _require_project_write_access(locked_project, actor)

        # Validate parent under the lock
        if parent_id is not None:
            _validate_parent(locked_project, parent_id)

        # Validate assignees under the lock
        if assignee_ids:
            _validate_assignees(locked_project, assignee_ids)

        # Resolve definition FKs under the lock
        type_def = _resolve_type_definition(locked_project, type_definition_id)

        if status_definition_id is not None:
            status_def = _resolve_status_definition(locked_project, status_definition_id)
        else:
            status_def = _resolve_default_status_definition(locked_project)

        initial_completed_at = None
        if status_def.category == WorkItemStatusDefinition.Category.DONE:
            from django.utils import timezone
            initial_completed_at = timezone.now()

        label_defs = []
        if label_definition_ids:
            label_defs = _resolve_label_definitions(locked_project, label_definition_ids)

        work_item = WorkItem.objects.create(
            project=locked_project,
            type_definition=type_def,
            title=title,
            description=description,
            status_definition=status_def,
            parent_id=parent_id,
            due_date=due_date,
            blocked_reason=blocked_reason or "",
            completed_at=initial_completed_at,
            created_by=actor,
        )

        # Create assignees (deduplicate to handle duplicate IDs safely)
        if assignee_ids:
            from django.contrib.auth import get_user_model
            User = get_user_model()
            seen_user_ids = set()
            for user_id in assignee_ids:
                if user_id in seen_user_ids:
                    continue
                seen_user_ids.add(user_id)
                WorkItemAssignee.objects.create(
                    work_item=work_item,
                    user=User.objects.get(pk=user_id),
                )

        # Create labels
        for label_def in label_defs:
            WorkItemLabel.objects.create(
                work_item=work_item,
                label=label_def,
            )

        # Recorded inside the same atomic block: if anything above
        # rolls back, no AuditEvent survives either.
        record_audit_event(
            research_group=locked_project.research_group,
            actor=actor,
            event_type=WorkItemAuditEventType.CREATED,
            project=locked_project,
            work_item=work_item,
            data={},
        )

    return work_item


def update_work_item(
    *,
    work_item: WorkItem,
    actor,
    title: Optional[str] = None,
    description: Optional[str] = None,
    assignee_ids: Optional[list[int]] = None,
    parent_id: object = _UNSET,
    due_date: object = _UNSET,
    blocked_reason: object = _UNSET,
    type_definition_id: Optional[int] = None,
    status_definition_id: Optional[int] = None,
    label_definition_ids: Optional[list[int]] = None,
) -> WorkItem:
    """Update a WorkItem atomically with assignee replacement and hierarchy.

    The actor must have current ProjectMembership with role 'owner' or 'member'
    AND current ResearchGroupMembership in the Project's Research Group.
    Immutable fields (project, created_by, created_at) cannot be changed.
    completed_at is server-managed, not client-writable.

    Assignee replacement is atomic: if any assignee is invalid, the entire
    update rolls back.

    Uses transaction.atomic() with select_for_update() on the Project row
    to serialize writes against concurrent membership changes.
    """
    project = work_item.project

    # Check if parent is being changed — requires hierarchy cycle validation
    parent_changing = (
        parent_id is not _UNSET and parent_id != work_item.parent_id
    )

    with transaction.atomic():
        # Lock the Project row to serialize against concurrent membership changes
        locked_project = Project.objects.select_for_update().get(pk=project.pk)

        # Reload work_item under the lock
        work_item = WorkItem.objects.select_for_update().get(pk=work_item.pk)

        # Re-check write access under the lock
        _require_project_write_access(locked_project, actor)

        # Validate assignees under the lock
        if assignee_ids is not None:
            _validate_assignees(locked_project, assignee_ids)

        # Validate parent under the lock
        if parent_id is not _UNSET:
            if parent_id is not None:
                _validate_parent_with_new_item(
                    locked_project, parent_id, work_item.pk
                )

        before_state = _snapshot_work_item_state(work_item)

        _apply_work_item_fields(
            work_item=work_item,
            project=locked_project,
            title=title,
            description=description,
            assignee_ids=assignee_ids,
            parent_id=parent_id,
            due_date=due_date,
            blocked_reason=blocked_reason,
            type_definition_id=type_definition_id,
            status_definition_id=status_definition_id,
            label_definition_ids=label_definition_ids,
        )

        work_item.refresh_from_db()
        after_state = _snapshot_work_item_state(work_item)

        changes = _diff_work_item_changes(
            project_id=locked_project.pk,
            before=before_state,
            after=after_state,
        )

        # Only a real canonical change produces history — a PATCH that
        # sends unchanged values (or only touches non-audited fields)
        # must not create a fake event. Recorded inside the same
        # atomic block so a rollback above never leaves an AuditEvent.
        if changes:
            record_audit_event(
                research_group=locked_project.research_group,
                actor=actor,
                event_type=WorkItemAuditEventType.UPDATED,
                project=locked_project,
                work_item=work_item,
                data={"changes": changes},
            )

    return work_item


def _apply_work_item_fields(
    *,
    work_item: WorkItem,
    project: Project,
    title: Optional[str] = None,
    description: Optional[str] = None,
    assignee_ids: Optional[list[int]] = None,
    parent_id: object = _UNSET,
    due_date: object = _UNSET,
    blocked_reason: object = _UNSET,
    type_definition_id: Optional[int] = None,
    status_definition_id: Optional[int] = None,
    label_definition_ids: Optional[list[int]] = None,
) -> None:
    """Apply field changes to a WorkItem and handle side effects.

    Assignee replacement is atomic (delete all, create new).
    completed_at is derived from status transitions.
    """
    update_fields = []

    if title is not None:
        work_item.title = title
        update_fields.append("title")
    if description is not None:
        work_item.description = description
        update_fields.append("description")
    if parent_id is not _UNSET:
        if parent_id != work_item.parent_id:
            work_item.parent_id = parent_id if parent_id is not None else None
            update_fields.append("parent")
    if due_date is not _UNSET:
        work_item.due_date = due_date if due_date != "" else None
        update_fields.append("due_date")
    if blocked_reason is not _UNSET:
        work_item.blocked_reason = (
            ""
            if blocked_reason is None
            else blocked_reason
        )
        update_fields.append("blocked_reason")

    # Type definition FK
    if type_definition_id is not None:
        type_def = _resolve_type_definition(project, type_definition_id)
        work_item.type_definition = type_def
        update_fields.append("type_definition")

    # Status transition with completion handling
    if status_definition_id is not None:
        status_def = _resolve_status_definition(project, status_definition_id)
        work_item.status_definition = status_def
        update_fields.append("status_definition")
        _apply_status_completion(work_item, status_def)
        update_fields.append("completed_at")
    else:
        # Even when status is not being changed, ensure completed_at
        # is consistent with the current status. This prevents a client
        # from arbitrarily setting completed_at through admin or raw ORM.
        is_done = (
            work_item.status_definition.category
            == WorkItemStatusDefinition.Category.DONE
        )

        if is_done:
            if work_item.completed_at is None:
                from django.utils import timezone
                work_item.completed_at = timezone.now()
                update_fields.append("completed_at")
        else:
            if work_item.completed_at is not None:
                work_item.completed_at = None
                update_fields.append("completed_at")

    work_item.save(update_fields=update_fields)

    # Atomic assignee replacement
    if assignee_ids is not None:
        from django.contrib.auth import get_user_model
        User = get_user_model()
        work_item.assignee_relations.all().delete()
        seen_user_ids = set()
        for user_id in assignee_ids:
            if user_id in seen_user_ids:
                continue
            seen_user_ids.add(user_id)
            WorkItemAssignee.objects.create(
                work_item=work_item,
                user=User.objects.get(pk=user_id),
            )

    # Atomic label replacement
    if label_definition_ids is not None:
        label_defs = _resolve_label_definitions(project, label_definition_ids)
        label_def_ids = {d.pk for d in label_defs}
        work_item.label_relations.all().delete()
        for label_def in label_defs:
            WorkItemLabel.objects.create(
                work_item=work_item,
                label=label_def,
            )


def _require_project_write_access(project: Project, actor) -> None:
    """Require that the actor has effective write access to the project.

    Effective write access requires BOTH:
    - ResearchGroupMembership in the Project's Research Group
    - ProjectMembership with role 'owner' or 'member'

    A viewer cannot write.
    Stale ProjectMembership (whose ResearchGroupMembership no longer exists)
    is rejected.
    """
    if project.archived_at is not None:
        raise WorkItemDomainError(
            "Archived Projects are read-only. Restore the Project first."
        )

    # Check current ResearchGroupMembership
    if not ResearchGroupMembership.objects.filter(
        research_group=project.research_group,
        user=actor,
    ).exists():
        raise WorkItemDomainError("You do not have access to this Project.")

    membership = ProjectMembership.objects.filter(
        project=project,
        user=actor,
    ).first()
    if membership is None:
        raise WorkItemDomainError("You do not have access to this Project.")
    if membership.role == ProjectMembership.Role.VIEWER:
        raise WorkItemDomainError("A viewer cannot modify WorkItems.")


def set_assignees(
    *,
    work_item: WorkItem,
    actor,
    assignee_ids: list[int],
) -> WorkItem:
    """Replace all assignees on a WorkItem atomically.

    The actor must have write access to the project.
    All assignees must be eligible.
    If any assignee is invalid, the entire operation rolls back.
    """
    project = work_item.project
    _require_project_write_access(project, actor)
    _validate_assignees(project, assignee_ids)

    with transaction.atomic():
        work_item.assignee_relations.all().delete()
        from django.contrib.auth import get_user_model
        User = get_user_model()
        seen_user_ids = set()
        for user_id in assignee_ids:
            if user_id in seen_user_ids:
                continue
            seen_user_ids.add(user_id)
            WorkItemAssignee.objects.create(
                work_item=work_item,
                user=User.objects.get(pk=user_id),
            )

    return work_item


# ── WorkItem Comments ──
#
# Human discussion, kept deliberately separate from AuditEvent history:
# comments are never recorded as audit events and never appear in the
# WorkItem history API. The Activity feed merges the two views
# presentation-side only.


def create_work_item_comment(
    *,
    work_item: WorkItem,
    actor,
    body: str,
) -> WorkItemComment:
    """Create a comment on a WorkItem.

    Reuses the exact same write-access rule as WorkItem mutation
    (owner/member ProjectMembership, current ResearchGroupMembership,
    non-archived Project) so a viewer — or anyone who could not edit
    the WorkItem itself — cannot comment on it either.
    """
    project = work_item.project
    _require_project_write_access(project, actor)

    cleaned_body = (body or "").strip()
    if not cleaned_body:
        raise WorkItemDomainError("Comment body cannot be empty.")

    with transaction.atomic():
        comment = WorkItemComment.objects.create(
            work_item=work_item,
            author=actor,
            body=cleaned_body,
        )

    return comment


def update_work_item_comment(
    *,
    comment: WorkItemComment,
    actor,
    body: str,
) -> WorkItemComment:
    """Edit a comment's body.

    Only the comment's own author may edit it — no moderator/admin
    bypass, matching the task's explicit scope.
    """
    if comment.author_id != actor.pk:
        raise WorkItemDomainError(
            "Only the comment's author can edit it."
        )

    cleaned_body = (body or "").strip()
    if not cleaned_body:
        raise WorkItemDomainError("Comment body cannot be empty.")

    with transaction.atomic():
        comment.body = cleaned_body
        comment.save(update_fields=["body", "updated_at"])

    return comment


def delete_work_item_comment(
    *,
    comment: WorkItemComment,
    actor,
) -> None:
    """Delete a comment. Only the comment's own author may delete it."""
    if comment.author_id != actor.pk:
        raise WorkItemDomainError(
            "Only the comment's author can delete it."
        )

    comment.delete()
