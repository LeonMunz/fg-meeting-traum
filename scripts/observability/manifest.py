#!/usr/bin/env python3
"""FG Workspace agent-observability capture manifest tool (stdlib only).

Subcommands:
  seed     <run_dir> <run_id> <kind>   create an initial running manifest
  finalize <run_dir> [--stop-status S] scan raw OTLP files, finalize manifest
  summary  <run_dir>                   print the manifest JSON (or null)

The manifest is the normalized, versioned side-car of a capture session.
Later Harness analysis must consume manifest + the documented trace contract
(docs/agent/trace-contract.json), never ad-hoc raw OTel field names.
"""
import json
import os
import re
import subprocess
import sys
import time

SCHEMA_VERSION = 1
RAW_GLOBS = ("logs.jsonl", "traces.jsonl", "metrics.jsonl")


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def env_str(name, default="unknown"):
    v = os.environ.get(name, "").strip()
    return v if v else default


def git_field(repo_root, *args):
    try:
        out = subprocess.run(
            ["git", "-C", repo_root] + list(args),
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0:
            # rstrip only: porcelain status lines keep line format intact
            return out.stdout.rstrip(chr(10))
    except Exception:
        pass
    return ""



def porcelain_paths(repo_root, limit=500):
    """Changed file paths from git status --porcelain (bounded, sorted).

    Returns (count, paths, truncated). Paths are repository-relative file
    names only (no diff content).
    """
    out = git_field(repo_root, "status", "--porcelain")
    if not out:
        return 0, [], False
    paths = set()
    for line in out.splitlines():
        if len(line) < 4:
            continue
        path = line[3:]
        arrow = " -> "
        if arrow in path:
            path = path.split(arrow, 1)[1]
        if path:
            paths.add(path)
    paths = sorted(paths)
    truncated = len(paths) > limit
    return len(paths), paths[:limit], truncated


def numstat_totals(repo_root, starting_head):
    """Added/deleted line totals vs the starting commit (tracked files).

    Returns (added, deleted) or (None, None) when not safely available.
    """
    if not starting_head or not re.fullmatch(r"[0-9a-f]{7,64}", starting_head):
        return None, None
    try:
        out = subprocess.run(
            ["git", "-C", repo_root, "diff", "--numstat", starting_head],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            return None, None
    except Exception:
        return None, None
    added = deleted = 0
    for line in out.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        a, d = parts[0], parts[1]
        if a.isdigit():
            added += int(a)
        if d.isdigit():
            deleted += int(d)
    return added, deleted


def git_end_evidence(repo_root, starting_head):
    """End-of-run Git/WIP evidence, recorded once at finalize time.

    Deterministic stored evidence: the ledger (later normalization) must
    never read live git state, which would make re-normalization
    non-reproducible.
    """
    evidence = {
        "ending_head": None,
        "ending_tree": None,
        "changed_file_count": None,
        "changed_files": [],
        "changed_files_truncated": False,
        "lines_added": None,
        "lines_deleted": None,
        "commit_created": None,
    }
    if not repo_root or not os.path.isdir(repo_root):
        return evidence
    ending_head = git_field(repo_root, "rev-parse", "HEAD") or None
    evidence["ending_head"] = ending_head
    if ending_head and starting_head:
        evidence["commit_created"] = ending_head != starting_head
    porcelain = git_field(repo_root, "status", "--porcelain")
    evidence["ending_tree"] = "clean" if not porcelain else "dirty"
    if porcelain is not None:
        count, paths, truncated = porcelain_paths(repo_root)
        evidence["changed_file_count"] = count
        evidence["changed_files"] = paths
        evidence["changed_files_truncated"] = truncated
        added, deleted = numstat_totals(repo_root, starting_head)
        evidence["lines_added"] = added
        evidence["lines_deleted"] = deleted
    return evidence

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


def raw_files(run_dir):
    raw = os.path.join(run_dir, "raw")
    found = []
    if os.path.isdir(raw):
        for name in sorted(os.listdir(raw)):
            path = os.path.join(raw, name)
            if os.path.isfile(path) and (
                name.startswith("logs") or name.startswith("traces") or name.startswith("metrics")
            ):
                found.append("raw/" + name)
    return found


def attrs_to_dict(attrs):
    out = {}
    if not isinstance(attrs, list):
        return out
    for kv in attrs:
        if not isinstance(kv, dict):
            continue
        key = kv.get("key")
        val = kv.get("value") or {}
        if isinstance(val, dict):
            for variant in ("stringValue", "intValue", "boolValue", "doubleValue"):
                if variant in val:
                    out[key] = val[variant]
                    break
    return out


def scan_raw(run_dir):
    conversation_ids = set()
    event_counts = {}
    app_versions = set()
    models = set()
    originators = set()
    span_counts = {}
    metric_names = {}
    log_record_count = 0
    span_count = 0
    metric_series_count = 0

    raw = os.path.join(run_dir, "raw")
    if not os.path.isdir(raw):
        return None
    for name in sorted(os.listdir(raw)):
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(raw, name)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(payload, dict):
                        continue
                    for rlogs in payload.get("resourceLogs") or []:
                        for slogs in rlogs.get("scopeLogs") or []:
                            for rec in slogs.get("logRecords") or []:
                                if not isinstance(rec, dict):
                                    continue
                                log_record_count += 1
                                attrs = attrs_to_dict(rec.get("attributes"))
                                cid = attrs.get("conversation.id")
                                if isinstance(cid, str) and cid:
                                    conversation_ids.add(cid)
                                ename = attrs.get("event.name")
                                if isinstance(ename, str) and ename:
                                    event_counts[ename] = event_counts.get(ename, 0) + 1
                                if isinstance(attrs.get("app.version"), str):
                                    app_versions.add(attrs["app.version"])
                                if isinstance(attrs.get("model"), str):
                                    models.add(attrs["model"])
                                if isinstance(attrs.get("originator"), str):
                                    originators.add(attrs["originator"])
                    for rspans in payload.get("resourceSpans") or []:
                        for spans in rspans.get("scopeSpans") or []:
                            for span in spans.get("spans") or []:
                                if not isinstance(span, dict):
                                    continue
                                span_count += 1
                                sname = span.get("name")
                                if isinstance(sname, str) and sname:
                                    span_counts[sname] = span_counts.get(sname, 0) + 1
                                attrs = attrs_to_dict(span.get("attributes"))
                                cid = attrs.get("conversation.id")
                                if isinstance(cid, str) and cid:
                                    conversation_ids.add(cid)
                                for evt in span.get("events") or []:
                                    if not isinstance(evt, dict):
                                        continue
                                    ename = evt.get("name")
                                    if isinstance(ename, str) and ename and not ename.startswith("codex."):
                                        continue
                                    if isinstance(ename, str) and ename:
                                        event_counts["span-event:" + ename] = (
                                            event_counts.get("span-event:" + ename, 0) + 1
                                        )
                    for rmetrics in payload.get("resourceMetrics") or []:
                        for smetrics in rmetrics.get("scopeMetrics") or []:
                            for metric in smetrics.get("metrics") or []:
                                if not isinstance(metric, dict):
                                    continue
                                mname = metric.get("name")
                                if isinstance(mname, str) and mname:
                                    metric_names[mname] = metric_names.get(mname, 0)
                                    metric_series_count += 1
        except Exception:
            continue

    return {
        "conversation_ids": sorted(conversation_ids),
        "event_counts": dict(sorted(event_counts.items())),
        "app_versions": sorted(app_versions),
        "models": sorted(models),
        "originators": sorted(originators),
        "span_counts": dict(sorted(span_counts.items())),
        "metric_names": dict(sorted(metric_names.items())),
        "log_record_count": log_record_count,
        "span_count": span_count,
        "metric_series_count": metric_series_count,
    }


def base_manifest(run_id, kind, run_dir):
    repo_root = env_str("FG_OBS_REPO_ROOT")
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "kind": kind,
        "start_ts": now_iso(),
        "end_ts": None,
        "stop_status": "running",
        "repo_root": repo_root,
        "branch": git_field(repo_root, "rev-parse", "--abbrev-ref", "HEAD") or None,
        "starting_head": git_field(repo_root, "rev-parse", "HEAD") or None,
        "starting_tree": (
            "clean"
            if not git_field(repo_root, "status", "--porcelain")
            else "dirty"
        ),
        "ending_head": None,
        "ending_tree": None,
        "changed_file_count": None,
        "changed_files": [],
        "changed_files_truncated": False,
        "lines_added": None,
        "lines_deleted": None,
        "commit_created": None,
        # Capture-time Codex discovery is NOT the product Codex version:
        # the ledger derives runtime.codex_version from the telemetry
        # app.version the Codex process itself emitted. Captures leave
        # this null (explicit unknown); only the native probe records
        # the exact binary it ran.
        "codex_version": os.environ.get("FG_OBS_CODEX_VERSION", "").strip() or None,
        "codex_acp_version": env_str("FG_OBS_CODEX_ACP_VERSION"),
        "collector_version": env_str("FG_OBS_COLLECTOR_VERSION"),
        "otel_endpoint": env_str("FG_OBS_OTEL_ENDPOINT"),
        "privacy_mode": env_str("FG_OBS_PRIVACY_MODE", "trace-safe-sanitized"),
        "retention_days": env_str("FG_OBS_RETENTION_DAYS", "14"),
        "max_file_mb": env_str("FG_OBS_MAX_MB", "32"),
        "max_backups": env_str("FG_OBS_MAX_BACKUPS", "10"),
        "raw_trace_files": [],
        "conversation_ids": [],
        "event_counts": {},
        "app_versions": [],
        "models": [],
        "originators": [],
        "span_counts": {},
        "metric_names": {},
        "log_record_count": 0,
        "span_count": 0,
        "metric_series_count": 0,
    }


def cmd_seed(argv):
    if len(argv) != 3:
        print("usage: manifest.py seed <run_dir> <run_id> <kind>", file=sys.stderr)
        return 2
    run_dir, run_id, kind = argv
    os.makedirs(os.path.join(run_dir, "raw"), exist_ok=True)
    path = os.path.join(run_dir, "capture-manifest.json")
    existing = load_json(path)
    if existing and existing.get("run_id") == run_id and existing.get("stop_status") == "running":
        return 0  # idempotent
    atomic_write(path, base_manifest(run_id, kind, run_dir))
    print("seeded " + path)
    return 0


def cmd_finalize(argv):
    run_dir = argv[0]
    stop_status = "graceful"
    if "--stop-status" in argv:
        i = argv.index("--stop-status")
        if i + 1 < len(argv):
            stop_status = argv[i + 1]
    path = os.path.join(run_dir, "capture-manifest.json")
    manifest = load_json(path)
    if manifest is None:
        # Finalizing without a seed (e.g. crashed run): build a minimal record.
        manifest = base_manifest(
            os.path.basename(os.path.abspath(run_dir)), "capture", run_dir
        )
    scan = scan_raw(run_dir) or {}
    manifest.update(scan)
    manifest.update(
        git_end_evidence(
            manifest.get("repo_root"), manifest.get("starting_head")
        )
    )
    manifest["raw_trace_files"] = raw_files(run_dir)
    manifest["end_ts"] = now_iso()
    manifest["stop_status"] = stop_status
    atomic_write(path, manifest)
    print("finalized " + path)
    return 0


def cmd_summary(argv):
    run_dir = argv[0]
    manifest = load_json(os.path.join(run_dir, "capture-manifest.json"))
    if manifest is None:
        print("null")
        return 0
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, argv = sys.argv[1], sys.argv[2:]
    if cmd == "seed":
        return cmd_seed(argv)
    if cmd == "finalize":
        return cmd_finalize(argv)
    if cmd == "summary":
        return cmd_summary(argv)
    print("unknown subcommand: " + cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
