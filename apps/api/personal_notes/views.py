"""Authenticated HTTP layer for the Personal Notes core lifecycle.

Personal Notes are a private capture space
(``docs/domain/personal-notes.md``). This module is the HTTP layer
ONLY — it authenticates, validates the transport shape, and maps the
canonical domain outcomes of ``personal_notes.services`` to HTTP:

- Every endpoint requires authentication (``IsAuthenticated``);
  anonymous requests get the repository's canonical 401
  (``WWW-Authenticate: Session``).
- The owner is ALWAYS ``request.user`` — never a client-supplied id.
  Client ownership fields are rejected fail-closed instead of being
  silently ignored.
- Note ownership resolution and every mutation delegate to the
  canonical services. This module never queries ``PersonalNote``
  directly and performs no authorization logic of its own.
- ``PersonalNoteNotFoundError`` is the single non-leaking domain
  outcome for BOTH an unknown note id and a foreign note id; it maps
  to one non-leaking 404 with the identical body in every case.
- Mutating endpoints follow the repository's canonical
  browser-mutation CSRF behavior: DRF ``SessionAuthentication``
  enforces CSRF for authenticated unsafe requests
  (``docs/domain/authentication-sessions.md`` §7).
"""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .serializers import (
    PersonalNoteCreateSerializer,
    PersonalNotePinSerializer,
    PersonalNoteSerializer,
    PersonalNoteUpdateSerializer,
)
from .services import (
    PersonalNoteNotFoundError,
    archive_personal_note,
    create_personal_note,
    get_personal_note,
    list_active_notes,
    list_archived_notes,
    restore_personal_note,
    set_personal_note_pinned,
    update_personal_note,
)

# Client-supplied ownership / identity fields. Ownership is always
# ``request.user``; supplying any of these is rejected fail-closed
# (mirrors the "Cannot directly change ... creator" convention).
_OWNERSHIP_FIELDS = (
    "user",
    "userId",
    "user_id",
    "owner",
    "ownerId",
    "owner_id",
)

# Fields that exist in the representation but are never directly
# mutable: pin state and archive state have explicit action
# endpoints; ``id`` / ``createdAt`` / ``updatedAt`` are system state.
_DIRECT_MUTATION_FIELDS = (
    "id",
    "pinned",
    "archivedAt",
    "archived_at",
    "createdAt",
    "created_at",
    "updatedAt",
    "updated_at",
)


def _note_not_found_response():
    """The ONE non-leaking 404 for an unknown OR foreign note id."""
    return Response({"error": "Personal note not found."}, status=404)


def _ownership_supplied(request):
    return any(field in request.data for field in _OWNERSHIP_FIELDS)


class PersonalNoteListCreateView(APIView):
    """GET/POST /api/me/notes/

    GET: the current user's ACTIVE notes, in canonical service order
    (most recently updated first, id tie-break). Never contains
    another user's notes.

    POST: create one note owned by the current user. Both ``title``
    and ``content`` are optional (capture-first); an empty object is
    valid. The owner is always the authenticated user — client
    ownership fields are rejected fail-closed.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        notes = list_active_notes(actor=request.user)
        return Response(PersonalNoteSerializer(notes, many=True).data)

    def post(self, request):
        if _ownership_supplied(request):
            return Response(
                {"error": "Cannot supply the owner of a Personal Note."},
                status=400,
            )

        serializer = PersonalNoteCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        note = create_personal_note(
            actor=request.user,
            title=serializer.validated_data["title"],
            content=serializer.validated_data["content"],
        )
        return Response(PersonalNoteSerializer(note).data, status=201)


class PersonalNoteArchiveListView(APIView):
    """GET /api/me/notes/archive/

    The current user's ARCHIVED notes, in the same canonical service
    order as the active listing.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        notes = list_archived_notes(actor=request.user)
        return Response(PersonalNoteSerializer(notes, many=True).data)


class PersonalNoteDetailView(APIView):
    """GET/PATCH /api/me/notes/{note_id}/

    GET: one of the current user's notes (active or archived). A
    foreign note id and a nonexistent note id both yield the same
    non-leaking 404.

    PATCH: partial update of ``title`` and/or ``content`` only.
    Ownership, pin state, archive state, and system timestamps are
    never directly mutable (rejected fail-closed); pin and archive
    lifecycle use their explicit action endpoints.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, note_id):
        try:
            note = get_personal_note(actor=request.user, note_id=note_id)
        except PersonalNoteNotFoundError:
            return _note_not_found_response()
        return Response(PersonalNoteSerializer(note).data)

    def patch(self, request, note_id):
        # Ownership resolution BEFORE payload validation: a foreign
        # or unknown id always answers with the same 404, regardless
        # of the payload.
        try:
            get_personal_note(actor=request.user, note_id=note_id)
        except PersonalNoteNotFoundError:
            return _note_not_found_response()

        if _ownership_supplied(request):
            return Response(
                {"error": "Cannot supply the owner of a Personal Note."},
                status=400,
            )
        if any(
            field in request.data for field in _DIRECT_MUTATION_FIELDS
        ):
            return Response(
                {
                    "error": (
                        "Cannot directly change the pin state, archive "
                        "state, or timestamps of a Personal Note."
                    )
                },
                status=400,
            )

        serializer = PersonalNoteUpdateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        try:
            note = update_personal_note(
                actor=request.user,
                note_id=note_id,
                title=serializer.validated_data.get("title"),
                content=serializer.validated_data.get("content"),
            )
        except PersonalNoteNotFoundError:
            return _note_not_found_response()
        return Response(PersonalNoteSerializer(note).data)


class PersonalNotePinView(APIView):
    """POST /api/me/notes/{note_id}/pin/

    Body: ``{"pinned": true | false}`` (exactly one required
    boolean). Delegates to the canonical idempotent pin service; a
    replay of the already-current state persists nothing (no
    ``updated_at`` churn).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, note_id):
        try:
            get_personal_note(actor=request.user, note_id=note_id)
        except PersonalNoteNotFoundError:
            return _note_not_found_response()

        serializer = PersonalNotePinSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)

        try:
            note = set_personal_note_pinned(
                actor=request.user,
                note_id=note_id,
                pinned=serializer.validated_data["pinned"],
            )
        except PersonalNoteNotFoundError:
            return _note_not_found_response()
        return Response(PersonalNoteSerializer(note).data)


class PersonalNoteArchiveView(APIView):
    """POST /api/me/notes/{note_id}/archive/

    Delegates directly to the canonical idempotent archive service.
    Archiving never deletes the row.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, note_id):
        try:
            note = archive_personal_note(
                actor=request.user, note_id=note_id
            )
        except PersonalNoteNotFoundError:
            return _note_not_found_response()
        return Response(PersonalNoteSerializer(note).data)


class PersonalNoteRestoreView(APIView):
    """POST /api/me/notes/{note_id}/restore/

    Delegates directly to the canonical idempotent restore service:
    clears ``archived_at`` on the SAME row (the note keeps its id).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, note_id):
        try:
            note = restore_personal_note(
                actor=request.user, note_id=note_id
            )
        except PersonalNoteNotFoundError:
            return _note_not_found_response()
        return Response(PersonalNoteSerializer(note).data)
