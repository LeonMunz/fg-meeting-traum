#!/usr/bin/env python3
"""
FG Workspace — transparent ACP lifecycle relay (prompt-turn runs).

Sits between the ACP client (Lucid) and the original codex-acp launcher and
does exactly two things:

  1. Byte-transparently pumps the ACP stdio stream in both directions
     (newline-delimited JSON-RPC framing; stdout carries ACP bytes
     only; all diagnostics go to stderr).
  2. Observes the bounded JSON-RPC lifecycle metadata and maps each
     session/prompt TURN to exactly one local observability run:

         session/prompt request (client -> server)   -> run starts
         matching session/prompt response (stopReason) -> run finalizes

     ACP defines the prompt turn as the execution boundary: one
     session/prompt request, the foreground agent work, and the matching
     response carrying a stopReason is prompt-turn completion. Lucid keeps
     ACP sessions alive indefinitely (session/close is NOT a reliable
     boundary), so the run boundary is the turn, not the session.

     The ACP sessionId stays a PERSISTENT GROUPING DIMENSION: the relay
     tracks each root session (session/new, session/load, session/resume,
     session/fork) so close/delete can clean up, but opening a session
     starts no run — only a prompt turn does. Every prompt turn of a
     session gets its own distinct run, so a long-lived chat produces one
     run per prompt.

     A fresh session can only be opened with session/new: the installed
     adapter (codex-acp 1.7.0) creates a new thread ONLY in its
     session/new handler; session/load and session/resume resume
     EXISTING threads (they fail without one) and session/fork has no
     handler at all. session/resume and session/load are nevertheless
     root session opens (a re-opened conversation is a fresh root ACP
     session) and are tracked as such. session/fork is covered
     defensively (its response carries the new sessionId).

     session/close and session/delete are CLEANUP ONLY: they finalize an
     unexpectedly open turn (one whose prompt response never arrived) as
     "interrupted" and release the session state. A normal turn never
     needs a close: its response finalizes the run while the ACP session
     stays open.

The ACP server process is long-lived across sessions and turns; the
observability unit is the prompt turn. Process/transport exit is only a
fallback cleanup boundary: if the child dies with an active prompt turn,
that run is finalized as "interrupted" (never as graceful).

Run finalization statuses:
  * prompt response with a result (stopReason)      -> "graceful"
  * prompt response with a JSON-RPC error           -> "interrupted"
  * session/close|delete before the prompt response -> "interrupted"
  * process/transport crash with the turn active    -> "interrupted"

Identity:
  * the ACP sessionId IS the native Codex thread/conversation id (the
    codex-acp adapter returns Codex `thread.id` as `sessionId`);
  * that captured conversation identity is persisted into the run's
    capture manifest at start time (FG_OBS_CAPTURED_CONVERSATION_ID,
    seeded as `captured_conversation_id`): it is durable run metadata —
    it survives finalization and the release of the transient mapping,
    and the Run Ledger uses it to attribute primary activity to the
    captured turn while reporting foreign telemetry explicitly;
  * the mapping file <MAP_DIR>/<sessionId> holds exactly one line: the
    run id of the session's ACTIVE prompt turn (git-ignored, bounded
    identifiers, atomic writes). It is written when the turn's run comes
    up and released when the turn finalizes — between turns the session
    has no mapping, and nothing resolves to a finished run.
  * the agent side resolves its run via CODEX_SESSION_ID (the native
    session id that Codex exports into tool shells) + this mapping —
    deterministic, never timestamp-nearest, never newest-run guessing.

Readiness ordering (captured prompts):
  * the collector must be confirmed ACCEPTING on its loopback OTLP
    endpoint BEFORE a captured prompt's bytes reach the Codex child —
    otherwise the turn's first telemetry events are lost to collector
    startup. A capturable session/prompt line is therefore HELD by the
    pump (never modified, never dropped) from the moment its turn's
    start sidecar begins, until the start contract resolves:
    "started" (collector confirmed listening on its OTLP endpoint), or
    the fail-open outcomes "already_running" / error / timeout (the
    prompt then proceeds uncaptured). The held bytes — the prompt line
    plus any lines that arrived while it was held — are then forwarded
    UNCHANGED, in the client's original order. No other ACP message is
    held: everything before the prompt line, and everything after the
    release, passes through immediately.

Privacy / protocol safety:
  * never modifies or re-serializes protocol payloads (bytes are
    forwarded as-is; only method/id/sessionId fields are observed);
  * never persists prompts or content blocks (lines beyond the
    bounded per-line observation bound are skipped, not retained);
  * the relay event log (see EventLog) records ONLY the bounded
    identifiers the lifecycle contract allows: relay start/exit, ACP
    method names, request ids, session ids, capture start results,
    mapping write results, close/delete events, finalization results.
    No prompts, content blocks, tool arguments/results, auth,
    environment dumps, or ACP bodies — ever.
  * on a malformed line the relay degrades to pure byte-forwarding
    for that line only (observation resumes on the next line) and
    never emits malformed ACP output;
  * no environment dumps; diagnostics are bounded single lines.

Live pathological-generation shadow warning (diagnostic only):
   while a captured turn is still running, the relay evaluates a
   bounded live predicate (open-segment elapsed >= 1800 s, zero
   codex.tool_result for the captured turn, all observed generation in
   the open segment is response.reasoning_text.delta,
   codex.api_request <= 1, segment still open) at most once every 60 s
   per turn, reading only NEW bytes of the run's raw log files
   (incremental, rotation-aware, captured-conversation-scoped). When
   the predicate becomes true the relay appends EXACTLY ONE bounded
   identifier/evidence-only `shadow-warning` event for the turn
   (one-shot; no re-arm). The warning never delays, modifies, or
   cancels the ACP stream, the model, or the collector — it is
   diagnostic only; read/parse anomalies fail open with at most one
   bounded `shadow-warning-read-error` event per error state.

This file is repository-owned and is launched by
scripts/agent-product-launch (one-time host integration, see
docs/agent/OBSERVABILITY.md, "Automatic product-session lifecycle").
"""

import json
import os
import re
import select
import signal
import subprocess
import sys
import tempfile
import traceback
import time

SCRIPT_PATH = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_PATH))

OBSCTL = os.environ.get("FG_PRODUCT_RELAY_OBSCTL") or os.path.join(
    REPO_ROOT, "scripts", "agent-observability")
MAP_DIR = os.environ.get("FG_PRODUCT_SESSION_MAP_DIR") or os.path.join(
    REPO_ROOT, ".artifacts", "agent-observability", "session-runs")
RUNS_DIR = os.environ.get("FG_OBS_RUNS_DIR") or os.path.join(
    REPO_ROOT, ".artifacts", "agent-runs")


def _load_shadow_warning():
    """Load the live shadow-warning module (same directory).

    The shadow warning is DIAGNOSTIC ONLY; a load failure must never
    break the relay — the byte-transparent ACP stream is the contract.
    """
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "fg_shadow_warning",
            os.path.join(SCRIPT_PATH, "shadow_warning.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None


shadow_warning = _load_shadow_warning()

CHUNK = 65536
START_DEADLINE = float(os.environ.get("FG_PRODUCT_RELAY_START_DEADLINE", "60"))
STOP_WAIT = float(os.environ.get("FG_PRODUCT_RELAY_STOP_WAIT", "60"))
ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
CLOSE_METHODS = ("session/close", "session/delete")
# The RUN BOUNDARY: one session/prompt request starts a run; the matching
# response (correlated by request id; result carries stopReason) finalizes
# it. The ACP session itself stays open across turns.
PROMPT_METHOD = "session/prompt"
# Session-OPEN methods (installed adapter: codex-acp 1.7.0). These track
# the session IDENTITY only (a persistent grouping dimension) — they start
# NO run; only a prompt turn does:
#   session/new, session/fork -> the NEW sessionId arrives in the response
#                                (session/new is the ONLY method that
#                                creates a fresh thread; a working fresh
#                                session can therefore only be a new);
#   session/load, session/resume -> the existing sessionId arrives in the
#                                   request params (both resume an
#                                   existing thread; load replays history,
#                                   resume does not).
# Any of these opens a ROOT ACP session (a re-opened conversation is a
# fresh root ACP session) and is tracked as such.
OPEN_RESPONSE_METHODS = ("session/new", "session/fork")
OPEN_PARAM_METHODS = ("session/load", "session/resume")

# Privacy-safe bounded diagnostics (see EventLog): the ACP server's stderr
# goes to the client host and may be dropped, so the same events are also
# appended to a git-ignored log file the controller can always inspect.
RELAY_LOG = os.environ.get("FG_PRODUCT_RELAY_LOG") or os.path.join(
    REPO_ROOT, ".artifacts", "agent-observability", "relay-events.log")
RELAY_LOG_MAX_BYTES = 262144    # rotate when the log exceeds 256 KiB
RELAY_LOG_KEEP_BYTES = 131072   # keep the most recent 128 KiB
LOG_PREFIX = "agent-observability relay: "


class EventLog:
    """Bounded single-line relay diagnostics (stderr + optional file).

    Records ONLY the bounded identifiers the lifecycle contract allows
    (relay started/exited, ACP method names, request ids, session ids,
    capture start results, mapping write results, close/delete events,
    finalization results, live shadow-warning diagnostics — bounded
    session/run ids and integer counters only). It never records prompts,
    content blocks,
    tool arguments/results, auth material, environment dumps, or ACP
    bodies. Every write is best-effort and bounded: diagnostics must
    never break or delay the ACP stream.
    """

    def __init__(self, path):
        self.path = path

    def write(self, line):
        rec = ("%s %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                          line))[:1000]
        try:
            sys.stderr.write(LOG_PREFIX + rec + "\n")
            sys.stderr.flush()
        except Exception:
            pass
        if not self.path:
            return
        try:
            d = os.path.dirname(self.path)
            if d:
                os.makedirs(d, exist_ok=True)
            with open(self.path, "a") as f:
                f.write(rec + "\n")
        except Exception:
            return
        try:
            if os.path.getsize(self.path) > RELAY_LOG_MAX_BYTES:
                with open(self.path, "rb") as f:
                    data = f.read()
                keep = data[-RELAY_LOG_KEEP_BYTES:]
                i = keep.find(b"\n")
                if i >= 0:
                    keep = keep[i + 1:]
                with open(self.path, "wb") as f:
                    f.write(keep)
        except Exception:
            pass


def _fmt_id(value):
    """Bounded rendering of a JSON-RPC id (never a body)."""
    if value is None:
        return "none"
    return str(value)[:64]

# Resets SIGINT/SIGTERM to the OS default and execs the product launcher
# in place (same pid/argv/env/stdio). Needed because a backgrounded child
# of a non-interactive shell may inherit SIGINT IGNORED, and a signal that
# is ignored on entry can never be trapped — the product process would
# silently lose its Ctrl-C semantics.
SHIM = (
    "import os, signal, sys\n"
    "signal.signal(signal.SIGINT, signal.SIG_DFL)\n"
    "signal.signal(signal.SIGTERM, signal.SIG_DFL)\n"
    "try:\n"
    "    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)\n"
    "except Exception as exc:\n"
    "    sys.stderr.write('agent-observability relay: ERROR: cannot exec delegate (%s: %s)\\n'\n"
    "                     % (exc.__class__.__name__, exc))\n"
    "    sys.exit(127)\n"
)

# Module-level diagnostics sink (set by Relay in run(); stderr-only
# fallback before that). stdout is ALWAYS ACP-only.
_EVENT_LOG = EventLog("")


def log(line):
    # Bounded single-line diagnostic (see EventLog for the privacy bound).
    _EVENT_LOG.write(line[:400])


def valid_id(value):
    return isinstance(value, str) and bool(ID_RE.match(value))


# ------------------------------------------------------------- mapping ----

def _mapping_path(session_id):
    return os.path.join(MAP_DIR, session_id)


def write_mapping(session_id, run_id):
    if not valid_id(session_id) or not RUN_ID_RE.match(run_id):
        raise ValueError("invalid session/run identifier")
    os.makedirs(MAP_DIR, exist_ok=True)
    tmp = os.path.join(MAP_DIR, ".%s.tmp.%d" % (session_id, os.getpid()))
    with open(tmp, "w") as f:
        f.write(run_id + "\n")
    os.replace(tmp, _mapping_path(session_id))


def read_mapping(session_id):
    if not valid_id(session_id):
        return None
    try:
        with open(_mapping_path(session_id), "r") as f:
            run_id = f.read().strip()
    except OSError:
        return None
    return run_id if RUN_ID_RE.match(run_id) else None


def remove_mapping(session_id):
    if not valid_id(session_id):
        return
    try:
        os.unlink(_mapping_path(session_id))
    except OSError:
        pass


# ------------------------------------------------------------- framer ----

class NdjsonFramer:
    """Observation-only tracker for ACP newline-delimited JSON-RPC framing.

    ACP stdio (stable v1) is newline-delimited JSON: one JSON-RPC message
    per line, terminated by ``\\n`` (a preceding ``\\r`` from CRLF is
    tolerated). Bytes are NEVER modified by this class; the pump forwards
    the original byte stream unchanged — the framer only tells the relay
    where line boundaries are and hands each complete line to the
    observer, within the bound below.

    Bounded observation:
      * at most MAX_LINE bytes of one line are retained for parsing.
        Lifecycle messages (session/new, session/load, session/resume,
        session/fork, session/close, session/delete and their responses)
        are small; payload-heavy lines (session/prompt, session/update)
        safely exceed the bound;
      * a line that exceeds MAX_LINE — whether it completes or is still
        unterminated at the bound — is SKIPPED: its bytes are discarded
        (observation only; the pump already forwarded them), ONE bounded
        diagnostic is recorded (frame-skipped), and observation RESUMES
        on the next line. An oversized line never disables observation
        for the stream (the old LSP framer's stream-wide bypass is gone
        by design — a single big line cannot blind the relay);
      * a malformed (non-JSON) line is forwarded unchanged by the pump
        and records ONE bounded diagnostic (never the content);
        observation continues with the next line.
    """

    MAX_LINE = 262144  # per-line observation bound (256 KiB)

    def __init__(self, on_message, on_error=None, on_skipped=None,
                 on_hold=None):
        self.on_message = on_message
        self.on_error = on_error       # callback(str) — bounded diagnostics
        self.on_skipped = on_skipped   # callback() — once per skipped line
        self.on_hold = on_hold         # callback(bytes) — hold this line
        self.buf = b""
        self.skipping = False

    def _skipped(self):
        if self.on_skipped:
            try:
                self.on_skipped()
            except Exception:
                pass

    def _observe_error(self, msg):
        if self.on_error:
            try:
                self.on_error(msg)
            except Exception:
                pass

    def feed(self, chunk):
        if not chunk:
            return
        if self.skipping:
            i = chunk.find(b"\n")
            if i < 0:
                return  # still inside the oversized line: discard bytes
            self.skipping = False
            chunk = chunk[i + 1:]
            if not chunk:
                return
        chunk = self.buf + chunk
        self.buf = b""
        start = 0
        while True:
            i = chunk.find(b"\n", start)
            if i < 0:
                break
            line = chunk[start:i]
            if len(line) > self.MAX_LINE:
                # Complete line beyond the observation bound: skip it.
                self._skipped()
            else:
                self._deliver(line)
            start = i + 1
        self.buf = chunk[start:]
        if len(self.buf) > self.MAX_LINE:
            # The current line is not terminated within the observation
            # bound: discard it (observation only — the pump has already
            # forwarded the bytes) until its terminating newline.
            self.buf = b""
            self.skipping = True
            self._skipped()

    def _deliver(self, line):
        raw = line  # as received (keeps a CRLF \r): the hold contract
        if line.endswith(b"\r"):
            line = line[:-1]
        if not line.strip():
            return  # blank line: nothing to observe
        try:
            msg = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            # Malformed line: the pump already forwarded the bytes
            # unchanged; record ONE bounded diagnostic (never the body).
            self._observe_error("malformed-json line (bytes=%d)"
                                % len(line))
            return
        if isinstance(msg, dict):
            try:
                result = self.on_message(msg)
            except Exception:
                # An observer failure must never be silent (it used to be
                # swallowed here, hiding lifecycle failures with zero
                # trace) and must never break the stream.
                self._observe_error("observer: %s" % _short_exc())
                return
            if result == "HOLD" and self.on_hold:
                # The observer started a new capture turn for this line:
                # hand the EXACT wire bytes (terminator included) to the
                # pump, which must not forward them until the turn's
                # start contract confirms collector readiness.
                try:
                    self.on_hold(raw + b"\n")
                except Exception:
                    pass


def _short_exc():
    """Bounded 'ExcClass @ file:line: msg' for the in-flight exception."""
    tb = traceback.extract_tb(sys.exc_info()[2])
    frame = tb[-1] if tb else None
    exc = sys.exc_info()[1]
    loc = ("%s:%s" % (os.path.basename(frame.filename), frame.lineno)
           if frame else "unknown")
    return "%s @ %s: %s" % (exc.__class__.__name__, loc, str(exc)[:80])


# ------------------------------------------------------------- sidecars ---

def run_bounded(argv, timeout=60):
    """Run a command to completion (stdin from /dev/null); return (rc, stdout, stderr)."""
    try:
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out, err
    except Exception:
        return 124, b"", b"sidecar failure"


def probe_running_state():
    """'running' | 'stopped' | 'unknown' via the control surface (never a guess)."""
    try:
        rc, out, _ = run_bounded([OBSCTL, "status", "--json"], timeout=20)
        if rc != 0:
            return "unknown"
        d = json.loads(out.decode("utf-8", "replace"))
        r = d.get("running")
        return r.get("state", "unknown") if isinstance(r, dict) else "unknown"
    except Exception:
        return "unknown"


class StartSidecar:
    """`agent-observability start --json` as a background sidecar.

    The contract lands on the sidecar's stdout as soon as the collector is
    confirmed listening; the sidecar process may then keep running briefly
    (read-only doctor snapshot) and must not be waited on for the contract.

    `captured_conversation_id` is the ACP sessionId that caused this run
    (the native Codex conversation; validated by the caller against the
    relay's bounded identifier shape). It is passed to the sidecar as
    FG_OBS_CAPTURED_CONVERSATION_ID so the run manifest persists the
    captured conversation identity at seed time — durably, before any
    finalization and independent of the transient session/run mapping
    (which is released when the turn ends).
    """

    def __init__(self, captured_conversation_id=None):
        self.out_file = tempfile.mktemp(prefix="fg-relay-start-out.")
        self.err_file = tempfile.mktemp(prefix="fg-relay-start-err.")
        self.owned_port = probe_running_state() != "running"
        self.proc = None
        self.contract = None   # (status, run_id, run_dir) | ("error", rc, None)
        self.exited_rc = None
        env = None
        if captured_conversation_id:
            env = dict(os.environ)
            env["FG_OBS_CAPTURED_CONVERSATION_ID"] = captured_conversation_id
        try:
            with open(self.out_file, "wb") as of, open(self.err_file, "wb") as ef:
                self.proc = subprocess.Popen(
                    [OBSCTL, "start", "--json"],
                    stdin=subprocess.DEVNULL, stdout=of, stderr=ef,
                    env=env)
        except Exception as exc:
            # A spawn failure must NOT escape the observer callback (that
            # would be swallowed silently and leave a session uncaptured
            # with zero trace): fail open with a recorded, bounded reason.
            for f in (self.out_file, self.err_file):
                try:
                    os.unlink(f)
                except OSError:
                    pass
            self.contract = ("error", 1,
                             "sidecar spawn failed (%s)"
                             % exc.__class__.__name__)
        self.deadline = time.monotonic() + START_DEADLINE

    def poll(self):
        """Non-blocking. Returns True once the outcome is final."""
        if self.contract is not None:
            return True
        if self.proc is None:
            return True
        data = b""
        try:
            with open(self.out_file, "rb") as f:
                data = f.read()
        except OSError:
            data = b""
        if b'"status"' in data:
            parsed = self._parse(data)
            if parsed is not None:
                self.contract = parsed
                return True
        rc = self.proc.poll()
        if rc is not None:
            self.exited_rc = rc
            c = self._parse(data)
            if c is None:
                reason = "no contract (sidecar exit %s)" % rc
                try:
                    with open(self.err_file, "rb") as f:
                        err = f.read(300).decode("utf-8", "replace")
                    err = " ".join(err.split())
                    if err:
                        reason = "%s: %s" % (reason, err[:120])
                except OSError:
                    pass
                self.contract = ("error", rc, reason)
            else:
                self.contract = c
            return True
        if time.monotonic() > self.deadline:
            try:
                self.proc.kill()
            except Exception:
                pass
            self.contract = ("error", 124, "start deadline exceeded")
            return True
        return False

    def _parse(self, data):
        try:
            d = json.loads(data.decode("utf-8", "replace"))
        except (ValueError, UnicodeDecodeError):
            return None
        if not isinstance(d, dict) or d.get("schema_version") != 1:
            return None
        status = d.get("status")
        run_id = d.get("run_id")
        run_dir = d.get("run_dir")
        if status not in ("started", "already_running"):
            return None
        if not isinstance(run_id, str) or not RUN_ID_RE.match(run_id) \
                or not isinstance(run_dir, str) or not run_dir:
            return None
        return (status, run_id, run_dir)

    def cleanup(self, kill=False):
        if kill:
            try:
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:
                pass
        for f in (self.out_file, self.err_file):
            try:
                os.unlink(f)
            except OSError:
                pass


class StopSidecar:
    """`agent-observability stop --stop-status <s>` (runs to completion)."""

    def __init__(self, stop_status):
        self.out_file = tempfile.mktemp(prefix="fg-relay-stop-out.")
        self.err_file = tempfile.mktemp(prefix="fg-relay-stop-err.")
        with open(self.out_file, "wb") as of, open(self.err_file, "wb") as ef:
            self.proc = subprocess.Popen(
                [OBSCTL, "stop", "--stop-status", stop_status],
                stdin=subprocess.DEVNULL, stdout=of, stderr=ef)
        self.stop_status = stop_status
        self.deadline = time.monotonic() + STOP_WAIT
        self.rc = None

    def poll(self):
        if self.rc is not None:
            return True
        rc = self.proc.poll()
        if rc is not None:
            self.rc = rc
            return True
        if time.monotonic() > self.deadline:
            try:
                self.proc.kill()
                self.rc = self.proc.wait()
            except Exception:
                self.rc = 124
            return True
        return False

    def cleanup(self):
        try:
            self.proc.kill()
            self.proc.wait(timeout=5)
        except Exception:
            pass
        for f in (self.out_file, self.err_file):
            try:
                os.unlink(f)
            except OSError:
                pass


# --------------------------------------------------------------- relay ----

class Relay:
    def __init__(self, delegate, args):
        self.delegate = delegate
        self.args = args
        self.child = None
        self.child_stdout_eof = False
        self.stdin_open = True
        self.capture_available = os.path.isfile(OBSCTL) and os.access(OBSCTL, os.X_OK)
        # session_id -> state dict:
        #   state: "idle" (tracked, no active turn) | "pending" (turn start
        #          in flight) | "open" (turn active, run live) |
        #          "finalizing" (turn stop in flight) | "uncaptured" (no run
        #          for the current turn) | "closed" (session released)
        #   run_id: the active/last turn's run id
        #   turn_id: the prompt request id of the active turn (None between
        #            turns)
        #   start: StartSidecar|None, stop: StopSidecar|None
        #   stop_status: finalization status already decided for the active
        #                turn ("graceful"|"interrupted") by a prompt
        #                response or a session close that arrived before
        #                the run came up; None while undecided
        #   closed: session/close|delete arrived
        self.sessions = {}
        self.forwarded_sig = set()
        self._pending_news = {}
        self._pending_prompts = {}   # prompt request id -> session id
        self._prompt_ids = {}        # recently seen prompt ids (bounded)
        self._events = EventLog(RELAY_LOG)
        # Prompt-readiness gate (see module docstring, "Readiness
        # ordering"): a capturable session/prompt line is HELD — never
        # modified, never dropped — until its start contract confirms
        # the collector is accepting OTLP. _gate_sid names the deciding
        # session (None = stream open); _held_prefix is the gating line
        # (already observed at hold time); _held_buf holds the raw bytes
        # that arrived while the gate was engaged (unobserved — they
        # re-enter the normal line path on release).
        self._gate_sid = None
        self._held_prefix = b""
        self._held_buf = b""
        self._hold_requested = False
        self._hold_line = b""
        # Pump-side line reassembly (client direction). The bound is the
        # framer's MAX_LINE: a line beyond it is streamed through
        # unobserved — never observed, never captured, never gated —
        # exactly like the framer's oversized-line skip.
        self._cl_buf = b""
        self._cl_skip = False
        self._framer_in = None
        self.child_in_fd = None
        # Route the module-level log() through the same bounded sink so
        # every diagnostic lands on stderr AND in the git-ignored file.
        global _EVENT_LOG
        _EVENT_LOG = self._events

    # ----- lifecycle transitions (called from the observer callbacks) ----

    def on_client_message(self, msg):
        method = msg.get("method")
        if not isinstance(method, str):
            return
        # Bounded observation record: method name + request id ONLY.
        self._events.write("client-request method=%s id=%s"
                           % (method, _fmt_id(msg.get("id"))))
        params = msg.get("params")
        params = params if isinstance(params, dict) else {}
        sid = params.get("sessionId")
        if method in OPEN_RESPONSE_METHODS:
            if msg.get("id") is None:
                # A request without an id cannot be correlated to its
                # response: record and skip (never invent a session id).
                self._events.write("open-ignored method=%s reason=no-id" % method)
                return
            self._remember_pending_new(msg.get("id"), method)
        elif method in OPEN_PARAM_METHODS:
            if valid_id(sid):
                self.open_session(sid, via=method)
        elif method in CLOSE_METHODS:
            if valid_id(sid):
                self.close_session(sid)
        elif method == PROMPT_METHOD:
            if self.on_prompt_request(sid, msg.get("id")):
                # A NEW capture turn started for this line: the collector
                # must be confirmed accepting OTLP BEFORE the line's bytes
                # reach the Codex child (ordering invariant). Signal the
                # pump to hold the line until the start contract resolves.
                self._gate_sid = sid
                return "HOLD"

    def on_server_message(self, msg):
        if "method" in msg:
            # server->client notifications: record the method name except
            # the high-volume session/update stream (never its params).
            m = msg.get("method")
            if isinstance(m, str) and m != "session/update":
                self._events.write("server-notification method=%s" % m)
            return
        mid = msg.get("id")
        if mid is None:
            return
        if mid in self._pending_prompts:
            # The matching session/prompt response: prompt-turn completion.
            # Only the request id, the session id, and stopReason are read.
            # The id STAYS in _prompt_ids so a late/duplicate response with
            # the same id is still caught by the check below (bounded
            # "turn-response-late" no-op) instead of vanishing silently.
            sid = self._pending_prompts.pop(mid)
            self.on_prompt_response(sid, mid, msg)
            return
        if mid in self._prompt_ids:
            # A late/duplicate response for an already-settled prompt turn:
            # bounded no-op record; never touches any run.
            self._events.write("turn-response-late id=%s" % _fmt_id(mid))
            return
        if "error" in msg:
            self._events.write("server-error id=%s" % _fmt_id(mid))
            return
        via = self._pending_news.pop(mid, None)
        if via is None:
            return
        result = msg.get("result")
        if isinstance(result, dict):
            sid = result.get("sessionId")
            if valid_id(sid):
                self.open_session(sid, via=via)
            else:
                self._events.write("open-no-session-id method=%s" % via)
        else:
            self._events.write("open-response-incomplete method=%s" % via)

    def _remember_pending_new(self, mid, via):
        # Bounded: a handful of in-flight open requests at most.
        if len(self._pending_news) > 16:
            self._pending_news.pop(next(iter(self._pending_news)), None)
        self._pending_news[mid] = via

    def _remember_pending_prompt(self, mid, sid):
        # Bounded: a handful of in-flight prompt turns at most.
        if len(self._pending_prompts) > 16:
            self._pending_prompts.pop(next(iter(self._pending_prompts)), None)
        self._pending_prompts[mid] = sid
        if len(self._prompt_ids) > 32:
            self._prompt_ids.pop(next(iter(self._prompt_ids)), None)
        self._prompt_ids[mid] = sid

    def _framer_skipped(self, direction):
        def _cb():
            # One bounded diagnostic per oversized line; observation
            # resumes on the next line (never a stream-wide bypass).
            self._events.write("frame-skipped dir=%s reason=line-oversized"
                               % direction)
        return _cb

    def _framer_error(self, direction):
        def _cb(msg):
            self._events.write("observe-error dir=%s %s" % (direction, msg))
        return _cb

    # ----- prompt-turn boundary --------------------------------------------

    @staticmethod
    def _new_session_state():
        return {"state": "idle", "run_id": None, "turn_id": None,
                "start": None, "stop": None, "stop_status": None,
                "closed": False, "turn_started_at": None,
                "shadow": None, "shadow_error_logged": False}

    def open_session(self, sid, via="session/new"):
        st = self.sessions.get(sid)
        if st is not None and st["state"] in ("idle", "pending", "open",
                                              "finalizing", "uncaptured"):
            # The same session id is still live on this connection
            # (duplicate open, or a re-send while the first open is in
            # flight): idempotent, identity tracking only. A previously
            # CLOSED id is NOT live: re-opening it (session/resume /
            # session/load / session/new with a recycled id) is a fresh
            # root ACP session and is tracked as such. No run starts here
            # in any case — only a prompt turn does.
            self._events.write("session-open-ignored session=%s via=%s "
                               "reason=already-tracked state=%s"
                               % (sid, via, st["state"]))
            return
        self.sessions[sid] = self._new_session_state()
        self._events.write("session-open session=%s via=%s state=idle"
                           % (sid, via))

    def on_prompt_request(self, sid, mid):
        """Observe one session/prompt request. Returns True iff a NEW
        capture turn was started for it — the pump then holds the line:
        the collector must be confirmed accepting before the prompt
        bytes reach the Codex child (readiness ordering)."""
        if mid is None:
            # A prompt without a request id cannot be correlated to its
            # response: never start a run for it (bounded record only —
            # the prompt body itself is never read).
            self._events.write("prompt-ignored session=%s reason=no-id"
                               % (sid if valid_id(sid) else "none"))
            return False
        if not valid_id(sid):
            self._events.write("prompt-ignored id=%s reason=bad-session-id"
                               % _fmt_id(mid))
            return False
        return self.start_turn(sid, mid)

    def start_turn(self, sid, mid):
        st = self.sessions.get(sid)
        if st is None:
            # A prompt for a session this connection has not tracked (e.g.
            # opened before observation started): track it on sight.
            st = self.sessions[sid] = self._new_session_state()
            self._events.write("session-seen session=%s via=session/prompt"
                               % sid)
        if st["state"] in ("pending", "open", "finalizing"):
            # One turn at a time per session (ACP serializes prompts per
            # session): a prompt while a turn is in progress is not
            # captured. Bounded record, stream untouched.
            self._events.write("prompt-ignored session=%s id=%s "
                               "reason=turn-in-progress state=%s"
                               % (sid, _fmt_id(mid), st["state"]))
            return False
        if st["state"] == "closed":
            # A prompt to a closed session is a protocol violation:
            # never resurrect a run.
            self._events.write("prompt-ignored session=%s id=%s "
                               "reason=session-closed"
                               % (sid, _fmt_id(mid)))
            return False
        # state is "idle" or "uncaptured": a new prompt turn.
        if not self.capture_available:
            st["state"] = "uncaptured"
            self._events.write("turn-uncaptured session=%s id=%s "
                               "reason=control-surface-unavailable"
                               % (sid, _fmt_id(mid)))
            return False
        # Authoritative turn timing: the relay's monotonic clock at the
        # moment the prompt turn is observed (the segment-elapsed source
        # for the live shadow warning — never SSE count, mtime, or
        # token counters).
        st["turn_started_at"] = time.monotonic()
        self._remember_pending_prompt(mid, sid)
        st["state"] = "pending"
        st["turn_id"] = mid
        st["run_id"] = None
        # sid is the native Codex conversation id (validated above). It is
        # persisted into the run manifest by the start sidecar at seed
        # time, so the captured conversation identity is durable even
        # after the transient mapping is released.
        st["start"] = StartSidecar(sid)
        st["stop"] = None
        st["stop_status"] = None
        st["closed"] = False
        self._events.write("turn-start session=%s id=%s" % (sid, _fmt_id(mid)))
        return True

    def on_prompt_response(self, sid, mid, msg):
        st = self.sessions.get(sid)
        if st is None or st.get("turn_id") != mid:
            # A response whose request id does not match the session's
            # active turn (stale, duplicate, or foreign): never touches
            # any run.
            state = st["state"] if st is not None else "none"
            self._events.write("turn-response-unmatched session=%s id=%s "
                               "state=%s" % (sid, _fmt_id(mid), state))
            return
        result = msg.get("result")
        stop_reason = None
        if "error" in msg:
            # A JSON-RPC error ends the turn without a stopReason: the
            # turn did not complete.
            status = "interrupted"
        else:
            # Prompt-turn completion: read ONLY the stopReason (a bounded
            # enum string) — never result content.
            status = "graceful"
            if isinstance(result, dict):
                sr = result.get("stopReason")
                if isinstance(sr, str):
                    stop_reason = sr[:64]
        self._events.write("turn-response session=%s id=%s stop_reason=%s"
                           % (sid, _fmt_id(mid), stop_reason or "none"))
        self.finalize_turn(sid, mid, status)

    def finalize_turn(self, sid, mid, status):
        st = self.sessions[sid]
        if st["state"] == "pending":
            # The response arrived before the start sidecar resolved: the
            # run (once it comes up, if it does) finalizes with this
            # status. First-to-arrive wins: a session close that already
            # decided "interrupted" is kept.
            if st["stop_status"] is None:
                st["stop_status"] = status
            self._events.write("turn-response-pending session=%s id=%s "
                               "stop_status=%s"
                               % (sid, _fmt_id(mid), st["stop_status"]))
            return
        if st["state"] == "open":
            st["state"] = "finalizing"
            st["stop"] = StopSidecar(status)
            self._events.write("turn-finalize session=%s id=%s "
                               "stop_status=%s run=%s"
                               % (sid, _fmt_id(mid), status, st["run_id"]))
            return
        if st["state"] == "finalizing":
            # Duplicate response while the stop is already in flight.
            self._events.write("turn-finalize-ignored session=%s id=%s "
                               "reason=stop-in-flight"
                               % (sid, _fmt_id(mid)))
            return
        # "idle"/"uncaptured"/"closed": no run for this turn.
        self._events.write("turn-response-norun session=%s id=%s state=%s"
                           % (sid, _fmt_id(mid), st["state"]))

    def close_session(self, sid):
        st = self.sessions.get(sid)
        if st is None:
            # Unknown or already-released session (duplicate close, or a
            # session this connection never owned): never touch any other
            # run. The mapping file, if any, is left for its owner.
            self._events.write("close-unknown session=%s" % sid)
            return
        if st["state"] == "pending":
            # Close arrived while the turn's start is in flight: the turn
            # did not complete; first-to-arrive wins the final status.
            st["closed"] = True
            if st["stop_status"] is None:
                st["stop_status"] = "interrupted"
            self._events.write("close-pending session=%s — will finalize as %s"
                               % (sid, st["stop_status"]))
            return
        if st["state"] == "open" and st["stop"] is None:
            # A turn is active but its prompt response never arrived:
            # close is a CLEANUP boundary — the turn did not complete, so
            # it finalizes as interrupted (never graceful).
            st["closed"] = True
            st["state"] = "finalizing"
            st["stop"] = StopSidecar("interrupted")
            self._events.write("close-launched session=%s run=%s stop_status=interrupted"
                               % (sid, st["run_id"]))
            return
        if st["state"] == "finalizing":
            # A finalization is already in flight: it is exactly-once, but
            # this close still RELEASES the session state once it
            # completes (so a later re-open is a fresh root ACP session).
            st["closed"] = True
            self._events.write("close-ignored session=%s reason=finalizing"
                               % sid)
            return
        # "idle"/"uncaptured"/"closed": no active turn, no run — release
        # the session state only (a normal run never needed this).
        st["state"] = "closed"
        self._events.write("session-closed session=%s (no active turn — "
                           "nothing to finalize)" % sid)

    # ----- sidecar bookkeeping (called from the pump loop) ----------------

    def process_sidecars(self):
        for sid, st in list(self.sessions.items()):
            start = st.get("start")
            if start is not None and start.poll():
                st["start"] = None
                status, run_id, extra = start.contract
                start.cleanup(kill=status != "started")
                if status == "started":
                    self._events.write("start-result session=%s status=started run=%s"
                                       % (sid, run_id))
                    st["run_id"] = run_id
                    # Live shadow warning host (diagnostic only): the
                    # tracker reads this run's raw log files
                    # incrementally and may append at most ONE bounded
                    # shadow-warning event for the turn. It never
                    # touches the ACP stream or the collector.
                    self._start_shadow_tracking(sid, st, run_id, run_dir=extra)
                    if st["stop_status"] is not None:
                        # The turn already ended (prompt response or
                        # session close) while the run was coming up:
                        # finalize it immediately. No mapping write: the
                        # turn is over, so nothing resolves to it, and the
                        # run is released moments later.
                        st["state"] = "finalizing"
                        st["stop"] = StopSidecar(st["stop_status"])
                        self._events.write("turn-finalize-during-start session=%s "
                                           "run=%s stop_status=%s"
                                           % (sid, run_id, st["stop_status"]))
                        continue
                    try:
                        write_mapping(sid, run_id)
                        self._events.write("mapping-written session=%s run=%s"
                                           % (sid, run_id))
                    except Exception:
                        # Fail open: the run is live but the turn is not
                        # captured (no mapping). It finalizes on the prompt
                        # response, a session close, or child exit.
                        st["state"] = "open"
                        self._events.write("mapping-write-failed session=%s run=%s — "
                                           "turn not captured" % (sid, run_id))
                        continue
                    st["state"] = "open"
                elif status == "already_running":
                    st["state"] = "uncaptured"
                    st["turn_id"] = None
                    self._events.write("start-result session=%s status=already_running "
                                       "run=%s — turn not captured: a capture already "
                                       "runs (one observed turn at a time)"
                                       % (sid, extra))
                else:  # error / timeout
                    self._events.write("start-error session=%s rc=%s reason=%s"
                                       % (sid, run_id, str(extra)[:160]))
                    self._handle_start_error(sid, st, start, extra)
            stop = st.get("stop")
            if stop is not None and stop.poll():
                st["stop"] = None
                stop.cleanup()
                if stop.rc == 0:
                    remove_mapping(sid)
                    st["state"] = "closed" if st["closed"] else "idle"
                    st["turn_id"] = None
                    self._clear_shadow(st)
                    self._events.write("stop-result session=%s stop_status=%s rc=0 "
                                       "run=%s mapping=released"
                                       % (sid, stop.stop_status, st["run_id"]))
                else:
                    # The turn itself is over (its prompt response or close
                    # already arrived); keep the mapping so agent-side
                    # resolution still finds the run and a later stop can
                    # re-finalize. The raw evidence is untouched.
                    st["state"] = "idle"
                    st["turn_id"] = None
                    self._clear_shadow(st)
                    self._events.write("stop-result session=%s stop_status=%s rc=%s "
                                       "run=%s mapping=kept-for-retry"
                                       % (sid, stop.stop_status, stop.rc, st["run_id"]))

    def _handle_start_error(self, sid, st, sidecar, detail):
        # Deadline / contract failure: the run may or may not be live.
        # If the port was free before we started and is live now, the run
        # is ours (no one else could bind the port): adopt it via the
        # deterministic resolver, or clean it up if we cannot name it.
        state = probe_running_state()
        if state == "running" and sidecar.owned_port:
            rc, out, _ = run_bounded([OBSCTL, "current-run"], timeout=30)
            run_id = out.decode("utf-8", "replace").strip()
            if rc == 0 and RUN_ID_RE.match(run_id):
                if st["stop_status"] is not None:
                    # The turn already ended: finalize the adopted run
                    # with the decided status.
                    st["run_id"] = run_id
                    self._stop_sync(sid, st, st["stop_status"])
                    return
                try:
                    write_mapping(sid, run_id)
                    st["state"] = "open"
                    st["run_id"] = run_id
                    self._start_shadow_tracking(sid, st, run_id)
                    log("session %s turn captured after start deadline (run %s)" % (sid, run_id))
                    return
                except Exception:
                    pass
                self._stop_sync(sid, st, "interrupted")
                return
            else:
                # A live run we cannot name: it is still ours (port was
                # free before) — stop it so it cannot orphan.
                self._stop_sync(sid, st, "interrupted")
                return
        st["state"] = "uncaptured"
        st["turn_id"] = None
        log("session %s turn not captured: %s" % (sid, str(detail)[:160]))

    def _stop_sync(self, sid, st, stop_status):
        try:
            rc, _, err = run_bounded(
                [OBSCTL, "stop", "--stop-status", stop_status], timeout=STOP_WAIT + 30)
        except Exception:
            rc = 1
            err = b""
        if rc == 0:
            remove_mapping(sid)
            st["state"] = "closed" if st["closed"] else "idle"
            st["turn_id"] = None
            self._clear_shadow(st)
            log("session %s turn finalized (%s); run %s" % (sid, stop_status, st["run_id"]))
        else:
            st["state"] = "idle"
            st["turn_id"] = None
            self._clear_shadow(st)
            log("session %s: finalization failed (stop exit %s) — run %s; %s"
                % (sid, rc, st["run_id"], " ".join(err.decode("utf-8", "replace").split())[:160]))

    # ----- live shadow warning (diagnostic only) --------------------------

    def _start_shadow_tracking(self, sid, st, run_id, run_dir=None):
        # Host the live pathological-generation shadow warning for this
        # captured turn (diagnostic only — see module docstring and
        # docs/agent/OBSERVABILITY.md, "Live pathological-generation
        # shadow warning"). Any failure degrades to "no shadow
        # warning"; the turn and the ACP stream are never affected.
        if shadow_warning is None:
            return
        if run_dir is None:
            run_dir = os.path.join(RUNS_DIR, run_id)
        try:
            st["shadow"] = shadow_warning.ShadowWarningTracker(
                conversation_id=sid,
                run_id=run_id,
                run_dir=run_dir,
                turn_start=st.get("turn_started_at"),
                on_warning=lambda warning: self._shadow_warning_event(
                    sid, st, warning),
                on_error=lambda reason: self._shadow_error_event(
                    sid, st, reason))
        except Exception:
            st["shadow"] = None
            self._events.write("shadow-warning-read-error session=%s "
                               "run=%s reason=init-failure" % (sid, run_id))

    def _clear_shadow(self, st):
        # The turn is over (finalized, whatever the outcome): release
        # the tracker (bounded memory) — no more warnings for it.
        if st.get("shadow") is not None:
            st["shadow"] = None
            st["shadow_error_logged"] = False

    def _evaluate_shadow(self):
        # Live diagnostic evaluation, called from the pump loop. The
        # tracker rate-limits itself to at most one raw-telemetry
        # inspection every 60 s per turn; this call is otherwise a
        # bounded no-op. Never raises: the ACP pump is the contract.
        if shadow_warning is None:
            return
        now = time.monotonic()
        for sid, st in list(self.sessions.items()):
            if st.get("shadow") is None:
                continue
            if st["state"] not in ("open", "finalizing"):
                continue
            try:
                st["shadow"].maybe_evaluate(now)
            except Exception:
                # Belt and braces (the tracker already fails open):
                # one bounded diagnostic per error state.
                if not st.get("shadow_error_logged"):
                    st["shadow_error_logged"] = True
                    self._events.write("shadow-warning-read-error "
                                       "session=%s run=%s reason=unexpected"
                                       % (sid, st.get("run_id")))

    def _shadow_warning_event(self, sid, st, warning):
        # The one-shot live warning: bounded identifiers + integer
        # counters only. all_reasoning=true / tools=0 are implied by
        # the predicate (the warning fires only when both hold).
        self._events.write("shadow-warning session=%s run=%s "
                           "elapsed_s=%d sse_events=%d all_reasoning=true "
                           "tools=0 api=%d"
                           % (sid, st.get("run_id"), warning["elapsed_s"],
                              warning["sse_events"], warning["api"]))

    def _shadow_error_event(self, sid, st, reason):
        # At most one per turn/error state (enforced by the tracker):
        # the bounded error class name — never a path or payload.
        self._events.write("shadow-warning-read-error session=%s run=%s "
                           "reason=%s"
                           % (sid, st.get("run_id"), str(reason)[:64]))

    # ----- child exit / fallback ------------------------------------------

    def wait_sidecars_settled(self, deadline_s=30):
        deadline = time.monotonic() + deadline_s
        while time.monotonic() < deadline:
            pending = []
            for st in self.sessions.values():
                if st.get("start") is not None:
                    st["start"].poll()
                if st.get("stop") is not None:
                    st["stop"].poll()
                if st.get("start") is not None or st.get("stop") is not None:
                    pending.append(st)
            if not pending:
                return
            time.sleep(0.2)
        for st in self.sessions.values():
            if st.get("start") is not None:
                st["start"].cleanup()
            if st.get("stop") is not None:
                st["stop"].cleanup()

    def finalize_open_sessions(self, child_rc):
        if not self.capture_available:
            return
        open_turns = [
            (sid, st) for sid, st in self.sessions.items()
            if st["state"] in ("open", "finalizing", "pending")
        ]
        if not open_turns:
            return
        log("child exited (%s); finalizing %d active prompt turn(s)"
            % (child_rc, len(open_turns)))
        for sid, st in open_turns:
            stop = st.get("stop")
            if stop is not None:
                # A finalization was already in flight: let it finish.
                while not stop.poll():
                    time.sleep(0.1)
                stop.cleanup()
                if stop.rc == 0:
                    remove_mapping(sid)
                    st["state"] = "closed"
                    self._clear_shadow(st)
                else:
                    st["state"] = "idle"
                    self._clear_shadow(st)
                continue
            if st["state"] == "pending" and st.get("start") is not None:
                st["start"].cleanup()
                st["start"] = None
            if st["run_id"] is None:
                # Run never came up (or we lost its identity): the control
                # surface reconciles any orphaned run on the next start.
                st["state"] = "uncaptured"
                continue
            # The child died mid-turn: the turn did not complete — unless
            # a prompt response already decided the final status.
            self._stop_sync(sid, st, st["stop_status"] or "interrupted")

    def install_signal_handlers(self):
        def forward(signum, frame):
            try:
                if self.child is not None and self.child.poll() is None \
                        and signum not in self.forwarded_sig:
                    os.kill(self.child.pid, signum)
                    self.forwarded_sig.add(signum)
            except Exception:
                pass

        try:
            signal.signal(signal.SIGTERM, forward)
            signal.signal(signal.SIGHUP, forward)
        except Exception:
            pass
        # SIGINT: reset to the OS default. A signal ignored at entry cannot
        # be trapped; the delegate keeps its own Ctrl-C semantics via the
        # exec shim. If INT reaches the relay, the relay dies and open runs
        # are reconciled as interrupted on the next start/stop (the
        # control surface's pre-existing orphan property).
        try:
            signal.signal(signal.SIGINT, signal.SIG_DFL)
        except Exception:
            pass

    # ----- prompt-readiness gate (collector accepting before forwarding) --

    def _on_client_hold(self, raw_line):
        # The framer's hold signal: the just-observed line started a new
        # capture turn. The pump queues the EXACT wire bytes (they are
        # NOT forwarded until the gate releases).
        self._hold_requested = True
        self._hold_line = raw_line

    def _forward_or_hold(self, line):
        if self._gate_sid is not None:
            self._held_buf += line
        else:
            self._write_all(self.child_in_fd, line)

    def _emit_client_line(self, line):
        # One COMPLETE client line (terminator included, within the
        # observation bound): observe it, then forward — UNLESS the
        # observation engaged the gate (a new capture turn started for
        # this line): then the line itself is held until the start
        # contract confirms collector readiness.
        self._hold_requested = False
        self._hold_line = b""
        self._framer_in.feed(line)
        if self._hold_requested and self._gate_sid is not None:
            self._hold_requested = False
            self._held_prefix += self._hold_line
            return
        self._forward_or_hold(line)

    def _feed_client(self, data):
        # Client stdin → child stdin, line-aware and gate-aware, but
        # BYTE-TRANSPARENT: every byte is forwarded exactly once, in
        # order. Only a capturable prompt line (and the lines behind it)
        # may be DELAYED by the readiness gate — never dropped, never
        # modified.
        if self._gate_sid is not None:
            # Gate engaged: hold everything; on release the held bytes
            # re-enter this same path (line splitting + per-line
            # decision), preserving the client's original order.
            self._held_buf += data
            return
        if self._cl_skip:
            # Inside an oversized line (beyond the observation bound):
            # stream the bytes through until its terminating newline.
            i = data.find(b"\n")
            if i < 0:
                self._write_all(self.child_in_fd, data)
                return
            head, data = data[:i + 1], data[i + 1:]
            self._cl_skip = False
            self._write_all(self.child_in_fd, head)
            if not data:
                return
        self._cl_buf += data
        maxline = NdjsonFramer.MAX_LINE
        while True:
            if self._gate_sid is not None:
                # A line earlier in this chunk engaged the gate: hold
                # the rest of the stream (order is preserved on release).
                self._held_buf += self._cl_buf
                self._cl_buf = b""
                return
            i = self._cl_buf.find(b"\n")
            if i < 0:
                break
            line = self._cl_buf[:i + 1]
            self._cl_buf = self._cl_buf[i + 1:]
            if len(line) > maxline + 1:
                # Complete line beyond the observation bound (the framer
                # would skip it: never observed, never captured, never
                # gated): forward as-is + the one bounded diagnostic.
                if self._framer_in.on_skipped:
                    self._framer_in.on_skipped()
                self._write_all(self.child_in_fd, line)
                continue
            self._emit_client_line(line)
        if len(self._cl_buf) > maxline:
            # The unterminated line is already beyond the observation
            # bound: it can no longer be observed; stream it through and
            # skip until its terminator (observation resumes there).
            if self._framer_in.on_skipped:
                self._framer_in.on_skipped()
            self._write_all(self.child_in_fd, self._cl_buf)
            self._cl_buf = b""
            self._cl_skip = True

    def _release_gate_if_resolved(self):
        # Called each pump tick after process_sidecars(): when the
        # gating turn's start sidecar has a FINAL contract (started /
        # already_running / error / timeout — consumed by
        # process_sidecars, which wrote the mapping for a "started"
        # turn), the gate is released: the held bytes go to the child
        # NOW, in order. Fail-open by construction: every terminal
        # outcome releases; the gate only ever DELAYS, never drops.
        sid = self._gate_sid
        if sid is None:
            return
        st = self.sessions.get(sid)
        if st is not None and st.get("start") is not None:
            return  # the start contract is not final yet
        self._gate_sid = None
        held = len(self._held_prefix) + len(self._held_buf)
        self._events.write("gate-released session=%s held_bytes=%d"
                           % (sid, held))
        prefix, buf = self._held_prefix, self._held_buf
        self._held_prefix = b""
        self._held_buf = b""
        if prefix:
            # The gating line was already observed at hold time: forward
            # it as-is (observing it again would double-log the turn).
            self._write_all(self.child_in_fd, prefix)
        if buf:
            self._feed_client(buf)

    # ----- main pump ---------------------------------------------------------

    def run(self):
        self._pending_news = {}
        # First diagnostic of the process lifetime: if a real session
        # still shows no run/mapping AND this file has no
        # relay-started line, the failure boundary is upstream of the
        # relay (trampoline / product-launch — the client never invoked
        # the installed entrypoint, or the wrapper degraded to a direct
        # exec). If relay-started is present, the boundary is in the
        # observed method flow below.
        self._events.write("relay-started pid=%d obsctl=%s"
                           % (os.getpid(), OBSCTL))
        if not self.capture_available:
            log("control surface not available at %s — transparent passthrough only" % OBSCTL)
        if shadow_warning is None:
            # Diagnostic-only capability lost; the relay itself is
            # unaffected (one bounded note).
            log("live shadow warning unavailable (module load failed) — diagnostic only")
        child_argv = [sys.executable, "-c", SHIM, self.delegate] + list(self.args)
        self.child = subprocess.Popen(
            child_argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.install_signal_handlers()

        framer_in = NdjsonFramer(self.on_client_message,
                                 on_error=self._framer_error("in"),
                                 on_skipped=self._framer_skipped("in"),
                                 on_hold=self._on_client_hold)
        framer_out = NdjsonFramer(self.on_server_message,
                                  on_error=self._framer_error("out"),
                                  on_skipped=self._framer_skipped("out"))
        child_in_fd = self.child.stdin.fileno()
        child_out_fd = self.child.stdout.fileno()
        out_fd = sys.stdout.fileno()
        self._framer_in = framer_in
        self.child_in_fd = child_in_fd

        try:
            while True:
                self.process_sidecars()
                self._evaluate_shadow()
                self._release_gate_if_resolved()
                rlist = [child_out_fd]
                if self.stdin_open:
                    rlist.insert(0, 0)
                r, _, _ = select.select(rlist, [], [], 0.2)
                if 0 in r and self.stdin_open:
                    data = os.read(0, CHUNK)
                    if data:
                        self._feed_client(data)
                    else:
                        # Client closed the stream: half-close the child's
                        # stdin (the ACP server sees EOF and will exit).
                        try:
                            self.child.stdin.close()
                        except Exception:
                            pass
                        self.stdin_open = False
                if child_out_fd in r:
                    data = os.read(child_out_fd, CHUNK)
                    if data:
                        self._write_all(out_fd, data)
                        framer_out.feed(data)
                    else:
                        self.child_stdout_eof = True
                if self.child.poll() is not None and self.child_stdout_eof:
                    break
        finally:
            try:
                self.child.stdin.close()
            except Exception:
                pass
            try:
                self.child.stdout.close()
            except Exception:
                pass
        child_rc = self.child.wait()
        # Normalize Python's negative signal-death return codes to the
        # shell convention (128+signal) so the launcher's status is
        # preserved exactly as the client expects.
        if child_rc is None:
            child_rc = 143
        elif child_rc < 0:
            child_rc = 128 + (-child_rc)
        self.wait_sidecars_settled()
        # Consume any sidecar contract that resolved during the settle
        # wait (e.g. a start that finished in the same instant the child
        # exited): processing is what writes the mapping, records the
        # event, and names the run — without it a live run would be
        # orphaned and the diagnostic trail would show a bare
        # "pending -> uncaptured" with no start result.
        self.process_sidecars()
        self.finalize_open_sessions(child_rc)
        open_left = sum(1 for st in self.sessions.values()
                        if st["state"] in ("pending", "open", "finalizing"))
        self._events.write("relay-exited child_rc=%d open_sessions=%d"
                           % (child_rc, open_left))
        return child_rc

    @staticmethod
    def _write_all(fd, data):
        view = memoryview(data)
        while view:
            n = os.write(fd, view)
            view = view[n:]


def main():
    argv = sys.argv[1:]
    delegate = None
    if argv and argv[0] == "--delegate":
        if len(argv) < 2:
            sys.stderr.write(LOG_PREFIX + "ERROR: --delegate requires a path\n")
            return 2
        delegate = argv[1]
        argv = argv[2:]
    if delegate is None or not os.path.isabs(delegate) or not os.path.isfile(delegate):
        sys.stderr.write(LOG_PREFIX + "ERROR: delegate must be an absolute path to the original launcher\n")
        return 2
    relay = Relay(delegate, argv)
    try:
        return relay.run()
    except Exception as exc:
        # Never write to stdout (ACP purity); one bounded line on stderr.
        sys.stderr.write(LOG_PREFIX + "ERROR: relay failure (%s: %s) — stream may be truncated\n"
                         % (exc.__class__.__name__, str(exc)[:200]))
        return 1


if __name__ == "__main__":
    sys.exit(main())
