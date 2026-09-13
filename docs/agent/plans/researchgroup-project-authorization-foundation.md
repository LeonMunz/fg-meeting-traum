# Execution Plan — ResearchGroup / Project Membership & Authorization Foundation

**Task type:** Domain (long-running)
**Opened:** 2026-09-13
**Status:** COMPLETE (M0–M6; 2026-09-13)
**Outcome:** The backend enforces the canonical ResearchGroup/Project
membership, ownership, scope, and authorization invariants through one
server-side authorization foundation, with database-backed integrity and
regression tests proving access is revoked correctly.

Canonical spec: `docs/domain/authorization.md` (created for this task).
Settled invariants: see `docs/domain/authorization.md` §1–§7 and the task
invariant list (1–20).

## Current-state inventory (M0, verified 2026-09-13)

### User / Auth
- `accounts.User(AbstractUser)` — no extra fields. Session auth
  (LoginView/LogoutView/MeView + CSRF wrapper). No invitation/passkey/SSO.
- "Suspension" exists only as `User.is_active` (Django
  `ModelBackend` + DRF `SessionAuthentication` already reject inactive
  users at authentication). No lifecycle UI.

### ResearchGroup
- `ResearchGroup` (`created_by` RESTRICT), `ResearchGroupMembership`
  (roles `admin`/`member`), `UNIQUE(research_group, user)` (present both
  via `unique_together` and a `UniqueConstraint` — duplicate, pre-existing,
  harmless).
- Group creation: **no API endpoint** — groups exist only via seed
  commands. **Gap vs invariant 8.**
- Management: member list, candidates, add/role-change/remove,
  offboarding preview + execution (resolves Project ownership/assignments
  atomically before removing the group membership).

### Project
- `Project.research_group` NOT NULL FK RESTRICT (exactly one group ✓).
- `ProjectMembership` roles `owner`/`member`/`viewer`,
  `UNIQUE(project, user)` ✓, `user`/`added_by` RESTRICT.
- **Gap vs invariant 3:** "membership user belongs to project's group"
  was enforced in application logic only (the model docstring claims
  PostgreSQL cannot express it — incorrect; composite FKs to unique
  indexes are supported).

### Roles / authorization (before this task)
- No capability abstraction. Scattered role checks:
  - `research_groups/views.py` `_require_group_membership` + inline
    `role == ADMIN` gates.
  - `projects/views.py` `_require_project_access` + per-view
    `role != OWNER` gates; `projects/services.py` actor-owner checks.
  - `work_items/views.py` second `_require_project_access`;
    `work_items/services.py` `_require_project_write_access`.
  - `meetings/services.py` `_require_scoped_read/write_access`,
    `_has_canonical_meeting_read_access`, `PROJECT_READ/WRITE_ROLES` sets;
    `meetings/views.py` `_has_scoped_read/write_access`,
    `_has_project_write_access`.
- Final-owner invariants (Project + group admin) already implemented with
  `select_for_update` row locks and re-validation under the lock.
- List endpoints already permission-filtered; inaccessible detail reads
  return non-leaking 404.

### Work Item / Meeting scope
- `WorkItem.project` NOT NULL; definitions project-scoped
  (`3a.4` same-project invariant enforced in services).
- Meetings: scope `group`/`project` with DB check constraint
  (project required iff scope=project); `Meeting.created_by` +
  `MeetingParticipant` define read access (creator-or-participant).

### Membership mutation paths
- Project: `create_project` (atomic owner), `add_project_membership`,
  `change_membership_role`, `remove_membership` (locked, final-owner +
  assignment guards), archive/restore/update/delete (owner-only).
- Group: `create_research_group` **missing** (gap), add/role-change/remove
  (locked, final-admin guard; plain remove refuses when Project
  memberships remain), `offboard_research_group_member` (atomic
  per-project resolution: ownership transfer-or-archive, assignment
  transfer-or-unassign, then group membership removal).

### DB constraints relevant to this task
- Verified on real dev database `fg_workspace` (PostgreSQL 17.11,
  reachable at localhost:5432): 2 users, 1 group, 2 projects,
  4 ProjectMemberships; **zero** cross-group violations; every active
  project has ≥1 owner. Backfilling a composite FK is safe.

### Tests (baseline)
- `uv run python manage.py test` (full backend suite): **980 tests, OK**
  (2026-09-13, PostgreSQL 17 test DB).
- Notable existing coverage: `research_groups/tests_offboarding*.py`,
  `projects/tests_lifecycle*.py`, `projects/tests_assignment_resolution*.py`,
  `meetings/tests_scope.py`, `work_items/tests_invariants.py`,
  `work_items/tests_my_work.py`.

## Exact delta from canonical invariants (M0 conclusion)

| Invariant | State |
|---|---|
| 1 User global identity | ✓ (Django auth) |
| 2 Project → exactly one group | ✓ (NOT NULL FK) |
| 3 ProjectMembership ⇒ group membership | ✗ app-level only → **M1 composite FK** |
| 4 Group has 1..n Owners | ✓ (final-admin guard) |
| 5 Active Project has 1..n Owners | ✓ (final-owner guard) |
| 6 Last owner cannot be removed/downgraded | ✓ services; needs kernel migration + concurrency proof |
| 7 Concurrency-safe ownership mutations | ✓ `select_for_update`; needs explicit concurrency test |
| 8 Active account can create group, becomes first Owner | ✗ **M3: create_research_group + endpoint** |
| 9 Group member can create Project, becomes first Owner | ✓ `create_project` |
| 10 ProjectMembership removal revokes access | ✓ (membership is the access truth) |
| 11 Group membership removal revokes group + child Project access | ✓ via offboarding (plain remove guards); DB backstop added in M1 (RESTRICT composite FK) |
| 12 Rejoin does not restore ProjectMemberships | ✓ (hard-delete semantics) |
| 13 Explicit Group/Project scopes | ✓ persisted; kernel makes scope checks canonical (M2/M4) |
| 14 Work Items + Meetings on same foundation | ✗ scattered helpers → **M2/M4** |
| 16–18 Server-side, DENY, UI not security | ✓ principle; M2 kernel makes it structural |
| 19 Group Owner ≠ private Project access | ✓ (dual membership required everywhere) |
| 20 Central role→capability mapping | ✗ scattered `role ==` checks → **M2** |

## Milestone checklist

- [x] **M0** — inventory, canonical doc, execution plan, baseline green
      (980 tests OK).
- [x] **M1** — Persisted membership & scope integrity
  - [x] `ProjectMembership.research_group` FK + composite FKs
        `(project_id, research_group_id) → projects_project(id, research_group_id)`
        and `(research_group_id, user_id) → research_groups_membership(research_group_id, user_id)` (ON DELETE RESTRICT).
  - [x] Unique target `(id, research_group)` on `projects_project`.
  - [x] Data backfill + constraint migration (non-destructive).
  - [x] ORM normalization (`save()` derives `research_group` from project).
  - [x] Model tests (constraint violation raises) + migrate real dev DB forward.
- [x] **M2** — Authorization kernel (`apps/api/authorization/`)
  - [x] `Capability` enum + central role→capability maps.
  - [x] `ScopeContext` / `AuthContext` (trusted identity, active check, default DENY).
  - [x] One canonical service: scope resolution + `require_capability`.
  - [x] Unit tests: capability matrix + DENY behavior.
- [x] **M3** — Creation, ownership, removal invariants
  - [x] `create_research_group` (atomic first owner) + `POST /api/research-groups/`.
  - [x] Route all ownership mutation paths through kernel capability checks.
  - [x] Last-owner tests (group + project) + real concurrency tests
        (two simultaneous owner mutations ⇒ never zero owners).
- [x] **M4** — Migrate protected backend access through the kernel
  - [x] research_groups / projects / work_items / meetings views+services.
  - [x] Proof tests: non-member DENY, group member w/o ProjectMembership
        cannot read private Project, removed members DENY with known IDs.
  - [x] Residual closure (2026-09-13): 5 group-admin gates in
        `research_groups/views.py` and 1 project-write gate in
        `meetings/views.py` (WorkItem-from-MeetingItem) migrated from
        raw role checks to `GROUP_MANAGE` / `PROJECT_WORK` capability
        checks via the kernel. No raw role authorization checks remain
        in view code (verified by grep sweep).
- [x] **M5** — Security regression matrix
        (`authorization/tests_security_matrix.py`, 25 behavioral tests)
  - [x] ALLOW/DENY matrix: no-GroupMembership DENY; no-ProjectMembership
        DENY; group Owner w/o ProjectMembership DENY (invariant 19);
        viewer allowed reads / denied writes; member work / denied manage;
        owner manage ALLOW.
  - [x] Removed Project member + known Project/WorkItem IDs → 404.
  - [x] Removed Group member + known child Project/WorkItem/Meeting IDs → 404
        (Meeting exception pinned: explicit participant keeps creator/
        participant READ per settled rule, scoped WRITE revoked → 403).
  - [x] Final Owner self-remove / downgrade → 400 (group + Project);
        two Owners, one leaves → ALLOW (200).
  - [x] Cross-group ProjectMembership attempt → 400 at API + IntegrityError
        at database (composite FK).
  - [x] Group removal (offboarding) clears child ProjectMemberships;
        rejoin does not restore them.
  - [x] Inactive (suspended) user → DENY at API and kernel.
  - [x] `manage.py test authorization` → **50/50 OK** (25 kernel + 25 matrix).
- [x] **M6** — Stabilization
  - [x] Targeted + full backend suite, migration checks, `git diff --check`.
  - [x] Residual role-check sweep: no view-layer role authorization
        checks remain; remaining `Role.X` references are ownership/
        domain rules allowed by the canonical spec.
  - [x] Read-only security-review subagent over final diff → "safe to
        merge"; 1 LOW finding fixed (comment), 1 MEDIUM operational
        note recorded, 2 INFO noted.
  - [x] Updated `docs/CURRENT_STATE.md` (Authorization / multi-user
        section) + this plan with final evidence.

## Decisions made

- **D1** — The group role `admin` **is** the product "group Owner".
  Persisted role values (`admin`, `owner`) are not renamed: renaming is a
  destructive data change and AGENTS.md forbids renaming persistence for
  presentation terminology.
- **D2** — Invariant 3 enforced with composite foreign keys (PostgreSQL
  supports FKs to unique indexes). `ProjectMembership` gains a
  `research_group` column; `save()` derives it from
  `project.research_group` (single source of truth stays on Project).
  Composite FK to group membership uses ON DELETE RESTRICT so group
  membership removal always requires explicit Project-membership cleanup
  (the offboarding service already deletes project memberships first, in
  one transaction).
- **D3** — New backend app `authorization` (no models) hosts the kernel:
  `capabilities.py` (enum + role maps), `context.py`
  (AuthContext/ScopeContext), `service.py` (canonical checks). Domain
  apps import it; it imports only `research_groups`/`projects` models.
- **D4** — Capability matrix as documented in
  `docs/domain/authorization.md` §5 (GROUP_READ / GROUP_CREATE_PROJECT /
  GROUP_MANAGE; PROJECT_READ / PROJECT_WORK / PROJECT_MANAGE;
  MEETING_READ / MEETING_WRITE; MEETING_SERIES_READ / MEETING_SERIES_WRITE).
- **D5** — Meeting read access stays creator-or-participant (settled,
  tested product rule); it is expressed as `MEETING_READ` in the kernel so
  meetings use the same foundation. Write = read + scope capability
  (group: GROUP_READ; project: PROJECT_WORK + not archived).
- **D6** — Group creation is implemented as a domain service
  (`create_research_group`: group + creator ADMIN membership atomic) plus
  `POST /api/research-groups/`. No frontend wiring in this task
  (membership UI is out of scope).
- **D7** — Inactive accounts (`is_active=False`) get no capabilities in
  the kernel (defense in depth; authentication already rejects them).
  Documented as the current "suspension" story; full account lifecycle is
  later authentication work.
- **D8** — `MEETING_WRITE` is the scoped write rule and is **independent**
  of the creator/participant `MEETING_READ` rule (per
  `docs/domain/authorization.md` §5). A user can therefore hold
  `MEETING_WRITE` without `MEETING_READ` in the kernel scope object.
  This is safe because every Meeting mutation view gates on read access
  first (404) and then on the write capability (403); the service layer
  re-checks the write rule under its own lock. A stale M2 kernel test
  that encoded the older "write implies read" expectation was updated to
  pin the settled rule (STALE TEST classification, spec §5 is the
  evidence).

## Discovered risks

- **R1 (low)** — Composite FK adds a denormalized `research_group` column
  on ProjectMembership; mitigated by the composite FK to
  `projects_project(id, research_group_id)` making divergence impossible,
  plus `save()` derivation.
- **R2 (medium)** — M4 is a wide mechanical refactor of ~6 view files and
  3 service files; regression risk in meeting flows (largest test mass).
  Mitigation: behavior-preserving changes, full suite after each milestone,
  keep existing error messages/status codes.
- **R3 (low)** — `remove_research_group_membership` re-enters a nested
  transaction from offboarding; keep idempotent behavior unchanged.
- **R4 (low)** — Environment: colima cannot start in this sandbox; the
  dev PostgreSQL 17 at localhost:5432 is reachable and used for all DB
  verification instead. If it disappears mid-task, classify as
  ENVIRONMENT/HARNESS and continue with non-DB verification.
- **R5 (fixed 2026-09-13)** — Both `tests_concurrency.py` files had a
  harness bug: `worker_downgrade`'s `finally: _db.close()` referenced a
  `_db` import that only existed inside `worker_remove` (NameError in the
  thread → worker DB session never closed → `DROP DATABASE` at test
  teardown failed with "database is being accessed by other users" in
  combined runs). Fixed by importing `django.db.connection` at module
  level in both files. This was the cause of the recurring teardown
  ObjectInUse errors; teardown is clean after the fix.
- **R6 (low)** — The combined multi-app test run previously failed at
  teardown (not at test execution) due to R5; after the fix the full
  suite is expected to tear down cleanly. If a stray
  `test_fg_workspace` remains, drop it with a single psql `-c`
  `DROP DATABASE IF EXISTS` (cannot run inside a transaction).

## Verification evidence

- 2026-09-13 M0: `git status --short` clean; full backend suite
  `uv run python manage.py test` → **Ran 980 tests … OK**.
- 2026-09-13 M0: real DB checks — 0 cross-group membership violations;
  migration state matches code (`makemigrations --check` clean).
- 2026-09-13 M1: `projects/0005_projectmembership_research_group`
  applied to the real dev database `fg_workspace` (PostgreSQL 17.11) —
  non-destructive, data verified consistent before/after.
  `makemigrations --check --dry-run` → "No changes detected";
  `manage.py check` → 0 issues.
- 2026-09-13 M1: `projects.tests_membership_integrity` → **7/7 OK**
  (composite-FK violations raise IntegrityError; rejoin does not
  restore ProjectMemberships; project delete cascades memberships).
- 2026-09-13 M1: full backend suite → **Ran 987 tests … OK**.
  24 pre-existing tests that fabricated the now-forbidden "stale
  membership" state (group membership deleted while ProjectMembership
  survived) were updated to the canonical revocation sequence
  (ProjectMembership removed first, then group membership); assertions
  (DENY with known IDs) unchanged. Files: `projects/tests.py`,
  `work_items/tests_invariants.py`, `work_items/tests_my_work.py`,
  `work_items/tests_personal_my_work.py`, `meetings/tests_note_work_item.py`.
- 2026-09-13 M2: new app `authorization` (capabilities, context,
  service). `manage.py test authorization` → **25/25 OK**
  (capability matrix, default DENY, dual-membership rule,
  creator/participant meeting read, archived-project write DENY).
- 2026-09-13 M3: `create_research_group` service + `POST /api/research-groups/`
  (creator becomes first Owner atomically; blank name / inactive account
  rejected). `research_groups.tests_creation` → **6/6 OK**.
- 2026-09-13 M3: real concurrency tests (threads + Barrier + row locks,
  `TransactionTestCase`): simultaneous final-owner removal vs downgrade
  (Project) and final-admin removal vs downgrade (Group) → at least one
  owner remains, exactly one conflicting mutation succeeds.
  `projects.tests_concurrency` + `research_groups.tests_concurrency` →
  **2/2 OK**. (Pre-existing explicit last-owner tests remain in
  `projects/tests.py` and `research_groups/tests_management.py`.)
- 2026-09-13 M4: all protected Group/Project/WorkItem/Meeting server
  operations now resolve scope + capability through
  `authorization.service`; view/service role-string checks removed
  (PROJECT_MANAGE / PROJECT_WORK / GROUP_MANAGE / GROUP_READ /
  MEETING_READ / MEETING_WRITE / MEETING_SERIES_* capability gates).
  Targeted suites after migration:
  - `projects` + `research_groups` + `authorization` → **OK**
  - `work_items` → **OK** (681 with meetings)
  - `meetings` + `work_items` → **Ran 681 tests … OK**
  One stale expectation updated: `work_items/tests.py::test_viewer_rejected`
  asserted a legacy per-case message; now asserts the canonical
  "cannot be assigned" message (DENY behavior unchanged).
- 2026-09-13 M4 residual closure: 5 group-admin gates in
  `research_groups/views.py` (detail PATCH, member-candidates,
  memberships list/detail, offboarding) and 1 project-write gate in
  `meetings/views.py` (WorkItem-from-MeetingItem) migrated to kernel
  capability checks (`GROUP_MANAGE` / `PROJECT_WORK`). Status codes and
  error messages unchanged.
- 2026-09-13 M4/M6 sweep: per-app suites re-run after the view
  migration — `projects` → **Ran 202 tests … OK**; `meetings` →
  **Ran 413 tests … OK**; `work_items` + `research_groups` +
  `authorization` → **Ran 401 tests … OK**. All teardowns clean.
- 2026-09-13 M5: `authorization/tests_security_matrix.py` (25
  behavioral API-level ALLOW/DENY tests) — all pass on first run.
  `manage.py test authorization` → **Ran 50 tests … OK**.
- 2026-09-13 M6: Stale M2 kernel test
  `authorization.tests.MeetingScopeTest.test_non_participant_denied_even_for_group_member`
  replaced by `test_non_participant_group_member_has_write_not_read`
  (STALE TEST: encoded pre-D8 "write implies read"; settled spec §5 says
  the rules are independent, and every mutation view gates read-first).
  Harness fix (R5) landed in both `tests_concurrency.py` files.
- 2026-09-13 M6: full backend suite `uv run python manage.py test`
  → **Ran 1045 tests … OK** (987 baseline + 2 concurrency + 6 creation
  + 25 kernel + 25 security matrix; math reconciles exactly). Teardown
  clean (R5 fix confirmed). `manage.py check` → 0 issues;
  `makemigrations --check --dry-run` → "No changes detected";
  `git diff --check` → clean; `./scripts/agent-verify.sh backend` →
  all checks passed.
- 2026-09-13 M6: residual role-check sweep (grep, non-test code):
  view-layer role authorization checks — none remain. Remaining
  `Role.X` references are all acceptable per the canonical spec:
  ownership invariants (final-owner/admin counts, creator-becomes-Owner,
  ownership-candidate eligibility, viewer-assignment guard, role
  transition rules) and data defaults. Pre-existing, untouched
  query-level assignment-eligibility filters in
  `work_items/views.py` (My Work projections, `role__in=[OWNER, MEMBER]`)
  documented as a later capability-semantic cleanup candidate.
- 2026-09-13 M6: read-only security review (independent subagent over
  the full diff + new files) — verdict: **safe to merge**. No access
  widening (project reads are strictly tighter than the old code: they
  now also require current ResearchGroupMembership + active account),
  no client-trusted authorization input (identity exclusively
  `request.user`; client `createdById`/`researchGroupId` rejected), no
  cross-group collection leaks, all owner-set mutations under parent
  row lock + atomic revalidation, non-leaking 404s verified.
  Findings triaged:
  - LOW — `get_accessible_project_qs` docstring/code nuance (group
    condition enforced by the composite FK, not the query): fixed with
    an explanatory comment pinning the DB-constraint dependency.
  - MEDIUM (operational, not code) — on an existing production
    database, audit for orphaned `ProjectMembership` rows before
    applying `projects/0005`; the composite FK `ADD CONSTRAINT` fails
    cleanly (transactional, no corruption) while any exist. The local
    dev database was verified to have zero such rows before migration.
  - INFO — O(n) backfill loop (fine at current scale); pre-existing
    404-vs-403 nuance in `MeetingItemWorkItemCreateView` (reveals only
    the caller's own membership state inside their own group).

## Remaining work

None. M0–M6 complete. Final confirmation run (post all edits):
`uv run python manage.py test` → **Ran 1045 tests … OK**, exit 0,
teardown clean. No open blockers. Deliberately deferred (documented in
`docs/domain/authorization.md` §7): authentication provider work,
invitations, passkeys, SSO, Membership-management UI, Calendar,
Knowledge/Wiki, Roadmap, KVP, service accounts, PostgreSQL RLS.
Operational note for deployment: see MEDIUM finding above (orphaned
ProjectMembership audit before applying `projects/0005`).
