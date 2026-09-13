import uuid

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
