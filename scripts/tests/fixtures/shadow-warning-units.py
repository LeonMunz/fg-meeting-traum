#!/usr/bin/env python3
"""
Test fixture: unit tests for the live pathological-generation shadow
warning (scripts/observability/shadow_warning.py + its relay host in
scripts/observability/acp-lifecycle-relay.py).

Runs without a collector: synthetic timestamped JSONL telemetry drives
the incremental raw-log reader and the predicate with INJECTED time
(no real 30-minute waits, no live pathological model turn). Prints
ok/FAIL lines; exit 1 on any failure.

Coverage (task cases A-K, case L noted at the end):
  A  incident-shaped stream      -> exactly one shadow-warning
  B  exact threshold boundary    -> 1799 s: none; 1800 s: warning
  C  short no-tool response      -> no warning (completes < 1800 s)
  D  long engineering turn       -> no warning (tool results exist)
  E  non-reasoning generation    -> no warning (output-text /
                                    function-call delta in the open
                                    segment)
  F  segment already completed   -> later turn age alone must not
                                    trigger
  G  foreign telemetry isolation -> captured pathological + foreign
                                      heavy: A warns; captured healthy
                                      + foreign pathological: no warn
  H  one-shot                    -> no additional warnings on later
                                    evaluator ticks
  I  rotation                    -> records before/after rotation are
                                      counted exactly once (no
                                      duplication, no omission),
                                      including a live rename of the
                                      active file
  J  incomplete trailing line    -> partial record ignored until its
                                    newline; then consumed exactly once
  K  read/parsing failure        -> relay survives, no error storm
                                    (one diagnostic per error state,
                                    recovery re-arms exactly once)
  L  ACP byte transparency       -> covered by the EXISTING relay
                                    scenario suite (agent-product-
                                    launch.test.sh: prompt-hold,
                                    collector-readiness, framing,
                                    malformed/oversized line,
                                    concurrency, finalization); this
                                    fixture additionally asserts the
                                    relay event FORMAT of the
                                    shadow-warning line.

Plus: a READ-ONLY historical replay of the stored incident
(run-20260921T111009Z, captured conversation
01a0c3a6-dd79-7652-bb05-ecb528dd8c5d) and of the local representative
captured runs, when the local artifacts are present (no artifacts ->
skipped, not failed).
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime

REPO = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
SHADOW = os.path.join(REPO, "scripts", "observability", "shadow_warning.py")
RELAY = os.path.join(REPO, "scripts", "observability",
                     "acp-lifecycle-relay.py")

CAPTURED = "conv-captured"
FOREIGN = "conv-foreign"

FAILURES = []
PASSES = 0


def ok(name):
    global PASSES
    PASSES += 1
    print("ok   %s" % name)


def bad(name, detail=""):
    FAILURES.append(name)
    print("FAIL %s%s" % (name, (" — " + str(detail)[:300]) if detail else ""))


def check(name, cond, detail=""):
    if cond:
        ok(name)
    else:
        bad(name, detail)


def load_shadow():
    spec = importlib.util.spec_from_file_location("fg_shadow_warning", SHADOW)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sw = load_shadow()

WORK = tempfile.mkdtemp(prefix="fg-shadow-units.")


def new_run(name):
    run_dir = os.path.join(WORK, name)
    os.makedirs(os.path.join(run_dir, "raw"))
    return run_dir


def active_path(run_dir):
    return os.path.join(run_dir, "raw", "logs.jsonl")


def write_lines(path, lines):
    with open(path, "wb") as f:
        for line in lines:
            f.write(line if line.endswith(b"\n") else line + b"\n")


def append_lines(path, lines):
    with open(path, "ab") as f:
        for line in lines:
            f.write(line if line.endswith(b"\n") else line + b"\n")


def line_for(*records):
    return (json.dumps(sw.make_payload(*records)) + "\n").encode()


def delta(conv=CAPTURED, kind=sw.REASONING_GENERATION_KIND):
    return sw.make_record(conv, sw.SSE_EVENT, kind)


def completed(conv=CAPTURED):
    return sw.make_record(conv, sw.SSE_EVENT, sw.SEGMENT_CLOSE_KIND)


def tool_result(conv=CAPTURED):
    return sw.make_record(conv, sw.TOOL_RESULT_EVENT)


def api_request(conv=CAPTURED):
    return sw.make_record(conv, sw.API_REQUEST_EVENT)


def tracker(run_dir, conv=CAPTURED, **kw):
    warns, errs = [], []
    t = sw.ShadowWarningTracker(
        conversation_id=conv, run_id="run-test", run_dir=run_dir,
        turn_start=0.0, on_warning=warns.append, on_error=errs.append,
        **kw)
    return t, warns, errs


# ------------------------------------------------------------------ case A --

def case_a():
    run_dir = new_run("caseA")
    write_lines(active_path(run_dir),
                [line_for(delta()) for _ in range(400)])
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(0.0)
    check("A1 no warning at turn start", not warns)
    # Cadence: the 59 s tick must NOT inspect the raw telemetry again.
    reads = []
    real_read = t.reader.read_new_lines
    t.reader.read_new_lines = lambda: reads.append(1) or real_read()
    t.maybe_evaluate(59.0)
    check("A2 cadence: no raw inspection before 60 s", reads == [])
    t.maybe_evaluate(1799.9)
    check("A3 no warning just under the threshold", not warns)
    t.maybe_evaluate(1860.0)
    check("A4 exactly one shadow-warning", len(warns) == 1, warns)
    if warns:
        w = warns[0]
        check("A5 warning fields (sse_events/api/elapsed_s)",
              w["sse_events"] == 400 and w["api"] == 0 and w["elapsed_s"] == 1860,
              w)
    check("A6 no read/parse errors", not errs, errs)


# ------------------------------------------------------------------ case B --

def case_b():
    p = sw.PathologyPredicate(CAPTURED, 0.0)
    p.observe(sw.record_attributes(delta()), 0.0)
    check("B1 no warning at 1799 s", p.evaluate(1799.0) is None)
    w = p.evaluate(1800.0)
    check("B2 warning at exactly 1800 s", w is not None and w["elapsed_s"] == 1800,
          w)


# ------------------------------------------------------------------ case C --

def case_c():
    run_dir = new_run("caseC")
    lines = [line_for(delta()) for _ in range(50)]
    lines.append(line_for(completed()))
    write_lines(active_path(run_dir), lines)
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(100.0)   # consumes: 50 deltas + response.completed
    check("C1 short reasoning-only response: no warning", not warns)
    check("C2 segment is closed", t.predicate.segment_open is False)


# ------------------------------------------------------------------ case D --

def case_d():
    run_dir = new_run("caseD")
    lines = []
    for i in range(60):
        lines.append(line_for(delta()))
        if i % 10 == 0:
            lines.append(line_for(tool_result()))
    write_lines(active_path(run_dir), lines)
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(0.0)
    t.maybe_evaluate(1860.0)
    check("D1 long engineering turn (tool results): no warning", not warns)
    check("D2 tool results counted", t.predicate.turn_tool_results == 6,
          t.predicate.turn_tool_results)


# ------------------------------------------------------------------ case E --

def case_e():
    for label, name, kind in (
            ("E1", "E1 output-text", "response.output_text.delta"),
            ("E2", "E2 function-call",
             "response.function_call_arguments.delta")):
        run_dir = new_run("case" + label)
        lines = [line_for(delta()) for _ in range(300)]
        lines.append(line_for(delta(kind=kind)))
        lines += [line_for(delta()) for _ in range(100)]
        write_lines(active_path(run_dir), lines)
        t, warns, errs = tracker(run_dir)
        t.maybe_evaluate(0.0)
        t.maybe_evaluate(1860.0)
        check("%s non-reasoning generation: no warning" % name, not warns)
        check("%s all_reasoning cleared" % name,
              t.predicate.segment_all_reasoning is False)


# ------------------------------------------------------------------ case F --

def case_f():
    run_dir = new_run("caseF")
    lines = [line_for(delta()) for _ in range(20)]
    lines.append(line_for(completed()))
    write_lines(active_path(run_dir), lines)
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(100.0)          # segment closes at 100 s
    t.maybe_evaluate(1860.0)
    t.maybe_evaluate(3600.0)
    check("F1 completed segment: later turn age alone must not trigger",
          not warns)


# ------------------------------------------------------------------ case G --

def case_g():
    # Variant 1: captured A pathological, foreign B tool/API heavy.
    run_dir = new_run("caseG1")
    lines = []
    for i in range(300):
        lines.append(line_for(delta()))
        lines.append(line_for(delta(conv=FOREIGN)))
        if i % 5 == 0:
            lines.append(line_for(tool_result(conv=FOREIGN)))
        if i % 10 == 0:
            lines.append(line_for(api_request(conv=FOREIGN)))
    write_lines(active_path(run_dir), lines)
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(0.0)
    t.maybe_evaluate(1860.0)
    check("G1v1 captured pathological + foreign heavy: exactly one warning",
          len(warns) == 1, warns)
    if warns:
        check("G1v2 foreign progress invisible to the predicate",
              warns[0]["api"] == 0 and warns[0]["sse_events"] == 300, warns[0])
    check("G1v3 foreign counters never counted",
          t.predicate.turn_tool_results == 0 and t.predicate.turn_api_requests == 0)

    # Variant 2: captured A healthy, foreign B pathological.
    run_dir = new_run("caseG2")
    lines = []
    for i in range(300):
        lines.append(line_for(delta(kind="response.output_text.delta")))
        lines.append(line_for(delta(conv=FOREIGN)))
        if i % 5 == 0:
            lines.append(line_for(tool_result()))
            lines.append(line_for(api_request()))
    write_lines(active_path(run_dir), lines)
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(0.0)
    t.maybe_evaluate(1860.0)
    check("G2v1 captured healthy + foreign pathological: no warning", not warns)
    check("G2v2 captured turn progress counted",
          t.predicate.turn_tool_results == 60 and t.predicate.turn_api_requests == 60)


# ------------------------------------------------------------------ case H --

def case_h():
    run_dir = new_run("caseH")
    write_lines(active_path(run_dir), [line_for(delta()) for _ in range(100)])
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(0.0)
    t.maybe_evaluate(1860.0)
    check("H1 warning fired once", len(warns) == 1)
    # Later evaluator ticks (new data appended): no re-fire.
    for now in (1920.0, 1980.0, 2040.0, 2100.0):
        append_lines(active_path(run_dir), [line_for(delta()) for _ in range(5)])
        t.maybe_evaluate(now)
    check("H2 one-shot: no additional warnings on later ticks",
          len(warns) == 1, warns)


# ------------------------------------------------------------------ case I --

ROT1 = "logs-2026-01-02T03-04-05.678-size.jsonl"
ROT2 = "logs-2026-01-02T04-05-06.789-size.jsonl"


def case_i():
    # I1: pre-rotated layout — rotated file + active file, each counted
    # exactly once, oldest file first.
    run_dir = new_run("caseI1")
    raw = os.path.join(run_dir, "raw")
    write_lines(os.path.join(raw, ROT1), [line_for(delta()) for _ in range(100)])
    write_lines(active_path(run_dir), [line_for(delta()) for _ in range(50)])
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(0.0)
    check("I1 rotated + active counted exactly once each",
          t.predicate.segment_sse_events == 150,
          t.predicate.segment_sse_events)
    t.maybe_evaluate(60.0)
    check("I1b no duplication on a second (idle) evaluation",
          t.predicate.segment_sse_events == 150)

    # I2: live rotation — the active file is RENAMED (same inode):
    # its consumed offset must carry over (no double counting), and the
    # fresh active file is consumed from 0 (no omission).
    run_dir = new_run("caseI2")
    act = active_path(run_dir)
    write_lines(act, [line_for(delta()) for _ in range(100)])
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(0.0)
    check("I2a first file consumed",
          t.predicate.segment_sse_events == 100)
    os.rename(act, os.path.join(os.path.dirname(act), ROT2))
    write_lines(act, [line_for(delta()) for _ in range(50)])
    t.maybe_evaluate(60.0)
    check("I2b after rename: no duplication, no omission",
          t.predicate.segment_sse_events == 150,
          t.predicate.segment_sse_events)
    append_lines(act, [line_for(delta()) for _ in range(20)])
    t.maybe_evaluate(120.0)
    check("I2c new active-file appends consumed exactly once",
          t.predicate.segment_sse_events == 170,
          t.predicate.segment_sse_events)


# ------------------------------------------------------------------ case J --

def case_j():
    run_dir = new_run("caseJ")
    act = active_path(run_dir)
    full = line_for(delta())
    with open(act, "wb") as f:
        f.write(full[:len(full) // 2])   # incomplete trailing line
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(0.0)
    check("J1 partial record ignored (no corruption warning)",
          t.predicate.segment_sse_events == 0 and not errs,
          (t.predicate.segment_sse_events, errs))
    with open(act, "ab") as f:
        f.write(full[len(full) // 2:])   # complete the line
    t.maybe_evaluate(60.0)
    check("J2 completed line consumed exactly once",
          t.predicate.segment_sse_events == 1,
          t.predicate.segment_sse_events)
    t.maybe_evaluate(120.0)
    check("J3 no double count on the next evaluation",
          t.predicate.segment_sse_events == 1)


# ------------------------------------------------------------------ case K --

def case_k():
    # K1: missing run dir -> one bounded error diagnostic, no storm,
    # recovery clears the state, a later NEW anomaly is reported once.
    missing = os.path.join(WORK, "caseK-missing-run", "raw")
    t, warns, errs = tracker(os.path.dirname(missing))
    t.maybe_evaluate(0.0)
    check("K1a missing raw dir: relay survives, one error diagnostic",
          errs == ["OSError"], errs)
    t.maybe_evaluate(60.0)
    t.maybe_evaluate(120.0)
    check("K1b no error storm while the anomaly persists",
          len(errs) == 1, errs)
    os.makedirs(missing)
    write_lines(os.path.join(missing, "logs.jsonl"),
                [line_for(delta()) for _ in range(5)])
    t.maybe_evaluate(180.0)
    check("K1c recovery: records consumed, state cleared",
          t.predicate.segment_sse_events == 5 and len(errs) == 1,
          (t.predicate.segment_sse_events, errs))
    shutil.rmtree(os.path.dirname(missing))
    t.maybe_evaluate(240.0)
    check("K1d a NEW error state is reported exactly once",
          len(errs) == 2, errs)

    # K2: malformed complete line -> skipped, one diagnostic, the valid
    # records around it are still consumed.
    run_dir = new_run("caseK2")
    act = active_path(run_dir)
    with open(act, "wb") as f:
        f.write(line_for(delta()))
        f.write(b"this is not json\n")
        f.write(line_for(delta()))
    t, warns, errs = tracker(run_dir)
    t.maybe_evaluate(0.0)
    check("K2a malformed line skipped, valid records consumed",
          t.predicate.segment_sse_events == 2 and errs == ["ValueError"],
          (t.predicate.segment_sse_events, errs))
    append_lines(act, [line_for(delta())])
    t.maybe_evaluate(60.0)
    check("K2b recovery after the malformed line",
          t.predicate.segment_sse_events == 3 and len(errs) == 1,
          (t.predicate.segment_sse_events, errs))


# ------------------------------------------- relay event format (part L) --

def case_relay_format():
    # The relay HOSTS the tracker: verify the exact bounded event line
    # the relay appends when the warning fires (relay event log), and
    # the read-error line. The byte-transparent ACP stream itself is
    # covered by the existing relay scenario suite (task case L).
    relay_log = os.path.join(WORK, "relay-events-test.log")
    os.environ["FG_PRODUCT_RELAY_LOG"] = relay_log
    spec = importlib.util.spec_from_file_location("fg_acp_lifecycle_relay",
                                                  RELAY)
    relay_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(relay_mod)
    check("L1 relay loads the shadow-warning module",
          relay_mod.shadow_warning is not None)
    check("L2 relay exposes the one-shot warning host",
          hasattr(relay_mod.Relay, "_start_shadow_tracking") and
          hasattr(relay_mod.Relay, "_evaluate_shadow"))
    run_dir = new_run("caseL")
    write_lines(active_path(run_dir), [line_for(delta()) for _ in range(50)])
    relay = relay_mod.Relay("/bin/true", [])
    st = relay._new_session_state()
    st.update(state="open", run_id="run-123", turn_started_at=1000.0)
    relay.sessions[CAPTURED] = st
    relay._start_shadow_tracking(CAPTURED, st, "run-123", run_dir=run_dir)
    check("L3 tracker hosted on the session state", st.get("shadow") is not None)
    # Advance the relay's monotonic clock past the threshold.
    fake = {"now": 1000.0}
    real_monotonic = relay_mod.time.monotonic
    relay_mod.time.monotonic = lambda: fake["now"]
    try:
        relay._evaluate_shadow()   # at t=0: initializes the reader
        fake["now"] = 1000.0 + 1860.0
        relay._evaluate_shadow()   # predicate fires
    finally:
        relay_mod.time.monotonic = real_monotonic
    try:
        with open(relay_log, "r") as f:
            log_text = f.read()
    except OSError:
        log_text = ""
    expected = ("shadow-warning session=%s run=run-123 elapsed_s=1860 "
                "sse_events=50 all_reasoning=true tools=0 api=0" % CAPTURED)
    check("L4 relay appends exactly the bounded shadow-warning line",
          expected in log_text, log_text[-400:])
    check("L5 one-shot at the relay level",
          log_text.count("shadow-warning session=") == 1)
    # Turn finalization releases the tracker (bounded memory).
    relay._clear_shadow(st)
    check("L6 tracker released on turn finalization", st.get("shadow") is None)


# ------------------------------------------------- historical replay (RO) --

def case_replay():
    runs_dir = os.path.join(REPO, ".artifacts", "agent-runs")
    incident = os.path.join(runs_dir, "run-20260921T111009Z")
    if not os.path.isdir(incident):
        ok("R replay skipped — no local incident artifact (read-only check)")
        return

    def manifest_ts(path, key):
        try:
            with open(path) as f:
                m = json.load(f)
            v = m.get(key)
            if not isinstance(v, str):
                return None
            return datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ")
        except (OSError, ValueError):
            return None

    manifest = os.path.join(incident, "capture-manifest.json")
    turn_start = manifest_ts(manifest, "start_ts")
    cap = "01a0c3a6-dd79-7652-bb05-ecb528dd8c5d"
    warns, stats = sw.replay_run(os.path.join(incident, "raw"), cap,
                                 turn_start=turn_start)
    check("R1 incident replay: exactly one warning", len(warns) == 1,
          (len(warns), stats))
    if warns:
        w = warns[0]
        check("R2 incident replay: 1800-second live rule fires on the "
              "open reasoning-only segment (forensic: ~46,567 SSE events)",
              40000 <= w["sse_events"] <= 50000 and w["api"] <= 1, w)

    # Foreign telemetry of the SAME run must not fire (run-wide metrics
    # would show 62 API requests / 67 tool results).
    foreign = "01a0c317-53f2-75c3-94cd-5c55f1905890"
    fwarns, fstats = sw.replay_run(os.path.join(incident, "raw"), foreign,
                                   turn_start=turn_start)
    check("R3 incident replay: foreign conversation does not warn",
          len(fwarns) == 0 and fstats.get("captured_records", 0) > 0,
          (len(fwarns), fstats))

    # Representative captured runs (local artifacts, read-only): the
    # same predicate must not fire on any normal captured turn.
    cap_runs = []
    try:
        names = sorted(os.listdir(runs_dir))
    except OSError:
        names = []
    for name in names:
        if name == "run-20260921T111009Z":
            continue
        mpath = os.path.join(runs_dir, name, "capture-manifest.json")
        try:
            with open(mpath) as f:
                m = json.load(f)
        except (OSError, ValueError):
            continue
        ccid = m.get("captured_conversation_id")
        if not isinstance(ccid, str) or m.get("stop_status") == "running":
            continue
        cap_runs.append((name, ccid))
    total = 0
    replayed = 0
    fired = []
    for name, ccid in cap_runs:
        raw = os.path.join(runs_dir, name, "raw")
        try:
            size = sum(os.path.getsize(os.path.join(raw, n))
                       for n in os.listdir(raw)
                       if n == "logs.jsonl" or n.startswith("logs-"))
        except OSError:
            continue
        if total + size > 200 * 1024 * 1024:
            ok("R4 corpus replay truncated at the 200 MiB log cap "
               "(%d of %d captured runs replayed)" % (replayed, len(cap_runs)))
            break
        total += size
        ts = manifest_ts(os.path.join(runs_dir, name, "capture-manifest.json"),
                         "start_ts")
        warns, stats = sw.replay_run(raw, ccid, turn_start=ts)
        replayed += 1
        if warns:
            fired.append(name)
    check("R5 representative captured runs: zero warnings (%d replayed%s)"
          % (replayed, ", none available" if not cap_runs else ""),
          not fired, fired)


def main():
    case_a()
    case_b()
    case_c()
    case_d()
    case_e()
    case_f()
    case_g()
    case_h()
    case_i()
    case_j()
    case_k()
    case_relay_format()
    case_replay()
    shutil.rmtree(WORK, ignore_errors=True)
    if FAILURES:
        print("SUMMARY %d passed, %d FAILED" % (PASSES, len(FAILURES)))
        return 1
    print("SUMMARY %d passed, 0 failed" % PASSES)
    return 0


if __name__ == "__main__":
    sys.exit(main())
