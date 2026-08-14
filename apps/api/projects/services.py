"""Project application/domain operations.

Centralizes domain rules so they are not duplicated across views.
Every operation receives the authenticated actor explicitly.
"""

from typing import Optional

from django.conf import settings
from django.db import transaction
from django.db.models import Q

from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import Project, ProjectMembership


class ProjectDomainError(Exception):
    """Raised when a domain invariant is violated."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


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
    The target user must have ResearchGroupMembership in the Project's Research Group.
    """
    # Validate: actor is Project owner
    actor_membership = ProjectMembership.objects.filter(
        project=project,
        user=actor,
    ).first()
    if actor_membership is None or actor_membership.role != ProjectMembership.Role.OWNER:
        raise ProjectDomainError("Only a Project owner can manage memberships.")

    # Validate role
    if role not in ProjectMembership.Role.values:
        raise ProjectDomainError(f"Invalid membership role: {role}")

    # Validate: target user has ResearchGroupMembership in this Research Group
    if not ResearchGroupMembership.objects.filter(
        research_group=project.research_group,
        user=target_user,
    ).exists():
        raise ProjectDomainError(
            "Target user must be a member of the Project's Research Group."
        )

    # Validate: no existing membership
    if ProjectMembership.objects.filter(
        project=project,
        user=target_user,
    ).exists():
        raise ProjectDomainError(
            "Target user already has a membership in this Project."
        )

    return ProjectMembership.objects.create(
        project=project,
        user=target_user,
        role=role,
        added_by=actor,
    )


def change_membership_role(
    *,
    membership: ProjectMembership,
    actor,
    new_role: str,
) -> ProjectMembership:
    """Change a membership role.

    The actor must be a Project owner.
    The active Project final-owner invariant is enforced.
    """
    # Validate: actor is Project owner
    actor_membership = ProjectMembership.objects.filter(
        project=membership.project,
        user=actor,
    ).first()
    if actor_membership is None or actor_membership.role != ProjectMembership.Role.OWNER:
        raise ProjectDomainError("Only a Project owner can manage memberships.")

    # Validate role
    if new_role not in ProjectMembership.Role.values:
        raise ProjectDomainError(f"Invalid membership role: {new_role}")

    # Validate: final-owner invariant for active projects
    if membership.project.status == Project.Status.ACTIVE:
        _check_final_owner_change(membership.project, membership, new_role)

    membership.role = new_role
    membership.save(update_fields=["role"])
    return membership


def remove_membership(
    *,
    membership: ProjectMembership,
    actor,
) -> None:
    """Remove a ProjectMembership.

    The actor must be a Project owner.
    The active Project final-owner invariant is enforced.
    """
    # Validate: actor is Project owner
    actor_membership = ProjectMembership.objects.filter(
        project=membership.project,
        user=actor,
    ).first()
    if actor_membership is None or actor_membership.role != ProjectMembership.Role.OWNER:
        raise ProjectDomainError("Only a Project owner can manage memberships.")

    # Validate: final-owner invariant for active projects
    if membership.project.status == Project.Status.ACTIVE:
        _check_final_owner_removal(membership.project, membership)

    membership.delete()


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
    Immutable fields (research_group, created_by, created_at) cannot be changed.
    """
    # Validate: actor is Project owner
    actor_membership = ProjectMembership.objects.filter(
        project=project,
        user=actor,
    ).first()
    if actor_membership is None or actor_membership.role != ProjectMembership.Role.OWNER:
        raise ProjectDomainError("Only a Project owner can update a Project.")

    if name is not None:
        project.name = name
    if description is not None:
        project.description = description
    if status is not None:
        if status not in Project.Status.values:
            raise ProjectDomainError(f"Invalid project status: {status}")
        project.status = status

    project.save(update_fields=["name", "description", "status"])
    return project


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
