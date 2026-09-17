"""Status-only transition (preserves project-local board position) tests.

Verifies the canonical Work Item status-only transition capability
(`transition_work_item_status` + `POST /api/work-items/{id}/transition-status/`):
- the transition changes the concrete status_definition
- the target must belong to the same Project and be active
- authorization (owner/member; not viewer; no access denied)
- existing status validation remains enforced
- the moved item's board_position is value-for-value unchanged
- no sibling board_position changes (no renumbering)
- transitions work across semantic categories (completed_at follows category)
- target status name/category do not affect ordering behavior
- a real change records exactly one work_item.updated event; a no-op records none
- no extra / My Work-specific persistence is introduced

Regression guards:
- the ordinary PATCH status update STILL repositions to the column end
- the Board drag/drop reorder STILL sets an exact position
"""

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from rest_framework.test import APIClient

from audit_history.models import AuditEvent
from projects.models import WorkItemStatusDefinition
from projects.services import create_project

from work_items.models import (
    WorkItem,
    WorkItemAssignee,
    WorkItemComment,
    WorkItemLabel,
)
from work_items.services import (
    WorkItemAuditEventType,
    WorkItemDomainError,
    create_work_item,
    reposition_work_item,
    transition_work_item_status,
    update_work_item,
)

from .tests_invariants import _create_test_scenario

User = get_user_model()


def _status_ids(project):
    return {
        status.category: status.pk
        for status in project.status_definitions.all()
    }


def _board_state(project):
    """Map work_item_id -> (status_definition_id, board_position).

    This is the ordering-relevant snapshot: status (which column) plus the
    persisted project-local board_position. Comparing before/after proves
    the transition did not reorder anything.
    """
    return {
        wi.pk: (wi.status_definition_id, wi.board_position)
        for wi in WorkItem.objects.filter(project=project).order_by("id")
    }


class _TransitionBase:
    def setUp(self):
        self.data = _create_test_scenario()
        self.project = self.data["paper_xyz"]
        self.alex = self.data["alex"]
        self.chris = self.data["chris"]
        self.laura = self.data["laura"]
        self.maria = self.data["maria"]
        self.task_type = self.data["task_type"]
        self.status_ids = _status_ids(self.project)

    def _create_in(self, title, category, position=None):
        wi = create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.task_type.pk,
            title=title,
            status_definition_id=self.status_ids[category],
        )
        if position is not None:
            wi.board_position = position
            wi.save(update_fields=["board_position"])
        return wi


# ── Service-level behavior ──


class StatusTransitionServiceTest(_TransitionBase, TestCase):
    def test_transition_changes_status_definition(self):
        c = self._create_in("C", "todo")
        before_pos = c.board_position
        transition_work_item_status(
            work_item=c,
            actor=self.alex,
            status_definition_id=self.status_ids["review"],
        )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["review"])
        self.assertEqual(c.board_position, before_pos)

    def test_transition_to_same_status_is_noop(self):
        c = self._create_in("C", "todo")
        before = _board_state(self.project)
        transition_work_item_status(
            work_item=c,
            actor=self.alex,
            status_definition_id=self.status_ids["todo"],
        )
        c.refresh_from_db()
        self.assertEqual(_board_state(self.project), before)

    def test_transition_preserves_position_last_with_gaps_and_populated_target(self):
        # todo column has gaps (positions 1, 3, 5); review column is populated.
        self._create_in("A", "todo", position=1)
        self._create_in("B", "todo", position=3)
        c = self._create_in("C", "todo", position=5)  # last in todo
        self._create_in("D", "review", position=1)
        self._create_in("E", "review", position=2)

        before = _board_state(self.project)
        transition_work_item_status(
            work_item=c,
            actor=self.alex,
            status_definition_id=self.status_ids["review"],
        )
        after = _board_state(self.project)

        # Moved item: status changed, board_position identical.
        self.assertEqual(after[c.pk][0], self.status_ids["review"])
        self.assertEqual(after[c.pk][1], 5)
        # No item added/removed.
        self.assertEqual(set(before), set(after))
        # Every sibling is untouched.
        for pk, (status, pos) in before.items():
            if pk != c.pk:
                self.assertEqual(after[pk], (status, pos), f"item {pk} changed")

    def test_transition_preserves_position_first(self):
        a = self._create_in("A", "todo", position=1)  # first in todo
        self._create_in("B", "todo", position=2)
        self._create_in("D", "review", position=1)
        before = _board_state(self.project)
        transition_work_item_status(
            work_item=a,
            actor=self.alex,
            status_definition_id=self.status_ids["review"],
        )
        after = _board_state(self.project)
        self.assertEqual(after[a.pk][0], self.status_ids["review"])
        self.assertEqual(after[a.pk][1], 1)
        for pk, (status, pos) in before.items():
            if pk != a.pk:
                self.assertEqual(after[pk], (status, pos))

    def test_transition_preserves_position_middle(self):
        self._create_in("A", "todo", position=1)
        b = self._create_in("B", "todo", position=3)  # middle of 1/3/5
        self._create_in("C", "todo", position=5)
        before = _board_state(self.project)
        transition_work_item_status(
            work_item=b,
            actor=self.alex,
            status_definition_id=self.status_ids["in_progress"],
        )
        after = _board_state(self.project)
        self.assertEqual(after[b.pk][0], self.status_ids["in_progress"])
        self.assertEqual(after[b.pk][1], 3)
        for pk, (status, pos) in before.items():
            if pk != b.pk:
                self.assertEqual(after[pk], (status, pos))

    def test_transition_across_semantic_categories(self):
        c = self._create_in("C", "todo", position=4)

        transition_work_item_status(
            work_item=c, actor=self.alex,
            status_definition_id=self.status_ids["in_progress"],
        )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["in_progress"])
        self.assertIsNone(c.completed_at)
        self.assertEqual(c.board_position, 4)

        transition_work_item_status(
            work_item=c, actor=self.alex,
            status_definition_id=self.status_ids["review"],
        )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["review"])
        self.assertIsNone(c.completed_at)
        self.assertEqual(c.board_position, 4)

        transition_work_item_status(
            work_item=c, actor=self.alex,
            status_definition_id=self.status_ids["done"],
        )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["done"])
        self.assertIsNotNone(c.completed_at)
        self.assertEqual(c.board_position, 4)

        # Leaving done clears completed_at; position still preserved.
        transition_work_item_status(
            work_item=c, actor=self.alex,
            status_definition_id=self.status_ids["todo"],
        )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["todo"])
        self.assertIsNone(c.completed_at)
        self.assertEqual(c.board_position, 4)

    def test_done_to_done_preserves_completed_at(self):
        second_done = WorkItemStatusDefinition.objects.create(
            project=self.project, name="Shipped", category="done",
        )
        c = self._create_in("C", "todo", position=7)
        transition_work_item_status(
            work_item=c, actor=self.alex,
            status_definition_id=self.status_ids["done"],
        )
        c.refresh_from_db()
        first_done_at = c.completed_at
        self.assertIsNotNone(first_done_at)

        transition_work_item_status(
            work_item=c, actor=self.alex,
            status_definition_id=second_done.pk,
        )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, second_done.pk)
        self.assertEqual(c.completed_at, first_done_at)
        self.assertEqual(c.board_position, 7)

    def test_name_and_category_do_not_affect_ordering(self):
        # A custom-named status in an existing category isolates the
        # display name from the semantic category.
        custom = WorkItemStatusDefinition.objects.create(
            project=self.project, name="Data Collection",
            category="in_progress",
        )
        for target in (
            self.status_ids["in_progress"],
            self.status_ids["review"],
            self.status_ids["done"],
            custom.pk,
        ):
            c = self._create_in("C", "todo", position=6)
            transition_work_item_status(
                work_item=c, actor=self.alex, status_definition_id=target,
            )
            c.refresh_from_db()
            self.assertEqual(c.status_definition_id, target)
            self.assertEqual(c.board_position, 6,
                             f"position changed for target {target}")

    def test_transition_cross_project_status_rejected(self):
        other = create_project(
            research_group=self.data["group"],
            creator=self.alex, name="Other Project",
        )
        c = self._create_in("C", "todo")
        with self.assertRaises(WorkItemDomainError):
            transition_work_item_status(
                work_item=c, actor=self.alex,
                status_definition_id=other.status_definitions.get(
                    category="todo"
                ).pk,
            )

    def test_transition_nonexistent_status_rejected(self):
        c = self._create_in("C", "todo")
        with self.assertRaises(WorkItemDomainError):
            transition_work_item_status(
                work_item=c, actor=self.alex, status_definition_id=999999,
            )

    def test_transition_inactive_status_rejected(self):
        review = WorkItemStatusDefinition.objects.get(
            pk=self.status_ids["review"]
        )
        review.active = False
        review.save(update_fields=["active"])
        c = self._create_in("C", "todo")
        with self.assertRaises(WorkItemDomainError):
            transition_work_item_status(
                work_item=c, actor=self.alex,
                status_definition_id=self.status_ids["review"],
            )

    def test_transition_viewer_rejected(self):
        c = self._create_in("C", "todo")
        with self.assertRaises(WorkItemDomainError):
            transition_work_item_status(
                work_item=c, actor=self.laura,
                status_definition_id=self.status_ids["review"],
            )

    def test_transition_no_project_access_rejected(self):
        c = self._create_in("C", "todo")
        with self.assertRaises(WorkItemDomainError):
            transition_work_item_status(
                work_item=c, actor=self.maria,
                status_definition_id=self.status_ids["review"],
            )

    def test_transition_records_single_event_with_status_change(self):
        c = self._create_in("C", "todo")
        transition_work_item_status(
            work_item=c, actor=self.alex,
            status_definition_id=self.status_ids["review"],
        )
        events = AuditEvent.objects.filter(
            work_item=c, event_type=WorkItemAuditEventType.UPDATED,
        )
        self.assertEqual(events.count(), 1)
        changes = events.first().data["changes"]
        self.assertIn("statusDefinition", changes)
        self.assertEqual(
            changes["statusDefinition"]["from"]["category"], "todo",
        )
        self.assertEqual(
            changes["statusDefinition"]["to"]["category"], "review",
        )
        # board_position is never part of the history diff.
        self.assertNotIn("boardPosition", changes)

    def test_noop_transition_records_no_event(self):
        c = self._create_in("C", "todo")
        transition_work_item_status(
            work_item=c, actor=self.alex,
            status_definition_id=self.status_ids["todo"],
        )
        events = AuditEvent.objects.filter(
            work_item=c, event_type=WorkItemAuditEventType.UPDATED,
        )
        self.assertEqual(events.count(), 0)

    def test_no_extra_persistence(self):
        c = self._create_in("C", "todo", position=5)
        self._create_in("A", "todo", position=1)
        self._create_in("D", "review", position=1)

        def _counts():
            return {
                "work_items": WorkItem.objects.filter(
                    project=self.project
                ).count(),
                "assignees": WorkItemAssignee.objects.filter(
                    work_item__project=self.project
                ).count(),
                "labels": WorkItemLabel.objects.filter(
                    work_item__project=self.project
                ).count(),
                "comments": WorkItemComment.objects.filter(
                    work_item__project=self.project
                ).count(),
            }

        before = _board_state(self.project)
        before_counts = _counts()
        transition_work_item_status(
            work_item=c, actor=self.alex,
            status_definition_id=self.status_ids["review"],
        )
        after = _board_state(self.project)
        after_counts = _counts()

        # No rows created/removed anywhere in the Work Item graph.
        self.assertEqual(before_counts, after_counts)
        # No board_position changed at all (not the moved item, not siblings).
        for pk in before:
            self.assertEqual(
                before[pk][1], after[pk][1],
                f"board_position changed for item {pk}",
            )
        # Only the moved item's status changed.
        self.assertEqual(after[c.pk][0], self.status_ids["review"])
        for pk, (status, pos) in before.items():
            if pk != c.pk:
                self.assertEqual(after[pk], (status, pos))


# ── Regression guards: existing mutation semantics are unchanged ──


class ExistingMutationRegressionTest(_TransitionBase, TestCase):
    def test_ordinary_patch_status_update_still_repositions(self):
        """update_work_item (editor) STILL appends to the end of the column."""
        a = self._create_in("A", "review")
        b = self._create_in("B", "review")
        c = self._create_in("C", "todo")
        self.assertIsNone(c.board_position)

        update_work_item(
            work_item=c,
            actor=self.alex,
            status_definition_id=self.status_ids["review"],
        )
        c.refresh_from_db()
        a.refresh_from_db()
        b.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["review"])
        # Ordinary path repositioned: explicit end-of-column slot.
        self.assertIsNotNone(c.board_position)
        self.assertEqual(a.board_position, 1)
        self.assertEqual(b.board_position, 2)
        self.assertEqual(c.board_position, 3)

    def test_reposition_still_sets_exact_position(self):
        """reposition_work_item (Board drag) STILL sets an exact position."""
        a = self._create_in("A", "todo")
        c = self._create_in("C", "todo")
        reposition_work_item(
            work_item=c,
            actor=self.alex,
            status_definition_id=self.status_ids["todo"],
            before_work_item_id=a.pk,
        )
        c.refresh_from_db()
        a.refresh_from_db()
        self.assertEqual(c.board_position, 1)
        self.assertEqual(a.board_position, 2)


# ── API-level behavior ──


class StatusTransitionAPITest(_TransitionBase, TestCase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def _login(self, username, password="Pass1!"):
        self.client.get("/api/auth/csrf/")
        csrf = self.client.cookies.get("csrftoken").value
        self.client.post(
            "/api/auth/login/",
            data={"username": username, "password": password},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

    def _csrf(self):
        self.client.get("/api/auth/csrf/")
        cookie = self.client.cookies.get("csrftoken")
        return cookie.value if cookie else ""

    def _post(self, work_item, payload):
        return self.client.post(
            f"/api/work-items/{work_item.pk}/transition-status/",
            data=payload,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=self._csrf(),
        )

    def test_api_success_preserves_board_position(self):
        c = self._create_in("C", "todo", position=5)
        self._login("alex")
        resp = self._post(c, {"statusDefinitionId": self.status_ids["review"]})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["statusDefinitionId"], self.status_ids["review"])
        self.assertEqual(body["boardPosition"], 5)

    def test_api_viewer_forbidden(self):
        c = self._create_in("C", "todo")
        self._login("laura")
        resp = self._post(c, {"statusDefinitionId": self.status_ids["review"]})
        self.assertEqual(resp.status_code, 403)

    def test_api_no_access_not_found(self):
        c = self._create_in("C", "todo")
        self._login("maria")
        resp = self._post(c, {"statusDefinitionId": self.status_ids["review"]})
        self.assertEqual(resp.status_code, 404)

    def test_api_missing_field(self):
        c = self._create_in("C", "todo")
        self._login("alex")
        resp = self._post(c, {})
        self.assertEqual(resp.status_code, 400)

    def test_api_invalid_status(self):
        c = self._create_in("C", "todo")
        self._login("alex")
        resp = self._post(c, {"statusDefinitionId": 999999})
        self.assertEqual(resp.status_code, 400)

    def test_api_cross_project(self):
        other = create_project(
            research_group=self.data["group"],
            creator=self.alex, name="Other Project",
        )
        c = self._create_in("C", "todo")
        self._login("alex")
        resp = self._post(
            c, {"statusDefinitionId": other.status_definitions.get(
                category="todo"
            ).pk},
        )
        self.assertEqual(resp.status_code, 400)

    def test_api_inactive_status(self):
        review = WorkItemStatusDefinition.objects.get(
            pk=self.status_ids["review"]
        )
        review.active = False
        review.save(update_fields=["active"])
        c = self._create_in("C", "todo")
        self._login("alex")
        resp = self._post(c, {"statusDefinitionId": self.status_ids["review"]})
        self.assertEqual(resp.status_code, 400)

    def test_api_csrf_required(self):
        c = self._create_in("C", "todo")
        django_client = Client(enforce_csrf_checks=True)
        django_client.force_login(self.alex)
        resp = django_client.post(
            f"/api/work-items/{c.pk}/transition-status/",
            data={"statusDefinitionId": self.status_ids["review"]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 403)
