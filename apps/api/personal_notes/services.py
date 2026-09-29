"""Canonical Personal Notes domain service / query layer.

Personal Notes are a private capture space
(``docs/domain/personal-notes.md``). This module is the single
canonical boundary for every PersonalNote read and write:

- **Ownership is immutable.** The creator of a note is its owner. No
  operation here accepts or applies a change of ``user``/owner for an
  existing note.
- **Every operation that addresses an existing note is scoped by
  (note id, actor) in a single lookup** —
  ``filter(user=actor, pk=note_id)``. There is no unscoped
  ``get(pk=...)`` followed by a later ownership check.
- **One non-leaking "not found / inaccessible" outcome.** A nonexistent
  note and a note owned by another user both raise
  ``PersonalNoteNotFoundError``; callers cannot distinguish which
  condition occurred.
- **No authorization fallback.** ResearchGroup, Project, and Meeting
  memberships grant NOTHING for Personal Notes; only the note's own
  ``user`` may read or write it.
- **Idempotent state transitions.** ``archive_personal_note`` and
  ``restore_personal_note`` are safe to replay: the first call persists
  the transition (and updates ``updated_at``); a replay that finds the
  note already in the requested state changes nothing — including
  ``archived_at`` and ``updated_at``.
- Any persisted change to a note (title/content update, first archive,
  restore, pin state change) updates ``updated_at``; a no-op replay does
  not.
"""

from django.db.models import Q
from django.utils import timezone

from .models import PersonalNote


class PersonalNoteDomainError(Exception):
    """A Personal Notes domain invariant was violated."""

    def __init__(self, message):
        self.message = message
        super().__init__(message)


class PersonalNoteNotFoundError(PersonalNoteDomainError):
    """The note does not exist for the given actor.

    This is the SINGLE domain outcome for BOTH a nonexistent note id and
    a note owned by another user. It deliberately does not reveal which
    condition occurred; the later API layer maps it to a non-leaking
    404.
    """


def _get_note_for_actor(actor, note_id):
    """Owner-scoped lookup: resolve ``note_id`` for ``actor`` only.

    Returns the note, or raises ``PersonalNoteNotFoundError`` when the
    id is unknown OR the note belongs to another user (never
    distinguishable to the caller).
    """
    note = PersonalNote.objects.filter(user=actor, pk=note_id).first()
    if note is None:
        raise PersonalNoteNotFoundError("Personal note not found.")
    return note


# ── Create ────────────────────────────────────────────────────────


def create_personal_note(*, actor, title="", content=""):
    """Create one note owned by ``actor``.

    The owner is always the actor — it can never be supplied or
    spoofed. Capture-first: both ``title`` and ``content`` may be
    empty.
    """
    return PersonalNote.objects.create(
        user=actor,
        title=title or "",
        content=content or "",
    )


# ── Read ──────────────────────────────────────────────────────────


def get_personal_note(*, actor, note_id):
    """Retrieve one note for its owner (active or archived).

    Raises ``PersonalNoteNotFoundError`` for an unknown id or a foreign
    note (identical, non-leaking outcome).
    """
    return _get_note_for_actor(actor, note_id)


def list_active_notes(*, actor):
    """All of the actor's ACTIVE notes (``archived_at`` IS NULL).

    Canonical ordering: most recently updated first, tie-break by id
    (newer id first). Never contains another user's notes.
    """
    return list(
        PersonalNote.objects.filter(
            user=actor,
            archived_at__isnull=True,
        )
    )


def list_archived_notes(*, actor):
    """All of the actor's ARCHIVED notes (``archived_at`` NOT NULL).

    Same canonical ordering as ``list_active_notes``. Never contains
    another user's notes.
    """
    return list(
        PersonalNote.objects.filter(
            user=actor,
            archived_at__isnull=False,
        )
    )


def search_active_notes(*, actor, query):
    """Search the actor's ACTIVE notes for a case-insensitive substring.

    ``query`` is the transport-trimmed, non-empty search string. A note
    matches when the substring occurs in its ``title`` OR its
    ``content`` (case-insensitive; no tokenization, stemming, or
    ranking — V1 simple substring search).

    The predicate is applied on top of the SAME owner-scoped active
    base as ``list_active_notes`` (``user=actor`` AND
    ``archived_at IS NULL``) inside one query: archived notes and
    another user's notes are excluded by the query itself, and the
    canonical ordering (``updated_at`` desc, ``id`` desc tie-break —
    the model's ``Meta.ordering``) is preserved.
    """
    return list(
        PersonalNote.objects.filter(
            user=actor,
            archived_at__isnull=True,
        ).filter(
            Q(title__icontains=query) | Q(content__icontains=query),
        )
    )


# ── Update ────────────────────────────────────────────────────────


def update_personal_note(*, actor, note_id, title=None, content=None):
    """Update title and/or content of the actor's own note.

    Partial updates are supported: ``None`` leaves the field
    unchanged. A call with neither field persists nothing (the note is
    still resolved, so an unknown/foreign id raises). Ownership is NOT
    a parameter and is never touched.
    """
    note = _get_note_for_actor(actor, note_id)
    update_fields = []
    if title is not None:
        note.title = title
        update_fields.append("title")
    if content is not None:
        note.content = content
        update_fields.append("content")
    if update_fields:
        note.save(update_fields=update_fields + ["updated_at"])
    return note


def set_personal_note_pinned(*, actor, note_id, pinned):
    """Pin or unpin the actor's own note.

    Idempotent: setting the state the note already has persists
    nothing. Pinning does not change ownership, does not imply
    visibility, and does not create another entity.
    """
    note = _get_note_for_actor(actor, note_id)
    desired = bool(pinned)
    if note.pinned != desired:
        note.pinned = desired
        note.save(update_fields=["pinned", "updated_at"])
    return note


# ── Archive / restore ─────────────────────────────────────────────


def archive_personal_note(*, actor, note_id):
    """Archive the actor's own note.

    Sets ``archived_at`` (once) and retains title/content/pinned/
    ownership; the row is never deleted. Idempotent: archiving an
    already-archived note keeps the original ``archived_at`` and
    changes nothing else.
    """
    note = _get_note_for_actor(actor, note_id)
    if note.archived_at is None:
        note.archived_at = timezone.now()
        note.save(update_fields=["archived_at", "updated_at"])
    return note


def restore_personal_note(*, actor, note_id):
    """Restore the actor's own archived note.

    Clears ``archived_at`` on the SAME row (the note keeps its id,
    title, content, pinned state, and ownership) and makes it active
    again. Idempotent: restoring an already-active note changes
    nothing.
    """
    note = _get_note_for_actor(actor, note_id)
    if note.archived_at is not None:
        note.archived_at = None
        note.save(update_fields=["archived_at", "updated_at"])
    return note


# ── Permanent delete ──────────────────────────────────────────────


def delete_personal_note(*, actor, note_id):
    """Permanently delete the actor's own note.

    Resolves through the SAME owner-scoped lookup as every other
    existing-note operation (``filter(user=actor, pk=note_id)``):
    only the owner can delete, and an unknown id and a foreign id
    produce the SAME non-leaking ``PersonalNoteNotFoundError``.

    The row is PHYSICALLY removed — there is no ``deleted_at``
    tombstone, no Trash state, and no recovery after success. Both
    active and archived notes may be deleted; Archive remains the
    separate, reversible lifecycle. Deleting an already-deleted note
    follows the ordinary not-found contract.
    """
    note = _get_note_for_actor(actor, note_id)
    note.delete()
