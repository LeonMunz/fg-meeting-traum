#!/usr/bin/env node
/**
 * FG Workspace - deterministic fake ACP agent for probe-client contract tests.
 *
 * Mirrors the codex-acp 1.7.0 ACP v1 request contract for the methods the
 * probe client uses (initialize, session/new, session/prompt).
 * session/prompt is validated against the exact 1.7.0 schema
 * ({ sessionId, prompt: ContentBlock[] } with text blocks
 * { type: "text", text }); any other shape - including the legacy
 * "content" key - is rejected with the same -32602 "Invalid params"
 * shape the real adapter emits. The received prompt params are appended to
 * the file named by FAKE_ACP_PARAMS_FILE for assertions.
 *
 * FAKE_ACP_INVALID_RESPONSE=1 makes even a valid prompt fail with -32602 to
 * test the client's clean JSON-RPC error reporting.
 */
import { createInterface } from "node:readline";
import fs from "node:fs";

const paramsFile = process.env.FAKE_ACP_PARAMS_FILE || "";
const invalidResponse = process.env.FAKE_ACP_INVALID_RESPONSE === "1";
const SESSION_ID = "fake-session-0001";

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function invalidParams(id) {
  write({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32602,
      message: "Invalid params",
      data: {
        _errors: [],
        prompt: { _errors: ["Invalid input: expected array, received undefined"] },
      },
    },
  });
}

function promptShapeValid(p) {
  return (
    p &&
    p.sessionId === SESSION_ID &&
    Array.isArray(p.prompt) &&
    p.prompt.length >= 1 &&
    p.prompt.every(
      (b) => b && b.type === "text" && typeof b.text === "string" && b.text.length > 0,
    ) &&
    !("content" in p)
  );
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-acp-agent", title: "Fake ACP Agent", version: "0.0.0" },
        agentCapabilities: {},
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: SESSION_ID } });
    return;
  }
  if (msg.method === "session/prompt") {
    if (paramsFile) {
      try {
        fs.appendFileSync(paramsFile, JSON.stringify(msg.params) + "\n");
      } catch {}
    }
    if (!promptShapeValid(msg.params) || invalidResponse) {
      invalidParams(msg.id);
      return;
    }
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "fake-tc-1",
          kind: "execute",
          title: "shell",
          status: "completed",
        },
      },
    });
    write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (msg.method === "session/request_permission") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    return;
  }
  if (msg.method && msg.id !== undefined) {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
