# Agent Observability — Local Native-Codex Trace Capture

## Purpose

Normal Codex/ACP product-agent sessions can emit **native Codex
OpenTelemetry** events into a **local, privacy-conscious, git-ignored trace
store**. The goal is to base later Harness improvements (Run Ledger,
normalized Harness metrics) on actual observed behavior instead of
anecdotes.

This is a **local capture facility only**:

- No dashboards, no aggregate analytics. The **Run Ledger** (below) is the
  normalized, versioned per-run record above this capture layer; cross-run
  analytics are a later stage that will consume ledger records only.
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

## Why the Codex config is user-level (and where the product home is)

Codex reads the `[otel]` section only from the **user-level** Codex
configuration (`$CODEX_HOME/config.toml`). **Repository-local
`.codex/config.toml` cannot enable OTel and is never presented as a valid
solution by any command in this repository.**

The product-agent `CODEX_HOME` is **host-managed** and may differ from the
controller shell's default home — do **not** assume `~/.codex`. Because the
controller shell does not inherit the host-managed product `CODEX_HOME`, this
repository keeps two strictly separate concepts:

- the **product-agent Codex home** — the home the normal product agent
  actually runs in (e.g. `$HOME/.codex-lucid` here); the only home that
  matters for product telemetry; and
- a **generic / standalone Codex home** — what `$HOME/.codex*` directory
  discovery finds (the controller shell's standalone Codex, e.g.
  `$HOME/.codex`). This is a *different* thing and is **never** used to tell
  the user where to configure product telemetry.

The **product** home is established **only from evidence**, in this
precedence (never from generic discovery):

1. `FG_PRODUCT_CODEX_HOME` — an explicit product-specific override;
2. `CODEX_HOME` — the live product-agent environment (the host exports
   `CODEX_HOME` to the product process); an explicitly set `CODEX_HOME` is
   authoritative and validated;
3. the persisted **product-runtime registration**
   (`.artifacts/agent-observability/product-runtime.json`, git-ignored),
   written by `./scripts/agent-observability product-runtime register` from
   inside a real product-agent session;
4. otherwise `not_registered` (or `corrupt`) — fail closed.

The standalone `.codex` is still surfaced by `status` as the clearly-labeled
*controller* home (informational only), and `native-probe` still uses generic
discovery when it needs a standalone authenticated home. A home that is
merely **unreadable in the current environment** (e.g. inside the agent
sandbox) is reported as `not_checked` rather than silently re-guessed.

Therefore:

- the repository owns collector, config template, schema, scripts, docs;
- enabling telemetry is an **explicit, auditable user action**
  (`./scripts/agent-observability config` prints the exact block **targeted
  at the resolved product `CODEX_HOME`**; the user adds it to their own
  Codex config in the controller shell);
- repository tooling **never edits** `$CODEX_HOME/config.toml` or any
  Codex authentication configuration (there is deliberately no
  `config --apply`: lossless TOML rewrite with comment preservation cannot
  be guaranteed without a heavyweight dependency, so configuration stays
  manual).

### Product runtime identity (registration)

Because an ordinary controller terminal cannot see the host-managed product
`CODEX_HOME`, the bridge is a small, local, privacy-safe **registration**
that a normal product-agent session writes once:

```bash
# run FROM INSIDE a normal product-agent session (where CODEX_HOME is set):
./scripts/agent-observability product-runtime register
```

- Writes only `.artifacts/agent-observability/product-runtime.json`
  (git-ignored) with exactly the bounded, non-secret identity:
  `schema_version`, `codex_home`, `codex_path`, `codex_acp_version`. It never
  stores environment dumps, auth contents, tokens, or prompt content.
- `CODEX_HOME` must be present in the registering environment, else it fails
  closed (exit 5). It **never infers** the product home.
- Idempotent for an unchanged runtime (byte-identical); an explicit
  re-registration deliberately replaces stale identity. There are no
  timestamps and no directory-name heuristics deciding which home is current.
- `./scripts/agent-observability product-runtime show` prints the registration
  (or `null` when absent).

The `context` command also records the registration idempotently as a
best-effort side-effect when run from a product-agent session, so the
structured-context adoption step doubles as the registration step.

Once registered, an ordinary controller shell reports
`product codex home: registered — <home>` and `config` targets exactly
`<home>/config.toml`. Before registration (or on a corrupt registration) it
reports `not registered` / `corrupt` and `config` refuses to print an
actionable destination.

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
./scripts/agent-observability start [--json]
./scripts/agent-observability stop [--stop-status graceful|interrupted]
./scripts/agent-observability doctor [--json]
./scripts/agent-observability config
./scripts/agent-observability install
./scripts/agent-observability native-probe
./scripts/agent-observability ledger [run-id] [--json]
./scripts/agent-observability annotate <run-id> --correction yes|no ...
./scripts/agent-observability context current|<run-id> --task-type T --session M
                     [--task-key K] [--harness-variant H]
./scripts/agent-observability current-run
./scripts/agent-observability product-runtime register|show
```

- `status` — read-only: collector availability/version (distinct from
  running/stopped — a controller-owned collector this shell cannot
  signal (EPERM) still counts as running; only a nonexistent PID
  (ESRCH) is stopped), endpoint + port state, output directory, the resolved
  **product** Codex home (`override` / `product_session` / `registered` /
  `not_registered` / `corrupt` / `invalid`), the product `[otel]` config
  state **with a loopback/privacy judgment** (`configured` = all exporters
  local on the expected port and `log_user_prompt` not true;
  `misconfigured` = `log_user_prompt = true` or a non-local/port-mismatched
  endpoint — only `scheme://host:port` is echoed, never other config values;
  `absent` / `not_checked`), a separately-labeled **controller**
  (generic/standalone) Codex home that is informational only and never used
  for product telemetry, whether the calling shell is itself a product-agent
  session (`CODEX_SESSION_ID`), and harness-local Codex/codex-acp/collector
  versions (`versions`; the `codex` entry is the calling shell's own
  discovery — informational, never capture metadata; the product Codex
  version is attributed by the ledger from telemetry).
- `start` — starts only the local collector for a **product run**
  (`run-<UTC ts>`, kind `capture`). Idempotent; refuses a conflicting
  listener on the OTLP port; records PID/state; captures the initial Git
  state; collects a read-only `agent-doctor.sh --json` snapshot into the
  run directory (a DEGRADED result is stored as evidence, a failed doctor
  leaves no file — capture never aborts on the doctor); never touches
  product services. The capture manifest does **not** record a seed-time
  Codex version (its `codex_version` field stays null): attributing the
  product Codex version from the collector shell's `codex` on `PATH` would
  conflate the standalone controller Codex with the captured product Codex —
  the ledger derives `runtime.codex_version` from telemetry instead (see the
  ledger's Codex version attribution bullet).
  - `--json` (machine-readable contract): stdout is exactly one JSON
    document — `{"schema_version": 1, "tool": "agent-observability",
    "status": "started" | "already_running", "run_id": "...", "run_dir":
    "...", "pid": <int>, "endpoint": "http://127.0.0.1:<port>"}` —
    emitted as a single write as soon as the collector is CONFIRMED
    ACCEPTING on its loopback OTLP endpoint — a bounded local
    TCP-connect probe of the OTLP port (the OTLP/HTTP listener IS the
    endpoint; no telemetry is consumed or altered by the probe) — so
    pollers can never observe a partial document, and `started` never
    precedes the point at which the endpoint accepts. A collector
    that exits before it can bind fails fast instead of spending the
    whole startup budget (the failure contract is unchanged: no JSON
    on stdout, explicit stderr error, cleanup, exit 1).
    `started` is the only status a caller may adopt as its own;
    `already_running` reports the run owned by ITS owner — a caller must
    never adopt it. On failure no JSON is written to stdout; errors go
    to stderr and the human exit codes are preserved (1 generic, 3
    collector missing, 4 port conflict). Doctor-snapshot diagnostics,
    when the snapshot runs, go to stderr only.
- `stop [--stop-status graceful|interrupted]` — graceful (SIGTERM,
  drain/flush, manifest finalization, end-of-run Git evidence), handles
  already-stopped state, cleans transient PID files, never deletes trace
  history — and then **automatically normalizes the run into
  `run-ledger.json`**, reporting the ledger path and the evidence gaps.
  A ledger normalization failure is reported distinctly (exit 9) and
  never loses the raw capture. `--stop-status graceful` (the default)
  records a normal close; `--stop-status interrupted` records the
  run as an interruption — used by the session-lifecycle relay's
  process-exit fallback and available for manually reconciling an
  orphaned run.
- `doctor` — end-to-end local OTLP capability: starts an ephemeral
  collector in a temp dir, injects a synthetic OTLP payload containing
  **fake secrets**, and verifies the payload is persisted **without** the
  secrets. Statuses: `AVAILABLE` / `NOT_CONFIGURED` / `BLOCKED` /
  `BROKEN`. `--json` for machine-readable output.
- `config` — read-only diagnosis + the exact user-level configuration,
  **targeted at the resolved product `CODEX_HOME`**, plus the current
  config state. When the product identity is unknown or corrupt it
  **refuses to print an actionable destination** and instead explains how to
  register the product runtime. It never edits anything, never prints auth
  contents, and never presents repository-local `.codex/config.toml` or the
  controller's standalone `.codex` as the product destination. (No
  `--apply`: by design, user Codex configuration changes stay manual.)
- `context current|<run-id> --task-type T --session M [--task-key K]
  [--harness-variant H]` — attaches the bounded structured run context
  (see Structured run context) to a product capture. `current` resolves
  the single **live** product capture (collector PID **alive** per the
  canonical liveness semantic — an existing process counts as alive whether
  it is signalable or merely permission-denied (EPERM, e.g. a controller-
  owned collector); only a nonexistent PID (ESRCH) is dead — plus manifest
  kind `capture`; probes never count) and fails closed with exit 10
  (zero) or exit 11 (multiple) — no timestamp-nearest guessing.
  Idempotent; existing fields are preserved. When run from a product-agent
  session it also records the product-runtime registration idempotently.
- `current-run` — read-only, deterministic resolver for the single **live**
  product capture (the same canonical liveness as `status` and `context
  current`). Prints just the run id; exits 10 (zero) / 11 (multiple). Use
  it to feed a reliable explicit `FG_AGENT_RUN_ID` to `agent-verify`
  across the controller/agent identity boundary.
- `product-runtime register|show` — record/show the bounded product-agent
  runtime identity (the product `CODEX_HOME`) that `status`/`config`/`start`
  use when no live `CODEX_HOME` is in scope. `register` must run FROM INSIDE
  a product-agent session, requires `CODEX_HOME`, writes the git-ignored
  `.artifacts/agent-observability/product-runtime.json` (only the bounded
  fields), never infers the home and never touches user config/auth.
  `show` prints the registration (or `null`), exiting 7 when corrupt.
- `install` — explicitly downloads the pinned collector release, verifies
  the SHA-256, installs into the git-ignored repo-local location.
- `ledger [run-id] [--json]` — normalizes one captured run into the
  versioned **Run Ledger** record (deterministic, idempotent; see below).
- `annotate <run-id> --correction yes|no [--category <c>] [--note <s>]
  [--classification <K>] [--for-failure <ref>]` — appends one explicit
  post-hoc human annotation (raw telemetry is never rewritten).
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
  The resolved home/path are reported in the probe evidence summary and in
  `status` (`controller_codex_home` in `--json`, the generic/standalone
  resolution).

### Canonical liveness semantic (EPERM vs ESRCH)

A liveness probe has three semantic outcomes, and the first two are
**alive**:

```text
signalable   process exists and we may signal it
denied       process exists but signaling is denied (EPERM) — e.g. a
             controller-owned collector started by a different identity
dead         process does not exist (ESRCH) or the pid is invalid
```

The controller shell starts the collector; a product-agent session is a
*different identity* and may not be able to signal it. Such a process is
alive, not dead — so `EPERM` and `ESRCH` must never be collapsed into one
boolean failure. The canonical helper `scripts/observability/liveness.py`
(`classify` / `is_alive`) is the single implementation of this semantic and
is shared by `status`, active-run discovery, `context current`, and
`current-run`. Python is the only portable *structured* mechanism here: on
macOS there is no `/proc`, and a shell `kill -0` returns the same nonzero
status for both EPERM and ESRCH (the difference is only in the localized
error text, which the repository never parses).

`agent-verify.sh` is deliberately decoupled from this helper (see the
verification-correlation note below): its auto-correlation stays
builtins-only so it never depends on Python or on observability being
installed.

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
  `run-<UTC timestamp>` for product captures, `probe-native-<UTC timestamp>`
  for probes). Each run may contain: `capture-manifest.json`,
  `raw/*.jsonl` (sanitized OTLP), `collector.log`,
  `agent-doctor-start.json` (read-only doctor snapshot from `start`),
  `run-context.json` (bounded structured context, when attached),
  verification-evidence JSON files (agent-verify `--summary-json` output,
  doctor JSON), `annotations.json` (explicit human annotations) and
  `run-ledger.json` (normalized record, generated by `stop` or `ledger`).
  `.artifacts/agent-observability/` holds the pinned collector binary and
  `session-runs/`, the git-ignored ACP session id → run id mapping used
  by the automatic product-session lifecycle (the run id of the
  session's active prompt turn, one bounded run id per session file;
  written when the turn's run comes up, released when the turn
  finalizes).
  `.artifacts/` is git-ignored.
- Retention: per-file rotation in the collector (`max_megabytes`,
  `max_days`, `max_backups`, defaults 32 MiB / 14 days / 10 backups) plus
  whole-run pruning by `start` (runs older than
  `FG_OBS_RETENTION_DAYS`, default 14, are removed).
- Correlation: every Codex event and span carries `conversation.id` (the
  native Codex conversation/session ID, which for ACP sessions matches
  `CODEX_SESSION_ID`). Tool invocations and results correlate by
  `call_id`; API requests correlate by `attempt` within the conversation.
  The manifest records the set of observed conversation IDs per run — and,
  for prompt-turn runs created by the ACP lifecycle relay, the persisted
  captured conversation identity (`captured_conversation_id`, the session
  that caused the run), which is authoritative for ledger attribution.
- Interruption safety: raw files are JSON lines (one self-contained OTLP
  payload per line); an interrupted run leaves at worst a truncated final
  line, which the manifest scan skips; prior runs are never rewritten or
  deleted by later runs.

## Trace contract

`docs/agent/trace-contract.json` (`schemaVersion: 2`) is the versioned
contract for the data later Harness analysis may depend on: stable event
names, the retained attribute keys per event, resource attributes, metric
names, the dropped set, and the manifest schema. Raw OTLP field names
outside that contract are implementation detail and may change.

## Run Ledger

The Run Ledger is the **normalization boundary** above the capture layer:

```text
raw sanitized OTel (logs/traces/metrics)  — only trace-contract fields
+ capture-manifest.json                    — session + end-of-run Git evidence
+ verification evidence JSON in run dir    — agent-verify/agent-doctor output
+ run-context.json                         — bounded structured run context
+ annotations.json                         — explicit human annotations
  ↓
.artifacts/agent-runs/<run-id>/run-ledger.json   (versioned record, schema
  docs/agent/ledger-contract.json — currently schemaVersion 3)
```

- `./scripts/agent-observability ledger [run-id] [--json]` normalizes one
  run (default: latest). Deterministic and idempotent: the record is a pure
  function of the stored evidence — no wall clock, no live git state — so
  re-running on unchanged evidence yields identical bytes. `stop` runs
  this normalization automatically after finalizing a run.
- **Event dedup identity is correlation tuple + sanitized content.** The
  ledger collapses a telemetry record as a duplicate of an already-seen
  record only when they share the correlation tuple (event name,
  timestamp, conversation id, reference id) **and** the canonical
  deterministic serialization of their full sanitized attribute set. This
  is what lets Codex 0.148.0's paired `response.completed` records for one
  API response (emitted in the same payload at the same millisecond, one
  without token counters and one with) survive as two distinct logical
  events, while byte/logically equivalent copies (e.g. the same event seen
  both as a log record and a span event) still collapse to one. The
  serialization is in-memory only and never written to the record, so the
  privacy boundary is unchanged; it depends only on sanitized content,
  never on insertion order, object identity, or randomized hashing.
- Missing optional evidence (metrics file, verification JSON, end-of-run
  git state on old captures, annotations, run context) yields `null`/empty
  values plus a stable code in `evidence_gaps` (e.g. `no_run_context`);
  nothing is guessed. Malformed required data (missing/mismatched capture
  manifest, foreign verification attribution, malformed run-context) fails
  with a nonzero exit code.
- **Captured conversation identity (schema v3).** The ACP lifecycle relay
  persists the native Codex conversation of the ACP session/prompt that
  caused a prompt-turn run into the capture manifest at start time
  (`captured_conversation_id`); the identity survives finalization and the
  release of the transient session/run mapping. When it is present, the
  primary `activity`, `failures` and token-usage metrics describe that
  captured turn ONLY: events and token datapoints from other conversations
  in the same raw run are reported explicitly in `activity.foreign`
  (bounded aggregate: foreign ids, request/tool counts, failures, token
  total) and never merged into the captured turn's metrics. Run-level
  infrastructure facts (`git_wip`, duration, runtime versions, stop
  status, `runtime.models` / `app_versions`, `identity.conversation_ids`)
  are deliberately not scoped. Without a persisted identity (historical or
  manual runs) the run-wide aggregate is preserved (backward compatible)
  and the explicit `captured_conversation_unknown` gap is recorded — no
  conversation is ever heuristically selected.
- **Verification correlation is explicit, never timestamp-guessed.**
  Explicit: `FG_AGENT_RUN_ID=<run-id> ./scripts/agent-verify.sh
  --summary-json .artifacts/agent-runs/<run-id>/verify-<profile>.json
  quick` records the run id in the summary (`agentRunId`); the ledger
  rejects a summary whose `agentRunId` does not equal the run id (exit 8).
  Automatic (deterministic, **best-effort**, only with `--summary-json`
  and `FG_AGENT_RUN_ID` unset) is two-tiered:
  1. **Session/run mapping** (automatic product-session lifecycle): when
     `CODEX_SESSION_ID` is set and the mapping
     `.artifacts/agent-observability/session-runs/<CODEX_SESSION_ID>`
     (overridable via `FG_PRODUCT_SESSION_MAP_DIR`) stores a run id whose
     run dir exists, that run is exactly this session's run — exact, no
     liveness scan, recorded as `agentRunId`. This is the automatic
     product-session correlation tier.
  2. **Single active capture** (manual start/stop flow): if the session
     mapping does not resolve, agent-verify discovers the **single
     active local product capture** (run dir whose collector pidfile
     names a live process and whose manifest kind is `capture`; probes
     never count) via a builtins-only `kill -0` probe and records it as
     `agentRunId`. Zero active captures keep `agentRunId: null`
     (historical behavior); multiple active captures are refused (exit
     2, no summary). The runs root for this discovery honors
     `FG_OBS_RUNS_DIR` (default `<repo>/.artifacts/agent-runs`); a
     missing directory simply yields no candidates — agent-verify never
     depends on observability being installed or enabled. Because that
     probe is builtins-only (no Python; it must work under the
     restricted test PATH), a shell `kill -0` cannot distinguish EPERM
     (exists, another identity) from ESRCH (absent): a **controller-
     owned** capture the agent cannot signal is treated as absent, so
     tier 2 is **same-identity only** and is not the reliable path
     across the identity boundary. For reliable correlation in manual
     flows, resolve the run id with `./scripts/agent-observability
     current-run` (canonical EPERM->alive liveness) and set
     `FG_AGENT_RUN_ID` explicitly. Doctor evidence: the read-only snapshot
  stored by `start` (`agent-doctor-start.json`), or redirect
  `./scripts/agent-doctor.sh --json` (or
  `./scripts/agent-observability doctor --json`) into the run directory.
  The doctor status is read from the explicit `result` field or the real
  `agent-doctor.sh` `summary.overall` field — never invented.
- **Comparability dimensions (schema v2).** `runtime` additionally carries
  `reasoning_effort`, `sandbox_mode` (from the native `sandbox_policy`)
  and `approval_policy` — taken from the **first**
  `codex.conversation_starts` event, only when the native event actually
  carries the attribute (0.148.0 emits `reasoning_effort` only when an
  effort is set). Absent values stay `null` and are represented
  explicitly by the `comparability` section: 12 fixed boolean dimensions
  (model, reasoning effort, Codex version, codex-acp version, sandbox
  mode, approval policy, task type, session mode, Git starting revision,
  verification evidence, doctor/environment evidence, explicit harness
  variant) plus a sorted `missing` list. The section answers only whether
  evidence exists — it is not a quality score and never ranks runs.
- **Codex version attribution (telemetry, not PATH).** `runtime.codex_version`
  is the Codex version that actually executed the captured turn, derived
  exclusively from the telemetry `app.version` attribute the Codex process
  itself emitted (the values of `runtime.app_versions`): exactly one distinct
  non-empty value observed in the run -> that value (no prefixing beyond the
  emitted value); zero or several distinct values -> `null` plus the stable
  gap code `codex_version_unresolved` (all observed values stay preserved in
  `app_versions`; nothing is guessed). The controller/standalone `codex` on
  `PATH` is never substituted: capture manifests no longer seed a codex
  version from the collector shell at all (the field stays `null` in
  captures; only `native-probe` records the exact binary the probe ran), and
  the standalone version remains available via `status`
  (`controller_codex_version`, informational only).
- **Historical captures.** v1/v2 ledger records remain valid documents and
  are never rewritten in place by any tooling. Captures made before v2
  normalize to v3 with null context/runtime values plus explicit
  evidence/comparability gaps. Captures made before v3 (no persisted
  captured conversation identity) normalize to v3 with
  `identity.captured_conversation_id` null: the primary activity is the
  run-wide aggregate, represented explicitly by the
  `captured_conversation_unknown` gap whenever at least one conversation
  was observed; nothing is guessed or back-filled.
- **Human intervention is never inferred.** `annotate` records, after the
  fact: whether a human correction occurred (`--correction yes|no`), a
  bounded category (required with `yes`), an optional note (≤ 280 chars),
  and — only when explicitly given — one of the four repository failure
  classifications attached to a named failure via `--for-failure`. An exit
  code or `success=false` never invents a semantic class.
- **Privacy:** the ledger copies only contract-named, already-sanitized,
  bounded fields (counts, statuses, durations, ids, file paths). It never
  contains prompt text, hidden reasoning, auth/token values, shell
  stdout/stderr, source diffs, environment dumps, or raw tool arguments.
  Raw tool names appear only as bounded failure identifiers; the by-type
  activity map uses broad categories (shell/file/search/web/plan/
  interaction/other). The run context is bounded by construction (closed
  enums + 1-128 char slugs; see below).
- The end-of-run Git evidence (`ending_head`, `ending_tree`, changed files,
  line totals, `commit_created`) is recorded once by the manifest at
  capture finalize, so later normalization stays reproducible.
- Unsupported by design (documented, never guessed): repeated-command
  count (command text is sanitized away), human intervention from
  telemetry, and any raw content.

## Structured run context

Cross-run analysis cannot safely infer task semantics from prompt text.
Each run may therefore carry a small, privacy-safe, **explicitly supplied**
structured context in `<run-dir>/run-context.json` (git-ignored with the
run, versioned `schema_version: 1`):

```json
{
  "schema_version": 1,
  "task_type": "Bug | Vertical Slice | Domain | Stabilization | Documentation",
  "session_mode": "CURRENT | NEW",
  "task_key": "<bounded slug> | null",
  "harness_variant": "<bounded slug> | null"
}
```

- `task_type` and `session_mode` are **closed enums** matching the
  repository's orchestration contract; they are attached with
  `./scripts/agent-observability context current|<run-id> --task-type T
  --session M` and are otherwise null.
- `task_key` (optional) explicitly pairs/group runs that represent the
  same logical task for future controlled comparisons; `harness_variant`
  (optional) labels explicit future A/B harness runs. Both are bounded
  slugs (1-128 chars of `[A-Za-z0-9._-]`, no whitespace) — **arbitrary
  prompt/chat text cannot be stored in any field**; malformed or
  prompt-shaped values fail closed (exit 2 at write, exit 7 on a
  corrupted stored file).
- Nothing is inferred: task type is never derived from the prompt, session
  mode is never derived from the transcript, and no extra free-form
  analytics tags exist.
- `current` resolves deterministically in two tiers: first the
  session/run mapping (`CODEX_SESSION_ID` → the exact run for this ACP
  session's active prompt turn — the automatic product-session
  tier; between turns the session has no mapping), then exactly one
  live
  product capture (collector PID alive + manifest kind `capture`;
  probes excluded). Zero live captures → exit 10; multiple → exit 11
  with the candidates named. An explicit run id always works
  (including after the run stopped).
- Updates are partial and idempotent: re-attaching the same values is a
  byte-identical no-op; fields not passed are preserved.
- The ledger (schema v2) copies the four fields into `context` and counts
  them among the comparability dimensions.

Agent adoption (root `AGENTS.md`, kept deliberately short): when a local
product capture is active, attach the task's already-given Task type and
Session to the resolved run once; never invent `task_key` or
`harness_variant`; if observability is unavailable, product work proceeds
normally.

## Automatic product-session lifecycle

`scripts/agent-product-launch` (repository-owned) installs a one-time
trampoline on the normal product launcher so that every ACP prompt
turn of a normal Lucid/Codex coding-agent session automatically
starts, correlates, finalizes, and normalizes its own observability
run — no per-turn or per-session `start`/`stop` commands, no user
action, no session closing.

The observability unit is the **ACP session/prompt turn**, not the ACP
session and not the ACP server process. The product launcher (the
long-lived `codex-acp` stdio server) is kept alive by Lucid across
many sessions and many prompts; each `session/prompt` request starts
exactly one observability run, and the matching `session/prompt`
response carrying a `stopReason` finalizes it — while the ACP session
itself stays open. The ACP `sessionId` remains a **persistent grouping
dimension** (identity, ledger conversation, telemetry correlation);
it is no longer the run boundary.

### Why prompt turns, not session or process lifetime

The earlier designs owned the run at launcher-process start and,
later, at the ACP session boundary (`session/new`/`session/load` →
start, `session/close`/`session/delete` → stop). Real acceptance
exposed both mismatches: Lucid neither terminates the ACP server
process after a task nor sends `session/close` when a prompt turn
finishes — it keeps the ACP session alive indefinitely for follow-up
prompts. A run owned at session open therefore never finalizes while
the chat is still open (`stop_status=running`, `end_ts=null`, no end
Git evidence, no ledger).

ACP defines the stronger boundary: the **prompt turn** — one
`session/prompt` request, the foreground agent work, and the matching
`session/prompt` response with a `stopReason`. The ACP specification's
TypeScript SDK defines exactly this response as prompt-turn
completion, and the installed `codex-acp` (1.7.0) returns
`{"stopReason": ...}` for every completed turn. The prompt turn is
therefore the normal finalization boundary; session close/delete and
process exit remain only fallback cleanup boundaries.

Interception option: the preferred client/host hook (A) and a
codex-acp extension hook (B) do not exist in the installed stack — the
Lucid client exposes no stable hook around ACP turns that can call
repository observability, and codex-acp exposes no supported
extension point (its installed source must not be monkey-patched).
The implementation is therefore the last-resort option (C): a
**transparent ACP lifecycle relay** between the client and the
original codex-acp process.

### Process model

```text
Lucid host
  → ~/.local/bin/lucid-codex-acp                (installed trampoline)
    → scripts/agent-product-launch launch       (guards, opt-out; exec)
      → scripts/observability/acp-lifecycle-relay.py
                                               (transparent ACP stdio
                                                relay + prompt-turn
                                                lifecycle sidecar;
                                                exec'd: same pid)
        → ~/.local/share/lucid-codex-acp/lucid-codex-acp.impl
                                               (original launcher,
                                                unchanged)
          → @agentclientprotocol/codex-acp → codex-policy-guard.py → Codex
```

The relay's only protocol role is observation:

- It forwards client stdin → child stdin and child stdout → client
  stdout byte-for-byte (preserving the newline-delimited JSON-RPC line
  framing and backpressure). `stdout` stays ACP-only; every diagnostic
  goes to stderr. Malformed lines are forwarded unchanged. There is
  exactly one ORDERING exception: the bytes of a CAPTURABLE
  `session/prompt` line are HELD (never modified, never dropped) from
  the moment its turn's start sidecar begins until the start contract
  confirms the collector is accepting OTLP — `started`, or the
  fail-open outcomes (`already_running` / error / timeout) — and are
  then forwarded unchanged; no other ACP message is held (see
  "Per-turn lifecycle", readiness ordering).
- It parses only enough of each line to read `method`, `id`, and
  `sessionId` (in `params`, or the `session/new` / `session/fork`
  `result`) for lifecycle methods. It never inspects, modifies, logs,
  or persists prompt or content blocks, and it retains at most one
  line at a time (bounded per-line observation; a line beyond the
  bound is skipped for that line only — the stream is never
  disabled).
- Session opens are recognized on **all four ACP open methods**
  (verified against the installed codex-acp 1.7.0, whose `initialize`
  result advertises `sessionCapabilities` with `load`, `resume`, and
  `fork` — and whose source shows `session/new` is the ONLY handler
  that creates a thread). Opens track the session IDENTITY only —
  they start NO run:
  - `session/new` — a FRESH session (the method a real fresh Lucid
    session uses). Remembered by request id (bounded pending set);
    the canonical `sessionId` arrives in the response — a short
    pending state, never an invented id.
  - `session/load` / `session/resume` — re-open of an EXISTING thread
    (the `sessionId` travels in the request params, the response
    carries no id). Each such re-open is a fresh root ACP session and
    is tracked as such.
  - `session/fork` — the response carries the NEW `sessionId`; the
    forked session is tracked as a fresh root ACP session.
- The **prompt turn** is the run boundary: a `session/prompt` request
  (the relay reads ONLY its request id and `params.sessionId` — never
  the prompt blocks) starts a run for that turn; the matching
  response, correlated by the EXACT request id (a late or foreign id
  never touches any run), finalizes it. From that response the relay
  reads only the correlation and `stopReason` (a bounded enum
  string) — never the result content.
- `session/close` and `session/delete` are **cleanup only**: they
  finalize an unexpectedly open turn (one whose prompt response never
  arrived) as `interrupted` and release the session state. A close of
  a session with no active turn finalizes nothing. A normal turn
  never needs a close: its response finalizes the run while the ACP
  session stays open.
- Run start/stop invoke the existing control surface as short-lived
  sidecars (`agent-observability start --json`, `agent-observability
  stop --stop-status graceful|interrupted`). The relay adds no
  capture state of its own beyond the session/run mapping.

### Session/run identity

- The ACP `sessionId` is the native Codex thread id: codex-acp returns
  `thread.id` as the ACP `sessionId`, and the same id reaches tool
  shells as `CODEX_SESSION_ID`. One identifier, end to end — it is the
  grouping dimension every run of the session shares.
- The mapping `.artifacts/agent-observability/session-runs/<session-id>`
  stores exactly one bounded run id per session file (git-ignored;
  atomic write): the id of that session's **active prompt turn**. It
  is written when the turn's run comes up and released when the turn
  finalizes; between turns the session has no mapping, and nothing
  resolves to a finished run.
- When the turn's run comes up, the relay persists the session's native
  Codex conversation id into the run's capture manifest
  (`captured_conversation_id`, at seed time). Unlike the mapping, that
  identity is durable run metadata: it survives finalization and the
  mapping release, and it is what the Run Ledger uses to attribute the
  primary activity to the captured turn (foreign telemetry in the same
  raw run is reported explicitly, never merged).
- One turn at a time per session (ACP serializes prompts per session):
  a prompt while a turn is in progress is not captured (one bounded
  record, stream untouched). A prompt to a closed session is a
  protocol violation: it is never resurrected.
- A previously closed session id re-opened (via `session/resume` /
  `session/load` / `session/new` with a recycled id) is a fresh root
  ACP session: its prompt turns get fresh runs, never the old ones.
- There is no timestamp-nearest matching, no newest-run guessing, no
  idle timers, no UI-close dependency, and no final-text heuristic
  anywhere in the automatic path.

### Correlation model (inside a turn)

The automatic path **does not export `FG_AGENT_RUN_ID`** — one
persistent ACP process serves many sessions and turns, so a
process-global id cannot represent them. Resolution is tiered:

1. **Session mapping (automatic path, authoritative)**:
   `CODEX_SESSION_ID` → mapping file → the exact run of this
   session's ACTIVE prompt turn. Both `agent-observability context
   current` and `agent-verify --summary-json` auto-correlation use
   this tier first. Between turns the session has no mapping, so
   nothing resolves — work outside an observed turn is simply not
   correlated, which is correct (there is no turn to correlate it
   to).
2. **Single live capture (manual path)**: with no session mapping,
   exactly one live capture is selected by pidfile liveness (probes
   excluded); multiple candidates are refused, never guessed.
3. **Explicit `FG_AGENT_RUN_ID`**: a manual/debug override that always
   wins. The automatic path never sets it; any inherited value is
   dropped at the launch boundary.

### Per-turn lifecycle

```text
session open (any of: session/new, session/load, session/resume,
session/fork — see "Process model" for where the sessionId travels)
   → identity tracking only (state "idle"); NO run starts
session/prompt request (client → server)
   → the prompt line is HELD at the relay (byte-intact; NOT yet
     forwarded to the Codex child) — for a captured prompt, collector
     readiness MUST precede the prompt's first bytes, so the turn's
     initial telemetry events cannot be lost to collector startup
   → start sidecar: agent-observability start --json
        started           → the collector is CONFIRMED ACCEPTING on its
                            loopback OTLP endpoint (the "started"
                            contract is only emitted once it is); the
                            mapping is written, the turn run is OPEN
                            (doctor snapshot + start Git evidence
                            recorded by start; the session's native
                            Codex conversation id persisted into the
                            run manifest as captured_conversation_id),
                            and the held prompt bytes are NOW forwarded
                            to the Codex child — readiness strictly
                            precedes the captured prompt's first byte
        already_running   → turn uncaptured (one observed turn at a
                            time — never attached, never merged); the
                            prompt is forwarded immediately — a turn
                            never waits for readiness of a collector
                            it does not own
        error / timeout   → fail open: turn uncaptured, one bounded
                            warning, stream intact; the prompt is
                            forwarded (the hold is bounded by the
                            control surface's startup budget, never an
                            indefinite wait; a collector that exited
                            before binding fails fast)
   → prompt while a turn is in progress: not captured (bounded
     record; ACP serializes prompts per session)
matching session/prompt response (carries stopReason)
   → stop sidecar: agent-observability stop --stop-status graceful
        → collector stopped, manifest finalized (end Git evidence),
          run-ledger.json generated, mapping released
   → the ACP session stays OPEN
   → late/duplicate response for the same id: bounded no-op
     (exactly-once finalization)
session/close (or session/delete) — CLEANUP ONLY, never required
   → active turn (response never arrived): stop sidecar
     --stop-status interrupted, mapping released
   → no active turn: release the session state only (nothing to
     finalize)
   → duplicate close: harmless no-op (exactly-once finalization)
   → unknown session close: no-op — never touches another run
child exit with an active prompt turn
   → pending start/stop sidecars are settled AND their contracts
     consumed (mapping write, start result) before finalization, so a
     run that came up in the same instant the child exited is still
     named, mapped, and stopped — never orphaned
   → the active turn finalizes as --stop-status interrupted
     (fallback boundary, never the normal close)
```

(readiness ordering: the prompt bytes are not forwarded to the Codex
child before the start contract resolves, so a prompt response or a
session close for the held turn cannot precede it in the normal flow;
the first-to-decide rule below is retained as the defensive contract
for the paths that can still interleave). A prompt response that
arrives before the start sidecar resolves finalizes the run with that
status as soon as it comes up (first-to-decide wins: a session close
that already arrived is kept as `interrupted`). A failed mapping write
fails open: the run starts and is live, the turn is simply not
captured (no mapping), the stream stays intact, and the prompt
response STILL finalizes the run — with a bounded `mapping-write-failed`
diagnostic. A failed finalization
(stop non-zero) leaves the raw evidence untouched and keeps the
mapping so a later close (or a manual `agent-observability stop`) can
re-finalize.

### Process failure fallback

ACP server process/transport exit is **only a fallback cleanup
boundary**: the prompt turn this connection still holds active is
finalized as `interrupted` (never graceful), no collector is left
orphaned, raw evidence is preserved, and the relay exits with the
child's exit status (128+signal when the child died by a signal that
was forwarded once). A process exit with no active turn produces no
run and no finalization side effects.

### Signals, exit status, and finalization policy

- INT/TERM/HUP are forwarded once to the child (by pid); the relay then
  waits for the child's real exit status. Further signals are consumed
  (single forward, single finalization). The child is launched through
  a small pre-exec shim that resets SIGINT to the OS default (a
  backgrounded child of a non-interactive bash shell otherwise inherits
  SIGINT IGNORED and could never trap it — the product process would
  silently lose its Ctrl-C semantics). The shim execs the delegate in
  place (same pid, argv, environment, stdio — indistinguishable from a
  direct launch). If no python3 is available, the launch path degrades
  to a direct exec of the original launcher (no relay, no capture).
- Finalization is exactly-once per run (idempotent manifest state);
  SIGKILL cannot be trapped — a run orphaned by SIGKILL is reconciled
  as `interrupted` on the next start/stop (pre-existing control-surface
  property).
- Precise finalization-failure contract: manifest corruption is NOT a
  finalization failure — manifest finalize is self-healing by design
  (it rebuilds the manifest from the raw evidence; stop stays green and
  the ledger records the resulting evidence gaps). A genuine
  finalization failure is a non-recoverable write failure (e.g. a
  non-writable run directory): then stop exits non-zero, the relay
  emits one bounded warning, all raw evidence is preserved exactly as
  found, and the mapping is kept so a later close (or a manual
  `agent-observability stop`) can re-finalize.
- The launch path ALWAYS exits with the child's exit status
  (128+signal when the child died by signal). Observability
  finalization never replaces it. Observability must not turn a
  successful coding-agent invocation into an unusable launcher.

### Fail-open policy

Observability is optional supporting infrastructure. If a prompt
turn's capture cannot start (missing control surface, missing or
broken collector, port conflict, script error, unusable contract,
timeout), the turn runs uncaptured: ONE bounded warning on stderr,
the ACP stream passes through intact, no retries, no auto-install,
nothing hidden. A live capture that the turn does not own is never
attached to or overwritten — the turn fails open with a warning
naming the active run. A fast start failure fails open fast (the
relay observes the sidecar's exit instead of polling to the
deadline).

### Concurrency

The capture architecture owns one loopback endpoint
(127.0.0.1:4318) and one capture directory per collector lifecycle,
so exactly **one automatically observed prompt turn is supported at a
time**. A concurrent turn (a second prompt before the first turn's
response finalized, or a prompt on any other session) fails open with
a bounded warning naming the active run; it is never attached,
overwritten, or merged into the first turn's capture, and no evidence
is attributed across turns. Documented limitation of the pre-existing
single-endpoint architecture: a concurrent or foreign turn's OTLP (if
any) may still land in the first run's raw capture; the Run Ledger
scoping (schema v3) makes that explicit instead of merging it: the
primary activity is scoped to the persisted captured conversation
identity, and the foreign conversations are reported via
`activity.foreign`. Multi-turn routing is out of scope until observed
normal usage requires parallel turns.

### Opt-out (one session)

`FG_AGENT_OBSERVABILITY=0` (also `off`/`false`/`no`/`disabled`, any
case) for one session: the launch path execs the original launcher
directly — no relay, no collector, no run, no ledger, no diagnostics.
The repository default after installation is enabled. This is a local
session bypass, not a global analytics/cloud toggle.

### One-time host integration: install / status / uninstall

- `scripts/agent-product-launch install` — one-time, idempotent:
  backs up the original launcher byte-identically (mode kept,
  cmp-verified) to `~/.local/share/lucid-codex-acp/lucid-codex-acp.impl`
  and atomically replaces `~/.local/bin/lucid-codex-acp` with a small
  trampoline that exports the explicit delegate path and execs the
  wrapper, and writes the user-level config
  `~/.local/share/lucid-codex-acp/agent-product-launch.json`
  (schema_version 1: repo root, entrypoint, delegate). All writes are
  atomic renames; a post-install consistency check verifies
  trampoline + delegate + config agree. Never touches auth, never
  embeds secrets, never hardcodes temporary paths. `status` and
  `uninstall` are the read-only report and the byte-exact rollback.
- `status` — read-only integration report. Exit 0 consistent, 7 not
  installed, 8 inconsistent.
- `uninstall` — restores the original launcher byte-identically
  (cmp-verified) and removes config + backup. Idempotent. This is the
  rollback path.
- Recursion is impossible: the wrapper fails closed (exit 125) when the
  delegate resolves to the wrapper itself or to a trampoline, and an
  internal environment guard (`FG_PRODUCT_OBS_IN_WRAPPER`) catches any
  nested invocation. If the trampoline ever runs while the wrapper is
  missing, it reports one bounded stderr warning and executes the
  original launcher with the original arguments (the product keeps
  working; capture is unavailable until the wrapper is restored).

### Privacy and protocol guarantees

- The relay persists **no ACP content**: only bounded identifiers
  (session id, run id, request id, ACP method name, stopReason) and
  bounded single-line diagnostics (the reported start reason is ≤160
  chars), on stderr and in the bounded git-ignored relay event log
  (below). No environment dumps; no prompt, content-block, or
  tool-result logging at any layer.
- The launch boundary drops any inherited `FG_AGENT_RUN_ID` and adds
  only the internal `FG_PRODUCT_OBS_IN_WRAPPER` recursion guard to the
  delegate environment. It reads and writes no Codex auth/config.
- All existing privacy invariants apply unchanged: loopback-only OTLP,
  `log_user_prompt = false`, sanitized raw telemetry, no prompt
  persistence, git-ignored runtime artifacts.

### Relay event log (bounded diagnostics; failure-boundary pinning)

The ACP server's stderr goes to the client host and may be dropped, so
the relay appends the same bounded single-line diagnostics to a
git-ignored log file:
`.artifacts/agent-observability/relay-events.log` (override:
`FG_PRODUCT_RELAY_LOG`). Lines are truncated to 1000 chars; the file
rotates to the most recent 128 KiB once it exceeds 256 KiB. Every
write is best-effort and never breaks or delays the ACP stream.

The events are exactly the bounded identifiers the lifecycle contract
allows — `relay-started`, `relay-exited`, `client-request` (method +
request id), `server-notification` (method name only; the
high-volume `session/update` stream is suppressed), `server-error`
(request id), `session-open` / `session-open-ignored` / `session-seen`
(session id, open method), `open-ignored` / `open-no-session-id` /
`open-response-incomplete` (method), `turn-start` / `turn-uncaptured`
/ `prompt-ignored` (session id, request id, bounded reason),
`start-result` / `start-error` (run id + bounded reason),
`mapping-written` / `mapping-write-failed`, `gate-released` (session
id, held byte count — the readiness gate released and the held prompt
bytes are forwarded to the Codex child now), `turn-response` /
`turn-response-pending` / `turn-response-unmatched` /
`turn-response-late` / `turn-response-norun` (session id, request id,
stopReason — never the result body), `turn-finalize` /
`turn-finalize-during-start` / `turn-finalize-ignored` (session id,
request id, run id, stop status), `close-pending` / `close-launched`
/ `close-ignored` / `close-unknown` / `session-closed`, `stop-result`
(session id, stop status, run id, mapping outcome), `frame-skipped`
(direction + `reason=line-oversized`; one per line beyond the
per-line observation bound — observation resumes on the next line,
the stream is never disabled), `observe-error` — and never prompts,
content blocks, tool arguments or results, auth material, environment
dumps, or ACP bodies.

Because the first line of every relay process lifetime is
`relay-started`, the log pins the exact failure boundary for
"fresh prompt, no run":

- **no `relay-started` line** — the client never reached the installed
  entrypoint (upstream of the relay: the trampoline or
  `agent-product-launch`, or the wrapper degraded to a direct exec);
- **`relay-started` present but no `client-request` for
  `session/prompt`** — the relay is in the chain but the client sent
  no prompt the relay recognizes (a single `frame-skipped` line is
  NOT this failure: it skips one oversized line only and observation
  resumes on the next line);
- **`turn-start` + `start-error`** — the start sidecar failed; the
  bounded reason says which (port conflict, missing collector,
  deadline, spawn failure);
- **`turn-start` + `start-result … status=already_running`** — another
  observed turn's run is live (one at a time);
- **`start-result … status=started` + `mapping-write-failed`** — the
  run started but the turn is uncaptured (fail open by design);
- **`turn-response … stop_reason=…` + `turn-finalize` + `stop-result
  … mapping=released`** — a healthy prompt-turn boundary (the run is
  finalized and the session stays open).

### Environment variables

| Variable | Meaning |
|---|---|
| `FG_AGENT_OBSERVABILITY` | Session opt-out (`0/off/false/no/disabled`) |
| `FG_AGENT_RUN_ID` | Manual/debug override only; the automatic path never sets it (inherited values are dropped) |
| `FG_OBS_CAPTURED_CONVERSATION_ID` | Internal (relay-set): the session's native Codex conversation id, passed by the ACP lifecycle relay when it starts a prompt-turn run so the manifest persists it as `captured_conversation_id`; manual starts and probes leave it unset (null) |
| `CODEX_SESSION_ID` | Native session id (set by Codex, read-only); the automatic active-turn correlation key |
| `FG_PRODUCT_LAUNCH_STATE_DIR` | Install state dir (test override) |
| `FG_PRODUCT_LAUNCH_ENTRYPOINT` | Launcher path to wrap (test override) |
| `FG_PRODUCT_LAUNCH_DELEGATE` | Original launcher path (set by the trampoline) |
| `FG_PRODUCT_SESSION_MAP_DIR` | Session/run mapping dir (test override; default `.artifacts/agent-observability/session-runs`) |
| `FG_OBS_RUNS_DIR` | Runs dir (test override) |
| `FG_OBS_NO_DOCTOR_SNAPSHOT` | Skip the read-only doctor snapshot in `start` |
| `FG_PRODUCT_RELAY_LOG` | Relay event log path (test override; default `.artifacts/agent-observability/relay-events.log`) |

## Normal product acceptance (zero manual lifecycle)

The defining acceptance: a **normal product-agent chat left open the
way users leave it** is captured end-to-end **without anyone running
`agent-observability start` or `stop`, without closing the session,
and without any manual observability command** — after the one-time
installation, the trampoline + relay own the per-turn lifecycle, and
every prompt in the still-open chat receives its own distinct run.

1. Register the product runtime from a normal product-agent session
   (where `CODEX_HOME` is set): `./scripts/agent-observability
   product-runtime register`. Idempotent; also happens automatically
   when the agent runs the `context` command. Writes the git-ignored
   `.artifacts/agent-observability/product-runtime.json`.
2. One-time host integration: `./scripts/agent-product-launch install`
   (idempotent; reversible via `uninstall`; `status` reports the
   state).
3. Verify the normal-product OTel config state (read-only):
   `./scripts/agent-observability status` — expect `product codex home:
   registered — <home>` and `product otel config: configured (local:
   true)` and a found collector. If `config` refuses with "product
   Codex home is not registered", register first (step 1). If the
   product otel config is `absent`, apply the exact block printed by
   `./scripts/agent-observability config` to the **registered
   product** `$CODEX_HOME/config.toml` **manually, explicitly** (the
   repository never edits it), then start a **new** agent session so
   Codex loads the configuration.
4. Start a normal coding-agent session **exactly as the user
   normally does** — no lifecycle command — and **leave it open**.
5. Send prompt A (a harmless, bounded repository task). Inside the
   session: `FG_AGENT_RUN_ID` is **absent** (the automatic path never
   exports it) and `CODEX_SESSION_ID` is present (the ACP session
   id). The active-turn mapping already names the turn's fresh
   `run-*`. The agent attaches its already-given task type and
   session once via the canonical resolver, which selects the active
   turn's own run from the mapping:
   `./scripts/agent-observability context current --task-type "<Task
   type>" --session "<Session>"`.
6. The agent performs normal repository/tool work and runs a
   verification profile with a summary — no manual export: `./scripts/
   agent-verify.sh --summary-json .artifacts/agent-runs/<run-id>/
   verify-quick.json quick`; the summary auto-correlates to the
   active turn's run via the same session/run mapping (no liveness
   discovery, no timestamp matching).
7. **Leave the chat open** and wait until the agent has finished
   replying (the prompt-turn response). The controller must already
   show run A finalized: `stop_status=graceful`, `end_ts` set,
   end-of-run Git evidence recorded, `<run-id>/run-ledger.json`
   generated, the mapping released, and the loopback port freed —
   **no manual stop command, no UI session close**.
8. **Without closing the chat**, send prompt B. Run B starts and
   finalizes independently: a different run id, and no evidence from
   prompt A is attributed to prompt B.
9. Inspect the ledger: conversation id, model, reasoning effort (when
   the native event provides it), sandbox mode/approval policy (same),
   tool events, task type + session mode, correlated verification +
   doctor evidence, start/end Git state — and confirm no prompt
   contents and no credentials anywhere in the run directory
   (sanitized raw + ledger + context).

Manual `start`/`stop` remain the fallback when the trampoline is not
installed; the collector is a long-lived local process that cannot be
sustained from inside an agent sandbox, so manual runs must be started
from the controller shell.

`native-probe` remains an acceptance/diagnostic overlay for the capture
pipeline itself; it is **not** a substitute for product-session
adoption proof.

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
  active in the **product** `CODEX_HOME` (check `status` →
  `product otel config`; it must say `configured (local: true)` for the
  **registered** product home — a `~/.codex` in the controller shell is not
  the product home; if `status` reports the product home as `not registered`,
  run `product-runtime register` from a product-agent session first), the
  collector is not running (`start` it; it does not survive reboots and is
  reaped when the spawning agent sandbox command ends — start it from the
  controller shell), the agent session was started before the config change
  (Codex reads `[otel]` at process start), or the port mismatched
  (`FG_OBS_PORT` must match the configured endpoints). `status` always
  separates these: collector availability vs running state vs product OTel
  configuration.
- **`context current` exits 10/11** — no live product capture, or more
  than one (candidates are named); start a capture or pass an explicit
  run id. Probes never count as product captures.
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

0. Remove the automatic product-session lifecycle:
   `./scripts/agent-product-launch uninstall` (restores the original
   launcher byte-identically). Or bypass capture for one session only:
   `FG_AGENT_OBSERVABILITY=0` (no collector, run, or ledger for that
   session).
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
