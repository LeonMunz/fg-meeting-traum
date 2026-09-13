# FG Workspace — Account Registration Domain

This document is the canonical domain reference for **invite-only account
registration** — how a person who does not yet have an FG Workspace account
creates one.

Companion documents:

- `docs/domain/account-invitations.md` — Account Invitations (the bootstrap
  artifact that registration redeems).
- `docs/domain/authentication-sessions.md` — Authentication & Sessions
  (the browser session registration establishes).
- `docs/domain/authorization.md` — Membership & Authorization.
- `docs/architecture.md` — technical architecture.

The invariants below are **settled decisions**. Code that contradicts this
document is an implementation defect.

## 1. Purpose and dominant invariant

**Public/open registration does not exist.** A global FG Workspace `User`
may be created through self-service registration **only** from one valid,
pending account invitation.

> A global `User` may be created through self-service registration only from
> one valid pending account invitation, and the creation of that `User` and
> the acceptance of that invitation form **one atomic domain transition**.

Registration is a **redeem** of the account-invitation artifact defined in
`docs/domain/account-invitations.md`: it consumes exactly one valid pending
token and binds it to the newly created account.

## 2. No public signup

1. There is no endpoint or service that creates a `User` without a valid
   pending invitation token.
2. Registration is impossible with a missing, unknown, expired, revoked,
   already-accepted, or replaced token.
3. The only other `User`-creation paths in the repository are developer /
   E2E seed management commands, not application endpoints.

## 3. The invited email is authoritative

1. The account email comes **exclusively** from
   `AccountInvitation.invited_email` (already normalized: trim + lowercase,
   see `docs/domain/account-invitations.md` §4).
2. The client **cannot** choose or change the invited email.
3. A registration request that includes an authoritative `email` field is
   **rejected fail-closed** (it is not silently trusted or ignored).
4. The stored `User.email` is set to the normalized invited email.

## 4. User-created identity fields

The person choosing to register supplies only the fields the current
`accounts.User` model (Django `AbstractUser`) actually requires them to
create:

- **`username`** — validated by the model's canonical validation (required,
  uniqueness, `max_length`, `UnicodeUsernameValidator`).
- **`password`** — validated by Django's configured `AUTH_PASSWORD_VALIDATORS`
  (`UserAttributeSimilarity`, `MinimumLength`, `Common`, `Numeric`), run via
  `validate_password(password, user)` against the account being created,
  then stored with `set_password`.

No new display-name / profile field is introduced. `first_name` / `last_name`
remain blank-optional and are not required by registration.

## 5. Existing-account collision

Before creating the `User`, registration checks whether any existing `User`
already has the invitation's **normalized** (trim + case-insensitive) email.

1. If at least one existing account matches (active **or** inactive):
   - no new `User` is created;
   - the invitation is **not** consumed (it remains `PENDING` and usable);
   - the operation returns a stable `account_exists` result telling the
     caller to **sign in** and use the existing invitation-acceptance flow
     (`POST /api/account-invitations/accept/`);
   - no unrelated account data is disclosed.
2. If multiple existing `User`s match the same normalized email, they are
   still reported as a single `account_exists`. This slice does **not**
   merge accounts; that is a future identity-cleanup concern.
3. This check introduces **no** `User.email` uniqueness and **no**
   normalized-email index (see §11). It is a database expression comparison
   `LOWER(BTRIM(email)) = <invited_email>`, mirroring
   `normalize_invitation_email`.

## 6. Atomicity

The following are **one database transaction**, bounded by a row lock on the
invitation row (`select_for_update`):

1. token resolution by digest and evaluation of effective lifecycle state;
2. persistence of the `EXPIRED` transition when the token is effectively
   expired (the one state change a failed registration may make);
3. the existing-account collision check;
4. username validation + Django password validation;
5. `User` creation;
6. the invitation `ACCEPTED` transition (`accepted` / `accepted_at` /
   `accepted_by`).

If any part fails:

- **no new `User` remains**;
- the invitation is **not** consumed — it stays usable — **unless** the
  failure is a genuine expiry, which legitimately transitions it to
  `EXPIRED`;
- **no** `ResearchGroupMembership` or `ProjectMembership` is created.

A `User` is never created first and then accepted through a separate
non-atomic flow.

## 7. Acceptance lifecycle sharing

Registration and the existing-account acceptance flow
(`docs/domain/account-invitations.md` §8) share the same lifecycle rules and
do **not** duplicate token or lifecycle logic. Both resolve the token by
digest, lock the invitation row, evaluate effective expiry, and persist the
terminal `ACCEPTED` transition through the same internal helpers in
`apps/api/accounts/invitation_services.py`. The only difference is the
disclosure policy: the existing-account endpoint keeps collapsing terminal
states to a single non-leaking failure, whereas registration distinguishes
`already_used` / `revoked` / `expired` (safe, because the caller already
holds the token) plus `invalid_token` / `account_exists` / `username` /
`password`.

## 8. Session establishment

After the database registration transaction succeeds, the new account is
authenticated **exactly** like an ordinary login:

1. `login(request, user)` — the normal Django browser-session path, which
   rotates the session identifier (no session fixation);
2. the **post-rotation** session key is registered in the `UserSession`
   registry (`register_user_session`), identical to the login endpoint.

The registration session is an ordinary revocable Django session:

- it is visible in the own-session listing (`GET /api/auth/sessions/`);
- it is individually revocable and removed by logout;
- it is subject to the same inactive-account handling as every other
  session;
- no special registration session type, token, or JWT is introduced.

See `docs/domain/authentication-sessions.md` §3 for the login contract and
the session-registry rules.

## 9. No membership, no permission grant

Registration creates **no** `ResearchGroupMembership` or `ProjectMembership`
and grants **no** access to any ResearchGroup, Project, Work Item, or
Meeting. Authentication ≠ membership; deny-by-default authorization is
untouched.

The newly registered **active** account retains the already-established
global rights: it may create a `ResearchGroup`, and later create `Project`s
inside ResearchGroups in which it is a member. No new permission is
introduced or required for this; existing authorization behavior is
unchanged.

## 10. CSRF / unauthenticated security

Registration and the invitation preview are **unauthenticated browser
mutations** (POST). As with login, they are explicitly CSRF-protected via the
`csrf_protect` pattern in `config/urls.py` (DRF's `csrf_exempt` flag is
removed and the view is wrapped with `csrf_protect`). There is no
`csrf_exempt` shortcut.

Browser contract:

1. the caller obtains a CSRF token from `GET /api/auth/csrf/`;
2. a registration/preview POST without a valid CSRF token is rejected;
3. a POST with a valid CSRF token may proceed.

The invitation preview endpoint (POST, non-consuming except for persisting an
effective `EXPIRED` transition) is CSRF-protected **deliberately**: it is an
unauthenticated browser POST that can write the expiry transition, so it is
treated like any other unauthenticated mutation.

## 11. No email-uniqueness migration

This slice does **not** add `unique=True` to `User.email` and does **not**
add a functional normalized-email unique index. Collisions are detected by a
database expression comparison (§5). Normalized-email uniqueness and account
merging are deferred (see §14).

## 12. Concurrency

The invitation row is the concurrency boundary. Under two (or more)
concurrent registration attempts with the **same** valid token:

- exactly **one** `User` is created from that invitation;
- exactly **one** registration operation succeeds;
- the invitation ends `ACCEPTED` exactly once, with `accepted_by` pointing at
  the single created `User`;
- the losing attempt(s) create **no** `User` (no orphan account survives).

This is enforced by real PostgreSQL row locking (`select_for_update` on the
invitation row) inside a single transaction — not by in-process mutexes or
mocked concurrency. It is pinned by real-DB threaded tests
(`accounts/tests_registration_concurrency.py`).

## 13. API contract

Unauthenticated, CSRF-protected (no `csrf_exempt`):

| Endpoint | Behavior |
|---|---|
| `POST /api/auth/register/` | Body `{token, username, password}`. `201` on success with the same safe user representation as the existing auth APIs (`id`, `username`, `firstName`, `lastName`, `email`), leaving the browser authenticated. A client-supplied `email` is rejected (`400`). Failure discriminators (each with a stable `code` and non-leaking message): `404` `invalid_token`, `410` `already_used` / `revoked` / `expired`, `409` `account_exists`, `400` `username` / `password`. Never returns the token digest, the raw token, or any unrelated account id. |
| `POST /api/auth/registration-invitation/` | **Non-consuming preview.** Body `{token}`. For an effective-pending token: `200` with `{status: "pending", usable: true, invitedEmail, expiresAt, accountExists}`. For a terminal token: `200` with `{status, usable: false}` (the invited email is not disclosed). For an unknown token: `404`. It does **not** authenticate, does **not** create or accept anything, and does **not** consume the invitation; it persists an effective `EXPIRED` transition consistent with the invitation lifecycle. |

Consumption rule: **only** a successful account-creation + acceptance
consumes a valid invitation. Preview/open, username-validation failure,
password-validation failure, an existing-account collision, and a malformed
request do **not** consume it. Expiry is the exception: an effectively-expired
invitation may and should transition to `EXPIRED`.

## 14. Explicitly deferred (NOT implemented)

- The frontend signup UI (this slice is backend-only; no UI is wired).
- E-mail delivery of invitations, e-mail verification.
- Password reset / recovery, passkeys, SSO.
- Membership invitations (ResearchGroup / Project).
- Global normalized `User.email` uniqueness and account merging.
- Invitation / registration rate limiting.

This list documents deferral only; none of these are implemented.
