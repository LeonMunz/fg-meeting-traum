import uuid
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Custom user model for FG Workspace.

    Extends Django's AbstractUser with no additional fields.
    The swap is done early so future models can safely reference
    settings.AUTH_USER_MODEL instead of auth.User.
    """

    class Meta:
        db_table = "accounts_user"
        verbose_name = "user"
        verbose_name_plural = "users"


class UserSession(models.Model):
    """Server-side registry of authenticated browser sessions.

    The registry is metadata only: it attributes an authenticated session to
    its User so sessions can be listed and revoked. It never grants
    authentication — the Django session row remains the credential.

    ``session_key`` is the raw Django session identifier (the
    ``django_session`` primary key). It is stored server-side only and is
    never serialized to the client. ``public_id`` is the non-secret API
    identifier exposed by the session-management endpoints.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sessions",
    )
    session_key = models.CharField(max_length=40, unique=True)
    public_id = models.UUIDField(default=uuid.uuid4, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "accounts_usersession"

    def __str__(self):
        return f"UserSession(user={self.user_id}, id={self.public_id})"


class AccountInvitation(models.Model):
    """A time-bounded, single-use credential bootstrap artifact.

    An account invitation targets a **global FG Workspace account** (the
    normalized invited email), never a ResearchGroup or Project. Creating,
    revoking, or accepting an invitation grants no ResearchGroup or Project
    membership and no access to application resources; possession of the
    token is only ever checked by the acceptance service.

    Token security: only a one-way SHA-256 digest (``token_digest``) is
    persisted. The raw token exists solely in the return value of the
    creation service call / its one-time API response and never in the
    database, model string form, any list serialization, or logs.

    Lifecycle (transitions are centralized in ``invitation_services``):
    ``PENDING -> ACCEPTED | REVOKED | EXPIRED``; terminal states never
    reactivate. A PENDING row past ``expires_at`` is *effectively expired*
    and behaves as EXPIRED everywhere; operations that evaluate state
    persist the EXPIRED transition.

    At most one PENDING row may exist per normalized invited email
    (partial unique index); creating a new invitation atomically
    transitions the effective pending row to REVOKED (system replacement)
    or an already-expired row to EXPIRED before inserting the new row.
    """

    class Status(models.TextChoices):
        PENDING = "pending"
        ACCEPTED = "accepted"
        REVOKED = "revoked"
        EXPIRED = "expired"

    # Exact invitation lifetime: 7 days from creation.
    LIFETIME = timedelta(days=7)

    public_id = models.UUIDField(default=uuid.uuid4, unique=True)
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sent_account_invitations",
    )
    invited_email = models.CharField(max_length=254)
    token_digest = models.CharField(max_length=64, unique=True)
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.PENDING
    )
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="accepted_account_invitations",
    )
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "accounts_accountinvitation"
        constraints = [
            models.UniqueConstraint(
                fields=["invited_email"],
                # status value of Status.PENDING; the nested TextChoices
                # name is not resolvable inside this Meta on Python 3.14.
                condition=models.Q(status="pending"),
                name="uniq_account_invitation_pending_email",
            )
        ]

    def __str__(self):
        return (
            f"AccountInvitation(id={self.public_id}, "
            f"email={self.invited_email}, status={self.status})"
        )
