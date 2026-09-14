# FG Workspace — Account Invitations Domain

This document is the canonical domain reference for **global account
invitations**.

Companion documents:

- `docs/domain/authentication-sessions.md` — Authentication & Sessions
  (WHO is this user; browser authentication and session management).
- `docs/domain/authorization.md` — Membership & Authorization (WHAT may a
  user do; ResearchGroup/Project membership, scopes, capabilities).
- `docs/architecture.md` — technical architecture.

The invariants below are **settled decisions**. Code that contradicts this
document is an implementation defect.

## 1. Purpose and dominant invariant

A global account invitation is a **time-bounded, single-use credential
bootstrap artifact** for a global FG Workspace account.

Its possession does not itself grant application-resource access.
Successful acceptance only **associates the invitation with the matching
global account**. Nothing else happens.

An account invitation targets a **global account** (identified by the
invited email address), never a ResearchGroup and never a Project.

Only people who do **not** yet have an FG Workspace account may be
invited: creating an invitation for a normalized email that already
belongs to an account is rejected with `account_exists` (§9).

## 2. Separation from Membership

1. Authentication (who), membership (where), and authorization (what)
   remain separate responsibilities (see
   `docs/domain/authentication-sessions.md` §1).
2. Creating, revoking, or accepting an account invitation **must not**
   create or alter:
   - a `ResearchGroupMembership`,
   - a `ProjectMembership`,
   - or any capability, scope, or access to ResearchGroups, Projects,
     Work Items, or Meetings.
3. An invitation token is never an authorization input: no endpoint grants
   any access because a caller holds (or presents) a token, except the
   acceptance operation defined in §7.
4. Membership invitations (inviting someone into a ResearchGroup or
   Project) are a separate, not-yet-implemented concern and must reuse the
   authorization foundation, not this mechanism.

## 3. Model

`accounts.AccountInvitation` (table `accounts_accountinvitation`):

- `public_id` — UUID, unique, the non-secret API identifier.
- `invited_by` — the User who created the invitation.
- `invited_email` — the **normalized** invited email (see §4).
- `token_digest` — SHA-256 hex digest of the raw token, unique. **The raw
  token is never persisted.**
- `status` — `pending` / `accepted` / `revoked` / `expired`.
- `created_at` / `expires_at` — creation and exact expiry (see §6).
- `accepted_at` / `accepted_by` — nullable; set exactly once on acceptance.
- `revoked_at` — nullable; set exactly once on revocation.

Database invariants:

- `public_id` unique; `token_digest` unique.
- **At most one `pending` row per normalized `invited_email`** — enforced
  structurally by a partial unique index
  (`uniq_account_invitation_pending_email`), not by application checks
  alone.

## 4. Email normalization

One canonical normalization rule applies to invitations and to acceptance
matching (shared helper `normalize_invitation_email`):

1. trim surrounding whitespace,
2. lowercase (case-insensitive comparison).

The stored `invited_email` is always the normalized form. The global User
email storage format is **intentionally unchanged** by this domain;
acceptance compares `normalize_invitation_email(actor.email)` against
`invited_email`.

## 5. Token security

1. Raw tokens are generated with `secrets.token_urlsafe(32)` (256 bits,
   cryptographic randomness; no custom cryptography).
2. Only the one-way SHA-256 digest is stored and used for lookup.
3. The raw token:
   - is never persisted in the database,
   - never appears in model `repr`/`str`,
   - is never returned by list endpoints,
   - is never written to application logs,
   - may be returned **exactly once**, by the creation response, because
     e-mail delivery is deferred and the caller currently needs the
     bootstrap artifact.
4. Token digests are never exposed through any API.

## 6. Lifetime and effective expiry

1. Every invitation expires **exactly 7 days** after creation
   (`expires_at = created_at + 7 days`, derived from the persisted
   creation timestamp).
2. A `pending` row with `expires_at <= now` is *effectively expired*: it is
   not usable, all API/service behavior treats it as `expired`, and it
   does not block creation of a new invitation.
3. Operations that evaluate an invitation's state (accept, revoke, list,
   creation) persist the `expired` transition when they encounter an
   effectively expired `pending` row. No scheduler is required;
   observable behavior is authoritative.

## 7. Lifecycle

Allowed transitions (centralized in
`apps/api/accounts/invitation_services.py` — views never mutate
lifecycle state directly):

```text
pending -> accepted    (acceptance, §8)
pending -> revoked     (manual revocation)
pending -> expired     (effective expiry persisted by a state-evaluating op)
```

`accepted`, `revoked`, and `expired` are **terminal**: no transition out
of them, ever. An accepted, revoked, or expired invitation cannot be
reactivated.

## 8. Acceptance (existing-account flow)

Acceptance is **atomic and concurrency-safe** (row lock + single
transaction):

1. The caller is the authenticated current user (server session identity;
   the account must be active). No client-supplied identity is trusted.
2. The raw token is resolved to an invitation by its digest.
3. The invitation must be effectively `pending` (unexpired).
4. `normalize_invitation_email(request.user.email)` must equal
   `invited_email`.
5. On success the invitation is atomically set to `accepted` with
   `accepted_at` and `accepted_by` — exactly once.

Acceptance **creates no User** and **creates no membership** (§2). A
second acceptance of the same token always fails, indistinguishably from
an unknown token (terminal states answer the same non-leaking failure as
unknown tokens).

Already-existing invitation records for emails that belong to an account
— for example records created before the existing-account guard on
creation (§9) — are still accepted through this flow; the guard only
restricts **new** creation.

**Registration integration (implemented):** a person without an account
redeems the invitation through invite-only registration
(`docs/domain/account-registration.md`). That flow creates and authenticates
the matching account and then marks the invitation `ACCEPTED` through the
**same** lifecycle internals as this acceptance service — token and
lifecycle logic is shared, never duplicated. Registration is a separate
endpoint under `/api/auth/`; it is not a second acceptance mechanism.

## 9. Duplicate pending invitations

**Existing-account guard first.** Account invitations are only for
people who do not yet have an FG Workspace account. If the normalized
email already belongs to an existing User — the same canonical
normalized lookup registration uses (trim + lowercase, active or
inactive) — creation is rejected with the stable `account_exists`
discriminator (API: `409`, the same status registration uses for that
code) before any token is generated and no invitation is written. This
guard takes precedence over the duplicate-pending rule: an email that
belongs to an account and also has a pending invitation record is
answered `account_exists`, never `pending_invitation_exists`. The
rejection creates no memberships.

For a non-account email, creating an invitation while an effective
`pending` invitation exists is **rejected**:

1. no new invitation is created;
2. the existing invitation is left completely unchanged (status, token,
   expiry, and timestamps); the old token remains usable;
3. the operation returns the stable domain discriminator
   `pending_invitation_exists` (API: `409` with a neutral message).

The rejection is deterministic and holds under concurrency: the partial
unique index (§3) guarantees at most one `pending` row per normalized
email, so exactly one concurrent creation can win; the losing attempt(s)
receive the same `pending_invitation_exists` failure.

An effectively **expired** pending invitation does **not** block
creation: the state-evaluating creation operation persists the `expired`
transition for that row (§6) and issues a new invitation with a fresh
cryptographically random token and the normal 7-day expiry. `revoked`,
`expired`, and `accepted` rows never block creation.

## 10. Revocation

1. Only the **original inviter** may manually revoke an invitation, and
   only while it is effectively `pending`.
2. The token becomes unusable immediately.
3. Revoke requests for unknown ids, foreign invitations, or invitations
   that are no longer effectively `pending` all answer the same
   non-leaking `404`; no state or existence is revealed.

## 11. API contract

Browser-authenticated, CSRF-protected (DRF `SessionAuthentication`
enforcement; no `csrf_exempt` shortcuts):

| Endpoint | Behavior |
|---|---|
| `GET /api/account-invitations/` | Own invitations, newest first, with **effective** status (`id`, `invitedEmail`, `invitedBy`, `status`, `createdAt`, `expiresAt`, `acceptedAt`, `revokedAt`). Never the raw token or its digest. Never other inviters' invitations. |
| `POST /api/account-invitations/` | Body `{targetEmail}`. Creates the pending invitation; `201` with the invitation metadata **plus the raw token exactly once**. `400` for an invalid email. `409` with the stable code `account_exists` when the normalized email already belongs to an FG Workspace account (checked first; no invitation and no token are created). `409` with the stable code `pending_invitation_exists` for a non-account email when an effective pending invitation already exists (the existing invitation and its token are left untouched). |
| `POST /api/account-invitations/{publicId}/revoke/` | Own, effectively pending invitations only; non-leaking `404` otherwise. |
| `POST /api/account-invitations/accept/` | Body `{token}`. Existing-account acceptance (§8). `404` unknown/terminal token, `410` expired, `400` email mismatch. |

All endpoints require an authenticated **active** account (DRF session
authentication rejects inactive accounts with `401`).

## 12. Concurrency invariants

1. **Concurrent acceptance of one token:** exactly one acceptance
   succeeds; the invitation ends `accepted` exactly once, with
   `accepted_by` set exactly once; no inconsistent intermediate state is
   observable (row lock + single transaction; real PostgreSQL).
2. **Concurrent creation for one normalized email:** exactly one creation
   succeeds; every other concurrent attempt fails with
   `pending_invitation_exists`. The final state contains at most one
   `pending` invitation and at most one usable token; no duplicate active
   invitations survive. The partial unique index serializes the inserts;
   the service retries narrowly and deterministically around the
   empty-row race, which resolves into the duplicate rejection.

These invariants are pinned by real-DB threaded tests
(`apps/api/accounts/tests_invitations_concurrency.py`), not mocks.

## 13. Explicitly deferred (NOT implemented)

- E-mail delivery of invitations (provider, templates, transport).
- The frontend signup UI (the backend registration flow that redeems an
  invitation for a new account is implemented — see
  `docs/domain/account-registration.md`).
- Invitation management UI.
- Membership invitations (ResearchGroup / Project).
- Invitation rate limiting.
- Invitation audit history.

This list documents deferral only; none of these are implemented.
