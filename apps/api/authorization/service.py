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

Meeting-specific access is expressed here as the ``MEETING_READ`` /
``MEETING_WRITE`` capabilities so the Meeting domain uses the same
foundation (invariant: Work Items and Meetings share the scope/
authorization foundation):

- group scope: every CURRENT Research Group member can read and fully
  collaborate on the group's Meetings;
- project scope: read stays restricted to the creator / explicit
  participants, and collaboration additionally requires a valid current
  ProjectMembership (canonical Project-read boundary). Meeting
  collaboration never grants PROJECT_WORK or any other Project / Work
  Item right.
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

    Delegates to the batched canonical resolver
    (``resolve_project_scopes``) for a single Project, so the
    Project-scope rule has exactly one implementation.
    """
    if project_id is None:
        return None
    return resolve_project_scopes(user, [project_id]).get(project_id)


def resolve_project_scopes(user, project_ids) -> dict:
    """Batched canonical Project scope resolution for a set of
    Projects.

    The per-Project rule is IDENTICAL to ``resolve_project_scope``:
    a current ``ProjectMembership`` in the Project AND a current
    ``ResearchGroupMembership`` in the Project's Research Group
    (default deny otherwise). The batched load issues exactly ONE
    ProjectMembership query across ALL given Projects and — only when
    at least one membership exists — ONE ResearchGroupMembership
    query across exactly the Research Groups those memberships'
    Projects belong to: the SQL query count is constant in the
    number of Projects (no per-Project N+1). Projects without a
    matching membership, or without current Research Group
    membership, resolve to ``None`` exactly like the single-Project
    resolver does.

    ``project_ids`` may be any iterable of Project primary keys
    (``None`` entries and duplicates are collapsed; an empty
    iterable yields an empty mapping). The returned mapping covers
    every non-None input id.
    """
    auth = get_auth_context(user)
    if not auth.is_active:
        return {
            project_id: None
            for project_id in sorted(
                {
                    project_id
                    for project_id in project_ids
                    if project_id is not None
                }
            )
        }

    ids = sorted(
        {project_id for project_id in project_ids if project_id is not None}
    )
    if not ids:
        return {}

    memberships = {
        membership.project_id: membership
        for membership in (
            ProjectMembership.objects.select_related("project")
            .filter(user=user, project_id__in=ids)
        )
    }
    if not memberships:
        return {project_id: None for project_id in ids}

    group_ids = {
        membership.project.research_group_id
        for membership in memberships.values()
    }
    group_membership_ids = set(
        ResearchGroupMembership.objects
        .filter(user=user, research_group_id__in=group_ids)
        .values_list("research_group_id", flat=True)
    )

    scopes = {}
    for project_id in ids:
        membership = memberships.get(project_id)
        if membership is None:
            scopes[project_id] = None
            continue
        if (
            membership.project.research_group_id
            not in group_membership_ids
        ):
            scopes[project_id] = None
            continue
        scopes[project_id] = ScopeContext(
            kind=ScopeKind.PROJECT,
            research_group_id=membership.project.research_group_id,
            project_id=membership.project_id,
            role=membership.role,
            capabilities=capabilities_for_project_role(membership.role),
        )
    return scopes


def resolve_group_scopes(user, group_ids) -> dict:
    """Batched canonical Research Group scope resolution for a set of
    Research Groups.

    The per-Group rule is IDENTICAL to ``resolve_group_scope``: a
    current ``ResearchGroupMembership`` in the Group (default deny
    otherwise). The batched load issues exactly ONE
    ``ResearchGroupMembership`` query across ALL given Groups: the
    SQL query count is constant in the number of Groups (no
    per-Group N+1). Groups without a matching membership resolve to
    ``None`` exactly like the single-Group resolver does.

    ``group_ids`` may be any iterable of Group primary keys (``None``
    entries and duplicates are collapsed; an empty iterable yields an
    empty mapping). The returned mapping covers every non-None input
    id.
    """
    auth = get_auth_context(user)
    if not auth.is_active:
        return {
            group_id: None
            for group_id in sorted(
                {
                    group_id
                    for group_id in group_ids
                    if group_id is not None
                }
            )
        }

    ids = sorted(
        {group_id for group_id in group_ids if group_id is not None}
    )
    if not ids:
        return {}

    memberships = {
        membership.research_group_id: membership
        for membership in (
            ResearchGroupMembership.objects.filter(
                user=user,
                research_group_id__in=ids,
            )
        )
    }

    scopes = {}
    for group_id in ids:
        membership = memberships.get(group_id)
        if membership is None:
            scopes[group_id] = None
            continue
        scopes[group_id] = ScopeContext(
            kind=ScopeKind.GROUP,
            research_group_id=membership.research_group_id,
            role=membership.role,
            capabilities=capabilities_for_group_role(membership.role),
        )
    return scopes


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
# Meeting read access:
#   group scope    → any CURRENT Research Group member (GROUP_READ);
#   project scope  → the Meeting's creator or an explicit
#                    MeetingParticipant WITH a valid current Project
#                    access (the canonical Project-read boundary).
#                    Scope membership, ownership, or admin status
#                    alone grant nothing, and a stale creator /
#                    participant relation without current Project
#                    access grants no read access either.
# Meeting collaboration (write) follows the Meeting's scope:
#   group scope    → GROUP_READ (any current Research Group member);
#   project scope  → the creator or an explicit participant with a
#                    valid current ProjectMembership satisfying the
#                    canonical Project-read boundary, and the Project
#                    not archived.
# Destructive Meeting administration (admin):
#   group scope    → GROUP_READ (any current Research Group member);
#   project scope  → the creator or an explicit participant with
#                    PROJECT_WORK (Project owner or member), and the
#                    Project not archived.
# The moderator identity is NOT an authorization gate.


def _meeting_participant_or_creator(meeting, user) -> bool:
    from meetings.models import MeetingParticipant

    if meeting.created_by_id == user.pk:
        return True
    # Use the prefetched relation when the caller already loaded it
    # (e.g. a permission-filtered Meeting list); otherwise fall back
    # to the same direct query. The prefetch holds ALL participant
    # relations of the Meeting, so the membership test is
    # semantically identical to the filtered exists() check.
    try:
        relations = meeting._prefetched_objects_cache[
            "participant_relations"
        ]
    except (AttributeError, KeyError):
        return MeetingParticipant.objects.filter(
            meeting_id=meeting.pk,
            user=user,
        ).exists()
    return any(relation.user_id == user.pk for relation in relations)


def resolve_meeting_scope(
    user,
    meeting,
    *,
    group_scope: Optional[ScopeContext] = None,
    project_scopes: Optional[dict] = None,
    group_scopes: Optional[dict] = None,
) -> Optional[ScopeContext]:
    """Resolve the user's scope for one Meeting occurrence.

    ``group_scope`` and ``project_scopes`` are optional pre-resolved
    authorization inputs for list-style callers that already resolved
    them for the whole result set: ``group_scope`` must be the
    caller's ``resolve_group_scope`` result for this Meeting's
    Research Group, and ``project_scopes`` a caller-built
    ``resolve_project_scopes`` mapping covering this Meeting's
    Project. When provided, the kernel consumes them instead of
    issuing the equivalent queries; the capability rules applied to
    them are the SAME rules as when the kernel resolves them itself
    (one implementation, no second authorization path).

    Pre-resolved inputs are trusted ONLY after an identity check
    against the Meeting they are applied to — a scope that does not
    belong to THIS Meeting's Research Group / Project is an
    authorization identity mismatch and FAILS CLOSED: the Meeting
    resolves to NO capabilities (``None``), and there is NO implicit
    fallback to re-resolving the user's actual scope (an
    inconsistent caller input is a programming error, not a cache
    miss):

    - ``group_scope`` must have ``kind == ScopeKind.GROUP`` and
      ``research_group_id == meeting.research_group_id``;
    - ``group_scopes`` (the batched twin of ``group_scope``) must
      carry an entry for this Meeting's Research Group with
      ``kind == ScopeKind.GROUP`` and
      ``research_group_id == meeting.research_group_id``;
    - the ``project_scopes`` entry selected by ``meeting.project_id``
      must exist and have ``kind == ScopeKind.PROJECT``,
      ``project_id == meeting.project_id``, and
      ``research_group_id == meeting.research_group_id``.

    ``group_scopes`` is a caller-built ``resolve_group_scopes``
    mapping covering every Research Group represented by a list-style
    result set. When provided it takes precedence over the single
    ``group_scope`` and is consumed with the SAME fail-closed
    identity check — a missing or mismatched entry resolves to NO
    capabilities with NO fallback re-resolution (identical contract
    to ``project_scopes``).

    Ordinary resolution (no pre-resolved inputs supplied) is
    unchanged.

    The capabilities are independent (canonical model):

    - ``MEETING_READ``:
      - group scope: any CURRENT Research Group member (``GROUP_READ``);
      - project scope: the user created the Meeting or is an explicit
        ``MeetingParticipant`` AND holds a valid current
        ProjectMembership satisfying the canonical Project-read
        boundary. Project membership, ownership, or admin status
        alone do NOT grant read access, and a stale creator /
        participant relation without current Project access grants
        no read access either.
    - ``MEETING_WRITE`` (Meeting collaboration):
      - group scope: ``GROUP_READ`` (any current Research Group
        member);
      - project scope: the creator or an explicit participant with a
        valid current ProjectMembership satisfying the canonical
        Project-read boundary, and the Project not archived.
    - ``MEETING_ADMIN`` (destructive Meeting administration):
      - group scope: ``GROUP_READ`` (any current Research Group
        member — group Meetings are fully collaborative);
      - project scope: the creator or an explicit participant with
        ``PROJECT_WORK`` (Project owner or member), and the Project
        not archived. Participation with a ``viewer`` role alone
        never grants destructive administration.

    Meeting collaboration is NOT Project access: it never grants
    ``PROJECT_WORK`` or any other Project / Work Item capability, and
    the moderator identity is not an authorization gate.

    Returns None when the user has none, so views answer 404.
    """
    auth = get_auth_context(user)
    if not auth.is_active:
        return None

    caps = set()
    is_collaborator = _meeting_participant_or_creator(meeting, user)

    if meeting.scope == "group":
        if meeting.project_id is not None:
            # Scope inconsistency guard: a group Meeting must not
            # reference a Project.
            return None
        if group_scopes is not None:
            # Batched pre-resolved input (list caller): the mapping
            # covers exactly this Meeting's Research Group. A missing
            # or mismatched entry fails closed with NO fallback
            # re-resolution — the SAME contract as ``project_scopes``.
            group_scope = group_scopes.get(
                meeting.research_group_id
            )
            if not (
                group_scope is not None
                and group_scope.kind == ScopeKind.GROUP
                and group_scope.research_group_id
                == meeting.research_group_id
            ):
                return None
        else:
            if group_scope is not None and not (
                group_scope.kind == ScopeKind.GROUP
                and group_scope.research_group_id
                == meeting.research_group_id
            ):
                # An explicitly supplied group scope that does not
                # belong to this Meeting's Research Group must never
                # grant Meeting capabilities: fail closed, and do NOT
                # fall back to re-resolving the user's actual group
                # scope (an inconsistent caller input is a programming
                # error, not a missing cache entry).
                return None
            if group_scope is None:
                group_scope = resolve_group_scope(
                    user, meeting.research_group_id
                )
        if group_scope is not None and group_scope.has(
            Capability.GROUP_READ
        ):
            caps.add(Capability.MEETING_READ)
            caps.add(Capability.MEETING_WRITE)
            caps.add(Capability.MEETING_ADMIN)
    else:
        if meeting.project_id is None:
            return None
        if not is_collaborator:
            return None
        # Use the already-loaded Project relation when the caller
        # eager-loaded it (select_related); otherwise the access
        # issues the same single-row lookup as before. A missing
        # Project row resolves exactly like the former filtered
        # query: None.
        try:
            project = meeting.project
        except Project.DoesNotExist:
            project = None
        if project_scopes is not None:
            project_scope = project_scopes.get(meeting.project_id)
            if not (
                project_scope is not None
                and project_scope.kind == ScopeKind.PROJECT
                and project_scope.project_id == meeting.project_id
                and project_scope.research_group_id
                == meeting.research_group_id
            ):
                # The explicitly supplied mapping must match this
                # Meeting's Project identity exactly (kind, Project,
                # and Research Group). A missing or mismatched
                # entry fails closed — there is NO implicit
                # fallback to resolving this or any other Project.
                return None
        else:
            project_scope = (
                resolve_project_scope(user, meeting.project_id)
                if project is not None
                else None
            )
        if project_scope is None:
            # A stale creator / participant relation without valid
            # current Project access grants nothing.
            return None
        if project_scope.has(Capability.PROJECT_READ):
            caps.add(Capability.MEETING_READ)
        if project is not None and project.archived_at is None:
            if project_scope.has(Capability.PROJECT_READ):
                caps.add(Capability.MEETING_WRITE)
            if project_scope.has(Capability.PROJECT_WORK):
                caps.add(Capability.MEETING_ADMIN)

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


def require_meeting_admin(user, meeting) -> ScopeContext:
    scope = resolve_meeting_scope(user, meeting)
    if scope is None or not scope.has(Capability.MEETING_ADMIN):
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
    "resolve_group_scopes",
    "has_group_capability",
    "require_group_capability",
    "group_scope_for",
    "resolve_project_scope",
    "resolve_project_scopes",
    "has_project_capability",
    "require_project_capability",
    "project_scope_for",
    "resolve_meeting_scope",
    "require_meeting_admin",
    "require_meeting_write",
    "resolve_meeting_series_scope",
    "resolve_meeting_recurrence_scope",
]
