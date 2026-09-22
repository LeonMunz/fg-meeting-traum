"""The single canonical server-side authorization service.

Every protected Group/Project/Work Item/Meeting operation resolves its
scope and required capability through this module.

Rules:
- Identity comes from the authenticated server session (``request.user``).
- Default is DENY: missing/unknown role, missing membership, or an
  inactive account yields an empty capability set.
- Inaccessible scopes resolve to ``None`` so views can answer with a
  non-leaking 404 (existence is not revealed).
- Knowing a valid resource ID never grants access: scope resolution
  always re-reads the current persisted membership state.

Meeting-specific access (creator-or-participant read rule) is expressed
here as the ``MEETING_READ`` / ``MEETING_WRITE`` capabilities so the
Meeting domain uses the same foundation (invariant: Work Items and
Meetings share the scope/authorization foundation).
"""

from typing import Optional

from django.db import transaction

from projects.models import Project, ProjectMembership
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from .capabilities import (
    Capability,
    capabilities_for_group_role,
    capabilities_for_project_role,
)
from .context import AuthContext, ScopeContext, ScopeKind


class AuthorizationDenied(Exception):
    """Raised when the default-deny check fails."""

    def __init__(self, message: str = "Access denied."):
        self.message = message
        super().__init__(message)


def get_auth_context(user) -> AuthContext:
    """Build the trusted AuthContext for a server-authenticated user."""
    return AuthContext(user=user)


def _ensure_active(auth: AuthContext) -> None:
    if not auth.is_active:
        raise AuthorizationDenied(
            "The account cannot perform this operation."
        )


# ── ResearchGroup scope ───────────────────────────────────────────


def resolve_group_scope(
    user,
    research_group_id,
) -> Optional[ScopeContext]:
    """Resolve the user's scope in one ResearchGroup.

    Returns None when the user has no current group membership there
    (views answer 404 so group existence is not leaked).
    """
    auth = get_auth_context(user)
    if not auth.is_active:
        return None

    membership = ResearchGroupMembership.objects.filter(
        research_group_id=research_group_id,
        user=user,
    ).first()

    if membership is None:
        return None

    return ScopeContext(
        kind=ScopeKind.GROUP,
        research_group_id=membership.research_group_id,
        role=membership.role,
        capabilities=capabilities_for_group_role(membership.role),
    )


def has_group_capability(
    user,
    research_group_id,
    capability: Capability,
) -> bool:
    scope = resolve_group_scope(user, research_group_id)
    return scope is not None and scope.has(capability)


def require_group_capability(
    user,
    research_group_id,
    capability: Capability,
) -> ScopeContext:
    scope = resolve_group_scope(user, research_group_id)
    if scope is None or not scope.has(capability):
        raise AuthorizationDenied()
    return scope


def group_scope_for(user, research_group: ResearchGroup) -> Optional[ScopeContext]:
    """Object-level resolution for an already-loaded group row."""
    return resolve_group_scope(user, research_group.pk)


# ── Project scope ─────────────────────────────────────────────────
#
# Effective Project access requires BOTH a current ProjectMembership
# and a current ResearchGroupMembership in the Project's group. The
# composite FK keeps those two relations consistent in the database;
# this check is the authorization-level expression of the same rule.


def resolve_project_scope(
    user,
    project_id,
) -> Optional[ScopeContext]:
    """Resolve the user's scope in one Project.

    Returns None when the user has no effective access (no
    ProjectMembership, no current group membership, unknown Project,
    or inactive account). Views answer 404.
    """
    auth = get_auth_context(user)
    if not auth.is_active:
        return None

    membership = ProjectMembership.objects.select_related(
        "project"
    ).filter(
        project_id=project_id,
        user=user,
    ).first()

    if membership is None:
        return None

    project = membership.project

    if not ResearchGroupMembership.objects.filter(
        research_group_id=project.research_group_id,
        user=user,
    ).exists():
        return None

    return ScopeContext(
        kind=ScopeKind.PROJECT,
        research_group_id=project.research_group_id,
        project_id=project.pk,
        role=membership.role,
        capabilities=capabilities_for_project_role(membership.role),
    )


def has_project_capability(
    user,
    project_id,
    capability: Capability,
) -> bool:
    scope = resolve_project_scope(user, project_id)
    return scope is not None and scope.has(capability)


def require_project_capability(
    user,
    project_id,
    capability: Capability,
) -> ScopeContext:
    scope = resolve_project_scope(user, project_id)
    if scope is None or not scope.has(capability):
        raise AuthorizationDenied()
    return scope


def project_scope_for(user, project: Project) -> Optional[ScopeContext]:
    """Object-level resolution for an already-loaded Project row."""
    return resolve_project_scope(user, project.pk)


# ── Meeting scope ─────────────────────────────────────────────────
#
# Meeting read access is creator-or-participant (MeetingParticipant).
# Group/Project membership, ownership, or admin status alone do NOT
# grant Meeting visibility. Meeting write access additionally requires
# the scope capability of the Meeting's scope:
#   group scope    → GROUP_READ
#   project scope  → PROJECT_WORK (and the Project not archived)


def _meeting_participant_or_creator(meeting, user) -> bool:
    from meetings.models import MeetingParticipant

    if meeting.created_by_id == user.pk:
        return True
    return MeetingParticipant.objects.filter(
        meeting_id=meeting.pk,
        user=user,
    ).exists()


def resolve_meeting_scope(
    user,
    meeting,
) -> Optional[ScopeContext]:
    """Resolve the user's scope for one Meeting occurrence.

    The two capabilities are independent (canonical model):

    - ``MEETING_READ``: the user created the Meeting or is an explicit
      ``MeetingParticipant``. Group/Project membership alone does not
      grant read access.
    - ``MEETING_WRITE``: the scoped write rule of the Meeting's scope
      (group: ``GROUP_READ``; project: ``PROJECT_WORK`` and the Project
      is not archived).

    Returns None when the user has neither, so views answer 404.
    """
    auth = get_auth_context(user)
    if not auth.is_active:
        return None

    caps = set()

    if _meeting_participant_or_creator(meeting, user):
        caps.add(Capability.MEETING_READ)

    if meeting.scope == "group":
        if meeting.project_id is not None:
            # Scope inconsistency guard: a group Meeting must not
            # reference a Project.
            return None
        group_scope = resolve_group_scope(
            user, meeting.research_group_id
        )
        if group_scope is not None and group_scope.has(
            Capability.GROUP_READ
        ):
            caps.add(Capability.MEETING_WRITE)
    else:
        if meeting.project_id is None:
            return None
        project_scope = resolve_project_scope(user, meeting.project_id)
        project = Project.objects.filter(pk=meeting.project_id).first()
        if (
            project_scope is not None
            and project is not None
            and project.archived_at is None
            and project_scope.has(Capability.PROJECT_WORK)
        ):
            caps.add(Capability.MEETING_WRITE)

    if not caps:
        return None

    return ScopeContext(
        kind=ScopeKind.MEETING,
        research_group_id=meeting.research_group_id,
        project_id=meeting.project_id,
        capabilities=frozenset(caps),
    )


def require_meeting_write(user, meeting) -> ScopeContext:
    scope = resolve_meeting_scope(user, meeting)
    if scope is None or not scope.has(Capability.MEETING_WRITE):
        raise AuthorizationDenied()
    return scope


# ── Meeting Series scope ──────────────────────────────────────────


def resolve_meeting_series_scope(
    user,
    series,
) -> Optional[ScopeContext]:
    """Resolve the user's scope for one Meeting Series template."""
    auth = get_auth_context(user)
    if not auth.is_active:
        return None

    group_scope = resolve_group_scope(user, series.research_group_id)
    if group_scope is None:
        return None

    caps = {Capability.MEETING_SERIES_READ}

    if series.scope == "group":
        if series.project_id is not None:
            return None
        if group_scope.has(Capability.GROUP_READ):
            caps.add(Capability.MEETING_SERIES_WRITE)
    else:
        if series.project_id is None:
            return None
        project_scope = resolve_project_scope(user, series.project_id)
        project = Project.objects.filter(pk=series.project_id).first()
        if project_scope is None or project is None:
            return None
        caps = {
            Capability.MEETING_SERIES_READ,
        }
        if (
            project.archived_at is None
            and project_scope.has(Capability.PROJECT_WORK)
        ):
            caps.add(Capability.MEETING_SERIES_WRITE)

    return ScopeContext(
        kind=ScopeKind.MEETING_SERIES,
        research_group_id=series.research_group_id,
        project_id=series.project_id,
        capabilities=frozenset(caps),
    )


# ── Meeting Recurrence scope ────────────────────────────────────


def resolve_meeting_recurrence_scope(
    user,
    recurrence,
) -> Optional[ScopeContext]:
    """Resolve the user's scope for one MeetingRecurrence schedule.

    A Recurrence is a scope-level schedule resource (not a concrete
    Meeting occurrence), so its read rule follows the Meeting Series
    scope read rule for the Recurrence's scope:

    - group scope: any current ResearchGroup member (``GROUP_READ``);
    - Project scope: current Project membership (``PROJECT_READ``)
      AND a current ResearchGroupMembership in the Project's group.

    Returns None when the user has no read access, so views answer a
    non-leaking 404. Knowing a valid recurrence id never grants
    access. (No Recurrence write capability exists yet: there is no
    Recurrence mutation API.)
    """
    auth = get_auth_context(user)
    if not auth.is_active:
        return None

    group_scope = resolve_group_scope(user, recurrence.research_group_id)
    if group_scope is None:
        return None

    if recurrence.scope == "group":
        if recurrence.project_id is not None:
            # Scope inconsistency guard: a group Recurrence must not
            # reference a Project.
            return None
    else:
        if recurrence.project_id is None:
            return None
        project_scope = resolve_project_scope(user, recurrence.project_id)
        if project_scope is None:
            return None
        if project_scope.research_group_id != recurrence.research_group_id:
            # Scope inconsistency guard: the Recurrence's Project must
            # live in the Recurrence's own Research Group.
            return None
        if not project_scope.has(Capability.PROJECT_READ):
            return None

    return ScopeContext(
        kind=ScopeKind.MEETING_RECURRENCE,
        research_group_id=recurrence.research_group_id,
        project_id=recurrence.project_id,
        capabilities=frozenset({Capability.MEETING_RECURRENCE_READ}),
    )


__all__ = [
    "AuthorizationDenied",
    "AuthContext",
    "ScopeContext",
    "ScopeKind",
    "Capability",
    "get_auth_context",
    "resolve_group_scope",
    "has_group_capability",
    "require_group_capability",
    "group_scope_for",
    "resolve_project_scope",
    "has_project_capability",
    "require_project_capability",
    "project_scope_for",
    "resolve_meeting_scope",
    "require_meeting_write",
    "resolve_meeting_series_scope",
    "resolve_meeting_recurrence_scope",
]
