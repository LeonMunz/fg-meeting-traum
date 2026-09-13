"""Account invitation domain operations.

An ``AccountInvitation`` is a time-bounded, single-use credential
bootstrap artifact for a **global FG Workspace account**. It targets the
normalized invited email — never a ResearchGroup or Project — and creating,
revoking, or accepting one grants no membership and no access to any
application resource. All lifecycle transitions (PENDING -> ACCEPTED /
REVOKED / EXPIRED) are centralized in this module; views only translate
domain errors into API responses.

Token security: the raw token is generated with ``secrets`` and persisted
only as a one-way SHA-256 digest. The raw token is never stored, logged,
serialized, or returned after the single creation response.

Canonical email normalization (shared by invitation storage, acceptance
matching, and registration collision detection): trim surrounding
whitespace, then lowercase (case-insensitive comparison).

Concurrency: at most one PENDING row per normalized email is enforced by a
partial unique index (``uniq_account_invitation_pending_email``). Creation
replaces the existing effective pending row atomically and retries
narrowly around the empty-row insert race; acceptance and registration lock
the invitation row so at most one concurrent transition of a token
succeeds.
"""

import hashlib
import secrets
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import (
    get_default_password_validators,
    validate_password,
)
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.db.models import CharField
from django.db.models.expressions import RawSQL
from django.utils import timezone

from .models import AccountInvitation

User = get_user_model()

INVITATION_LIFETIME = timedelta(days=7)

# Django's stable validation-code identifiers, keyed by configured
# validator class name. These are the codes Django's own
# ``ValidationError`` carries (see ``django.contrib.auth.
# password_validation``); they only identify a requirement and encode no
# policy — the satisfied/not decision always comes from running the
# configured validator itself. Unknown future validators fall back to
# their lowercased class name.
_VALIDATOR_CODE_BY_CLASS = {
    "UserAttributeSimilarityValidator": "password_too_similar",
    "MinimumLengthValidator": "password_too_short",
    "CommonPasswordValidator": "password_too_common",
    "NumericPasswordValidator": "password_entirely_numeric",
}

# Stable, non-leaking failure messages shared by registration and the
# non-consuming password-policy check (same discriminators, same words).
_REGISTRATION_FAILURE_MESSAGES = {
    "invalid_token": "This invitation token is invalid or unknown.",
    "already_used": "This invitation has already been used.",
    "revoked": "This invitation has been revoked.",
    "expired": "This invitation has expired.",
    "account_exists": (
        "An account with this e-mail address already exists. Please sign in."
    ),
    "username": "The username is invalid or already in use.",
    "password": "The password does not meet the requirements.",
}

# Bounded, deterministic retry around the empty-row insert race on the
# partial unique index (concurrent first invitations for the same email).
_MAX_CREATE_ATTEMPTS = 3


class AccountInvitationDomainError(Exception):
    """Raised when an account invitation domain invariant is violated.

    ``code`` is a stable machine-readable discriminator the API layer maps
    onto status codes (it never leaks which other email addresses are
    invited).
    """

    def __init__(self, message, code="invalid"):
        self.message = message
        self.code = code
        super().__init__(message)


class RegistrationDomainError(Exception):
    """Raised when invite-only registration cannot proceed.

    ``code`` is a stable machine-readable discriminator the API layer maps
    onto status codes: ``invalid_token`` / ``already_used`` / ``revoked`` /
    ``expired`` / ``account_exists`` / ``username`` / ``password``.

    ``requirements`` is present only for the ``password`` failure: the
    per-validator requirement states produced by
    ``evaluate_password_requirements`` (the same evaluator the
    registration-password-policy endpoint uses), so a final registration
    failure reconciles with the live policy contract.
    """

    def __init__(self, message, code="invalid", requirements=None):
        self.message = message
        self.code = code
        self.requirements = requirements
        super().__init__(message)


def normalize_invitation_email(value):
    """Canonical invitation email normalization.

    Trim surrounding whitespace and lowercase. This is the only
    normalization applied to invited (and matched) emails in this slice;
    the global User email storage format is intentionally untouched.
    """
    if value is None:
        return ""
    return str(value).strip().lower()


def generate_invitation_token():
    """Cryptographically random invitation token (256 bits, URL-safe)."""
    return secrets.token_urlsafe(32)


def digest_invitation_token(raw_token):
    """One-way SHA-256 digest of a raw token (the only persisted form)."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def effective_status(invitation, now=None):
    """The invitation's lifecycle state as observed by the outside world.

    A PENDING row at or past ``expires_at`` is *effectively expired*: it is
    no longer usable and must behave as EXPIRED everywhere, even before the
    persisted status is updated.
    """
    now = now if now is not None else timezone.now()
    if (
        invitation.status == AccountInvitation.Status.PENDING
        and invitation.expires_at <= now
    ):
        return AccountInvitation.Status.EXPIRED
    return invitation.status


def serialize_account_invitation(invitation, now=None):
    """Non-secret API representation of an invitation.

    Never includes the raw token (not stored) or the token digest.
    """
    return {
        "id": str(invitation.public_id),
        "invitedEmail": invitation.invited_email,
        "invitedBy": invitation.invited_by_id,
        "status": effective_status(invitation, now),
        "createdAt": invitation.created_at.isoformat(),
        "expiresAt": invitation.expires_at.isoformat(),
        "acceptedAt": (
            invitation.accepted_at.isoformat() if invitation.accepted_at else None
        ),
        "revokedAt": (
            invitation.revoked_at.isoformat() if invitation.revoked_at else None
        ),
    }


def _require_active_account(actor):
    if not getattr(actor, "is_active", False):
        raise AccountInvitationDomainError(
            "Only active accounts may use account invitations.",
            code="inactive",
        )


def _replace_pending_invitation(invited_email, now):
    """Transition this email's PENDING rows out of PENDING (under lock).

    Effective pending rows become REVOKED (system replacement — the old
    token is unusable immediately); rows already past expiry are persisted
    as EXPIRED. Called inside the caller's transaction.
    """
    rows = (
        AccountInvitation.objects.select_for_update()
        .filter(
            invited_email=invited_email,
            status=AccountInvitation.Status.PENDING,
        )
    )
    for row in rows:
        if row.expires_at <= now:
            row.status = AccountInvitation.Status.EXPIRED
        else:
            row.status = AccountInvitation.Status.REVOKED
            row.revoked_at = now
        row.save(update_fields=["status", "revoked_at"])


def create_account_invitation(*, actor, invited_email):
    """Create (or replace) the pending account invitation for an email.

    Validates and normalizes the target email, generates a fresh
    cryptographic token, atomically invalidates any existing effective
    pending invitation for the same normalized email, and persists exactly
    one new PENDING row expiring 7 days after creation.

    Returns ``(invitation, raw_token)``. The raw token is returned once,
    only here; it is never persisted.
    """
    _require_active_account(actor)

    normalized = normalize_invitation_email(invited_email)
    try:
        validate_email(normalized)
    except ValidationError:
        raise AccountInvitationDomainError(
            "A valid e-mail address is required.", code="invalid_email"
        ) from None

    for _attempt in range(_MAX_CREATE_ATTEMPTS):
        try:
            with transaction.atomic():
                now = timezone.now()
                _replace_pending_invitation(normalized, now)
                token = generate_invitation_token()
                invitation = AccountInvitation.objects.create(
                    invited_by=actor,
                    invited_email=normalized,
                    token_digest=digest_invitation_token(token),
                    status=AccountInvitation.Status.PENDING,
                    # Provisional; tightened below so expiry is exactly
                    # 7 days after the persisted created_at.
                    expires_at=now + INVITATION_LIFETIME,
                )
                # auto_now_add owns created_at; derive the exact expiry
                # from the persisted creation timestamp.
                invitation.expires_at = (
                    invitation.created_at + INVITATION_LIFETIME
                )
                invitation.save(update_fields=["expires_at"])
            return invitation, token
        except IntegrityError:
            # Empty-row race: a concurrent transaction inserted the single
            # PENDING row for this email after we read none. The partial
            # unique index serialized the inserts and rolled this attempt
            # back; retry the replacement against committed state.
            continue

    raise AccountInvitationDomainError(
        "Could not create the invitation. Try again.", code="conflict"
    )


def list_account_invitations(user):
    """All invitations created by ``user``, newest first.

    The list is an operation that evaluates state: PENDING rows already
    past their expiry are persisted as EXPIRED. Only the requesting user's
    own invitations are ever returned.
    """
    now = timezone.now()
    AccountInvitation.objects.filter(
        invited_by=user,
        status=AccountInvitation.Status.PENDING,
        expires_at__lte=now,
    ).update(status=AccountInvitation.Status.EXPIRED)
    return list(
        AccountInvitation.objects.filter(invited_by=user).order_by(
            "-created_at", "pk"
        )
    )


def revoke_account_invitation(*, actor, public_id):
    """Revoke the actor's own invitation while it is effectively pending.

    Returns the revoked invitation, or None for an unknown id, a foreign
    invitation (non-disclosure: the API answers the same 404), or an
    invitation that is no longer effectively pending.
    """
    _require_active_account(actor)
    with transaction.atomic():
        invitation = (
            AccountInvitation.objects.select_for_update()
            .filter(invited_by=actor, public_id=public_id)
            .first()
        )
        if invitation is None:
            return None
        now = timezone.now()
        if invitation.status == AccountInvitation.Status.PENDING:
            if invitation.expires_at <= now:
                invitation.status = AccountInvitation.Status.EXPIRED
                invitation.save(update_fields=["status"])
            else:
                invitation.status = AccountInvitation.Status.REVOKED
                invitation.revoked_at = now
                invitation.save(update_fields=["status", "revoked_at"])
                return invitation
        return None


def _resolve_locked_invitation(raw_token):
    """Lock and evaluate the invitation for a raw token.

    Must be called inside the caller's ``transaction.atomic`` block. Returns
    ``(state, invitation, now)`` where ``state`` is one of:

    - ``"missing"``   no row for this token digest;
    - ``"accepted"``  terminal ACCEPTED;
    - ``"revoked"``   terminal REVOKED;
    - ``"expired"``   PENDING but at/past ``expires_at`` — the ``EXPIRED``
                      transition is persisted by this state-evaluating read;
    - ``"pending"``   effectively PENDING (usable).

    ``invitation`` and ``now`` are meaningful for ``pending`` (the locked row
    and the evaluation time) and for ``expired`` (the persisted row). The row
    is held under ``select_for_update`` for the caller's transaction, so at
    most one concurrent transition of the token succeeds.
    """
    raw_token = str(raw_token or "").strip()
    if not raw_token:
        return ("missing", None, None)

    invitation = (
        AccountInvitation.objects.select_for_update()
        .filter(token_digest=digest_invitation_token(raw_token))
        .first()
    )
    if invitation is None:
        return ("missing", None, None)

    if invitation.status == AccountInvitation.Status.ACCEPTED:
        return ("accepted", None, None)
    if invitation.status == AccountInvitation.Status.REVOKED:
        return ("revoked", None, None)
    if invitation.status == AccountInvitation.Status.PENDING:
        now = timezone.now()
        if invitation.expires_at <= now:
            invitation.status = AccountInvitation.Status.EXPIRED
            invitation.save(update_fields=["status"])
            return ("expired", invitation, now)
        return ("pending", invitation, now)

    return ("missing", None, None)  # pragma: no cover - status is a closed set


def _mark_invitation_accepted(invitation, user, now):
    """Persist the terminal ACCEPTED transition for ``invitation``.

    Shared by existing-account acceptance and registration so both use the
    exact same lifecycle write.
    """
    invitation.status = AccountInvitation.Status.ACCEPTED
    invitation.accepted_at = now
    invitation.accepted_by = user
    invitation.save(update_fields=["status", "accepted_at", "accepted_by"])


def _existing_user_for_normalized_email(email):
    """True when any existing User's normalized email equals ``email``.

    ``email`` is the invitation's already-normalized (trim + lowercase)
    invited email. The User email is not globally unique and this slice adds
    no normalized-email index, so the comparison is a PostgreSQL expression
    match on the stored column (``LOWER(BTRIM(email))``), mirroring
    ``normalize_invitation_email``. This is a scan, not an index lookup; that
    is accepted in this slice.
    """
    return (
        User.objects.annotate(
            _normalized_email=RawSQL(
                "LOWER(BTRIM(email))",
                [],
                output_field=CharField(),
            )
        )
        .filter(_normalized_email=email)
        .exists()
    )


def _try_create_registration_user(username, password, email):
    """Create and save the registration ``User``.

    Validates the username through the model's canonical validation and the
    password through Django's configured validators, both against the
    account being created. Returns ``(code, user, requirements)``:
    - ``("created", user, None)`` on success;
    - ``("username", None, None)`` when the username is invalid or already
      taken;
    - ``("password", None, requirements)`` when the password fails
      Django's validators, with the per-validator requirement states from
      ``evaluate_password_requirements``.

    Called inside the caller's atomic block; a failure writes nothing, so
    the surrounding transaction — and any PENDING invitation — is left intact.
    """
    user = User(username=username, email=email)
    try:
        # Username + email are validated by the model; password is set
        # separately (see validate_password / set_password below), so it
        # is excluded from the field validation here.
        user.full_clean(exclude=["password"])
    except ValidationError:
        return ("username", None, None)
    try:
        validate_password(password, user)
    except ValidationError:
        # Same evaluator as the registration-password-policy endpoint, so
        # the registration failure reconciles with the live policy result.
        return (
            "password",
            None,
            evaluate_password_requirements(
                password, username=username, email=email
            ),
        )
    user.set_password(password)
    try:
        user.save()
    except IntegrityError:
        # Concurrent same-username registration lost the race.
        return ("username", None, None)
    return ("created", user, None)


def accept_account_invitation(*, actor, token):
    """Bind the invitation for ``token`` to the authenticated actor.

    Existing-account acceptance: the actor is the already-authenticated
    current user (never a client-supplied identity) and must have a
    normalized email equal to the invitation's invited email. No User is
    created and no ResearchGroup or Project membership is created.

    Registration acceptance (``register_account_from_invitation``) shares the
    same lifecycle internals (``_resolve_locked_invitation`` /
    ``_mark_invitation_accepted``) — token and lifecycle logic is not
    duplicated.

    Returns the ACCEPTED invitation. Raises ``AccountInvitationDomainError``:
    - ``not_found`` for an unknown token, or a token whose invitation is
      already terminal (ACCEPTED / REVOKED) — indistinguishable on purpose;
    - ``expired`` for a token whose invitation is effectively expired
      (persisted as EXPIRED);
    - ``email_mismatch`` when the actor's normalized email differs from the
      invited email.

    Concurrency-safe: the row is locked (``select_for_update``) inside one
    transaction, so exactly one concurrent acceptance can succeed.
    """
    _require_active_account(actor)

    # The transaction commits on every outcome (failures are outcomes, not
    # exceptions inside the block) so the persisted EXPIRED transition —
    # made by this state-evaluating operation — survives.
    with transaction.atomic():
        state, invitation, now = _resolve_locked_invitation(token)
        if state == "pending":
            if (
                normalize_invitation_email(getattr(actor, "email", ""))
                != invitation.invited_email
            ):
                outcome = ("email_mismatch", None)
            else:
                _mark_invitation_accepted(invitation, actor, now)
                outcome = ("accepted", invitation)
        elif state == "expired":
            outcome = ("expired", None)
        else:  # missing / accepted / revoked -> same non-leaking failure
            outcome = ("not_found", None)

    if outcome[0] == "accepted":
        return outcome[1]
    messages = {
        "not_found": "Invitation not found.",
        "expired": "This invitation has expired.",
        "email_mismatch": "This invitation is for a different e-mail address.",
    }
    raise AccountInvitationDomainError(messages[outcome[0]], code=outcome[0])


def register_account_from_invitation(*, token, username, password):
    """Create the account for ``token`` and atomically accept the invitation.

    Invite-only self-service registration. The invited email comes
    exclusively from the invitation; the client supplies only the user-created
    fields required by the current User model (username and password). User
    creation and invitation acceptance are ONE atomic database transition,
    bounded by the invitation row lock: if any part fails, no new User
    remains and the invitation is not consumed (an effectively-expired PENDING
    row is persisted as EXPIRED, consistent with the invitation lifecycle).
    No ResearchGroup or Project membership is created and no access is
    granted.

    Returns the created ``User``. Raises ``RegistrationDomainError`` with a
    stable ``code``:
    - ``invalid_token``  unknown token;
    - ``already_used``   invitation already accepted;
    - ``revoked``        invitation revoked;
    - ``expired``        invitation effectively expired (persisted);
    - ``account_exists`` a User with the invited normalized email already
                         exists (the caller must sign in and use the existing
                         acceptance flow);
    - ``username``       username invalid or already in use;
    - ``password``       password failed Django's validators.
    """
    username = "" if username is None else str(username)
    password = "" if password is None else str(password)

    with transaction.atomic():
        state, invitation, now = _resolve_locked_invitation(token)
        if state != "pending":
            code = {
                "expired": "expired",
                "accepted": "already_used",
                "revoked": "revoked",
            }.get(state, "invalid_token")
            outcome = (code, None, None)
        elif _existing_user_for_normalized_email(invitation.invited_email):
            outcome = ("account_exists", None, None)
        else:
            code, user, requirements = _try_create_registration_user(
                username, password, invitation.invited_email
            )
            if code == "created":
                _mark_invitation_accepted(invitation, user, now)
            outcome = (code, user, requirements)

    if outcome[0] == "created":
        return outcome[1]
    code, _user, requirements = outcome
    raise RegistrationDomainError(
        _REGISTRATION_FAILURE_MESSAGES[code],
        code=code,
        requirements=requirements,
    )


def evaluate_password_requirements(password, *, username, email):
    """Evaluate each configured Django password validator individually.

    Builds the same transient candidate ``User`` identity that registration
    validation uses (client-supplied ``username``, invitation-authoritative
    ``email``, blank first/last name) and runs every validator from
    ``get_default_password_validators()`` — the canonical set used by
    ``validate_password`` — against it. No policy is reproduced here: a
    requirement is satisfied if and only if the configured validator itself
    accepts the candidate password, so a given token + username + password
    candidate yields exactly the result actual registration would compute.

    Returns ``[{code, label, satisfied}, ...]`` in
    ``AUTH_PASSWORD_VALIDATORS`` order: ``code`` is Django's stable
    validation code for that validator, ``label`` is the validator's
    configured help text (so configured parameters, e.g. the minimum
    length, are reflected without any frontend-owned copy), and
    ``satisfied`` is the validator's own verdict. The candidate password is
    only passed to the validators; it is never stored, logged, serialized,
    or echoed back.
    """
    user = User(username=username, email=email)
    requirements = []
    for validator in get_default_password_validators():
        try:
            validator.validate(password, user)
            satisfied = True
        except ValidationError:
            satisfied = False
        validator_class = type(validator).__name__
        requirements.append(
            {
                "code": _VALIDATOR_CODE_BY_CLASS.get(
                    validator_class, validator_class.lower()
                ),
                "label": validator.get_help_text(),
                "satisfied": satisfied,
            }
        )
    return requirements


def _resolve_invitation_read_only(raw_token):
    """Read-only invitation resolution for strictly non-mutating operations.

    Reuses the canonical token digesting (``digest_invitation_token``) and
    the canonical effective-expiration rule (``effective_status``) but
    acquires **no** mutation-oriented row lock and **persists no** lifecycle
    transition: an effectively expired PENDING row is reported as
    ``"expired"`` while remaining PENDING in the database. The
    state-evaluating ``EXPIRED`` persistence belongs to the mutation-aware
    resolver (``_resolve_locked_invitation``) used by preview, acceptance,
    and registration.

    Returns ``(state, invitation)`` where ``state`` is one of
    ``"missing"`` / ``"pending"`` / ``"expired"`` / ``"accepted"`` /
    ``"revoked"`` and ``invitation`` is the (PENDING) row for the
    ``"pending"`` state and ``None`` otherwise. A row already persisted as
    EXPIRED collapses to ``"missing"`` — the same canonical terminal
    interpretation the mutation-aware resolver applies.
    """
    raw_token = str(raw_token or "").strip()
    if not raw_token:
        return ("missing", None)

    invitation = AccountInvitation.objects.filter(
        token_digest=digest_invitation_token(raw_token)
    ).first()
    if invitation is None:
        return ("missing", None)

    if invitation.status == AccountInvitation.Status.PENDING:
        if effective_status(invitation) == AccountInvitation.Status.EXPIRED:
            # Effectively expired PENDING: canonical expired semantics,
            # but the row is left untouched (no EXPIRED persistence).
            return ("expired", None)
        return ("pending", invitation)
    if invitation.status in (
        AccountInvitation.Status.ACCEPTED,
        AccountInvitation.Status.REVOKED,
    ):
        return (invitation.status, None)
    return ("missing", None)  # persisted EXPIRED: canonical terminal collapse


def check_registration_password_policy(*, token, username, password):
    """Strictly read-only live password-policy check for a registration
    candidate.

    Resolves the invitation through the canonical token/digest rules and
    the canonical effective-expiration rule (``_resolve_invitation_read_only``)
    without acquiring mutation-oriented row locks and without persisting
    any invitation lifecycle transition: repeated checks are side-effect
    free, and an effectively expired PENDING invitation is reported as
    expired while remaining PENDING in the database. It performs no
    consumption, no acceptance, no User creation, and no membership or
    permission change. The invited email is server-authoritative: the
    candidate identity evaluated by Django's configured validators is the
    same transient ``User`` that registration would create, so the browser
    cannot substitute another email.

    Empty ``username`` / ``password`` are valid candidate form state (the
    live UI validates while the form is being filled), not malformed
    requests.

    For a non-pending invitation the same stable discriminators as
    registration are raised (``invalid_token`` / ``already_used`` /
    ``revoked`` / ``expired``). For a pending invitation it returns
    ``{"valid", "requirements", "accountExists"}``: ``valid`` is true only
    when every configured validator passes; ``requirements`` is the
    per-validator state from ``evaluate_password_requirements``; and
    ``accountExists`` mirrors the registration-preview contract for an
    invitation whose normalized email already belongs to an account
    (registration would still fail with ``account_exists``; no new account
    path is introduced).
    """
    username = "" if username is None else str(username)
    password = "" if password is None else str(password)

    state, invitation = _resolve_invitation_read_only(token)
    if state != "pending":
        code = {
            "expired": "expired",
            "accepted": "already_used",
            "revoked": "revoked",
        }.get(state, "invalid_token")
        raise RegistrationDomainError(
            _REGISTRATION_FAILURE_MESSAGES[code], code=code
        )

    requirements = evaluate_password_requirements(
        password,
        username=username,
        email=invitation.invited_email,
    )
    return {
        "valid": all(r["satisfied"] for r in requirements),
        "requirements": requirements,
        "accountExists": _existing_user_for_normalized_email(
            invitation.invited_email
        ),
    }


def preview_account_invitation(token):
    """Non-consuming preview of a registration token.

    Lets a person without an account confirm a token is valid and see the
    invited email, its expiry, and whether an account already exists, before
    registering. It does not authenticate, does not create or accept
    anything, and does not consume the invitation. Like every state-
    evaluating operation it persists the EXPIRED transition when it
    encounters an effectively-expired PENDING row.

    For an unknown token it raises ``RegistrationDomainError``
    (``invalid_token``). Otherwise it returns a dict:
    - effective PENDING:
      ``{status, usable: True, invitedEmail, expiresAt, accountExists}``;
    - any other resolvable state (expired / accepted / revoked):
      ``{status, usable: False}`` (the invited email is not disclosed for a
      terminal token).
    """
    with transaction.atomic():
        state, invitation, _ = _resolve_locked_invitation(token)
        if state == "missing":
            outcome = ("invalid_token", None)
        elif state == "pending":
            data = {
                "status": state,
                "usable": True,
                "invitedEmail": invitation.invited_email,
                "expiresAt": invitation.expires_at.isoformat(),
                "accountExists": _existing_user_for_normalized_email(
                    invitation.invited_email
                ),
            }
            outcome = ("ok", data)
        else:  # expired / accepted / revoked
            outcome = ("ok", {"status": state, "usable": False})

    if outcome[0] == "ok":
        return outcome[1]
    raise RegistrationDomainError(
        "This invitation token is invalid or unknown.", code="invalid_token"
    )
