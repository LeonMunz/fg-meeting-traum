"""Canonical personal My Work — shared projection query source.

Personal My Work is NOT a separate task database: it is an
authorized projection over the canonical ``WorkItem`` table
(``docs/domain/foundation.md`` §14). This module is the single
source of that projection's queryset so that every consumer —
the personal My Work endpoint, the per-Research-Group My Work
endpoint, and the Home read models — applies the identical
boundary instead of maintaining independent copies.

The canonical predicate (all conditions are CURRENT rows only —
historical data never grants visibility):

1. **Current assignment**: a ``WorkItemAssignee`` row for the
   user (the same relational assignment the Project views use).
   Unassigned Work Items never qualify, and ownership of the
   Project never creates an assignment.
2. **Current Project membership**: a ``ProjectMembership`` of the
   user in the Work Item's Project restricted to the canonical
   assignee-eligible roles ``owner``/``member``. The role filter
   is not a My-Work-specific rule: assignment requires the
   ``PROJECT_WORK`` capability (``owner``/``member`` only — a
   viewer holds only ``PROJECT_READ`` and can never canonically
   be an assignee, ``foundation.md`` §9), and the canonical
   mutation paths never leave an assignment row pointing at a
   user who lost eligibility. The read-time role filter applies
   that assignment-eligibility invariant at read time, as
   defense in depth.
3. **Current Research Group membership**: a
   ``ResearchGroupMembership`` of the user in the Project's
   Research Group — the cross-group boundary. Research Group
   membership alone never grants Project access, and losing the
   membership removes the Work Item immediately.

Callers apply their own ``select_related``/``order_by`` and any
additional, explicitly documented projection filters.
"""

from projects.models import ProjectMembership

from .models import WorkItem


def personal_my_work_queryset(user, *, group_id=None):
    """Return the canonical personal My Work queryset for ``user``.

    The unfiltered queryset is the personal cross-Research-Group
    My Work boundary (the query behind ``GET /api/me/work-items/``).
    Passing ``group_id`` restricts the projection to Projects of
    that one Research Group (the query behind
    ``GET /api/research-groups/{group_id}/my-work/``; the caller
    is responsible for rejecting groups the user cannot access
    before calling).

    The result is ``.distinct()``-ed because the membership joins
    can duplicate rows. No ``select_related`` or ordering is
    applied here — consumers declare their own.
    """
    queryset = WorkItem.objects.filter(
        # 1. current assignment to the user
        assignee_relations__user=user,
        # 2. current Project membership in the Work Item's Project,
        #    restricted to the canonical assignee-eligible roles
        project__memberships__user=user,
        project__memberships__role__in=[
            ProjectMembership.Role.OWNER,
            ProjectMembership.Role.MEMBER,
        ],
        # 3. current Research Group membership in the Project's
        #    Research Group (the cross-group boundary)
        project__research_group__memberships__user=user,
    ).distinct()

    if group_id is not None:
        queryset = queryset.filter(project__research_group_id=group_id)

    return queryset
