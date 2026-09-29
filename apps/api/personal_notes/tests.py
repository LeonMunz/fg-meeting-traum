"""Tests for the Personal Notes domain foundation (persistence only; no API).

Canonical reference: ``docs/domain/personal-notes.md``.

Covers:
- persistence: creation with empty title/content, immutable owner,
  timestamps, pin persistence, archive/restore on the same row
- privacy boundary: owner-scoped lookups; one non-leaking outcome for a
  foreign id and a nonexistent id; updates/pin/archive denied for a
  foreign owner; lists never contain foreign notes; ResearchGroup /
  Project membership grants no note access
- lifecycle: active/archived partitioning, identity preservation across
  archive/restore, idempotent replay, owner immutability
- ordering: most recently updated first with a deterministic id
  tie-breaker (active and archived listings)
- search: owner-scoped, ACTIVE-only, case-insensitive substring
  matching over title OR content (canonical ordering preserved;
  archived and foreign notes never match)
"""

import inspect

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from personal_notes.models import PersonalNote
from personal_notes.services import (
    PersonalNoteNotFoundError,
    archive_personal_note,
    create_personal_note,
    get_personal_note,
    list_active_notes,
    list_archived_notes,
    restore_personal_note,
    search_active_notes,
    set_personal_note_pinned,
    update_personal_note,
)
from projects.models import ProjectMembership
from projects.services import add_project_membership, create_project
from research_groups.models import ResearchGroupMembership
from research_groups.services import (
    add_research_group_membership,
    create_research_group,
)

User = get_user_model()


def _note_ids(notes):
    return [note.pk for note in notes]


def _set_updated_at(note, moment):
    """Set an explicit updated_at (queryset update bypasses auto_now)."""
    PersonalNote.objects.filter(pk=note.pk).update(updated_at=moment)
    note.refresh_from_db()


class PersonalNotePersistenceTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pn_alice", password="TestPass1!"
        )
        cls.bob = User.objects.create_user(
            username="pn_bob", password="TestPass1!"
        )

    # 1. A note can be created for a user with empty title/content.
    def test_create_with_empty_title_and_content(self):
        note = create_personal_note(actor=self.alice)
        self.assertIsNotNone(note.pk)
        self.assertEqual(note.title, "")
        self.assertEqual(note.content, "")

    # 2. The creator is persisted as the owner.
    def test_creator_is_persisted_owner(self):
        note = create_personal_note(
            actor=self.alice, title="t", content="c"
        )
        note.refresh_from_db()
        self.assertEqual(note.user_id, self.alice.pk)

    # 3. Timestamps behave correctly.
    def test_timestamps(self):
        before = timezone.now()
        note = create_personal_note(actor=self.alice, title="t")
        after = timezone.now()

        self.assertIsNotNone(note.created_at)
        self.assertIsNotNone(note.updated_at)
        self.assertTrue(timezone.is_aware(note.created_at))
        self.assertTrue(timezone.is_aware(note.updated_at))
        self.assertGreaterEqual(note.created_at, before)
        self.assertLessEqual(note.created_at, after)
        self.assertGreaterEqual(note.updated_at, note.created_at)

        # A content update bumps updated_at (and not created_at).
        stale = before - timezone.timedelta(seconds=3600)
        _set_updated_at(note, stale)
        original_created_at = note.created_at

        update_personal_note(
            actor=self.alice, note_id=note.pk, content="edited"
        )
        note.refresh_from_db()
        self.assertEqual(note.content, "edited")
        self.assertEqual(note.created_at, original_created_at)
        self.assertGreater(note.updated_at, stale)

    # 4. Pin state persists.
    def test_pin_state_persists(self):
        note = create_personal_note(actor=self.alice, title="pin me")
        self.assertFalse(note.pinned)

        pinned = set_personal_note_pinned(
            actor=self.alice, note_id=note.pk, pinned=True
        )
        self.assertTrue(pinned.pinned)

        note.refresh_from_db()
        self.assertTrue(note.pinned)

        unpinned = set_personal_note_pinned(
            actor=self.alice, note_id=note.pk, pinned=False
        )
        self.assertFalse(unpinned.pinned)
        note.refresh_from_db()
        self.assertFalse(note.pinned)

    # 5. Archive state persists and restores on the same row.
    def test_archive_persists_and_restores_same_row(self):
        note = create_personal_note(
            actor=self.alice, title="t", content="c"
        )
        note_id = note.pk

        archived = archive_personal_note(
            actor=self.alice, note_id=note_id
        )
        self.assertIsNotNone(archived.archived_at)

        restored = restore_personal_note(
            actor=self.alice, note_id=note_id
        )
        self.assertIsNone(restored.archived_at)
        self.assertEqual(restored.pk, note_id)

    # 20. No domain operation can change the owner.
    def test_update_cannot_change_owner(self):
        note = create_personal_note(
            actor=self.alice, title="t", content="c"
        )
        update_personal_note(
            actor=self.alice,
            note_id=note.pk,
            title="new title",
            content="new content",
        )
        note.refresh_from_db()
        self.assertEqual(note.user_id, self.alice.pk)

        # Structural: no operation accepts an owner/user for an existing
        # note, and creation takes only the actor as owner source.
        for fn in (
            update_personal_note,
            get_personal_note,
            set_personal_note_pinned,
            archive_personal_note,
            restore_personal_note,
        ):
            params = inspect.signature(fn).parameters
            self.assertNotIn("user", params, fn.__name__)
            self.assertNotIn("owner", params, fn.__name__)
        self.assertNotIn("user", inspect.signature(create_personal_note).parameters)
        self.assertNotIn("owner", inspect.signature(create_personal_note).parameters)


class PersonalNotePrivacyBoundaryTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pnb_alice", password="TestPass1!"
        )
        cls.bob = User.objects.create_user(
            username="pnb_bob", password="TestPass1!"
        )
        cls.alice_note = create_personal_note(
            actor=cls.alice, title="alice note", content="alice content"
        )

    # 6. The owner can retrieve their own note.
    def test_owner_can_retrieve_own_note(self):
        note = get_personal_note(
            actor=self.alice, note_id=self.alice_note.pk
        )
        self.assertEqual(note.pk, self.alice_note.pk)

    # 7. User B cannot retrieve user A's note by known id.
    def test_foreign_user_cannot_retrieve(self):
        with self.assertRaises(PersonalNoteNotFoundError):
            get_personal_note(actor=self.bob, note_id=self.alice_note.pk)

    # 8. A foreign id and a nonexistent id expose the same outcome.
    def test_foreign_and_nonexistent_expose_same_outcome(self):
        with self.assertRaises(PersonalNoteNotFoundError) as foreign:
            get_personal_note(actor=self.bob, note_id=self.alice_note.pk)
        with self.assertRaises(PersonalNoteNotFoundError) as missing:
            get_personal_note(actor=self.bob, note_id=9_999_999_999)
        self.assertEqual(str(foreign.exception), str(missing.exception))

    # 9. User B cannot update user A's title/content.
    def test_foreign_user_cannot_update(self):
        with self.assertRaises(PersonalNoteNotFoundError):
            update_personal_note(
                actor=self.bob,
                note_id=self.alice_note.pk,
                title="hijacked",
                content="hijacked",
            )
        self.alice_note.refresh_from_db()
        self.assertEqual(self.alice_note.title, "alice note")
        self.assertEqual(self.alice_note.content, "alice content")

    # 10. User B cannot pin/unpin user A's note.
    def test_foreign_user_cannot_pin(self):
        with self.assertRaises(PersonalNoteNotFoundError):
            set_personal_note_pinned(
                actor=self.bob, note_id=self.alice_note.pk, pinned=True
            )
        self.alice_note.refresh_from_db()
        self.assertFalse(self.alice_note.pinned)

    # 11. User B cannot archive/restore user A's note.
    def test_foreign_user_cannot_archive_or_restore(self):
        with self.assertRaises(PersonalNoteNotFoundError):
            archive_personal_note(actor=self.bob, note_id=self.alice_note.pk)
        self.alice_note.refresh_from_db()
        self.assertIsNone(self.alice_note.archived_at)

        archive_personal_note(actor=self.alice, note_id=self.alice_note.pk)
        self.alice_note.refresh_from_db()
        self.assertIsNotNone(self.alice_note.archived_at)

        with self.assertRaises(PersonalNoteNotFoundError):
            restore_personal_note(actor=self.bob, note_id=self.alice_note.pk)
        self.alice_note.refresh_from_db()
        self.assertIsNotNone(self.alice_note.archived_at)

    # 12. The active listing for A never contains B's notes.
    def test_active_list_never_contains_foreign_notes(self):
        bob_note = create_personal_note(
            actor=self.bob, title="bob note"
        )
        listed = list_active_notes(actor=self.alice)
        self.assertIn(self.alice_note.pk, _note_ids(listed))
        self.assertNotIn(bob_note.pk, _note_ids(listed))

    # 13. The archived listing for A never contains B's archived notes.
    def test_archived_list_never_contains_foreign_notes(self):
        bob_note = create_personal_note(actor=self.bob, title="bob arch")
        archive_personal_note(actor=self.bob, note_id=bob_note.pk)
        archive_personal_note(actor=self.alice, note_id=self.alice_note.pk)

        listed = list_archived_notes(actor=self.alice)
        self.assertIn(self.alice_note.pk, _note_ids(listed))
        self.assertNotIn(bob_note.pk, _note_ids(listed))

    # 14. RG/Project membership does not grant access to another
    #     user's PersonalNote.
    def test_rg_project_membership_grants_no_note_access(self):
        group = create_research_group(creator=self.alice, name="PN Group")
        add_research_group_membership(
            research_group=group,
            actor=self.alice,
            target_user=self.bob,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        project = create_project(
            research_group=group, creator=self.alice, name="PN Project"
        )
        add_project_membership(
            project=project,
            actor=self.alice,
            target_user=self.bob,
            role=ProjectMembership.Role.MEMBER,
        )

        # Bob is a group member and a project member of a project Alice
        # created — none of that grants note access.
        with self.assertRaises(PersonalNoteNotFoundError):
            get_personal_note(actor=self.bob, note_id=self.alice_note.pk)
        with self.assertRaises(PersonalNoteNotFoundError):
            update_personal_note(
                actor=self.bob,
                note_id=self.alice_note.pk,
                title="hijacked",
            )
        self.assertNotIn(
            self.alice_note.pk,
            _note_ids(list_active_notes(actor=self.bob)),
        )


class PersonalNoteLifecycleTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pl_alice", password="TestPass1!"
        )

    # 15. The active list excludes archived notes.
    def test_active_list_excludes_archived(self):
        active = create_personal_note(actor=self.alice, title="active")
        archived = create_personal_note(actor=self.alice, title="archived")
        archive_personal_note(actor=self.alice, note_id=archived.pk)

        listed = _note_ids(list_active_notes(actor=self.alice))
        self.assertIn(active.pk, listed)
        self.assertNotIn(archived.pk, listed)

    # 16. The archived list excludes active notes.
    def test_archived_list_excludes_active(self):
        active = create_personal_note(actor=self.alice, title="active")
        archived = create_personal_note(actor=self.alice, title="archived")
        archive_personal_note(actor=self.alice, note_id=archived.pk)

        listed = _note_ids(list_archived_notes(actor=self.alice))
        self.assertIn(archived.pk, listed)
        self.assertNotIn(active.pk, listed)

    # 17. Archive preserves note identity/content/ownership.
    def test_archive_preserves_identity_and_content(self):
        note = create_personal_note(
            actor=self.alice, title="t", content="c"
        )
        set_personal_note_pinned(
            actor=self.alice, note_id=note.pk, pinned=True
        )
        note.refresh_from_db()
        original = (
            note.pk, note.title, note.content, note.pinned, note.user_id
        )

        archived = archive_personal_note(actor=self.alice, note_id=note.pk)
        archived.refresh_from_db()
        self.assertEqual(
            (
                archived.pk,
                archived.title,
                archived.content,
                archived.pinned,
                archived.user_id,
            ),
            original,
        )

    # 18. Restore makes the same note active again.
    def test_restore_makes_same_note_active_again(self):
        note = create_personal_note(
            actor=self.alice, title="t", content="c"
        )
        archive_personal_note(actor=self.alice, note_id=note.pk)
        restored = restore_personal_note(actor=self.alice, note_id=note.pk)

        self.assertEqual(restored.pk, note.pk)
        restored.refresh_from_db()
        self.assertIsNone(restored.archived_at)
        self.assertIn(
            note.pk, _note_ids(list_active_notes(actor=self.alice))
        )
        self.assertNotIn(
            note.pk, _note_ids(list_archived_notes(actor=self.alice))
        )

    # 19. Repeated archive/restore is safe (idempotent contract).
    def test_archive_is_idempotent(self):
        note = create_personal_note(actor=self.alice, title="t")
        first = archive_personal_note(actor=self.alice, note_id=note.pk)
        first_archived_at = first.archived_at
        self.assertIsNotNone(first_archived_at)

        second = archive_personal_note(actor=self.alice, note_id=note.pk)
        self.assertEqual(second.archived_at, first_archived_at)
        self.assertEqual(second.pk, note.pk)

    def test_restore_is_idempotent(self):
        note = create_personal_note(actor=self.alice, title="t")
        archive_personal_note(actor=self.alice, note_id=note.pk)

        first = restore_personal_note(actor=self.alice, note_id=note.pk)
        self.assertIsNone(first.archived_at)

        second = restore_personal_note(actor=self.alice, note_id=note.pk)
        self.assertIsNone(second.archived_at)
        self.assertEqual(second.pk, note.pk)

    def test_noop_update_changes_nothing(self):
        note = create_personal_note(
            actor=self.alice, title="t", content="c"
        )
        _set_updated_at(note, note.created_at)
        before = note.updated_at

        result = update_personal_note(actor=self.alice, note_id=note.pk)
        self.assertEqual(result.pk, note.pk)
        note.refresh_from_db()
        self.assertEqual(note.updated_at, before)

    # A foreign-id denial also applies to every mutation operation.
    def test_foreign_user_denied_on_every_operation(self):
        bob = User.objects.create_user(
            username="pl_bob", password="TestPass1!"
        )
        note = create_personal_note(actor=self.alice, title="t")

        for fn, kwargs in (
            (update_personal_note, {"title": "x"}),
            (set_personal_note_pinned, {"pinned": True}),
            (archive_personal_note, {}),
            (restore_personal_note, {}),
        ):
            with self.assertRaises(PersonalNoteNotFoundError):
                fn(actor=bob, note_id=note.pk, **kwargs)


class PersonalNoteOrderingTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="po_alice", password="TestPass1!"
        )

    def _make(self, title):
        return create_personal_note(actor=self.alice, title=title)

    # 21. Active notes are returned newest-updated first with a
    #     deterministic id tie-breaker.
    def test_active_list_ordering_newest_updated_first(self):
        n_first = self._make("created first")
        n_second = self._make("created second")
        n_third = self._make("created third")

        old = timezone.now() - timezone.timedelta(days=2)
        new = timezone.now()

        _set_updated_at(n_first, old)
        _set_updated_at(n_second, new)
        _set_updated_at(n_third, old)  # ties n_first

        listed = _note_ids(list_active_notes(actor=self.alice))
        # Newest updated first; the tie (n_first / n_third) breaks to the
        # newer id (n_third was created later).
        self.assertEqual(listed, [n_second.pk, n_third.pk, n_first.pk])

    def test_archived_list_uses_same_ordering(self):
        n_first = self._make("a")
        n_second = self._make("b")

        old = timezone.now() - timezone.timedelta(days=1)
        _set_updated_at(n_first, old)
        _set_updated_at(n_second, timezone.now())

        for note in (n_first, n_second):
            archive_personal_note(actor=self.alice, note_id=note.pk)

        listed = _note_ids(list_archived_notes(actor=self.alice))
        self.assertEqual(listed, [n_second.pk, n_first.pk])


class PersonalNoteSearchServiceTest(TestCase):
    """search_active_notes: owner-scoped case-insensitive substring
    search over ACTIVE notes (title OR content)."""

    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="pns_alice", password="TestPass1!"
        )
        cls.bob = User.objects.create_user(
            username="pns_bob", password="TestPass1!"
        )

        cls.title_note = create_personal_note(
            actor=cls.alice, title="Quantum flux notes",
        )
        cls.content_note = create_personal_note(
            actor=cls.alice, title="Plain", content="the QUANTUM drift",
        )
        cls.both_note = create_personal_note(
            actor=cls.alice,
            title="QUANTUM summary", content="quantum recap",
        )
        cls.none_note = create_personal_note(
            actor=cls.alice, title="Unrelated", content="nothing",
        )
        cls.archived_note = create_personal_note(
            actor=cls.alice, title="Quantum archived",
        )
        archive_personal_note(
            actor=cls.alice, note_id=cls.archived_note.pk,
        )
        cls.foreign_note = create_personal_note(
            actor=cls.bob, title="Quantum foreign",
        )

    def test_matches_title_or_content_case_insensitively(self):
        ids = _note_ids(
            search_active_notes(actor=self.alice, query="quantum"),
        )
        self.assertEqual(
            set(ids),
            {
                self.title_note.pk,
                self.content_note.pk,
                self.both_note.pk,
            },
        )
        # Uppercase query matches the mixed-case stored text too.
        self.assertEqual(
            _note_ids(search_active_notes(actor=self.alice, query="QUANTUM")),
            _note_ids(search_active_notes(actor=self.alice, query="quantum")),
        )

    def test_note_matching_both_fields_appears_exactly_once(self):
        ids = _note_ids(
            search_active_notes(actor=self.alice, query="quantum"),
        )
        self.assertEqual(ids.count(self.both_note.pk), 1)
        self.assertEqual(len(ids), len(set(ids)))

    def test_archived_notes_never_match(self):
        ids = _note_ids(
            search_active_notes(actor=self.alice, query="quantum"),
        )
        self.assertNotIn(self.archived_note.pk, ids)

    def test_foreign_notes_never_match(self):
        alice_ids = _note_ids(
            search_active_notes(actor=self.alice, query="quantum"),
        )
        bob_ids = _note_ids(
            search_active_notes(actor=self.bob, query="quantum"),
        )
        self.assertNotIn(self.foreign_note.pk, alice_ids)
        self.assertEqual(bob_ids, [self.foreign_note.pk])

    def test_non_matching_query_returns_empty_list(self):
        self.assertEqual(
            search_active_notes(actor=self.alice, query="zzz-not-there"),
            [],
        )

    def test_preserves_canonical_ordering(self):
        now = timezone.now()
        _set_updated_at(
            self.title_note, now - timezone.timedelta(hours=3),
        )
        _set_updated_at(
            self.content_note, now - timezone.timedelta(hours=1),
        )
        _set_updated_at(
            self.both_note, now - timezone.timedelta(hours=2),
        )
        ids = _note_ids(
            search_active_notes(actor=self.alice, query="quantum"),
        )
        self.assertEqual(
            ids,
            [
                self.content_note.pk,
                self.both_note.pk,
                self.title_note.pk,
            ],
        )
