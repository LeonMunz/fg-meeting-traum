"""Transport serializers for the Personal Notes HTTP API.

Personal Notes are a private capture space
(``docs/domain/personal-notes.md``). The serializers validate the
transport shape of requests and produce the canonical camelCase API
representation. They carry NO business rules and NO authorization:
ownership resolution and every mutation are delegated to
``personal_notes.services`` by the views.

The full note representation is EXACTLY:

    {
      "id": number,
      "title": string,
      "content": string,
      "pinned": boolean,
      "archivedAt": string | null,   # null = active
      "createdAt": string,
      "updatedAt": string
    }

No ``user`` / ``userId`` / ``owner`` or other ownership data is ever
exposed: the note belongs to the authenticated user by construction,
and the representation must not leak the owner identity.
"""

from rest_framework import serializers

from .models import PersonalNote


class PersonalNoteSerializer(serializers.ModelSerializer):
    """Canonical full Personal Note representation (camelCase)."""

    archivedAt = serializers.DateTimeField(
        source="archived_at", read_only=True
    )
    createdAt = serializers.DateTimeField(
        source="created_at", read_only=True
    )
    updatedAt = serializers.DateTimeField(
        source="updated_at", read_only=True
    )

    class Meta:
        model = PersonalNote
        fields = (
            "id",
            "title",
            "content",
            "pinned",
            "archivedAt",
            "createdAt",
            "updatedAt",
        )
        read_only_fields = fields


class PersonalNoteCreateSerializer(serializers.Serializer):
    """Request shape for POST /api/me/notes/.

    Both fields are optional (capture-first): an empty object is valid
    and creates a note with ``title = ""`` and ``content = ""``.
    ``title`` respects the model's max-length domain constraint.
    The owner is never part of this contract — it is always the
    authenticated user (enforced by the view, fail-closed).
    """

    title = serializers.CharField(
        max_length=255, allow_blank=True, required=False, default="",
    )
    content = serializers.CharField(
        allow_blank=True, required=False, default="",
    )


class PersonalNoteUpdateSerializer(serializers.Serializer):
    """Request shape for PATCH /api/me/notes/{note_id}/.

    Partial update: only the fields present in the payload are
    applied. A payload without ``title``/``content`` is a valid
    no-op (the service persists nothing and does not churn
    ``updated_at``). ``pinned`` and the archive/timestamp state are
    not part of this contract — they are changed only through their
    explicit action endpoints (rejected fail-closed by the view).
    """

    title = serializers.CharField(
        max_length=255, allow_blank=True, required=False,
    )
    content = serializers.CharField(
        allow_blank=True, required=False,
    )


class PersonalNotePinSerializer(serializers.Serializer):
    """Request shape for POST /api/me/notes/{note_id}/pin/.

    Exactly one required boolean: ``pinned``.
    """

    pinned = serializers.BooleanField()
