# FG Workspace — Authentication & Sessions Domain

This document is the canonical domain reference for browser
**authentication** and **session management**.

Companion documents:

- `docs/domain/authorization.md` — Membership & Authorization (WHAT may a
  user do; capabilities, scopes, ownership). Authentication is a separate
  responsibility: it answers WHO is this user.
- `docs/architecture.md` — technical architecture.

The invariants below are **settled decisions**. Code that contradicts this
document is an implementation defect.

## 1. Authentication architecture

1. Django is the canonical browser authentication provider
   (`authenticate()` / `login()` / `logout()`, `ModelBackend`, DB session
   store, Django CSRF). There is no second authentication framework, no
   JWT/browser token authentication, and no client-side credential
   material.
2. The browser possesses only an opaque, HttpOnly session cookie. It never
   submits `userId`, role, capability, or membership as authoritative
   authentication information; the authenticated identity is always
   derived from the server session/request (`request.user`).
3. Authentication (who), membership (where), and authorization (what)
   remain separate server-side responsibilities; this document does not
   redefine the authorization foundation
   (`docs/domain/authorization.md`).

## 2. Session architecture

1. The Django session row (`django_session`) is the authentication
   credential.
2. `accounts.UserSession` is a server-side **registry/index** that
   attributes each authenticated browser session to exactly one User:
   `user` (FK), `session_key` (the Django session id, unique,
   server-side only), `public_id` (UUID, the non-secret API identifier),
   `created_at`.
3. The registry is **metadata only**: it never grants authentication. A
   registry row without a live Django session row is dead and must never
   be presented as an active session.
4. Registry maintenance:
   - the login endpoint (and the invite-only registration endpoint, which
     reuses the identical login path) registers the **post-rotation**
     session key;
   - `SessionRegistryMiddleware` lazily registers any authenticated
     session (sessions created outside the login endpoint, legacy
     sessions);
   - logout and every revocation operation delete the Django session row
     and the registry row atomically;
   - listing cross-checks Django session liveness (present and
     unexpired) and prunes the requesting user's own dead rows.

## 3. Login

1. Valid credentials authenticate through Django; the response contract is
   `{id, username, firstName, lastName, email}`.
2. Invalid credentials → 401 with a generic error (no user enumeration).
3. Inactive accounts never authenticate (Django `ModelBackend` rejects
   them at `authenticate()`).
4. Successful login **rotates the session identifier** (Django
   `login()`); the pre-login/anonymous session id must not remain usable
   as the authenticated session id (no session fixation).
5. **Invite-only registration** establishes a session the same way: after
   the atomic account + invitation transaction commits, `login(request,
   user)` rotates the session id and the post-rotation key is registered
   exactly as above. Registration creates no special session type or
   token; the resulting session is an ordinary revocable Django session
   (see `docs/domain/account-registration.md` §8).

## 4. Logout

1. Logout destroys the current Django session **server-side** and removes
   its registry row.
2. Replaying the logged-out session cookie must not authenticate
   (the session row no longer exists).
3. Clearing frontend state or removing a cookie client-side is not a
   logout.

## 5. Session management

A user may inspect and manage **their own** active sessions. The
implemented API contract (browser-authenticated, CSRF-protected):

| Endpoint | Behavior |
|---|---|
| `GET /api/auth/sessions/` | Own active sessions: `{id, createdAt, isCurrent}`; expired/revoked sessions are not listed |
| `POST /api/auth/sessions/{id}/revoke/` | Revoke one owned session; the revoked browser is anonymous on its next request |
| `POST /api/auth/sessions/revoke-others/` | Revoke every session of the user except the current one |
| `POST /api/auth/sessions/revoke-all/` | Revoke every session of the user, including the current one |

1. Multiple simultaneous sessions per user are supported and independent.
2. Session identifiers in the API are `public_id` UUIDs. The raw Django
   session key, session cookies, bearer credentials, and password hashes
   are never exposed by any endpoint.
3. Cross-user access is non-leaking: attempting to list or revoke another
   user's session behaves exactly like an unknown id (404,
   `{"error": "Session not found"}`); existence is never revealed.
4. Revocation is atomic (Django session row + registry row) and idempotent
   in the observable sense that re-revoking an already-revoked id is the
   same non-leaking 404.
5. The session-management UI is NOT part of this foundation (deferred).

## 6. Inactive accounts

1. An inactive account (`is_active=False`) cannot log in.
2. An already-authenticated session **ceases to provide authenticated
   access** once the account becomes inactive: the DRF session
   authentication layer rejects the session (401 on every API endpoint,
   including `/api/auth/me/` and the session-management endpoints), and
   the authorization kernel independently grants the account no
   capabilities.
3. Deactivation is not revocation: the Django session row is retained
   until its normal expiry or explicit revocation; it simply no longer
   authenticates.
4. The full ACTIVE/SUSPENDED/DEACTIVATED lifecycle, offboarding, and
   account deletion are out of scope for this foundation (see §8).

## 7. Cookie & CSRF contract

Cookies (local HTTP development — `config/settings.py`):

- `SESSION_COOKIE_HTTPONLY = True`
- `SESSION_COOKIE_SECURE = False` (explicit; local HTTP)
- `SESSION_COOKIE_SAMESITE = "Lax"`
- `CSRF_COOKIE_HTTPONLY = False` — the SPA reads the CSRF token from
  `document.cookie` (`apps/web/src/api/client.ts`) and sends it as
  `X-CSRFToken` on unsafe requests
- `CSRF_COOKIE_SAMESITE = "Lax"`

Production (`config/settings_production.py`):

- `SESSION_COOKIE_SECURE = True`
- `CSRF_COOKIE_SECURE = True`
- `DEBUG = False`
- HttpOnly and SameSite=Lax inherited from the base settings.
- The module refuses to start with the committed development
  `SECRET_KEY` (`DJANGO_SECRET_KEY` must be provided by the deployment),
  so production session cookies are never signed with a repo-committed
  secret. `ALLOWED_HOSTS` stays empty unless the deployment overrides
  it (refuse-all default).

CSRF:

1. All browser-authenticated mutating endpoints (login, logout, session
   management, and every existing application mutation) enforce the
   established Django/DRF CSRF mechanism: login/logout via
   `csrf_protect` (the DRF `csrf_exempt` flag is removed); all other API
   mutations via DRF `SessionAuthentication` CSRF enforcement.
2. Possessing the session cookie alone must never authorize a mutation.
3. `SameSite=Lax` is defense in depth and never replaces CSRF.
4. There are no mutating GET endpoints and no custom CSRF bypasses in the
   codebase.
5. Trusted origins are not broadened beyond the established
   `CSRF_TRUSTED_ORIGINS` (dev: 5173; e2e: 4173).

## 8. Explicitly deferred (NOT implemented)

- Session-management / account-security UI.
- E-mail verification, password reset, password change.
- Compromised-password checking, login abuse/rate limiting.
- Full ACTIVE/SUSPENDED/DEACTIVATED account lifecycle, offboarding,
  account deletion.
- Recent Authentication / Sudo Mode, Passkeys, Recovery Codes.
- OIDC / university SSO, account linking.
- Security audit log subsystem.
- Service accounts, API tokens.
- Calendar, Knowledge/Wiki, Roadmap, KVP, PostgreSQL RLS.

This list documents deferral only; none of these are implemented.
