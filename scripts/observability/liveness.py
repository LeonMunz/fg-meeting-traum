#!/usr/bin/env python3
"""Canonical process-liveness semantic for FG agent observability.

A liveness probe has exactly three semantic outcomes. The first two are ALIVE;
only the third is not:

  signalable   os.kill(pid, 0) succeeded       -> exists, and we may signal it
  denied       PermissionError  (EPERM)        -> exists, owned by another identity
  dead         ProcessLookupError (ESRCH)      -> does not exist (or pid invalid)

The key invariant: never collapse "permission denied" and "no such process"
into one boolean failure. A controller-owned collector that the calling agent
cannot signal (EPERM) is a *live* process, not a dead one. This is the exact
condition that arises across the controller/agent identity boundary.

Every liveness decision in the repository routes through this helper so that
`status`, active-run discovery, `context current` / `current-run`, and
verification correlation all share one semantic. Python is the only portable
*structured* mechanism here: on macOS there is no /proc, and a shell `kill -0`
returns the same non-zero status for both EPERM and ESRCH (the difference is
only in the localized error text, which we deliberately never parse).
"""

import os
import sys

SIGNALABLE = "signalable"
DENIED = "denied"
DEAD = "dead"

#: Outcomes that mean the process exists (is alive).
ALIVE = (SIGNALABLE, DENIED)


def classify(pid):
    """Return ``'signalable'``, ``'denied'``, or ``'dead'`` for *pid*.

    *pid* may be an int or a string (e.g. a pidfile line). Invalid, empty,
    non-numeric, or non-positive pids are ``'dead'``: a pidfile that is not a
    real pid is never evidence of a live collector.
    """
    try:
        n = int(str(pid).strip())
    except (TypeError, ValueError):
        return DEAD
    if n <= 0:
        return DEAD
    try:
        os.kill(n, 0)
    except PermissionError:
        # Exists, but we cannot signal it (owned by another identity). Alive.
        return DENIED
    except (ProcessLookupError, OverflowError, OSError):
        # Does not exist (ESRCH), pid out of range, or any other kernel error:
        # fail closed rather than claim a live run.
        return DEAD
    return SIGNALABLE


def is_alive(pid):
    """True iff *pid* names an existing process (signalable or merely
    permission-denied)."""
    return classify(pid) in ALIVE


def main(argv):
    # classify <pid>  -> print one of: signalable|denied|dead (exit 0)
    # alive <pid>     -> exit 0 if alive (signalable|denied), else exit 1
    if len(argv) == 2 and argv[0] in ("classify", "alive"):
        outcome = classify(argv[1])
        if argv[0] == "classify":
            print(outcome)
            return 0
        return 0 if outcome in ALIVE else 1
    sys.stderr.write("usage: liveness.py classify <pid> | liveness.py alive <pid>\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
