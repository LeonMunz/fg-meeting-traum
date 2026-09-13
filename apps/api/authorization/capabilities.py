"""Typed capabilities and the central role → capability mapping.

This is the single canonical role→capability table. Endpoint and
service code must check capabilities through ``authorization.service``;
raw ``if role == ...`` authorization logic is not allowed elsewhere.

Canonical spec: ``docs/domain/authorization.md`` §5.
"""

from enum import Enum

from projects.models import ProjectMembership
from research_groups.models import ResearchGroupMembership


class Capability(str, Enum):
    """Typed server-side capabilities granted by scope membership."""

    GROUP_READ = "group.read"
    GROUP_CREATE_PROJECT = "group.create_project"
    GROUP_MANAGE = "group.manage"

    PROJECT_READ = "project.read"
    PROJECT_WORK = "project.work"
    PROJECT_MANAGE = "project.manage"

    MEETING_READ = "meeting.read"
    MEETING_WRITE = "meeting.write"

    MEETING_SERIES_READ = "meeting_series.read"
    MEETING_SERIES_WRITE = "meeting_series.write"


_NO_CAPABILITIES: frozenset[Capability] = frozenset()

# ResearchGroup role → capabilities.
GROUP_ROLE_CAPABILITIES: dict[str, frozenset[Capability]] = {
    ResearchGroupMembership.Role.MEMBER: frozenset(
        {
            Capability.GROUP_READ,
            Capability.GROUP_CREATE_PROJECT,
        }
    ),
    ResearchGroupMembership.Role.ADMIN: frozenset(
        {
            Capability.GROUP_READ,
            Capability.GROUP_CREATE_PROJECT,
            Capability.GROUP_MANAGE,
        }
    ),
}

# Project role → capabilities. Effective Project capabilities always
# additionally require a current ResearchGroupMembership in the
# Project's Research Group; that conjunction is applied by the
# authorization service, not by this table.
PROJECT_ROLE_CAPABILITIES: dict[str, frozenset[Capability]] = {
    ProjectMembership.Role.VIEWER: frozenset(
        {Capability.PROJECT_READ}
    ),
    ProjectMembership.Role.MEMBER: frozenset(
        {
            Capability.PROJECT_READ,
            Capability.PROJECT_WORK,
        }
    ),
    ProjectMembership.Role.OWNER: frozenset(
        {
            Capability.PROJECT_READ,
            Capability.PROJECT_WORK,
            Capability.PROJECT_MANAGE,
        }
    ),
}


def capabilities_for_group_role(role) -> frozenset[Capability]:
    """Capabilities for a ResearchGroup role (default deny)."""
    if role is None:
        return _NO_CAPABILITIES
    return GROUP_ROLE_CAPABILITIES.get(role, _NO_CAPABILITIES)


def capabilities_for_project_role(role) -> frozenset[Capability]:
    """Capabilities for a Project role (default deny)."""
    if role is None:
        return _NO_CAPABILITIES
    return PROJECT_ROLE_CAPABILITIES.get(role, _NO_CAPABILITIES)
