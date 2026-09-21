#!/usr/bin/env python3
"""
FG Workspace — live pathological-generation shadow warning.

Diagnostic-only live detection of the pathological generation shape
established by the forensic replay of run-20260921T111009Z (captured
conversation 01a0c3a6-dd79-7652-bb05-ecb528dd8c5d): a captured prompt
turn whose open response segment has been generating for >= 1800 s
with zero tool progress and no visible (non-reasoning) output.

This module is the predicate + the incremental raw-telemetry reader.
The ACP lifecycle relay (acp-lifecycle-relay.py) is the HOST: it owns
the turn lifecycle and calls ShadowWarningTracker.maybe_evaluate()
from its existing pump loop. There is no new daemon, and nothing in
this module can delay, modify, cancel, or otherwise touch the ACP
stream, the model, or the collector — the output is at most ONE
bounded identifier/evidence-only relay event per captured turn.

Contract (canonical: docs/agent/OBSERVABILITY.md, "Live
pathological-generation shadow warning"):

  * threshold: open-segment elapsed >= 1800 s (relay timing — the
    monotonic turn-start / segment-start; never SSE count, file mtime,
    or token counts; authoritative token counters do not exist during
    streaming, so no token thresholds are used);
  * cadence: at most one evaluation every 60 s per captured turn (the
    raw telemetry is NEVER inspected on the 200 ms pump cadence);
  * scope: ONLY records whose conversation.id equals the captured
    conversation (the ACP session id); foreign telemetry in the same
    run has no effect (run-wide metrics would be masked by a
    tool-heavy foreign conversation — the incident had one);
  * zero codex.tool_result records so far for this captured turn;
  * all observed generation events in the current open segment are
    response.reasoning_text.delta (a response.output_text.delta or
    response.function_call_arguments.delta in the open segment clears
    all_reasoning; unrelated lifecycle/control SSE kinds are NOT
    user-visible generation and do not clear it);
  * codex.api_request count so far <= 1;
  * the current response segment is still open (it closes at
    response.completed; a new segment begins with the next non-close
    SSE record after that);
  * ONE-SHOT: maximum one shadow warning per captured turn; no
    re-arm after later segments (first version).

Reader contract (raw files under <run_dir>/raw/):

  * only logs.jsonl (active) plus the collector's rotated log files
    (logs-<ts>-size.jsonl / logs-<ts>-age.jsonl — the otelcol
    file-exporter rotation renames the active file and starts a fresh
    one, so the active file is always the newest) are read;
  * consumption is byte-offset based per file IDENTITY (st_dev,
    st_ino), not per file name: a rotated file keeps its consumed
    offset across the rename (never double-counted), a fresh active
    file starts at 0, and a deleted rotated backup contributes
    nothing (its records were already consumed);
  * only complete JSONL records are consumed; an incomplete trailing
    line stays unconsumed until its newline arrives;
  * bounded memory: one read buffer per file per evaluation;
  * read/parsing failures degrade to "turn continues normally" (fail
    open) with at most one bounded error diagnostic per error state
    (a successful evaluation clears the state).

Privacy: the module reads sanitized raw telemetry (the collector's
transform has already dropped prompt/tool content) and persists
nothing itself; the relay emits only the bounded warning fields
(session id, run id, elapsed_s, sse_events, api) and a bounded error
class name. It never persists or returns prompt content, reasoning
content, output text, tool arguments/results, or raw SSE payloads.
"""

import json
import os
import re
import sys
import time
from datetime import datetime

# Calibrated on the stored incident evidence (see the module docstring
# and docs/agent/OBSERVABILITY.md): initial conservative heuristic, not
# a statistically established limit. No 600 s / 900 s tiers.
SHADOW_WARNING_THRESHOLD_S = 1800.0
# Bounded evaluation cadence per captured turn.
SHADOW_EVAL_INTERVAL_S = 60.0
# Per-file read bound per evaluation (bytes); the rest is consumed on
# the next evaluation. Bounded memory by construction.
MAX_READ_BYTES = 64 * 1024 * 1024

# Event names / kinds from the trace contract
# (docs/agent/trace-contract.json): the only telemetry this predicate
# reads. Generation kinds are the user-visible delta kinds; everything
# else in the SSE stream (response.created, response.in_progress,
# content-part / output-item / reasoning-part lifecycle, *.done,
# response.completed) is lifecycle/control, not generation.
SSE_EVENT = "codex.sse_event"
TOOL_RESULT_EVENT = "codex.tool_result"
API_REQUEST_EVENT = "codex.api_request"
SEGMENT_CLOSE_KIND = "response.completed"
REASONING_GENERATION_KIND = "response.reasoning_text.delta"
NON_REASONING_GENERATION_KINDS = frozenset((
    "response.output_text.delta",
    "response.function_call_arguments.delta",
))


# ------------------------------------------------------- record shapes --

def record_attributes(record):
    """Flatten one OTLP log record's attribute list into {key: value}.

    Bounded: only string/int/double/bool values are retained; missing
    or malformed shapes yield {} (never an exception).
    """
    out = {}
    attrs = record.get("attributes")
    if not isinstance(attrs, list):
        return out
    for a in attrs:
        if not isinstance(a, dict):
            continue
        key = a.get("key")
        if not isinstance(key, str) or not key:
            continue
        value = a.get("value")
        if not isinstance(value, dict):
            continue
        for kind in ("stringValue", "intValue", "doubleValue", "boolValue"):
            if kind in value:
                out[key] = value[kind]
                break
    return out


def iter_log_records(payload):
    """Yield the log records of one parsed OTLP/JSON payload line."""
    if not isinstance(payload, dict):
        return
    resource_logs = payload.get("resourceLogs")
    if not isinstance(resource_logs, list):
        return
    for rl in resource_logs:
        if not isinstance(rl, dict):
            continue
        scope_logs = rl.get("scopeLogs")
        if not isinstance(scope_logs, list):
            continue
        for sl in scope_logs:
            if not isinstance(sl, dict):
                continue
            records = sl.get("logRecords")
            if not isinstance(records, list):
                continue
            for lr in records:
                if isinstance(lr, dict):
                    yield lr


def make_payload(*records):
    """Build one OTLP/JSON ResourceLogs payload line (test/replay helper)."""
    return {"resourceLogs": [{"scopeLogs": [{"logRecords": list(records)}]}]}


def make_record(conversation_id, event_name, event_kind=None,
                timestamp=None):
    """Build one sanitized-shape log record (test/replay helper)."""
    attrs = [
        {"key": "event.name",
         "value": {"stringValue": event_name}},
        {"key": "conversation.id",
         "value": {"stringValue": conversation_id}},
    ]
    if event_kind is not None:
        attrs.append({"key": "event.kind",
                      "value": {"stringValue": event_kind}})
    if timestamp is not None:
        attrs.append({"key": "event.timestamp",
                      "value": {"stringValue": timestamp}})
    return {"attributes": attrs}


# ------------------------------------------------------ predicate state --

class PathologyPredicate:
    """Per-turn state machine for the live shadow-warning predicate.

    Source-agnostic: callers feed sanitized log-record attribute dicts
    in emission order, each tagged with the relay's monotonic ``now``.
    It tracks bounded counters/booleans only — never record content.

    Segment semantics: a response segment begins at the turn start, or
    with the first non-close SSE record after a prior
    response.completed (which closes the open segment).
    """

    def __init__(self, conversation_id, turn_start=0.0):
        self.conversation_id = conversation_id
        self.turn_start = turn_start
        # Segment state (reset when a new segment opens):
        self.segment_open = True
        self.segment_start = turn_start
        self.segment_sse_events = 0
        self.segment_all_reasoning = True
        # Turn-scoped progress (never reset: a tool result or API
        # request anywhere in the turn is turn progress):
        self.turn_tool_results = 0
        self.turn_api_requests = 0
        # One-shot: once a warning fires for this turn, never again.
        self.warning_emitted = False

    def observe(self, attributes, now):
        """Consume one sanitized log record (no return value)."""
        if attributes.get("conversation.id") != self.conversation_id:
            return
        name = attributes.get("event.name")
        if name == TOOL_RESULT_EVENT:
            self.turn_tool_results += 1
            return
        if name == API_REQUEST_EVENT:
            self.turn_api_requests += 1
            return
        if name != SSE_EVENT:
            return
        kind = attributes.get("event.kind")
        if self.segment_open:
            self.segment_sse_events += 1
            if kind == SEGMENT_CLOSE_KIND:
                self.segment_open = False
            elif kind in NON_REASONING_GENERATION_KINDS:
                self.segment_all_reasoning = False
        else:
            if kind == SEGMENT_CLOSE_KIND:
                return  # a stray/duplicate close: no open segment
            # A new segment begins with this record.
            self.segment_open = True
            self.segment_start = now
            self.segment_sse_events = 1
            self.segment_all_reasoning = \
                kind not in NON_REASONING_GENERATION_KINDS

    def evaluate(self, now):
        """One predicate check. Returns the warning dict (fields
        elapsed_s / sse_events / api) iff the full predicate holds;
        the first fire sets warning_emitted and later calls return
        None for the life of the turn."""
        if self.warning_emitted or not self.segment_open:
            return None
        elapsed = now - self.segment_start
        if elapsed < SHADOW_WARNING_THRESHOLD_S:
            return None
        if self.turn_tool_results != 0:
            return None
        if not self.segment_all_reasoning:
            return None
        if self.turn_api_requests > 1:
            return None
        self.warning_emitted = True
        return {"elapsed_s": int(elapsed),
                "sse_events": self.segment_sse_events,
                "api": self.turn_api_requests}


# ------------------------------------------------------- raw log reader --

def ordered_log_files(raw_dir):
    """Return the raw log files in chronological order (oldest first),
    or None when the directory cannot be listed.

    The otelcol file exporter's rotation renames the ACTIVE file to
    logs-<ts>-size.jsonl / logs-<ts>-age.jsonl (fixed-width zero-padded
    timestamps, so lexicographic order == chronological order) and
    creates a fresh active logs.jsonl — the active file is therefore
    always the newest and is ordered LAST.
    """
    try:
        names = os.listdir(raw_dir)
    except OSError:
        return None
    rotated = []
    active = None
    for name in names:
        if name == "logs.jsonl":
            active = name
            continue
        if _ROTATED_LOG_RE.match(name):
            # The timestamp is embedded in the name (fixed width): sort
            # on (embedded timestamp, name) — not on the name alone.
            rotated.append((_ROTATED_LOG_RE.match(name).group(1), name))
    rotated.sort()
    files = [name for _, name in rotated]
    if active is not None:
        files.append(active)
    return files


_ROTATED_LOG_RE = re.compile(
    r"^logs-([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}"
    r"\.[0-9]{3})-(size|age)\.jsonl$")


class RawLogReader:
    """Incremental reader over a capture run's raw LOG files.

    Reads only <raw_dir>/logs.jsonl (active) and the rotated
    logs-<ts>-{size,age}.jsonl files. Consumption is byte-offset based
    per file IDENTITY (st_dev, st_ino) — not per file name — so a
    rotated file keeps its consumed offset across the rename (no
    double counting), a fresh active file starts at 0, and a truncated
    in-place file (e.g. the collector restart re-creates the active
    file) restarts at 0 (its old content is gone; the relay reports
    one bounded diagnostic for the anomaly). Only complete JSONL
    records are consumed; an incomplete trailing line stays
    unconsumed until its newline arrives. Memory is bounded (one read
    buffer per file per evaluation, capped at MAX_READ_BYTES).
    """

    def __init__(self, raw_dir):
        self.raw_dir = raw_dir
        self._offsets = {}  # (st_dev, st_ino) -> consumed byte offset

    def read_new_lines(self):
        """Consume newly appended bytes.

        Returns (lines, error): lines is a list of complete JSONL
        lines (bytes, newline stripped, empty lines dropped), oldest
        file first; error is None or a bounded error class name.
        """
        files = ordered_log_files(self.raw_dir)
        if files is None:
            return [], "OSError"
        lines = []
        error = None
        for name in files:
            path = os.path.join(self.raw_dir, name)
            try:
                st = os.stat(path)
                identity = (st.st_dev, st.st_ino)
                offset = self._offsets.get(identity, 0)
                size = st.st_size
                if size < offset:
                    # Truncated / re-created in place: the old content
                    # is gone, so restart from 0.
                    offset = 0
                    error = "OSError"
                if size <= offset:
                    self._offsets[identity] = offset
                    continue
                with open(path, "rb") as f:
                    f.seek(offset)
                    data = f.read(min(size - offset, MAX_READ_BYTES))
            except FileNotFoundError:
                # A rotated backup deleted by max_backups between
                # evaluations: its records were already consumed.
                continue
            except (OSError, ValueError, OverflowError):
                error = "OSError"
                continue
            end = len(data)
            if not data.endswith(b"\n"):
                # Incomplete trailing line: keep it unconsumed until
                # its newline arrives.
                nl = data.rfind(b"\n")
                end = nl + 1 if nl >= 0 else 0
            if end > 0:
                for line in data[:end].split(b"\n"):
                    if line.strip():
                        lines.append(line)
                self._offsets[identity] = offset + end
        return lines, error


# ------------------------------------------------------------ live host --

class ShadowWarningTracker:
    """Live host for the shadow warning on ONE captured turn.

    Owns the incremental reader for the turn's run directory plus the
    per-turn predicate state. maybe_evaluate() is rate-limited to at
    most one evaluation per SHADOW_EVAL_INTERVAL_S and is fail-open:
    any read/parse anomaly degrades to "the turn continues normally"
    (the ACP stream and the collector are never touched) and reports
    at most ONE bounded error diagnostic per error state (a successful
    evaluation clears the state, so a later new anomaly is reported
    once). The warning itself is delivered to on_warning at most ONCE
    per turn (one-shot).
    """

    def __init__(self, conversation_id, run_id, run_dir,
                 turn_start=None, now=None,
                 on_warning=None, on_error=None):
        self.conversation_id = conversation_id
        self.run_id = run_id
        self.reader = RawLogReader(os.path.join(run_dir, "raw"))
        if now is None:
            now = time.monotonic()
        if turn_start is None:
            turn_start = now
        self.predicate = PathologyPredicate(conversation_id, turn_start)
        self._last_eval = None
        self._error_reported = False
        self._on_warning = on_warning
        self._on_error = on_error

    def maybe_evaluate(self, now=None):
        """Rate-limited evaluation. Never raises. The warning (if any,
        at most once per turn) is delivered to on_warning."""
        if now is None:
            now = time.monotonic()
        if self._last_eval is not None and \
                now - self._last_eval < SHADOW_EVAL_INTERVAL_S:
            return None
        self._last_eval = now
        warning = None
        try:
            lines, error = self.reader.read_new_lines()
            if error is not None:
                self._note_error(error)
            else:
                self._error_reported = False
            for line in lines:
                try:
                    payload = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    # A malformed complete line: skip it; one bounded
                    # diagnostic per error state.
                    self._note_error("ValueError")
                    continue
                for record in iter_log_records(payload):
                    self.predicate.observe(record_attributes(record), now)
            warning = self.predicate.evaluate(now)
        except Exception as exc:
            # Fail open: the turn continues normally.
            self._note_error(exc.__class__.__name__)
            return None
        if warning is not None and self._on_warning is not None:
            try:
                self._on_warning(warning)
            except Exception:
                pass
        return None

    def _note_error(self, reason):
        if self._error_reported:
            return
        self._error_reported = True
        if self._on_error is not None:
            try:
                self._on_error(reason)
            except Exception:
                pass


# ------------------------------------------------------------ replay ----

_TS_FORMATS = ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ")


def _parse_event_ts(value):
    """Parse an event.timestamp attribute into a naive datetime, or None."""
    if not isinstance(value, str):
        return None
    for fmt in _TS_FORMATS:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def replay_run(raw_dir, conversation_id, turn_start=None,
               eval_interval_s=SHADOW_EVAL_INTERVAL_S):
    """Read-only chronological replay of ONE stored run's raw log files
    through the SAME predicate used live.

    Records are fed in file order (chronological by the collector's
    rotation) / line order — the emission order — each tagged with the
    relay-equivalent monotonic now = record event.timestamp -
    turn_start (clamped non-decreasing; wall-clock arithmetic only, no
    timezone interpretation). Evaluation happens on the live cadence
    (at most once per eval_interval_s of replay time).

    turn_start: naive datetime for the turn start (default: the
    earliest captured-conversation record time). Returns
    (warnings, stats) — warnings is the list of warning dicts (at
    most one: one-shot). The predicate's threshold is the module
    constant SHADOW_WARNING_THRESHOLD_S (a test may monkey-patch the
    module attribute; the predicate reads it at call time).
    """
    names = ordered_log_files(raw_dir)
    if names is None:
        return [], {"error": "missing-raw-dir"}
    def _scan():
        records = []
        for name in names:
            try:
                with open(os.path.join(raw_dir, name), "rb") as f:
                    data = f.read()
            except OSError:
                continue
            if not data.endswith(b"\n"):
                nl = data.rfind(b"\n")
                data = data[:nl + 1] if nl >= 0 else b""
            for line in data.split(b"\n"):
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                for record in iter_log_records(payload):
                    records.append(record_attributes(record))
        return records

    records = _scan()
    if turn_start is None:
        start_dts = [d for a in records
                     if a.get("conversation.id") == conversation_id
                     for d in [_parse_event_ts(a.get("event.timestamp"))]
                     if d is not None]
        if not start_dts:
            return [], {"error": "no-captured-records"}
        turn_start = min(start_dts)
    predicate = PathologyPredicate(conversation_id, 0.0)
    warnings = []
    last_eval = None
    prev_now = None
    captured = 0
    for attrs in records:
        if attrs.get("conversation.id") != conversation_id:
            continue
        captured += 1
        dt = _parse_event_ts(attrs.get("event.timestamp"))
        if dt is None:
            if prev_now is None:
                continue
            now = prev_now
        else:
            now = max((dt - turn_start).total_seconds(), prev_now or 0.0)
        prev_now = now
        predicate.observe(attrs, now)
        if last_eval is None or now - last_eval >= eval_interval_s:
            last_eval = now
            warning = predicate.evaluate(now)
            if warning is not None:
                warnings.append(warning)
    stats = {"captured_records": captured,
             "total_records": len(records),
             "warning_emitted": predicate.warning_emitted}
    return warnings, stats


def main(argv):
    # Read-only forensic replay helper:
    #   shadow_warning.py replay <run_dir> <conversation_id>
    #       [--turn-start 2026-09-21T11:10:09Z]
    # Prints one bounded JSON object (warnings + counts only).
    if len(argv) < 3 or argv[0] != "replay":
        sys.stderr.write(
            "usage: shadow_warning.py replay <run_dir> <conversation_id> "
            "[--turn-start ISO-Z]\n")
        return 2
    run_dir = argv[1]
    conversation_id = argv[2]
    turn_start = None
    rest = argv[3:]
    i = 0
    while i < len(rest):
        if rest[i] == "--turn-start" and i + 1 < len(rest):
            turn_start = _parse_event_ts(rest[i + 1])
            if turn_start is None:
                sys.stderr.write("error: unparseable --turn-start\n")
                return 2
            i += 2
            continue
        sys.stderr.write("error: unknown argument %r\n" % rest[i])
        return 2
    warnings, stats = replay_run(os.path.join(run_dir, "raw"),
                                 conversation_id, turn_start=turn_start)
    print(json.dumps({"warnings": warnings, "stats": stats},
                     sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
