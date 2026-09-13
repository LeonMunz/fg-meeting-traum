"""AuthContext and ScopeContext: explicit scope + identity representation.

- ``AuthContext`` wraps the trusted, server-authenticated identity.
  It is only ever built from ``request.user`` (server session); no
  client-supplied identity is accepted.
- ``ScopeContext`` is an explicit Group/Project/Meeting scope
  representation carrying the effective capability set for one user in
  one scope. An empty capability set means DENY.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from .capabilities import Capability


class ScopeKind(str, Enum):
    GROUP = "group"
    PROJECT = "project"
    MEETING = "meeting"
    MEETING_SERIES = "meeting_series"


@dataclass(frozen=True)
class ScopeContext:
    """One user's effective position inside one resource scope.

    ``capabilities`` is the *effective* set already reduced by all
    applicable membership/account-state rules. Anything not in the set
    is denied (default deny).
    """

    kind: ScopeKind
    capabilities: frozenset[Capability]
    research_group_id: Optional[int] = None
    project_id: Optional[int] = None
    role: Optional[str] = None

    def has(self, capability: Capability) -> bool:
        return capability in self.capabilities


@dataclass(frozen=True)
class AuthContext:
    """Trusted authenticated identity from the server session."""

    user: object

    @property
    def is_authenticated(self) -> bool:
        user = self.user
        return bool(getattr(user, "is_authenticated", False))

    @property
    def is_active(self) -> bool:
        """Account state as represented by the current system.

        An inactive account (suspended) carries no capabilities.
        """
        user = self.user
        return bool(
            self.is_authenticated
            and getattr(user, "is_active", False)
        )
