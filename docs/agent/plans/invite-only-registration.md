# Execution Plan — Invite-Only Account Registration

**Task type:** Domain (backend-only)
**Opened:** 2026-09-13
**Status:** COMPLETE (M0–M7; 2026-09-13)
**Starting commit:** `a9b9be15ba08883365fa1998c7bfae5910613eaf` (feat(accounts): establish invitation foundation; == origin/main, clean tree)
**Outcome:** A person without an account redeems exactly one valid pending
account-invitation token to create exactly one account, atomically accept
that invitation, and receive a normal revocable Django browser session.
Registration without a valid pending invitation is impossible.

Canonical domain doc: `docs/domain/account-registration.md` (created for this
task).

## M0 — Current-state inventory (verified 2026-09-13)

- **User model:** `accounts.User(AbstractUser)` — no extra fields.
  `USERNAME_FIELD = "username"` (Django default). `username` is unique,
  `max_length=150`, `UnicodeUsernameValidator`. `email` is a non-unique
  `EmailField`. The only user-created field the model *requires* is
  **username**; email is supplied by the invitation, password by the
  credential.
- **Existing acceptance service:** `accounts/invitation_services.py`
  `accept_account_invitation(actor, token)` — resolves token by SHA-256
  digest, `select_for_update` on the invitation row, evaluates effective
  expiry, requires matching normalized email, atomically sets
  `accepted`/`accepted_at`/`accepted_by`. Terminal states answer the same
  non-leaking failure as unknown tokens; effective expiry is persisted as
  `EXPIRED`. The transaction commits on every computed outcome so the
  persisted `EXPIRED` survives.
- **Login / session path:** `LoginView` → `login(request, user)` (rotates the
  session key) → `register_user_session(user, request.session.session_key)`.
  `UserSession` is a metadata-only registry; `SessionRegistryMiddleware`
  lazily registers sessions created outside login. Login/logout use
  `csrf_protect_view` (removes DRF `csrf_exempt` then wraps `csrf_protect`).
- **Password validation:** `AUTH_PASSWORD_VALIDATORS` = UserAttributeSimilarity,
  MinimumLength, Common, Numeric. Canonical API:
  `validate_password(password, user)`.
- **CSRF for unauthenticated mutations:** `csrf_protect_view(...)` in
  `config/urls.py`; real enforcement tested with
  `Client(enforce_csrf_checks=True)`.
- **No existing public self-service User creation.** The only User-creation
  paths are the seed management commands (dev/e2e fixtures), not API
  endpoints. No `User.email` uniqueness and no normalized-email index
  (intentionally not added here).
- **Collision detection without a uniqueness migration:** compare the
  invitation's normalized (trim+lowercase) email against stored emails using
  a PostgreSQL expression match `LOWER(BTRIM(email)) = <invited_email>`
  (no index; app is PostgreSQL-only), mirroring `normalize_invitation_email`.
- **Concurrency harness:** `TransactionTestCase` + `threading.Barrier`
  workers calling the real service, `_db.close()` in `finally`,
  exactly-one-success assertions (`accounts/tests_invitations_concurrency.py`).
  Postgres test DB verified available.

## Decisions

1. **One canonical service** — `register_account_from_invitation(token,
   username, password)` in `invitation_services.py`, sharing lifecycle
   internals with `accept_account_invitation`.
2. **Shared internals, no duplicated lifecycle.** A new internal
   `_resolve_locked_invitation(raw_token)` returns the truthful lifecycle
   state (`missing` / `accepted` / `revoked` / `expired` / `pending`) and the
   locked row for `pending`/`expired`. A `_mark_invitation_accepted` helper
   centralizes the ACCEPTED write. Both public services apply their own
   disclosure policy on top: the existing acceptance flow keeps collapsing
   terminal states to the non-leaking `not_found`; registration distinguishes
   `already_used` / `revoked` / `expired` (safe — the caller holds the token)
   plus `invalid_token` / `account_exists` / `username` / `password`.
3. **Atomicity boundary = the invitation row.** Everything (token resolve,
   expiry, collision check, User create, ACCEPTED write) is one
   `transaction.atomic()` with the invitation row held under
   `select_for_update`. Username/password validation failures write nothing
   and leave the invitation PENDING and usable; only a real expiry persists
   `EXPIRED`.
4. **Email is authoritative from the invitation.** The client supplies only
   `username` + `password`. A client-supplied `email` is **rejected
   fail-closed (400)**.
5. **Existing-account collision:** if any existing User's normalized email
   equals the invited email, no User is created, the invitation is not
   consumed, and the result is a stable `account_exists` (409). Inactive
   matching accounts also block. Multiple matches are still a single
   `account_exists` (no merging).
6. **Session establishment reuses login.** On success: `login(request, user)`
   + `register_user_session(user, request.session.session_key)` — identical to
   `LoginView`. No special registration session, no JWT.
7. **CSRF:** both new endpoints are unauthenticated browser POSTs → wrapped
   with `csrf_protect_view`, same as login. The preview endpoint
   (non-consuming except persisting `EXPIRED`) is CSRF-protected too,
   deliberately, because it can write the expiry transition and is an
   unauthenticated browser POST.
8. **Endpoints:** `POST /api/auth/register/` and non-consuming
   `POST /api/auth/registration-invitation/` (preview).
9. **No Membership, no permissions.** Registration creates no
   `ResearchGroupMembership` / `ProjectMembership` and grants nothing; the new
   active account retains the already-established right to create a
   `ResearchGroup` (no new permission added).
10. **Docs:** created `docs/domain/account-registration.md`; updated
    `account-invitations.md`, `authentication-sessions.md`, `CURRENT_STATE.md`,
    and `docs/README.md`.

## Verification

Targeted: `accounts.tests_registration` (38 tests) +
`accounts.tests_registration_concurrency` (2 tests) — green. `accounts` app
suite (118) green. Full Django backend suite (1148) green.
`manage.py check`, `makemigrations --check --dry-run` (no changes), and
`./scripts/agent-verify.sh backend` green.
