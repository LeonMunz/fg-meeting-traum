# Execution Plan — Global Account Invitation Foundation

**Task type:** Domain (backend-only)
**Opened:** 2026-09-13
**Status:** COMPLETE (M0–M6; 2026-09-13)
**Starting commit:** `7a6fbc5aab282e28f86204bc093ca85229ed5cff` (fix(projects): reserve work item inspector rail; == origin/main, clean tree)
**Outcome:** Any active account can create a secure, single-use 7-day global
account invitation; invitations can be replaced, revoked by their inviter,
and accepted exactly once by an authenticated account with the matching
email — without granting any ResearchGroup or Project membership.

Canonical domain doc: `docs/domain/account-invitations.md` (created for
this task).

## M0 — Current-state inventory (verified 2026-09-13)

- User model: `accounts.User(AbstractUser)` — **no extra fields**; email is
  a plain non-unique `EmailField` with no normalization. Only two test
  fixtures carry emails (`max@example.com`, `legacy-alex@example.com`);
  no duplicate normalized emails exist. → **No User-email uniqueness
  migration** (would be unrelated scope); acceptance binds to
  `request.user` instead of email lookup.
- accounts app: `models.py` (User, UserSession), `services.py` (session
  registry ops), `views.py` (APIView + dict responses, camelCase keys,
  `{"error": ...}` failures, non-leaking 404s), no serializers module.
- API/auth: single `config/urls.py`; REST defaults
  `FGSessionAuthentication` + `IsAuthenticated`; DRF
  `SessionAuthentication` rejects inactive accounts (401) and enforces CSRF
  on authenticated unsafe requests; login/logout wrapped with
  `csrf_protect`. Real-enforcement tests via
  `Client(enforce_csrf_checks=True)` (`accounts/tests_csrf.py`).
- Domain error convention: `XDomainError(Exception)` with `.message`
  (e.g. `ResearchGroupDomainError`).
- Concurrency harness: `TransactionTestCase` + `threading.Barrier` workers
  calling real services, `_db.close()` in `finally`, exactly-one-success
  assertions (`research_groups/tests_concurrency.py`).
- Postgres test DB available (repository-native setup).

## Decisions

- **Model:** `accounts.AccountInvitation` — `public_id` (UUID, unique),
  `invited_by` FK, `invited_email` (normalized), `token_digest` (SHA-256
  hex, unique), `status`, `created_at` (auto), `expires_at`,
  `accepted_at`/`accepted_by` (nullable), `revoked_at` (nullable). Partial
  unique index: one `pending` row per normalized email.
- **Token:** `secrets.token_urlsafe(32)`; only SHA-256 digest persisted;
  raw token returned exactly once (creation response).
- **Normalization:** `normalize_invitation_email` = trim + lowercase;
  shared by storage and acceptance matching.
- **Expiry:** exactly 7 days; `expires_at` derived from the persisted
  `created_at` (auto_now_add owns that column) inside the create
  transaction; effective expiry is observable behavior, EXPIRED persisted
  by state-evaluating operations, no scheduler.
- **Lifecycle:** centralized in `accounts/invitation_services.py`;
  `pending → accepted | revoked | expired`, terminal forever. System
  replacement uses `revoked` (no invented `REPLACED`).
- **Concurrency:** create = replace-under-lock + insert, with a bounded
  (3×) deterministic retry around the IntegrityError from the partial
  unique index (empty-row race); accept = `select_for_update` + single
  transaction, failures as outcomes (not exceptions inside the atomic
  block) so the persisted EXPIRED transition survives.
- **API:** list+create `GET/POST /api/account-invitations/`,
  `POST .../{publicId}/revoke/`, `POST .../accept/` — all
  IsAuthenticated (→ active only), CSRF via SessionAuthentication.

## Scope notes

- No registration/signup, no e-mail delivery, no UI, no membership
  invitations, no rate limiting (all deferred; documented).
- Future registration flow must call `accept_account_invitation` after
  creating/authenticating the matching account.

## Verification

- `accounts` app suite green, including new
  `tests_invitations.py` (25 behavioral API/service tests incl. real CSRF)
  and `tests_invitations_concurrency.py` (2 real-DB threaded tests).
- `manage.py check`, `makemigrations --check --dry-run`, and the broader
  backend verification per `scripts/agent-verify.sh backend`.
