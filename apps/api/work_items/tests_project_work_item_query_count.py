"""Query-count regression for ``GET /api/projects/{id}/work-items/``.

The Project Work Item list read path must not add one query per
returned Work Item: the serialized relations (Project, creator,
parent, type definition, status definition) are eager-loaded with
``select_related``, assignees and labels with ``prefetch_related``,
and the note-backed Meeting origin links with ONE bulk query per
request (not one per Work Item). The permission-filtered Meeting
origin resolution must not reintroduce a per-item N+1 either — the
Meeting read-access check for every origin on the page is resolved
with a constant number of membership queries per request.

These tests pin the scaling behavior with ``CaptureQueriesContext``
(behavioral, not source-string assertions) and additionally pin the
payload/authorization contract so the optimization stays internal.
"""

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from meetings.models import Meeting, MeetingSection
from meetings.services import (
    add_meeting_participant,
    create_meeting,
    create_meeting_item,
    create_meeting_note,
    create_work_item_from_meeting_item,
    start_meeting,
)
from projects.models import ProjectMembership, WorkItemLabelDefinition
from projects.services import add_project_membership, create_project
from research_groups.models import ResearchGroup, ResearchGroupMembership

from .services import create_work_item

User = get_user_model()

PASSWORD = "PwqcPass1!"


# ── Shared scenario ────────────────────────────────────────────────


def _build_scenario():
    """Alex (Project owner) + Chris (Project member) in one Group.

    Returns (alex, chris, group, project, label, task_type).
    """
    alex = User.objects.create_user(
        username="pwqc_alex", password=PASSWORD,
    )
    chris = User.objects.create_user(
        username="pwqc_chris", password=PASSWORD,
    )
    group = ResearchGroup.objects.create(
        name="PWQC Group", created_by=alex,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=alex,
        role=ResearchGroupMembership.Role.ADMIN,
    )
    ResearchGroupMembership.objects.create(
        research_group=group, user=chris,
        role=ResearchGroupMembership.Role.MEMBER,
    )
    project = create_project(
        research_group=group, creator=alex, name="PWQC Project",
    )
    add_project_membership(
        project=project, actor=alex, target_user=chris,
        role=ProjectMembership.Role.MEMBER,
    )
    label = WorkItemLabelDefinition.objects.create(
        project=project, name="PWQC Label",
    )
    task_type = project.type_definitions.get(name="Task")
    return alex, chris, group, project, label, task_type


class _ProjectWorkItemListBase(APITestCase):
    """Common fixture: one Project, owner Alex, member Chris."""

    @classmethod
    def setUpTestData(cls):
        (
            cls.alex,
            cls.chris,
            cls.group,
            cls.project,
            cls.label,
            cls.task_type,
        ) = _build_scenario()

    def setUp(self):
        self.client = APIClient()
        self.url = f"/api/projects/{self.project.pk}/work-items/"

    def _login(self, username):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        response = self.client.post(
            "/api/auth/login/",
            data={"username": username, "password": PASSWORD},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)

    def _make_plain_work_item(self, index):
        """A Work Item with an assignee + label and NO Meeting origin."""
        return create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.task_type.pk,
            title=f"PWQC plain {index}",
            assignee_ids=[self.alex.pk],
            label_definition_ids=[self.label.pk],
        )

    def _make_origin_work_item(
        self,
        index,
        *,
        creator,
        scope=Meeting.Scope.GROUP,
        add_alex_as_participant=True,
    ):
        """A Work Item whose note-backed origin is a DISTINCT Meeting.

        ``creator`` is the Meeting creator. When the reader (Alex) is
        not the creator, ``add_alex_as_participant`` makes Alex an
        explicit participant so the canonical Meeting read path is
        exercised through the participant relation (not the creator
        short-circuit).
        """
        meeting = create_meeting(
            research_group=self.group,
            actor=creator,
            title=f"PWQC origin meeting {index}",
            scheduled_at=timezone.now(),
            scope=scope,
            project=(
                self.project if scope == Meeting.Scope.PROJECT else None
            ),
        )
        if (
            add_alex_as_participant
            and creator.pk != self.alex.pk
        ):
            add_meeting_participant(
                meeting=meeting,
                actor=creator,
                target_user=self.alex,
            )
        start_meeting(meeting=meeting, actor=creator)
        meeting.refresh_from_db()
        section = MeetingSection.objects.get(meeting=meeting)
        item = create_meeting_item(
            meeting=meeting,
            meeting_section=section,
            actor=creator,
            title=f"PWQC origin item {index}",
        )
        note = create_meeting_note(
            meeting_item=item,
            actor=creator,
            content=f"PWQC origin note {index}",
        )
        return create_work_item_from_meeting_item(
            meeting_item=item,
            project=self.project,
            actor=creator,
            type_definition_id=self.task_type.pk,
            title=f"PWQC origin work {index}",
            meeting_note=note,
            assignee_ids=[self.alex.pk],
            label_definition_ids=[self.label.pk],
        )


# ── Query-count regression ────────────────────────────────────────


class ProjectWorkItemQueryCountTest(_ProjectWorkItemListBase):
    """The Project Work Item list must not scale its SQL query count
    with the number of returned Work Items."""

    def _login_as_alex(self):
        self._login("pwqc_alex")

    def test_query_count_does_not_scale_with_work_item_count(self):
        # Every Work Item carries the full serialized relation set
        # (assignee + label + definitions) AND a note-backed Meeting
        # origin from a DISTINCT group Meeting where Alex is an
        # explicit participant — the worst case for both the relation
        # N+1 and the permission-filtered origin N+1.
        #
        # Request 1: 2 Work Items.
        self._make_origin_work_item(1, creator=self.chris)
        self._make_origin_work_item(2, creator=self.chris)
        self._login_as_alex()

        with CaptureQueriesContext(connection) as small_ctx:
            small_response = self.client.get(self.url)
        self.assertEqual(small_response.status_code, 200)
        small_payload = small_response.json()
        self.assertEqual(len(small_payload), 2)

        # Request 2: 14 Work Items (7x the rows, identical shape,
        # each with its own origin Meeting).
        for index in range(3, 15):
            self._make_origin_work_item(index, creator=self.chris)

        with CaptureQueriesContext(connection) as large_ctx:
            large_response = self.client.get(self.url)
        self.assertEqual(large_response.status_code, 200)
        large_payload = large_response.json()
        self.assertEqual(len(large_payload), 14)

        # 7x the rows add ZERO queries — a per-row relation lookup
        # (type/status definition, assignee, label) or a per-item
        # Meeting origin / permission check would make the second
        # request issue 12+ more queries.
        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "Project Work Item list query count must not scale with "
            "the returned row count; every serialized relation "
            "(type definition, status definition, assignees, labels) "
            "and the permission-filtered Meeting origin check must be "
            "eager-loaded or bulk-fetched per request.",
        )

        # The response is not merely cheaper — it is unchanged: the
        # two items from the small request appear verbatim (same IDs,
        # same field values, same order) inside the large response.
        large_by_id = {item["id"]: item for item in large_payload}
        for small_item in small_payload:
            self.assertEqual(
                large_by_id[small_item["id"]],
                small_item,
                "the optimized read path must return the identical "
                "payload for identical data.",
            )
        self.assertEqual(
            [item["id"] for item in small_payload],
            [item["id"] for item in large_payload[:2]],
        )

    def test_query_count_includes_origin_free_items(self):
        # Mix origin-backed and origin-free Work Items: items without
        # a note-backed origin must not add origin queries, and the
        # count must still be row-count invariant.
        self._make_origin_work_item(1, creator=self.chris)
        self._make_plain_work_item(1)
        self._login_as_alex()

        with CaptureQueriesContext(connection) as small_ctx:
            small_response = self.client.get(self.url)
        self.assertEqual(small_response.status_code, 200)
        self.assertEqual(len(small_response.json()), 2)

        for index in range(2, 7):
            if index % 2 == 0:
                self._make_origin_work_item(index, creator=self.chris)
            else:
                self._make_plain_work_item(index)

        with CaptureQueriesContext(connection) as large_ctx:
            large_response = self.client.get(self.url)
        self.assertEqual(large_response.status_code, 200)
        large_payload = large_response.json()
        # 2 initial (1 origin + 1 plain) + loop index 2..6 (origin on
        # even 2,4,6 and plain on odd 3,5) = 4 origin + 3 plain = 7.
        self.assertEqual(len(large_payload), 7)

        self.assertEqual(
            len(small_ctx.captured_queries),
            len(large_ctx.captured_queries),
            "origin-free Work Items must not change the constant "
            "query count of the Project Work Item list.",
        )


# ── Payload compatibility + authorization (unchanged contract) ─────


class ProjectWorkItemListContractTest(_ProjectWorkItemListBase):
    """The optimization is internal: payload fields, ordering, and the
    permission-filtered Meeting origin stay exactly as before."""

    def _item_by_title(self, payload, title):
        matches = [item for item in payload if item["title"] == title]
        self.assertEqual(len(matches), 1)
        return matches[0]

    def test_origin_payload_and_ordering_for_representative_mix(self):
        # A representative mix of origin shapes in ONE Project:
        #  - group Meeting, reader is the creator            (shown)
        #  - group Meeting, reader is an explicit participant (shown)
        #  - project Meeting, reader is an explicit participant (shown)
        #  - project Meeting, reader has NO read access      (hidden)
        #  - no origin                                       (null)
        # and one plain Work Item to pin Board ordering.
        shown_creator = self._make_origin_work_item(
            1, creator=self.alex, add_alex_as_participant=False,
        )
        shown_participant = self._make_origin_work_item(
            2, creator=self.chris,
        )
        shown_project = self._make_origin_work_item(
            3,
            creator=self.chris,
            scope=Meeting.Scope.PROJECT,
        )
        hidden_project = self._make_origin_work_item(
            4,
            creator=self.chris,
            scope=Meeting.Scope.PROJECT,
            add_alex_as_participant=False,
        )
        no_origin = self._make_plain_work_item(5)

        self._login("pwqc_alex")
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 5)

        # Board ordering: board_position ASC NULLS LAST, then
        # created_at, then id. All items are unsorted (NULL), so the
        # order is canonical creation order.
        self.assertEqual(
            [item["id"] for item in payload],
            [
                shown_creator.pk,
                shown_participant.pk,
                shown_project.pk,
                hidden_project.pk,
                no_origin.pk,
            ],
        )

        creator_item = self._item_by_title(
            payload, shown_creator.title,
        )
        # meetingOrigin is exposed: the reader created the Meeting.
        origin = creator_item["meetingOrigin"]
        self.assertIsNotNone(origin)
        self.assertEqual(origin["noteContent"], "PWQC origin note 1")
        self.assertEqual(origin["meetingItemTitle"],
                         "PWQC origin item 1")
        self.assertIsInstance(origin["meetingId"], int)
        self.assertIn("meetingTitle", origin)
        self.assertIn("scheduledAt", origin)

        participant_item = self._item_by_title(
            payload, shown_participant.title,
        )
        self.assertIsNotNone(participant_item["meetingOrigin"])
        self.assertEqual(
            participant_item["meetingOrigin"]["noteContent"],
            "PWQC origin note 2",
        )

        project_item = self._item_by_title(
            payload, shown_project.title,
        )
        self.assertIsNotNone(project_item["meetingOrigin"])
        self.assertEqual(
            project_item["meetingOrigin"]["noteContent"],
            "PWQC origin note 3",
        )

        # The project Meeting Alex is neither creator nor participant
        # of is NOT readable by Alex — the origin must stay hidden.
        hidden_item = self._item_by_title(
            payload, hidden_project.title,
        )
        self.assertIsNone(hidden_item["meetingOrigin"])

        # No note-backed origin at all.
        no_origin_item = self._item_by_title(payload, no_origin.title)
        self.assertIsNone(no_origin_item["meetingOrigin"])

        # Representative assignee + label + definition fields are
        # intact on every item; createdById reflects the actor that
        # created each item.
        created_by = {
            shown_creator.pk: self.alex.pk,
            shown_participant.pk: self.chris.pk,
            shown_project.pk: self.chris.pk,
            hidden_project.pk: self.chris.pk,
            no_origin.pk: self.alex.pk,
        }
        for item in payload:
            self.assertEqual(item["assigneeIds"], [self.alex.pk])
            self.assertEqual(item["labelDefinitionIds"], [self.label.pk])
            self.assertEqual(item["projectId"], self.project.pk)
            self.assertEqual(item["typeDefinitionId"], self.task_type.pk)
            self.assertIn("statusDefinitionId", item)
            self.assertIn("boardPosition", item)
            self.assertEqual(item["createdById"], created_by[item["id"]])

    def test_viewer_reads_list_without_extra_rights(self):
        # A viewer can READ the Project Work Item list but the read
        # grants no additional rights: a viewer is never an eligible
        # assignee and the list is the same permission-filtered set.
        laura = User.objects.create_user(
            username="pwqc_laura", password=PASSWORD,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=laura,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project, actor=self.alex, target_user=laura,
            role=ProjectMembership.Role.VIEWER,
        )
        origin_item = self._make_origin_work_item(1, creator=self.chris)
        plain = self._make_plain_work_item(2)

        self._login("pwqc_laura")
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 2)
        # The viewer sees exactly the same canonical items (no more,
        # no less) — reading the list never grants extra rights.
        self.assertEqual(
            {item["id"] for item in payload},
            {origin_item.pk, plain.pk},
        )

    def test_user_without_project_access_gets_non_leaking_404(self):
        outsider = User.objects.create_user(
            username="pwqc_outsider", password=PASSWORD,
        )
        # In the Research Group but WITHOUT a ProjectMembership.
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=outsider,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self._make_origin_work_item(1, creator=self.chris)

        self._login("pwqc_outsider")
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("PWQC", str(response.json()))


# ── Authorization kernel unchanged (owner / member reads) ──────────


class ProjectWorkItemListAuthorizationTest(_ProjectWorkItemListBase):
    """Owner and member keep reading the authorized Work Items."""

    def test_owner_and_member_see_the_same_items(self):
        a = self._make_origin_work_item(1, creator=self.chris)
        b = self._make_plain_work_item(2)

        self._login("pwqc_alex")
        owner_payload = self.client.get(self.url).json()

        self.client = APIClient()
        self._login("pwqc_chris")
        member_payload = self.client.get(self.url).json()

        self.assertEqual(
            [item["id"] for item in owner_payload],
            [item["id"] for item in member_payload],
        )
        self.assertEqual(
            {item["id"] for item in owner_payload},
            {a.pk, b.pk},
        )
