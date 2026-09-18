# Agent Runtime Contract

## Purpose and scope

This document is the canonical runtime contract for agent work in this
repository. It fixes which agent harness is canonical, separates the runtime
layers from each other, records only evidenced runtime values, and defines
the mandatory per-run metadata for later evaluations.

It applies to agent sessions and evaluation runs performed against this
repository. It is not:

- a historical audit report (audit evidence stays in the audit records),
- a machine-readable eval schema or runner (only the field contract is
  defined here),
- a product, CI, or toolchain document (those live in `README.md`, the CI
  workflows, and `docs/living-lab.md`),
- an inventory of any local machine, user directory, or locally installed
  alternative agent tooling.

## Runtime layers

The agent runtime is described on four separate layers. A value observed on
one layer never implies a value on another layer.

### Harness

The canonical agent harness for this repository is **Codex**.

This contract states the harness identity only. It does not state that a
local `codex` CLI is used, that the harness must be installed locally, or
that a specific harness version is active. The harness version is
`externally controlled / not currently captured`.

Locally installed alternative agent CLIs and their user-specific
configurations are outside the canonical Codex runtime contract.

### Model

The model is a runtime decision separate from the harness. A model is served
to the harness by a serving layer; the harness does not imply the model, and
the model does not imply the harness.

Observed, available model option (not an active model):

- `Qwen/Qwen3.8-27B-FP8` — observed in a platform model catalog as an
  available option for this harness. This entry:
  - is documented only as an available or possible model option, never as
    the proven active model;
  - carries `FP8` as part of the observed model label; the label is not
    proof of an exact checkpoint or build revision;
  - is associated with a platform serving label (LUCID / vLLM) that belongs
    to this catalog entry only.

The actually active model identifier must be captured per eval run (see
Required metadata per eval run). If the provider does not expose a
revision, the revision stays explicitly `UNKNOWN`.

### Serving layer

The serving layer hosts the model for the harness. Only the catalog-entry
serving label described under Model has been observed so far; no serving
property of the active runtime is evidenced. A concrete engine version,
deployment configuration, API endpoint, chat template, tool-calling wire
format, batching setting, server timeout, or retry setting must not be
documented as a fact until it is evidenced.

### Session and tool policy

Session-bound platform details are per-run variables, not durable repository
facts. Where known, they must be captured per eval run:

- `reasoning_effort`
- tool set
- read and write permissions
- network access
- approval model
- subagent availability
- context and output limits, if known
- timeout and retry rules, if known

## Current runtime contract

Every runtime value carries exactly one of these statuses:

- `PINNED` — versioned in this repository with a concrete value.
- `OBSERVED` — observed in a concrete session, not fixed in the repository.
- `EXTERNAL` — set outside the repository or controlled by the platform;
  not fixed in the repository.
- `UNKNOWN` — not reliably known at present.
- `NOT_APPLICABLE` — not relevant for the runtime in question.

The observed Qwen catalog entry above has status `OBSERVED`. The current
contract for the canonical runtime:

| Layer | Field | Status | Current evidenced value | Effective source | Capture rule |
|---|---|---|---|---|---|
| Harness | Harness identity | `PINNED` | `Codex` | This document (product decision) | n/a — fixed in repository |
| Harness | Harness version | `EXTERNAL` | externally controlled / not currently captured | platform / session | log per eval run if available |
| Harness | Local CLI installation | `NOT_APPLICABLE` | no local CLI requirement | — | n/a |
| Model | Model name (active) | `EXTERNAL` | runtime decision per run; none fixed in the repository | session / provider | mandatory per eval run |
| Model | Model revision | `UNKNOWN` | not observed | — | per eval run; `UNKNOWN` if the provider does not expose it |
| Model | Checkpoint | `UNKNOWN` | not observed | — | per eval run |
| Model | Quantization | `UNKNOWN` | not evidenced for the active model | — | per eval run |
| Serving | Serving engine (active runtime) | `UNKNOWN` | not evidenced; the observed LUCID / vLLM label belongs to the Qwen catalog entry only | — | per eval run |
| Serving | Serving engine version | `UNKNOWN` | not observed | — | per eval run if available |
| Session | `reasoning_effort` | `EXTERNAL` | set per run; not currently captured | platform / session | mandatory per eval run |
| Session | Thinking / `preserve_thinking` | `UNKNOWN` | no such option evidenced | — | per eval run if present |
| Session | Temperature | `UNKNOWN` | not evidenced; no provider default assumed | — | per eval run if explicitly set |
| Session | `top_p` | `UNKNOWN` | not evidenced; no provider default assumed | — | per eval run if explicitly set |
| Session | Seed | `UNKNOWN` | not evidenced | — | per eval run if explicitly set |
| Session | Context window | `UNKNOWN` | not evidenced for the active model | — | per eval run if known |
| Session | Maximum output length | `UNKNOWN` | not evidenced for the active model | — | per eval run if known |
| Session | Tool set | `EXTERNAL` | varies per run / session | platform / session | mandatory per eval run |
| Session | Sandbox / permission profile | `EXTERNAL` | set per run / session | platform / session | mandatory per eval run |
| Session | Network access | `EXTERNAL` | set per run / session | platform / session | mandatory per eval run |
| Session | Timeout / retry rules | `EXTERNAL` | set per run / session, where known | platform / session | per eval run, where known |

## Unknown and externally controlled values

- No exact active model revision, checkpoint, or quantization has been
  observed; these stay `UNKNOWN` until evidenced.
- No serving version, deployment configuration, endpoint, chat template,
  tool-calling format, batching, timeout, or retry value is documented,
  because none is evidenced.
- No sampling parameter is documented as a default. A value that is not set
  is not a known value.
- Session-bound platform details (tools, permissions, budgets) are captured
  per run; they are never restated in this document as durable facts.

## Required metadata per eval run

Every later A/B evaluation run must record, as a minimum:

1. Timestamp
2. Repository commit
3. Task or eval ID
4. Harness
5. Harness version, if available
6. Model ID
7. Model revision, or explicitly `UNKNOWN`
8. Serving engine and version, if available
9. `reasoning_effort`
10. Sampling parameters, if explicitly set
11. Context and output limits, if known
12. Tool set
13. Sandbox / permission profile
14. Network status
15. Time and retry budget
16. Result status
17. Runtime duration
18. Tool call count
19. Unnecessary test runs
20. False verification claims
21. Human corrections
22. Diff size

This is the binding field contract only. No machine-readable eval schema,
file, or runner is introduced by this document.

## Security and secret boundaries

Never store in this repository:

- API keys or tokens
- authentication headers
- cookies
- credential files
- full internal endpoints
- local home paths
- full environment dumps
- approval prefix lists with local paths
- provider responses containing sensitive metadata

Allowed: abstracted, non-secret runtime values and explicit `UNKNOWN`
markers.

## Update rules

- A runtime value moves from `UNKNOWN` or `EXTERNAL` to `OBSERVED` or
  `PINNED` only with concrete evidence.
- A model alias is not a model revision.
- UI labels and catalog entries do not prove which model was actually
  active.
- Per-run values belong in the eval run dataset, not in this document as
  apparently durable defaults.
- Changes to the runtime contract and changes to eval results are separate
  slices.

## Existing repository contracts

- Canonical agent execution flow, evidence contract, verification statuses,
  and completion format → `docs/agent/WORKFLOW.md`
- Agent command surface, environment doctor, verification profiles, E2E
  consent contract → `README.md`
- Environment doctor and its status values → `docs/living-lab.md`
- Current implementation checkpoint → `docs/CURRENT_STATE.md`
- Documentation map → `docs/README.md`

This document duplicates none of these contracts; it only references them.
