from django.conf import settings
from django.db import models


class PersonalNote(models.Model):
    """A single private personal note belonging to exactly one user.

    Personal Notes are a private capture space (``docs/domain/personal-notes.md``).
    A note is personal state, NOT project work:

    - A PersonalNote belongs to exactly one user (its ``user``), and that
      user is its owner. Ownership is IMMUTABLE: no domain operation
      reassigns ``user`` after creation.
    - A PersonalNote is readable and writable ONLY by its owner. There is no
      ResearchGroup/Project/Meeting fallback, and no membership of any kind
      grants access to another user's notes.
    - A PersonalNote is NOT a Work Item: it has no Project, no type/status
      definitions, no assignee, and no board position.
    - ``title`` and ``content`` are both optional at creation
      (capture-first): a note may exist with an empty title and/or empty
      content.
    - ``archived_at`` is the single archive state: NULL = active, NOT NULL
      = archived (the moment it was archived). Archiving never deletes the
      row; restoring clears ``archived_at`` on the same row.
    - ``pinned`` is lightweight personal state: it does not change
      ownership, does not imply visibility to anyone else, and does not
      create another entity.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="personal_notes",
    )
    title = models.CharField(max_length=255, default="", blank=True)
    content = models.TextField(default="", blank=True)
    pinned = models.BooleanField(default=False)
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "personal_notes_personal_note"
        verbose_name = "personal note"
        verbose_name_plural = "personal notes"
        # Deterministic domain ordering for owner-scoped reads:
        # most recently updated first, tie-break by id (newer id first).
        ordering = ["-updated_at", "-id"]
        indexes = [
            # Owner-scoped recent/archive reads never require a global
            # unscoped scan: (user, archive state, recency, id) covers the
            # active listing (archived_at IS NULL) and the archived listing
            # (archived_at IS NOT NULL) in the canonical ordering.
            models.Index(
                fields=["user_id", "archived_at", "-updated_at", "-id"],
                name="pn_user_archive_idx",
            ),
        ]

    def __str__(self):
        return self.title or f"Untitled personal note ({self.pk})"
