"""Project application/domain operations.

Centralizes domain rules so they are not duplicated across views.
Every operation receives the authenticated actor explicitly.
"""

from typing import Optional

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from audit_history.services import record_audit_event
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import Project, ProjectMembership


ASSIGNMENT_RESOLUTION_UNASSIGN = "unassign"
ASSIGNMENT_RESOLUTION_TRANSFER = "transfer"
ASSIGNMENT_RESOLUTION_VALUES = {
    ASSIGNMENT_RESOLUTION_UNASSIGN,
    ASSIGNMENT_RESOLUTION_TRANSFER,
}


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
    # Validate: creator is a Research Group member
    if not ResearchGroupMembership.objects.filter(
        research_group=research_group,
        user=creator,
    ).exists():
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

    return project


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

        actor_membership = (
            ProjectMembership.objects
            .filter(
                project=locked_project,
                user=actor,
            )
            .first()
        )

        if (
            actor_membership is None
            or actor_membership.role
            != ProjectMembership.Role.OWNER
        ):
            raise ProjectDomainError(
                "Only a Project owner can manage memberships."
            )

        if not ResearchGroupMembership.objects.filter(
            research_group=locked_project.research_group,
            user=target_user,
        ).exists():
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

        # Validate: actor is Project owner
        actor_membership = ProjectMembership.objects.select_for_update().filter(
            project=project,
            user=actor,
        ).first()
        if actor_membership is None or actor_membership.role != ProjectMembership.Role.OWNER:
            raise ProjectDomainError("Only a Project owner can manage memberships.")

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
                event_type="project.member_assignments_resolved",
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

        # Validate: actor is Project owner
        actor_membership = ProjectMembership.objects.select_for_update().filter(
            project=project,
            user=actor,
        ).first()
        if actor_membership is None or actor_membership.role != ProjectMembership.Role.OWNER:
            raise ProjectDomainError("Only a Project owner can manage memberships.")

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
                event_type="project.member_assignments_resolved",
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

        actor_membership = (
            ProjectMembership.objects
            .filter(
                project=locked_project,
                user=actor,
            )
            .first()
        )

        if (
            actor_membership is None
            or actor_membership.role
            != ProjectMembership.Role.OWNER
        ):
            raise ProjectDomainError(
                "Only a Project owner can update a Project."
            )

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

        actor_membership = (
            ProjectMembership.objects
            .select_for_update()
            .filter(
                project=project,
                user=actor,
            )
            .first()
        )

        if (
            actor_membership is None
            or actor_membership.role
            != ProjectMembership.Role.OWNER
        ):
            raise ProjectDomainError(
                "Only a Project owner can archive a Project."
            )

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
            event_type="project.archived",
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

        actor_membership = (
            ProjectMembership.objects
            .select_for_update()
            .filter(
                project=project,
                user=actor,
            )
            .first()
        )

        if (
            actor_membership is None
            or actor_membership.role
            != ProjectMembership.Role.OWNER
        ):
            raise ProjectDomainError(
                "Only a Project owner can restore a Project."
            )

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
            event_type="project.restored",
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

        actor_membership = (
            ProjectMembership.objects
            .select_for_update()
            .filter(
                project=project,
                user=actor,
            )
            .first()
        )

        if (
            actor_membership is None
            or actor_membership.role
            != ProjectMembership.Role.OWNER
        ):
            raise ProjectDomainError(
                "Only a Project owner can delete a Project."
            )

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
            event_type="project.deleted",
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
    """
    return Project.objects.filter(
        memberships__user=user,
    ).distinct()


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
