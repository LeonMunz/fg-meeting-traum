#!/usr/bin/env node
/**
 * FG Workspace — minimal ACP client for the native-OTel acceptance probe.
 *
 * Drives the SAME ACP adapter used by normal product sessions
 * (@agentclientprotocol/codex-acp) with one harmless prompt that makes the
 * agent run a single shell command, so the captured trace contains
 * conversation start, tool activity and turn completion.
 *
 * Protocol: Agent Client Protocol v1 (NDJSON JSON-RPC 2.0 over stdio).
 * No dependencies beyond the Node.js stdlib.
 *
 * Usage:
 *   node acp-probe-client.mjs --adapter <path-to-codex-acp-dist-index.js> \
 *     --cwd <scratch-dir> --prompt "<harmless task>" \
 *     --timeout <ms> --log <file>
 *
 * Output: one JSON summary object on stdout (exit 0) or an error object
 * (exit 1). Permission requests are auto-approved (allow_once preferred)
 * and every approval is written to --log.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = { timeout: 180000 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error("missing value for " + a);
      return argv[i];
    };
    if (a === "--adapter") out.adapter = next();
    else if (a === "--cwd") out.cwd = next();
    else if (a === "--prompt") out.prompt = next();
    else if (a === "--timeout") out.timeout = Number(next());
    else if (a === "--log") out.log = next();
    else throw new Error("unknown arg: " + a);
  }
  for (const k of ["adapter", "cwd", "prompt"]) {
    if (!out[k]) throw new Error("missing required arg --" + k);
  }
  return out;
}

const args = parseArgs(process.argv);

const logLines = [];
function log(line) {
  const entry = String(line);
  logLines.push(entry);
  process.stderr.write(entry + "\n");
}
function flushLog() {
  try {
    if (args.log) fs.writeFileSync(args.log, logLines.join("\n") + "\n");
  } catch (err) {
    log("probe-log-write-failed: " + err.message);
  }
}

const adapter = spawn(process.execPath, [args.adapter], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let adapterStderr = "";
adapter.stderr.on("data", (d) => {
  adapterStderr += d.toString();
  if (adapterStderr.length > 200000) adapterStderr = adapterStderr.slice(-200000);
});
adapter.on("error", (err) => {
  log("probe-adapter-spawn-error: " + err.message);
});

const pending = new Map(); // id -> {resolve, reject}
let nextId = 1;

function send(method, params, { notify = false } = {}) {
  const msg = { jsonrpc: "2.0", method, params };
  if (!notify) msg.id = nextId++;
  adapter.stdin.write(JSON.stringify(msg) + "\n");
  if (notify) return undefined;
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject });
  });
}

const toolCalls = new Map();
let messageChars = 0;
let planCount = 0;
let sessionId = null;

function noteSessionUpdate(params) {
  const u = params && params.update ? params.update : {};
  const kind = u.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const t = u.content && typeof u.content.text === "string" ? u.content.text : "";
    messageChars += t.length;
  } else if (kind === "tool_call" || kind === "tool_call_update") {
    const id = u.toolCallId || u.tool_call_id || u.id || null;
    const prev = (id && toolCalls.get(id)) || {};
    const merged = {
      ...prev,
      title: u.title || prev.title,
      kind: u.kind || prev.kind,
      status: u.status || prev.status,
      raw: JSON.stringify(u).slice(0, 400),
    };
    if (id) toolCalls.set(id, merged);
  } else if (kind === "plan") {
    planCount += 1;
  }
  log("update:" + (kind || "?") + " " + JSON.stringify(u).slice(0, 300));
}

function respondPermission(req) {
  const params = req.params || {};
  const options = Array.isArray(params.options) ? params.options : [];
  log("permission-request options=" + JSON.stringify(options.map((o) => o && (o.optionId || o.kind))));
  const pick =
    options.find((o) => o && o.optionId === "allow_once") ||
    options.find((o) => o && /allow|proceed|accept/i.test(String(o.optionId || ""))) ||
    options.find((o) => o && String(o.kind || "").startsWith("allow"));
  if (pick) {
    log("permission-auto-approved: " + JSON.stringify(pick));
    return { outcome: { outcome: "selected", optionId: pick.optionId } };
  }
  log("permission-cancelled (no allow option): " + JSON.stringify(options).slice(0, 300));
  return { outcome: { outcome: "cancelled" } };
}

async function handleAgentRequest(req) {
  const { id, method, params } = req;
  let result;
  switch (method) {
    case "session/request_permission":
      result = respondPermission(req);
      break;
    case "fs/read_text_file": {
      const p = params && params.path ? String(params.path) : "";
      try {
        result = { content: fs.readFileSync(p, "utf8") };
      } catch (err) {
        adapter.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "read failed: " + err.message.slice(0, 200) } }) + "\n",
        );
        return;
      }
      break;
    }
    case "fs/write_text_file": {
      const p = params && params.path ? String(params.path) : "";
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(params.content || ""));
        result = {};
      } catch (err) {
        adapter.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "write failed: " + err.message.slice(0, 200) } }) + "\n",
        );
        return;
      }
      break;
    }
    default:
      adapter.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not supported by probe: " + method } }) + "\n",
      );
      return;
  }
  adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

const rl = createInterface({ input: adapter.stdout });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log("probe-adapter-nonjson: " + line.slice(0, 200));
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error).slice(0, 400)));
      else p.resolve(msg.result);
    }
    return;
  }
  if (msg.method === "session/update" && msg.params) {
    noteSessionUpdate(msg.params);
    return;
  }
  if (msg.method && msg.id !== undefined) {
    handleAgentRequest(msg).catch((err) => log("probe-handle-error: " + err.message));
    return;
  }
});

function finish(code, summary) {
  summary.durationMs = Date.now() - startedAt;
  flushLog();
  try {
    adapter.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      if (!adapter.killed) adapter.kill("SIGKILL");
    } catch {}
    console.log(JSON.stringify(summary, null, 2));
    process.exit(code);
  }, 500).unref();
}

const startedAt = Date.now();
const deadline = startedAt + args.timeout;
let stopped = false;
function stop(reason) {
  if (stopped) return;
  stopped = true;
  finish(1, { ok: false, reason, sessionId, toolCalls: [...toolCalls.values()], messageChars });
}

const guard = setTimeout(() => stop("probe-timeout after " + args.timeout + "ms"), args.timeout);

try {
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "fg-native-otel-probe", title: "FG Native OTel Probe", version: "1.0.0" },
  });
  log("initialize ok: " + JSON.stringify(init).slice(0, 300));

  const session = await send("session/new", {
    cwd: args.cwd,
    additionalDirectories: [],
    mcpServers: [],
  });
  sessionId = session.sessionId;
  log("session/new ok: " + String(sessionId));

  const promptResult = await Promise.race([
    send("session/prompt", {
      sessionId,
      // ACP v1 as implemented by codex-acp 1.7.0: params are
      // { sessionId, prompt: ContentBlock[] }; a text block is
      // { type: "text", text } (schema: zPromptRequest / zContentBlock).
      prompt: [{ type: "text", text: args.prompt }],
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("prompt timed out at " + args.timeout + "ms")), Math.max(1000, args.timeout - 2000)),
    ),
  ]);
  clearTimeout(guard);
  const stopReason = promptResult && promptResult.stopReason;
  log("prompt complete stopReason=" + String(stopReason));
  finish(
    stopReason === "end_turn" || stopReason === "cancelled" ? 0 : 1,
    {
      ok: true,
      stopReason: stopReason || "unknown",
      sessionId,
      toolCalls: [...toolCalls.values()],
      planCount,
      messageChars,
      adapterStderrTail: adapterStderr.slice(-1500),
    },
  );
} catch (err) {
  clearTimeout(guard);
  log("probe-failed: " + (err && err.message ? err.message : String(err)));
  log("adapter-stderr-tail: " + adapterStderr.slice(-1500));
  finish(1, {
    ok: false,
    error: err && err.message ? err.message : String(err),
    sessionId,
    toolCalls: [...toolCalls.values()],
    messageChars,
    adapterStderrTail: adapterStderr.slice(-1500),
  });
}
