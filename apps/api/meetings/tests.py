from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from .models import (
    Meeting,
    MeetingItem,
    MeetingParticipant,
    MeetingSection,
)
from .services import (
    MeetingDomainError,
    add_meeting_participant,
    derive_meeting_item_title,
    create_meeting,
    create_meeting_item,
    end_meeting,
    meeting_item_is_content_authored,
    remove_meeting_participant,
    reopen_meeting,
    start_meeting,
    update_meeting_item,
    update_meeting,
)


User = get_user_model()


class MeetingDomainTest(TestCase):
    def setUp(self):
        self.alex = User.objects.create_user(
            username="alex-meeting",
            password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="chris-meeting",
            password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="maria-meeting",
            password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Meeting Research Group",
            created_by=self.alex,
        )

        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.scheduled_at = (
            timezone.now() + timedelta(days=1)
        )

    def create_default_meeting(self):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="FG Weekly",
            scheduled_at=self.scheduled_at,
        )

    def test_research_group_member_can_create_meeting(self):
        meeting = self.create_default_meeting()

        self.assertEqual(
            meeting.status,
            Meeting.Status.UPCOMING,
        )
        self.assertEqual(
            meeting.research_group,
            self.group,
        )
        self.assertEqual(
            meeting.created_by,
            self.alex,
        )

    def test_creator_becomes_participant(self):
        meeting = self.create_default_meeting()

        self.assertTrue(
            MeetingParticipant.objects.filter(
                meeting=meeting,
                user=self.alex,
            ).exists()
        )

    def test_non_group_member_cannot_create_meeting(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting(
                research_group=self.group,
                actor=self.maria,
                title="Forbidden",
                scheduled_at=self.scheduled_at,
            )

    def test_meeting_requires_title(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting(
                research_group=self.group,
                actor=self.alex,
                title="   ",
                scheduled_at=self.scheduled_at,
            )

    def test_invalid_meeting_status_is_rejected(self):
        with self.assertRaises(MeetingDomainError):
            create_meeting(
                research_group=self.group,
                actor=self.alex,
                title="Invalid",
                scheduled_at=self.scheduled_at,
                status="invalid",
            )

    def test_group_member_can_be_added_as_participant(self):
        meeting = self.create_default_meeting()

        participant = add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )

        self.assertEqual(
            participant.user,
            self.chris,
        )

    def test_non_group_member_cannot_be_added_by_creator(self):
        meeting = self.create_default_meeting()

        # maria is not a current Research Group member of the
        # Meeting's Research Group, so the group-scoped Meeting
        # rejects her; no membership is created as a side effect.
        with self.assertRaises(MeetingDomainError):
            add_meeting_participant(
                meeting=meeting,
                actor=self.alex,
                target_user=self.maria,
            )
        self.assertFalse(
            MeetingParticipant.objects.filter(
                meeting=meeting,
                user=self.maria,
            ).exists()
        )
        self.assertFalse(
            ResearchGroupMembership.objects.filter(
                research_group=self.group,
                user=self.maria,
            ).exists()
        )

    def test_duplicate_participant_is_rejected(self):
        meeting = self.create_default_meeting()

        add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )

        with self.assertRaises(MeetingDomainError):
            add_meeting_participant(
                meeting=meeting,
                actor=self.alex,
                target_user=self.chris,
            )

    def test_meeting_items_receive_sequential_positions(self):
        meeting = self.create_default_meeting()

        section = MeetingSection.objects.get(meeting=meeting)
        first = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="First item",
        )
        second = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=self.alex,
            title="Second item",
        )

        self.assertEqual(first.position, 0)
        self.assertEqual(second.position, 1)

    def test_non_group_member_cannot_create_meeting_item(self):
        meeting = self.create_default_meeting()

        with self.assertRaises(MeetingDomainError):
            create_meeting_item(
                meeting=meeting,
                meeting_section=MeetingSection.objects.get(meeting=meeting),
                actor=self.maria,
                title="Forbidden item",
            )

    def test_meeting_metadata_can_be_updated(self):
        meeting = self.create_default_meeting()
        new_scheduled_at = (
            self.scheduled_at + timedelta(hours=2)
        )

        update_meeting(
            meeting=meeting,
            actor=self.alex,
            title="Updated Weekly",
            scheduled_at=new_scheduled_at,
        )

        meeting.refresh_from_db()

        self.assertEqual(
            meeting.title,
            "Updated Weekly",
        )
        self.assertEqual(
            meeting.scheduled_at,
            new_scheduled_at,
        )
        # Metadata edits must not move the lifecycle.
        self.assertEqual(
            meeting.status,
            Meeting.Status.UPCOMING,
        )

    def test_start_meeting_sets_status_and_started_at(self):
        meeting = self.create_default_meeting()

        started = start_meeting(meeting=meeting, actor=self.alex)

        self.assertEqual(started.status, Meeting.Status.LIVE)
        self.assertIsNotNone(started.started_at)
        self.assertIsNone(started.ended_at)

        # scheduled timestamp is preserved, not overwritten.
        self.assertEqual(started.scheduled_at, self.scheduled_at)

    def test_start_meeting_rejects_live_and_completed(self):
        meeting = self.create_default_meeting()
        start_meeting(meeting=meeting, actor=self.alex)

        with self.assertRaises(MeetingDomainError):
            start_meeting(meeting=meeting, actor=self.alex)

    def test_end_meeting_requires_live(self):
        meeting = self.create_default_meeting()

        with self.assertRaises(MeetingDomainError):
            end_meeting(meeting=meeting, actor=self.alex)

    def test_end_meeting_sets_status_and_ended_at(self):
        meeting = self.create_default_meeting()
        start_meeting(meeting=meeting, actor=self.alex)

        ended = end_meeting(meeting=meeting, actor=self.alex)

        self.assertEqual(ended.status, Meeting.Status.COMPLETED)
        self.assertIsNotNone(ended.ended_at)
        self.assertIsNotNone(ended.started_at)
        self.assertEqual(ended.scheduled_at, self.scheduled_at)

    def test_completed_meeting_cannot_restart(self):
        meeting = self.create_default_meeting()
        start_meeting(meeting=meeting, actor=self.alex)
        end_meeting(meeting=meeting, actor=self.alex)

        with self.assertRaises(MeetingDomainError):
            start_meeting(meeting=meeting, actor=self.alex)
        with self.assertRaises(MeetingDomainError):
            end_meeting(meeting=meeting, actor=self.alex)


    def test_reopen_completed_meeting_returns_to_live(self):
        meeting = self.create_default_meeting()
        start_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        started_at = meeting.started_at
        end_meeting(meeting=meeting, actor=self.alex)

        reopened = reopen_meeting(meeting=meeting, actor=self.alex)

        self.assertEqual(reopened.status, Meeting.Status.LIVE)
        self.assertIsNone(reopened.ended_at)
        # Original started_at is preserved.
        self.assertEqual(reopened.started_at, started_at)
        self.assertEqual(reopened.scheduled_at, self.scheduled_at)

    def test_reopen_rejects_upcoming_and_live(self):
        upcoming = self.create_default_meeting()
        with self.assertRaises(MeetingDomainError):
            reopen_meeting(meeting=upcoming, actor=self.alex)

        live = self.create_default_meeting()
        start_meeting(meeting=live, actor=self.alex)
        with self.assertRaises(MeetingDomainError):
            reopen_meeting(meeting=live, actor=self.alex)

    def test_reopened_meeting_can_be_ended_again(self):
        meeting = self.create_default_meeting()
        start_meeting(meeting=meeting, actor=self.alex)
        end_meeting(meeting=meeting, actor=self.alex)
        reopen_meeting(meeting=meeting, actor=self.alex)

        ended = end_meeting(meeting=meeting, actor=self.alex)
        self.assertEqual(ended.status, Meeting.Status.COMPLETED)
        self.assertIsNotNone(ended.ended_at)

    def test_update_meeting_does_not_accept_status(self):
        meeting = self.create_default_meeting()

        update_meeting(
            meeting=meeting,
            actor=self.alex,
            title="No lifecycle here",
        )

        meeting.refresh_from_db()
        self.assertEqual(meeting.title, "No lifecycle here")
        self.assertEqual(meeting.status, Meeting.Status.UPCOMING)

    def test_meeting_participant_can_be_removed(self):
        meeting = self.create_default_meeting()

        participant = add_meeting_participant(
            meeting=meeting,
            actor=self.alex,
            target_user=self.chris,
        )

        remove_meeting_participant(
            participant=participant,
            actor=self.alex,
        )

        self.assertFalse(
            MeetingParticipant.objects.filter(
                meeting=meeting,
                user=self.chris,
            ).exists()
        )

    def test_meeting_item_can_be_updated(self):
        meeting = self.create_default_meeting()

        item = create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.get(meeting=meeting),
            actor=self.alex,
            title="Discussion",
        )

        update_meeting_item(
            meeting_item=item,
            actor=self.chris,
            notes="Reviewed by the group.",
        )

        item.refresh_from_db()

        self.assertEqual(
            item.outcome,
            MeetingItem.Outcome.NOT_DISCUSSED,
        )
        self.assertEqual(
            item.notes,
            "Reviewed by the group.",
        )
        # Transitional Markdown persistence: the update re-derives
        # content from the effective (title, notes) pair.
        self.assertEqual(
            item.content,
            "Discussion\n\nReviewed by the group.",
        )


class MeetingItemContentPersistenceTest(TestCase):
    """Transitional Markdown ``content`` persistence for MeetingItem.

    While the legacy title/notes write contract remains authoritative,
    every supported creation and update initializes/synchronizes the
    persisted Markdown ``content`` from the effective (title, notes)
    pair: the title, followed by the notes separated by a single
    blank line when the notes are present (docs/domain/meetings.md
    §17). ``title`` / ``notes`` keep their existing semantics.
    """

    def setUp(self):
        self.alex = User.objects.create_user(
            username="alex-content",
            password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="chris-content",
            password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Content Research Group",
            created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.scheduled_at = (
            timezone.now() + timedelta(days=1)
        )

    def create_default_meeting(self):
        return create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="FG Weekly",
            scheduled_at=self.scheduled_at,
        )

    def create_item(self, **kwargs):
        return create_meeting_item(
            meeting=self.meeting,
            meeting_section=MeetingSection.objects.get(
                meeting=self.meeting,
            ),
            actor=self.alex,
            **kwargs,
        )

    def test_created_item_without_notes_carries_title_as_content(self):
        self.meeting = self.create_default_meeting()

        item = self.create_item(title="GPU procurement")

        self.assertEqual(item.title, "GPU procurement")
        self.assertEqual(item.notes, "")
        self.assertEqual(item.content, "GPU procurement")

    def test_created_item_with_notes_derives_content(self):
        self.meeting = self.create_default_meeting()

        item = self.create_item(
            title="GPU procurement",
            notes="Discuss scope.",
        )

        self.assertEqual(item.title, "GPU procurement")
        self.assertEqual(item.notes, "Discuss scope.")
        self.assertEqual(
            item.content,
            "GPU procurement\n\nDiscuss scope.",
        )

    def test_created_item_preserves_multiline_notes_in_content(self):
        self.meeting = self.create_default_meeting()

        notes = "line one\nline two\nline three"
        item = self.create_item(
            title="Multiline",
            notes=notes,
        )

        self.assertEqual(item.notes, notes)
        self.assertEqual(
            item.content,
            "Multiline\n\nline one\nline two\nline three",
        )

    def test_content_is_not_limited_to_the_title_length(self):
        self.meeting = self.create_default_meeting()

        long_notes = "x" * 500
        item = self.create_item(
            title="Long item",
            notes=long_notes,
        )

        self.assertGreater(len(item.content), 255)
        self.assertEqual(
            item.content,
            "Long item\n\n" + long_notes,
        )

    def test_update_title_rederives_content(self):
        self.meeting = self.create_default_meeting()
        item = self.create_item(
            title="Old title",
            notes="Context.",
        )

        update_meeting_item(
            meeting_item=item,
            actor=self.alex,
            title="New title",
        )
        item.refresh_from_db()

        self.assertEqual(item.title, "New title")
        self.assertEqual(item.notes, "Context.")
        self.assertEqual(item.content, "New title\n\nContext.")

    def test_update_notes_rederives_content(self):
        self.meeting = self.create_default_meeting()
        item = self.create_item(
            title="Title",
            notes="First note.",
        )

        update_meeting_item(
            meeting_item=item,
            actor=self.alex,
            notes="Second note.",
        )
        item.refresh_from_db()

        self.assertEqual(item.title, "Title")
        self.assertEqual(item.notes, "Second note.")
        self.assertEqual(item.content, "Title\n\nSecond note.")

    def test_update_clearing_notes_drops_the_separator(self):
        self.meeting = self.create_default_meeting()
        item = self.create_item(
            title="Title",
            notes="Some context.",
        )

        update_meeting_item(
            meeting_item=item,
            actor=self.alex,
            notes="",
        )
        item.refresh_from_db()

        self.assertEqual(item.notes, "")
        self.assertEqual(item.content, "Title")

    def test_update_whitespace_only_notes_counts_as_absent(self):
        self.meeting = self.create_default_meeting()
        item = self.create_item(title="Title")

        update_meeting_item(
            meeting_item=item,
            actor=self.alex,
            notes="   ",
        )
        item.refresh_from_db()

        self.assertEqual(item.notes, "")
        self.assertEqual(item.content, "Title")

    def test_update_touching_only_one_field_keeps_the_other(self):
        self.meeting = self.create_default_meeting()
        item = self.create_item(
            title="Original title",
            notes="Original notes.",
        )

        update_meeting_item(
            meeting_item=item,
            actor=self.alex,
            title="Renamed title",
            notes="Renamed notes.",
        )
        item.refresh_from_db()

        self.assertEqual(item.title, "Renamed title")
        self.assertEqual(item.notes, "Renamed notes.")
        self.assertEqual(
            item.content,
            "Renamed title\n\nRenamed notes.",
        )


class MeetingItemTitleDerivationTest(SimpleTestCase):
    """Deterministic title derivation from canonical Markdown content."""

    def test_plain_line(self):
        self.assertEqual(
            derive_meeting_item_title("Discuss the budget"),
            "Discuss the budget",
        )

    def test_atx_heading_markers_are_stripped(self):
        for level in range(1, 7):
            self.assertEqual(
                derive_meeting_item_title(
                    f"{'#' * level} Budget review"
                ),
                "Budget review",
            )

    def test_atx_closing_sequence_is_stripped(self):
        self.assertEqual(
            derive_meeting_item_title("## Closing ##"),
            "Closing",
        )

    def test_inline_formatting_is_stripped(self):
        self.assertEqual(
            derive_meeting_item_title("**Bold** and *italic* end"),
            "Bold and italic end",
        )
        self.assertEqual(
            derive_meeting_item_title("~~Struck~~ sample"),
            "Struck sample",
        )

    def test_code_spans_keep_their_text(self):
        self.assertEqual(
            derive_meeting_item_title("`code` sample"),
            "code sample",
        )

    def test_links_and_images_keep_visible_text(self):
        self.assertEqual(
            derive_meeting_item_title(
                "[Forecast](https://example.org)"
            ),
            "Forecast",
        )
        self.assertEqual(
            derive_meeting_item_title("![Diagram](img.png)"),
            "Diagram",
        )

    def test_list_markers_are_stripped(self):
        self.assertEqual(
            derive_meeting_item_title("- First bullet"),
            "First bullet",
        )
        self.assertEqual(
            derive_meeting_item_title("1. Step one"),
            "Step one",
        )
        self.assertEqual(
            derive_meeting_item_title("12) Step twelve"),
            "Step twelve",
        )

    def test_task_list_checkboxes_are_stripped(self):
        self.assertEqual(
            derive_meeting_item_title("- [x] Done task"),
            "Done task",
        )
        self.assertEqual(
            derive_meeting_item_title("1. [ ] Open task"),
            "Open task",
        )

    def test_blockquote_prefix_is_stripped(self):
        self.assertEqual(
            derive_meeting_item_title("> Quoted line"),
            "Quoted line",
        )

    def test_first_meaningful_line_wins(self):
        self.assertEqual(
            derive_meeting_item_title("\n\n## After blanks"),
            "After blanks",
        )
        self.assertEqual(
            derive_meeting_item_title("---\n\n## Title"),
            "Title",
        )

    def test_lines_without_meaningful_text_yield_none(self):
        for content in (
            "",
            "   ",
            "\n  \n",
            "---",
            "***",
            "___",
            "=====",
            "##",
            "###",
            "**",
            "```\ncode\n```",
            "- ",
        ):
            with self.subTest(content=content):
                self.assertIsNone(derive_meeting_item_title(content))

    def test_derivation_never_invents_text(self):
        # Only syntax, no visible text: no title is invented.
        self.assertIsNone(derive_meeting_item_title("```\n```\n~~~"))

    def test_long_lines_are_truncated_to_the_title_limit(self):
        long_text = "w" * 300
        derived = derive_meeting_item_title(long_text)
        self.assertEqual(len(derived), 255)
        self.assertEqual(derived, "w" * 255)

    def test_truncation_rstrips_trailing_whitespace(self):
        text = ("w" * 250) + "   "
        derived = derive_meeting_item_title(text)
        self.assertEqual(derived, "w" * 250)

    def test_derivation_is_deterministic(self):
        content = "## A\n\n- b\n"
        self.assertEqual(
            derive_meeting_item_title(content),
            derive_meeting_item_title(content),
        )


class MeetingItemContentWriteContractTest(TestCase):
    """Canonical Markdown content writes at the service layer.

    ``content`` is the authoritative write field: it is stored
    verbatim, the title is derived, the notes compatibility value is
    empty, and legacy title/notes writes against a content-authored
    item are rejected explicitly (docs/domain/meetings.md §17).
    """

    def setUp(self):
        self.alex = User.objects.create_user(
            username="alex-content-write",
            password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Content Write Research Group",
            created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.scheduled_at = (
            timezone.now() + timedelta(days=1)
        )
        self.meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="FG Weekly",
            scheduled_at=self.scheduled_at,
        )

    def create_item(self, **kwargs):
        return create_meeting_item(
            meeting=self.meeting,
            meeting_section=MeetingSection.objects.get(
                meeting=self.meeting,
            ),
            actor=self.alex,
            **kwargs,
        )

    # ── Content-based creation ─────────────────────────────────

    def test_create_with_content_stores_it_verbatim(self):
        content = "## Budget review\n\nLong **body**."
        item = self.create_item(content=content)

        self.assertEqual(item.content, content)
        self.assertEqual(item.title, "Budget review")
        self.assertEqual(item.notes, "")
        self.assertTrue(meeting_item_is_content_authored(item))

    def test_create_with_content_only_needs_no_title_or_notes(self):
        item = self.create_item(content="Plain discussion.")

        self.assertEqual(item.title, "Plain discussion.")
        self.assertEqual(item.notes, "")
        # A single plain line is fully represented by the legacy
        # pair, so the item is NOT content-authored: legacy writes
        # on it stay lossless.
        self.assertFalse(meeting_item_is_content_authored(item))

    def test_create_with_neither_title_nor_content_is_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self.create_item()

    def test_create_with_both_contracts_is_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self.create_item(
                title="First",
                content="## First",
            )
        self.assertFalse(
            MeetingItem.objects.filter(
                meeting=self.meeting,
            ).exists()
        )

    def test_create_with_empty_or_whitespace_content_is_rejected(self):
        for content in ["", "   ", "\n\n"]:
            with self.subTest(content=content):
                with self.assertRaises(MeetingDomainError):
                    self.create_item(content=content)
        self.assertFalse(
            MeetingItem.objects.filter(
                meeting=self.meeting,
            ).exists()
        )

    def test_create_with_underivable_content_is_rejected(self):
        with self.assertRaises(MeetingDomainError):
            self.create_item(content="---\n***")
        self.assertFalse(
            MeetingItem.objects.filter(
                meeting=self.meeting,
            ).exists()
        )

    def test_create_with_long_content_is_not_truncated(self):
        content = "## Head\n\n" + "paragraph line.\n" * 100
        item = self.create_item(content=content)

        self.assertGreater(len(item.content), 255)
        self.assertEqual(item.content, content)
        self.assertLessEqual(len(item.title), 255)

    # ── Content-based updates ──────────────────────────────────

    def test_update_with_content_replaces_it_verbatim(self):
        item = self.create_item(title="Legacy", notes="Old.")

        new_content = "## Rewritten\n\nNew **body**."
        update_meeting_item(
            meeting_item=item,
            actor=self.alex,
            content=new_content,
        )
        item.refresh_from_db()

        self.assertEqual(item.content, new_content)
        self.assertEqual(item.title, "Rewritten")
        self.assertEqual(item.notes, "")
        self.assertTrue(meeting_item_is_content_authored(item))

    def test_update_with_content_repeated_writes_have_no_drift(self):
        item = self.create_item(content="## One")

        for expected in ("## One\n\nBody.", "## One\n\nBody v2."):
            update_meeting_item(
                meeting_item=item,
                actor=self.alex,
                content=expected,
            )
            item.refresh_from_db()
            self.assertEqual(item.content, expected)

    def test_update_with_empty_content_is_rejected(self):
        item = self.create_item(title="Legacy")

        with self.assertRaises(MeetingDomainError):
            update_meeting_item(
                meeting_item=item,
                actor=self.alex,
                content="   ",
            )

        item.refresh_from_db()
        self.assertEqual(item.content, "Legacy")

    def test_update_with_underivable_content_is_rejected(self):
        item = self.create_item(title="Legacy")

        with self.assertRaises(MeetingDomainError):
            update_meeting_item(
                meeting_item=item,
                actor=self.alex,
                content="---",
            )

        item.refresh_from_db()
        self.assertEqual(item.content, "Legacy")

    def test_update_with_both_contracts_is_rejected(self):
        item = self.create_item(title="Legacy")

        with self.assertRaises(MeetingDomainError):
            update_meeting_item(
                meeting_item=item,
                actor=self.alex,
                content="## New",
                title="New",
            )

        item.refresh_from_db()
        self.assertEqual(item.content, "Legacy")

    # ── Legacy writes against content-authored items ───────────

    def _content_authored_item(self):
        return self.create_item(
            content="## Budget review\n\nLong **markdown** body.",
        )

    def test_legacy_title_update_of_content_authored_item_is_rejected(self):
        item = self._content_authored_item()
        before = (item.title, item.notes, item.content)

        with self.assertRaises(MeetingDomainError):
            update_meeting_item(
                meeting_item=item,
                actor=self.alex,
                title="Something else",
            )

        item.refresh_from_db()
        self.assertEqual(
            (item.title, item.notes, item.content),
            before,
        )

    def test_legacy_notes_update_of_content_authored_item_is_rejected(self):
        item = self._content_authored_item()
        before = (item.title, item.notes, item.content)

        with self.assertRaises(MeetingDomainError):
            update_meeting_item(
                meeting_item=item,
                actor=self.alex,
                notes="A legacy note",
            )

        item.refresh_from_db()
        self.assertEqual(
            (item.title, item.notes, item.content),
            before,
        )

    def test_legacy_update_of_legacy_item_still_works(self):
        item = self.create_item(title="Legacy", notes="Old.")
        self.assertFalse(meeting_item_is_content_authored(item))

        update_meeting_item(
            meeting_item=item,
            actor=self.alex,
            title="Legacy (v2)",
        )
        item.refresh_from_db()

        self.assertEqual(item.title, "Legacy (v2)")
        self.assertEqual(item.notes, "Old.")
        self.assertEqual(item.content, "Legacy (v2)\n\nOld.")

    def test_empty_legacy_update_is_a_no_op_on_any_item(self):
        for item in (
            self.create_item(title="Legacy"),
            self._content_authored_item(),
        ):
            with self.subTest(title=item.title):
                before = (item.title, item.notes, item.content)
                update_meeting_item(
                    meeting_item=item,
                    actor=self.alex,
                )
                item.refresh_from_db()
                self.assertEqual(
                    (item.title, item.notes, item.content),
                    before,
                )
