#!/usr/bin/env python3
"""FG Workspace agent-observability product runtime registration (stdlib only).

The registration is the local, privacy-safe record of the **normal
product-agent** Codex runtime identity, written from inside a real
product-agent session (where the host exports CODEX_HOME). It is the
authority the controller shell uses to answer "which Codex home is the
PRODUCT home" — generic $HOME/.codex* discovery must never substitute for
it.

Artifact: .artifacts/agent-observability/product-runtime.json
(git-ignored; a pure function of the registered environment, so
re-registration of an unchanged runtime is byte-identical; a newer explicit
registration deliberately replaces stale identity — no timestamps, no
directory-name heuristics).

Subcommands:
  register <path> --codex-home H [--codex-path P] [--codex-acp-version V]
  show     <path>            print the registration JSON (or "null")
  state    <path>            print "registered|<home>" | "not_registered"
                             | "corrupt|<reason>" (always exit 0)

Privacy contract:
  * only the bounded identity fields below are stored — never environment
    dumps, auth contents, tokens, prompt content, or arbitrary variables;
  * values are validated syntactically (absolute bounded paths, semver);
    auth files are never read or copied.

Exit codes:
  0  ok (including idempotent no-op register and not_registered state)
  2  usage error / invalid value (fail closed)
  6  target directory does not exist (register)
"""
import json
import os
import re
import sys

REG_SCHEMA_VERSION = 1
REG_FILE = "product-runtime.json"
MAX_PATH_LEN = 1024
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")

FIELDS = ("codex_home", "codex_path", "codex_acp_version")


def die(msg, code=2):
    sys.stderr.write("agent-observability product-runtime: ERROR: %s\n" % msg)
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


def valid_path(value, field, required):
    if value is None or value == "":
        if required:
            die("%s is required" % field, 2)
        return None
    if not isinstance(value, str):
        die("%s must be a string" % field, 2)
    if len(value) > MAX_PATH_LEN:
        die("%s exceeds the %d character bound" % (field, MAX_PATH_LEN), 2)
    if any(ch.isspace() for ch in value):
        die("%s must not contain whitespace" % field, 2)
    if not value.startswith("/"):
        die("%s must be an absolute path" % field, 2)
    return value


def valid_semver(value, field):
    if value is None or value == "" or value == "unknown":
        return None
    if not isinstance(value, str) or not SEMVER_RE.match(value):
        die("%s must be a semantic version (x.y.z); got %r" % (field, value), 2)
    return value


def stored_value_ok(field, value):
    """Structural check for a value already stored on disk."""
    if value is None:
        return True
    if not isinstance(value, str):
        return False
    if field == "codex_acp_version":
        return bool(SEMVER_RE.match(value))
    return (
        len(value) <= MAX_PATH_LEN
        and not any(ch.isspace() for ch in value)
        and value.startswith("/")
    )


def load_registration(path):
    """strict read: malformed/invalid stored content is 'corrupt' (fail
    closed) so a corrupted file can never masquerade as identity."""
    data = load_json(path)
    if not isinstance(data, dict):
        return None, "file is not a JSON object"
    if data.get("schema_version") != REG_SCHEMA_VERSION:
        return None, "unsupported schema_version: %r" % data.get("schema_version")
    for f in FIELDS:
        if not stored_value_ok(f, data.get(f)):
            return None, "invalid %s value" % f
    home = data.get("codex_home")
    if not isinstance(home, str) or not home:
        return None, "missing codex_home"
    return data, None


def cmd_register(argv):
    if len(argv) < 2:
        die("usage: productruntime.py register <path> --codex-home H "
            "[--codex-path P] [--codex-acp-version V]", 2)
    out_path = argv[0]
    opts = {}
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in ("--codex-home", "--codex-path", "--codex-acp-version"):
            if i + 1 >= len(argv):
                die("%s requires a value" % a, 2)
            opts[a[2:]] = argv[i + 1]
            i += 2
        else:
            die("unknown argument: %s" % a, 2)
    if "codex-home" not in opts:
        die("--codex-home is required (the product agent's CODEX_HOME)", 2)

    record = {
        "schema_version": REG_SCHEMA_VERSION,
        "codex_home": valid_path(opts["codex-home"], "codex_home", True),
        "codex_path": valid_path(opts.get("codex-path"), "codex_path", False),
        "codex_acp_version": valid_semver(
            opts.get("codex-acp-version"), "codex_acp_version"),
    }

    out_dir = os.path.dirname(os.path.abspath(out_path))
    if not os.path.isdir(out_dir):
        die("target directory does not exist: %s" % out_dir, 6)

    existing = load_json(out_path)
    if existing == record:
        print("unchanged|codex_home=%s" % record["codex_home"])
        return 0
    if isinstance(existing, dict):
        # Deliberate replacement of stale identity (explicit re-registration
        # is authoritative); the file stays a pure function of the new
        # registered environment.
        print("replaced|codex_home=%s (was %s)"
              % (record["codex_home"], existing.get("codex_home")))
    else:
        print("registered|codex_home=%s" % record["codex_home"])
    atomic_write(out_path, record)
    return 0


def cmd_show(argv):
    if len(argv) != 1:
        die("usage: productruntime.py show <path>", 2)
    path = argv[0]
    if not os.path.exists(path):
        print("null")
        return 0
    data, err = load_registration(path)
    if err is not None:
        die("registration is corrupt: %s (repair: re-run register from a "
            "product session)" % err, 7)
    print(json.dumps(data, indent=2, sort_keys=True) if data else "null")
    return 0


def cmd_state(argv):
    if len(argv) != 1:
        die("usage: productruntime.py state <path>", 2)
    path = argv[0]
    if not os.path.exists(path):
        print("not_registered|")
        return 0
    data, err = load_registration(path)
    if err is not None:
        print("corrupt|" + err)
        return 0
    print("registered|" + data["codex_home"])
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, argv = sys.argv[1], sys.argv[2:]
    if cmd == "register":
        return cmd_register(argv)
    if cmd == "show":
        return cmd_show(argv)
    if cmd == "state":
        return cmd_state(argv)
    print("unknown subcommand: " + cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
