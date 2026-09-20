# Agent Observability — Local Native-Codex Trace Capture

## Purpose

Normal Codex/ACP product-agent sessions can emit **native Codex
OpenTelemetry** events into a **local, privacy-conscious, git-ignored trace
store**. The goal is to base later Harness improvements (Run Ledger,
normalized Harness metrics) on actual observed behavior instead of
anecdotes.

This is a **local capture facility only**:

- No dashboards, no aggregate analytics (next slice: Run Ledger).
- No cloud observability vendor, no external telemetry backend — the only
  OTLP destination is a loopback collector on this machine.
- No monkey-patching of Codex/codex-acp; the repository owns only the
  collector configuration, scripts, schema, tests and this documentation.
- No product code changes, no Eval changes (`evals/` is untouched).

## Architecture

```text
Codex app-server (0.148.x, launched by the policy guard, driven by
@agentclientprotocol/codex-acp 1.7.0 over ACP — the normal product path)
  [otel] exporters (user-level config, explicit opt-in):
    logs    -> OTLP/HTTP JSON  127.0.0.1:4318/v1/logs
    traces  -> OTLP/HTTP JSON  127.0.0.1:4318/v1/traces
    metrics -> OTLP/HTTP JSON  127.0.0.1:4318/v1/metrics
        |
otelcol-contrib 0.161.0 (official OpenTelemetry Collector, pinned;
  binds 127.0.0.1 only; no external endpoints in the config)
  receivers:   otlp (http, loopback)
  processors:  memory_limiter -> batch -> transform (sanitization)
  exporters:   file (OTLP JSON, one object per line, bounded rotation)
        |
.artifacts/agent-runs/<run-id>/
  capture-manifest.json      normalized run manifest (schema_version 1)
  raw/logs.jsonl             sanitized OTLP JSON (log records = Codex events)
  raw/traces.jsonl           sanitized OTLP JSON (spans + span events)
  raw/metrics.jsonl          sanitized OTLP JSON (metrics, e.g. token usage)
  collector.log              collector stdout/stderr
  probe-client.log           (probe runs only)
```

Native vs repository-generated data:

- **Native (Codex)**: every telemetry record in the raw files — event
  names, attributes, spans, metrics, resource attributes. Codex decides
  what to emit; the repository never fabricates telemetry.
- **Repository-generated**: the collector config (sanitization), the
  manifest (metadata about the capture session: repo state, versions,
  endpoint, observed conversation IDs, event counts), and the run/state
  bookkeeping. The manifest is the normalization boundary: later analysis
  must consume the manifest + `docs/agent/trace-contract.json`, not
  ad-hoc raw OTel field names.

## Why the Codex config is user-level

Codex reads the `[otel]` section only from the **user-level** Codex
configuration (`$CODEX_HOME/config.toml` — in this deployment
`$CODEX_HOME` is normally `~/.codex-lucid`). Repository-local
`.codex/config.toml` cannot enable OTel. Therefore:

- the repository owns collector, config template, schema, scripts, docs;
- enabling telemetry is an **explicit, auditable user action**
  (`./scripts/agent-observability config` prints the exact block; the user
  adds it to their own Codex config);
- repository tooling **never edits** `$CODEX_HOME/config.toml` or any
  Codex authentication configuration.

## Exact Codex configuration

Add to `$CODEX_HOME/config.toml` (printed by `./scripts/agent-observability
config`; port must match `FG_OBS_PORT`, default 4318):

```toml
[otel]
environment = "dev"
log_user_prompt = false
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }
trace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/traces", protocol = "json" } }
metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/metrics", protocol = "json" } }
```

Notes:

- `log_user_prompt = false` is the privacy default and stays false. Codex
  emits a `codex.user_prompt` event with `prompt = "[REDACTED]"` and length
  counts; the (already redacted) `prompt` key is dropped by the collector
  anyway.
- `metrics_exporter` **must** be set explicitly: Codex's default routes
  product metrics to an external backend; this block redirects metrics to
  the local collector so nothing leaves the machine while observability is
  active.
- Endpoints are full URLs (Codex POSTs to them verbatim).
- The same `[otel]` block is used by the acceptance probe
  (`./scripts/agent-observability native-probe`), which injects it into a
  temporary overlay `CODEX_HOME` (real config copy + `auth.json` symlink)
  so the probe never touches the user's real Codex settings.

## Exact collector setup

- Distribution: official `otelcol-contrib` (OpenTelemetry Collector
  releases), version pinned in `scripts/observability/pins.json` with
  per-platform SHA-256 checksums (current: `0.161.0`).
- Install (explicit, opt-in, checksum-verified, repo-local and
  git-ignored): `./scripts/agent-observability install`
  (binary lands in `.artifacts/agent-observability/otelcol/<version>/`).
  Any `otelcol` on `PATH` or `FG_OTELCOL` is used instead, if present.
- Config template: `scripts/observability/otelcol-local.yaml` (rendered per
  run; loopback-only receiver; `transform` sanitization; `file` exporters
  per signal with rotation).
- The collector is started/stopped as a normal local process (PID file in
  the run directory); it is not a daemon and does not survive reboots.

## Command surface

```text
./scripts/agent-observability status [--json]
./scripts/agent-observability start
./scripts/agent-observability stop
./scripts/agent-observability doctor [--json]
./scripts/agent-observability config
./scripts/agent-observability install
./scripts/agent-observability native-probe
```

- `status` — read-only: collector availability/version, running/stopped,
  endpoint, output directory, resolved Codex home (explicit/discovered/
  not-found/ambiguous/invalid), Codex `[otel]` config state, Codex/
  codex-acp/collector versions.
- `start` — starts only the local collector. Idempotent; refuses a
  conflicting listener on the OTLP port; records PID/state; never touches
  product services.
- `stop` — graceful (SIGTERM, drain/flush, manifest finalization), handles
  already-stopped state, cleans transient PID files, never deletes trace
  history.
- `doctor` — end-to-end local OTLP capability: starts an ephemeral
  collector in a temp dir, injects a synthetic OTLP payload containing
  **fake secrets**, and verifies the payload is persisted **without** the
  secrets. Statuses: `AVAILABLE` / `NOT_CONFIGURED` / `BLOCKED` /
  `BROKEN`. `--json` for machine-readable output.
- `config` — prints the exact user-level Codex configuration and why it
  cannot live in the repository. It never edits anything. (No `--apply`:
  by design, user Codex configuration changes stay manual.)
- `install` — explicitly downloads the pinned collector release, verifies
  the SHA-256, installs into the git-ignored repo-local location.
- `native-probe` — the acceptance/diagnostic probe: runs one harmless
  prompt (a single shell `echo`) through the **same ACP adapter and Codex
  binary** used by normal product sessions (with the temporary overlay
  `CODEX_HOME` enabling local OTel), then reports the captured events and
  conversation IDs. Works from an ordinary terminal — no manual
  environment setup is needed for the common case:
  - `CODEX_HOME`: an explicitly set value is authoritative and is validated
    before use. When unset, the normal Codex home is discovered from the
    installed Codex conventions under `$HOME` (`$HOME/.codex`, then
    `$HOME/.codex-*` deployment variants, in sorted order). A candidate is
    valid only with a readable `config.toml` plus `auth.json`. Zero valid
    candidates or several valid candidates fail closed with a diagnostic —
    export `CODEX_HOME` to select one explicitly.
  - `CODEX_PATH`: an explicitly set value is authoritative, is validated
    before use, and is forwarded to the adapter. When unset, the probe
    leaves it unset so the codex-acp agent spawns its **bundled**
    `@openai/codex` — the default the adapter's ACP path itself applies
    (it does *not* fall back to `codex` on `PATH`; a `codex` on `PATH` may
    be a different Codex version than the bundled one, which would break
    trace-contract version alignment).
  The resolved home/path are reported in the evidence summary and in
  `status` (`codex_home` in `--json`).

## Privacy model

Layers, in order:

1. **Codex source**: `log_user_prompt = false`; no Codex 0.148.x OTel event
   carries hidden reasoning text (reasoning appears only as token counts in
   metrics). Nothing sensitive is emitted for prompts; tool arguments and
   output are emitted in full by the log events, so layer 2 is mandatory.
2. **Collector transform (deterministic key drops, not regex-only)**:
   dropped before persistence — `delete_key()` on
   `user.email`, `user.account_id`, `auth.env_provider_key_name`,
   `auth.header_name`, `auth.agent_id`, `auth.task_id`, `auth.request_id`,
   `auth.cf_ray`, `error.message`, `endpoint`, `prompt`, `arguments`,
   `output`, `mcp_servers` (log records, spans, span events) plus a
   defensive drop set on metric datapoint attributes. Resource attributes
   are handled by a **whitelist** — `keep_keys(resource.attributes,
   ["service.name", "service.version", "env"])` — so `host.name` and any
   other non-essential resource attribute (host identity, sdk fields,
   future additions) is dropped deterministically. (The OTTL resource
   context of otelcol-contrib 0.161 has no `delete` function; the
   whitelist is the deterministic mechanism and is the stronger guarantee.)
3. **Regex backstop**: the one retained free-text field
   (`originator`, the client originator string) is scanned for
   secret-shaped values (OpenAI/Google/GitHub/Slack/AWS key shapes,
   JWT-shaped tokens) and redacted in place.
4. **Storage**: everything stays under git-ignored
   `.artifacts/agent-runs/`; raw traces are never committed; credentials
   are never copied (the probe references `auth.json` by symlink inside a
   temp dir that is removed afterwards).

Fields intentionally retained (Harness-relevant, non-content):
timestamps, `conversation.id`, `event.name`, `model`, `app.version`
(Codex/app version), `originator` (session source), `reasoning_effort`
(metadata on `codex.conversation_starts`), `sandbox_policy`,
`approval_policy`, `auth_mode`, tool name/success/duration/`call_id`
(`codex.tool_result`, `codex.sandbox_outcome`), tool decision
(`codex.tool_decision`), API/request duration + HTTP status
(`codex.api_request`), token counts (metrics: `codex.turn.token_usage`,
`codex.api_request`), error status (`http.response.status_code`),
turn timing (`codex.turn_ttft`, spans), and bounded diagnostic counts
(`arguments_length`, `output_length`, `prompt_length`, `output_line_count`).

## Storage location, retention, correlation

- Storage: `.artifacts/agent-runs/<run-id>/` (`run-id` =
  `run-<UTC timestamp>` for captures, `probe-native-<UTC timestamp>` for
  probes); `.artifacts/agent-observability/` holds the pinned collector
  binary. `.artifacts/` is git-ignored.
- Retention: per-file rotation in the collector (`max_megabytes`,
  `max_days`, `max_backups`, defaults 32 MiB / 14 days / 10 backups) plus
  whole-run pruning by `start` (runs older than
  `FG_OBS_RETENTION_DAYS`, default 14, are removed).
- Correlation: every Codex event and span carries `conversation.id` (the
  native Codex conversation/session ID, which for ACP sessions matches
  `CODEX_SESSION_ID`). Tool invocations and results correlate by
  `call_id`; API requests correlate by `attempt` within the conversation.
  The manifest records the set of observed conversation IDs per run.
- Interruption safety: raw files are JSON lines (one self-contained OTLP
  payload per line); an interrupted run leaves at worst a truncated final
  line, which the manifest scan skips; prior runs are never rewritten or
  deleted by later runs.

## Trace contract

`docs/agent/trace-contract.json` (`schemaVersion: 1`) is the versioned
contract for the data later Harness analysis may depend on: stable event
names, the retained attribute keys per event, resource attributes, metric
names, the dropped set, and the manifest schema. Raw OTLP field names
outside that contract are implementation detail and may change.

## How to inspect one trace

```bash
./scripts/agent-observability status                  # where are the runs
RUN=.artifacts/agent-runs/<run-id>
python3 scripts/observability/manifest.py summary "$RUN"     # manifest
python3 -c 'import json,sys
for line in open(sys.argv[1]):
    for rl in json.loads(line).get("resourceLogs", []):
        for sl in rl.get("scopeLogs", []):
            for rec in sl.get("logRecords", []):
                a = {kv["key"]: kv["value"].get("stringValue", kv["value"]) for kv in rec.get("attributes", [])}
                print(a.get("event.timestamp"), a.get("event.name"), a.get("conversation.id"), a.get("model"), a.get("tool_name", ""))' "$RUN/raw/logs.jsonl" | head -40
jq . "$RUN/capture-manifest.json"
```

## Version compatibility

- Codex: `0.148.x` (the line used by `@agentclientprotocol/codex-acp
  1.7.0`, whose dependency is `@openai/codex ^0.148.0`). The event/
  attribute names in `trace-contract.json` were derived from the
  0.148.0 `codex-rs/otel` source and must be re-verified after a Codex
  upgrade (the contract test suite and `native-probe` are the checks).
- codex-acp: `1.7.0` (ACP protocol version 1).
- Collector: `otelcol-contrib 0.161.0` (pinned; upgrade = edit
  `scripts/observability/pins.json` + re-run `install` + re-run
  `doctor`/`native-probe`).

## Troubleshooting

- **No telemetry in a new run** — the user-level `[otel]` config is not
  active (check `status` → `codex otel config`), the collector is not
  running, or the port mismatched (`FG_OBS_PORT` must match the
  configured endpoints).
- **`doctor` BLOCKED** — port occupied (stop the running capture or set
  `FG_OBS_PORT`), sandbox denies loopback binding, or no `python3`.
- **`doctor` BROKEN** — event accepted but not persisted (collector
  config regression) or a fake secret survived sanitization (transform
  regression). Inspect the ephemeral run dir reported by the doctor.
- **`native-probe` fails to authenticate** — the probe references
  the resolved home's `auth.json` by symlink; verify the real Codex home is
  authenticated (`codex login` in the normal environment).
- **`native-probe` refuses before probing** — no valid Codex home was
  discoverable, or several were (the diagnostic lists what was checked):
  export `CODEX_HOME` explicitly. `CODEX_PATH` resolves the same way
  (explicit value, then `codex` on `PATH`).
- **Collector version mismatch** — `status` prints the active binary and
  version; the pinned version is in `scripts/observability/pins.json`.

## Disabling observability completely

1. `./scripts/agent-observability stop` (flushes and finalizes the run;
   trace history remains on disk until retention prunes it — delete
   `.artifacts/agent-runs/` to remove it now).
2. Remove the `[otel]` section from `$CODEX_HOME/config.toml` (Codex then
  emits nothing to the local collector; note Codex's own default product
  metrics behavior returns to what the Codex build ships).
3. Optionally `rm -rf .artifacts/agent-observability` to remove the
   pinned collector binary.

`agent-doctor` reports `agent_observability` as an **optional** capability:
a missing collector never gates the doctor result or any verification
profile unless `FG_DOCTOR_REQUIRE_OBSERVABILITY=1` is set.
