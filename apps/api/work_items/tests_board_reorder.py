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

from audit_history.models import AuditEvent
from projects.models import WorkItemStatusDefinition
from work_items.models import WorkItem
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


def _add_status_definition(project, name, category, order=0, active=True):
    """Add a concrete StatusDefinition to the Project (test fixture)."""
    return WorkItemStatusDefinition.objects.create(
        project=project,
        name=name,
        category=category,
        order=order,
        active=active,
    )


def _category_titles(project, category):
    """The VISIBLE order of one semantic category column.

    A Board column spans ALL concrete StatusDefinitions of the
    category; the list endpoint renders items by
    (board_position ASC NULLS LAST, created_at, id), so this is the
    shared, project-wide order the Project Board shows.
    """
    from django.db.models import F

    return list(
        WorkItem.objects.filter(
            project=project,
            status_definition__category=category,
        )
        .order_by(F("board_position").asc(nulls_last=True), "created_at", "id")
        .values_list("title", flat=True)
    )


def _board_state(project):
    """work_item_id -> (status_definition_id, board_position)."""
    return {
        wi.pk: (wi.status_definition_id, wi.board_position)
        for wi in WorkItem.objects.filter(project=project).order_by("id")
    }


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


# ── Shared semantic-category columns (multiple definitions per
# ── category) — AP-01 canonical Project Board ordering ──


class _MultiDefBase(_ReorderAuthMixin):
    """Standard scenario PLUS extra concrete StatusDefinitions sharing
    categories: 'Planned' (todo) next to 'Todo', 'Testing' (review)
    next to 'Review'. Board columns are semantic categories, so these
    items share the one column and the one project-wide ordering."""

    def setUp(self):
        super().setUp()
        self.data = _create_test_scenario()
        self.project = self.data["paper_xyz"]
        self.alex = self.data["alex"]
        self.chris = self.data["chris"]
        self.task_type = self.data["task_type"]
        self.status_ids = _status_ids(self.project)
        self.open_def = self.project.status_definitions.get(name="Todo")
        self.planned = _add_status_definition(
            self.project, "Planned", "todo", order=1,
        )
        self.testing = _add_status_definition(
            self.project, "Testing", "review", order=9,
        )

    def _create_in(self, title, status_def):
        return create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.task_type.pk,
            title=title,
            status_definition_id=(
                status_def.pk if hasattr(status_def, "pk") else status_def
            ),
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

    def _list_category_titles(self, category):
        """One category column as served by GET /api/projects/{id}/
        work-items/ (the payload the Board renders from)."""
        defs = set(
            self.project.status_definitions
            .filter(category=category)
            .values_list("pk", flat=True)
        )
        response = self.client.get(
            f"/api/projects/{self.project.pk}/work-items/"
        )
        self.assertEqual(response.status_code, 200)
        return [
            item["title"]
            for item in response.json()
            if item["statusDefinitionId"] in defs
        ]


class MultiDefinitionCategoryReorderServiceTest(_MultiDefBase, TestCase):
    """Reordering across concrete definitions of ONE semantic
    category: the category column is shared and exact."""

    def test_mixed_definitions_shared_column_exact_order(self):
        """A(Open) B(Planned) C(Open) — one Todo column; drop C
        between A and B → A, C, B, persisted, statuses untouched."""
        a = self._create_in("A", self.open_def)
        b = self._create_in("B", self.planned)
        c = self._create_in("C", self.open_def)

        reposition_work_item(
            work_item=c,
            actor=self.alex,
            before_work_item_id=b.pk,
        )

        for item in (a, b, c):
            item.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.open_def.pk)
        self.assertEqual(b.status_definition_id, self.planned.pk)
        self.assertEqual(c.status_definition_id, self.open_def.pk)
        self.assertEqual(
            _category_titles(self.project, "todo"), ["A", "C", "B"],
        )
        # Explicit, unique positions 1..3 in the resulting order.
        self.assertEqual(a.board_position, 1)
        self.assertEqual(c.board_position, 2)
        self.assertEqual(b.board_position, 3)

    def test_same_category_request_does_not_flip_status_definition(self):
        """Sending a DIFFERENT same-category definition selects the
        column only — the Work Item's concrete StatusDefinition is
        never changed by a reorder."""
        a = self._create_in("A", self.planned)
        b = self._create_in("B", self.open_def)

        reposition_work_item(
            work_item=a,
            actor=self.alex,
            status_definition_id=self.open_def.pk,
            before_work_item_id=b.pk,
        )

        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.planned.pk)
        self.assertEqual(
            _category_titles(self.project, "todo"), ["A", "B"],
        )

    def test_same_category_reorder_preserves_properties_and_history(self):
        """Pure reorder: status, completed_at, blocked_reason intact;
        no functional status change and no audit event."""
        done_def = self.status_ids["done"]
        a = self._create_in("A", done_def)
        b = self._create_in("B", done_def)
        a.blocked_reason = "waiting on data"
        a.save(update_fields=["blocked_reason"])
        a.refresh_from_db()
        self.assertIsNotNone(a.completed_at)
        completed_at = a.completed_at

        events_before = list(
            AuditEvent.objects.filter(
                event_type=WorkItemAuditEventType.UPDATED,
            ).values_list("pk", flat=True)
        )

        reposition_work_item(
            work_item=a,
            actor=self.alex,
            before_work_item_id=b.pk,
        )

        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, done_def)
        self.assertEqual(a.blocked_reason, "waiting on data")
        self.assertEqual(a.completed_at, completed_at)
        self.assertEqual(
            _category_titles(self.project, "done"), ["A", "B"],
        )
        self.assertEqual(
            list(
                AuditEvent.objects.filter(
                    event_type=WorkItemAuditEventType.UPDATED,
                ).values_list("pk", flat=True)
            ),
            events_before,
        )

    def test_inactive_referenced_status_does_not_block_pure_reorder(self):
        legacy = _add_status_definition(
            self.project, "LegacyTodo", "todo", order=2, active=False,
        )
        a = self._create_in("A", legacy)
        b = self._create_in("B", self.open_def)

        # No target status at all: pure reorder within the category.
        reposition_work_item(
            work_item=a,
            actor=self.alex,
            before_work_item_id=b.pk,
        )
        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, legacy.pk)
        self.assertEqual(
            _category_titles(self.project, "todo"), ["A", "B"],
        )

        # Sending the inactive same-category definition still works
        # and still never flips the concrete status.
        c = self._create_in("C", self.open_def)
        reposition_work_item(
            work_item=c,
            actor=self.alex,
            status_definition_id=legacy.pk,
            before_work_item_id=a.pk,
        )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.open_def.pk)
        self.assertEqual(
            _category_titles(self.project, "todo"), ["C", "A", "B"],
        )

    def test_cross_category_move_atomic_status_position_completion(self):
        """Cross-category drop: status, exact position, and completion
        semantics change together; exactly one status history event."""
        a = self._create_in("A", self.open_def)
        t1 = self._create_in("T1", self.testing)
        self._create_in("D", self.status_ids["done"])

        reposition_work_item(
            work_item=a,
            actor=self.alex,
            status_definition_id=self.testing.pk,
        )

        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.testing.pk)
        self.assertIsNone(a.completed_at)
        self.assertEqual(
            _category_titles(self.project, "review"), ["T1", "A"],
        )
        t1.refresh_from_db()
        self.assertEqual(t1.status_definition_id, self.testing.pk)

        events = AuditEvent.objects.filter(
            work_item=a,
            event_type=WorkItemAuditEventType.UPDATED,
        )
        self.assertEqual(events.count(), 1)
        changes = events.first().data["changes"]
        self.assertEqual(
            changes["statusDefinition"]["from"]["id"], self.open_def.pk,
        )
        self.assertEqual(
            changes["statusDefinition"]["to"]["id"], self.testing.pk,
        )
        self.assertEqual(
            changes["statusDefinition"]["to"]["category"], "review",
        )

    def test_cross_category_move_into_done_sets_completed_at(self):
        a = self._create_in("A", self.open_def)

        reposition_work_item(
            work_item=a,
            actor=self.alex,
            status_definition_id=self.status_ids["done"],
        )

        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.status_ids["done"])
        self.assertIsNotNone(a.completed_at)

    def test_cross_category_move_to_inactive_target_rejected_atomically(self):
        inactive_review = _add_status_definition(
            self.project, "OldReview", "review", order=10, active=False,
        )
        a = self._create_in("A", self.open_def)
        t1 = self._create_in("T1", self.testing)
        before = _board_state(self.project)

        with self.assertRaises(WorkItemDomainError):
            reposition_work_item(
                work_item=a,
                actor=self.alex,
                status_definition_id=inactive_review.pk,
                before_work_item_id=t1.pk,
            )

        self.assertEqual(_board_state(self.project), before)
        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.open_def.pk)
        self.assertFalse(
            AuditEvent.objects.filter(
                work_item=a,
                event_type=WorkItemAuditEventType.UPDATED,
            ).exists()
        )

    def test_cross_category_anchor_in_other_category_rejected(self):
        done_def = self.status_ids["done"]
        a = self._create_in("A", self.open_def)
        done_item = self._create_in("D", done_def)

        with self.assertRaises(WorkItemDomainError):
            reposition_work_item(
                work_item=a,
                actor=self.alex,
                status_definition_id=self.testing.pk,
                before_work_item_id=done_item.pk,
            )

    def test_first_position_anchor_from_other_definition(self):
        a = self._create_in("A", self.planned)
        self._create_in("B", self.open_def)
        c = self._create_in("C", self.open_def)

        reposition_work_item(
            work_item=c,
            actor=self.alex,
            before_work_item_id=a.pk,
        )

        self.assertEqual(
            _category_titles(self.project, "todo"), ["C", "A", "B"],
        )

    def test_last_position_appends_after_all_definitions_in_category(self):
        a = self._create_in("A", self.planned)
        self._create_in("B", self.open_def)
        self._create_in("C", self.open_def)

        reposition_work_item(
            work_item=a,
            actor=self.alex,
            # No anchor, no target status: end of the Todo category.
        )

        self.assertEqual(
            _category_titles(self.project, "todo"), ["B", "C", "A"],
        )

    def test_empty_category_column(self):
        a = self._create_in("A", self.open_def)

        reposition_work_item(
            work_item=a,
            actor=self.alex,
            status_definition_id=self.testing.pk,
        )

        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.testing.pk)
        self.assertEqual(
            _category_titles(self.project, "review"), ["A"],
        )

    def test_legacy_overlapping_positions_deterministic_then_normalized(self):
        """Pre-shared-column positions (per-definition 1..N) may
        overlap within a category: the render order stays deterministic
        via (board_position, created_at, id), and the first reorder
        normalizes the FULL category to explicit 1..N positions."""
        a = self._create_in("A", self.open_def)
        b = self._create_in("B", self.planned)
        c = self._create_in("C", self.open_def)
        d = self._create_in("D", self.open_def)
        a.board_position = 1
        a.save(update_fields=["board_position"])
        c.board_position = 2
        c.save(update_fields=["board_position"])
        b.board_position = 1  # overlaps A's position (legacy data)
        b.save(update_fields=["board_position"])
        # d stays unpositioned (NULL)

        # Deterministic stable order BEFORE any reorder:
        # A(1), B(1, created later), C(2), D(NULL last).
        self.assertEqual(
            _category_titles(self.project, "todo"), ["A", "B", "C", "D"],
        )

        reposition_work_item(
            work_item=c,
            actor=self.alex,
            before_work_item_id=a.pk,
        )

        self.assertEqual(
            _category_titles(self.project, "todo"), ["C", "A", "B", "D"],
        )
        c.refresh_from_db()
        a.refresh_from_db()
        b.refresh_from_db()
        d.refresh_from_db()
        self.assertEqual(c.board_position, 1)
        self.assertEqual(a.board_position, 2)
        self.assertEqual(b.board_position, 3)
        self.assertEqual(d.board_position, 4)

    def test_editor_patch_appends_at_end_of_category_column(self):
        """Editor status change appends to the end of the target
        CATEGORY column — even when other same-category definitions
        hold (legacy) positions beyond the moved item's definition."""
        a = self._create_in("A", self.open_def)
        c = self._create_in("C", self.open_def)
        b = self._create_in("B", self.planned)
        a.board_position = 1
        a.save(update_fields=["board_position"])
        c.board_position = 2
        c.save(update_fields=["board_position"])
        b.board_position = 5  # legacy position in the same category
        b.save(update_fields=["board_position"])
        d = self._create_in("D", self.status_ids["in_progress"])

        update_work_item(
            work_item=d,
            actor=self.alex,
            status_definition_id=self.open_def.pk,
        )

        d.refresh_from_db()
        self.assertEqual(d.status_definition_id, self.open_def.pk)
        # The full category is normalized and D lands LAST.
        self.assertEqual(
            _category_titles(self.project, "todo"), ["A", "C", "B", "D"],
        )

    def test_editor_same_category_definition_change_still_mutates_status(self):
        """Explicit editor status changes remain possible: a PATCH to a
        different concrete definition of the SAME category is a real
        status change (event + end-of-category-column placement: the
        status-changed item is repositioned to the column end)."""
        a = self._create_in("A", self.open_def)
        b = self._create_in("B", self.planned)

        update_work_item(
            work_item=a,
            actor=self.alex,
            status_definition_id=self.planned.pk,
        )

        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.planned.pk)
        self.assertEqual(a.board_position, 2)
        b.refresh_from_db()
        self.assertEqual(b.board_position, 1)
        self.assertEqual(
            _category_titles(self.project, "todo"), ["B", "A"],
        )
        events = AuditEvent.objects.filter(
            work_item=a,
            event_type=WorkItemAuditEventType.UPDATED,
        )
        self.assertEqual(events.count(), 1)
        changes = events.first().data["changes"]
        self.assertEqual(
            changes["statusDefinition"]["from"]["id"], self.open_def.pk,
        )
        self.assertEqual(
            changes["statusDefinition"]["to"]["id"], self.planned.pk,
        )


class MultiDefinitionCategoryReorderApiTest(_MultiDefBase, TestCase):
    """API-level contract: the shared category order is persisted,
    stable across reloads, and identical for every authorized member."""

    def setUp(self):
        super().setUp()
        self._login("alex")

    def test_reorder_between_definitions_persists_identical_for_members(self):
        a = self._create_in("A", self.open_def)
        b = self._create_in("B", self.planned)
        c = self._create_in("C", self.open_def)

        response = self._reorder_api(c, before_work_item_id=b.pk)
        self.assertEqual(response.status_code, 200)

        # Re-GET: the shared order is identical for the owner ...
        titles_alex = self._list_category_titles("todo")
        self.assertEqual(titles_alex, ["A", "C", "B"])

        # ... and for another authorized Project member.
        self.client.cookies.clear()
        self._login("chris")
        titles_chris = self._list_category_titles("todo")
        self.assertEqual(titles_chris, ["A", "C", "B"])

        # The payload carries the explicit shared positions.
        self.client.get("/api/auth/csrf/")
        payload = {
            item["title"]: item["boardPosition"]
            for item in self.client.get(
                f"/api/projects/{self.project.pk}/work-items/"
            ).json()
            if item["title"] in ("A", "B", "C")
        }
        self.assertEqual(payload, {"A": 1, "C": 2, "B": 3})

    def test_api_same_category_different_definition_reorder(self):
        a = self._create_in("A", self.planned)
        b = self._create_in("B", self.open_def)

        response = self._reorder_api(
            a,
            status_definition_id=self.open_def.pk,
            before_work_item_id=b.pk,
        )
        self.assertEqual(response.status_code, 200)
        # Same category: the concrete status is NOT changed.
        self.assertEqual(response.json()["statusDefinitionId"],
                         self.planned.pk)
        self.assertEqual(
            _category_titles(self.project, "todo"), ["A", "B"],
        )

    def test_api_cross_category_inactive_target_rejected(self):
        inactive_review = _add_status_definition(
            self.project, "OldReview", "review", order=10, active=False,
        )
        a = self._create_in("A", self.open_def)
        before = _board_state(self.project)

        response = self._reorder_api(
            a, status_definition_id=inactive_review.pk,
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(_board_state(self.project), before)

    def test_api_cross_category_move(self):
        a = self._create_in("A", self.open_def)
        t1 = self._create_in("T1", self.testing)

        response = self._reorder_api(
            a,
            status_definition_id=self.testing.pk,
            before_work_item_id=t1.pk,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["statusDefinitionId"],
                         self.testing.pk)
        self.assertEqual(
            _category_titles(self.project, "review"), ["A", "T1"],
        )
        self.assertEqual(_category_titles(self.project, "todo"), [])


class StaleSnapshotRepositionServiceTest(_MultiDefBase, TestCase):
    """AP-01 race regression tests.

    The caller's Work Item may be a STALE snapshot: a concurrent
    status change can commit between the caller's read (the Board
    drag that picked up the item) and the reorder's lock. Every move
    decision must therefore come from the fresh, locked state.

    "Concurrent" changes are simulated deterministically — no
    threads, no sleeps: the test commits a controlled state change
    (through the canonical services, like a real competing operation)
    AFTER the caller-side snapshot has been taken, so the service
    receives exactly the stale ORM instance a racing Board drag would
    hold.
    """

    def _stale_snapshot(self, work_item):
        """The caller-side instance a drag would hold: fetched before
        the competing operation commits."""
        return WorkItem.objects.get(pk=work_item.pk)

    def _competing_status_change(self, work_item, status_def):
        """A competing status change committed after the caller's read
        — the canonical status-only transition."""
        transition_work_item_status(
            work_item=work_item,
            actor=self.alex,
            status_definition_id=status_def.pk,
        )

    def _updated_events(self, work_item):
        return AuditEvent.objects.filter(
            work_item=work_item,
            event_type=WorkItemAuditEventType.UPDATED,
        )

    def test_stale_item_explicit_target_uses_fresh_state(self):
        """Reproduced regression: the caller reads the item in
        'todo'; a competing status change moves it to 'review'; the
        explicit target is 'todo'. The same-/cross-category decision
        must be made against the FRESH state: this is a cross-category
        move back to 'todo', not a stale same-category no-op that
        leaves the item in 'review' with a todo-column position."""
        a = self._create_in("A", self.open_def)
        b = self._create_in("B", self.open_def)
        self._create_in("T1", self.testing)

        stale_a = self._stale_snapshot(a)
        self._competing_status_change(a, self.testing)
        self.assertEqual(stale_a.status_definition_id, self.open_def.pk)
        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.testing.pk)
        events_before = self._updated_events(a).count()

        reposition_work_item(
            work_item=stale_a,
            actor=self.alex,
            status_definition_id=self.open_def.pk,
            before_work_item_id=b.pk,
        )

        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.open_def.pk)
        self.assertIsNone(a.completed_at)
        self.assertEqual(_category_titles(self.project, "todo"), ["A", "B"])
        self.assertEqual(_category_titles(self.project, "review"), ["T1"])

        events = self._updated_events(a).order_by("id")
        self.assertEqual(events.count(), events_before + 1)
        changes = events.last().data["changes"]
        self.assertEqual(
            changes["statusDefinition"]["from"]["id"], self.testing.pk,
        )
        self.assertEqual(
            changes["statusDefinition"]["to"]["id"], self.open_def.pk,
        )

    def test_implicit_target_uses_fresh_category_under_lock(self):
        """No explicit target definition: the column is the item's
        CURRENT (fresh) category under the lock — not the category of
        a stale snapshot."""
        a = self._create_in("A", self.open_def)
        b = self._create_in("B", self.open_def)
        t1 = self._create_in("T1", self.testing)

        stale_a = self._stale_snapshot(a)
        self._competing_status_change(a, self.testing)
        self.assertEqual(stale_a.status_definition_id, self.open_def.pk)
        b_position_before = b.board_position
        events_before = self._updated_events(a).count()

        reposition_work_item(
            work_item=stale_a,
            actor=self.alex,
            before_work_item_id=t1.pk,
        )

        a.refresh_from_db()
        # Pure reorder in the FRESH category ('review'): the concrete
        # definition is never flipped, and the item is positioned by
        # the review column — not by the stale todo column.
        self.assertEqual(a.status_definition_id, self.testing.pk)
        self.assertEqual(_category_titles(self.project, "review"),
                         ["A", "T1"])
        self.assertEqual(a.board_position, 1)
        # The stale todo column is untouched.
        self.assertEqual(_category_titles(self.project, "todo"), ["B"])
        b.refresh_from_db()
        self.assertEqual(b.board_position, b_position_before)
        self.assertEqual(self._updated_events(a).count(), events_before)

    def test_deactivated_target_rejected_at_decisive_validation(self):
        """A target definition that is active in the caller's snapshot
        but inactive at the decisive (under-lock) validation is
        rejected — atomically, without any partial position,
        completion, or audit change."""
        old_review = _add_status_definition(
            self.project, "OldReview", "review", order=10,
        )
        a = self._create_in("A", self.open_def)
        self._create_in("T1", self.testing)

        # The caller's snapshot sees the definition as active...
        stale_def = WorkItemStatusDefinition.objects.get(pk=old_review.pk)
        self.assertTrue(stale_def.active)
        # ...and a competing configuration change deactivates it
        # before the decisive validation:
        WorkItemStatusDefinition.objects.filter(
            pk=old_review.pk,
        ).update(active=False)

        before = _board_state(self.project)
        events_before = self._updated_events(a).count()

        with self.assertRaises(WorkItemDomainError):
            reposition_work_item(
                work_item=a,
                actor=self.alex,
                status_definition_id=old_review.pk,
            )

        self.assertEqual(_board_state(self.project), before)
        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.open_def.pk)
        self.assertEqual(self._updated_events(a).count(), events_before)

    def test_stale_anchor_in_other_category_controlled_error(self):
        """The anchor belonged to the target column in the caller's
        snapshot; a competing operation moved it to a different
        category. The reorder must be rejected with a controlled
        WorkItemDomainError — no unhandled StopIteration — and the
        transaction must roll back without partial changes."""
        a = self._create_in("A", self.open_def)
        b = self._create_in("B", self.open_def)  # the drop anchor

        stale_a = self._stale_snapshot(a)
        events_before = self._updated_events(a).count()

        # Competing move of the ANCHOR: todo -> review.
        self._competing_status_change(b, self.testing)
        # The state the reorder starts from (competing change committed).
        before = _board_state(self.project)

        with self.assertRaises(WorkItemDomainError) as ctx:
            reposition_work_item(
                work_item=stale_a,
                actor=self.alex,
                before_work_item_id=b.pk,
            )
        self.assertIn("beforeWorkItemId", str(ctx.exception))

        self.assertEqual(_board_state(self.project), before)
        self.assertEqual(self._updated_events(a).count(), events_before)

    def test_deleted_anchor_controlled_error(self):
        """An anchor deleted after the caller's snapshot is rejected
        with a controlled domain error, not an internal failure."""
        a = self._create_in("A", self.open_def)
        b = self._create_in("B", self.open_def)

        stale_a = self._stale_snapshot(a)
        b_pk = b.pk
        before = _board_state(self.project)
        del before[b_pk]
        WorkItem.objects.filter(pk=b_pk).delete()

        with self.assertRaises(WorkItemDomainError):
            reposition_work_item(
                work_item=stale_a,
                actor=self.alex,
                before_work_item_id=b_pk,
            )

        self.assertEqual(_board_state(self.project), before)
        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.open_def.pk)
        self.assertIsNone(a.board_position)

    def test_same_category_reorder_keeps_fresh_definition(self):
        """Same-category reorder after a concurrent change to another
        concrete definition of the SAME category: the FRESH concrete
        definition is kept — the stale snapshot and the requested
        same-category definition must not flip it."""
        a = self._create_in("A", self.open_def)
        b = self._create_in("B", self.open_def)
        c = self._create_in("C", self.planned)

        stale_a = self._stale_snapshot(a)
        # Competing same-category definition change: 'Todo' -> 'Planned'.
        self._competing_status_change(a, self.planned)
        self.assertEqual(stale_a.status_definition_id, self.open_def.pk)
        events_before = self._updated_events(a).count()

        reposition_work_item(
            work_item=stale_a,
            actor=self.alex,
            status_definition_id=self.open_def.pk,
            before_work_item_id=c.pk,
        )

        a.refresh_from_db()
        # Still the fresh definition ('Planned') — no status mutation
        # from the reorder, and no flip back to the stale one.
        self.assertEqual(a.status_definition_id, self.planned.pk)
        self.assertEqual(
            _category_titles(self.project, "todo"), ["B", "A", "C"],
        )
        self.assertEqual(self._updated_events(a).count(), events_before)

    def test_rejected_move_rolls_back_persistence_completion_audit(self):
        """A rejected move (stale drop anchor) must leave persistence,
        completion, and audit untouched — including completed_at of a
        'done' item."""
        a = self._create_in("A", self.status_ids["done"])
        b = self._create_in("B", self.testing)  # the drop anchor

        stale_a = self._stale_snapshot(a)
        completed_at_before = a.completed_at
        self.assertIsNotNone(completed_at_before)
        events_before = self._updated_events(a).count()

        # Competing move of the anchor out of 'review'.
        self._competing_status_change(b, self.open_def)
        # The state the reorder starts from (competing change committed).
        before = _board_state(self.project)

        with self.assertRaises(WorkItemDomainError):
            reposition_work_item(
                work_item=stale_a,
                actor=self.alex,
                status_definition_id=self.testing.pk,
                before_work_item_id=b.pk,
            )

        self.assertEqual(_board_state(self.project), before)
        a.refresh_from_db()
        self.assertEqual(a.status_definition_id, self.status_ids["done"])
        self.assertEqual(a.completed_at, completed_at_before)
        self.assertEqual(self._updated_events(a).count(), events_before)
