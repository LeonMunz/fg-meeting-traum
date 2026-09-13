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

Canonical email normalization (shared by invitation storage and
acceptance matching): trim surrounding whitespace, then lowercase
(case-insensitive comparison).

Concurrency: at most one PENDING row per normalized email is enforced by a
partial unique index (``uniq_account_invitation_pending_email``). Creation
replaces the existing effective pending row atomically and retries
narrowly around the empty-row insert race; acceptance locks the invitation
row so at most one concurrent acceptance succeeds.
"""

import hashlib
import secrets
from datetime import timedelta

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import AccountInvitation

INVITATION_LIFETIME = timedelta(days=7)

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


def accept_account_invitation(*, actor, token):
    """Bind the invitation for ``token`` to the authenticated actor.

    Existing-account acceptance: the actor is the already-authenticated
    current user (never a client-supplied identity) and must have a
    normalized email equal to the invitation's invited email. No User is
    created and no ResearchGroup or Project membership is created.

    The future registration flow must create/authenticate a matching
    account and then call this same service — token and lifecycle logic
    must not be duplicated there.

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

    raw_token = str(token or "").strip()
    if not raw_token:
        raise AccountInvitationDomainError(
            "An invitation token is required.", code="not_found"
        )

    # The transaction commits on every outcome (failures are outcomes, not
    # exceptions inside the block) so the persisted EXPIRED transition —
    # made by this state-evaluating operation — survives.
    with transaction.atomic():
        invitation = (
            AccountInvitation.objects.select_for_update()
            .filter(token_digest=digest_invitation_token(raw_token))
            .first()
        )
        if invitation is None:
            outcome = ("not_found", None)
        elif invitation.status in (
            AccountInvitation.Status.ACCEPTED,
            AccountInvitation.Status.REVOKED,
        ):
            # Terminal: same non-disclosing failure as an unknown token.
            outcome = ("not_found", None)
        elif invitation.status == AccountInvitation.Status.PENDING:
            now = timezone.now()
            if invitation.expires_at <= now:
                invitation.status = AccountInvitation.Status.EXPIRED
                invitation.save(update_fields=["status"])
                outcome = ("expired", None)
            elif (
                normalize_invitation_email(getattr(actor, "email", ""))
                != invitation.invited_email
            ):
                outcome = ("email_mismatch", None)
            else:
                invitation.status = AccountInvitation.Status.ACCEPTED
                invitation.accepted_at = now
                invitation.accepted_by = actor
                invitation.save(
                    update_fields=["status", "accepted_at", "accepted_by"]
                )
                outcome = ("accepted", invitation)
        else:  # pragma: no cover - defensive; status is a closed set
            outcome = ("not_found", None)

    if outcome[0] == "accepted":
        return outcome[1]
    messages = {
        "not_found": "Invitation not found.",
        "expired": "This invitation has expired.",
        "email_mismatch": "This invitation is for a different e-mail address.",
    }
    raise AccountInvitationDomainError(messages[outcome[0]], code=outcome[0])
