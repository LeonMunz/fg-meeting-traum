# Execution Plan — Browser Authentication & Revocable Session Security Foundation

**Task type:** Domain (long-running)
**Opened:** 2026-09-13
**Status:** COMPLETE (M0–M6; 2026-09-13)
**Starting commit:** `aa1253edbc17e5d80fd06253cba10d797fccad78` (feat(authz): establish membership authorization foundation; == origin/main, clean tree)
**Outcome:** Django-backed browser authentication with server-side revocable sessions,
CSRF-protected cookie flows, individually manageable sessions, and trusted session
identity feeding the existing AuthContext — no Membership/AuthZ redesign, no login UI
change.

Canonical domain doc: `docs/domain/authentication-sessions.md` (created for this task).

## M0 — Current-state inventory (verified 2026-09-13)

### Authentication
- User model: `accounts.User(AbstractUser)` (no extra fields);
  `AUTH_USER_MODEL = 'accounts.User'`. No `AUTHENTICATION_BACKENDS` override →
  default `django.contrib.auth.backends.ModelBackend` (rejects inactive users at
  `authenticate()` via `user_can_authenticate`).
- Endpoints (all in `config/urls.py`):
  - `GET /api/auth/csrf/` — `CSRFEndpoint` (AllowAny; `csrf_get_token` sets cookie).
  - `POST /api/auth/login/` — `LoginView`, wrapped by `csrf_protect_view`
    (removes DRF's `csrf_exempt`, wraps `csrf_protect`).
  - `POST /api/auth/logout/` — `LogoutView`, same wrapper.
  - `GET /api/auth/me/` — `MeView` (IsAuthenticated; returns
    id/username/firstName/lastName/email).
- `LoginView`: `authenticate(username, password)` → 401 on failure;
  `django.contrib.auth.login(request, user)` (creates session + `cycle_key()`
  rotation built in).
- `LogoutView`: `django.contrib.auth.logout(request)` (destroys the Django
  session server-side).
- DRF: `FGSessionAuthentication(SessionAuthentication)` (adds
  `authenticate_header` so 401 is preserved); single default authenticator;
  `DEFAULT_PERMISSION_CLASSES = [IsAuthenticated]`. DRF
  `SessionAuthentication.authenticate()` returns None for inactive users (FACT,
  probed 2026-09-13) → all DRF endpoints already answer 401 for inactive
  accounts; CSRF is enforced by DRF for authenticated unsafe requests.
- Session engine: default DB backend (`django.contrib.sessions.backends.db`,
  table `django_session`: pk=session_key(40), session_data, expire_date
  [db_index]). No `SESSION_*` overrides → defaults:
  HttpOnly=True, Secure=False, SameSite=None, age 1209600 (2 weeks).
- CSRF: `CsrfViewMiddleware` active; `CSRF_TRUSTED_ORIGINS` =
  localhost:5173 + 127.0.0.1:5173 (dev); `settings_e2e.py` isolates
  127.0.0.1:4173. No `csrf_exempt` bypasses beyond DRF's standard `as_view()`.
- No production settings module; `DEBUG=True` and insecure `SECRET_KEY`
  hardcoded in `config/settings.py` (pre-existing; production hardening beyond
  the cookie/CSRF contract is out of scope for this task).

### Session behavior (before this task)
- Login rotates the session id (Django `login()` → `cycle_key()`). ✓
- Logout destroys the session server-side. ✓
- No user→sessions index; sessions cannot be listed or individually revoked.
  → a session registry is required (M1).
- No session registry model, no last-login tracking, no account-security UI.

### Frontend
- `apps/web/src/api/client.ts`: fetch with `credentials: 'same-origin'`;
  unsafe requests send `X-CSRFToken` read from the `csrftoken` cookie (fetched
  via `GET /api/auth/csrf/` when missing). `CSRF_COOKIE_HTTPONLY` must stay
  False for this SPA mechanism.
- `apps/web/src/api/auth.ts` + `SessionProvider.tsx`: session recovery via
  `GET /api/auth/me/` on mount; no auth secrets in localStorage/sessionStorage
  (localStorage is used only for appearance theme — unrelated, untouched).
- No global 401 interceptor; SessionProvider treats any /me/ failure as
  logged-out state.

### Security
- Existing auth tests: `accounts/tests.py` (health, CSRF endpoint,
  login/logout with/without CSRF incl. `Client(enforce_csrf_checks=True)`,
  /me/ behavior, impersonation prevention, protected default).
- E2E: `e2e/auth-and-projects.spec.ts` (Playwright; `/login` form, username +
  password `DevPass1!`, "Sign in" button, "Sign out" visibility as success
  signal). Playwright Chromium is known-broken in this sandbox (icudtl.dat);
  browser gate stays with the user.
- Inactive accounts: rejected at login (ModelBackend) and 401 at the API layer
  (DRF SessionAuthentication) — probed, matches the security matrix tests.

### Authorization integration
- `authorization/service.py`: `get_auth_context(request.user)` → `AuthContext`;
  inactive accounts resolve to no capabilities in every scope (pinned by
  `authorization/tests_security_matrix.py::AccountStateMatrixTest` and
  `authorization/tests.py`). Nothing in the authorization kernel trusts the
  request payload. No changes required; M5 verifies.

### Baseline (recorded 2026-09-13, before any change)
- `uv run python manage.py check` → 0 issues.
- `uv run python manage.py makemigrations --check --dry-run` → no changes.
- `uv run python manage.py test` (full backend, PostgreSQL 17 on
  localhost:5432) → **Ran 1045 tests — OK**.
- Frontend: untouched by this task (login/logout contract preserved), so no
  web-unit changes are expected; final gate re-runs repo verification anyway.

## Architectural delta

1. **Session registry** (new, in `accounts`): model `UserSession`
   (`public_id` UUID [API identifier, non-secret], `user` FK, `session_key`
   unique [the Django session pk, server-side only], `created_at`). Registry is
   metadata only — never grants authentication; the Django session row remains
   the credential.
2. **Registry maintenance**:
   - login view registers the rotated session key explicitly;
   - `SessionRegistryMiddleware` (after AuthenticationMiddleware) lazily
     registers any authenticated session (covers admin-panel logins and
     pre-migration legacy sessions) — one indexed lookup per authenticated
     request;
   - revocation/logout delete the Django session row AND the registry row in
     one transaction;
   - expired Django sessions are never listed: the list service cross-checks
     liveness (indexed `django_session` PK + `expire_date`) and prunes dead
     rows for the requesting user.
3. **Session-management API** (DRF, IsAuthenticated, CSRF-enforced like all
   unsafe endpoints):
   - `GET /api/auth/sessions/` → own live sessions only
     (`id` = public_id, `createdAt`, `isCurrent`);
   - `POST /api/auth/sessions/{uuid}/revoke/` → non-leaking 404 for unknown or
     foreign ids; idempotent in the sense that a second call is 404;
   - `POST /api/auth/sessions/revoke-others/` → keeps current session;
   - `POST /api/auth/sessions/revoke-all/` → includes current session.
4. **Cookie/CSRF contract**:
   - `config/settings.py` (local HTTP dev): `SESSION_COOKIE_HTTPONLY=True`,
     `SESSION_COOKIE_SAMESITE="Lax"`, `SESSION_COOKIE_SECURE` stays off for
     local HTTP; `CSRF_COOKIE_HTTPONLY=False` (SPA reads the token),
     `CSRF_COOKIE_SAMESITE="Lax"`.
   - NEW `config/settings_production.py` (inherits settings):
     `SESSION_COOKIE_SECURE=True`, `CSRF_COOKIE_SECURE=True`, `DEBUG=False`.
     Values are test-pinned in `config`.
5. **AuthContext / inactive accounts**: verified, no change — DRF already
   returns 401 for inactive users on every API endpoint (probed), and the
   authorization kernel denies all capabilities.

## Decisions made

- D1: Registry lives in the `accounts` app (authentication concern; app
  already owns User + auth views/services).
- D2: Rows are deleted (not status-flagged) on revocation/logout →
  idempotent revocation falls out as a non-leaking 404.
- D3: API session identifier = `public_id` UUID4 (non-secret, non-guessable);
  the raw Django session key is never serialized.
- D4: `settings_production.py` rather than env-var guessing: the repo has no
  production settings module, and the task requires a testable production
  cookie contract.
- D5: No code change for M5 — the DRF authentication layer already rejects
  inactive users (probe FACT 2026-09-13); M5 adds behavioral proof.

## Discovered risks

- R1: Login view must register the POST-rotation session key; the middleware
  alone would register the pre-rotation key on the login request. Mitigated:
  explicit registration in the login view after `login()`.
- R2: Stale registry rows (key rotation, expiry, session row deletion).
  Mitigated: liveness cross-check in the list service + prune of the user's
  own dead rows.
- R3: Concurrency on lazy registration races → unique `session_key` +
  IntegrityError swallow.
- R4: `revoke-all` must not accidentally keep the current session;
  `revoke-others` must not delete it. Covered by dedicated behavioral tests
  with independent test clients.

## Milestones

- [x] M0 — inventory + baseline (1045 tests OK).
- [x] M1 — session registry model + migration + maintenance.
- [x] M2 — login/logout/session-fixation contract + tests.
- [x] M3 — session-management API + tests.
- [x] M4 — CSRF + cookie hardening + tests.
- [x] M5 — AuthContext / inactive-session behavioral proof.
- [x] M6 — security sweep + final verification + report.

## Migrations

- `accounts/migrations/0002_usersession.py` (planned) — creates
  `accounts_usersession` with unique `session_key` and unique `public_id`.

## Verification evidence

- M0: baseline green (see above).
- M1: `accounts/migrations/0002_usersession.py` applied forward on a real
  PostgreSQL 17 scratch database (`fg_auth_migration_check`, created,
  migrated, dropped); `makemigrations --check --dry-run` → no changes;
  `manage.py check` → 0 issues; 10 registry tests OK
  (multi-session, idempotent registration, unique key, liveness + pruning,
  lazy registration, orphan row not active).
- M2: `manage.py test accounts` — login rotation (pre-login key flushed,
  registry points at post-rotation key), pre-login cookie cannot
  authenticate after login, no session credential in login JSON, logout
  deletes the Django session row AND registry row, logged-out cookie replay
  → 401 on /me/ and /sessions/. Inactive login → 401, no registry row.
- M3: 3-browser A/B/C tests: list (metadata only, exactly one isCurrent,
  raw keys absent from the body), revoke-selected (only that browser 401;
  Django row + registry row gone), unknown/already-revoked → same
  non-leaking 404, revoke-others (current kept, exactly one session left),
  revoke-all (all browsers 401, registry empty, fresh login isolated),
  cross-user list/revoke denied non-leaking. 45/45 accounts tests OK.
- Stale-test changes in this window: none (the one interim failure was a
  bug in a NEW test I wrote this session — wrong expected body — fixed
  before green; no pre-existing test was modified).
- M4: cookie contract pinned for both environments
  (`config/tests.py::CookieContractTest`): dev (local HTTP) —
  SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SECURE=False (explicit),
  SameSite=Lax, CSRF_COOKIE_HTTPONLY=False (SPA reads the token from
  document.cookie), CSRF SameSite=Lax; production module
  (`config/settings_production.py`, NEW) — SESSION_COOKIE_SECURE=True,
  CSRF_COOKIE_SECURE=True, DEBUG=False. Real-CSRF tests
  (`accounts/tests_csrf.py`, `Client(enforce_csrf_checks=True)`): login
  without token 403 / with token 200; logout without token 403 and the
  session survives; session revoke / revoke-others / revoke-all without
  token 403 and state unchanged; authenticated application mutation
  (POST /api/research-groups/) 403 without token, 201 with token.
  Audit: no explicit `csrf_exempt` in code (only the `csrf_protect_view`
  helper which REMOVES the DRF flag); no mutating GET handlers; DRF
  SessionAuthentication enforces CSRF on all unsafe API methods.
  10/10 tests OK.
- M6: structured security sweep (self) + independent read-only security
  review subagent over the full diff. Verdict: no blockers; all seven
  review properties (secret leakage, client-trusted auth, session
  fixation, revocation gaps, CSRF bypasses, cookie misconfiguration,
  AuthZ regression) HOLD with file:line evidence. One RISK (R1:
  production module inheriting the dev SECRET_KEY) fixed this session
  (fail-fast guard + test). Final verification: full backend suite
  **Ran 1082 tests — OK**; `manage.py check` → 0 issues;
  `makemigrations --check --dry-run` → no changes;
  `./scripts/agent-verify.sh backend` → all checks passed;
  `git diff --check` → clean; final diff sweep for
  csrf_exempt / localStorage / sessionStorage / Bearer /
  "Authorization:" / role == / role != → no occurrences. Frontend
  unchanged (login/logout contract preserved; no web gates triggered by
  code changes).
- M5: no production code change required (FACT from M0 probe: DRF
  `SessionAuthentication.authenticate()` returns None for inactive users,
  so every API endpoint — including the new session-management endpoints
  and /me — answers 401; the authorization kernel independently denies
  all capabilities). Behavioral proof added:
  `accounts/tests_sessions.py::InactiveSessionBehaviorTest` (active login
  → protected access OK → is_active=False → same unchanged session 401
  on /me/, /sessions/, /research-groups/; Django session row retained —
  revocation is not deactivation). `manage.py test accounts` 53 OK;
  `manage.py test authorization` 50 OK (aa1253e regression suite green).

## Unresolved issues

- **R1 (resolved this session)** — the new production settings module
  initially inherited the committed dev `SECRET_KEY`. Fixed:
  `config/settings_production.py` now requires a deployment-provided
  `DJANGO_SECRET_KEY` and raises `ImproperlyConfigured` at import when the
  committed dev key would be used (pinned by
  `config/tests.py::CookieContractTest.test_production_module_refuses_development_secret_key`).
  `ALLOWED_HOSTS` remains empty in the production module (refuse-all
  default); a real deployment must set it plus `CSRF_TRUSTED_ORIGINS` —
  that is a deployment decision outside this task (documented, not
  broadened).
- Reviewer NOTEs, deliberately left as-is (documented, no security
  effect): orphan registry rows persist until the owner lists sessions
  (liveness cross-check guarantees they are never shown or usable);
  revoking an already-expired (unrevoked) row answers 200 (semantics
  only); `GET /api/auth/sessions/` prunes the requester's own dead rows
  (self-scoped, idempotent, not a mutating business endpoint); revoked
  browsers keep their inert cookie (server-side invalidation is the
  guarantee); `SESSION_COOKIE_AGE` stays the Django 2-week default
  (absolute lifetime policy deferred).

## Explicitly deferred

- Session-management/account-security UI (explicitly out of this slice).
- Password reset/change, e-mail verification, rate limiting, passkeys, SSO,
  API tokens, service accounts, full ACTIVE/SUSPENDED/DEACTIVATED lifecycle,
  sudo/recent-auth, audit-log subsystem, RLS, Redis.
- Production `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS` deployment values
  (deployment decision; the production module now fail-fasts on the dev
  SECRET_KEY instead of inheriting it silently — see Unresolved issues).
