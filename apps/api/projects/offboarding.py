"""Project-specific primitives for Research Group offboarding.

These operations are deliberately separate from the normal Project
membership API. They grant no general Project-management authority to
Research Group admins; they exist only for the explicit offboarding
workflow.
"""

from dataclasses import dataclass
from typing import Optional

from django.db import transaction
from django.utils import timezone

from audit_history.services import record_audit_event
from research_groups.models import ResearchGroupMembership
from work_items.models import WorkItemAssignee

from .models import Project, ProjectMembership
from .services import (
    ProjectDomainError,
    _resolve_assignments_for_membership_mutation,
)


OWNERSHIP_RESOLUTION_TRANSFER = "transfer"
OWNERSHIP_RESOLUTION_ARCHIVE = "archive"

OWNERSHIP_RESOLUTION_VALUES = {
    OWNERSHIP_RESOLUTION_TRANSFER,
    OWNERSHIP_RESOLUTION_ARCHIVE,
}


@dataclass(frozen=True)
class ProjectOffboardingResult:
    project_id: int
    affected_work_item_count: int
    transferred_assignment_count: int
    unassigned_assignment_count: int
    ownership_transfer_count: int
    archived_project_count: int


def resolve_project_membership_for_research_group_offboarding(
    *,
    membership: ProjectMembership,
    actor,
    assignment_resolution: Optional[str] = None,
    assignment_replacement_user=None,
    ownership_resolution: Optional[str] = None,
    ownership_replacement_user=None,
) -> ProjectOffboardingResult:
    """Resolve one ProjectMembership during Research Group offboarding.

    The actor must be a Research Group admin of this Project's group.

    Unlike normal Project membership mutation:
    - the actor does not have to be a Project owner;
    - archived Projects may be processed;
    - active final owners require explicit transfer or archive;
    - paused/completed/archived Projects retain the existing domain
      semantics and may become ownerless.

    The caller is expected to wrap all affected Projects in one outer
    transaction so Research Group offboarding remains atomic.
    """

    with transaction.atomic():
        project = (
            Project.objects
            .select_for_update()
            .select_related("research_group")
            .get(pk=membership.project_id)
        )

        membership = (
            ProjectMembership.objects
            .select_for_update()
            .select_related("user")
            .get(
                pk=membership.pk,
                project=project,
            )
        )

        if not ResearchGroupMembership.objects.filter(
            research_group=project.research_group,
            user=actor,
            role=ResearchGroupMembership.Role.ADMIN,
        ).exists():
            raise ProjectDomainError(
                "Only a Research Group admin can perform "
                "Research Group offboarding."
            )

        target_user = membership.user

        other_owner_exists = (
            ProjectMembership.objects
            .filter(
                project=project,
                role=ProjectMembership.Role.OWNER,
            )
            .exclude(pk=membership.pk)
            .exists()
        )

        requires_ownership_resolution = (
            membership.role
            == ProjectMembership.Role.OWNER
            and project.status
            == Project.Status.ACTIVE
            and project.archived_at is None
            and not other_owner_exists
        )

        ownership_transfer_count = 0
        archived_project_count = 0

        if requires_ownership_resolution:
            if (
                ownership_resolution
                not in OWNERSHIP_RESOLUTION_VALUES
            ):
                raise ProjectDomainError(
                    "The final owner of an active Project "
                    "must transfer ownership or archive "
                    "the Project before offboarding."
                )

            if (
                ownership_resolution
                == OWNERSHIP_RESOLUTION_TRANSFER
            ):
                if ownership_replacement_user is None:
                    raise ProjectDomainError(
                        "Ownership transfer requires "
                        "a replacement user."
                    )

                if (
                    ownership_replacement_user.pk
                    == target_user.pk
                ):
                    raise ProjectDomainError(
                        "Ownership cannot be transferred "
                        "to the same user."
                    )

                if not ResearchGroupMembership.objects.filter(
                    research_group=project.research_group,
                    user=ownership_replacement_user,
                ).exists():
                    raise ProjectDomainError(
                        "Ownership replacement must be a "
                        "member of this Research Group."
                    )

                replacement_membership = (
                    ProjectMembership.objects
                    .select_for_update()
                    .filter(
                        project=project,
                        user=ownership_replacement_user,
                    )
                    .first()
                )

                if replacement_membership is None:
                    raise ProjectDomainError(
                        "Ownership replacement must already "
                        "have access to this Project."
                    )

                previous_replacement_role = (
                    replacement_membership.role
                )

                replacement_membership.role = (
                    ProjectMembership.Role.OWNER
                )
                replacement_membership.save(
                    update_fields=["role"]
                )

                ownership_transfer_count = 1

                record_audit_event(
                    research_group=project.research_group,
                    actor=actor,
                    event_type=(
                        "project.ownership_resolved_for_offboarding"
                    ),
                    subject_user=target_user,
                    project=project,
                    data={
                        "resolution": "transfer",
                        "replacementUserId":
                            ownership_replacement_user.pk,
                        "replacementPreviousRole":
                            previous_replacement_role,
                    },
                )

            else:
                if ownership_replacement_user is not None:
                    raise ProjectDomainError(
                        "Archive ownership resolution does "
                        "not accept a replacement user."
                    )

                project.archived_at = timezone.now()
                project.save(
                    update_fields=[
                        "archived_at",
                        "updated_at",
                    ]
                )

                archived_project_count = 1

                record_audit_event(
                    research_group=project.research_group,
                    actor=actor,
                    event_type="project.archived",
                    project=project,
                    data={
                        "status": project.status,
                        "reason":
                            "research_group_offboarding",
                    },
                )

        elif (
            ownership_resolution is not None
            or ownership_replacement_user is not None
        ):
            raise ProjectDomainError(
                "Ownership resolution is only required "
                "for the final owner of an active, "
                "non-archived Project."
            )

        assignment_count = (
            WorkItemAssignee.objects
            .filter(
                work_item__project=project,
                user=target_user,
            )
            .count()
        )

        affected_work_item_count = 0
        transferred_assignment_count = 0
        unassigned_assignment_count = 0

        if assignment_count:
            if assignment_resolution is None:
                raise ProjectDomainError(
                    "Assigned Project work must be "
                    "transferred or left unassigned "
                    "before offboarding."
                )

            affected_work_item_count = (
                _resolve_assignments_for_membership_mutation(
                    project=project,
                    target_user=target_user,
                    resolution_mode=assignment_resolution,
                    replacement_user=(
                        assignment_replacement_user
                    ),
                )
            )

            if assignment_resolution == "transfer":
                transferred_assignment_count = (
                    affected_work_item_count
                )
            elif assignment_resolution == "unassign":
                unassigned_assignment_count = (
                    affected_work_item_count
                )

            record_audit_event(
                research_group=project.research_group,
                actor=actor,
                event_type=(
                    "project.member_assignments_resolved"
                ),
                subject_user=target_user,
                project=project,
                data={
                    "resolution": assignment_resolution,
                    "affectedWorkItemCount":
                        affected_work_item_count,
                    "replacementUserId": (
                        assignment_replacement_user.pk
                        if assignment_replacement_user
                        is not None
                        else None
                    ),
                    "membershipAction": "offboarded",
                    "previousRole": membership.role,
                    "newRole": None,
                },
            )

        elif (
            assignment_resolution is not None
            or assignment_replacement_user is not None
        ):
            raise ProjectDomainError(
                "This Project has no assignments that "
                "require resolution."
            )

        membership.delete()

        return ProjectOffboardingResult(
            project_id=project.pk,
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
