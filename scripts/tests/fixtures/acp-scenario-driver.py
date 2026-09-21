#!/usr/bin/env python3
"""
Test fixture: scenario driver for the agent-product-launch lifecycle tests.

Drives the repository's product-launch wrapper (with the fake ACP server as
delegate) through real ACP JSON-RPC traffic (newline-delimited JSON-RPC
framing — the real ACP stdio wire format) and asserts the per-PROMPT-TURN
observability lifecycle on the filesystem.

The run boundary is the session/prompt turn (ACP defines the prompt
request -> foreground work -> response-with-stopReason as prompt-turn
completion); the ACP session stays open across turns and is only a
persistent grouping dimension:

  prompt request  -> run starts (+ mapping for the active turn)
  prompt response -> run finalizes (graceful; end Git evidence, ledger,
                     mapping released) — the session stays open
  session close   -> cleanup ONLY: finalizes an unexpectedly open turn as
                     interrupted; never required for normal completion
  process crash   -> an active turn finalizes as interrupted

Scenarios (one process per scenario; prints ok/FAIL lines; exit 1 on any
failure):
  prompt-turn      one persistent session: prompt A -> run A; response A ->
                   run A graceful (end evidence, ledger, mapping released);
                   session still alive WITHOUT any close; prompt B ->
                   distinct run B; response B -> run B graceful; during a
                   turn, current-run / context current resolve the active
                   turn's run; exactly two runs; marker content never
                   persisted; fragmented stream stays valid ACP.
  id-correlation   exact request-id correlation: a forged response with a
                   wrong id never finalizes; the forged response with the
                   EXACT prompt id finalizes; the late real response (same
                   id) is a bounded no-op (no second finalization/run).
  close-cleanup    close is cleanup only: idle-session close finalizes
                   nothing; close during an active turn -> interrupted;
                   the late real response is a no-op; duplicate + unknown
                   closes harmless.
  crash-interrupted process crash DURING an active prompt -> run finalizes
                   as interrupted, no orphan collector, exit status kept.
  no-session       process without any session -> no run; a session without
                   a prompt also never creates a run.
  concurrency      a foreign live capture -> the prompt turn fails open
                   (never attached); after the foreign run ends, the SAME
                   session's next prompt is captured.
  verify-correlation agent-verify --summary-json during a turn attributes
                   to the active turn's run (CODEX_SESSION_ID + mapping;
                   explicit id overrides; mapping wins over a newer live
                   run — no newest-run guessing); the turn-finalization
                   ledger consumes the summary.
  opt-out          FG_AGENT_OBSERVABILITY=0 -> direct launch, no relay,
                   no capture, no diagnostics (prompts included).
  stale-runid      inherited stale FG_AGENT_RUN_ID is dropped; the turn's
                   run is the fresh mapped one.
  exit-status      child exit code preserved (no session; and mid-turn,
                   with the active turn finalizing as interrupted).
  signal-terminated SIGTERM to the launch path mid-turn -> forwarded, the
                   active turn finalizes as interrupted, exit 143.
  fail-open        broken collector -> the prompt turn is uncaptured
                   (fail open), stream intact, bounded warning, no
                   secret/env leakage.
  doctor-snapshot  the doctor snapshot is stored for the turn's run.
  trampoline-session / trampoline-optout / raw-stream  (as before, on the
                   prompt-turn contract).
  session-reopen   session identity persists across close + re-open
                   (session/resume, session/load): every prompt turn gets
                   its own distinct run; fork -> new session id -> its own
                   runs.
  map-fail         mapping write failure fails OPEN: the run starts live,
                   the turn is uncaptured (bounded diagnostic), and the
                   prompt response still finalizes the run gracefully.
  ndjson-wire      the REAL ACP wire format regression: NDJSON
                   initialize/session/new/prompt traffic is observed (no
                   framer bypass); fragmented reads; several JSON-RPC
                   lines in one write; an oversized line skipped for that
                   line only (bounded diagnostic, no payload leakage,
                   observation resumes); a malformed line forwarded
                   without killing observation.
  ready-ordering   the collector-readiness ordering contract (Cases A/F/G):
                   collector accepting AT prompt receipt (runtime
                   observation), prompt bytes forwarded unchanged
                   (sha256 of the exact wire line), exactly-once, and the
                   child's first-request telemetry (fake OTLP POST at
                   prompt receipt) CAPTURED by the real collector.
  ready-delayed    Case B: a deliberately delayed collector (wrapper that
                   sleeps before binding) — the prompt stays unforwarded
                   for the whole delay window, then forwards exactly once
                   with the endpoint already accepting.
  ready-fail-exit  Case C: collector exits before readiness — bounded fast
                   failure, fail-open forwarding, no run, no mapping,
                   failure surfaced via the start contract.
  ready-fail-timeout Case D: collector alive but never ready — the bounded
                   startup budget fails the start, fail-open forwarding,
                   no orphaned run, no stale mapping.

All runtime artifacts stay in the --workdir temp dir; the real
.artifacts/agent-runs and product registration are never touched.
"""

import json
import os
import re
import select
import signal
import subprocess
import sys
import time

RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
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


# --------------------------------------------------------- NDJSON client --

def frame(obj):
    """One ACP stdio message: a newline-delimited JSON-RPC line."""
    return json.dumps(obj).encode("utf-8") + b"\n"


class Client:
    """ACP client over the wrapper's stdin/stdout pipes."""

    def __init__(self, proc):
        self.proc = proc
        self.buf = b""
        self.next_id = 0

    def send_raw(self, payload, fragment=0):
        if fragment and fragment > 0:
            for i in range(0, len(payload), fragment):
                self.proc.stdin.write(payload[i:i + fragment])
                self.proc.stdin.flush()
                time.sleep(0.002)
        else:
            self.proc.stdin.write(payload)
            self.proc.stdin.flush()

    def send(self, obj, fragment=0):
        self.send_raw(frame(obj), fragment)

    def request(self, method, params=None, fragment=0):
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method,
                   "params": params or {}}, fragment)
        return self.next_id

    def _try_message(self):
        while True:
            i = self.buf.find(b"\n")
            if i < 0:
                return None
            line, self.buf = self.buf[:i], self.buf[i + 1:]
            if line.endswith(b"\r"):
                line = line[:-1]
            if not line.strip():
                continue
            body = line
            try:
                return json.loads(body.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return {"__malformed__": True}

    def _read_more(self, timeout):
        r, _, _ = select.select([self.proc.stdout], [], [], timeout)
        if r:
            data = os.read(self.proc.stdout.fileno(), 65536)
            if data:
                self.buf += data
                return True
        return False

    def wait_response(self, mid, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self._try_message()
            while msg is not None:
                if msg.get("id") == mid:
                    return msg
                msg = self._try_message()
            if not self._read_more(0.5):
                rc = self.proc.poll()
                if rc is not None:
                    return None
        return None

    def wait_pong(self, timeout=30):
        mid = self.request("test/ping")
        msg = self.wait_response(mid, timeout)
        return bool(msg and isinstance(msg.get("result"), dict)
                    and msg["result"].get("pong") is True)


# ------------------------------------------------------------- launching --

def base_env(repo, workdir, scenario, extra=None):
    env = dict(os.environ)
    # Strip everything inherited from a real product session (the driver
    # itself may run inside one): the recursion guard, launch paths, and
    # any run identity — the scenarios control all of these explicitly.
    for v in ("CODEX_HOME", "CODEX_PATH", "CODEX_SESSION_ID",
              "FG_PRODUCT_CODEX_HOME", "FG_AGENT_RUN_ID",
              "FG_PRODUCT_OBS_IN_WRAPPER", "FG_PRODUCT_LAUNCH_STATE_DIR",
              "FG_PRODUCT_LAUNCH_ENTRYPOINT", "FG_PRODUCT_SESSION_MAP_DIR",
              "FG_PRODUCT_RELAY_OBSCTL", "FG_OBS_RUNS_DIR"):
        env.pop(v, None)
    env["FG_OBS_RUNS_DIR"] = os.path.join(workdir, "runs")
    env["FG_PRODUCT_SESSION_MAP_DIR"] = os.path.join(workdir, "map")
    env["FG_OBS_NO_DOCTOR_SNAPSHOT"] = "1"
    # Bounded relay diagnostics land in the isolated workdir, never in
    # the real .artifacts tree.
    env["FG_PRODUCT_RELAY_LOG"] = os.path.join(workdir, "relay-events.log")
    # Port isolation: the scenarios must never collide with a live
    # product-session collector (which owns the default port).
    env["FG_OBS_PORT"] = os.environ.get("FG_PL_TEST_PORT", "4319")
    env["FG_PRODUCT_LAUNCH_DELEGATE"] = os.path.join(
        repo, "scripts", "tests", "fixtures", "acp-fake-server.py")
    env["FAKE_SESSION_ID_PREFIX"] = "01%s" % scenario[:6]
    if extra:
        env.update(extra)
    return env


def launch(repo, workdir, scenario, extra=None, launcher=None, largs=None):
    env = base_env(repo, workdir, scenario, extra)
    err_path = os.path.join(workdir, scenario + ".err")
    err = open(err_path, "w")
    if launcher:
        argv = [launcher] + (largs or [])
    else:
        argv = ["/bin/bash", os.path.join(repo, "scripts", "agent-product-launch"), "launch"]
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=err,
        env=env)
    return proc, err_path


def shutdown(proc):
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            proc.wait(timeout=10)
        except Exception:
            pass


# ---------------------------------------------------------- fs predicates --

def runs_root(workdir):
    return os.path.join(workdir, "runs")


def list_runs(workdir):
    root = runs_root(workdir)
    if not os.path.isdir(root):
        return []
    return sorted(n for n in os.listdir(root)
                  if (n.startswith("run-") or n.startswith("probe-"))
                  and not os.path.islink(os.path.join(root, n))
                  and os.path.isdir(os.path.join(root, n)))


def run_dir(workdir, rid):
    return os.path.join(runs_root(workdir), rid)


def read_mapping(workdir, sid):
    p = os.path.join(workdir, "map", sid)
    try:
        with open(p) as f:
            v = f.read().strip()
        return v if RUN_ID_RE.match(v) else None
    except OSError:
        return None


def mapping_ids(workdir):
    d = os.path.join(workdir, "map")
    if not os.path.isdir(d):
        return []
    return sorted(n for n in os.listdir(d) if not n.startswith("."))


def manifest(workdir, rid):
    p = os.path.join(run_dir(workdir, rid), "capture-manifest.json")
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def collector_alive(workdir, rid):
    p = os.path.join(run_dir(workdir, rid), "collector.pid")
    try:
        with open(p) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # alive, other identity


def wait_for(cond, timeout, what):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(0.2)
    return False


# --------------------------------------------------- prompt-turn helpers --

def open_session(client, workdir, label, fragment=0, existing=()):
    """session/new; the prompt-turn contract: opening a session tracks the
    session IDENTITY only and starts NO run. `existing` names runs that
    already exist in the isolated runs dir (earlier turns); the check
    compares run sets instead of asserting emptiness. Returns the
    sessionId."""
    mid = client.request("session/new", {"cwd": "/tmp"}, fragment=fragment)
    msg = client.wait_response(mid)
    if not msg or not isinstance(msg.get("result"), dict):
        bad("%s: session/new response" % label)
        return None
    sid = msg["result"].get("sessionId")
    if not isinstance(sid, str) or not sid:
        bad("%s: session/new without sessionId" % label)
        return None
    time.sleep(1.0)  # give a (wrong) run start a chance to appear
    check("%s: session open starts NO run (the prompt is the boundary)" % label,
          list_runs(workdir) == sorted(existing)
          and read_mapping(workdir, sid) is None,
          "runs=%s existing=%s mapping=%r"
          % (list_runs(workdir), sorted(existing),
             read_mapping(workdir, sid)))
    return sid


def open_session_via(client, workdir, method, sid, label, fragment=0):
    """session/load or session/resume (sessionId in request params, no
    sessionId in the result): tracks the re-opened session identity and
    starts NO run. Returns True when the response is clean."""
    mid = client.request(method, {"sessionId": sid, "cwd": "/tmp",
                                  "mcpServers": []}, fragment=fragment)
    msg = client.wait_response(mid)
    good = bool(msg) and "result" in msg
    check("%s: %s response" % (label, method), good)
    time.sleep(1.0)
    check("%s: %s re-open starts NO run" % (label, method),
          read_mapping(workdir, sid) is None,
          "mapping=%r" % read_mapping(workdir, sid))
    return good


def send_prompt(client, sid, marker=None, fragment=0):
    """A session/prompt request; returns the prompt request id."""
    params = {"sessionId": sid,
              "prompt": [{"type": "text", "text": marker or "prompt turn"}]}
    return client.request("session/prompt", params, fragment=fragment)


def _mapping_live(workdir, sid):
    """The mapping's run id only when it names an existing run dir with a
    live collector; None otherwise (covers stale mappings from a
    just-finalized previous turn, which the relay releases on its next
    pump tick)."""
    rid = read_mapping(workdir, sid)
    if rid is None or not os.path.isdir(run_dir(workdir, rid)):
        return None
    return rid if collector_alive(workdir, rid) else None


def wait_run_live(workdir, sid, timeout=120):
    """Wait until the prompt turn's run is live: a mapping pointing at a
    live collector. Returns (run_id, live)."""
    ok_wait = wait_for(lambda: _mapping_live(workdir, sid) is not None,
                       timeout, None)
    rid = _mapping_live(workdir, sid)
    return rid, bool(ok_wait and rid is not None)


def start_turn(client, workdir, sid, label, marker=None):
    """session/prompt; wait for the turn's run to come up. Returns
    (prompt_id, run_id) — run_id may be None when the wait failed."""
    mid = send_prompt(client, sid, marker=marker)
    rid, live = wait_run_live(workdir, sid)
    check("%s: prompt -> run started + mapped (active turn)" % label,
          rid is not None and live,
          "mapping=%r" % rid)
    return mid, rid


def check_turn_finalized(workdir, sid, rid, label, stop_status):
    """Assert the response/close-driven finalization of a turn's run:
    manifest stop_status, end Git evidence, ledger, mapping released,
    collector stopped — and the persisted captured conversation identity:
    the relay records the ACP session's native Codex conversation id into
    the run manifest at start time; it must SURVIVE finalization and the
    release of the transient session/run mapping (durable, not transient),
    and the turn-finalization ledger must carry it."""
    if rid is None:
        bad("%s: no run id to check (earlier step failed)" % label)
        return None
    wait_for(lambda: (manifest(workdir, rid) or {}).get("stop_status")
             in ("graceful", "interrupted"), 90, None)
    m = manifest(workdir, rid)
    check("%s: run finalized (%s)" % (label, stop_status),
          bool(m) and m.get("stop_status") == stop_status,
          "manifest stop_status=%r" % ((m or {}).get("stop_status"),))
    check("%s: end git evidence" % label,
          bool(m) and m.get("end_ts") is not None and m.get("ending_head") is not None,
          "end_ts=%r ending_head=%r" % ((m or {}).get("end_ts"), (m or {}).get("ending_head")))
    check("%s: captured conversation identity persisted (after finalization)"
          % label,
          bool(m) and m.get("captured_conversation_id") == sid,
          "manifest captured_conversation_id=%r expected=%r"
          % ((m or {}).get("captured_conversation_id"), sid))
    ledger_path = os.path.join(run_dir(workdir, rid), "run-ledger.json")
    # The ledger is generated by the stop sidecar AFTER the manifest is
    # finalized, so its appearance (and the mapping release below) lag
    # the manifest status by the remaining stop work; wait (bounded).
    ledger_ok = wait_for(lambda: os.path.isfile(ledger_path), 30, None)
    check("%s: ledger generated" % label, bool(m) and ledger_ok,
          "ledger exists=%s" % os.path.isfile(ledger_path))
    if ledger_ok:
        try:
            with open(ledger_path) as f:
                ld = json.load(f)
            got = (ld.get("identity") or {}).get("captured_conversation_id")
        except (OSError, ValueError):
            ld, got = None, None
        check("%s: ledger carries the persisted captured conversation identity"
              % label,
              isinstance(ld, dict) and got == sid,
              "ledger captured_conversation_id=%r expected=%r" % (got, sid))
    released = wait_for(
        lambda: read_mapping(workdir, sid) is None
        and not collector_alive(workdir, rid), 20, None)
    check("%s: mapping released, collector stopped" % label, released,
          "mapping=%r collector=%s" % (read_mapping(workdir, sid),
                                       collector_alive(workdir, rid)))
    return m


def check_no_capture(workdir, label):
    check(label, list_runs(workdir) == [] and mapping_ids(workdir) == [],
          "runs=%s maps=%s" % (list_runs(workdir), mapping_ids(workdir)))


def content_leak(workdir, marker, err_path):
    """Paths that contain the prompt marker (privacy must keep them none)."""
    found = []
    for root in (runs_root(workdir), os.path.join(workdir, "map"), err_path,
                 relay_log_path(workdir)):
        if os.path.isdir(root):
            for dp, _, fns in os.walk(root):
                for fn in fns:
                    fp = os.path.join(dp, fn)
                    try:
                        with open(fp, "rb") as f:
                            if marker.encode() in f.read():
                                found.append(fp)
                    except OSError:
                        pass
        elif os.path.isfile(root):
            try:
                with open(root, "rb") as f:
                    if marker.encode() in f.read():
                        found.append(root)
            except OSError:
                pass
    return found


def forge_response(client, rid, stop_reason="end_turn", error=None):
    """Emit a FORGED server->client JSON-RPC response line (via the fake
    server) with the given request id; returns the ack request id."""
    params = {"id": rid}
    if stop_reason:
        params["stopReason"] = stop_reason
    if error:
        params["error"] = error
    return client.request("test/fake-response", params)


def relay_log_path(workdir):
    return os.path.join(workdir, "relay-events.log")


def relay_events(workdir):
    """All relay event lines (one bounded diagnostic per line), or []."""
    try:
        with open(relay_log_path(workdir)) as f:
            return [l for l in f.read().splitlines() if l.strip()]
    except OSError:
        return []


def has_event(workdir, fragment):
    return any(fragment in l for l in relay_events(workdir))


def prompt_receipts(fake_log):
    """The fake server's prompt-receipt observation lines, parsed:
    [{'n': int, 'ts': float, 'bytes': int, 'sha256': str,
      'port_listening': 'yes'|'no'|'n/a'}, ...] — one per session/prompt
    line the (fake) Codex child actually received."""
    out = []
    try:
        with open(fake_log) as f:
            for l in f.read().splitlines():
                if not l.startswith("prompt-received "):
                    continue
                d = {}
                for tok in l.split()[1:]:
                    k, _, v = tok.partition("=")
                    d[k] = v
                out.append(d)
    except OSError:
        pass
    return out


def fake_first_event_posted(fake_log):
    try:
        with open(fake_log) as f:
            for l in f.read().splitlines():
                if l.startswith("first-event-posted="):
                    return l.split("=", 1)[1]
    except OSError:
        pass
    return None


def obsctl_env(workdir, repo, scenario, session_id):
    """Environment for running the control surface against the scenario's
    isolated runs/mapping as the session's agent side (CODEX_SESSION_ID)."""
    env = base_env(repo, workdir, scenario)
    env["CODEX_SESSION_ID"] = session_id
    return env


def run_cmd_logged(argv, env, timeout=120):
    return subprocess.run(argv, env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, timeout=timeout)


# ------------------------------------------------------------- scenarios --

def start_capture_manual(repo, workdir):
    """Start a capture directly via the control surface; return the run id."""
    env = base_env(repo, workdir, "manual")
    p = subprocess.run(
        ["/bin/bash", os.path.join(repo, "scripts", "agent-observability"),
         "start", "--json"],
        env=env, stdin=subprocess.DEVNULL,
        capture_output=True, timeout=120)
    if p.returncode != 0:
        return None
    try:
        d = json.loads(p.stdout.decode("utf-8", "replace"))
        if d.get("status") == "started" and d.get("run_id"):
            return d["run_id"]
    except ValueError:
        pass
    return None


def stop_capture_manual(repo, workdir, stop_status=None):
    env = base_env(repo, workdir, "manual")
    argv = ["/bin/bash", os.path.join(repo, "scripts", "agent-observability"), "stop"]
    if stop_status:
        argv += ["--stop-status", stop_status]
    subprocess.run(argv, env=env, stdin=subprocess.DEVNULL,
                   capture_output=True, timeout=120)


def scenario_prompt_turn(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "promptturn"
    proc, err_path = launch(repo, workdir, s, extra={"FAKE_PROMPT_DELAY": "8"})
    try:
        c = Client(proc)
        mid = c.request("initialize", fragment=2)  # fragmented framing stress
        msg = c.wait_response(mid)
        check("t01a initialize round-trip (fragmented, valid ACP on stdout)",
              bool(msg) and msg.get("result", {}).get("protocolVersion") == 1)
        check("t01b no run before a session", list_runs(workdir) == [])
        sid = open_session(c, workdir, "t01c session A open (identity only)")
        if not sid:
            shutdown(proc)
            return
        # ---- prompt A -> run A (active turn) ----
        marker = "FG_RELAY_CONTENT_MARKER_%d" % os.getpid()
        mid_a, run_a = start_turn(c, workdir, sid, "t01d prompt A", marker=marker)
        check("t01e run id is fresh (run-*)",
              bool(run_a) and run_a.startswith("run-"), "run=%r" % run_a)
        # Captured identity persisted at RUN START (before finalization,
        # while the transient mapping is still live): the manifest carries
        # the ACP session's native Codex conversation id.
        m_a = manifest(workdir, run_a)
        check("t01e2 captured conversation identity persisted while the turn is live",
              bool(m_a) and m_a.get("captured_conversation_id") == sid,
              "manifest captured_conversation_id=%r expected=%r"
              % ((m_a or {}).get("captured_conversation_id"), sid))
        if not run_a:
            return
        # during the turn: resolution + context attach target the ACTIVE
        # turn's run (session identity is the grouping dimension)
        env = obsctl_env(workdir, repo, s, sid)
        p = run_cmd_logged(["/bin/bash",
                            os.path.join(repo, "scripts", "agent-observability"),
                            "current-run"], env)
        check("t01f during-turn current-run resolves the active turn's run",
              p.returncode == 0 and p.stdout.decode().strip() == run_a,
              "rc=%s out=%r expected=%s" % (p.returncode,
                                            p.stdout.decode().strip(), run_a))
        p = run_cmd_logged(["/bin/bash",
                            os.path.join(repo, "scripts", "agent-observability"),
                            "context", "current",
                            "--task-type", "Domain", "--session", "NEW"], env)
        check("t01g during-turn context current attaches to the active turn's run",
              p.returncode == 0
              and os.path.isfile(os.path.join(run_dir(workdir, run_a),
                                              "run-context.json")),
              "rc=%s err=%s" % (p.returncode,
                                p.stderr.decode().splitlines()[-1:] or ""))
        # ---- prompt response A -> run A finalized (NO session close) ----
        resp_a = c.wait_response(mid_a, 60)
        check("t01h prompt A response received (stopReason)",
              bool(resp_a) and isinstance(resp_a.get("result"), dict)
              and resp_a["result"].get("stopReason") == "end_turn",
              "resp=%r" % (resp_a,))
        check_turn_finalized(workdir, sid, run_a, "t01i prompt A response",
                             "graceful")
        check("t01j session A alive after its run finalized (no close sent)",
              c.wait_pong())
        # ---- prompt B -> distinct run B, same session ----
        mid_b, run_b = start_turn(c, workdir, sid, "t01k prompt B")
        check("t01l run B distinct from run A (same session)",
              bool(run_b) and run_b != run_a,
              "run_a=%s run_b=%s" % (run_a, run_b))
        if not run_b:
            return
        resp_b = c.wait_response(mid_b, 60)
        check("t01m prompt B response received (stopReason)",
              bool(resp_b) and isinstance(resp_b.get("result"), dict)
              and resp_b["result"].get("stopReason") == "end_turn")
        check_turn_finalized(workdir, sid, run_b, "t01n prompt B response",
                             "graceful")
        check("t01o session A still alive after turn B", c.wait_pong())
        runs = list_runs(workdir)
        check("t01p exactly the two turn runs exist (no fake runs)",
              runs == sorted([run_a, run_b]), str(runs))
        # privacy: the prompt marker never persisted anywhere
        found = content_leak(workdir, marker, err_path)
        check("t01q no prompt/content persisted by the lifecycle layer",
              not found, str(found))
        # relay event log: bounded single lines + the prompt-turn chain
        ev = relay_events(workdir)
        check("t01r relay event log written (bounded single lines)",
              bool(ev) and all("\n" not in l for l in ev), "lines=%d" % len(ev))
        check("t01s relay log records the prompt-turn chain (A)",
              has_event(workdir, "client-request method=session/prompt id=%s" % mid_a)
              and has_event(workdir, "turn-start session=%s id=%s" % (sid, mid_a))
              and has_event(workdir, "start-result session=%s status=started" % sid)
              and has_event(workdir, "mapping-written session=%s run=%s" % (sid, run_a))
              and has_event(workdir, "turn-response session=%s id=%s stop_reason=end_turn"
                            % (sid, mid_a))
              and has_event(workdir, "turn-finalize session=%s id=%s stop_status=graceful"
                            % (sid, mid_a))
              and has_event(workdir, "stop-result session=%s stop_status=graceful" % sid),
              "events=%s" % " | ".join(ev[:14]))
        check("t01t relay log records the distinct turn B",
              has_event(workdir, "mapping-written session=%s run=%s" % (sid, run_b))
              and has_event(workdir, "turn-finalize session=%s id=%s stop_status=graceful"
                            % (sid, mid_b)),
              "events=%s" % " | ".join(relay_events(workdir)[-10:]))
        check("t01u relay log has NO session-close event (close not required)",
              not has_event(workdir, "session-closed")
              and not has_event(workdir, "close-launched")
              and not has_event(workdir, "close-pending"),
              "events=%s" % " | ".join(relay_events(workdir)[-10:]))
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("t01v client EOF -> launch path exits 0 (session never closed)",
              rc == 0, "rc=%s" % rc)
        check("t01w relay log records the exit with no active turns",
              has_event(workdir, "relay-exited child_rc=0 open_sessions=0"))
    finally:
        shutdown(proc)


def scenario_id_correlation(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "idcorr"
    proc, err_path = launch(repo, workdir, s, extra={"FAKE_PROMPT_DELAY": "12"})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        sid = open_session(c, workdir, "t21a id-correlation: session open")
        if not sid:
            return
        check_no_capture(workdir, "t21b no run before the prompt")
        mid_a, run_a = start_turn(c, workdir, sid, "t21c prompt A -> run A live")
        if not run_a:
            return
        # 1) a forged response with an UNKNOWN request id must not touch
        #    the active turn
        c.request("test/fake-response", {"id": 987654, "stopReason": "end_turn"})
        c.wait_response(c.next_id, 30)
        time.sleep(2.0)
        check("t21d forged wrong-id response does NOT finalize the turn",
              read_mapping(workdir, sid) == run_a and collector_alive(workdir, run_a),
              "mapping=%r" % read_mapping(workdir, sid))
        check("t21e no finalization for the wrong id",
              not has_event(workdir, "turn-finalize")
              and not has_event(workdir, "stop-result"),
              "events=%s" % " | ".join(relay_events(workdir)[-6:]))
        # 2) a forged response with the EXACT prompt request id finalizes
        c.request("test/fake-response", {"id": mid_a, "stopReason": "end_turn"})
        c.wait_response(c.next_id, 30)
        check_turn_finalized(workdir, sid, run_a, "t21f exact-id response",
                             "graceful")
        # 3) the real delayed response (same id) arrives afterwards: it
        #    must be a bounded no-op (no second finalization, no new run)
        resp = c.wait_response(mid_a, 30)
        check("t21g the late real prompt response arrived (same id)",
              resp is not None, "resp=%r" % (resp,))
        time.sleep(1.5)
        check("t21h the late duplicate response is a no-op",
              list_runs(workdir) == [run_a]
              and read_mapping(workdir, sid) is None
              and (manifest(workdir, run_a) or {}).get("stop_status") == "graceful",
              "runs=%s" % list_runs(workdir))
        check("t21i the late duplicate response is recorded as a bounded no-op",
              has_event(workdir, "turn-response-late id=%s" % mid_a),
              "events=%s" % " | ".join(relay_events(workdir)[-6:]))
        check("t21j stream alive throughout", c.wait_pong())
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("t21k launch path exits 0", rc == 0, "rc=%s" % rc)
        check("t21l relay exit with no active turns",
              has_event(workdir, "relay-exited child_rc=0 open_sessions=0"))
    finally:
        shutdown(proc)


def scenario_close_cleanup(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "closecln"
    proc, err_path = launch(repo, workdir, s, extra={"FAKE_PROMPT_DELAY": "8"})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        sid = open_session(c, workdir, "t31a close-cleanup: session open")
        if not sid:
            return
        # 1) close of an IDLE session: release only — nothing to finalize
        mid = c.request("session/close", {"sessionId": sid})
        c.wait_response(mid, 30)
        time.sleep(1.0)
        check("t31b idle-session close finalizes nothing (no run exists)",
              list_runs(workdir) == [] and read_mapping(workdir, sid) is None,
              "runs=%s" % list_runs(workdir))
        check("t31c stream alive after the idle close", c.wait_pong())
        # the same session id re-opened (a fresh root ACP session)
        open_session_via(c, workdir, "session/resume", sid, "t31d resume re-open")
        # 2) close DURING an active turn: the turn finalizes interrupted
        mid_p, run_a = start_turn(c, workdir, sid, "t31e prompt -> run live")
        if not run_a:
            return
        mid_c = c.request("session/close", {"sessionId": sid})
        c.wait_response(mid_c, 30)
        check_turn_finalized(workdir, sid, run_a, "t31f close during active turn",
                             "interrupted")
        # the late real prompt response (same id) is a bounded no-op
        resp = c.wait_response(mid_p, 30)
        check("t31g the late prompt response was consumed", resp is not None)
        time.sleep(1.5)
        check("t31h the late response is a no-op (still exactly one run)",
              list_runs(workdir) == [run_a]
              and read_mapping(workdir, sid) is None
              and (manifest(workdir, run_a) or {}).get("stop_status") == "interrupted",
              "runs=%s" % list_runs(workdir))
        # The late response is a bounded no-op, recorded as one of:
        # unmatched (the session state already settled), late (the id was
        # seen and settled), or finalize-ignored (arrived while the
        # close-triggered stop was still in flight).
        check("t31i late response recorded (bounded no-op)",
              has_event(workdir, "turn-response-unmatched session=%s id=%s"
                        % (sid, mid_p))
              or has_event(workdir, "turn-response-late id=%s" % mid_p)
              or has_event(workdir, "turn-finalize-ignored session=%s id=%s"
                           % (sid, mid_p)),
              "events=%s" % " | ".join(relay_events(workdir)[-8:]))
        # 3) duplicate close + unknown close: harmless, never touch runs
        c.request("session/close", {"sessionId": sid})
        c.wait_response(c.next_id, 30)
        c.request("session/close",
                  {"sessionId": "01close-deadbeef000000000000"})
        c.wait_response(c.next_id, 30)
        time.sleep(1.5)
        check("t31j duplicate + unknown closes harmless",
              list_runs(workdir) == [run_a] and c.wait_pong(),
              "runs=%s" % list_runs(workdir))
        check("t31k relay log recorded the cleanup chain",
              has_event(workdir, "session-closed session=%s" % sid)
              and has_event(workdir, "close-launched session=%s run=%s stop_status=interrupted"
                            % (sid, run_a)),
              "events=%s" % " | ".join(relay_events(workdir)[-10:]))
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("t31l launch path exits 0", rc == 0, "rc=%s" % rc)
        check("t31m relay exit with no active turns",
              has_event(workdir, "relay-exited child_rc=0 open_sessions=0"))
    finally:
        shutdown(proc)


def scenario_crash_interrupted(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "crash"
    proc, _ = launch(repo, workdir, s,
                     extra={"FAKE_PROMPT_CRASH": "1",
                            "FAKE_PROMPT_CRASH_DELAY": "3"})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        sid = open_session(c, workdir, "t40a crash: session open")
        if not sid:
            return
        mid, run_id = start_turn(c, workdir, sid, "t40b prompt -> run live")
        if not run_id:
            return
        # the fake server crashes (os._exit 9) mid-turn, with NO response
        rc = proc.wait(timeout=90)
        check("t40c crash -> launch path exits with the child status (9)",
              rc == 9, "rc=%s" % rc)
        check_turn_finalized(workdir, sid, run_id, "t40d crash during prompt",
                             "interrupted")
        check("t40e ledger generated, collector not orphaned",
              bool(manifest(workdir, run_id))
              and os.path.isfile(os.path.join(run_dir(workdir, run_id),
                                              "run-ledger.json"))
              and not collector_alive(workdir, run_id))
    finally:
        shutdown(proc)


def scenario_no_session(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "nosess"
    proc, _ = launch(repo, workdir, s)
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        check("t50a stream works without any session", c.wait_pong())
        # a session WITHOUT a prompt never creates a run either
        mid = c.request("session/new", {"cwd": "/tmp"})
        msg = c.wait_response(mid, 30)
        sid = (msg or {}).get("result", {}).get("sessionId")
        time.sleep(1.5)
        check("t50b a session without a prompt never creates a run",
              bool(sid) and list_runs(workdir) == []
              and read_mapping(workdir, sid) is None,
              "runs=%s" % list_runs(workdir))
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("t50c process exit -> exit 0", rc == 0, "rc=%s" % rc)
        check("t50d process exit -> NO fake run",
              list_runs(workdir) == [], str(list_runs(workdir)))
        mapdir = os.path.join(workdir, "map")
        check("t50e no session mappings left",
              not os.path.isdir(mapdir) or os.listdir(mapdir) == [])
    finally:
        shutdown(proc)


def scenario_concurrency(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "conc"
    run_foreign = start_capture_manual(repo, workdir)
    check("t60a manual (foreign) capture started", bool(run_foreign))
    if not run_foreign:
        return
    # Delayed prompts: the turn must stay ACTIVE across the start
    # sidecar (the foreign capture resolves the first one as
    # already_running; after the foreign run ends, the second prompt's
    # run must be observable before its response finalizes it).
    fake_log = os.path.join(workdir, "conc.fake.log")
    proc, err_path = launch(repo, workdir, s,
                            extra={"FAKE_PROMPT_DELAY": "6",
                                   "FAKE_LOG": fake_log})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        # Inline open: the foreign run legitimately occupies the runs
        # dir, so "starts NO run" compares run sets, not emptiness.
        mid = c.request("session/new", {"cwd": "/tmp"})
        msg = c.wait_response(mid)
        sid = (msg or {}).get("result", {}).get("sessionId")
        if not isinstance(sid, str) or not sid:
            bad("t60b concurrent session open: session/new response")
            sid = None
        time.sleep(1.0)  # give a (wrong) run start a chance to appear
        check("t60b concurrent session open starts NO run (identity only)",
              sid is not None and list_runs(workdir) == [run_foreign]
              and read_mapping(workdir, sid) is None,
              "runs=%s mapping=%r" % (list_runs(workdir),
                                      read_mapping(workdir, sid)))
        if not sid:
            return
        # a prompt turn while a foreign capture is live: fails open. The
        # prompt must NOT wait for readiness of the collector it does not
        # own: the already_running contract resolves fast and the prompt
        # forwards without a startup-delay window.
        t_send = time.time()
        mid = send_prompt(c, sid)
        resp = c.wait_response(mid, 30)
        time.sleep(3.0)  # give the (impossible) capture a chance
        check("t60c prompt turn fails open (never attached, no run created)",
              resp is not None and read_mapping(workdir, sid) is None
              and list_runs(workdir) == [run_foreign],
              "mapping=%r runs=%s" % (read_mapping(workdir, sid),
                                      list_runs(workdir)))
        check("t60d fail-open warning on stderr",
              "not captured" in open(err_path).read())
        check("t60e ACP stream fully functional while uncaptured", c.wait_pong())
        receipts = prompt_receipts(fake_log)
        check("t60l already_running prompt forwarded without a readiness wait",
              len(receipts) == 1 and (float(receipts[0]["ts"]) - t_send) < 5.0,
              "receipts=%s" % receipts)
        stop_capture_manual(repo, workdir)
        check("t60f foreign run finalized",
              wait_for(lambda: not collector_alive(workdir, run_foreign), 60, None)
              and (manifest(workdir, run_foreign) or {}).get("stop_status") == "graceful")
        # the SAME session's next prompt is captured (a distinct run)
        mid2, run2 = start_turn(c, workdir, sid, "t60g next prompt after foreign run")
        check("t60h next prompt turn captured (distinct run)",
              bool(run2) and run2 != run_foreign, "run2=%r" % run2)
        if not run2:
            return
        resp2 = c.wait_response(mid2, 60)
        check("t60i next prompt response received",
              bool(resp2) and (resp2.get("result") or {}).get("stopReason") == "end_turn")
        check_turn_finalized(workdir, sid, run2, "t60j next prompt response",
                             "graceful")
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("t60k launch path exits 0", rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_verify_correlation(repo, workdir, fake_bin=None,
                                launcher=None, largs=None):
    s = "verif"
    # A long turn: the real response arrives well after the scenario ends
    # it deterministically with a forged exact-id response.
    proc, _ = launch(repo, workdir, s, extra={"FAKE_PROMPT_DELAY": "120"})
    bash_bin = "/bin/bash"
    env = base_env(repo, workdir, s)
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        sid = open_session(c, workdir, "t70a verify: session open")
        if not sid:
            return
        mid, run_a = start_turn(c, workdir, sid, "t70b prompt -> active turn run")
        if not run_a:
            return
        # during the turn: agent-verify attributes the summary to the
        # ACTIVE TURN's run (CODEX_SESSION_ID + mapping)
        venv = dict(env)
        venv["CODEX_SESSION_ID"] = sid
        venv["PATH"] = fake_bin
        venv.pop("FG_AGENT_RUN_ID", None)
        # The live-turn summary goes INTO the run dir (where the agent
        # writes it in real sessions and where the ledger consumes it).
        sumdir = os.path.join(workdir, "sums")
        os.makedirs(sumdir, exist_ok=True)
        live_sum = os.path.join(run_dir(workdir, run_a), "verify-live.json")
        p = subprocess.run(
            [bash_bin, os.path.join(repo, "scripts", "agent-verify.sh"),
             "--summary-json", live_sum, "quick"],
            env=venv, stdin=subprocess.DEVNULL, capture_output=True, timeout=300)
        d = json.load(open(live_sum))
        check("t70c verify DURING the turn attributes to the active turn's run",
              p.returncode in (0, 1) and d.get("agentRunId") == run_a,
              "agentRunId=%r expected=%s" % (d.get("agentRunId"), run_a))
        # explicit id always wins
        venv2 = dict(venv)
        venv2["FG_AGENT_RUN_ID"] = "run-explicit-override-1"
        p = subprocess.run(
            [bash_bin, os.path.join(repo, "scripts", "agent-verify.sh"),
             "--summary-json", os.path.join(sumdir, "explicit.json"), "quick"],
            env=venv2, stdin=subprocess.DEVNULL, capture_output=True, timeout=300)
        d2 = json.load(open(os.path.join(sumdir, "explicit.json")))
        check("t70d explicit FG_AGENT_RUN_ID overrides the mapping",
              d2.get("agentRunId") == "run-explicit-override-1",
              "agentRunId=%r" % d2.get("agentRunId"))
        # end the turn deterministically: forged response, EXACT id
        forge_response(c, mid)
        c.wait_response(c.next_id, 30)
        check_turn_finalized(workdir, sid, run_a, "t70e exact-id response",
                             "graceful")
        # the turn-finalization ledger consumed the live-turn summary
        try:
            ledger = json.load(open(os.path.join(run_dir(workdir, run_a),
                                                 "run-ledger.json")))
            vs = [p_ for p_ in (ledger.get("verification") or {}).get("profiles") or []
                  if p_.get("agent_run_id") == run_a]
            check("t70f ledger consumed the correlated summary", bool(vs),
                  "verification.profiles=%s" % ((ledger.get("verification") or {}).get("profiles"),))
        except (OSError, ValueError) as exc:
            bad("t70f ledger consumed the correlated summary", exc)
        # no-newest-run-guessing: a NEWER live run exists; the stored
        # mapping for the session must still resolve the (older) run.
        run_new = start_capture_manual(repo, workdir)
        check("t70g newer manual run started", bool(run_new))
        mapdir = os.path.join(workdir, "map")
        os.makedirs(mapdir, exist_ok=True)
        with open(os.path.join(mapdir, sid), "w") as f:
            f.write(run_a + "\n")
        p = subprocess.run(
            [bash_bin, os.path.join(repo, "scripts", "agent-verify.sh"),
             "--summary-json", os.path.join(sumdir, "stale-map.json"), "quick"],
            env=venv, stdin=subprocess.DEVNULL, capture_output=True, timeout=300)
        d3 = json.load(open(os.path.join(sumdir, "stale-map.json")))
        check("t70h mapping wins over a newer live run (no newest-run guessing)",
              d3.get("agentRunId") == run_a,
              "agentRunId=%r expected=%s (newer live=%s)"
              % (d3.get("agentRunId"), run_a, run_new))
        stop_capture_manual(repo, workdir)
        if os.path.exists(os.path.join(mapdir, sid)):
            os.unlink(os.path.join(mapdir, sid))
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("t70i launch path exits 0", rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_opt_out(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "optout"
    envlog = os.path.join(workdir, s + ".env.log")
    proc, err_path = launch(repo, workdir, s,
                            extra={"FG_AGENT_OBSERVABILITY": "0",
                                   "FAKE_LOG": envlog})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        mid = c.request("session/new", {"cwd": "/tmp"})
        msg = c.wait_response(mid)
        sid = (msg or {}).get("result", {}).get("sessionId")
        mid_p = send_prompt(c, sid)
        c.wait_response(mid_p, 30)
        c.wait_response(c.request("test/record-env"), 30)
        time.sleep(0.5)
        log = open(envlog).read() if os.path.exists(envlog) else ""
        check("t80a opt-out: ACP stream works (prompt round-trips)",
              bool(sid) and c.wait_pong())
        check("t80b opt-out: no capture, no run, no mapping (prompts included)",
              list_runs(workdir) == [] and
              (not os.path.isdir(os.path.join(workdir, "map"))
               or os.listdir(os.path.join(workdir, "map")) == []))
        check("t80c opt-out: original launcher env (no wrapper guard, no run id)",
              "FG_AGENT_RUN_ID:<unset>" in log
              and "FG_PRODUCT_OBS_IN_WRAPPER:<unset>" in log,
              "log=%r" % log[:200])
        err = open(err_path).read()
        check("t80d opt-out: no lifecycle diagnostics", err == "", err[:200])
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("t80e opt-out: launch path exits 0", rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_stale_runid(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "stale"
    envlog = os.path.join(workdir, s + ".env.log")
    proc, _ = launch(repo, workdir, s,
                     extra={"FG_AGENT_RUN_ID": "run-stale-999",
                            "FAKE_LOG": envlog,
                            "FAKE_PROMPT_DELAY": "4"})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        sid = open_session(c, workdir, "t90a stale-runid: session open")
        if not sid:
            return
        mid, run_id = start_turn(c, workdir, sid, "t90b prompt -> turn run")
        check("t90c fresh run created (not the stale inherited id)",
              bool(run_id) and run_id != "run-stale-999", "run=%r" % run_id)
        c.wait_response(c.request("test/record-env"), 30)
        time.sleep(0.5)
        log = open(envlog).read() if os.path.exists(envlog) else ""
        check("t90d inherited stale FG_AGENT_RUN_ID dropped from the child env",
              "FG_AGENT_RUN_ID:<unset>" in log, "log=%r" % log[:200])
        resp = c.wait_response(mid, 60)
        check("t90e prompt response received",
              bool(resp) and (resp.get("result") or {}).get("stopReason") == "end_turn")
        check_turn_finalized(workdir, sid, run_id, "t90f prompt response",
                             "graceful")
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("t90g launch path exits 0", rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_exit_status(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "exitst"
    # 1) no session: exit code preserved
    proc, _ = launch(repo, workdir, s, extra={"FAKE_EXIT": "17"})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        c.send({"jsonrpc": "2.0", "method": "test/die"})
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tA0a child exit 17 (no session) preserved", rc == 17, "rc=%s" % rc)
        check("tA0b no session -> no run", list_runs(workdir) == [])
    finally:
        shutdown(proc)
    # 2) active prompt turn: exit code preserved, the turn finalizes
    #    interrupted (process/transport exit mid-turn)
    proc, _ = launch(repo, workdir, s, extra={"FAKE_EXIT": "17",
                                              "FAKE_PROMPT_DELAY": "5"})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        sid = open_session(c, workdir, "tA0c exit-status: session open")
        if not sid:
            return
        mid, run_id = start_turn(c, workdir, sid, "tA0d prompt -> run live")
        if not run_id:
            return
        c.send({"jsonrpc": "2.0", "method": "test/die"})
        time.sleep(1.0)
        proc.stdin.close()
        rc = proc.wait(timeout=90)
        check("tA0e child exit 17 (active prompt turn) preserved", rc == 17,
              "rc=%s" % rc)
        check_turn_finalized(workdir, sid, run_id, "tA0f mid-turn child exit",
                             "interrupted")
    finally:
        shutdown(proc)


def scenario_signal_terminated(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "sigterm"
    proc, _ = launch(repo, workdir, s, extra={"FAKE_PROMPT_DELAY": "5"})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        sid = open_session(c, workdir, "tB0a signal: session open")
        if not sid:
            return
        mid, run_id = start_turn(c, workdir, sid, "tB0b prompt -> run live")
        if not run_id:
            return
        os.kill(proc.pid, signal.SIGTERM)
        rc = proc.wait(timeout=90)
        check("tB0c SIGTERM -> launch path exits 143", rc == 143, "rc=%s" % rc)
        check_turn_finalized(workdir, sid, run_id, "tB0d mid-turn SIGTERM",
                             "interrupted")
        check("tB0e mapping released, collector stopped",
              read_mapping(workdir, sid) is None
              and not collector_alive(workdir, run_id))
    finally:
        shutdown(proc)


def scenario_fail_open(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "failopen"
    broken = os.environ.get("FG_PL_BROKEN_OTELCOL", "")
    if not broken or not os.path.exists(broken):
        bad("tC00 fail-open scenario requires FG_PL_BROKEN_OTELCOL")
        return
    proc, err_path = launch(repo, workdir, s,
                            extra={"FG_OTELCOL": broken,
                                   "FG_TEST_SECRET_MARKER":
                                       "sk-fake-should-never-appear-1234"})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        mid = c.request("session/new", {"cwd": "/tmp"})
        msg = c.wait_response(mid)
        sid = (msg or {}).get("result", {}).get("sessionId")
        mid_p = send_prompt(c, sid)
        c.wait_response(mid_p, 30)
        time.sleep(4.0)  # the start sidecar fails fast; give it room
        check("tC0a broken collector -> prompt turn uncaptured (fail-open)",
              sid is not None and read_mapping(workdir, sid) is None
              and list_runs(workdir) == [],
              "mapping=%r runs=%s" % (read_mapping(workdir, sid),
                                      list_runs(workdir)))
        err = open(err_path).read()
        check("tC0b fail-open warning emitted (bounded)",
              "automatic observability unavailable" in err
              or "not captured" in err, err[:300])
        check("tC0c fail-open warning carries no env/secret values",
              "should-never-appear" not in err, err[:300])
        check("tC0d ACP stream fully functional while uncaptured", c.wait_pong())
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tC0e launch path exits 0 (fail-open never breaks the session)",
              rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_doctor_snapshot(repo, workdir, fake_bin=None, launcher=None, largs=None):
    s = "doctor"
    proc, _ = launch(repo, workdir, s,
                     extra={"FG_OBS_NO_DOCTOR_SNAPSHOT": "0",
                            "FAKE_PROMPT_DELAY": "120"})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        sid = open_session(c, workdir, "tD0a doctor: session open")
        if not sid:
            return
        mid, run_id = start_turn(c, workdir, sid, "tD0b prompt -> turn run")
        if run_id:
            doc = os.path.join(run_dir(workdir, run_id), "agent-doctor-start.json")

            def _doctor_valid():
                try:
                    d = json.load(open(doc))
                except (OSError, ValueError):
                    return False
                return (isinstance(d, dict)
                        and isinstance(d.get("summary"), dict)
                        and isinstance(d["summary"].get("overall"), str))

            # The file is created eagerly and filled as the doctor runs:
            # poll for a complete, valid document (bounded).
            valid = wait_for(_doctor_valid, 120, None)
            check("tD0c doctor snapshot stored for the turn's run",
                  valid, "valid=%s" % valid)
            # end the turn deterministically (the real response would wait
            # 120s): forged response, EXACT id
            forge_response(c, mid)
            c.wait_response(c.next_id, 30)
            check_turn_finalized(workdir, sid, run_id, "tD0d exact-id response",
                                 "graceful")
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tD0e launch path exits 0", rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_trampoline_session(repo, workdir, fake_bin=None,
                                launcher=None, largs=None):
    s = "tramp"
    envlog = os.path.join(workdir, s + ".env.log")
    proc, _ = launch(repo, workdir, s,
                     extra={"FAKE_LOG": envlog,
                            "FAKE_PROMPT_DELAY": "4"},
                     launcher=launcher, largs=largs or ["sess-arg", "--flag"])
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        sid = open_session(c, workdir, "tE0a trampoline: session open")
        if not sid:
            return
        mid, run_id = start_turn(c, workdir, sid, "tE0b trampoline: prompt turn")
        check("tE0c trampoline prompt turn automatically captured",
              bool(run_id) and run_id.startswith("run-"), "run=%r" % run_id)
        log = open(envlog).read() if os.path.exists(envlog) else ""
        check("tE0d original args forwarded through trampoline+wrapper",
              "args: [sess-arg] [--flag]" in log, "log=%r" % log[:200])
        if run_id:
            resp = c.wait_response(mid, 60)
            check("tE0e prompt response received",
                  bool(resp) and (resp.get("result") or {}).get("stopReason") == "end_turn")
            check_turn_finalized(workdir, sid, run_id, "tE0f prompt response",
                                 "graceful")
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tE0g launch path exits 0", rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_trampoline_optout(repo, workdir, fake_bin=None,
                               launcher=None, largs=None):
    s = "trampopt"
    proc, _ = launch(repo, workdir, s,
                     extra={"FG_AGENT_OBSERVABILITY": "0"},
                     launcher=launcher, largs=largs or [])
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        mid = c.request("session/new", {"cwd": "/tmp"})
        msg = c.wait_response(mid)
        sid = (msg or {}).get("result", {}).get("sessionId")
        mid_p = send_prompt(c, sid)
        c.wait_response(mid_p, 30)
        time.sleep(1.0)
        check("tF0a opt-out through trampoline: stream works",
              bool(sid) and c.wait_pong())
        check("tF0b opt-out through trampoline: no capture (prompts included)",
              list_runs(workdir) == [] and
              (not os.path.isdir(os.path.join(workdir, "map"))
               or os.listdir(os.path.join(workdir, "map")) == []),
              "runs=%s" % list_runs(workdir))
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tF0c opt-out through trampoline: launch path exits 0",
              rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_raw_stream(repo, workdir, fake_bin=None,
                        launcher=None, largs=None):
    s = "rawstream"
    proc, err_path = launch(repo, workdir, s, launcher=launcher, largs=largs or [])
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        check("tG0a raw stream round-trip works", c.wait_pong())
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tG0b raw stream exit 0", rc == 0, "rc=%s" % rc)
        err = open(err_path).read()
        if err.strip():
            print("stderr: %s" % " ".join(err.split())[:400])
    finally:
        shutdown(proc)


def scenario_session_reopen(repo, workdir, fake_bin=None,
                            launcher=None, largs=None):
    """Session identity persists across close + re-open:
      * session/new   -> tracked, NO run
      * every prompt turn -> its own distinct run
      * idle close    -> finalizes nothing
      * session/resume / session/load (same id re-opened) -> tracked
                    again; the next prompt gets a fresh run
      * session/fork  -> the response carries the NEW sessionId; the
                    forked session's prompt turns get their own runs
    The server process stays alive across all of them."""
    s = "resopen"
    proc, _ = launch(repo, workdir, s, extra={"FAKE_PROMPT_DELAY": "6"})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        runs_seen = []
        # 1) fresh session + its first turn
        sid_a = open_session(c, workdir, "tH0a session/new")
        if not sid_a:
            return
        mid1, run_a = start_turn(c, workdir, sid_a, "tH0b first prompt")
        if not run_a:
            return
        runs_seen.append(run_a)
        resp = c.wait_response(mid1, 60)
        check("tH0c first prompt response received",
              bool(resp) and (resp.get("result") or {}).get("stopReason") == "end_turn")
        check_turn_finalized(workdir, sid_a, run_a, "tH0d first prompt response",
                             "graceful")
        # 2) idle close: finalizes nothing
        mid_c = c.request("session/close", {"sessionId": sid_a})
        c.wait_response(mid_c, 30)
        time.sleep(1.0)
        check("tH0e idle close finalizes nothing",
              list_runs(workdir) == [run_a], "runs=%s" % list_runs(workdir))
        # 3) the same session id re-opened via session/resume
        open_session_via(c, workdir, "session/resume", sid_a, "tH0f resume re-open")
        mid2, run_b = start_turn(c, workdir, sid_a, "tH0g resume prompt")
        check("tH0h resume turn got a distinct run (never the old one)",
              bool(run_b) and run_b not in runs_seen,
              "run_b=%s seen=%s" % (run_b, runs_seen))
        if run_b:
            runs_seen.append(run_b)
        resp = c.wait_response(mid2, 60)
        check_turn_finalized(workdir, sid_a, run_b, "tH0i resume prompt response",
                             "graceful")
        check("tH0j relay log recorded the resume re-open",
              has_event(workdir, "client-request method=session/resume")
              and has_event(workdir, "session-open session=%s via=session/resume" % sid_a),
              "events=%s" % " | ".join(relay_events(workdir)[:14]))
        # 4) the same session id re-opened via session/load
        open_session_via(c, workdir, "session/load", sid_a, "tH0k load re-open")
        mid3, run_c = start_turn(c, workdir, sid_a, "tH0l load prompt")
        check("tH0m load turn got a distinct run",
              bool(run_c) and run_c not in runs_seen, "run_c=%s" % run_c)
        if run_c:
            runs_seen.append(run_c)
        resp = c.wait_response(mid3, 60)
        check_turn_finalized(workdir, sid_a, run_c, "tH0n load prompt response",
                             "graceful")
        # 5) fork: the response carries the NEW session id -> the forked
        #    session's prompt turns get their own runs
        sid_d = open_session(c, workdir, "tH0o fork parent open",
                             existing=runs_seen)
        mid_c2 = c.request("session/close", {"sessionId": sid_d})
        c.wait_response(mid_c2, 30)
        time.sleep(1.0)
        mid_f = c.request("session/fork",
                          {"sessionId": sid_d, "cwd": "/tmp", "mcpServers": []})
        msg = c.wait_response(mid_f)
        sid_e = (msg or {}).get("result", {}).get("sessionId")
        check("tH0p fork response carries a new sessionId",
              isinstance(sid_e, str) and sid_e and sid_e != sid_d, "sid_e=%r" % sid_e)
        if sid_e:
            mid4, run_d = start_turn(c, workdir, sid_e, "tH0q forked prompt")
            check("tH0r forked session turn got a fresh run",
                  bool(run_d) and run_d not in runs_seen, "run_d=%s" % run_d)
            if run_d:
                runs_seen.append(run_d)
            resp = c.wait_response(mid4, 60)
            check_turn_finalized(workdir, sid_e, run_d,
                                 "tH0s forked prompt response", "graceful")
        # 6) bookkeeping
        runs = list_runs(workdir)
        check("tH0t exactly the four turn runs exist (no fake runs)",
              runs == sorted(runs_seen),
              "expected=%s actual=%s" % (sorted(runs_seen), runs))
        mapdir = os.path.join(workdir, "map")
        released = wait_for(
            lambda: not os.path.isdir(mapdir) or os.listdir(mapdir) == [],
            20, None)
        check("tH0u all mappings released", released,
              "maps=%s" % (os.listdir(mapdir) if os.path.isdir(mapdir)
                           else []))
        check("tH0v server still alive after everything", c.wait_pong())
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tH0w relay log records exit with no active turns",
              has_event(workdir, "relay-exited child_rc=0 open_sessions=0"),
              "events=%s" % " | ".join(relay_events(workdir)[-6:]))
        check("tH0x launch path exits 0", rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_map_fail(repo, workdir, fake_bin=None,
                      launcher=None, largs=None):
    """Mapping write failure (link: session/run mapping) must fail OPEN:
    the turn's run starts and is live, the turn is never attached to it
    via a mapping, the stream stays intact, and the prompt response
    STILL finalizes the run gracefully (response-driven boundary)."""
    s = "mapfail"
    blocked = os.path.join(workdir, "map-blocked")
    with open(blocked, "w") as f:
        f.write("blocker\n")  # a FILE: makedirs() on map-blocked/... must fail
    env_extra = {"FG_PRODUCT_SESSION_MAP_DIR": blocked + "/session-runs",
                 "FAKE_PROMPT_DELAY": "12"}
    proc, err_path = launch(repo, workdir, s, extra=env_extra)
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        # Inline open: the map dir is blocked by design, so the mapping
        # wait of open_session() would never succeed.
        mid = c.request("session/new", {"cwd": "/tmp"})
        msg = c.wait_response(mid)
        sid = (msg or {}).get("result", {}).get("sessionId") if msg else None
        if not isinstance(sid, str) or not sid:
            bad("tI0a map-fail: session open")
            return
        mid_p = send_prompt(c, sid)
        # The run dir exists before the collector is spawned; wait for
        # the run dir AND a live collector (no mapping, by design).
        wait_for(lambda: any(collector_alive(workdir, r) for r in list_runs(workdir)),
                 120, None)
        runs = list_runs(workdir)
        live = [r for r in runs if collector_alive(workdir, r)]
        check("tI0b map-fail: prompt turn's run started + live (no mapping)",
              len(runs) == 1 and len(live) == 1, "runs=%s" % runs)
        check("tI0c no mapping file written", read_mapping(workdir, sid) is None)
        check("tI0d mapping-write-failed diagnostic recorded",
              wait_for(lambda: has_event(
                  workdir, "mapping-write-failed session=%s" % sid), 30, None),
              "events=%s" % " | ".join(relay_events(workdir)[:14]))
        check("tI0e stream fully functional while uncaptured", c.wait_pong())
        # the prompt response STILL finalizes the run (gracefully)
        resp = c.wait_response(mid_p, 60)
        check("tI0f prompt response received",
              bool(resp) and (resp.get("result") or {}).get("stopReason") == "end_turn")
        if runs:
            check_turn_finalized(workdir, sid, runs[0], "tI0g prompt response",
                                 "graceful")
        proc.stdin.close()
        rc = proc.wait(timeout=90)
        check("tI0h child EOF preserved (no open-turn crash)", rc == 0, "rc=%s" % rc)
        check("tI0i collector not orphaned",
              not runs or not collector_alive(workdir, runs[0]))
        check("tI0j relay exit recorded", has_event(workdir, "relay-exited"))
    finally:
        shutdown(proc)


def scenario_ndjson_wire(repo, workdir, fake_bin=None, launcher=None, largs=None):
    """The REAL ACP wire format regression (stable v1 ACP stdio is
    newline-delimited JSON — NOT LSP Content-Length framing):

    With the old LSP-only observer, exactly this traffic produced
    `framer-bypass ... reason=headers-oversized` and no lifecycle
    observation at all. This scenario proves the fixed behavior on the
    prompt-turn contract:
      * NDJSON initialize/session/new (fragmented byte reads) is
        observed (no run — session identity only);
      * a small NDJSON session/prompt is observed and its turn is
        captured (start + mapping);
      * several JSON-RPC lines in ONE write are all observed;
      * an oversized prompt-shaped line is skipped for that line only
        (one bounded frame-skipped, no payload leakage, NO turn started
        for it) and the NEXT line is still observed;
      * a malformed JSON line is forwarded unchanged and does not kill
        observation;
      * the (delayed) prompt response finalizes the turn."""
    s = "ndjson"
    proc, _ = launch(repo, workdir, s, extra={"FAKE_PROMPT_DELAY": "6"})
    try:
        c = Client(proc)
        # 1) fragmented NDJSON reads: initialize in 2-byte fragments
        mid = c.request("initialize", fragment=2)
        msg = c.wait_response(mid)
        check("tJ0a NDJSON initialize round-trip (fragmented reads)",
              bool(msg) and msg.get("result", {}).get("protocolVersion") == 1)
        check("tJ0b no run before a session", list_runs(workdir) == [])
        # 2) the exact real failure: session/new on NDJSON must be
        #    observed (also fragmented, 3-byte writes) — identity only
        mid_n = c.request("session/new", {"cwd": "/tmp"}, fragment=3)
        msg_n = c.wait_response(mid_n)
        sid = (msg_n or {}).get("result", {}).get("sessionId")
        time.sleep(1.0)
        check("tJ0c session/new (NDJSON) observed, NO run started",
              bool(sid) and list_runs(workdir) == []
              and read_mapping(workdir, sid) is None,
              "runs=%s" % list_runs(workdir))
        check("tJ0d no framer bypass of any kind (the real failure is gone)",
              not has_event(workdir, "framer-bypass")
              and not has_event(workdir, "headers-oversized"))
        check("tJ0e relay observed the NDJSON session open",
              has_event(workdir, "client-request method=initialize")
              and has_event(workdir, "client-request method=session/new")
              and has_event(workdir, "session-open session=%s via=session/new" % sid),
              "events=%s" % " | ".join(relay_events(workdir)[:14]))
        # 3) the prompt turn on NDJSON
        mid_p, run_id = start_turn(c, workdir, sid, "tJ0f prompt (NDJSON)")
        check("tJ0g relay observed the NDJSON prompt-turn chain",
              has_event(workdir, "client-request method=session/prompt id=%s" % mid_p)
              and has_event(workdir, "turn-start session=%s id=%s" % (sid, mid_p))
              and has_event(workdir, "mapping-written session=%s run=%s"
                            % (sid, run_id)),
              "events=%s" % " | ".join(relay_events(workdir)[:14]))
        # 4) several JSON-RPC lines in ONE write: both pings observed
        p1 = c.next_id + 1
        p2 = c.next_id + 2
        c.send_raw(frame({"jsonrpc": "2.0", "id": p1, "method": "test/ping"})
                   + frame({"jsonrpc": "2.0", "id": p2, "method": "test/ping"}))
        m1 = c.wait_response(p1)
        m2 = c.wait_response(p2)
        check("tJ0h two JSON-RPC lines in one write: both round-tripped",
              bool(m1) and bool(m2)
              and m1.get("result", {}).get("pong") is True
              and m2.get("result", {}).get("pong") is True)
        time.sleep(1.0)
        check("tJ0i both same-write requests observed",
              has_event(workdir, "client-request method=test/ping id=%d" % p1)
              and has_event(workdir, "client-request method=test/ping id=%d" % p2),
              "events=%s" % " | ".join(relay_events(workdir)[-6:]))
        # 5) oversized prompt-shaped line (a notification: no id): skipped
        #    for that line ONLY — and even if observed it could never
        #    start a turn (no request id to correlate).
        marker = "FG_RELAY_OVERRUN_MARKER_%d" % os.getpid()
        big = (json.dumps({"jsonrpc": "2.0", "method": "session/prompt",
                           "params": {"sessionId": sid,
                                      "prompt": [{"type": "text",
                                                  "text": marker + "Z" * 300000}]}})
               .encode() + b"\n")
        c.send_raw(big[:100000], fragment=4096)
        c.send_raw(big[100000:])
        p3 = c.next_id + 1
        c.request("test/ping")  # the NEXT line
        m3 = c.wait_response(p3)
        time.sleep(1.0)
        check("tJ0j oversized line: stream alive, next line round-trips",
              bool(m3) and m3.get("result", {}).get("pong") is True)
        check("tJ0k oversized line: next line still observed",
              has_event(workdir, "client-request method=test/ping id=%d" % p3),
              "events=%s" % " | ".join(relay_events(workdir)[-6:]))
        skipped = [l for l in relay_events(workdir)
                   if "frame-skipped dir=in reason=line-oversized" in l]
        check("tJ0l oversized line: exactly one bounded frame-skipped",
              len(skipped) == 1,
              "skipped=%d events=%s" % (len(skipped),
                                        " | ".join(relay_events(workdir)[-6:])))
        check("tJ0m oversized line never started a turn (exactly one run)",
              list_runs(workdir) == [run_id], "runs=%s" % list_runs(workdir))
        leaked = [l for l in relay_events(workdir) if marker in l]
        check("tJ0n oversized payload never persisted in relay log",
              not leaked, str(leaked)[:200])
        # 6) malformed JSON line: forwarded unchanged, observation survives
        c.send_raw(b"this-is-not-json {" + b" " * 100 + b"\n")
        p4 = c.next_id + 1
        c.request("test/ping")
        m4 = c.wait_response(p4)
        time.sleep(1.0)
        check("tJ0o malformed line: stream alive, next line round-trips",
              bool(m4) and m4.get("result", {}).get("pong") is True)
        check("tJ0p malformed line: observation continues",
              has_event(workdir, "client-request method=test/ping id=%d" % p4))
        check("tJ0q malformed line: bounded diagnostic recorded",
              has_event(workdir, "observe-error dir=in malformed-json line"),
              "events=%s" % " | ".join(relay_events(workdir)[-6:]))
        # 7) the (delayed) prompt response finalizes the turn
        resp = c.wait_response(mid_p, 60)
        check("tJ0r prompt response received",
              bool(resp) and (resp.get("result") or {}).get("stopReason") == "end_turn")
        check_turn_finalized(workdir, sid, run_id, "tJ0s prompt response",
                             "graceful")
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tJ0t launch path exits 0", rc == 0, "rc=%s" % rc)
        check("tJ0u relay log records exit with no active turns",
              has_event(workdir, "relay-exited child_rc=0 open_sessions=0"))
    finally:
        shutdown(proc)


def scenario_ready_ordering(repo, workdir, fake_bin=None,
                            launcher=None, largs=None):
    """Case A + F + G — the collector-readiness ordering contract,
    observed at RUNTIME (not by source inspection):

    For a capturable prompt the collector must be CONFIRMED ACCEPTING on
    its loopback OTLP endpoint BEFORE the prompt bytes reach the Codex
    child. The fake server records, at the exact moment it receives the
    session/prompt wire line, whether the endpoint already accepted a TCP
    connection, the sha256 of the EXACT wire bytes (integrity), and the
    receipt count (exactly-once). With FAKE_PROMPT_OTLP it also emits its
    "first request" telemetry at prompt receipt — capturable by the real
    collector only if readiness genuinely precedes forwarding (the
    historical failure was precisely this first event being lost)."""
    s = "readyord"
    fake_log = os.path.join(workdir, "readyord.fake.log")
    proc, err_path = launch(repo, workdir, s,
                            extra={"FAKE_PROMPT_DELAY": "2",
                                   "FAKE_PROMPT_OTLP": "1",
                                   "FAKE_LOG": fake_log})
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        mid = c.request("session/new", {"cwd": "/tmp"})
        msg = c.wait_response(mid)
        sid = (msg or {}).get("result", {}).get("sessionId")
        if not isinstance(sid, str) or not sid:
            bad("tR0a ready-ordering: session open")
            return
        import hashlib
        params = {"sessionId": sid,
                  "prompt": [{"type": "text",
                              "text": "FG_READY_ORDER_MARKER_%d" % os.getpid()}]}
        body = frame({"jsonrpc": "2.0", "id": c.next_id + 1,
                      "method": "session/prompt", "params": params})
        mid_p = c.next_id + 1
        c.send_raw(body)
        t_send = time.time()
        rid, live = wait_run_live(workdir, sid, timeout=60)
        check("tR0b prompt turn's run live (mapping + collector)",
              rid is not None and live, "mapping=%r" % rid)
        resp = c.wait_response(mid_p, 60)
        check("tR0c prompt response received (stopReason)",
              bool(resp) and (resp.get("result") or {}).get("stopReason") == "end_turn")
        receipts = prompt_receipts(fake_log)
        check("tR0d prompt line forwarded exactly once (no duplication)",
              len(receipts) == 1, "receipts=%s" % receipts)
        if receipts:
            r = receipts[0]
            check("tR0e collector accepting AT prompt receipt "
                  "(readiness strictly precedes forwarding)",
                  r.get("port_listening") == "yes",
                  "port_listening=%r" % r.get("port_listening"))
            expect_sha = hashlib.sha256(body[:-1]).hexdigest()
            check("tR0f prompt bytes forwarded unchanged (byte integrity)",
                  r.get("sha256") == expect_sha
                  and int(r.get("bytes", -1)) == len(body) - 1,
                  "got=%r expected=%r bytes=%s"
                  % (r.get("sha256"), expect_sha, r.get("bytes")))
            check("tR0g receipt not before the send (sanity)",
                  float(r.get("ts", 0)) >= t_send - 0.5,
                  "ts=%r t_send=%r" % (r.get("ts"), t_send))
        check("tR0h first-request telemetry POST succeeded at prompt receipt",
              fake_first_event_posted(fake_log) == "yes",
              "posted=%r" % fake_first_event_posted(fake_log))
        raw_logs = os.path.join(run_dir(workdir, rid), "raw", "logs.jsonl") if rid else ""

        def _first_event_captured():
            try:
                with open(raw_logs, "rb") as f:
                    return b"fg_first_event" in f.read()
            except OSError:
                return False
        check("tR0i first request's telemetry CAPTURED by the real collector "
              "(historical regression criterion: the initial request is not lost)",
              bool(rid) and wait_for(_first_event_captured, 30, None),
              "raw=%s" % raw_logs)
        if rid:
            check_turn_finalized(workdir, sid, rid, "tR0j prompt response",
                                 "graceful")
        check("tR0k relay log: gate released after the started contract",
              has_event(workdir, "start-result session=%s status=started" % sid)
              and has_event(workdir, "gate-released session=%s" % sid),
              "events=%s" % " | ".join(relay_events(workdir)[-12:]))
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tR0l launch path exits 0", rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_ready_delayed(repo, workdir, fake_bin=None, launcher=None,
                           largs=None):
    """Case B — bounded startup delay: the collector needs a deliberate,
    bounded time to become ready. The prompt must remain UNFORWARDED
    during that entire window (observed: receipt happens no earlier than
    the delay budget minus slack, and the endpoint is already accepting
    at receipt), and once readiness is signaled the prompt forwards
    exactly once."""
    s = "readydly"
    slow = os.environ.get("FG_PL_SLOW_OTELCOL", "")
    real = os.environ.get("FG_PL_REAL_OTELCOL", "")
    delay = float(os.environ.get("FG_PL_SLOW_DELAY", "3"))
    if not (slow and real and os.path.exists(slow) and os.path.exists(real)):
        bad("tS00 ready-delayed requires FG_PL_SLOW_OTELCOL + FG_PL_REAL_OTELCOL")
        return
    fake_log = os.path.join(workdir, "readydly.fake.log")
    proc, err_path = launch(repo, workdir, s, extra={
        "FAKE_PROMPT_DELAY": "2",
        "FG_OTELCOL": slow,
        "SLOW_REAL": real,
        "SLOW_COLLECTOR_DELAY": str(delay),
        "FAKE_LOG": fake_log,
    })
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        mid = c.request("session/new", {"cwd": "/tmp"})
        msg = c.wait_response(mid)
        sid = (msg or {}).get("result", {}).get("sessionId")
        if not isinstance(sid, str) or not sid:
            bad("tS01 ready-delayed: session open")
            return
        t_send = time.time()
        mid_p = send_prompt(c, sid)
        rid, live = wait_run_live(workdir, sid, timeout=90)
        check("tS02 delayed run live", rid is not None and live,
              "mapping=%r" % rid)
        resp = c.wait_response(mid_p, 90)
        check("tS03 prompt response received",
              bool(resp) and (resp.get("result") or {}).get("stopReason") == "end_turn")
        receipts = prompt_receipts(fake_log)
        check("tS04 prompt forwarded exactly once (no duplication)",
              len(receipts) == 1, "receipts=%s" % receipts)
        if receipts:
            gap = float(receipts[0]["ts"]) - t_send
            check("tS05 prompt UNFORWARDED during the startup delay window",
                  gap >= delay - 1.0,
                  "receipt_gap=%.2fs delay=%.1fs" % (gap, delay))
            check("tS06 collector accepting AT prompt receipt",
                  receipts[0].get("port_listening") == "yes",
                  "port_listening=%r" % receipts[0].get("port_listening"))
        if rid:
            check_turn_finalized(workdir, sid, rid, "tS07 prompt response",
                                 "graceful")
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tS08 launch path exits 0", rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_ready_fail_exit(repo, workdir, fake_bin=None, launcher=None,
                             largs=None):
    """Case C — the collector process EXITS before readiness (validate
    passes, the process dies without ever binding the port). Derived
    policy (from the existing fail-open semantics): the turn is
    uncaptured, the failure is surfaced through the start sidecar's
    error contract (bounded warning + start-error event), no run dir and
    no mapping are left behind, and the prompt STILL forwards
    (fail-open; the child may proceed without a collector). The wait is
    bounded: a collector that is already dead cannot hold the prompt
    until the full startup budget."""
    s = "readyfx"
    broken = os.environ.get("FG_PL_FAILEXIT_OTELCOL", "")
    if not broken or not os.path.exists(broken):
        bad("tU00 ready-fail-exit requires FG_PL_FAILEXIT_OTELCOL")
        return
    fake_log = os.path.join(workdir, "readyfx.fake.log")
    proc, err_path = launch(repo, workdir, s, extra={
        "FAKE_PROMPT_DELAY": "2",
        "FG_OTELCOL": broken,
        "FAKE_LOG": fake_log,
    })
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        mid = c.request("session/new", {"cwd": "/tmp"})
        msg = c.wait_response(mid)
        sid = (msg or {}).get("result", {}).get("sessionId")
        if not isinstance(sid, str) or not sid:
            bad("tU01 ready-fail-exit: session open")
            return
        t_send = time.time()
        mid_p = send_prompt(c, sid)
        resp = c.wait_response(mid_p, 60)
        t_resp = time.time()
        check("tU02 prompt response received (fail-open, stream intact)",
              bool(resp) and (resp.get("result") or {}).get("stopReason") == "end_turn")
        check("tU03 no indefinite wait: failure surfaced fast",
              (t_resp - t_send) < 20, "elapsed=%.1fs" % (t_resp - t_send))
        time.sleep(2.0)
        check("tU04 no run left behind (failed start cleaned up)",
              list_runs(workdir) == [], "runs=%s" % list_runs(workdir))
        check("tU05 no stale mapping", read_mapping(workdir, sid) is None,
              "mapping=%r" % read_mapping(workdir, sid))
        receipts = prompt_receipts(fake_log)
        check("tU06 prompt forwarded exactly once",
              len(receipts) == 1, "receipts=%s" % receipts)
        if receipts:
            check("tU07 fail-open: forwarded without readiness (no collector)",
                  receipts[0].get("port_listening") == "no",
                  "port_listening=%r" % receipts[0].get("port_listening"))
        err = open(err_path).read()
        check("tU08 failure surfaced through the harness result mechanism",
              "not captured" in err, "stderr tail=%r" % err[-300:])
        check("tU09 relay recorded the start error",
              has_event(workdir, "start-error session=%s" % sid),
              "events=%s" % " | ".join(relay_events(workdir)[-8:]))
        check("tU10 ACP stream fully functional while uncaptured", c.wait_pong())
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tU11 launch path exits 0 (fail-open never breaks the session)",
              rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


def scenario_ready_fail_timeout(repo, workdir, fake_bin=None, launcher=None,
                                largs=None):
    """Case D — the collector process stays ALIVE but never becomes
    ready (never binds the port). The control surface's bounded startup
    budget (15s) must fail the start: kill + cleanup + explicit error.
    The relay must not hang, must leave no run and no mapping, and must
    still forward the prompt (fail-open)."""
    s = "readyft"
    never = os.environ.get("FG_PL_NEVERREADY_OTELCOL", "")
    if not never or not os.path.exists(never):
        bad("tV00 ready-fail-timeout requires FG_PL_NEVERREADY_OTELCOL")
        return
    fake_log = os.path.join(workdir, "readyft.fake.log")
    proc, err_path = launch(repo, workdir, s, extra={
        "FAKE_PROMPT_DELAY": "2",
        "FG_OTELCOL": never,
        "FAKE_LOG": fake_log,
    })
    try:
        c = Client(proc)
        c.wait_response(c.request("initialize"), 30)
        mid = c.request("session/new", {"cwd": "/tmp"})
        msg = c.wait_response(mid)
        sid = (msg or {}).get("result", {}).get("sessionId")
        if not isinstance(sid, str) or not sid:
            bad("tV01 ready-fail-timeout: session open")
            return
        t_send = time.time()
        mid_p = send_prompt(c, sid)
        resp = c.wait_response(mid_p, 90)
        t_resp = time.time()
        check("tV02 bounded startup timeout: prompt forwarded within budget",
              resp is not None and (t_resp - t_send) < 35,
              "elapsed=%.1fs" % (t_resp - t_send))
        time.sleep(3.0)
        check("tV03 no orphaned owned capture",
              list_runs(workdir) == [], "runs=%s" % list_runs(workdir))
        check("tV04 no stale mapping", read_mapping(workdir, sid) is None,
              "mapping=%r" % read_mapping(workdir, sid))
        receipts = prompt_receipts(fake_log)
        check("tV05 prompt forwarded exactly once, without readiness",
              len(receipts) == 1
              and receipts[0].get("port_listening") == "no",
              "receipts=%s" % receipts)
        check("tV06 relay recorded the start error (startup budget failed)",
              has_event(workdir, "start-error session=%s" % sid),
              "events=%s" % " | ".join(relay_events(workdir)[-8:]))
        check("tV07 failure surfaced (turn not captured)",
              "not captured" in open(err_path).read())
        check("tV08 ACP stream fully functional while uncaptured", c.wait_pong())
        proc.stdin.close()
        rc = proc.wait(timeout=60)
        check("tV09 launch path exits 0", rc == 0, "rc=%s" % rc)
    finally:
        shutdown(proc)


SCENARIOS = {
    "prompt-turn": scenario_prompt_turn,
    "id-correlation": scenario_id_correlation,
    "close-cleanup": scenario_close_cleanup,
    "crash-interrupted": scenario_crash_interrupted,
    "no-session": scenario_no_session,
    "concurrency": scenario_concurrency,
    "verify-correlation": scenario_verify_correlation,
    "opt-out": scenario_opt_out,
    "stale-runid": scenario_stale_runid,
    "exit-status": scenario_exit_status,
    "signal-terminated": scenario_signal_terminated,
    "fail-open": scenario_fail_open,
    "doctor-snapshot": scenario_doctor_snapshot,
    "trampoline-session": scenario_trampoline_session,
    "trampoline-optout": scenario_trampoline_optout,
    "raw-stream": scenario_raw_stream,
    "session-reopen": scenario_session_reopen,
    "map-fail": scenario_map_fail,
    "ndjson-wire": scenario_ndjson_wire,
    "ready-ordering": scenario_ready_ordering,
    "ready-delayed": scenario_ready_delayed,
    "ready-fail-exit": scenario_ready_fail_exit,
    "ready-fail-timeout": scenario_ready_fail_timeout,
}


def main():
    if len(sys.argv) < 4 or sys.argv[1] not in SCENARIOS:
        sys.stderr.write("usage: acp-scenario-driver.py <scenario> --repo <repo> --workdir <dir> [--fake-bin <dir>]\n")
        return 2
    scenario = sys.argv[1]
    repo = workdir = fake_bin = launcher = None
    largs = []
    args = sys.argv[2:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--repo":
            repo = args[i + 1]; i += 2
        elif a == "--workdir":
            workdir = args[i + 1]; i += 2
        elif a == "--fake-bin":
            fake_bin = args[i + 1]; i += 2
        elif a == "--launcher":
            launcher = args[i + 1]; i += 2
        elif a == "--largs":
            # Everything until the next *driver* option is a launcher
            # argument; launcher args may themselves start with "--".
            i += 1
            while i < len(args) and args[i] not in (
                    "--repo", "--workdir", "--fake-bin", "--launcher",
                    "--largs"):
                largs.append(args[i]); i += 1
        else:
            i += 1
    if not repo or not workdir:
        return 2
    SCENARIOS[scenario](repo, workdir, fake_bin or "/usr/bin",
                        launcher=launcher, largs=largs or None)
    if FAILURES:
        print("scenario %s: %d passed, %d failed" % (scenario, PASSES, len(FAILURES)))
        return 1
    print("scenario %s: all %d checks passed" % (scenario, PASSES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
