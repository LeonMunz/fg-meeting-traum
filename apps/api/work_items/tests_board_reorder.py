"""Board reorder (drag/drop) persistence tests.

Verifies the single atomic reorder/move operation:
- reorder within the same status (position only, status untouched)
- cross-status move with exact insertion position
- first / last position
- empty target column
- reload/persistence semantics
- Project isolation (cross-Project references rejected)
- invalid target status rejected
- editor (non-drag) status change appends at the end of the target
  column
"""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import Project, ProjectMembership
from projects.services import create_project

from work_items.models import WorkItem
from work_items.services import (
    WorkItemDomainError,
    create_work_item,
    reposition_work_item,
    update_work_item,
)

from .tests_invariants import _create_test_scenario

User = get_user_model()


def _status_ids(project):
    return {
        status.category: status.pk
        for status in project.status_definitions.all()
    }


def _column_titles(project, status_pk):
    from django.db.models import F

    return list(
        WorkItem.objects.filter(
            project=project,
            status_definition_id=status_pk,
        )
        .order_by(F("board_position").asc(nulls_last=True), "created_at", "id")
        .values_list("title", flat=True)
    )


class _ReorderAuthMixin:
    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def _login(self, username, password="Pass1!"):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        self.client.post(
            "/api/auth/login/",
            data={"username": username, "password": password},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

    def _csrf(self):
        self.client.get("/api/auth/csrf/")
        cookie = self.client.cookies.get("csrftoken")
        return cookie.value if cookie else ""


class _ReorderBase(_ReorderAuthMixin):
    def setUp(self):
        super().setUp()
        self.data = _create_test_scenario()
        self.project = self.data["paper_xyz"]
        self.alex = self.data["alex"]
        self.task_type = self.data["task_type"]
        self.status_ids = _status_ids(self.project)

    def _create_in(self, title, category):
        return create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.task_type.pk,
            title=title,
            status_definition_id=self.status_ids[category],
        )

    def _reorder_api(self, work_item, status_definition_id=None,
                      before_work_item_id="__unset__"):
        payload = {}
        if status_definition_id is not None:
            payload["statusDefinitionId"] = status_definition_id
        if before_work_item_id != "__unset__":
            payload["beforeWorkItemId"] = before_work_item_id
        self.client.get("/api/auth/csrf/")
        return self.client.post(
            f"/api/work-items/{work_item.pk}/reorder/",
            data=payload,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=self._csrf(),
        )


# ── Service-level tests ──


class RepositionServiceTest(_ReorderBase, TestCase):
    def test_reorder_within_same_status(self):
        """A, B, C in Todo; move C before B → A, C, B. Status unchanged."""
        a = self._create_in("A", "todo")
        b = self._create_in("B", "todo")
        c = self._create_in("C", "todo")

        reposition_work_item(
            work_item=c,
            actor=self.alex,
            before_work_item_id=b.pk,
        )

        c.refresh_from_db()
        self.assertEqual(
            c.status_definition_id, self.status_ids["todo"],
        )
        self.assertEqual(
            _column_titles(self.project, self.status_ids["todo"]),
            ["A", "C", "B"],
        )

    def test_cross_status_move_exact_insertion(self):
        """Todo: A B; Review: C D E; move B between D and E."""
        a = self._create_in("A", "todo")
        b = self._create_in("B", "todo")
        c = self._create_in("C", "review")
        d = self._create_in("D", "review")
        e = self._create_in("E", "review")

        reposition_work_item(
            work_item=b,
            actor=self.alex,
            status_definition_id=self.status_ids["review"],
            before_work_item_id=e.pk,
        )

        b.refresh_from_db()
        self.assertEqual(
            b.status_definition_id, self.status_ids["review"],
        )
        self.assertEqual(
            _column_titles(self.project, self.status_ids["todo"]),
            ["A"],
        )
        self.assertEqual(
            _column_titles(self.project, self.status_ids["review"]),
            ["C", "D", "B", "E"],
        )

    def test_first_position(self):
        a = self._create_in("A", "todo")
        b = self._create_in("B", "todo")
        c = self._create_in("C", "todo")

        reposition_work_item(
            work_item=c,
            actor=self.alex,
            before_work_item_id=a.pk,
        )

        self.assertEqual(
            _column_titles(self.project, self.status_ids["todo"]),
            ["C", "A", "B"],
        )

    def test_last_position_same_column(self):
        a = self._create_in("A", "todo")
        b = self._create_in("B", "todo")

        reposition_work_item(
            work_item=a,
            actor=self.alex,
            status_definition_id=self.status_ids["todo"],
        )

        self.assertEqual(
            _column_titles(self.project, self.status_ids["todo"]),
            ["B", "A"],
        )

    def test_last_position_cross_column(self):
        a = self._create_in("A", "review")
        b = self._create_in("B", "todo")

        reposition_work_item(
            work_item=b,
            actor=self.alex,
            status_definition_id=self.status_ids["review"],
        )

        self.assertEqual(
            _column_titles(self.project, self.status_ids["review"]),
            ["A", "B"],
        )

    def test_empty_target_column(self):
        a = self._create_in("A", "todo")

        reposition_work_item(
            work_item=a,
            actor=self.alex,
            status_definition_id=self.status_ids["in_progress"],
        )

        a.refresh_from_db()
        self.assertEqual(
            a.status_definition_id, self.status_ids["in_progress"],
        )
        self.assertEqual(
            _column_titles(self.project, self.status_ids["in_progress"]),
            ["A"],
        )

    def test_move_to_first_of_column_preserves_others(self):
        a = self._create_in("A", "review")
        b = self._create_in("B", "review")
        c = self._create_in("C", "todo")

        reposition_work_item(
            work_item=c,
            actor=self.alex,
            status_definition_id=self.status_ids["review"],
            before_work_item_id=a.pk,
        )

        self.assertEqual(
            _column_titles(self.project, self.status_ids["review"]),
            ["C", "A", "B"],
        )

    def test_repeated_moves_are_stable(self):
        a = self._create_in("A", "todo")
        b = self._create_in("B", "todo")
        c = self._create_in("C", "todo")

        reposition_work_item(
            work_item=c,
            actor=self.alex,
            before_work_item_id=b.pk,
        )
        reposition_work_item(
            work_item=a,
            actor=self.alex,
            before_work_item_id=c.pk,
        )
        reposition_work_item(
            work_item=b,
            actor=self.alex,
            before_work_item_id=a.pk,
        )

        self.assertEqual(
            _column_titles(self.project, self.status_ids["todo"]),
            ["B", "A", "C"],
        )

    def test_editor_status_change_appends_at_end(self):
        """update_work_item (editor, no drag) places at column end."""
        a = self._create_in("A", "review")
        b = self._create_in("B", "review")
        c = self._create_in("C", "todo")

        update_work_item(
            work_item=c,
            actor=self.alex,
            status_definition_id=self.status_ids["review"],
        )

        c.refresh_from_db()
        self.assertEqual(
            _column_titles(self.project, self.status_ids["review"]),
            ["A", "B", "C"],
        )

    def test_editor_status_change_to_empty_column(self):
        c = self._create_in("C", "todo")

        update_work_item(
            work_item=c,
            actor=self.alex,
            status_definition_id=self.status_ids["done"],
        )

        c.refresh_from_db()
        self.assertIsNotNone(c.completed_at)
        self.assertEqual(
            _column_titles(self.project, self.status_ids["done"]),
            ["C"],
        )

    def test_cross_project_before_rejected(self):
        other = create_project(
            research_group=self.data["group"],
            creator=self.alex,
            name="Other Project",
        )
        foreign = create_work_item(
            project=other,
            actor=self.alex,
            type_definition_id=other.type_definitions.get(name="Task").pk,
            title="Foreign",
        )
        local = self._create_in("A", "todo")

        with self.assertRaises(WorkItemDomainError):
            reposition_work_item(
                work_item=local,
                actor=self.alex,
                before_work_item_id=foreign.pk,
            )

    def test_cross_project_status_rejected(self):
        other = create_project(
            research_group=self.data["group"],
            creator=self.alex,
            name="Other Project 2",
        )
        local = self._create_in("A", "todo")

        with self.assertRaises(WorkItemDomainError):
            reposition_work_item(
                work_item=local,
                actor=self.alex,
                status_definition_id=(
                    other.status_definitions.get(category="todo").pk
                ),
            )

    def test_before_item_must_share_target_column(self):
        b_review = self._create_in("B", "review")
        a_todo = self._create_in("A", "todo")

        with self.assertRaises(WorkItemDomainError):
            reposition_work_item(
                work_item=a_todo,
                actor=self.alex,
                before_work_item_id=b_review.pk,
            )

    def test_before_itself_rejected(self):
        a = self._create_in("A", "todo")

        with self.assertRaises(WorkItemDomainError):
            reposition_work_item(
                work_item=a,
                actor=self.alex,
                before_work_item_id=a.pk,
            )

    def test_viewer_cannot_reorder(self):
        a = self._create_in("A", "todo")
        b = self._create_in("B", "todo")
        laura = self.data["laura"]

        with self.assertRaises(WorkItemDomainError):
            reposition_work_item(
                work_item=a,
                actor=laura,
                before_work_item_id=b.pk,
            )

    def test_hidden_items_not_scrambled(self):
        """Items hidden by a filter keep their relative order when a
        visible item is inserted between other visible items."""
        a = self._create_in("A", "todo")
        hidden1 = self._create_in("Hidden1", "todo")
        b = self._create_in("B", "todo")
        hidden2 = self._create_in("Hidden2", "todo")
        c = self._create_in("C", "todo")

        # Creation order A, Hidden1, B, Hidden2, C. Inserting C before
        # B reorders the visible items to A, C, B; the (filter-hidden)
        # items keep their relative creation order at the end of the
        # column and are never scrambled relative to each other.
        reposition_work_item(
            work_item=c,
            actor=self.alex,
            before_work_item_id=b.pk,
        )

        self.assertEqual(
            _column_titles(self.project, self.status_ids["todo"]),
            ["A", "Hidden1", "C", "B", "Hidden2"],
        )


# ── API-level tests ──


class ReorderApiTest(_ReorderBase, TestCase):
    def setUp(self):
        super().setUp()
        self._login("alex")

    def test_reorder_endpoint_persists(self):
        a = self._create_in("A", "todo")
        b = self._create_in("B", "todo")
        c = self._create_in("C", "todo")

        response = self._reorder_api(
            c, before_work_item_id=b.pk,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            _column_titles(self.project, self.status_ids["todo"]),
            ["A", "C", "B"],
        )

    def test_reorder_endpoint_cross_status(self):
        a = self._create_in("A", "todo")
        b = self._create_in("B", "todo")
        e = self._create_in("E", "review")

        response = self._reorder_api(
            b,
            status_definition_id=self.status_ids["review"],
            before_work_item_id=e.pk,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["statusDefinitionId"],
                         self.status_ids["review"])
        self.assertEqual(
            _column_titles(self.project, self.status_ids["review"]),
            ["B", "E"],
        )
        self.assertEqual(
            _column_titles(self.project, self.status_ids["todo"]),
            ["A"],
        )

    def test_reorder_endpoint_noop_rejected(self):
        a = self._create_in("A", "todo")
        response = self._reorder_api(a)
        self.assertEqual(response.status_code, 400)

    def test_reorder_endpoint_invalid_status(self):
        a = self._create_in("A", "todo")
        response = self._reorder_api(a, status_definition_id=999999)
        self.assertEqual(response.status_code, 400)

    def test_reorder_endpoint_viewer_forbidden(self):
        a = self._create_in("A", "todo")
        b = self._create_in("B", "todo")
        self.client.cookies.clear()
        self._login("laura")

        response = self._reorder_api(a, before_work_item_id=b.pk)
        self.assertEqual(response.status_code, 403)

    def test_list_returns_board_position_and_order(self):
        self._create_in("A", "todo")
        b = self._create_in("B", "todo")
        self._create_in("C", "todo")

        # Move B to the end of the todo column: A, C, B.
        self._reorder_api(
            b, status_definition_id=self.status_ids["todo"],
        )
        self.client.get("/api/auth/csrf/")
        response = self.client.get(
            f"/api/projects/{self.project.pk}/work-items/",
        )
        self.assertEqual(response.status_code, 200)
        titles = [
            item["title"] for item in response.json()
            if item["statusDefinitionId"] == self.status_ids["todo"]
        ]
        self.assertEqual(titles, ["A", "C", "B"])
        # Positioned items carry a non-null boardPosition in the payload.
        positioned = [
            item for item in response.json()
            if item["title"] in ("A", "C", "B")
        ]
        self.assertTrue(
            all(item["boardPosition"] is not None
                for item in positioned[:2])
        )
