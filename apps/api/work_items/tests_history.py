"""Tests for WorkItem history: AuditEvent recording + the read-only
GET /api/work-items/{id}/history/ API.

AuditEvent.data["changes"] naming convention (documented here since the
task requires it be documented in tests — see work_items.services for
the implementation):

- title:         {"from": <str>, "to": <str>}
- description:   {"changed": True}                 (never stores bodies)
- type:          {"from": <str>, "to": <str>}
- status:        {"from": <str>, "to": <str>}
- dueDate:       {"from": <"YYYY-MM-DD" or None>, "to": <...>}
- blockedReason: {"from": <str or None>, "to": <str or None>}
                 (None == unblocked, matching canonical semantics)
- parent:        {"from": {"id": int, "title": str|None} | None,
                   "to": {"id": int, "title": str|None} | None}
- assignees:     {"added": [<user summary>, ...],
                   "removed": [<user summary>, ...]}
  user summary = {"id", "username", "firstName", "lastName"}

Only keys for fields that actually changed are present. A no-op update
(unchanged values, or only touching non-audited implementation fields
like completedAt/updatedAt) records NO AuditEvent at all.
"""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APITestCase

from audit_history.models import AuditEvent
from projects.services import create_project

from .models import WorkItem
from .services import (
    WorkItemDomainError,
    create_work_item,
    update_work_item,
)
from .tests_api import _AuthMixin, _setup_test_data

User = get_user_model()


def _events_for(work_item):
    """All AuditEvents for a WorkItem, oldest first (for readable diffs
    in assertions — the API itself returns newest first)."""
    return list(
        AuditEvent.objects
        .filter(work_item=work_item)
        .order_by("id")
    )


# ── Recording: create ──


class WorkItemCreateHistoryTest(TestCase):
    def test_create_records_exactly_one_created_event(self):
        data = _setup_test_data()
        alex = data["alex"]
        project = data["paper_xyz"]

        wi = create_work_item(
            project=project,
            actor=alex,
            type=WorkItem.Type.TASK,
            title="New Task",
        )

        events = _events_for(wi)
        self.assertEqual(len(events), 1)

        event = events[0]
        self.assertEqual(event.event_type, "work_item.created")
        self.assertEqual(event.actor, alex)
        self.assertEqual(event.project, project)
        self.assertEqual(
            event.research_group, project.research_group,
        )
        self.assertEqual(event.work_item, wi)
        # The event itself is sufficient — no WorkItem dump.
        self.assertEqual(event.data, {})


# ── Recording: update diffs ──


class WorkItemUpdateHistoryDiffTest(TestCase):
    def setUp(self):
        self.data = _setup_test_data()
        self.alex = self.data["alex"]
        self.chris = self.data["chris"]
        self.project = self.data["paper_xyz"]
        self.wi = create_work_item(
            project=self.project,
            actor=self.alex,
            type=WorkItem.Type.TASK,
            title="Original Title",
            description="Original body",
        )
        # One work_item.created event already exists at this point.

    def _latest_event(self, work_item):
        events = _events_for(work_item)
        return events[-1]

    def test_single_property_update_records_one_event_with_correct_diff(self):
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            status=WorkItem.Status.IN_PROGRESS,
        )

        events = _events_for(self.wi)
        self.assertEqual(len(events), 2)  # created + updated

        event = events[-1]
        self.assertEqual(event.event_type, "work_item.updated")
        self.assertEqual(event.actor, self.alex)
        self.assertEqual(
            event.data,
            {
                "changes": {
                    "status": {
                        "from": "todo",
                        "to": "in_progress",
                    },
                },
            },
        )

    def test_one_update_changing_multiple_properties_records_one_event(self):
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            title="Updated Title",
            status=WorkItem.Status.REVIEW,
            due_date="2026-08-21",
        )

        events = _events_for(self.wi)
        self.assertEqual(len(events), 2)

        changes = events[-1].data["changes"]
        self.assertEqual(
            set(changes.keys()),
            {"title", "status", "dueDate"},
        )
        self.assertEqual(
            changes["title"],
            {"from": "Original Title", "to": "Updated Title"},
        )
        self.assertEqual(
            changes["status"],
            {"from": "todo", "to": "review"},
        )
        self.assertEqual(
            changes["dueDate"],
            {"from": None, "to": "2026-08-21"},
        )

    def test_unchanged_value_creates_no_event(self):
        before_count = AuditEvent.objects.filter(
            work_item=self.wi,
        ).count()

        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            title="Original Title",  # identical to current value
            status=WorkItem.Status.TODO,  # identical to current value
        )

        after_count = AuditEvent.objects.filter(
            work_item=self.wi,
        ).count()
        self.assertEqual(before_count, after_count)

    def test_description_change_stores_only_changed_flag(self):
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            description="A completely different body with detail.",
        )

        changes = self._latest_event(self.wi).data["changes"]
        self.assertEqual(
            changes,
            {"description": {"changed": True}},
        )
        # No description body anywhere in the stored event.
        self.assertNotIn(
            "A completely different body with detail.",
            str(self._latest_event(self.wi).data),
        )

    def test_assignee_changes_captured_deterministically(self):
        # Start: no assignees. Assign chris and alex, deliberately
        # supplied in descending-id order — the diff must still come
        # out sorted ascending regardless of input/queryset order.
        unsorted_ids = sorted(
            [self.alex.pk, self.chris.pk], reverse=True,
        )
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            assignee_ids=unsorted_ids,
        )

        changes = self._latest_event(self.wi).data["changes"]
        added = changes["assignees"]["added"]
        self.assertEqual(len(added), 2)
        # Deterministic: sorted by user id ascending regardless of
        # the order assignee_ids was supplied in.
        self.assertEqual(
            [entry["id"] for entry in added],
            sorted([self.alex.pk, self.chris.pk]),
        )
        for entry in added:
            self.assertEqual(
                set(entry.keys()),
                {"id", "username", "firstName", "lastName"},
            )
        self.assertEqual(changes["assignees"]["removed"], [])

        # Now replace chris with nothing (only alex remains) —
        # chris should appear as removed.
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            assignee_ids=[self.alex.pk],
        )

        changes2 = self._latest_event(self.wi).data["changes"]
        self.assertEqual(changes2["assignees"]["added"], [])
        removed_ids = [
            entry["id"]
            for entry in changes2["assignees"]["removed"]
        ]
        self.assertEqual(removed_ids, [self.chris.pk])

    def test_blocked_reason_transitions_are_distinguishable(self):
        # null -> reason
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            blocked_reason="Waiting for ethics approval",
        )
        changes_a = self._latest_event(self.wi).data["changes"]
        self.assertEqual(
            changes_a["blockedReason"],
            {
                "from": None,
                "to": "Waiting for ethics approval",
            },
        )

        # reason -> a different (changed) reason
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            blocked_reason="Waiting for IRB approval",
        )
        changes_b = self._latest_event(self.wi).data["changes"]
        self.assertEqual(
            changes_b["blockedReason"],
            {
                "from": "Waiting for ethics approval",
                "to": "Waiting for IRB approval",
            },
        )

        # reason -> null (unblocked)
        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            blocked_reason=None,
        )
        changes_c = self._latest_event(self.wi).data["changes"]
        self.assertEqual(
            changes_c["blockedReason"],
            {
                "from": "Waiting for IRB approval",
                "to": None,
            },
        )

        # All three diffs must be distinguishable from one another.
        self.assertNotEqual(changes_a, changes_b)
        self.assertNotEqual(changes_b, changes_c)
        self.assertNotEqual(changes_a, changes_c)

    def test_parent_change_stores_identifying_summary(self):
        parent = create_work_item(
            project=self.project,
            actor=self.alex,
            type=WorkItem.Type.EPIC,
            title="Epic Parent",
        )

        update_work_item(
            work_item=self.wi,
            actor=self.alex,
            parent_id=parent.pk,
        )

        changes = self._latest_event(self.wi).data["changes"]
        self.assertEqual(
            changes["parent"],
            {
                "from": None,
                "to": {"id": parent.pk, "title": "Epic Parent"},
            },
        )

    def test_failed_update_creates_no_audit_event(self):
        before_count = AuditEvent.objects.filter(
            work_item=self.wi,
        ).count()

        with self.assertRaises(WorkItemDomainError):
            update_work_item(
                work_item=self.wi,
                actor=self.alex,
                # maria has no ProjectMembership in this project —
                # invalid assignee rolls the whole update back.
                assignee_ids=[self.data["maria"].pk],
            )

        after_count = AuditEvent.objects.filter(
            work_item=self.wi,
        ).count()
        self.assertEqual(before_count, after_count)

        # And the WorkItem itself is unchanged.
        self.wi.refresh_from_db()
        self.assertEqual(self.wi.title, "Original Title")


# ── Read API ──


class WorkItemHistoryApiTest(_AuthMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def _get_history(self, username, work_item):
        self._login(username)
        return self.client.get(
            f"/api/work-items/{work_item.pk}/history/"
        )

    def test_returns_newest_first(self):
        wi = self.data["work_item"]
        update_work_item(
            work_item=wi, actor=self.data["alex"], title="First Update",
        )
        update_work_item(
            work_item=wi, actor=self.data["alex"], title="Second Update",
        )

        response = self._get_history("alex", wi)
        self.assertEqual(response.status_code, 200)

        body = response.json()
        self.assertEqual(len(body), 3)  # created + 2 updates
        self.assertEqual(
            [entry["eventType"] for entry in body],
            [
                "work_item.updated",
                "work_item.updated",
                "work_item.created",
            ],
        )
        self.assertEqual(
            body[0]["changes"]["title"]["to"], "Second Update",
        )
        self.assertEqual(
            body[1]["changes"]["title"]["to"], "First Update",
        )

    def test_response_shape(self):
        wi = self.data["work_item"]
        response = self._get_history("alex", wi)
        body = response.json()

        self.assertEqual(len(body), 1)
        entry = body[0]
        self.assertEqual(
            set(entry.keys()),
            {"id", "eventType", "actor", "changes", "createdAt"},
        )
        self.assertEqual(entry["eventType"], "work_item.created")
        self.assertEqual(
            entry["actor"],
            {
                "id": self.data["alex"].pk,
                "username": "alex",
                "firstName": "",
                "lastName": "",
            },
        )
        self.assertEqual(entry["changes"], {})

    def test_owner_can_read_history(self):
        response = self._get_history("alex", self.data["work_item"])
        self.assertEqual(response.status_code, 200)

    def test_member_can_read_history(self):
        response = self._get_history("chris", self.data["work_item"])
        self.assertEqual(response.status_code, 200)

    def test_viewer_can_read_history_matching_work_item_read_permission(self):
        # WorkItemDetailView.get allows owner/member/viewer — history
        # must match exactly.
        response = self._get_history("laura", self.data["work_item"])
        self.assertEqual(response.status_code, 200)

    def test_no_project_membership_cannot_read_history(self):
        response = self._get_history("maria", self.data["work_item"])
        self.assertEqual(response.status_code, 404)

    def test_anonymous_cannot_read_history(self):
        response = self.client.get(
            f"/api/work-items/{self.data['work_item'].pk}/history/"
        )
        self.assertEqual(response.status_code, 401)

    def test_history_is_scoped_to_the_requested_work_item_only(self):
        wi_a = self.data["work_item"]
        wi_b = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Work Item B",
        )
        update_work_item(
            work_item=wi_b, actor=self.data["alex"], title="B Renamed",
        )

        response_a = self._get_history("alex", wi_a)
        response_b = self._get_history("alex", wi_b)

        ids_a = {entry["id"] for entry in response_a.json()}
        ids_b = {entry["id"] for entry in response_b.json()}

        self.assertEqual(len(response_a.json()), 1)
        self.assertEqual(len(response_b.json()), 2)
        self.assertTrue(ids_a.isdisjoint(ids_b))

        for entry in response_a.json():
            self.assertNotIn("B Renamed", str(entry))
        for entry in response_b.json():
            self.assertNotIn("Rewrite Introduction", str(entry))

    def test_history_bounded_to_explicit_limit_newest_first(self):
        from work_items.views import WorkItemHistoryView

        limit = WorkItemHistoryView.HISTORY_LIMIT
        wi = self.data["work_item"]

        # 1 created event already exists; add enough updates to
        # exceed the bound.
        for i in range(limit + 5):
            update_work_item(
                work_item=wi,
                actor=self.data["alex"],
                title=f"Title {i}",
            )

        response = self._get_history("alex", wi)
        body = response.json()

        self.assertEqual(len(body), limit)
        # Newest first: the very last update made ("Title {limit+4}")
        # must be first in the response.
        self.assertEqual(
            body[0]["changes"]["title"]["to"],
            f"Title {limit + 4}",
        )


class WorkItemHistoryAdminIsolationTest(_AuthMixin, APITestCase):
    """Research Group admin status must not bypass private Project
    membership — matching WorkItemAdminIsolationTest for plain reads."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        cls.maria_project = create_project(
            research_group=cls.data["group"],
            creator=cls.data["maria"],
            name="Maria Private Project",
        )
        cls.maria_wi = create_work_item(
            project=cls.maria_project,
            actor=cls.data["maria"],
            type=WorkItem.Type.TASK,
            title="Maria Secret Task",
        )

    def test_admin_without_project_membership_cannot_read_history(self):
        self._login("alex")
        response = self.client.get(
            f"/api/work-items/{self.maria_wi.pk}/history/"
        )
        self.assertEqual(response.status_code, 404)
