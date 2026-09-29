"""Personal Notes API tests — authenticated /api/me/notes/ core lifecycle.

Canonical reference: ``docs/domain/personal-notes.md``.

Covers the slice contract:
- authentication: every endpoint rejects anonymous requests with the
  repository's canonical 401 (``WWW-Authenticate: Session``)
- create: empty-object create, title/content round-trip, owner is
  always ``request.user`` (client ownership fields rejected
  fail-closed), title max-length enforced without creating a row
- lists: active and archived listings contain only the current
  user's notes in the canonical service ordering (updated_at desc,
  id desc tie-break)
- search: ``?q=`` on the active listing — owner-scoped,
  case-insensitive substring over title OR content (trimmed empty
  query = ordinary active list, canonical ordering retained, archived
  / foreign notes never match, no separate search route)
- detail: owner reads active and archived notes; a foreign note id
  and a nonexistent note id produce the identical non-leaking 404
- update: partial title/content updates only; owner, pin state,
  archive state, and system timestamps are never directly mutable;
  empty PATCH is a no-op without timestamp churn
- pin: boolean payload contract, idempotent replay without
  timestamp churn, non-leaking 404
- archive/restore: list partitioning, same-id identity, idempotent
  replays, non-leaking 404
- delete: permanent owner-only row removal — 204 with no body, the
  row is physically gone, active/archived listings reflect it
  immediately, foreign/unknown ids answer with the identical
  non-leaking 404
- privacy: ResearchGroup / Project membership grants no access
  through any endpoint; the representation exposes no owner/user
  identifier
- CSRF: authenticated mutations follow the repository's canonical
  browser-mutation CSRF contract (DRF ``SessionAuthentication``
  enforcement) — rejected without a token, honored with one
- contract: exact representation shape and nullability, status
  codes, and no deferred endpoints (separate search / daily /
  relations routes — DELETE on the detail resource IS part of the
  contract)
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from personal_notes.models import PersonalNote
from personal_notes.services import (
    archive_personal_note,
    create_personal_note,
    restore_personal_note,
)
from projects.models import ProjectMembership
from projects.services import add_project_membership, create_project
from research_groups.models import ResearchGroup, ResearchGroupMembership

User = get_user_model()

SEED_PASSWORD = "DevPass1!"

# The EXACT canonical note representation key set (camelCase).
NOTE_REPRESENTATION_KEYS = {
    "id",
    "title",
    "content",
    "pinned",
    "archivedAt",
    "createdAt",
    "updatedAt",
}


# ── Helpers ──


def _backdate_updated_at(note, moment):
    """Set an explicit updated_at (queryset update bypasses auto_now)."""
    PersonalNote.objects.filter(pk=note.pk).update(updated_at=moment)
    note.refresh_from_db()


class _AuthMixin:
    """Mixin with login helper for APIClient-based tests (repository
    convention: real session login + CSRF token for mutations)."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def _login(self, username, password=SEED_PASSWORD):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        response = self.client.post(
            "/api/auth/login/",
            data={"username": username, "password": password},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        assert response.status_code == 200, (
            f"login failed for {username}: {response.status_code}"
        )

    def _csrf(self):
        self.client.get("/api/auth/csrf/")
        cookie = self.client.cookies.get("csrftoken")
        return cookie.value if cookie else ""

    def _post(self, url, data):
        csrf = self._csrf()
        return self.client.post(
            url,
            data=data,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

    def _patch(self, url, data):
        csrf = self._csrf()
        return self.client.patch(
            url,
            data=data,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

    def _delete(self, url):
        csrf = self._csrf()
        return self.client.delete(
            url,
            HTTP_X_CSRFTOKEN=csrf,
        )


# ── Authentication ──


class PersonalNoteAuthTest(APITestCase):
    """Every Personal Notes endpoint requires authentication."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.alice = User.objects.create_user(
            username="pn_auth_alice", password=SEED_PASSWORD
        )
        self.note = create_personal_note(actor=self.alice, title="hidden")

    def test_anonymous_active_list_rejected(self):
        response = self.client.get("/api/me/notes/")
        self.assertEqual(response.status_code, 401)

    def test_anonymous_create_rejected(self):
        response = self.client.post(
            "/api/me/notes/", data={"title": "x"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)

    def test_anonymous_detail_and_mutation_requests_rejected(self):
        base = f"/api/me/notes/{self.note.pk}/"
        self.assertEqual(
            self.client.get(base).status_code, 401,
        )
        self.assertEqual(
            self.client.patch(
                base, data={"title": "x"}, content_type="application/json",
            ).status_code,
            401,
        )
        self.assertEqual(
            self.client.post(
                f"{base}pin/", data={"pinned": True},
                content_type="application/json",
            ).status_code,
            401,
        )
        self.assertEqual(
            self.client.post(
                f"{base}archive/", data={}, content_type="application/json",
            ).status_code,
            401,
        )
        self.assertEqual(
            self.client.post(
                f"{base}restore/", data={}, content_type="application/json",
            ).status_code,
            401,
        )
        self.assertEqual(
            self.client.delete(base).status_code,
            401,
        )

    def test_anonymous_response_is_canonical_401(self):
        """The repository's canonical unauthenticated response: 401 +
        WWW-Authenticate (FGSessionAuthentication.authenticate_header)."""
        response = self.client.get("/api/me/notes/")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.headers.get("WWW-Authenticate"), "Session",
        )


# ── Create ──


class PersonalNoteCreateTest(_AuthMixin, APITestCase):
    """POST /api/me/notes/."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_create_alice", password=SEED_PASSWORD,
        )
        cls.bob = User.objects.create_user(
            username="pn_create_bob", password=SEED_PASSWORD,
        )

    def test_empty_post_creates_owned_empty_note(self):
        self._login("pn_create_alice")
        response = self._post("/api/me/notes/", {})
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["title"], "")
        self.assertEqual(body["content"], "")
        self.assertFalse(body["pinned"])
        self.assertIsNone(body["archivedAt"])

        self.assertEqual(PersonalNote.objects.count(), 1)
        note = PersonalNote.objects.get()
        self.assertEqual(note.user_id, self.alice.pk)
        self.assertEqual(note.title, "")
        self.assertEqual(note.content, "")

    def test_title_content_round_trip(self):
        self._login("pn_create_alice")
        response = self._post(
            "/api/me/notes/",
            {"title": "Ideas", "content": "Draft text."},
        )
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["title"], "Ideas")
        self.assertEqual(body["content"], "Draft text.")

        detail = self.client.get(f"/api/me/notes/{body['id']}/")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json(), body)

    def test_owner_is_request_user_and_cannot_be_spoofed(self):
        self._login("pn_create_alice")
        for field in ("userId", "user", "user_id", "owner", "ownerId",
                      "owner_id"):
            response = self._post(
                "/api/me/notes/",
                {"title": "spoof", field: self.bob.pk},
            )
            self.assertEqual(response.status_code, 400, field)
        # Rejected fail-closed: nothing was created, no ownership
        # contract was honored.
        self.assertEqual(PersonalNote.objects.count(), 0)

        # The plain create is owned by the authenticated user.
        response = self._post("/api/me/notes/", {"title": "mine"})
        self.assertEqual(response.status_code, 201)
        note = PersonalNote.objects.get(pk=response.json()["id"])
        self.assertEqual(note.user_id, self.alice.pk)
        self.assertNotEqual(note.user_id, self.bob.pk)

    def test_invalid_title_length_rejected_no_row_created(self):
        self._login("pn_create_alice")
        response = self._post(
            "/api/me/notes/", {"title": "x" * 256},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("title", response.json())
        self.assertEqual(PersonalNote.objects.count(), 0)

        # The model constraint boundary (255) is accepted.
        response = self._post("/api/me/notes/", {"title": "x" * 255})
        self.assertEqual(response.status_code, 201)

    def test_null_and_boolean_title_rejected(self):
        self._login("pn_create_alice")
        # Repository serializer convention (DRF CharField): null and
        # boolean values are invalid transport for the title.
        for value in (None, True):
            response = self._post("/api/me/notes/", {"title": value})
            self.assertEqual(
                response.status_code, 400, f"title={value!r}",
            )
        self.assertEqual(PersonalNote.objects.count(), 0)


# ── Lists ──


class PersonalNoteListTest(_AuthMixin, APITestCase):
    """GET /api/me/notes/ and GET /api/me/notes/archive/."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_list_alice", password=SEED_PASSWORD,
        )
        cls.bob = User.objects.create_user(
            username="pn_list_bob", password=SEED_PASSWORD,
        )

        cls.alice_active_1 = create_personal_note(
            actor=cls.alice, title="a1",
        )
        cls.alice_active_2 = create_personal_note(
            actor=cls.alice, title="a2",
        )
        cls.alice_archived = create_personal_note(
            actor=cls.alice, title="a3",
        )
        archive_personal_note(
            actor=cls.alice, note_id=cls.alice_archived.pk,
        )

        cls.bob_active = create_personal_note(
            actor=cls.bob, title="b1",
        )
        cls.bob_archived = create_personal_note(
            actor=cls.bob, title="b2",
        )
        archive_personal_note(
            actor=cls.bob, note_id=cls.bob_archived.pk,
        )

    def test_active_list_returns_only_current_users_active_notes(self):
        self._login("pn_list_alice")
        response = self.client.get("/api/me/notes/")
        self.assertEqual(response.status_code, 200)
        ids = {note["id"] for note in response.json()}
        self.assertEqual(
            ids,
            {self.alice_active_1.pk, self.alice_active_2.pk},
        )

    def test_archived_list_returns_only_current_users_archived_notes(self):
        self._login("pn_list_alice")
        response = self.client.get("/api/me/notes/archive/")
        self.assertEqual(response.status_code, 200)
        ids = {note["id"] for note in response.json()}
        self.assertEqual(ids, {self.alice_archived.pk})

    def test_foreign_notes_never_appear(self):
        self._login("pn_list_bob")
        active = self.client.get("/api/me/notes/")
        archived = self.client.get("/api/me/notes/archive/")
        seen = {
            note["id"]
            for response in (active, archived)
            for note in response.json()
        }
        self.assertEqual(
            seen,
            {self.bob_active.pk, self.bob_archived.pk},
        )
        for alice_id in (
            self.alice_active_1.pk,
            self.alice_active_2.pk,
            self.alice_archived.pk,
        ):
            self.assertNotIn(alice_id, seen)

    def test_canonical_ordering_is_preserved(self):
        # Explicit recency: a2 newer than a1; plus a same-moment tie
        # that must be broken by id (higher id first).
        now = timezone.now()
        tie_a = create_personal_note(actor=self.alice, title="tie-a")
        tie_b = create_personal_note(actor=self.alice, title="tie-b")
        _backdate_updated_at(self.alice_active_1, now - timedelta(hours=3))
        _backdate_updated_at(self.alice_active_2, now - timedelta(hours=2))
        _backdate_updated_at(tie_a, now - timedelta(hours=1))
        _backdate_updated_at(tie_b, now - timedelta(hours=1))
        self.assertGreater(tie_b.pk, tie_a.pk)

        self._login("pn_list_alice")
        response = self.client.get("/api/me/notes/")
        self.assertEqual(response.status_code, 200)
        order = [note["id"] for note in response.json()]
        self.assertEqual(
            order,
            [tie_b.pk, tie_a.pk, self.alice_active_2.pk,
             self.alice_active_1.pk],
        )

        # Archived listing keeps the same canonical ordering.
        response = self.client.get("/api/me/notes/archive/")
        self.assertEqual(
            [note["id"] for note in response.json()],
            [self.alice_archived.pk],
        )


class PersonalNoteSearchTest(_AuthMixin, APITestCase):
    """GET /api/me/notes/?q= — owner-scoped V1 substring search over
    the current user's ACTIVE notes (title OR content,
    case-insensitive)."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_search_alice", password=SEED_PASSWORD,
        )
        cls.bob = User.objects.create_user(
            username="pn_search_bob", password=SEED_PASSWORD,
        )

        # Alice's ACTIVE notes.
        cls.alice_title = create_personal_note(
            actor=cls.alice, title="Quantum flux notes",
        )
        cls.alice_content = create_personal_note(
            actor=cls.alice,
            title="Plain title", content="observed the QUANTUM drift",
        )
        cls.alice_both = create_personal_note(
            actor=cls.alice,
            title="QUANTUM summary", content="quantum recap",
        )
        cls.alice_none = create_personal_note(
            actor=cls.alice, title="Unrelated", content="nothing here",
        )
        # Alice's ARCHIVED note that matches the search term.
        cls.alice_archived = create_personal_note(
            actor=cls.alice, title="Quantum archived",
        )
        archive_personal_note(
            actor=cls.alice, note_id=cls.alice_archived.pk,
        )
        # Bob's matching notes (active + archived).
        cls.bob_active = create_personal_note(
            actor=cls.bob, title="Quantum bob active",
        )
        cls.bob_archived = create_personal_note(
            actor=cls.bob, title="Quantum bob archived",
        )
        archive_personal_note(
            actor=cls.bob, note_id=cls.bob_archived.pk,
        )

    def _search_ids(self, q):
        response = self.client.get("/api/me/notes/", {"q": q})
        self.assertEqual(response.status_code, 200)
        return [note["id"] for note in response.json()]

    # ── Core search ──

    def test_without_q_returns_unchanged_active_list(self):
        self._login("pn_search_alice")
        response = self.client.get("/api/me/notes/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            {note["id"] for note in response.json()},
            {
                self.alice_title.pk,
                self.alice_content.pk,
                self.alice_both.pk,
                self.alice_none.pk,
            },
        )

    def test_title_substring_matches(self):
        self._login("pn_search_alice")
        self.assertEqual(
            set(self._search_ids("flux")),
            {self.alice_title.pk},
        )
        self.assertEqual(
            set(self._search_ids("uant")),
            {
                self.alice_title.pk,
                self.alice_content.pk,
                self.alice_both.pk,
            },
        )

    def test_content_substring_matches(self):
        self._login("pn_search_alice")
        self.assertEqual(
            set(self._search_ids("drift")),
            {self.alice_content.pk},
        )
        self.assertEqual(
            set(self._search_ids("recap")),
            {self.alice_both.pk},
        )

    def test_matching_is_case_insensitive(self):
        self._login("pn_search_alice")
        self.assertEqual(
            self._search_ids("QUANTUM"),
            self._search_ids("quantum"),
        )
        self.assertEqual(
            set(self._search_ids("quAnTuM")),
            {
                self.alice_title.pk,
                self.alice_content.pk,
                self.alice_both.pk,
            },
        )
        self.assertEqual(
            set(self._search_ids("FLUX NOTES")),
            {self.alice_title.pk},
        )

    def test_query_whitespace_is_trimmed(self):
        self._login("pn_search_alice")
        self.assertEqual(
            self._search_ids("  quantum  "),
            self._search_ids("quantum"),
        )

    def test_empty_q_behaves_like_ordinary_active_list(self):
        self._login("pn_search_alice")
        empty_q = self.client.get("/api/me/notes/?q=")
        plain = self.client.get("/api/me/notes/")
        self.assertEqual(empty_q.status_code, 200)
        self.assertEqual(empty_q.json(), plain.json())
        self.assertEqual(
            {note["id"] for note in plain.json()},
            {
                self.alice_title.pk,
                self.alice_content.pk,
                self.alice_both.pk,
                self.alice_none.pk,
            },
        )

    def test_whitespace_only_q_behaves_like_ordinary_active_list(self):
        self._login("pn_search_alice")
        blank_q = self.client.get("/api/me/notes/", {"q": " \t "})
        plain = self.client.get("/api/me/notes/")
        self.assertEqual(blank_q.status_code, 200)
        self.assertEqual(blank_q.json(), plain.json())

    def test_non_matching_q_returns_empty_list(self):
        self._login("pn_search_alice")
        response = self.client.get(
            "/api/me/notes/", {"q": "zzz-not-there"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_note_matching_both_fields_appears_only_once(self):
        self._login("pn_search_alice")
        ids = self._search_ids("quantum")
        self.assertEqual(ids.count(self.alice_both.pk), 1)
        self.assertEqual(len(ids), len(set(ids)))

    def test_search_preserves_canonical_ordering(self):
        # Explicit recency + a same-moment tie broken by id (higher
        # id first).
        now = timezone.now()
        tie_a = create_personal_note(
            actor=self.alice, content="quantum tie a",
        )
        tie_b = create_personal_note(
            actor=self.alice, content="quantum tie b",
        )
        _backdate_updated_at(self.alice_title, now - timedelta(hours=3))
        _backdate_updated_at(self.alice_both, now - timedelta(hours=2))
        _backdate_updated_at(self.alice_content, now - timedelta(hours=1))
        _backdate_updated_at(tie_a, now - timedelta(minutes=90))
        _backdate_updated_at(tie_b, now - timedelta(minutes=90))
        _backdate_updated_at(self.alice_none, now - timedelta(hours=5))
        self.assertGreater(tie_b.pk, tie_a.pk)

        self._login("pn_search_alice")
        ids = self._search_ids("quantum")
        self.assertEqual(
            ids,
            [
                self.alice_content.pk,  # most recently updated
                tie_b.pk,               # tie: higher id first
                tie_a.pk,
                self.alice_both.pk,
                self.alice_title.pk,
            ],
        )

    # ── Privacy / lifecycle ──

    def test_foreign_matching_notes_never_appear(self):
        self._login("pn_search_alice")
        ids = self._search_ids("quantum")
        self.assertNotIn(self.bob_active.pk, ids)
        self.assertNotIn(self.bob_archived.pk, ids)

    def test_search_returns_only_the_requesting_users_notes(self):
        self._login("pn_search_bob")
        self.assertEqual(
            self._search_ids("quantum"),
            [self.bob_active.pk],
        )

    def test_archived_matching_notes_never_appear(self):
        self._login("pn_search_alice")
        self.assertNotIn(
            self.alice_archived.pk, self._search_ids("quantum"),
        )

    def test_anonymous_search_rejected(self):
        response = self.client.get("/api/me/notes/", {"q": "quantum"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.headers.get("WWW-Authenticate"), "Session",
        )

    # ── Contract ──

    def test_search_response_representation_unchanged(self):
        self._login("pn_search_alice")
        response = self.client.get("/api/me/notes/", {"q": "quantum"})
        self.assertEqual(response.status_code, 200)
        for note in response.json():
            self.assertEqual(set(note.keys()), NOTE_REPRESENTATION_KEYS)
            self.assertIsNone(note["archivedAt"])

    def test_archive_collection_does_not_gain_search(self):
        self._login("pn_search_alice")
        plain = self.client.get("/api/me/notes/archive/")
        with_q = self.client.get("/api/me/notes/archive/", {"q": "quantum"})
        self.assertEqual(with_q.status_code, 200)
        self.assertEqual(with_q.json(), plain.json())
        # The archived matching note is still listed: q is ignored
        # entirely on the archive collection.
        self.assertEqual(
            [note["id"] for note in plain.json()],
            [self.alice_archived.pk],
        )


class PersonalNoteSearchPrivacyTest(_AuthMixin, APITestCase):
    """ResearchGroup / Project membership never exposes another
    user's matching note through search."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_sp_alice", password=SEED_PASSWORD,
        )
        cls.bob = User.objects.create_user(
            username="pn_sp_bob", password=SEED_PASSWORD,
        )
        cls.group = ResearchGroup.objects.create(
            name="PN Search Privacy Group", created_by=cls.alice,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group, user=cls.alice,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group, user=cls.bob,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        cls.project = create_project(
            research_group=cls.group, creator=cls.alice,
            name="PN Search Privacy Project",
        )
        add_project_membership(
            project=cls.project, actor=cls.alice, target_user=cls.bob,
            role=ProjectMembership.Role.MEMBER,
        )
        cls.alice_note = create_personal_note(
            actor=cls.alice, title="secret", content="very private",
        )

    def test_membership_does_not_expose_foreign_matching_note(self):
        self._login("pn_sp_bob")
        for q in ("secret", "private", "very private"):
            response = self.client.get("/api/me/notes/", {"q": q})
            # No error, no count, no existence leak: a plain 200 with
            # the requesting user's own (here: empty) matching set.
            self.assertEqual(response.status_code, 200)
            self.assertNotIn(
                self.alice_note.pk,
                [note["id"] for note in response.json()],
            )


# ── Detail ──


class PersonalNoteDetailTest(_AuthMixin, APITestCase):
    """GET /api/me/notes/{note_id}/."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_detail_alice", password=SEED_PASSWORD,
        )
        cls.bob = User.objects.create_user(
            username="pn_detail_bob", password=SEED_PASSWORD,
        )
        cls.alice_active = create_personal_note(
            actor=cls.alice, title="active", content="c",
        )
        cls.alice_archived = create_personal_note(
            actor=cls.alice, title="archived", content="c",
        )
        archive_personal_note(
            actor=cls.alice, note_id=cls.alice_archived.pk,
        )
        cls.bob_note = create_personal_note(
            actor=cls.bob, title="bob's",
        )

    def test_owner_can_get_active_note(self):
        self._login("pn_detail_alice")
        response = self.client.get(
            f"/api/me/notes/{self.alice_active.pk}/",
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["id"], self.alice_active.pk)
        self.assertEqual(body["title"], "active")
        self.assertIsNone(body["archivedAt"])

    def test_owner_can_get_archived_note(self):
        self._login("pn_detail_alice")
        response = self.client.get(
            f"/api/me/notes/{self.alice_archived.pk}/",
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["id"], self.alice_archived.pk)
        self.assertIsNotNone(body["archivedAt"])

    def test_foreign_known_id_same_404_as_nonexistent_id(self):
        self._login("pn_detail_bob")
        foreign = self.client.get(
            f"/api/me/notes/{self.alice_active.pk}/",
        )
        missing = self.client.get("/api/me/notes/999999/")
        self.assertEqual(foreign.status_code, 404)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(foreign.json(), missing.json())
        self.assertEqual(foreign.json(), {"error": "Personal note not found."})


# ── Update ──


class PersonalNoteUpdateTest(_AuthMixin, APITestCase):
    """PATCH /api/me/notes/{note_id}/."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_update_alice", password=SEED_PASSWORD,
        )
        cls.bob = User.objects.create_user(
            username="pn_update_bob", password=SEED_PASSWORD,
        )
        cls.alice_note = create_personal_note(
            actor=cls.alice, title="old title", content="old content",
        )
        cls.bob_note = create_personal_note(
            actor=cls.bob, title="bob's",
        )

    def _patch_own_note(self, data):
        return self._patch(
            f"/api/me/notes/{self.alice_note.pk}/", data,
        )

    def test_title_only_patch(self):
        self._login("pn_update_alice")
        response = self._patch_own_note({"title": "new title"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], "new title")
        self.assertEqual(response.json()["content"], "old content")
        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.title, "new title")
        self.assertEqual(self.alice_note.content, "old content")

    def test_content_only_patch(self):
        self._login("pn_update_alice")
        response = self._patch_own_note({"content": "new content"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["content"], "new content")
        self.assertEqual(response.json()["title"], "old title")
        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.content, "new content")
        self.assertEqual(self.alice_note.title, "old title")

    def test_title_and_content_patch(self):
        self._login("pn_update_alice")
        response = self._patch_own_note(
            {"title": "t2", "content": "c2"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], "t2")
        self.assertEqual(response.json()["content"], "c2")

    def test_owner_cannot_be_changed_through_payload(self):
        self._login("pn_update_alice")
        for field in ("userId", "user", "user_id", "owner", "ownerId",
                      "owner_id"):
            response = self._patch_own_note({field: self.bob.pk})
            self.assertEqual(response.status_code, 400, field)
        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.user_id, self.alice.pk)

    def test_pinned_archive_and_system_timestamps_not_directly_mutable(self):
        self._login("pn_update_alice")
        original_updated_at = self.alice_note.updated_at
        attempts = [
            {"pinned": True},
            {"archivedAt": "2020-01-01T00:00:00Z"},
            {"archived_at": "2020-01-01T00:00:00Z"},
            {"createdAt": "2020-01-01T00:00:00Z"},
            {"created_at": "2020-01-01T00:00:00Z"},
            {"updatedAt": "2020-01-01T00:00:00Z"},
            {"updated_at": "2020-01-01T00:00:00Z"},
            {"id": self.bob_note.pk},
        ]
        for data in attempts:
            response = self._patch_own_note(data)
            self.assertEqual(
                response.status_code, 400,
                f"{list(data)[0]} must be rejected",
            )
        self.alice_note.refresh_from_db()
        self.assertFalse(self.alice_note.pinned)
        self.assertIsNone(self.alice_note.archived_at)
        self.assertEqual(
            self.alice_note.updated_at, original_updated_at,
        )

    def test_empty_patch_is_noop_without_timestamp_churn(self):
        self._login("pn_update_alice")
        stale = timezone.now() - timedelta(hours=3)
        _backdate_updated_at(self.alice_note, stale)

        response = self._patch_own_note({})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], "old title")

        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.updated_at, stale)

    def test_foreign_patch_same_404_as_nonexistent_patch(self):
        self._login("pn_update_bob")
        foreign = self._patch(
            f"/api/me/notes/{self.alice_note.pk}/", {"title": "hijack"},
        )
        missing = self._patch("/api/me/notes/999999/", {"title": "x"})
        self.assertEqual(foreign.status_code, 404)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(foreign.json(), missing.json())
        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.title, "old title")


# ── Pin ──


class PersonalNotePinTest(_AuthMixin, APITestCase):
    """POST /api/me/notes/{note_id}/pin/."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_pin_alice", password=SEED_PASSWORD,
        )
        cls.bob = User.objects.create_user(
            username="pn_pin_bob", password=SEED_PASSWORD,
        )
        cls.alice_note = create_personal_note(
            actor=cls.alice, title="pin me",
        )
        cls.bob_note = create_personal_note(
            actor=cls.bob, title="bob's",
        )

    def test_pin_and_unpin(self):
        self._login("pn_pin_alice")
        url = f"/api/me/notes/{self.alice_note.pk}/pin/"

        response = self._post(url, {"pinned": True})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["pinned"])
        self.alice_note.refresh_from_db()
        self.assertTrue(self.alice_note.pinned)

        response = self._post(url, {"pinned": False})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["pinned"])
        self.alice_note.refresh_from_db()
        self.assertFalse(self.alice_note.pinned)

    def test_pin_requires_exactly_a_boolean_payload(self):
        self._login("pn_pin_alice")
        url = f"/api/me/notes/{self.alice_note.pk}/pin/"
        for data in ({}, {"pinned": "not-a-boolean"}, {"other": True}):
            response = self._post(url, data)
            self.assertEqual(
                response.status_code, 400,
                f"payload {data!r} must be rejected",
            )
        self.alice_note.refresh_from_db()
        self.assertFalse(self.alice_note.pinned)

    def test_foreign_pin_same_404_as_nonexistent_pin(self):
        self._login("pn_pin_bob")
        foreign = self._post(
            f"/api/me/notes/{self.alice_note.pk}/pin/", {"pinned": True},
        )
        missing = self._post(
            "/api/me/notes/999999/pin/", {"pinned": True},
        )
        self.assertEqual(foreign.status_code, 404)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(foreign.json(), missing.json())
        self.alice_note.refresh_from_db()
        self.assertFalse(self.alice_note.pinned)

    def test_idempotent_replay_does_not_churn_timestamp(self):
        self._login("pn_pin_alice")
        stale = timezone.now() - timedelta(hours=3)
        _backdate_updated_at(self.alice_note, stale)

        # Replay the already-current state (pinned = False).
        response = self._post(
            f"/api/me/notes/{self.alice_note.pk}/pin/", {"pinned": False},
        )
        self.assertEqual(response.status_code, 200)
        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.updated_at, stale)

        # A real change persists (and updates updated_at); a replay of
        # the NEW state must not churn again.
        response = self._post(
            f"/api/me/notes/{self.alice_note.pk}/pin/", {"pinned": True},
        )
        self.assertEqual(response.status_code, 200)
        self.alice_note.refresh_from_db()
        self.assertTrue(self.alice_note.pinned)
        self.assertGreater(self.alice_note.updated_at, stale)
        changed = self.alice_note.updated_at

        response = self._post(
            f"/api/me/notes/{self.alice_note.pk}/pin/", {"pinned": True},
        )
        self.assertEqual(response.status_code, 200)
        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.updated_at, changed)


# ── Archive / restore ──


class PersonalNoteArchiveRestoreTest(_AuthMixin, APITestCase):
    """POST /api/me/notes/{note_id}/archive/ and .../restore/."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_arch_alice", password=SEED_PASSWORD,
        )
        cls.bob = User.objects.create_user(
            username="pn_arch_bob", password=SEED_PASSWORD,
        )
        cls.alice_note = create_personal_note(
            actor=cls.alice, title="archivable", content="keep me",
        )
        cls.bob_note = create_personal_note(
            actor=cls.bob, title="bob's",
        )

    def test_archive_moves_note_between_lists(self):
        self._login("pn_arch_alice")
        note_id = self.alice_note.pk

        active = self.client.get("/api/me/notes/")
        self.assertIn(
            note_id, {note["id"] for note in active.json()},
        )

        response = self._post(f"/api/me/notes/{note_id}/archive/", {})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], note_id)
        self.assertIsNotNone(response.json()["archivedAt"])

        active = self.client.get("/api/me/notes/")
        self.assertNotIn(
            note_id, {note["id"] for note in active.json()},
        )
        archived = self.client.get("/api/me/notes/archive/")
        archived_notes = {note["id"]: note for note in archived.json()}
        self.assertIn(note_id, archived_notes)
        # Title/content/pinned are retained by the archive.
        self.assertEqual(archived_notes[note_id]["title"], "archivable")
        self.assertEqual(archived_notes[note_id]["content"], "keep me")
        self.alice_note.refresh_from_db()
        self.assertIsNotNone(self.alice_note.archived_at)

    def test_restore_reverses_using_same_note_id(self):
        self._login("pn_arch_alice")
        note_id = self.alice_note.pk
        archive_personal_note(actor=self.alice, note_id=note_id)

        response = self._post(f"/api/me/notes/{note_id}/restore/", {})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], note_id)
        self.assertIsNone(response.json()["archivedAt"])

        active = self.client.get("/api/me/notes/")
        self.assertIn(
            note_id, {note["id"] for note in active.json()},
        )
        archived = self.client.get("/api/me/notes/archive/")
        self.assertNotIn(
            note_id, {note["id"] for note in archived.json()},
        )
        self.alice_note.refresh_from_db()
        self.assertIsNone(self.alice_note.archived_at)
        # The SAME row: id and content survive the round trip.
        self.assertEqual(self.alice_note.title, "archivable")
        self.assertEqual(self.alice_note.content, "keep me")

    def test_foreign_archive_restore_same_404_as_nonexistent(self):
        self._login("pn_arch_bob")
        for suffix in ("archive", "restore"):
            foreign = self._post(
                f"/api/me/notes/{self.alice_note.pk}/{suffix}/", {},
            )
            missing = self._post(
                f"/api/me/notes/999999/{suffix}/", {},
            )
            self.assertEqual(foreign.status_code, 404, suffix)
            self.assertEqual(missing.status_code, 404, suffix)
            self.assertEqual(foreign.json(), missing.json(), suffix)
        self.alice_note.refresh_from_db()
        self.assertIsNone(self.alice_note.archived_at)

    def test_repeated_archive_restore_preserves_domain_idempotency(self):
        self._login("pn_arch_alice")
        note_id = self.alice_note.pk

        response = self._post(f"/api/me/notes/{note_id}/archive/", {})
        self.assertEqual(response.status_code, 200)
        self.alice_note.refresh_from_db()
        first_archived_at = self.alice_note.archived_at
        first_updated_at = self.alice_note.updated_at
        self.assertIsNotNone(first_archived_at)

        # Replay: archived_at and updated_at are untouched.
        response = self._post(f"/api/me/notes/{note_id}/archive/", {})
        self.assertEqual(response.status_code, 200)
        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.archived_at, first_archived_at)
        self.assertEqual(self.alice_note.updated_at, first_updated_at)

        response = self._post(f"/api/me/notes/{note_id}/restore/", {})
        self.assertEqual(response.status_code, 200)
        self.alice_note.refresh_from_db()
        self.assertIsNone(self.alice_note.archived_at)
        restored_updated_at = self.alice_note.updated_at

        # Replay: restored_updated_at is untouched.
        response = self._post(f"/api/me/notes/{note_id}/restore/", {})
        self.assertEqual(response.status_code, 200)
        self.alice_note.refresh_from_db()
        self.assertIsNone(self.alice_note.archived_at)
        self.assertEqual(
            self.alice_note.updated_at, restored_updated_at,
        )
        # The row was never replaced: archive/restore kept the id.
        self.assertEqual(self.alice_note.pk, note_id)


class PersonalNoteDeleteTest(_AuthMixin, APITestCase):
    """DELETE /api/me/notes/{note_id}/ — permanent, owner-only.

    Success is a 204 with an EMPTY body (no note representation);
    the row is physically removed; a foreign note id and a
    nonexistent note id produce the identical non-leaking 404 and
    leave the foreign row untouched.
    """

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_del_alice", password=SEED_PASSWORD,
        )
        cls.bob = User.objects.create_user(
            username="pn_del_bob", password=SEED_PASSWORD,
        )
        cls.alice_note = create_personal_note(
            actor=cls.alice, title="deletable", content="bye",
        )
        cls.alice_other = create_personal_note(
            actor=cls.alice, title="survivor",
        )
        cls.bob_note = create_personal_note(
            actor=cls.bob, title="foreign",
        )

    def test_owner_delete_returns_204_with_empty_body(self):
        self._login("pn_del_alice")
        note_id = self.alice_note.pk

        response = self._delete(f"/api/me/notes/{note_id}/")

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")
        self.assertFalse(
            PersonalNote.objects.filter(pk=note_id).exists()
        )

    def test_get_after_delete_is_the_canonical_404(self):
        self._login("pn_del_alice")
        note_id = self.alice_note.pk
        self._delete(f"/api/me/notes/{note_id}/")

        response = self.client.get(f"/api/me/notes/{note_id}/")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            response.json(), {"error": "Personal note not found."},
        )

    def test_deleted_active_note_disappears_from_active_listing(self):
        self._login("pn_del_alice")
        note_id = self.alice_note.pk

        self._delete(f"/api/me/notes/{note_id}/")

        active = self.client.get("/api/me/notes/")
        self.assertEqual(
            {note["id"] for note in active.json()},
            {self.alice_other.pk},
        )
        self.alice_other.refresh_from_db()
        self.assertEqual(self.alice_other.title, "survivor")

    def test_deleted_archived_note_disappears_from_archive_listing(self):
        self._login("pn_del_alice")
        note_id = self.alice_note.pk
        archive_personal_note(actor=self.alice, note_id=note_id)
        self.assertEqual(
            {note["id"] for note in
             self.client.get("/api/me/notes/archive/").json()},
            {note_id},
        )

        self._delete(f"/api/me/notes/{note_id}/")

        archived = self.client.get("/api/me/notes/archive/")
        self.assertEqual(archived.json(), [])
        self.assertEqual(
            {note["id"] for note in
             self.client.get("/api/me/notes/").json()},
            {self.alice_other.pk},
        )

    def test_foreign_and_nonexistent_delete_same_404(self):
        self._login("pn_del_bob")

        foreign = self._delete(f"/api/me/notes/{self.alice_note.pk}/")
        missing = self._delete("/api/me/notes/999999/")

        self.assertEqual(foreign.status_code, 404)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(foreign.json(), missing.json())
        self.assertEqual(
            foreign.json(), {"error": "Personal note not found."},
        )

    def test_failed_foreign_delete_leaves_the_row_untouched(self):
        self._login("pn_del_bob")
        self._delete(f"/api/me/notes/{self.alice_note.pk}/")

        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.title, "deletable")
        self.assertEqual(self.alice_note.content, "bye")
        self.assertIsNone(self.alice_note.archived_at)

    def test_delete_never_leaks_owner_or_ownership(self):
        """The 204 carries no representation at all — there is no
        owner identifier to leak on success, and the 404 body is the
        one non-leaking contract."""
        self._login("pn_del_alice")
        response = self._delete(
            f"/api/me/notes/{self.alice_note.pk}/",
        )
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")


# ── Privacy ──


class PersonalNotePrivacyTest(_AuthMixin, APITestCase):
    """ResearchGroup / Project / Meeting access never grants access to
    another user's note, and the representation never exposes the
    owner."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_priv_alice", password=SEED_PASSWORD,
        )
        cls.bob = User.objects.create_user(
            username="pn_priv_bob", password=SEED_PASSWORD,
        )
        cls.group = ResearchGroup.objects.create(
            name="PN Privacy Group", created_by=cls.alice,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group, user=cls.alice,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group, user=cls.bob,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        cls.project = create_project(
            research_group=cls.group, creator=cls.alice,
            name="PN Privacy Project",
        )
        add_project_membership(
            project=cls.project, actor=cls.alice, target_user=cls.bob,
            role=ProjectMembership.Role.MEMBER,
        )
        cls.alice_note = create_personal_note(
            actor=cls.alice, title="secret", content="very private",
        )

    def test_membership_grants_no_access_through_any_endpoint(self):
        self._login("pn_priv_bob")
        note_id = self.alice_note.pk

        # Bob's listings never contain Alice's note.
        for url in ("/api/me/notes/", "/api/me/notes/archive/"):
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn(
                note_id, {note["id"] for note in response.json()},
            )

        # Detail, update, pin, archive, restore: the non-leaking 404.
        base = f"/api/me/notes/{note_id}/"
        self.assertEqual(
            self.client.get(base).status_code, 404,
        )
        self.assertEqual(
            self._patch(base, {"title": "hijack"}).status_code, 404,
        )
        self.assertEqual(
            self._post(f"{base}pin/", {"pinned": True}).status_code, 404,
        )
        self.assertEqual(
            self._post(f"{base}archive/", {}).status_code, 404,
        )
        self.assertEqual(
            self._post(f"{base}restore/", {}).status_code, 404,
        )

        # The note is untouched by every attempt.
        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.title, "secret")
        self.assertEqual(self.alice_note.content, "very private")
        self.assertFalse(self.alice_note.pinned)
        self.assertIsNone(self.alice_note.archived_at)
        self.assertEqual(self.alice_note.user_id, self.alice.pk)

    def test_api_responses_expose_no_owner_user_identifier(self):
        self._login("pn_priv_alice")
        create = self._post("/api/me/notes/", {"title": "mine"})
        self.assertEqual(create.status_code, 201)
        active = self.client.get("/api/me/notes/")
        archived = self.client.get("/api/me/notes/archive/")
        detail = self.client.get(
            f"/api/me/notes/{self.alice_note.pk}/",
        )

        representations = (
            [create.json()]
            + active.json()
            + archived.json()
            + [detail.json()]
        )
        for body in representations:
            self.assertEqual(set(body.keys()), NOTE_REPRESENTATION_KEYS)
            for key in body:
                lowered = key.lower()
                self.assertNotIn("user", lowered, key)
                self.assertNotIn("owner", lowered, key)


# ── CSRF ──


class PersonalNoteCSRFTest(TestCase):
    """Authenticated browser mutations follow the repository's canonical
    CSRF contract: DRF ``SessionAuthentication`` enforces CSRF for
    authenticated unsafe requests (``docs/domain/authentication-sessions.md``
    §7). Real-enforcement tests with
    ``Client(enforce_csrf_checks=True)``."""

    def setUp(self):
        super().setUp()
        self.alice = User.objects.create_user(
            username="pn_csrf_alice", password=SEED_PASSWORD,
        )
        self.note = create_personal_note(
            actor=self.alice, title="csrf",
        )
        self.client = Client(enforce_csrf_checks=True)
        self.client.force_login(self.alice)

    def _token(self):
        self.client.get("/api/auth/csrf/")
        return self.client.cookies["csrftoken"].value

    def test_authenticated_mutations_without_csrf_token_are_rejected(self):
        note_id = self.note.pk
        attempts = [
            ("post", "/api/me/notes/", {"title": "no csrf"}),
            ("patch", f"/api/me/notes/{note_id}/", {"title": "no csrf"}),
            ("post", f"/api/me/notes/{note_id}/pin/", {"pinned": True}),
            ("post", f"/api/me/notes/{note_id}/archive/", {}),
            ("post", f"/api/me/notes/{note_id}/restore/", {}),
            ("delete", f"/api/me/notes/{note_id}/", None),
        ]
        for method, url, data in attempts:
            if data is None:
                response = getattr(self.client, method)(url)
            else:
                response = getattr(self.client, method)(
                    url,
                    data=data,
                    content_type="application/json",
                )
            self.assertEqual(
                response.status_code, 403,
                f"{method.upper()} {url} must require CSRF",
            )
        self.note.refresh_from_db()
        self.assertEqual(self.note.title, "csrf")
        self.assertFalse(self.note.pinned)
        self.assertIsNone(self.note.archived_at)

    def test_authenticated_mutations_with_csrf_token_succeed(self):
        token = self._token()
        response = self.client.post(
            "/api/me/notes/",
            data={"title": "with csrf"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 201)
        note_id = response.json()["id"]

        token = self._token()
        response = self.client.post(
            f"/api/me/notes/{note_id}/archive/",
            data={},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(response.json()["archivedAt"])

        token = self._token()
        response = self.client.delete(
            f"/api/me/notes/{note_id}/",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 204)
        self.assertFalse(
            PersonalNote.objects.filter(pk=note_id).exists()
        )

    def test_reads_do_not_require_csrf_token(self):
        response = self.client.get("/api/me/notes/")
        self.assertEqual(response.status_code, 200)
        response = self.client.get(
            f"/api/me/notes/{self.note.pk}/",
        )
        self.assertEqual(response.status_code, 200)


# ── Contract ──


class PersonalNoteContractTest(_AuthMixin, APITestCase):
    """Representation shape, status codes, and deferred-scope guards."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_contract_alice", password=SEED_PASSWORD,
        )

    def test_representation_shape_and_nullability(self):
        self._login("pn_contract_alice")
        create = self._post("/api/me/notes/", {"title": "t"})
        self.assertEqual(create.status_code, 201)
        body = create.json()
        self.assertEqual(set(body.keys()), NOTE_REPRESENTATION_KEYS)
        self.assertIsInstance(body["id"], int)
        self.assertIsInstance(body["title"], str)
        self.assertIsInstance(body["content"], str)
        self.assertIsInstance(body["pinned"], bool)
        self.assertIsNone(body["archivedAt"])  # active
        self.assertIsInstance(body["createdAt"], str)
        self.assertIsInstance(body["updatedAt"], str)

        note_id = body["id"]
        archived = self._post(f"/api/me/notes/{note_id}/archive/", {})
        self.assertEqual(archived.status_code, 200)
        self.assertEqual(
            set(archived.json().keys()), NOTE_REPRESENTATION_KEYS,
        )
        self.assertIsInstance(archived.json()["archivedAt"], str)

    def test_status_codes(self):
        self._login("pn_contract_alice")
        create = self._post("/api/me/notes/", {"title": "t"})
        self.assertEqual(create.status_code, 201)
        note_id = create.json()["id"]
        self.assertEqual(
            self.client.get(f"/api/me/notes/{note_id}/").status_code, 200,
        )
        self.assertEqual(
            self._patch(f"/api/me/notes/{note_id}/", {"title": "t2"}).status_code,
            200,
        )
        self.assertEqual(
            self._post(
                f"/api/me/notes/{note_id}/pin/", {"pinned": True},
            ).status_code,
            200,
        )
        self.assertEqual(
            self._post(f"/api/me/notes/{note_id}/archive/", {}).status_code,
            200,
        )
        self.assertEqual(
            self._post(f"/api/me/notes/{note_id}/restore/", {}).status_code,
            200,
        )
        self.assertEqual(self.client.get("/api/me/notes/").status_code, 200)
        self.assertEqual(
            self.client.get("/api/me/notes/archive/").status_code, 200,
        )
        self.assertEqual(
            self._delete(f"/api/me/notes/{note_id}/").status_code,
            204,
        )

    def test_no_deferred_endpoints_or_behavior_introduced(self):
        self._login("pn_contract_alice")
        create = self._post("/api/me/notes/", {"title": "findable"})
        note_id = create.json()["id"]

        # No separate search route: search is ?q= on the list only.
        self.assertEqual(
            self.client.get("/api/me/notes/search/").status_code, 404,
        )
        self.assertEqual(
            self.client.get("/api/me/notes/daily/").status_code, 404,
        )
        self.assertEqual(
            self.client.get(
                f"/api/me/notes/{note_id}/convert-to-work-item/",
            ).status_code,
            404,
        )
        # ?q= IS the owner-scoped active-note search (V1 substring):
        # a matching query returns the matching note...
        response = self.client.get("/api/me/notes/?q=findable")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            {note["id"] for note in response.json()}, {note_id},
        )
        # ...and a non-matching query returns no notes.
        no_match = self.client.get("/api/me/notes/?q=not-findable")
        self.assertEqual(no_match.status_code, 200)
        self.assertEqual(no_match.json(), [])

    def test_archive_list_route_does_not_shadow_note_ids(self):
        """The static /archive/ route never collides with note ids and a
        note titled "archive" is addressable by its id."""
        self._login("pn_contract_alice")
        create = self._post("/api/me/notes/", {"title": "archive"})
        self.assertEqual(create.status_code, 201)
        detail = self.client.get(
            f"/api/me/notes/{create.json()['id']}/",
        )
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["title"], "archive")
        self.assertEqual(self.client.get("/api/me/notes/archive/").status_code, 200)
