# FG Workspace — Design Documentation

Source-of-truth map for visual design documentation. For any
user-facing UI task, read this file first, then read **only** the
scoped contract that applies to the surface being changed.

## Authority model

| Layer | What it is | Where |
|---|---|---|
| Design contracts | Human-readable design intent and semantic roles (typography, density, scoped surface contracts) | `docs/design/` (this directory) |
| Token contract | Canonical technical color / theme / focus token contract — values, token vocabulary, compatibility & migration policy | `docs/design/tokens.md` |
| Scoped implementation contracts | May refine global rules for exactly one surface (IA, behavior, geometry); never contradict a settled global role | `workspace-sidebar/IMPLEMENTATION_CONTRACT.md` |
| Accepted visual references / screenshots | Visual evidence for the surface they scope; never a specification on their own | `workspace-sidebar/screen.png`, `code.html` |
| Production code | Implements the contracts; never silently redefines them | `apps/web/src` |
| Historical Stitch exports | References only, unless a scoped contract explicitly promotes them | `docs/stitch_examples/` |

Rules:

- Global semantic roles are defined once in a global design contract;
  scoped contracts refine, they never contradict.
- If code and a contract diverge, do not silently choose one — report
  the mismatch and resolve it deliberately (same discipline as
  `docs/README.md`, "Source-of-truth ownership").
- Accepted screenshots are evidence for their scoped surface only; they
  grant no authority over other surfaces.
- A new visual value for an existing semantic role requires updating
  the canonical contract first (routing rule: `apps/web/AGENTS.md`,
  "Design contracts").
- `tokens.md` stays the implementation authority for color, theme, and
  focus; design contracts carry intent, roles, and metrics — they do
  not duplicate token values.

## Contracts

| Document | Scope & status |
|---|---|
| `tokens.md` | Color / theme / focus tokens (Light + Dark), keyboard focus contract, compatibility / migration policy. Canonical technical contract. |
| `workspace-typography-density.md` | Global semantic typography roles (**settled**) + Projects/Meetings density metrics (**provisional** until browser validation and explicit acceptance). |
| `workspace-sidebar/IMPLEMENTATION_CONTRACT.md` | Sidebar information architecture & behavior (**frozen**, QA-1…QA-18) + frozen geometry (§3.4). Its reference set: `screen.png` (visual source of truth), `code.html` (measurement assistance only), `DESIGN.md` (advisory metadata only — never a token or requirement source; precedence fixed in its §3.2). |

## Conventions

- Design contracts are documentation deliverables: they change through
  explicit decisions and leave their rationale in place (exceptions
  register, status notes).
- A contract that becomes **frozen** says so in its title/status;
  frozen contracts change only via a new, explicitly approved decision.
- Provisional values are always labeled as such, together with the
  condition that upgrades them to invariants.
