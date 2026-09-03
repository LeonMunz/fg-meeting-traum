"""Backend tests for the persistent Meeting Note domain model and API.

Covers:
- authorized create / update / delete
- author cannot be spoofed
- unauthorized create / update / delete rejected
- inaccessible Notes do not leak
- empty Note rejected
- Note associated with the correct MeetingItem
- MeetingItem / Meeting deletion cascades
- lifecycle transitions: upcoming rejects, live allows, completed read-only
- Notes survive lifecycle transitions and reload
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from rest_framework import status
from rest_framework.test import APIClient

from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from .models import (
    Meeting,
    MeetingItem,
    MeetingNote,
    MeetingSection,
)
from .services import (
    MeetingDomainError,
    create_meeting,
    create_meeting_item,
    delete_meeting,
    delete_meeting_note,
    end_meeting,
    list_meeting_item_notes,
    start_meeting,
    update_meeting_item,
    update_meeting_note,
)


User = get_user_model()


class MeetingNoteApiTest(TestCase):
    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="note-api-alex",
            password="Pass1!",
            first_name="Alex",
        )
        self.chris = User.objects.create_user(
            username="note-api-chris",
            password="Pass1!",
            first_name="Chris",
        )
        self.maria = User.objects.create_user(
            username="note-api-maria",
            password="Pass1!",
            first_name="Maria",
        )

        self.group = ResearchGroup.objects.create(
            name="Note API Group",
            created_by=self.alex,
        )

        for user, role in [
            (self.alex, ResearchGroupMembership.Role.ADMIN),
            (self.chris, ResearchGroupMembership.Role.MEMBER),
        ]:
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=role,
            )

        self.scheduled_at = (
            timezone.now().replace(microsecond=0) + timedelta(days=1)
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def _make_live_meeting(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Live Weekly",
            scheduled_at=self.scheduled_at,
        )
        start_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        return meeting

    def _make_item(self, meeting, title="Discussion"):
        return create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.get(meeting=meeting),
            actor=self.alex,
            title=title,
        )

    # ── create ────────────────────────────────────────────────

    def test_authorized_user_can_create_note_in_live_meeting(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.chris)

        response = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "Agreed to ship Friday."},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )

        payload = response.json()
        self.assertEqual(payload["content"], "Agreed to ship Friday.")
        self.assertEqual(payload["meetingItemId"], item.pk)
        self.assertEqual(payload["author"]["id"], self.chris.pk)
        self.assertEqual(payload["author"]["firstName"], "Chris")
        self.assertTrue(payload["createdAt"])
        self.assertTrue(payload["updatedAt"])

        # The Note is persisted and retrievable via a fresh request.
        self.assertEqual(
            MeetingNote.objects.filter(
                meeting_item=item,
                author=self.chris,
            ).count(),
            1,
        )

    def test_note_author_is_derived_from_authenticated_request(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.chris)

        # A client-supplied author field is ignored / rejected.
        response = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {
                "content": "Hello",
                "author": self.alex.pk,
            },
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )
        self.assertEqual(
            response.json()["author"]["id"],
            self.chris.pk,
        )

    def test_unauthenticated_cannot_create_note(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.client.logout()

        response = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "Hello"},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_401_UNAUTHORIZED,
        )

    def test_group_non_member_cannot_create_note(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.maria)

        response = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "Hello"},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_empty_note_content_is_rejected(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)

        for content in ["", "   ", "\n\t"]:
            response = self.client.post(
                f"/api/meeting-items/{item.pk}/notes/",
                {"content": content},
                format="json",
            )

            self.assertEqual(
                response.status_code,
                status.HTTP_400_BAD_REQUEST,
            )

        self.assertEqual(
            MeetingNote.objects.filter(
                meeting_item=item,
            ).count(),
            0,
        )

    def test_note_is_attached_to_correct_meeting_item(self):
        meeting = self._make_live_meeting()
        first = self._make_item(meeting, title="First")
        second = self._make_item(meeting, title="Second")

        self.login(self.alex)

        response = self.client.post(
            f"/api/meeting-items/{first.pk}/notes/",
            {"content": "About the first item"},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_201_CREATED,
        )
        self.assertEqual(
            response.json()["meetingItemId"],
            first.pk,
        )
        self.assertEqual(
            MeetingNote.objects.filter(
                meeting_item=second,
            ).count(),
            0,
        )

    def test_upcoming_meeting_rejects_note_create(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Upcoming Weekly",
            scheduled_at=self.scheduled_at,
        )
        item = self._make_item(meeting)

        self.login(self.alex)

        response = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "Too early"},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_completed_meeting_rejects_note_create(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)
        end_meeting(meeting=meeting, actor=self.alex)

        self.login(self.alex)

        response = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "Too late"},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    # ── list / read ───────────────────────────────────────────

    def test_list_notes_returns_deterministic_order(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        first_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "first"},
            format="json",
        ).json()["id"]

        self.login(self.chris)
        second_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "second"},
            format="json",
        ).json()["id"]

        self.login(self.alex)
        response = self.client.get(
            f"/api/meeting-items/{item.pk}/notes/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        ids = [note["id"] for note in response.json()]
        self.assertEqual(ids, [first_id, second_id])

    def test_inaccessible_note_does_not_leak(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        note_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "private"},
            format="json",
        ).json()["id"]

        # A non-member cannot read the Note by id (404, not 403).
        self.login(self.maria)
        response = self.client.get(f"/api/meeting-notes/{note_id}/")
        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

        # Nor can they list Notes on the MeetingItem.
        response = self.client.get(
            f"/api/meeting-items/{item.pk}/notes/"
        )
        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_completed_meeting_notes_are_readable(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "protocol line"},
            format="json",
        )

        end_meeting(meeting=meeting, actor=self.alex)

        # Fresh request after the transition: the Note is still returned.
        response = self.client.get(
            f"/api/meeting-items/{item.pk}/notes/"
        )
        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(len(response.json()), 1)
        self.assertEqual(
            response.json()[0]["content"],
            "protocol line",
        )

    def test_completed_meeting_notes_returned_in_item_list(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "protocol line"},
            format="json",
        )
        end_meeting(meeting=meeting, actor=self.alex)

        # A fresh GET of the Meeting item list still includes the Note,
        # proving persistence across a simulated reload.
        response = self.client.get(
            f"/api/meetings/{meeting.pk}/items/"
        )
        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )

        serialized = response.json()[0]
        self.assertEqual(
            serialized["notes"][0]["content"],
            "protocol line",
        )

    # ── update ────────────────────────────────────────────────

    def test_authorized_user_can_update_note(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.chris)
        note_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "original"},
            format="json",
        ).json()["id"]

        response = self.client.patch(
            f"/api/meeting-notes/{note_id}/",
            {"content": "edited"},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(
            response.json()["content"],
            "edited",
        )

        # Original author is preserved.
        self.assertEqual(
            response.json()["author"]["id"],
            self.chris.pk,
        )

    def test_update_persists(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        note_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "one"},
            format="json",
        ).json()["id"]

        self.client.patch(
            f"/api/meeting-notes/{note_id}/",
            {"content": "two"},
            format="json",
        )

        note = MeetingNote.objects.get(pk=note_id)
        self.assertEqual(note.content, "two")

    def test_update_empty_content_is_rejected(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        note_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "one"},
            format="json",
        ).json()["id"]

        response = self.client.patch(
            f"/api/meeting-notes/{note_id}/",
            {"content": "   "},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_completed_meeting_note_update_is_rejected(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        note_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "one"},
            format="json",
        ).json()["id"]

        end_meeting(meeting=meeting, actor=self.alex)

        response = self.client.patch(
            f"/api/meeting-notes/{note_id}/",
            {"content": "two"},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_non_member_cannot_update_note(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        note_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "one"},
            format="json",
        ).json()["id"]

        self.login(self.maria)
        response = self.client.patch(
            f"/api/meeting-notes/{note_id}/",
            {"content": "two"},
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    # ── delete ────────────────────────────────────────────────

    def test_authorized_user_can_delete_note(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        note_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "one"},
            format="json",
        ).json()["id"]

        response = self.client.delete(
            f"/api/meeting-notes/{note_id}/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertFalse(
            MeetingNote.objects.filter(pk=note_id).exists()
        )

        # The MeetingItem itself survives.
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )

    def test_delete_removes_only_the_note(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        first_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "first"},
            format="json",
        ).json()["id"]
        second_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "second"},
            format="json",
        ).json()["id"]

        self.client.delete(f"/api/meeting-notes/{first_id}/")

        self.assertFalse(
            MeetingNote.objects.filter(pk=first_id).exists()
        )
        self.assertTrue(
            MeetingNote.objects.filter(pk=second_id).exists()
        )
        self.assertTrue(
            MeetingItem.objects.filter(pk=item.pk).exists()
        )
        self.assertTrue(
            Meeting.objects.filter(pk=meeting.pk).exists()
        )

    def test_completed_meeting_note_delete_is_rejected(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        note_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "one"},
            format="json",
        ).json()["id"]

        end_meeting(meeting=meeting, actor=self.alex)

        response = self.client.delete(
            f"/api/meeting-notes/{note_id}/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertTrue(
            MeetingNote.objects.filter(pk=note_id).exists()
        )

    def test_non_member_cannot_delete_note(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        note_id = self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "one"},
            format="json",
        ).json()["id"]

        self.login(self.maria)
        response = self.client.delete(
            f"/api/meeting-notes/{note_id}/"
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertTrue(
            MeetingNote.objects.filter(pk=note_id).exists()
        )

    # ── cascades ──────────────────────────────────────────────

    def test_meeting_item_deletion_cascades_notes(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)
        item_pk = item.pk

        self.login(self.alex)
        self.client.post(
            f"/api/meeting-items/{item_pk}/notes/",
            {"content": "one"},
            format="json",
        )
        self.client.post(
            f"/api/meeting-items/{item_pk}/notes/",
            {"content": "two"},
            format="json",
        )
        self.assertEqual(
            MeetingNote.objects.filter(
                meeting_item_id=item_pk,
            ).count(),
            2,
        )

        MeetingItem.objects.filter(pk=item_pk).delete()

        self.assertEqual(
            MeetingNote.objects.filter(
                meeting_item_id=item_pk,
            ).count(),
            0,
        )

    def test_meeting_deletion_cascades_notes(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)
        meeting_pk = meeting.pk

        self.login(self.alex)
        self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "one"},
            format="json",
        )

        delete_meeting(meeting=meeting, actor=self.alex)

        self.assertEqual(
            MeetingNote.objects.filter(
                meeting_item__meeting_id=meeting_pk,
            ).count(),
            0,
        )

    # ── lifecycle survival ────────────────────────────────────

    def test_notes_survive_live_to_completed_transition(self):
        meeting = self._make_live_meeting()
        item = self._make_item(meeting)

        self.login(self.alex)
        self.client.post(
            f"/api/meeting-items/{item.pk}/notes/",
            {"content": "decision recorded"},
            format="json",
        )

        end_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        self.assertEqual(
            meeting.status,
            Meeting.Status.COMPLETED,
        )

        notes = list_meeting_item_notes(
            meeting_item=item,
            user=self.alex,
        )
        self.assertEqual(len(notes), 1)
        self.assertEqual(
            notes[0].content,
            "decision recorded",
        )


class MeetingNoteServiceTest(TestCase):
    """Service-layer invariants that do not exercise HTTP."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="note-svc-alex",
            password="Pass1!",
            first_name="Alex",
        )
        self.group = ResearchGroup.objects.create(
            name="Note Svc Group",
            created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )

        self.scheduled_at = (
            timezone.now().replace(microsecond=0) + timedelta(days=1)
        )

    def _live(self):
        meeting = create_meeting(
            research_group=self.group,
            actor=self.alex,
            title="Svc Live",
            scheduled_at=self.scheduled_at,
        )
        start_meeting(meeting=meeting, actor=self.alex)
        meeting.refresh_from_db()
        return meeting

    def test_service_create_strips_whitespace(self):
        meeting = self._live()
        item = self._item(meeting)

        note = self._note(item, "   hello   ")
        self.assertEqual(note.content, "hello")

    def test_service_create_rejects_whitespace_only(self):
        meeting = self._live()
        item = self._item(meeting)

        with self.assertRaises(MeetingDomainError):
            self._note(item, "   \n\t")

    def _item(self, meeting, title="Discussion"):
        return create_meeting_item(
            meeting=meeting,
            meeting_section=MeetingSection.objects.get(meeting=meeting),
            actor=self.alex,
            title=title,
        )

    def _note(self, item, content):
        from .services import create_meeting_note

        return create_meeting_note(
            meeting_item=item,
            actor=self.alex,
            content=content,
        )
