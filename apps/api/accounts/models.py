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
