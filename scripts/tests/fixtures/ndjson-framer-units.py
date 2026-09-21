#!/usr/bin/env python3
"""
Test fixture: unit tests for the relay's NDJSON wire observer
(NdjsonFramer in scripts/observability/acp-lifecycle-relay.py).

Runs without a collector: raw byte chunks are fed straight into the
framer and asserted on via the observer callbacks. Prints ok/FAIL
lines; exit 1 on any failure.

Coverage (the exact real-failure regression at unit level):
  * fragmented byte reads reconstruct NDJSON lines;
  * several JSON-RPC lines in one read are all observed;
  * an oversized line is skipped for that line only (one bounded
    frame-skipped) and observation resumes on the next line;
  * an oversized line's content is never handed to the observer;
  * a malformed JSON line records a bounded diagnostic and does not
    kill observation;
  * CRLF line endings are tolerated; blank lines are ignored;
  * the old failure cannot recur: a long line without any CRLF header
    terminator is just a (long) line — no stream-wide bypass exists.
"""

import importlib.util
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
RELAY = os.path.join(REPO, "scripts", "observability", "acp-lifecycle-relay.py")

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


def load_framer():
    spec = importlib.util.spec_from_file_location(
        "fg_acp_lifecycle_relay", RELAY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.NdjsonFramer


def make(Framer):
    msgs, errors, skipped = [], [], []
    fr = Framer(msgs.append, on_error=errors.append,
                on_skipped=lambda: skipped.append(1))
    return fr, msgs, errors, skipped


def chunks(data, n):
    for i in range(0, len(data), n):
        yield data[i:i + n]


def main():
    Framer = load_framer()
    max_line = Framer.MAX_LINE

    # 1) fragmented byte reads reconstruct one NDJSON line
    fr, msgs, errors, skipped = make(Framer)
    line = (json.dumps({"jsonrpc": "2.0", "id": 1, "method": "session/new",
                        "params": {"cwd": "/tmp"}}) + "\n").encode()
    for ch in chunks(line, 3):
        fr.feed(ch)
    check("u01 fragmented reads reconstruct one line",
          len(msgs) == 1 and msgs[0]["method"] == "session/new",
          "msgs=%d" % len(msgs))
    check("u02 no diagnostics for clean traffic",
          not errors and not skipped, "errors=%s skipped=%s" % (errors, skipped))

    # 2) several JSON-RPC lines in one read
    fr, msgs, errors, skipped = make(Framer)
    two = (json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}) + "\n"
           + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "session/close",
                         "params": {"sessionId": "s1"}}) + "\n")
    fr.feed(two.encode())
    check("u03 two lines in one read both observed",
          [m["id"] for m in msgs] == [1, 2], "msgs=%s" % msgs)

    # 3) a line split across reads; the terminator arrives later
    fr, msgs, errors, skipped = make(Framer)
    line = (json.dumps({"jsonrpc": "2.0", "id": 3, "method": "session/resume",
                        "params": {"sessionId": "s2"}}) + "\n").encode()
    fr.feed(line[:-1])
    check("u04 unterminated line not delivered early", msgs == [])
    fr.feed(b"\n")
    check("u05 terminator in a later read completes the line",
          len(msgs) == 1 and msgs[0]["method"] == "session/resume")

    # 4) oversized line: skipped for that line only
    fr, msgs, errors, skipped = make(Framer)
    marker = "FG_FRAMER_UNIT_MARKER"
    big = (json.dumps({"jsonrpc": "2.0", "method": "session/prompt",
                       "params": {"prompt": [{"text":
                                               marker + "x" * (max_line + 5000)}]}})
           + "\n").encode()
    assert len(big) > max_line
    nextline = (json.dumps({"jsonrpc": "2.0", "id": 9, "method": "session/load",
                            "params": {"sessionId": "s3"}}) + "\n").encode()
    for ch in chunks(big, 70000):
        fr.feed(ch)
    check("u06 oversized line skipped (one bounded diagnostic, not observed)",
          skipped == [1] and msgs == [],
          "skipped=%s msgs=%d" % (skipped, len(msgs)))
    fr.feed(nextline)
    check("u07 observation resumes on the next line",
          len(msgs) == 1 and msgs[0]["method"] == "session/load"
          and msgs[0]["params"]["sessionId"] == "s3", "msgs=%s" % msgs)
    check("u08 oversized content never handed to the observer",
          all(marker not in json.dumps(m) for m in msgs))

    # 4b) oversized line whose tail + the next line arrive in one read
    fr, msgs, errors, skipped = make(Framer)
    fr.feed(big[:-1])
    check("u09 skip state survives chunk boundaries",
          msgs == [] and skipped == [1], "skipped=%s" % skipped)
    fr.feed(b"\n" + nextline)
    check("u10 terminator + next line in one read",
          len(msgs) == 1 and msgs[0]["method"] == "session/load",
          "msgs=%s" % msgs)

    # 4c) a line exactly at the bound is still observed (boundary)
    fr, msgs, errors, skipped = make(Framer)
    base = json.dumps({"jsonrpc": "2.0", "id": 4, "pad": ""})
    pad = "y" * (max_line - 1 - len(base))
    fit = json.dumps({"jsonrpc": "2.0", "id": 4, "pad": pad}) + "\n"
    assert len(fit.encode()) == max_line
    fr.feed(fit.encode())
    check("u11 a line at the observation bound is observed",
          len(msgs) == 1 and msgs[0]["id"] == 4,
          "line_bytes=%d skipped=%s" % (len(fit.encode()) - 1, skipped))

    # 5) malformed JSON line: bounded diagnostic, observation continues
    fr, msgs, errors, skipped = make(Framer)
    good = json.dumps({"jsonrpc": "2.0", "id": 5, "method": "test/ping"}) + "\n"
    fr.feed(b"this is not json\n")
    check("u12 malformed line: one bounded diagnostic, no crash",
          len(errors) == 1 and "malformed-json line" in errors[0],
          "errors=%s" % errors)
    fr.feed(good.encode())
    check("u13 malformed line does not kill observation",
          len(msgs) == 1 and msgs[0]["id"] == 5, "msgs=%s" % msgs)

    # 6) CRLF tolerated; blank lines ignored
    fr, msgs, errors, skipped = make(Framer)
    crlf = (json.dumps({"jsonrpc": "2.0", "id": 6, "method": "session/delete",
                        "params": {"sessionId": "s4"}}) + "\r\n").encode()
    fr.feed(b"\r\n" + crlf + b"\n" + crlf)
    check("u14 CRLF lines and blank lines",
          len(msgs) == 2 and all(m["method"] == "session/delete" for m in msgs)
          and not errors and not skipped,
          "msgs=%d errors=%s" % (len(msgs), errors))

    # 7) the old failure cannot recur: a long line WITHOUT any CRLF
    #    header terminator (which the old LSP framer treated as
    #    headers-oversized and bypassed forever) is just a long line
    fr, msgs, errors, skipped = make(Framer)
    long_line = (json.dumps({"jsonrpc": "2.0", "id": 7, "method": "test/ping",
                             "pad": "z" * 20000}) + "\n").encode()
    assert len(long_line) > 8192
    for ch in chunks(long_line, 8192):
        fr.feed(ch)
    check("u15 long-but-valid line observed (no headers-oversized bypass)",
          len(msgs) == 1 and msgs[0]["id"] == 7 and not skipped,
          "skipped=%s errors=%s" % (skipped, errors))

    print("ndjson framer units: %d passed, %d failed" % (PASSES, len(FAILURES)))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
