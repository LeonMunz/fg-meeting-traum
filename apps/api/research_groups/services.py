"""Research Group application/domain operations.

Centralizes Research Group management rules so permission and
membership invariants are not duplicated across API views.

ResearchGroupMembership represents current group access.
ProjectMembership remains an independent Project-level security boundary.
"""

from dataclasses import dataclass
from typing import Iterable, Optional

from django.db import transaction

from audit_history.services import record_audit_event

from projects.models import ProjectMembership

from .models import ResearchGroup, ResearchGroupMembership


class ResearchGroupDomainError(Exception):
    """Raised when a Research Group domain invariant is violated."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


def _require_group_admin(
    *,
    research_group: ResearchGroup,
    actor,
) -> ResearchGroupMembership:
    """Require an active Research Group admin membership."""
    membership = ResearchGroupMembership.objects.filter(
        research_group=research_group,
        user=actor,
    ).first()

    if (
        membership is None
        or membership.role
        != ResearchGroupMembership.Role.ADMIN
    ):
        raise ResearchGroupDomainError(
            "Only a Research Group admin can manage this Research Group."
        )

    return membership


def update_research_group(
    *,
    research_group: ResearchGroup,
    actor,
    name: Optional[str] = None,
) -> ResearchGroup:
    """Update Research Group metadata.

    Only Research Group admins may update group metadata.
    """
    _require_group_admin(
        research_group=research_group,
        actor=actor,
    )

    if name is not None:
        normalized_name = name.strip()

        if not normalized_name:
            raise ResearchGroupDomainError(
                "Research Group name is required."
            )

        research_group.name = normalized_name
        research_group.save(
            update_fields=[
                "name",
                "updated_at",
            ]
        )

    return research_group


def add_research_group_membership(
    *,
    research_group: ResearchGroup,
    actor,
    target_user,
    role: str = ResearchGroupMembership.Role.MEMBER,
) -> ResearchGroupMembership:
    """Add a user to a Research Group.

    Only Research Group admins may add memberships.
    """
    _require_group_admin(
        research_group=research_group,
        actor=actor,
    )

    if role not in ResearchGroupMembership.Role.values:
        raise ResearchGroupDomainError(
            f"Invalid Research Group role: {role}"
        )

    if ResearchGroupMembership.objects.filter(
        research_group=research_group,
        user=target_user,
    ).exists():
        raise ResearchGroupDomainError(
            "User is already a member of this Research Group."
        )

    return ResearchGroupMembership.objects.create(
        research_group=research_group,
        user=target_user,
        role=role,
    )


def change_research_group_membership_role(
    *,
    membership: ResearchGroupMembership,
    actor,
    new_role: str,
) -> ResearchGroupMembership:
    """Change a Research Group membership role.

    Only admins may change roles.
    The final-admin invariant is enforced under a row lock.
    """
    if new_role not in ResearchGroupMembership.Role.values:
        raise ResearchGroupDomainError(
            f"Invalid Research Group role: {new_role}"
        )

    with transaction.atomic():
        research_group = (
            ResearchGroup.objects
            .select_for_update()
            .get(pk=membership.research_group_id)
        )

        membership = (
            ResearchGroupMembership.objects
            .select_for_update()
            .get(pk=membership.pk)
        )

        _require_group_admin(
            research_group=research_group,
            actor=actor,
        )

        if (
            membership.role
            == ResearchGroupMembership.Role.ADMIN
            and new_role
            != ResearchGroupMembership.Role.ADMIN
        ):
            other_admin_exists = (
                ResearchGroupMembership.objects
                .filter(
                    research_group=research_group,
                    role=ResearchGroupMembership.Role.ADMIN,
                )
                .exclude(pk=membership.pk)
                .exists()
            )

            if not other_admin_exists:
                raise ResearchGroupDomainError(
                    "Cannot change the final admin of a Research Group. "
                    "Add another admin first."
                )

        membership.role = new_role
        membership.save(
            update_fields=["role"]
        )

    return membership


def remove_research_group_membership(
    *,
    membership: ResearchGroupMembership,
    actor,
) -> None:
    """Safely remove an uncomplicated Research Group membership.

    This is deliberately a low-level guard, not the final UX offboarding
    workflow.

    It refuses removal when Project memberships still exist. A later
    offboarding orchestration service will resolve Project ownership and
    assignments atomically before calling this operation.
    """
    with transaction.atomic():
        research_group = (
            ResearchGroup.objects
            .select_for_update()
            .get(pk=membership.research_group_id)
        )

        membership = (
            ResearchGroupMembership.objects
            .select_for_update()
            .get(pk=membership.pk)
        )

        _require_group_admin(
            research_group=research_group,
            actor=actor,
        )

        if (
            membership.role
            == ResearchGroupMembership.Role.ADMIN
        ):
            other_admin_exists = (
                ResearchGroupMembership.objects
                .filter(
                    research_group=research_group,
                    role=ResearchGroupMembership.Role.ADMIN,
                )
                .exclude(pk=membership.pk)
                .exists()
            )

            if not other_admin_exists:
                raise ResearchGroupDomainError(
                    "Cannot remove the final admin of a Research Group. "
                    "Add another admin first."
                )

        if ProjectMembership.objects.filter(
            project__research_group=research_group,
            user=membership.user,
        ).exists():
            raise ResearchGroupDomainError(
                "User still has Project memberships in this "
                "Research Group and cannot be removed yet."
            )

        membership.delete()


@dataclass(frozen=True)
class ResearchGroupOffboardingCandidate:
    user: object
    project_role: str


@dataclass(frozen=True)
class ResearchGroupProjectOffboardingPreview:
    project_id: int
    name: str
    status: str
    archived_at: object
    membership_role: str
    assignment_count: int
    final_owner: bool
    requires_ownership_resolution: bool
    ownership_candidates: tuple
    assignment_candidates: tuple


@dataclass(frozen=True)
class ResearchGroupMemberOffboardingPreview:
    membership_id: int
    user: object
    research_group_role: str
    final_research_group_admin: bool
    projects: tuple


def get_research_group_member_offboarding_preview(
    *,
    membership: ResearchGroupMembership,
    actor,
) -> ResearchGroupMemberOffboardingPreview:
    """Return the current dependencies for one RG member.

    This operation is read-only. It exposes only the Project information
    required for the explicit offboarding workflow.

    The executing offboarding operation never trusts this preview and
    revalidates the complete state transactionally.
    """

    from work_items.models import WorkItemAssignee

    research_group = (
        ResearchGroup.objects.get(
            pk=membership.research_group_id
        )
    )

    _require_group_admin(
        research_group=research_group,
        actor=actor,
    )

    membership = (
        ResearchGroupMembership.objects
        .select_related(
            "user",
            "research_group",
        )
        .get(
            pk=membership.pk,
            research_group=research_group,
        )
    )

    target_user = membership.user

    other_admin_exists = (
        ResearchGroupMembership.objects
        .filter(
            research_group=research_group,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        .exclude(pk=membership.pk)
        .exists()
    )

    final_research_group_admin = (
        membership.role
        == ResearchGroupMembership.Role.ADMIN
        and not other_admin_exists
    )

    project_memberships = list(
        ProjectMembership.objects
        .filter(
            project__research_group=research_group,
            user=target_user,
        )
        .select_related("project")
        .order_by(
            "project_id",
            "pk",
        )
    )

    project_previews = []

    for project_membership in project_memberships:
        project = project_membership.project

        other_owner_exists = (
            ProjectMembership.objects
            .filter(
                project=project,
                role=ProjectMembership.Role.OWNER,
            )
            .exclude(pk=project_membership.pk)
            .exists()
        )

        final_owner = (
            project_membership.role
            == ProjectMembership.Role.OWNER
            and not other_owner_exists
        )

        requires_ownership_resolution = (
            final_owner
            and project.status
            == project.Status.ACTIVE
            and project.archived_at is None
        )

        assignment_count = (
            WorkItemAssignee.objects
            .filter(
                work_item__project=project,
                user=target_user,
            )
            .count()
        )

        candidate_memberships = list(
            ProjectMembership.objects
            .filter(
                project=project,
                user__research_group_memberships__research_group=(
                    research_group
                ),
            )
            .exclude(user=target_user)
            .select_related("user")
            .order_by(
                "user__username",
                "user_id",
            )
            .distinct()
        )

        ownership_candidates = tuple(
            ResearchGroupOffboardingCandidate(
                user=candidate.user,
                project_role=candidate.role,
            )
            for candidate in candidate_memberships
        )

        assignment_candidates = tuple(
            ResearchGroupOffboardingCandidate(
                user=candidate.user,
                project_role=candidate.role,
            )
            for candidate in candidate_memberships
            if candidate.role
            in {
                ProjectMembership.Role.OWNER,
                ProjectMembership.Role.MEMBER,
            }
        )

        project_previews.append(
            ResearchGroupProjectOffboardingPreview(
                project_id=project.pk,
                name=project.name,
                status=project.status,
                archived_at=project.archived_at,
                membership_role=project_membership.role,
                assignment_count=assignment_count,
                final_owner=final_owner,
                requires_ownership_resolution=(
                    requires_ownership_resolution
                ),
                ownership_candidates=(
                    ownership_candidates
                ),
                assignment_candidates=(
                    assignment_candidates
                ),
            )
        )

    return ResearchGroupMemberOffboardingPreview(
        membership_id=membership.pk,
        user=target_user,
        research_group_role=membership.role,
        final_research_group_admin=(
            final_research_group_admin
        ),
        projects=tuple(project_previews),
    )


@dataclass(frozen=True)
class ResearchGroupProjectOffboardingResolution:
    project_id: int
    assignment_resolution: Optional[str] = None
    assignment_replacement_user: object = None
    ownership_resolution: Optional[str] = None
    ownership_replacement_user: object = None


@dataclass(frozen=True)
class ResearchGroupOffboardingResult:
    removed_project_membership_count: int
    affected_work_item_count: int
    transferred_assignment_count: int
    unassigned_assignment_count: int
    ownership_transfer_count: int
    archived_project_count: int


def offboard_research_group_member(
    *,
    membership: ResearchGroupMembership,
    actor,
    project_resolutions: Optional[
        Iterable[
            ResearchGroupProjectOffboardingResolution
        ]
    ] = None,
) -> ResearchGroupOffboardingResult:
    """Atomically remove one user from a Research Group.

    Current access and responsibility are removed while authored
    entities and immutable AuditEvents remain historical facts.

    The exceptional Project authority used here exists only for the
    explicit Research Group offboarding workflow. Normal Project
    permissions remain unchanged.
    """

    from projects.offboarding import (
        resolve_project_membership_for_research_group_offboarding,
    )
    from projects.services import ProjectDomainError

    resolutions = list(
        project_resolutions or []
    )

    resolution_by_project_id = {}

    for resolution in resolutions:
        if not isinstance(
            resolution,
            ResearchGroupProjectOffboardingResolution,
        ):
            raise ResearchGroupDomainError(
                "Invalid Project offboarding resolution."
            )

        if (
            resolution.project_id
            in resolution_by_project_id
        ):
            raise ResearchGroupDomainError(
                "Each Project may only have one "
                "offboarding resolution."
            )

        resolution_by_project_id[
            resolution.project_id
        ] = resolution

    with transaction.atomic():
        research_group = (
            ResearchGroup.objects
            .select_for_update()
            .get(
                pk=membership.research_group_id
            )
        )

        membership = (
            ResearchGroupMembership.objects
            .select_for_update()
            .select_related("user")
            .get(
                pk=membership.pk,
                research_group=research_group,
            )
        )

        _require_group_admin(
            research_group=research_group,
            actor=actor,
        )

        target_user = membership.user

        project_memberships = list(
            ProjectMembership.objects
            .filter(
                project__research_group=research_group,
                user=target_user,
            )
            .select_related("project")
            .order_by(
                "project_id",
                "pk",
            )
        )

        current_project_ids = {
            item.project_id
            for item in project_memberships
        }

        unknown_project_ids = (
            set(resolution_by_project_id)
            - current_project_ids
        )

        if unknown_project_ids:
            raise ResearchGroupDomainError(
                "Offboarding resolution references "
                "a Project the target user does not belong to."
            )

        affected_work_item_count = 0
        transferred_assignment_count = 0
        unassigned_assignment_count = 0
        ownership_transfer_count = 0
        archived_project_count = 0

        for project_membership in project_memberships:
            resolution = (
                resolution_by_project_id.get(
                    project_membership.project_id
                )
            )

            try:
                result = (
                    resolve_project_membership_for_research_group_offboarding(
                        membership=project_membership,
                        actor=actor,
                        assignment_resolution=(
                            resolution.assignment_resolution
                            if resolution is not None
                            else None
                        ),
                        assignment_replacement_user=(
                            resolution.assignment_replacement_user
                            if resolution is not None
                            else None
                        ),
                        ownership_resolution=(
                            resolution.ownership_resolution
                            if resolution is not None
                            else None
                        ),
                        ownership_replacement_user=(
                            resolution.ownership_replacement_user
                            if resolution is not None
                            else None
                        ),
                    )
                )
            except ProjectDomainError as exc:
                raise ResearchGroupDomainError(
                    exc.message
                ) from exc

            affected_work_item_count += (
                result.affected_work_item_count
            )

            transferred_assignment_count += (
                result.transferred_assignment_count
            )

            unassigned_assignment_count += (
                result.unassigned_assignment_count
            )

            ownership_transfer_count += (
                result.ownership_transfer_count
            )

            archived_project_count += (
                result.archived_project_count
            )

        # Keep the existing low-level RG guard as the final gate.
        # Any final-admin or remaining dependency failure rolls
        # back all Project mutations through the outer transaction.
        remove_research_group_membership(
            membership=membership,
            actor=actor,
        )

        result = ResearchGroupOffboardingResult(
            removed_project_membership_count=(
                len(project_memberships)
            ),
            affected_work_item_count=(
                affected_work_item_count
            ),
            transferred_assignment_count=(
                transferred_assignment_count
            ),
            unassigned_assignment_count=(
                unassigned_assignment_count
            ),
            ownership_transfer_count=(
                ownership_transfer_count
            ),
            archived_project_count=(
                archived_project_count
            ),
        )

        record_audit_event(
            research_group=research_group,
            actor=actor,
            event_type=(
                "research_group.member_offboarded"
            ),
            subject_user=target_user,
            data={
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
        )

        return result
