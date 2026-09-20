#!/usr/bin/env python3
"""FG Workspace agent-observability structured run-context tool (stdlib only).

Subcommands:
  set      <run_dir> --task-type T --session M [--task-key K]
          [--harness-variant H]
          Partially update <run_dir>/run-context.json (idempotent, atomic).
  show     <run_dir>
          Print the run-context JSON (or "null" when absent).
  resolve  <runs_dir>
          Print the id of the single live product capture under runs_dir.

Privacy contract:
  * task_type is a closed enum matching the repository's orchestration
    contract; session_mode is a closed enum (CURRENT | NEW)
  * task_key / harness_variant are bounded slugs: 1-128 characters of
    [A-Za-z0-9._-], no whitespace — arbitrary prompt/chat text cannot
    enter any field
  * nothing is inferred: values are only what was explicitly supplied
  * the file lives in the run directory (git-ignored with the run)

Exit codes:
  0  ok
  2  usage error / invalid value (fail closed)
  6  run directory not found
  7  run-context file malformed
  10 no live product capture (resolve)
  11 ambiguous: multiple live product captures (resolve)
"""
import json
import os
import re
import sys

# The canonical process-liveness semantic lives in liveness.py (same
# package dir). Make it importable whether this file is run as a
# script or imported from elsewhere.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import liveness  # noqa: E402

CONTEXT_SCHEMA_VERSION = 1
CONTEXT_FILE = "run-context.json"
TASK_TYPES = (
    "Bug",
    "Vertical Slice",
    "Domain",
    "Stabilization",
    "Documentation",
)
SESSION_MODES = ("CURRENT", "NEW")
SLUG_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$")
MAX_SLUG_LEN = 128

FIELDS = ("task_type", "session_mode", "task_key", "harness_variant")


def die(msg, code=2):
    sys.stderr.write("agent-observability context: ERROR: %s\n" % msg)
    sys.exit(code)


def load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def atomic_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def empty_context():
    return {
        "schema_version": CONTEXT_SCHEMA_VERSION,
        "task_type": None,
        "session_mode": None,
        "task_key": None,
        "harness_variant": None,
    }


def validate_value(field, value):
    """Fail closed on any value that is not one of the bounded,
    low-cardinality shapes the field allows. Returns the validated value."""
    if value is None:
        return None
    if not isinstance(value, str):
        die("%s must be a string (got %s)" % (field, type(value).__name__), 2)
    if field == "task_type":
        if value not in TASK_TYPES:
            die("task_type must be one of: %s" % ", ".join(TASK_TYPES), 2)
        return value
    if field == "session_mode":
        if value not in SESSION_MODES:
            die("session_mode must be one of: %s" % ", ".join(SESSION_MODES), 2)
        return value
    # task_key / harness_variant: bounded slug, never prompt text
    if len(value) > MAX_SLUG_LEN:
        die("%s exceeds the %d character bound" % (field, MAX_SLUG_LEN), 2)
    if not SLUG_RE.match(value):
        die("%s must be a slug: 1-%d characters of [A-Za-z0-9._-], "
            "starting and ending with a letter or digit (no whitespace, "
            "no arbitrary text)" % (field, MAX_SLUG_LEN), 2)
    return value


def stored_value_ok(field, value):
    """Structural/enum check for a value already stored on disk."""
    if value is None:
        return True
    if not isinstance(value, str):
        return False
    if field == "task_type":
        return value in TASK_TYPES
    if field == "session_mode":
        return value in SESSION_MODES
    return len(value) <= MAX_SLUG_LEN and bool(SLUG_RE.match(value))


def load_context(run_dir, strict=True):
    """Read the stored context.

    strict=True (ledger/show): malformed stored content fails closed
    (exit 7) so corrupted values never flow into the ledger.
    strict=False (set): malformed stored content is treated as absent —
    the file is rebuilt from the fully validated new values, which is how
    a corrupted file gets repaired. Nothing unvalidated is ever written.
    """
    path = os.path.join(run_dir, CONTEXT_FILE)
    if not os.path.isfile(path):
        return None
    data = load_json(path)
    if not isinstance(data, dict):
        if strict:
            die("run-context file is malformed: %s" % path, 7)
        return None
    for f in FIELDS:
        if not stored_value_ok(f, data.get(f)):
            if strict:
                die("run-context file is malformed (invalid %s value): %s"
                    % (f, path), 7)
            return None
    return data


def cmd_set(argv):
    paths = []
    opts = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--task-type", "--session", "--task-key", "--harness-variant"):
            if i + 1 >= len(argv):
                die("%s requires a value" % a, 2)
            opts[a] = argv[i + 1]
            i += 2
        else:
            paths.append(a)
            i += 1
    if len(paths) != 1:
        die("usage: runcontext.py set <run_dir> --task-type T --session M "
            "[--task-key K] [--harness-variant H]", 2)
    run_dir = paths[0]
    if not os.path.isdir(run_dir):
        die("run directory not found: %s" % run_dir, 6)
    if "--task-type" not in opts or "--session" not in opts:
        die("--task-type and --session are both required", 2)

    data = load_context(run_dir, strict=False) or empty_context()
    if data.get("schema_version") != CONTEXT_SCHEMA_VERSION:
        die("run-context file has unsupported schema_version: %r"
            % data.get("schema_version"), 7)
    updates = {
        "task_type": validate_value("task_type", opts["--task-type"]),
        "session_mode": validate_value("session_mode", opts["--session"]),
    }
    if "--task-key" in opts:
        updates["task_key"] = validate_value("task_key", opts["--task-key"])
    if "--harness-variant" in opts:
        updates["harness_variant"] = validate_value(
            "harness_variant", opts["--harness-variant"])
    merged = dict(data)
    merged.update(updates)
    atomic_write(os.path.join(run_dir, CONTEXT_FILE), merged)
    print(json.dumps(merged, indent=2, sort_keys=True))
    return 0


def cmd_show(argv):
    if len(argv) != 1 or not os.path.isdir(argv[0]):
        die("usage: runcontext.py show <run_dir>", 6)
    data = load_context(argv[0])
    print(json.dumps(data, indent=2, sort_keys=True) if data else "null")
    return 0


def pid_alive(pid):
    """Single canonical liveness semantic (delegates to liveness.py).

    A pid is alive whether it is signalable or merely permission-denied
    (EPERM, e.g. a controller-owned collector); only a nonexistent (ESRCH)
    or invalid pid is dead.
    """
    return liveness.is_alive(pid)


def live_product_runs(runs_dir):
    """Product captures (manifest kind == 'capture') with a live collector
    pid. Probes are diagnostic and never count. Deterministic (sorted)."""
    out = []
    if not os.path.isdir(runs_dir):
        return out
    for name in sorted(os.listdir(runs_dir)):
        if not name.startswith("run-"):
            continue
        d = os.path.join(runs_dir, name)
        if not os.path.isdir(d):
            continue
        manifest = load_json(os.path.join(d, "capture-manifest.json"))
        if not isinstance(manifest, dict) or manifest.get("kind") != "capture":
            continue
        try:
            with open(os.path.join(d, "collector.pid"), "r", encoding="ascii") as fh:
                pid = int(fh.read().strip())
        except Exception:
            continue
        if pid_alive(pid):
            out.append(name)
    return out


def cmd_resolve(argv):
    if len(argv) != 1:
        die("usage: runcontext.py resolve <runs_dir>", 2)
    runs_dir = argv[0]
    live = live_product_runs(runs_dir)
    if len(live) == 0:
        die("no live product capture (start one: ./scripts/agent-observability start)", 10)
    if len(live) > 1:
        die("ambiguous: multiple live product captures: %s — pass an explicit run id"
            % ", ".join(live), 11)
    print(live[0])
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, argv = sys.argv[1], sys.argv[2:]
    if cmd == "set":
        return cmd_set(argv)
    if cmd == "show":
        return cmd_show(argv)
    if cmd == "resolve":
        return cmd_resolve(argv)
    print("unknown subcommand: " + cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
