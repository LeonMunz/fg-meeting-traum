"""Persistence tests for the MeetingItem Markdown ``content`` slice.

Two levels of behavioral coverage for migration 0021:

1. ``MeetingItemContentBackfillUnitTest`` runs the EXACT backfill
   function the migration executes against populated rows in the
   legacy (pre-backfill) state — content at the AddField default
   ``""`` while ``title`` / ``notes`` carry the legacy values.
2. ``MeetingItemContentMigrationRoundTripTest`` performs the real
   migration on a populated test database: it unapplies 0021, seeds
   legacy rows through the pre-0021 (0020) model state, migrates to
   0021, and verifies the backfilled ``content`` plus the untouched
   ``title`` / ``notes`` values.
"""

import importlib
from datetime import timedelta

from django.apps import apps
from django.contrib.auth import get_user_model
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase
from django.utils import timezone

from .models import MeetingItem as CurrentMeetingItem
from .models import (
    Meeting,
    MeetingSection,
)
from .services import create_meeting_item
from .services import create_meeting, create_meeting_item
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

User = get_user_model()

TARGET = ("meetings", "0021_meetingitem_content")
PREV = ("meetings", "0020_meetingrecurrenceparticipant")


def _load_migration():
    return importlib.import_module(
        "meetings.migrations.%s" % TARGET[1]
    )


class MeetingItemContentBackfillUnitTest(TestCase):
    """The migration's backfill rule on simulated legacy rows.

    A legacy row, as migration 0021 finds it after the AddField, is
    exactly a fully populated ``meetings_item`` row whose ``content``
    still holds the column default ``""``.
    """

    def setUp(self):
        self.alex = User.objects.create_user(
            username="alex-backfill",
            password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Backfill Research Group",
            created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="FG Weekly",
            scheduled_at=timezone.now() + timedelta(days=1),
        )

    def _simulate_legacy_row(self, title, notes):
        item = create_meeting_item(
            meeting=self.meeting,
            meeting_section=MeetingSection.objects.get(
                meeting=self.meeting,
            ),
            actor=self.alex,
            title=title,
            notes=notes,
        )
        # Reset the row to the pre-backfill state of migration 0021:
        # content at the AddField default "". Legacy rows may carry
        # unstripped notes (pre-dating the service normalization), so
        # the stored notes value is set verbatim.
        CurrentMeetingItem.objects.filter(pk=item.pk).update(
            notes=notes,
            content="",
        )
        item.refresh_from_db()
        return item

    def _run_migration_backfill(self):
        migration = _load_migration()
        migration.backfill_meeting_item_content(apps, None)

    def test_title_only_row_gets_title_as_content(self):
        item = self._simulate_legacy_row("GPU procurement", "")
        self.assertEqual(item.content, "")

        self._run_migration_backfill()

        item.refresh_from_db()
        self.assertEqual(item.title, "GPU procurement")
        self.assertEqual(item.notes, "")
        self.assertEqual(item.content, "GPU procurement")

    def test_title_and_notes_row_gets_blank_line_separation(self):
        item = self._simulate_legacy_row("GPU procurement", "Discuss scope.")
        self.assertEqual(item.content, "")

        self._run_migration_backfill()

        item.refresh_from_db()
        self.assertEqual(item.title, "GPU procurement")
        self.assertEqual(item.notes, "Discuss scope.")
        self.assertEqual(
            item.content,
            "GPU procurement\n\nDiscuss scope.",
        )

    def test_multiline_notes_are_preserved_verbatim(self):
        notes = "line one\nline two\nline three"
        item = self._simulate_legacy_row("Multiline", notes)

        self._run_migration_backfill()

        item.refresh_from_db()
        self.assertEqual(item.notes, notes)
        self.assertEqual(
            item.content,
            "Multiline\n\nline one\nline two\nline three",
        )

    def test_whitespace_only_notes_count_as_absent(self):
        item = self._simulate_legacy_row("Title", "   ")

        self._run_migration_backfill()

        # The stored notes value is preserved verbatim (the migration
        # never rewrites it); only the derived content ignores the
        # whitespace-only notes.
        item.refresh_from_db()
        self.assertEqual(item.notes, "   ")
        self.assertEqual(item.content, "Title")

    def test_long_content_is_not_limited(self):
        long_notes = "x" * 500
        item = self._simulate_legacy_row("Long", long_notes)

        self._run_migration_backfill()

        item.refresh_from_db()
        self.assertGreater(len(item.content), 255)
        self.assertEqual(item.content, "Long\n\n" + long_notes)

    def test_backfill_is_idempotent_and_selective(self):
        legacy = self._simulate_legacy_row("Legacy", "Notes.")
        # A row already carrying the derived value (as a row written
        # by the domain services would).
        current = create_meeting_item(
            meeting=self.meeting,
            meeting_section=MeetingSection.objects.get(
                meeting=self.meeting,
            ),
            actor=self.alex,
            title="Current",
        )

        self._run_migration_backfill()
        first_content = CurrentMeetingItem.objects.get(
            pk=current.pk
        ).content

        self._run_migration_backfill()

        legacy.refresh_from_db()
        self.assertEqual(legacy.content, "Legacy\n\nNotes.")
        self.assertEqual(
            CurrentMeetingItem.objects.get(pk=current.pk).content,
            first_content,
        )


class MeetingItemContentMigrationRoundTripTest(TransactionTestCase):
    """Apply migration 0021 to a POPULATED pre-0021 database.

    Seeds legacy rows through the 0020-state model registry (the
    schema without the ``content`` column), migrates to 0021, and
    verifies the backfill plus the untouched legacy fields.
    """

    def setUp(self):
        super().setUp()
        MigrationExecutor(connection).migrate([PREV])

    def tearDown(self):
        MigrationExecutor(connection).migrate([TARGET])
        super().tearDown()

    def _legacy_apps(self):
        executor = MigrationExecutor(connection)
        state = executor.loader.project_state([TARGET], at_end=False)
        return state.apps

    def test_migration_backfills_populated_database(self):
        old = self._legacy_apps()
        OldUser = old.get_model("accounts", "User")
        OldRG = old.get_model("research_groups", "ResearchGroup")
        OldRGM = old.get_model("research_groups", "ResearchGroupMembership")
        OldMeeting = old.get_model("meetings", "Meeting")
        OldSection = old.get_model("meetings", "MeetingSection")
        OldItem = old.get_model("meetings", "MeetingItem")

        alex = OldUser.objects.create_user(
            username="alex-roundtrip",
            password="Pass1!",
        )
        group = OldRG.objects.create(
            name="RoundTrip Research Group",
            created_by=alex,
        )
        OldRGM.objects.create(
            research_group=group,
            user=alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        meeting = OldMeeting.objects.create(
            research_group=group,
            scope=Meeting.Scope.GROUP,
            title="FG Weekly",
            scheduled_at=timezone.now() + timedelta(days=1),
            status=Meeting.Status.UPCOMING,
            created_by=alex,
        )
        section = OldSection.objects.create(
            meeting=meeting,
            name="Agenda",
            description="",
            position=0,
            is_visible=True,
        )
        # Legacy rows in every shape: title only, title + notes,
        # multiline notes, and long notes (content > 255 chars).
        item_plain = OldItem.objects.create(
            meeting=meeting,
            meeting_section=section,
            title="Plain topic",
            notes="",
            position=0,
            outcome="not_discussed",
            created_by=alex,
        )
        item_notes = OldItem.objects.create(
            meeting=meeting,
            meeting_section=section,
            title="Noted topic",
            notes="Discuss scope.",
            position=1,
            outcome="not_discussed",
            created_by=alex,
        )
        long_notes = "y" * 500
        item_long = OldItem.objects.create(
            meeting=meeting,
            meeting_section=section,
            title="Long topic",
            notes=long_notes,
            position=2,
            outcome="not_discussed",
            created_by=alex,
        )

        # The real migration: AddField + backfill on the populated
        # database.
        MigrationExecutor(connection).migrate([TARGET])

        plain = CurrentMeetingItem.objects.get(pk=item_plain.pk)
        noted = CurrentMeetingItem.objects.get(pk=item_notes.pk)
        long_item = CurrentMeetingItem.objects.get(pk=item_long.pk)

        # Backfilled content...
        self.assertEqual(plain.content, "Plain topic")
        self.assertEqual(
            noted.content,
            "Noted topic\n\nDiscuss scope.",
        )
        self.assertEqual(long_item.content, "Long topic\n\n" + long_notes)
        self.assertGreater(len(long_item.content), 255)

        # ...with every legacy field preserved verbatim.
        self.assertEqual(plain.title, "Plain topic")
        self.assertEqual(plain.notes, "")
        self.assertEqual(noted.title, "Noted topic")
        self.assertEqual(noted.notes, "Discuss scope.")
        self.assertEqual(long_item.title, "Long topic")
        self.assertEqual(long_item.notes, long_notes)

        # No row was lost and no row was created.
        self.assertEqual(
            CurrentMeetingItem.objects.filter(
                meeting=Meeting.objects.get(pk=meeting.pk)
            ).count(),
            3,
        )
