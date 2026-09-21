#!/usr/bin/env python3
"""
Test fixture: long-lived fake ACP server (newline-delimited JSON-RPC
framing — the real ACP stdio wire format).

Stands in for the original product launcher (codex-acp) in the
agent-product-launch lifecycle tests. Speaks just enough of the ACP
JSON-RPC surface for the lifecycle tests:

  initialize        -> {"protocolVersion": 1}
  session/new       -> {"sessionId": <prefix><counter>}   (a fresh id each)
  session/load      -> {}                                  (sessionId in params)
  session/resume    -> {}                                  (sessionId in params;
                    mirrors codex-acp 1.7.0: resume an existing session
                    WITHOUT replaying history)
  session/fork      -> {"sessionId": <prefix>f<counter>}   (a fresh id each;
                    mirrors the ACP fork response carrying the new id)
  session/close     -> {}
  session/delete    -> {}
  session/prompt    -> {"stopReason": "end_turn"}          (the prompt-turn
                    completion response; delay / crash / error modes below)
  test/ping         -> {"pong": true}
  test/fake-response-> emit a FORGED raw JSON-RPC response line to the
                    client (params: {"id": N, "stopReason"?: S,
                    "error"?: {...}}), then ack. Used to exercise exact
                    request-id correlation without waiting for the real
                    (delayed) prompt response.
  test/record-env   -> {}                                  (records env to FAKE_LOG)
  test/die          -> {} then exit FAKE_EXIT (default 0)
  test/crash        -> immediate os._exit(9) (no response)
  any other request -> {"echo": true}                      (transparency check)

Environment:
  FAKE_SESSION_ID_PREFIX  session id prefix (default "01fake")
  FAKE_LOG                optional file; test/record-env appends one line
  FAKE_EXIT               exit code for test/die (default 0)
  FAKE_PROMPT_DELAY       seconds to sleep BEFORE answering session/prompt
                          (default 0) — keeps the prompt turn active so the
                          scenarios can observe/forge into it
  FAKE_PROMPT_ERROR       1/true/yes -> the prompt response is a JSON-RPC
                          error (turn finalizes as interrupted)
  FAKE_PROMPT_CRASH       1/true/yes -> the server os._exit()s AFTER
                          FAKE_PROMPT_CRASH_DELAY (default 3) WITHOUT
                          answering the prompt (process crash mid-turn)
  FAKE_PROMPT_CRASH_EXIT  exit code for FAKE_PROMPT_CRASH (default 9)

The server stays alive across sessions (long-lived ACP server semantics)
and exits 0 on stdin EOF. It never echoes request bodies. Prompt
processing runs in a worker thread so test/fake-response is answered
even while a prompt is delayed.
"""

import json
import os
import sys
import threading
import time

_SEND_LOCK = threading.Lock()


def read_line(buf):
    """Read one newline-delimited JSON-RPC line from stdin.

    Return (line, rest) on a complete line, or (None, buf) on EOF.
    A line is terminated by \\n; a preceding \\r (CRLF) is tolerated.
    """
    while True:
        i = buf.find(b"\n")
        if i >= 0:
            line, rest = buf[:i], buf[i + 1:]
            if line.endswith(b"\r"):
                line = line[:-1]
            return line, rest
        more = sys.stdin.buffer.read(1)
        if not more:
            return None, buf
        buf += more


def send(obj):
    body = json.dumps(obj).encode("utf-8")
    with _SEND_LOCK:
        sys.stdout.buffer.write(body + b"\n")
        sys.stdout.buffer.flush()


def _truthy(value):
    return str(value or "").lower() in ("1", "true", "yes")


def handle_prompt(mid):
    """session/prompt worker: delay, then crash / error / stopReason result.

    Runs in a daemon thread so the main loop keeps reading (and can
    answer test/fake-response) while a prompt is pending.
    """
    if mid is None:
        return  # a prompt notification: nothing to answer, no test hooks
    delay = float(os.environ.get("FAKE_PROMPT_DELAY", "0") or 0)
    if _truthy(os.environ.get("FAKE_PROMPT_CRASH")):
        crash_delay = float(os.environ.get(
            "FAKE_PROMPT_CRASH_DELAY", str(delay if delay else 3)) or 0)
        sys.stdout.buffer.flush()
        time.sleep(crash_delay)
        os._exit(int(os.environ.get("FAKE_PROMPT_CRASH_EXIT", "9")))
    if delay:
        time.sleep(delay)
    if _truthy(os.environ.get("FAKE_PROMPT_ERROR")):
        send({"jsonrpc": "2.0", "id": mid,
              "error": {"code": -32000, "message": "fake prompt failure"}})
    else:
        send({"jsonrpc": "2.0", "id": mid,
              "result": {"stopReason": "end_turn"}})


def main():
    prefix = os.environ.get("FAKE_SESSION_ID_PREFIX", "01fake")
    counter = 0
    log_path = os.environ.get("FAKE_LOG")
    if log_path:
        try:
            with open(log_path, "a") as f:
                f.write("args:")
                for a in sys.argv[1:]:
                    f.write(" [%s]" % a)
                f.write("\n")
        except OSError:
            pass
    buf = b""
    while True:
        line, buf = read_line(buf)
        if line is None:
            break  # stdin EOF (a partial unterminated line is dropped)
        if not line.strip():
            continue  # blank line: nothing to observe
        try:
            msg = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue  # malformed line: skip it (keep the stream going)
        mid = msg.get("id")
        method = msg.get("method")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": mid,
                  "result": {"protocolVersion": 1, "agentCapabilities": {}}})
        elif method == "session/new":
            counter += 1
            sid = "%s%020d" % (prefix, counter)
            send({"jsonrpc": "2.0", "id": mid,
                  "result": {"sessionId": sid, "models": [],
                             "currentModelId": None}})
        elif method in ("session/load", "session/close", "session/delete"):
            if mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "session/resume":
            # Like session/load: the sessionId travels in the request
            # params; the result carries no sessionId (codex-acp returns
            # model/mode state here — irrelevant to the lifecycle).
            if mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "session/fork":
            counter += 1
            sid = "%sf%020d" % (prefix, counter)
            if mid is not None:
                send({"jsonrpc": "2.0", "id": mid,
                      "result": {"sessionId": sid, "models": [],
                                 "currentModelId": None}})
        elif method == "session/prompt":
            # The prompt turn: the response (stopReason) completes it.
            # A worker thread keeps the main loop responsive (forged
            # responses, pings, crash/die) while the turn is pending.
            t = threading.Thread(target=handle_prompt, args=(mid,), daemon=True)
            t.start()
        elif method == "test/fake-response":
            params = msg.get("params")
            params = params if isinstance(params, dict) else {}
            fid = params.get("id")
            if isinstance(params.get("error"), dict):
                send({"jsonrpc": "2.0", "id": fid, "error": params["error"]})
            else:
                send({"jsonrpc": "2.0", "id": fid,
                      "result": {"stopReason":
                                 params.get("stopReason", "end_turn")}})
            if mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "test/ping":
            send({"jsonrpc": "2.0", "id": mid, "result": {"pong": True}})
        elif method == "test/record-env":
            log_path = os.environ.get("FAKE_LOG")
            if log_path:
                with open(log_path, "a") as f:
                    f.write("FG_AGENT_RUN_ID:%s\n" % os.environ.get("FG_AGENT_RUN_ID", "<unset>"))
                    f.write("FG_PRODUCT_OBS_IN_WRAPPER:%s\n" % os.environ.get("FG_PRODUCT_OBS_IN_WRAPPER", "<unset>"))
            if mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "test/die":
            if mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "result": {}})
            sys.stdout.buffer.flush()
            sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
        elif method == "test/crash":
            sys.stdout.buffer.flush()
            os._exit(9)
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": {"echo": True}})


if __name__ == "__main__":
    main()
