#!/usr/bin/env python3
"""FG Workspace agent-observability Run Ledger normalizer (stdlib only).

Subcommands:
  normalize <run_dir>           normalize the run's stored evidence into
                                <run_dir>/run-ledger.json (idempotent)
  show      <run_dir> [--json]  normalize (idempotent) then print the record:
                                full JSON with --json, human summary without
  annotate  <run_dir> --correction yes|no [--category C] [--note S]
            [--classification K] [--for-failure REF]
                                append one explicit human annotation to
                                <run_dir>/annotations.json (raw telemetry is
                                never rewritten)

Normalization boundary:
  raw sanitized OTel (logs/traces/metrics per docs/agent/trace-contract.json)
  + capture-manifest.json
  + verification evidence JSON stored in the run directory
  + explicit human annotations
+ run-context.json (structured, bounded run context)
  -> versioned normalized Run Ledger record (docs/agent/ledger-contract.json,
     schema v4: adds the bounded structured run context, native
     run-config runtime fields, the comparability section, the persisted
     captured conversation identity (identity.captured_conversation_id,
     since v3 — the primary activity / failure / token metrics are scoped
     to that captured conversation, and foreign telemetry (other
     conversation ids in the same raw run) is reported explicitly via
     activity.foreign instead of being merged into the captured turn's
     metrics), and — since v4 — the bounded diagnostic-only pathological
     run section (diagnostics.pathological_run): explicit deterministic
     signals over the normalized captured-scoped metrics that flag clearly
     pathological behavior for human review. Diagnostic only: it never
     terminates or cancels anything and never changes budgets or model
     settings)

Rules:
  * deterministic: the record is a pure function of the stored evidence
    (no wall clock, no live git state); re-running produces identical bytes
  * raw OTel attribute names outside the trace contract are never read
  * unavailable evidence yields null / empty values plus a stable
    evidence-gap code — never guessed values
  * failure classifications are only recorded when explicitly annotated;
    an exit code or success=false never invents a semantic class
  * privacy: only contract-named, already-sanitized, bounded fields are
    copied into the record (counts, statuses, durations, identifiers)

Exit codes:
  0  ok
  2  usage error
  6  run directory not found
  7  required capture manifest missing or malformed
  8  verification evidence attribution mismatch (agentRunId != run id)
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

try:
    import runcontext  # shared bounded-field contract for run-context.json
except ImportError:  # pragma: no cover - same-directory import fallback
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import runcontext

LEDGER_SCHEMA_VERSION = 4
RECORD_NAME = "fg-agent-run-ledger"
LEDGER_FILE = "run-ledger.json"
ANNOTATIONS_FILE = "annotations.json"
ANNOTATIONS_SCHEMA_VERSION = 1
RUN_CONTEXT_FILE = "run-context.json"

FAILURE_CLASSIFICATIONS = (
    "PRODUCT_REGRESSION",
    "STALE_TEST",
    "ENVIRONMENT_OR_HARNESS",
    "SCOPE_DISCOVERY",
)
ANNOTATION_CATEGORIES = (
    "wrong_approach",
    "wrong_scope",
    "missing_context",
    "incorrect_assumption",
    "env_or_tooling",
    "test_update",
    "spec_clarification",
    "other",
)
NOTE_MAX_LEN = 280
REF_MAX_LEN = 200

# Broad tool categories (normalized view). Raw tool names are deliberately
# not exposed in the by-type map; unknown tools collapse to "other".
TOOL_TYPE_MAP = {
    "exec_command": "shell",
    "exec": "shell",
    "shell": "shell",
    "bash": "shell",
    "apply_patch": "file",
    "write_file": "file",
    "edit_file": "file",
    "read_file": "file",
    "view_file": "file",
    "view": "file",
    "view_image": "file",
    "grep": "search",
    "search": "search",
    "find": "search",
    "list_files": "search",
    "list": "search",
    "web_search": "web",
    "web_fetch": "web",
    "browse": "web",
    "fetch": "web",
    "update_plan": "plan",
    "request_user_input": "interaction",
    "ask_user": "interaction",
}

# Contract-named token attributes on codex.sse_event (response.completed) —
# the only token-usage source besides the metrics signal.
SSE_TOKEN_KEYS = (
    "input_token_count",
    "output_token_count",
    "cached_token_count",
    "cache_write_token_count",
    "reasoning_token_count",
)
TOKEN_FIELD_MAP = {
    "input_token_count": "input",
    "output_token_count": "output",
    "cached_token_count": "cached",
    "cache_write_token_count": "cache_write",
    "reasoning_token_count": "reasoning",
}

# Verification evidence file shapes recognized inside a run directory.
VERIFY_IGNORED_FILES = {
    "capture-manifest.json",
    LEDGER_FILE,
    ANNOTATIONS_FILE,
    RUN_CONTEXT_FILE,
    "probe-summary.json",
}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def die(msg, code=2):
    sys.stderr.write("agent-observability ledger: ERROR: %s\n" % msg)
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


# --------------------------------------------------------------- context ----

def load_run_context(run_dir):
    """Read <run_dir>/run-context.json.

    Returns the validated field dict, or None when the file is absent.
    Malformed content (invalid enum / prompt-like stored value) fails
    closed (exit 7) via the shared runcontext contract.
    """
    return runcontext.load_context(run_dir)


def empty_context():
    return {
        "task_type": None,
        "session_mode": None,
        "task_key": None,
        "harness_variant": None,
    }


# ------------------------------------------------------------- value utils --

def attr_dict(attrs):
    """OTLP attribute list -> dict (first value variant wins)."""
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


def as_bool(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        if v.lower() == "true":
            return True
        if v.lower() == "false":
            return False
    return None


def as_int(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str):
        try:
            return int(v)
        except ValueError:
            try:
                return int(float(v))
            except ValueError:
                return None
    return None


def as_ts(v):
    """ISO-8601 UTC string (Z suffix) -> aware datetime or None."""
    if not isinstance(v, str) or not v:
        return None
    s = v.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# -------------------------------------------------------------- raw events --

def raw_jsonl_files(run_dir, prefix):
    raw = os.path.join(run_dir, "raw")
    if not os.path.isdir(raw):
        return []
    found = []
    for name in sorted(os.listdir(raw)):
        path = os.path.join(raw, name)
        if os.path.isfile(path) and name.startswith(prefix) and name.endswith(".jsonl"):
            found.append(path)
    return found


def iter_events(run_dir):
    """Yield normalized events {name, ts, conv, ref, attrs} from sanitized raw.

    Sources: log records in raw/logs*.jsonl and span events named codex.* in
    raw/traces*.jsonl (same trace-contract attribute shape). Consumers dedup
    via _event_key (correlation tuple + canonical sanitized-attribute
    serialization) so an event that appears both as a log record and a span
    event is counted once, while distinct records that share the
    correlation tuple (e.g. the paired 0.148.0 response.completed with and
    without token counters) are kept. Only trace-contract-named attributes
    are exposed downstream.
    """
    for prefix in ("logs", "traces"):
        for path in raw_jsonl_files(run_dir, prefix):
            try:
                fh = open(path, "r", encoding="utf-8", errors="replace")
            except OSError:
                continue
            with fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                    except Exception:
                        continue  # truncated/corrupt line: skip (interruption safety)
                    if not isinstance(payload, dict):
                        continue
                    for rlogs in payload.get("resourceLogs") or []:
                        for slogs in rlogs.get("scopeLogs") or []:
                            for rec in slogs.get("logRecords") or []:
                                if not isinstance(rec, dict):
                                    continue
                                ev = _event_from_attrs(attr_dict(rec.get("attributes")))
                                if ev is not None:
                                    yield ev
                    for rspans in payload.get("resourceSpans") or []:
                        for spans in rspans.get("scopeSpans") or []:
                            for span in spans.get("spans") or []:
                                if not isinstance(span, dict):
                                    continue
                                for evt in span.get("events") or []:
                                    if not isinstance(evt, dict):
                                        continue
                                    name = evt.get("name")
                                    if not isinstance(name, str) or not name.startswith("codex."):
                                        continue
                                    ev = _event_from_attrs(attr_dict(evt.get("attributes")))
                                    if ev is not None:
                                        yield ev


def _canonical_attrs(attrs):
    """Canonical, deterministic serialization of the sanitized attribute map.

    Sorted keys and compact separators make the output a pure function of
    the attribute content: it does not depend on dictionary insertion
    order, on Python object identity, or on per-process hash randomization
    (``json.dumps`` with ``sort_keys`` is stable across runs and processes).
    The input is the already-sanitized attribute set persisted by the
    collector (private keys are dropped at capture time), so the string
    carries no raw/private payload. It is used only to build the in-memory
    dedup identity and is never written into the ledger record.
    """
    return json.dumps(attrs, sort_keys=True, separators=(",", ":"))


def _event_key(ev):
    """Logical identity of one normalized telemetry event.

    The correlation tuple (event name, timestamp, conversation id,
    reference id) is necessary but NOT sufficient. Codex 0.148.0 can emit
    two distinct ``response.completed`` records for the same API response
    in the same payload at the same millisecond: one without token
    counters and one with them. They share name/timestamp/conversation/
    reference, so the correlation tuple alone would wrongly collapse one
    into the other and silently drop the counter-bearing record.

    The identity therefore additionally covers the COMPLETE sanitized
    attribute set (a canonical deterministic serialization of the
    already-sanitized attributes). Consequences:

    * two records that differ in any meaningful sanitized attribute remain
      distinct logical events even when they share the correlation tuple;
    * two byte/logically equivalent copies of the same record still
      collapse to one logical event (identical attributes -> identical
      canonical serialization), preserving the existing exact-duplicate
      (log/span) dedup behavior;
    * the result is deterministic and depends only on sanitized content —
      never on insertion order, object identity, randomized hashing, or
      unsanitized/private payload data.
    """
    return (
        ev.get("name"),
        ev.get("ts_iso") or "",
        ev.get("conv") or "",
        ev.get("ref") or "",
        _canonical_attrs(ev.get("attrs") or {}),
    )


def collect_events(run_dir):
    events = []
    seen = set()
    for ev in iter_events(run_dir):
        # Deduplicate only when the key is complete: an event observed both
        # as a log record and as a span event carries the same timestamp and
        # the same sanitized attributes, so its full identity matches. The
        # identity also covers the sanitized attribute content: an exact
        # copy of an already-seen record is dropped, while a record that
        # shares name/timestamp/conversation/reference but differs in
        # sanitized attributes (e.g. the paired 0.148.0 response.completed
        # with/without token counters) is a distinct logical event and is
        # kept. Events without a timestamp cannot be matched reliably and
        # are always kept (e.g. codex.api_request records, which in 0.148.0
        # carry no event.timestamp).
        if ev.get("ts_iso"):
            key = _event_key(ev)
            if key in seen:
                continue
            seen.add(key)
        events.append(ev)
    return events


def _event_from_attrs(attrs):
    name = attrs.get("event.name")
    if not isinstance(name, str) or not name:
        return None
    ts_raw = attrs.get("event.timestamp")
    ts = as_ts(ts_raw)
    call_id = attrs.get("call_id")
    attempt = attrs.get("attempt")
    ref = call_id if isinstance(call_id, str) and call_id else (
        attempt if isinstance(attempt, str) and attempt else "")
    conv = attrs.get("conversation.id")
    return {
        "name": name,
        "ts": ts,
        "ts_iso": ts_raw if isinstance(ts_raw, str) else None,
        "conv": conv if isinstance(conv, str) else None,
        "ref": ref,
        "attrs": attrs,
    }


def conversation_config(events):
    """Run-level runtime configuration from native telemetry.

    Source: the FIRST codex.conversation_starts event (earliest timestamp;
    tie-break by conversation id — deterministic). Only values that are
    actually present on that event are returned; absent attributes stay
    None and surface as explicit comparability gaps. Never inferred.
    """
    starts = [e for e in events if e["name"] == "codex.conversation_starts"]
    if not starts:
        return {"reasoning_effort": None, "sandbox_mode": None,
                "approval_policy": None}

    def sort_key(e):
        return (
            e["ts"] is None,
            e["ts"] or datetime.min.replace(tzinfo=timezone.utc),
            e["conv"] or "",
        )

    first = min(starts, key=sort_key)

    def str_attr(attr):
        v = first["attrs"].get(attr)
        return v if isinstance(v, str) and v else None

    return {
        "reasoning_effort": str_attr("reasoning_effort"),
        "sandbox_mode": str_attr("sandbox_policy"),
        "approval_policy": str_attr("approval_policy"),
    }


def _datapoint_conversation(attrs):
    c = attr_dict(attrs).get("conversation.id")
    return c if isinstance(c, str) and c else None


def token_usage_from_metrics(run_dir, conv=None, conv_set=None):
    """Sum codex.turn.token_usage datapoints attributable to a conversation.

    conv (single identity): only datapoints whose conversation.id attribute
    EQUALS conv count; a datapoint without a conversation.id — or with a
    different one — is never attributed to the captured turn.
    conv_set (foreign set): membership mode for the foreign diagnostic.
    Neither (historical aggregate mode): all datapoints count, as before.
    Returns (total, found): found is True when at least one datapoint was
    attributed (total may legitimately be 0).
    """
    total = 0
    found = False
    for path in raw_jsonl_files(run_dir, "metrics"):
        try:
            fh = open(path, "r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
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
                for rmetrics in payload.get("resourceMetrics") or []:
                    for smetrics in rmetrics.get("scopeMetrics") or []:
                        for metric in smetrics.get("metrics") or []:
                            if not isinstance(metric, dict):
                                continue
                            if metric.get("name") != "codex.turn.token_usage":
                                continue
                            for data in (metric.get("sum"), metric.get("gauge"),
                                          metric.get("histogram")):
                                if not isinstance(data, dict):
                                    continue
                                for point in data.get("dataPoints") or []:
                                    if not isinstance(point, dict):
                                        continue
                                    c = _datapoint_conversation(
                                        point.get("attributes"))
                                    if conv is not None:
                                        if c != conv:
                                            continue
                                    elif conv_set is not None:
                                        if c not in conv_set:
                                            continue
                                    val = point.get("asInt")
                                    if val is None:
                                        val = point.get("asDouble")
                                    n = as_int(val)
                                    if n is not None:
                                        total += n
                                        found = True
    return total, found


def sse_token_sums(sse_events):
    """Per-field sums of the contract-named SSE token counters."""
    sums = {}
    for ev in sse_events:
        for key in SSE_TOKEN_KEYS:
            n = as_int(ev["attrs"].get(key))
            if n is not None:
                sums[key] = sums.get(key, 0) + n
    return sums


def _api_request_failed(ev):
    ok = as_bool(ev["attrs"].get("success"))
    status = as_int(ev["attrs"].get("http.response.status_code"))
    return ok is False or (status is not None and status >= 400)


# ------------------------------------------------------------- verification --

def verification_evidence(run_dir, run_id):
    """Collect verify-summary + doctor JSON evidence stored in the run dir.

    Attribution is explicit, never timestamp-guessed: a verify summary may
    carry an agentRunId (written by agent-verify.sh when FG_AGENT_RUN_ID is
    set); a non-null agentRunId that does not equal this run's id is a
    hard error (exit 8). Placement in the run directory is itself explicit
    attribution for summaries without the field.
    """
    profiles = []
    doctor = None
    obs_doctor = None
    if not os.path.isdir(run_dir):
        return None, None, None
    for name in sorted(os.listdir(run_dir)):
        if name in VERIFY_IGNORED_FILES or not name.endswith(".json"):
            continue
        path = os.path.join(run_dir, name)
        if not os.path.isfile(path):
            continue
        data = load_json(path)
        if not isinstance(data, dict):
            continue
        if (isinstance(data.get("phases"), list) and "profile" in data
                and "schemaVersion" in data):
            agent_run_id = data.get("agentRunId")
            if agent_run_id not in (None, "") and agent_run_id != run_id:
                die("verification evidence attribution mismatch: %s carries "
                    "agentRunId %r, expected %r — move the file to the run "
                    "directory it belongs to" % (name, agent_run_id, run_id), 8)
            phases = []
            for ph in data.get("phases") or []:
                if not isinstance(ph, dict):
                    continue
                phases.append({
                    "name": ph.get("name") if isinstance(ph.get("name"), str) else None,
                    "outcome": ph.get("outcome") if isinstance(ph.get("outcome"), str) else None,
                    "exit_code": ph.get("exitCode") if as_int(ph.get("exitCode")) is not None
                                 else (None if ph.get("exitCode") is None else ph.get("exitCode")),
                })
            profiles.append({
                "profile": data.get("profile") if isinstance(data.get("profile"), str) else None,
                "result": data.get("result") if isinstance(data.get("result"), str) else None,
                "exit_code": as_int(data.get("exitCode")),
                "started_at": data.get("startedAt") if isinstance(data.get("startedAt"), str) else None,
                "finished_at": data.get("finishedAt") if isinstance(data.get("finishedAt"), str) else None,
                "duration_ms": as_int(data.get("durationMs")),
                "agent_run_id": agent_run_id if isinstance(agent_run_id, str) and agent_run_id else None,
                "source": name,
                "phases": phases,
            })
        elif data.get("tool") == "agent-doctor":
            caps = []
            for cap in data.get("capabilities") or []:
                if isinstance(cap, dict) and isinstance(cap.get("name"), str):
                    caps.append({
                        "name": cap["name"],
                        "status": cap.get("status") if isinstance(cap.get("status"), str) else None,
                    })
            # Status sources, in order: the explicit "result" field
            # (historical shape) or the real agent-doctor.sh --json
            # "summary.overall" field. Neither is invented.
            status = data.get("result")
            if not isinstance(status, str):
                summary = data.get("summary")
                overall = summary.get("overall") if isinstance(summary, dict) else None
                status = overall if isinstance(overall, str) else None
            doctor = {
                "status": status,
                "capabilities": caps,
                "source": name,
            }
        elif data.get("tool") == "agent-observability-doctor":
            obs_doctor = {
                "status": data.get("status") if isinstance(data.get("status"), str) else None,
                "source": name,
            }
    return profiles, doctor, obs_doctor


def comparability_section(identity, runtime, ctx, profiles, doctor,
                          obs_doctor):
    """Deterministic per-run evidence-presence map.

    Answers only whether each comparability dimension has evidence in this
    run. It is not a quality score and never ranks runs: missing dimensions
    are represented explicitly (False + listed in "missing").
    """
    dims = {
        "model": bool(runtime.get("models")),
        "reasoning_effort": runtime.get("reasoning_effort") is not None,
        "codex_version": runtime.get("codex_version") is not None,
        "codex_acp_version": runtime.get("codex_acp_version") is not None,
        "sandbox_mode": runtime.get("sandbox_mode") is not None,
        "approval_policy": runtime.get("approval_policy") is not None,
        "task_type": ctx.get("task_type") is not None,
        "session_mode": ctx.get("session_mode") is not None,
        "git_starting_revision": identity.get("starting_head") is not None,
        "verification_evidence": bool(profiles),
        "doctor_evidence": doctor is not None or obs_doctor is not None,
        "harness_variant": ctx.get("harness_variant") is not None,
    }
    return {"dimensions": dict(sorted(dims.items())),
            "missing": sorted(k for k, v in dims.items() if not v)}


def final_gate(profiles):
    if not profiles:
        return None
    def key(p):
        return (as_ts(p.get("started_at")) or datetime.min.replace(tzinfo=timezone.utc),
                p.get("source") or "")
    latest = max(profiles, key=key)
    return {"profile": latest.get("profile"), "result": latest.get("result"),
            "source": latest.get("source")}


# ------------------------------------------------------- diagnostics (v4) --
#
# Pathological run diagnostics (schema v4).
#
# Diagnostic ONLY: this section flags clearly pathological captured-turn
# behavior for human review. It is a warning surface, never an
# intervention: nothing here terminates or cancels a model, a turn, the
# agent, or the ACP session, and nothing here changes token budgets or
# model settings. Detection and intervention are separate decisions.
#
# Design principle: explicit deterministic signals over observable
# telemetry features (normalized, stored metrics) + the observed values
# that fired them — never a single opaque pathology score, never a
# semantic guess about whether the model's prose "looks bad". A signal
# whose required evidence is absent is reported in "unevaluated" with a
# stable reason; it is never guessed and never silently false.
#
# Scoping: all conversation-attributable signals use the PRIMARY
# (captured-conversation-scoped) activity metrics only. Foreign telemetry
# (activity.foreign) never influences this section. When no captured
# identity is persisted and more than one conversation was observed, the
# primary activity is the run-wide aggregate and MUST NOT be read as the
# captured turn's activity (the captured_conversation_unknown gap): the
# attributable signals are then unevaluated, never inferred. The
# no_progress_after_long_run signal uses only deliberately unscoped
# run-level facts (capture window, end-of-run Git evidence, verification
# evidence in the run directory) and stays evaluable.
#
# Thresholds — INITIAL conservative heuristics (high precision first),
# derived from the stored evidence of the captured runs 2026-09-19..21
# (rationale: docs/agent/OBSERVABILITY.md, "Pathological run
# diagnostics"). Reference points: the pathological incident
# run-20260921T111009Z, captured conversation 01a0c3a6-dd79-7652-bb05-
# ecb528dd8c5d: 2178 s, 0 tool calls, 0 attributed API requests,
# 221,128 output tokens of which 221,128 are reasoning (essentially no
# visible output), graceful end. Across the corpus: no normal run
# combined zero tool progress with large generation (no run with >= 3k
# output tokens used 0 tools; every run with >= 84k output tokens used
# >= 36 tools); the maximum reasoning share among runs with >= 50k
# output tokens is 0.82; no normal run >= 1800 s ended with zero changed
# files and no verification; the maximum failed-tool concentration is
# 8.3%. Recalibrate as more evidence accumulates.

DIAG_MIN_DURATION_S = 1800        # incident: 2178 s; longest normal >= 1800 s runs all ended with changed files
DIAG_MIN_OUTPUT_TOKENS = 200000   # incident: 221,128; max normal output with 0 tools: 1,789
DIAG_REASONING_DOMINANCE_OUTPUT_MIN = 50000
# reasoning share in basis points (integer math, no floats): 9500 = 95%
DIAG_REASONING_DOMINANCE_BPS = 9500
DIAG_MIN_FAILED_TOOLS = 5
# failed share in basis points: 5000 = 50% (max normal concentration: 8.3%)
DIAG_FAILED_TOOL_CONCENTRATION_BPS = 5000


def diagnostics_section(identity, activity, git_wip, verification,
                        captured, observed_conversation_ids):
    """Deterministic pathological-run diagnostics (schema v4, additive).

    Returns the bounded "diagnostics" record section. Diagnostic only:
    the output is a warning surface for human review — it never drives
    termination, cancellation, budgets, or model settings.

    * "signals" — fired signals, each with the observed contract-named
      values that triggered it (integers/booleans only; sorted by name).
    * "unevaluated" — signals whose required evidence is absent, each
      with a stable reason: "missing_evidence" (a required normalized
      field is null) or "captured_conversation_unknown" (no persisted
      captured identity AND >= 2 observed conversations, so the
      conversation-attributable signal cannot be attributed to the
      captured turn). Never guessed, never silently false.
    * "detected" — true when at least one signal fired.
    """
    tok = activity.get("token_usage") or {}
    dur = identity.get("duration_s")
    api = activity.get("api_request_count")
    tools = activity.get("tool_call_count")
    tools_failed = activity.get("failed_tool_calls")
    t_out = tok.get("output")
    t_reason = tok.get("reasoning")
    chg = git_wip.get("changed_file_count")
    commit = git_wip.get("commit_created")
    has_verify = bool((verification or {}).get("profiles"))

    scope_unknown = captured is None and len(observed_conversation_ids) >= 2

    signals = []
    unevaluated = []

    def fire(name, evidence):
        signals.append({"name": name,
                        "evidence": dict(sorted(evidence.items()))})

    def uneval(name, reason):
        unevaluated.append({"name": name, "reason": reason})

    # A. long_generation_without_tool_progress: very high generation, no
    #    tool progression, long duration. "Zero tools" alone is NOT
    #    pathological (a legitimate simple answer uses no tools); all
    #    three conditions must hold together.
    if scope_unknown:
        uneval("long_generation_without_tool_progress",
               "captured_conversation_unknown")
    elif dur is None or tools is None or t_out is None:
        uneval("long_generation_without_tool_progress", "missing_evidence")
    elif (dur >= DIAG_MIN_DURATION_S and tools == 0
          and t_out >= DIAG_MIN_OUTPUT_TOKENS):
        fire("long_generation_without_tool_progress",
             {"duration_s": dur, "tool_call_count": tools,
              "output_tokens": t_out})

    # B. extreme_reasoning_dominance: reasoning tokens dominate the
    #    generated output. Codex 0.148.0 output counters include
    #    reasoning tokens, so a share of ~100% means essentially no
    #    visible output was produced. Zero denominators are safe:
    #    t_out == 0 evaluates the signal false (no generation, no
    #    dominance), t_out None is missing evidence. Not every
    #    high-reasoning turn is pathological: the floor keeps small
    #    turns out.
    if scope_unknown:
        uneval("extreme_reasoning_dominance", "captured_conversation_unknown")
    elif t_out is None or t_reason is None:
        uneval("extreme_reasoning_dominance", "missing_evidence")
    elif (t_out > 0 and t_out >= DIAG_REASONING_DOMINANCE_OUTPUT_MIN
          and t_reason * 10000 >= t_out * DIAG_REASONING_DOMINANCE_BPS):
        fire("extreme_reasoning_dominance",
             {"output_tokens": t_out, "reasoning_tokens": t_reason})

    # C. no_progress_after_long_run: long capture window AND no changed
    #    files AND no commit AND no verification evidence. Supporting
    #    evidence only: long duration alone never fires; a long
    #    research/analysis run that ends without engineering-state
    #    progress is surfaced for human review, not failed. Uses only
    #    run-level (deliberately unscoped) facts; activity.foreign is
    #    never read.
    if dur is None or chg is None or commit is None:
        uneval("no_progress_after_long_run", "missing_evidence")
    elif (dur >= DIAG_MIN_DURATION_S and chg == 0 and commit is False
          and not has_verify):
        fire("no_progress_after_long_run",
             {"changed_file_count": chg, "commit_created": commit,
              "duration_s": dur, "verification_profiles": 0})

    # D. high_failed_tool_concentration: repeated failed tools, high
    #    failure concentration. Count-based only: tool arguments are
    #    sanitized away, so identical/repeated command content is NOT
    #    claimed (see the contract's unsupportedMetrics).
    if scope_unknown:
        uneval("high_failed_tool_concentration", "captured_conversation_unknown")
    elif tools is None or tools_failed is None:
        uneval("high_failed_tool_concentration", "missing_evidence")
    elif (tools > 0 and tools_failed >= DIAG_MIN_FAILED_TOOLS
          and tools_failed * 10000
          >= tools * DIAG_FAILED_TOOL_CONCENTRATION_BPS):
        fire("high_failed_tool_concentration",
             {"failed_tool_calls": tools_failed, "tool_call_count": tools})

    # E. huge_generation_on_few_api_requests: one/few API requests, very
    #    large generation, zero tools, long duration — the specific
    #    incident signature (a single continuous generation stream).
    #    api <= 1 because the captured turn's own codex.api_request event
    #    may not survive in the raw capture (the incident's scoped count
    #    is 0 while one model response is provable from the token
    #    counters).
    if scope_unknown:
        uneval("huge_generation_on_few_api_requests",
               "captured_conversation_unknown")
    elif dur is None or api is None or tools is None or t_out is None:
        uneval("huge_generation_on_few_api_requests", "missing_evidence")
    elif (api <= 1 and tools == 0 and t_out >= DIAG_MIN_OUTPUT_TOKENS
          and dur >= DIAG_MIN_DURATION_S):
        fire("huge_generation_on_few_api_requests",
             {"api_request_count": api, "duration_s": dur,
              "output_tokens": t_out, "tool_call_count": tools})

    signals.sort(key=lambda x: x["name"])
    unevaluated.sort(key=lambda x: x["name"])
    return {"pathological_run": {
        "detected": bool(signals),
        "signals": signals,
        "unevaluated": unevaluated,
    }}


# ------------------------------------------------------------------ git/wip --

def git_wip_section(manifest):
    def has(k):
        return manifest.get(k) is not None
    changed_files = manifest.get("changed_files")
    return {
        "starting_head": manifest.get("starting_head") if isinstance(manifest.get("starting_head"), str) else None,
        "ending_head": manifest.get("ending_head") if isinstance(manifest.get("ending_head"), str) else None,
        "starting_tree": manifest.get("starting_tree") if isinstance(manifest.get("starting_tree"), str) else None,
        "ending_tree": manifest.get("ending_tree") if isinstance(manifest.get("ending_tree"), str) else None,
        "changed_file_count": as_int(manifest.get("changed_file_count")) if has("changed_file_count") else None,
        "changed_files": [p for p in changed_files if isinstance(p, str)] if isinstance(changed_files, list) else ([] if changed_files is None else []),
        "changed_files_truncated": bool(manifest.get("changed_files_truncated")),
        "lines_added": as_int(manifest.get("lines_added")) if has("lines_added") else None,
        "lines_deleted": as_int(manifest.get("lines_deleted")) if has("lines_deleted") else None,
        "commit_created": manifest.get("commit_created") if isinstance(manifest.get("commit_created"), bool) else None,
    }


def activity_section(events, run_dir, captured_conversation_id=None):
    """Activity metrics of the observed turn.

    The caller passes events already scoped to the captured conversation
    (all events when no captured identity is persisted — historical
    aggregate behavior, represented by the explicit
    captured_conversation_unknown gap instead of a silent claim).
    Token accounting honors the same scoping: metrics datapoints only
    count when attributable to the captured conversation, and the SSE
    fallback sums that conversation's response.completed counters.
    """
    tool_results = [e for e in events if e["name"] == "codex.tool_result"]
    api_requests = [e for e in events if e["name"] == "codex.api_request"]
    prompts = [e for e in events if e["name"] == "codex.user_prompt"]
    starts = [e for e in events if e["name"] == "codex.conversation_starts"]
    sse = [e for e in events if e["name"] == "codex.sse_event"]

    def tool_type(ev):
        tool = ev["attrs"].get("tool_name")
        if not isinstance(tool, str) or not tool:
            return None
        return TOOL_TYPE_MAP.get(tool, "other")

    call_ids = set()
    for ev in tool_results:
        call_ids.add(ev["ref"] or ("__noref_%d__" % id(ev)))
    by_type = {}
    successful = 0
    failed = 0
    shell_total = 0
    shell_failed = 0
    file_activity = 0
    for ev in tool_results:
        ttype = tool_type(ev)
        if ttype is not None:
            by_type[ttype] = by_type.get(ttype, 0) + 1
            if ttype == "shell":
                shell_total += 1
            if ttype == "file":
                file_activity += 1
        ok = as_bool(ev["attrs"].get("success"))
        if ok is True:
            successful += 1
        elif ok is False:
            failed += 1
            if ttype == "shell":
                shell_failed += 1

    api_failed = sum(1 for ev in api_requests if _api_request_failed(ev))

    # token usage: metrics signal first, sse event counters as documented
    # fallback, else unavailable.
    token = {"input": None, "output": None, "cached": None,
             "cache_write": None, "reasoning": None, "total": None,
             "source": None}
    metrics_total, metrics_found = token_usage_from_metrics(
        run_dir, conv=captured_conversation_id)
    if metrics_found:
        token["total"] = metrics_total
        token["source"] = "metrics"
    else:
        sse_sums = sse_token_sums(sse)
        if sse_sums:
            for key, field in TOKEN_FIELD_MAP.items():
                token[field] = sse_sums.get(key)
            token["total"] = sum(sse_sums.values())
            token["source"] = "sse-events"

    def min_ts(evs):
        ts = [e["ts"] for e in evs if e["ts"] is not None]
        return min(ts) if ts else None

    def max_ts(evs):
        ts = [e["ts"] for e in evs if e["ts"] is not None]
        return max(ts) if ts else None

    base_ts = min_ts(prompts) or min_ts(starts)
    first_tool_ts = min_ts(tool_results)
    completed = [e for e in sse
                 if e["attrs"].get("event.kind") == "response.completed"]
    final_ts = max_ts(completed) or max_ts(api_requests)

    def ms(delta_from, to_ts):
        if delta_from is None or to_ts is None:
            return None
        return int((to_ts - delta_from).total_seconds() * 1000)

    failures_ts = []
    for ev in tool_results:
        if as_bool(ev["attrs"].get("success")) is False and ev["ts"]:
            failures_ts.append(ev["ts"])
    for ev in api_requests:
        if ev["ts"] and _api_request_failed(ev):
            failures_ts.append(ev["ts"])

    return {
        "tool_call_count": len(call_ids) if tool_results else (0 if events else None),
        "tool_calls_by_type": dict(sorted(by_type.items())),
        "successful_tool_calls": successful if tool_results else (0 if events else None),
        "failed_tool_calls": failed if tool_results else (0 if events else None),
        "shell_command_count": shell_total if tool_results else (0 if events else None),
        "failed_shell_commands": shell_failed if tool_results else (0 if events else None),
        "file_activity_count": file_activity if tool_results else (0 if events else None),
        "api_request_count": len(api_requests) if events else None,
        "failed_api_requests": api_failed if events else None,
        "token_usage": token,
        "turn_count": len(prompts) if events else None,
        "time_to_first_tool_action_ms": ms(base_ts, first_tool_ts),
        "time_to_first_failure_ms": ms(base_ts, min(failures_ts) if failures_ts else None),
        "time_to_final_response_ms": ms(base_ts, final_ts),
    }


def foreign_section(captured, observed_ids, events, run_dir):
    """Bounded diagnostic for FOREIGN telemetry in the same raw run.

    The single-endpoint capture can contain OTLP from other Codex
    conversations that happened to be active in the same window. The
    primary activity above is scoped to the captured conversation; this
    section makes the contamination explicit instead of silently merging
    or discarding it. It is a compact aggregate (identities + a handful
    of counts), not a full secondary ledger per foreign conversation.

    Returns None when no captured identity is persisted: 'foreign' is
    undefined without a captured reference, and the explicit
    captured_conversation_unknown gap represents that case instead.
    """
    if captured is None:
        return None
    foreign_ids = sorted({c for c in observed_ids if c != captured})
    section = {
        "present": bool(foreign_ids),
        "conversation_count": len(foreign_ids),
        "conversation_ids": foreign_ids,
        "api_request_count": 0,
        "failed_api_requests": 0,
        "tool_call_count": 0,
        "failed_tool_calls": 0,
        "turn_count": 0,
        "token_usage_total": None,
    }
    if not foreign_ids:
        return section
    fset = set(foreign_ids)
    fev = [e for e in events if e.get("conv") in fset]
    api = [e for e in fev if e["name"] == "codex.api_request"]
    tools = [e for e in fev if e["name"] == "codex.tool_result"]
    call_ids = {e["ref"] or ("__noref_%d__" % id(e)) for e in tools}
    section["api_request_count"] = len(api)
    section["failed_api_requests"] = sum(1 for e in api
                                         if _api_request_failed(e))
    section["tool_call_count"] = len(call_ids)
    section["failed_tool_calls"] = sum(
        1 for e in tools if as_bool(e["attrs"].get("success")) is False)
    section["turn_count"] = sum(1 for e in fev
                                if e["name"] == "codex.user_prompt")
    mtotal, mfound = token_usage_from_metrics(run_dir, conv_set=fset)
    if mfound:
        section["token_usage_total"] = mtotal
    else:
        ssums = sse_token_sums([e for e in fev
                                if e["name"] == "codex.sse_event"])
        section["token_usage_total"] = sum(ssums.values()) if ssums else None
    return section


def failures_section(events, profiles):
    failures = []
    for ev in events:
        if ev["name"] == "codex.tool_result" and as_bool(ev["attrs"].get("success")) is False:
            tool = ev["attrs"].get("tool_name")
            failures.append({
                "kind": "tool_call",
                "identifier": tool if isinstance(tool, str) and tool else "unknown_tool",
                "ref": ev["ref"] or None,
                "timestamp": ev["ts_iso"],
                "result": "success=false",
            })
        elif ev["name"] == "codex.api_request":
            ok = as_bool(ev["attrs"].get("success"))
            status = as_int(ev["attrs"].get("http.response.status_code"))
            if ok is False or (status is not None and status >= 400):
                failures.append({
                    "kind": "api_request",
                    "identifier": "model_api_request",
                    "ref": ev["ref"] or None,
                    "timestamp": ev["ts_iso"],
                    "result": ("http_status=%d" % status) if status is not None
                               else "success=false",
                })
    for prof in profiles or []:
        for ph in prof.get("phases") or []:
            if ph.get("outcome") == "failed":
                failures.append({
                    "kind": "verification_phase",
                    "identifier": ph.get("name") or "unknown_phase",
                    "ref": prof.get("profile"),
                    "timestamp": prof.get("finished_at"),
                    "result": ("exit_code=%s" % ph["exit_code"])
                               if ph.get("exit_code") is not None else "failed",
                })
    for f in failures:
        f["classification"] = None  # explicit annotation only, never inferred
    failures.sort(key=lambda f: (f.get("timestamp") or "~", f.get("kind") or "",
                                 f.get("identifier") or "", f.get("ref") or ""))
    return failures


def attach_classifications(failures, annotations):
    """Attach explicitly annotated classifications (deterministic: the
    earliest annotation matching ref, then identifier, wins)."""
    for ann in sorted((a for a in annotations if a.get("classification")
                       and a.get("applies_to")),
                      key=lambda a: a.get("ts") or ""):
        target = ann["applies_to"]
        match = None
        for f in failures:
            if f["classification"] is None and f.get("ref") == target:
                match = f
                break
        if match is None:
            for f in failures:
                if f["classification"] is None and f.get("identifier") == target:
                    match = f
                    break
        if match is not None:
            match["classification"] = ann["classification"]


def human_section(annotations):
    if not annotations:
        return {"correction_occurred": None, "categories": [], "annotations": []}
    corrections = [a.get("correction") for a in annotations]
    if "yes" in corrections:
        occurred = "yes"
    elif "no" in corrections:
        occurred = "no"
    else:
        occurred = None
    categories = sorted({a.get("category") for a in annotations
                         if isinstance(a.get("category"), str)})
    return {
        "correction_occurred": occurred,
        "categories": categories,
        "annotations": [
            {
                "ts": a.get("ts"),
                "correction": a.get("correction"),
                "category": a.get("category"),
                "note": a.get("note"),
                "classification": a.get("classification"),
                "applies_to": a.get("applies_to"),
            }
            for a in annotations
        ],
    }


# ---------------------------------------------------------------- normalize --

def load_manifest(run_dir, run_id):
    path = os.path.join(run_dir, "capture-manifest.json")
    manifest = load_json(path)
    if not isinstance(manifest, dict):
        die("required capture manifest missing or malformed: %s" % path, 7)
    if not isinstance(manifest.get("run_id"), str) or not manifest["run_id"]:
        die("capture manifest is malformed (missing run_id): %s" % path, 7)
    if manifest["run_id"] != run_id:
        die("capture manifest run_id %r does not match run directory %r"
            % (manifest["run_id"], run_id), 7)
    return manifest


def list_gaps(manifest, events, profiles, doctor, obs_doctor, annotations,
              token, has_run_context, codex_version=None,
              captured_conversation_id=None, observed_conversation_ids=()):
    gaps = []
    if not any(e["name"].startswith("codex.") for e in events):
        gaps.append("no_telemetry")
    if captured_conversation_id is None and observed_conversation_ids:
        # Telemetry from at least one conversation is present, but the run
        # carries no persisted captured conversation identity: the primary
        # metrics are the run-wide aggregate and MUST NOT be read as the
        # captured turn's activity. Nothing is guessed.
        gaps.append("captured_conversation_unknown")
    if codex_version is None:
        gaps.append("codex_version_unresolved")
    if not has_run_context:
        gaps.append("no_run_context")
    if not raw_jsonl_files(os.environ.get("LEDGER_RUN_DIR", ""), "metrics"):
        gaps.append("no_metrics_file")
    if token["source"] is None:
        gaps.append("token_usage_unavailable")
    if manifest.get("ending_head") in (None, ""):
        gaps.append("no_end_git_evidence")
    if not profiles:
        gaps.append("no_verification_evidence")
    if doctor is None and obs_doctor is None:
        gaps.append("no_doctor_evidence")
    if not annotations:
        gaps.append("no_annotations")
    return sorted(gaps)


def product_codex_version(app_versions):
    """The Codex version that actually executed the captured turn.

    The Codex process emits its own version as the ``app.version``
    attribute in the captured OTel records (the values that form
    ``runtime.app_versions``), so exactly one distinct non-empty value is
    the authoritative product version for the run. Zero or several
    distinct values leave the version unresolved (None): the
    controller/standalone ``codex`` on PATH and any capture-time
    (manifest) discovery are never substituted for it.
    """
    distinct = sorted({v for v in app_versions if isinstance(v, str) and v})
    return distinct[0] if len(distinct) == 1 else None


def build_record(run_dir):
    run_id = os.path.basename(os.path.abspath(run_dir))
    manifest = load_manifest(run_dir, run_id)

    events = collect_events(run_dir)
    profiles, doctor, obs_doctor = verification_evidence(run_dir, run_id)
    annotations = load_annotations(run_dir)
    run_context = load_run_context(run_dir)

    # The persisted captured conversation identity (the ACP session/prompt
    # that caused this run, recorded into the manifest by the lifecycle
    # relay at start). Nothing is inferred: a missing/invalid value means
    # the run carries no captured identity (historical or manual run).
    captured_raw = manifest.get("captured_conversation_id")
    captured = captured_raw if isinstance(captured_raw, str) and captured_raw else None
    start_ts = manifest.get("start_ts") if isinstance(manifest.get("start_ts"), str) else None
    end_ts = manifest.get("end_ts") if isinstance(manifest.get("end_ts"), str) else None
    duration = None
    s, e = as_ts(start_ts), as_ts(end_ts)
    if s is not None and e is not None:
        duration = int((e - s).total_seconds())

    def slist(key):
        val = manifest.get(key)
        if isinstance(val, list):
            return [v for v in val if isinstance(v, str)]
        return []

    observed_ids = slist("conversation_ids")
    # Primary activity attribution: when the run carries a persisted
    # captured conversation identity, the captured turn's metrics come
    # from that conversation's events only. Without it (historical or
    # manual run) the run-wide aggregate is preserved (backward
    # compatible) and represented explicitly by the
    # captured_conversation_unknown gap — never a heuristic pick.
    if captured is None:
        scoped_events = events
    else:
        scoped_events = [e for e in events if e.get("conv") == captured]
    git_wip = git_wip_section(manifest)
    activity = activity_section(scoped_events, run_dir, captured)
    failures = failures_section(scoped_events, profiles)
    attach_classifications(failures, annotations)
    conv_cfg = conversation_config(scoped_events)

    identity = {
        "conversation_ids": observed_ids,
        "captured_conversation_id": captured,
        "capture_kind": manifest.get("kind") if isinstance(manifest.get("kind"), str) else None,
        "repo_root": manifest.get("repo_root") if isinstance(manifest.get("repo_root"), str) else None,
        "branch": manifest.get("branch") if isinstance(manifest.get("branch"), str) else None,
        "starting_head": manifest.get("starting_head") if isinstance(manifest.get("starting_head"), str) else None,
        "ending_head": manifest.get("ending_head") if isinstance(manifest.get("ending_head"), str) else None,
        "start_ts": start_ts,
        "end_ts": end_ts,
        "duration_s": duration,
        "stop_status": manifest.get("stop_status") if isinstance(manifest.get("stop_status"), str) else None,
    }
    # Product Codex version attribution: derived exclusively from the
    # telemetry app.version values the Codex process itself emitted (the
    # values forming app_versions). Exactly one distinct value is
    # authoritative; zero or several leave the version unresolved. The
    # controller/standalone codex on PATH (the old capture-manifest
    # "codex_version" seed) is never substituted for it.
    app_versions = slist("app_versions")
    codex_version = product_codex_version(app_versions)

    runtime = {
        "codex_version": codex_version,
        "codex_acp_version": manifest.get("codex_acp_version") if isinstance(manifest.get("codex_acp_version"), str) else None,
        "models": slist("models"),
        "collector_version": manifest.get("collector_version") if isinstance(manifest.get("collector_version"), str) else None,
        "originators": slist("originators"),
        "privacy_mode": manifest.get("privacy_mode") if isinstance(manifest.get("privacy_mode"), str) else None,
        "app_versions": app_versions,
        # Native run-level configuration (codex.conversation_starts, first
        # event). Absent on 0.148.0 events or on historical captures ->
        # null + explicit comparability gap, never inferred.
        "reasoning_effort": conv_cfg["reasoning_effort"],
        "sandbox_mode": conv_cfg["sandbox_mode"],
        "approval_policy": conv_cfg["approval_policy"],
    }
    activity["foreign"] = foreign_section(captured, observed_ids, events, run_dir)
    ctx = empty_context()
    if run_context is not None:
        for f in ("task_type", "session_mode", "task_key", "harness_variant"):
            v = run_context.get(f)
            ctx[f] = v if isinstance(v, str) else None

    record = {
        "schema_version": LEDGER_SCHEMA_VERSION,
        "record_name": RECORD_NAME,
        "run_id": run_id,
        "identity": identity,
        "runtime": runtime,
        "context": ctx,
        "git_wip": git_wip,
        "activity": activity,
        "verification": {
            "doctor": doctor,
            "observability_doctor": obs_doctor,
            "profiles": profiles or [],
            "final_gate": final_gate(profiles or []),
        },
        "failures": failures,
        "human": human_section(annotations),
        "comparability": comparability_section(identity, runtime, ctx,
                                               profiles, doctor, obs_doctor),
        "diagnostics": diagnostics_section(
            identity, activity, git_wip,
            {"profiles": profiles or []},
            captured, observed_ids),
        "evidence_gaps": list_gaps(manifest, events, profiles or [], doctor,
                                   obs_doctor, annotations,
                                   activity["token_usage"],
                                   run_context is not None,
                                   codex_version,
                                   captured, observed_ids),
    }
    return record


def load_annotations(run_dir):
    data = load_json(os.path.join(run_dir, ANNOTATIONS_FILE))
    if not isinstance(data, dict):
        return []
    anns = data.get("annotations")
    if not isinstance(anns, list):
        return []
    return [a for a in anns if isinstance(a, dict)]


def cmd_normalize(argv):
    if len(argv) != 1:
        die("usage: ledger.py normalize <run_dir>")
    run_dir = argv[0]
    if not os.path.isdir(run_dir):
        die("run directory not found: %s" % run_dir, 6)
    os.environ["LEDGER_RUN_DIR"] = run_dir
    record = build_record(run_dir)
    atomic_write(os.path.join(run_dir, LEDGER_FILE), record)
    return 0


def cmd_show(argv):
    as_json = False
    paths = []
    for a in argv:
        if a == "--json":
            as_json = True
        else:
            paths.append(a)
    if len(paths) != 1:
        die("usage: ledger.py show <run_dir> [--json]")
    run_dir = paths[0]
    if not os.path.isdir(run_dir):
        die("run directory not found: %s" % run_dir, 6)
    os.environ["LEDGER_RUN_DIR"] = run_dir
    record = build_record(run_dir)
    atomic_write(os.path.join(run_dir, LEDGER_FILE), record)
    if as_json:
        print(json.dumps(record, indent=2, sort_keys=True))
    else:
        print_human(record)
    return 0


def print_human(r):
    ident = r["identity"]
    rt = r["runtime"]
    g = r["git_wip"]
    a = r["activity"]
    v = r["verification"]
    h = r["human"]
    tok = a["token_usage"]

    def hms(m):
        if m is None:
            return "n/a"
        return "%+.1fs" % (m / 1000.0)

    def head(s):
        return s[:12] if isinstance(s, str) and s else "n/a"
    def na(v):
        return v if v is not None else "n/a"

    print("run ledger: %s (schema v%s)" % (r["run_id"], r["schema_version"]))
    print("  capture:    kind=%s stop=%s conversations=%s" % (
        ident["capture_kind"], ident["stop_status"], len(ident["conversation_ids"])))
    ccid = ident.get("captured_conversation_id")
    if ccid:
        print("  captured:   conversation=%s" % ccid)
    else:
        print("  captured:   conversation=unknown (no persisted identity — "
              "activity is the run-wide aggregate, see evidence_gaps)")
    foreign = a.get("foreign")
    if foreign is not None and foreign.get("present"):
        print("  foreign:    %d other conversation(s) in this raw run: %s "
              "(api=%s tools=%s) — NOT part of the captured turn metrics"
              % (foreign["conversation_count"],
                 ", ".join(foreign["conversation_ids"]) or "-",
                 foreign["api_request_count"], foreign["tool_call_count"]))
    print("  window:     %s -> %s (duration %s)" % (
        ident["start_ts"], ident["end_ts"],
        "%ss" % ident["duration_s"] if ident["duration_s"] is not None else "n/a"))
    print("  repo:       %s @ %s -> %s (commit created: %s)" % (
        ident["branch"], head(ident["starting_head"]), head(ident["ending_head"]),
        g["commit_created"] if g["commit_created"] is not None else "n/a"))
    print("  tree:       start=%s end=%s changed=%s files (+%s/-%s lines)" % (
        na(g["starting_tree"]), na(g["ending_tree"]),
        na(g["changed_file_count"]), na(g["lines_added"]), na(g["lines_deleted"])))
    print("  runtime:    codex=%s codex-acp=%s collector=%s" % (
        na(rt["codex_version"]), na(rt["codex_acp_version"]),
        na(rt["collector_version"])))
    print("  run config: effort=%s sandbox=%s approval=%s" % (
        rt.get("reasoning_effort") or "n/a",
        rt.get("sandbox_mode") or "n/a",
        rt.get("approval_policy") or "n/a"))
    print("  model(s):   %s" % (", ".join(rt["models"]) or "n/a"))
    print("  activity:   turns=%s tools=%s api_requests=%s" % (
        a["turn_count"], a["tool_call_count"], a["api_request_count"]))
    if a["tool_calls_by_type"]:
        print("  tool types: %s" % " ".join("%s=%d" % (k, c)
                                           for k, c in a["tool_calls_by_type"].items()))
    print("  tools:      ok=%s failed=%s (shell failed=%s, file activity=%s)" % (
        a["successful_tool_calls"], a["failed_tool_calls"],
        a["failed_shell_commands"], a["file_activity_count"]))
    print("  api:        failed=%s" % a["failed_api_requests"])
    print("  tokens:     in=%s out=%s cached=%s cache_write=%s reasoning=%s total=%s (source: %s)" % (
        tok["input"], tok["output"], tok["cached"], tok["cache_write"],
        tok["reasoning"], tok["total"], tok["source"] or "n/a"))
    print("  timing:     first tool %s | first failure %s | final response %s" % (
        hms(a["time_to_first_tool_action_ms"]), hms(a["time_to_first_failure_ms"]),
        hms(a["time_to_final_response_ms"])))
    if r["failures"]:
        print("  failures:   %d" % len(r["failures"]))
        for f in r["failures"][:10]:
            cls = (" [%s]" % f["classification"]) if f["classification"] else ""
            print("    - %s %s @ %s result=%s%s" % (
                f["kind"], f["identifier"], f["timestamp"] or "n/a", f["result"], cls))
    else:
        print("  failures:   none recorded")
    if v["profiles"]:
        for p in v["profiles"]:
            print("  verify:     profile=%s result=%s exit=%s (source: %s)" % (
                p["profile"], p["result"], p["exit_code"], p["source"]))
        fg = v["final_gate"]
        print("  final gate: %s=%s" % (fg["profile"], fg["result"]) if fg else
              "  final gate: n/a")
    else:
        print("  verify:     no verification evidence in run directory")
    if v["doctor"]:
        print("  doctor:     %s (%s)" % (v["doctor"]["status"], v["doctor"]["source"]))
    elif v["observability_doctor"]:
        print("  doctor:     observability=%s" % v["observability_doctor"]["status"])
    else:
        print("  doctor:     no doctor evidence in run directory")
    print("  human:      correction=%s categories=%s" % (
        h["correction_occurred"] or "unknown",
        ", ".join(h["categories"]) or "-"))
    c = r.get("context") or {}
    print("  context:    type=%s session=%s task_key=%s harness=%s" % (
        c.get("task_type") or "n/a", c.get("session_mode") or "n/a",
        c.get("task_key") or "n/a", c.get("harness_variant") or "n/a"))
    comp = r.get("comparability") or {}
    miss = comp.get("missing") or []
    print("  comparable: %s" % ("all dimensions evidenced" if not miss
                                else "missing: " + ", ".join(miss)))
    diag = ((r.get("diagnostics") or {}).get("pathological_run")) or {}
    if diag.get("detected"):
        # warning surface only: diagnostic, never an intervention
        print("  diagnostic: PATHOLOGICAL RUN (warning; diagnostic only, "
              "no action taken)")
        print("    signals:    %s" % ", ".join(
            x["name"] for x in diag.get("signals") or []))
        unev = diag.get("unevaluated") or []
        if unev:
            print("    unevaluated: %s" % ", ".join(
                "%s (%s)" % (x["name"], x["reason"]) for x in unev))
    else:
        print("  diagnostic: no pathological-run signals")
    print("  missing:    %s" % (", ".join(r["evidence_gaps"]) or "none"))


# ----------------------------------------------------------------- annotate --

def cmd_annotate(argv):
    # annotate <run_dir> --correction yes|no [--category C] [--note S]
    #           [--classification K] [--for-failure REF]
    paths = []
    opts = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--correction", "--category", "--note", "--classification",
                 "--for-failure"):
            if i + 1 >= len(argv):
                die("%s requires a value" % a)
            opts[a] = argv[i + 1]
            i += 2
        else:
            paths.append(a)
            i += 1
    if len(paths) != 1 or "--correction" not in opts:
        die("usage: ledger.py annotate <run_dir> --correction yes|no "
            "[--category C] [--note S] [--classification K] [--for-failure REF]")
    run_dir = paths[0]
    if not os.path.isdir(run_dir):
        die("run directory not found: %s" % run_dir, 6)
    correction = opts["--correction"]
    if correction not in ("yes", "no"):
        die("--correction must be yes or no")
    category = opts.get("--category")
    if category is not None and category not in ANNOTATION_CATEGORIES:
        die("--category must be one of: %s" % ", ".join(ANNOTATION_CATEGORIES))
    if correction == "yes" and category is None:
        die("--category is required when --correction is yes "
            "(one of: %s)" % ", ".join(ANNOTATION_CATEGORIES))
    note = opts.get("--note")
    if note is not None and len(note) > NOTE_MAX_LEN:
        die("--note exceeds the %d character bound" % NOTE_MAX_LEN)
    classification = opts.get("--classification")
    if classification is not None and classification not in FAILURE_CLASSIFICATIONS:
        die("--classification must be one of: %s" % ", ".join(FAILURE_CLASSIFICATIONS))
    applies_to = opts.get("--for-failure")
    if classification is not None and not applies_to:
        die("--classification requires --for-failure <identifier-or-ref>")
    if applies_to is not None and len(applies_to) > REF_MAX_LEN:
        die("--for-failure exceeds the %d character bound" % REF_MAX_LEN)

    path = os.path.join(run_dir, ANNOTATIONS_FILE)
    data = load_json(path)
    if data is None:
        data = {"schema_version": ANNOTATIONS_SCHEMA_VERSION,
                "run_id": os.path.basename(os.path.abspath(run_dir)),
                "annotations": []}
    if not isinstance(data.get("annotations"), list):
        die("annotations file is malformed: %s" % path, 7)
    data["annotations"].append({
        "ts": now_iso(),
        "correction": correction,
        "category": category,
        "note": (note[:NOTE_MAX_LEN] if note is not None else None),
        "classification": classification,
        "applies_to": applies_to,
    })
    atomic_write(path, data)
    print("annotated %s (%d annotation(s) total)"
          % (path, len(data["annotations"])))
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, argv = sys.argv[1], sys.argv[2:]
    if cmd == "normalize":
        return cmd_normalize(argv)
    if cmd == "show":
        return cmd_show(argv)
    if cmd == "annotate":
        return cmd_annotate(argv)
    print("unknown subcommand: " + cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
