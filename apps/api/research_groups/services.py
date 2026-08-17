"""Research Group application/domain operations.

Centralizes Research Group management rules so permission and
membership invariants are not duplicated across API views.

ResearchGroupMembership represents current group access.
ProjectMembership remains an independent Project-level security boundary.
"""

from typing import Optional

from django.db import transaction

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
