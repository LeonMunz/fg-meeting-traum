"""My Work Board ordering (personal, server-persisted) tests.

Verifies the persisted per-user My Work Kanban ordering
(``MyWorkBoardPosition`` + ``work_items.my_work_board_order`` +
``POST /api/me/work-items/{id}/reorder/`` + the ``myWorkBoardPosition``
metadata on ``GET /api/me/work-items/``):

- same-category reorder: personal order only — no status mutation,
  no Work Item history event, project board_position untouched
- persistence across requests / sessions (server-side, per user)
- user isolation: one user's reorder never changes another user's order
- canonical response stability: GET /api/me/work-items/ keeps its
  canonical top-level (created_at, id) order; myWorkBoardPosition is
  Board-order metadata, not a List ordering input
- unpositioned items: null metadata, deterministic fallback after
  positioned items
- cross-category move: canonical Project-local status-target
  resolution + canonical status transition + personal position in one
  atomic operation; exactly one canonical status history event;
  project board_position untouched
- atomic rollback: a failed placement leaves BOTH canonical status
  and personal order unchanged
- missing target: no active status definition in the requested
  category → rejected, nothing changes
- authorization / non-leaking: items outside the user's CURRENT My
  Work projection → 404; invalid anchors → 400
- stale category: an external status change voids the old category's
  position (the item behaves as unpositioned in the new column)
- Project Board isolation: board_position semantics untouched by both
  same-category reorder and cross-category move
- deletion: deleting a Work Item removes its personal-order rows
  (no dangling references)
- concurrency / serialization: the User row of the requesting user
  is the FIRST lock root of every move (pinned by a
  select_for_update call-order spy); a same-category personal
  reorder takes NO canonical Project / Work Item row lock (the
  sibling Work Items used to compute the personal column are read,
  never locked — even when they are assigned to another user), and
  the canonical Project / moved Work Item locks are taken only on
  the cross-category path where the canonical status mutation
  requires them; sequential cross-Project same-user moves stay
  deterministic with unique positions, and interleaved
  different-user moves stay isolated
"""

import json
from unittest import mock

from django.contrib.auth import get_user_model
from django.db.models.query import QuerySet
from django.test import TestCase
from rest_framework.test import APIClient

from audit_history.models import AuditEvent
from projects.models import Project, ProjectMembership, WorkItemStatusDefinition
from projects.services import add_project_membership, create_project
from work_items.models import (
    MyWorkBoardPosition,
    WorkItem,
    WorkItemAssignee,
)
from work_items.my_work_board_order import (
    effective_my_work_board_positions,
    move_my_work_item,
    resolve_my_work_status_target,
)
from work_items.personal_my_work import personal_my_work_queryset
from work_items.services import (
    WorkItemAuditEventType,
    WorkItemDomainError,
    create_work_item,
    delete_work_item,
    transition_work_item_status,
)

from .tests_invariants import _create_test_scenario

_UNSET = object()


class _MyWorkBoardOrderBase:
    def setUp(self):
        self.data = _create_test_scenario()
        self.project = self.data["paper_xyz"]
        self.alex = self.data["alex"]
        self.chris = self.data["chris"]
        self.laura = self.data["laura"]
        self.maria = self.data["maria"]
        self.task_type = self.data["task_type"]
        self.status_ids = {
            status.category: status.pk
            for status in self.project.status_definitions.all()
        }

    def _create(self, title, category="todo", assignee_ids=None,
                position=None):
        wi = create_work_item(
            project=self.project,
            actor=self.alex,
            type_definition_id=self.task_type.pk,
            title=title,
            status_definition_id=self.status_ids[category],
            assignee_ids=(
                assignee_ids if assignee_ids is not None else [self.alex.pk]
            ),
        )
        if position is not None:
            wi.board_position = position
            wi.save(update_fields=["board_position"])
        return wi

    def _board_state(self):
        """work_item_id -> (status_definition_id, board_position)."""
        return {
            wi.pk: (wi.status_definition_id, wi.board_position)
            for wi in WorkItem.objects.filter(project=self.project)
            .order_by("id")
        }

    def _effective_column(self, user, category):
        """The user's effective My Work column order for a category:
        positioned items first (position ASC), then unpositioned in
        canonical creation order."""
        items = list(
            personal_my_work_queryset(user)
            .filter(status_definition__category=category)
            .order_by("created_at", "id")
        )
        stored = dict(
            MyWorkBoardPosition.objects.filter(
                user=user,
                status_category=category,
                work_item_id__in=[wi.pk for wi in items],
            ).values_list("work_item_id", "position")
        )
        items.sort(
            key=lambda wi: (
                (0, stored[wi.pk]) if wi.pk in stored else (1, 0)
            ) + (wi.created_at, wi.pk)
        )
        return [wi.pk for wi in items]

    def _rows(self, user):
        return {
            row.work_item_id: (row.status_category, row.position)
            for row in MyWorkBoardPosition.objects.filter(user=user)
        }

    def _history_events(self, work_item):
        return list(
            AuditEvent.objects.filter(
                event_type=WorkItemAuditEventType.UPDATED,
                work_item=work_item,
            ).order_by("id")
        )


def _login(client, username):
    client.get("/api/auth/csrf/")
    csrf_token = client.cookies.get("csrftoken").value
    response = client.post(
        "/api/auth/login/",
        data={"username": username, "password": "Pass1!"},
        content_type="application/json",
        HTTP_X_CSRFTOKEN=csrf_token,
    )
    assert response.status_code == 200


# ── 1. Same-category reorder ──────────────────────────────────────


class SameCategoryReorderServiceTest(_MyWorkBoardOrderBase, TestCase):
    def test_move_c_before_b_reorders_personal_column(self):
        a = self._create("A")
        b = self._create("B")
        c = self._create("C")

        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=b.pk,
        )

        self.assertEqual(
            self._effective_column(self.alex, "todo"),
            [a.pk, c.pk, b.pk],
        )
        self.assertEqual(
            self._rows(self.alex),
            {a.pk: ("todo", 1), c.pk: ("todo", 2), b.pk: ("todo", 3)},
        )

    def test_move_to_end_of_column(self):
        a = self._create("A")
        b = self._create("B")
        c = self._create("C")

        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=None,
        )
        self.assertEqual(
            self._effective_column(self.alex, "todo"),
            [a.pk, b.pk, c.pk],
        )
        # And now move A to the end.
        move_my_work_item(
            user=self.alex, work_item=a,
            status_category="todo", before_work_item_id=None,
        )
        self.assertEqual(
            self._effective_column(self.alex, "todo"),
            [b.pk, c.pk, a.pk],
        )

    def test_same_category_move_does_not_mutate_status(self):
        a = self._create("A")
        c = self._create("C")
        before_state = self._board_state()

        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=a.pk,
        )

        c.refresh_from_db()
        self.assertEqual(
            c.status_definition_id, self.status_ids["todo"]
        )
        self.assertIsNone(c.completed_at)
        # No Work Item status history event for a personal reorder.
        self.assertEqual(self._history_events(c), [])
        # Project board state (status + board_position) untouched.
        self.assertEqual(self._board_state(), before_state)

    def test_same_category_move_does_not_touch_board_position(self):
        a = self._create("A", position=1)
        b = self._create("B", position=2)
        c = self._create("C", position=3)
        before = {wi.pk: wi.board_position for wi in (a, b, c)}

        move_my_work_item(
            user=self.alex, work_item=a,
            status_category="todo", before_work_item_id=c.pk,
        )

        for wi in (a, b, c):
            wi.refresh_from_db()
        self.assertEqual(
            {wi.pk: wi.board_position for wi in (a, b, c)}, before
        )

    def test_move_into_column_with_unpositioned_items(self):
        a = self._create("A")
        b = self._create("B")
        move_my_work_item(
            user=self.alex, work_item=b,
            status_category="todo", before_work_item_id=None,
        )
        self.assertEqual(
            self._effective_column(self.alex, "todo"),
            [a.pk, b.pk],
        )
        # C arrives AFTER the column was positioned: it is
        # unpositioned and sorts after the positioned items.
        c = self._create("C")
        self.assertEqual(
            self._effective_column(self.alex, "todo"),
            [a.pk, b.pk, c.pk],
        )
        # Insert C before B → A, C, B (all positioned again).
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=b.pk,
        )
        self.assertEqual(
            self._effective_column(self.alex, "todo"),
            [a.pk, c.pk, b.pk],
        )


# ── 2. Persistence / 3. isolation / 4. list stability / 5. unpositioned (API) ──


class MyWorkBoardOrderApiTest(_MyWorkBoardOrderBase, TestCase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def move(self, work_item_id, status_category, before=_UNSET):
        payload = {"statusCategory": status_category}
        if before is not _UNSET:
            payload["beforeWorkItemId"] = before
        return self.client.post(
            f"/api/me/work-items/{work_item_id}/reorder/",
            data=json.dumps(payload),
            content_type="application/json",
        )

    def get_my_work_map(self):
        response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        return {item["id"]: item for item in response.json()}

    def get_my_work_ids(self):
        response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        return [item["id"] for item in response.json()]

    # ── 1/2. same-column reorder + persistence ──

    def test_same_column_reorder_then_fresh_get(self):
        a = self._create("A")
        b = self._create("B")
        c = self._create("C")
        _login(self.client, "alex")

        response = self.move(c.pk, "todo", before=b.pk)
        self.assertEqual(response.status_code, 200)

        # A fresh GET returns the same effective positions.
        items = self.get_my_work_map()
        self.assertEqual(items[a.pk]["myWorkBoardPosition"], 1)
        self.assertEqual(items[c.pk]["myWorkBoardPosition"], 2)
        self.assertEqual(items[b.pk]["myWorkBoardPosition"], 3)

    def test_positions_survive_new_session(self):
        a = self._create("A")
        b = self._create("B")
        c = self._create("C")
        _login(self.client, "alex")
        self.assertEqual(
            self.move(c.pk, "todo", before=b.pk).status_code, 200
        )

        # A completely fresh client + session (logout/login,
        # "another device" equivalent) sees the persisted order.
        fresh = APIClient()
        _login(fresh, "alex")
        response = fresh.get("/api/me/work-items/")
        items = {item["id"]: item for item in response.json()}
        self.assertEqual(items[a.pk]["myWorkBoardPosition"], 1)
        self.assertEqual(items[c.pk]["myWorkBoardPosition"], 2)
        self.assertEqual(items[b.pk]["myWorkBoardPosition"], 3)

    # ── 3. user isolation ──

    def test_reorder_is_personal_to_the_requesting_user(self):
        a = self._create("A", assignee_ids=[self.alex.pk, self.chris.pk])
        b = self._create("B", assignee_ids=[self.alex.pk, self.chris.pk])
        c = self._create("C", assignee_ids=[self.alex.pk, self.chris.pk])
        _login(self.client, "alex")
        self.assertEqual(
            self.move(c.pk, "todo", before=b.pk).status_code, 200
        )

        alex_items = self.get_my_work_map()
        self.assertEqual(alex_items[a.pk]["myWorkBoardPosition"], 1)
        self.assertEqual(alex_items[c.pk]["myWorkBoardPosition"], 2)
        self.assertEqual(alex_items[b.pk]["myWorkBoardPosition"], 3)

        _login(self.client, "chris")
        chris_items = self.get_my_work_map()
        for pk in (a.pk, b.pk, c.pk):
            self.assertIsNone(chris_items[pk]["myWorkBoardPosition"])
        # Chris's column keeps the canonical creation order.
        self.assertEqual(
            self._effective_column(self.chris, "todo"),
            [a.pk, b.pk, c.pk],
        )
        # No row exists for Chris at all.
        self.assertFalse(
            MyWorkBoardPosition.objects.filter(user=self.chris).exists()
        )

    # ── 4. canonical list stability ──

    def test_top_level_response_order_remains_canonical(self):
        a = self._create("A")
        b = self._create("B")
        c = self._create("C")
        _login(self.client, "alex")

        # Canonical order: creation order (created_at, id).
        self.assertEqual(self.get_my_work_ids(), [a.pk, b.pk, c.pk])

        self.assertEqual(
            self.move(c.pk, "todo", before=b.pk).status_code, 200
        )
        # The List payload is NOT reordered by personal Board
        # metadata — the same canonical order is retained.
        self.assertEqual(self.get_my_work_ids(), [a.pk, b.pk, c.pk])
        items = self.get_my_work_map()
        self.assertEqual(items[a.pk]["myWorkBoardPosition"], 1)
        self.assertEqual(items[c.pk]["myWorkBoardPosition"], 2)
        self.assertEqual(items[b.pk]["myWorkBoardPosition"], 3)

    # ── 5. unpositioned behavior ──

    def test_newly_assigned_item_is_unpositioned(self):
        a = self._create("A")
        c = self._create("C")
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=a.pk,
        )
        # B is assigned AFTER the column was positioned.
        b = self._create("B")
        _login(self.client, "alex")
        items = self.get_my_work_map()
        self.assertEqual(items[c.pk]["myWorkBoardPosition"], 1)
        self.assertEqual(items[a.pk]["myWorkBoardPosition"], 2)
        self.assertIsNone(items[b.pk]["myWorkBoardPosition"])

    def test_late_assignment_is_unpositioned_and_falls_back(self):
        a = self._create("A")
        move_my_work_item(
            user=self.alex, work_item=a,
            status_category="todo", before_work_item_id=None,
        )
        # New item assigned to alex AFTER the column was positioned.
        late = self._create("LATE")
        _login(self.client, "alex")
        items = self.get_my_work_map()
        self.assertIsNone(items[late.pk]["myWorkBoardPosition"])
        # Unpositioned items appear after positioned ones.
        self.assertEqual(
            self._effective_column(self.alex, "todo"),
            [a.pk, late.pk],
        )


# ── 6. Cross-column move ──────────────────────────────────────────


class CrossCategoryMoveTest(_MyWorkBoardOrderBase, TestCase):
    def test_cross_category_move_end_to_end(self):
        # Review column already has D (anchor) and E.
        d = self._create("D", category="review", position=10)
        e = self._create("E", category="review", position=11)
        c = self._create("C", category="todo", position=7)
        before_state = self._board_state()

        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="review", before_work_item_id=d.pk,
        )

        c.refresh_from_db()
        # Resolved the Project's Review StatusDefinition…
        self.assertEqual(c.status_definition_id, self.status_ids["review"])
        self.assertIsNone(c.completed_at)
        # …Project board_position untouched for the moved item…
        self.assertEqual(c.board_position, 7)
        # …and for every sibling (status-only transition: no
        # renumbering of the Project Board).
        after_state = self._board_state()
        for pk, (status, pos) in before_state.items():
            if pk != c.pk:
                self.assertEqual(after_state[pk], (status, pos))
        self.assertEqual(after_state[c.pk][1], 7)

        # Personal position established in Review: C before D.
        self.assertEqual(
            self._effective_column(self.alex, "review"),
            [c.pk, d.pk, e.pk],
        )
        self.assertEqual(
            self._rows(self.alex),
            {c.pk: ("review", 1), d.pk: ("review", 2), e.pk: ("review", 3)},
        )
        # C is gone from the Todo column entirely.
        self.assertEqual(
            self._effective_column(self.alex, "todo"), []
        )

        # Exactly ONE canonical status history event, carrying the
        # statusDefinition change (personal ordering itself is not
        # Work Item history).
        events = self._history_events(c)
        self.assertEqual(len(events), 1)
        changes = events[0].data["changes"]
        self.assertIn("statusDefinition", changes)

    def test_cross_category_move_resolves_first_active_by_configured_order(
        self,
    ):
        # A second active Review definition with a LOWER configured
        # order wins resolution (display names never participate).
        early_review = WorkItemStatusDefinition.objects.create(
            project=self.project,
            name="Review (priority)",
            category=WorkItemStatusDefinition.Category.REVIEW,
            order=0,
            active=True,
        )
        target = resolve_my_work_status_target(self.project, "review")
        self.assertEqual(target.pk, early_review.pk)

        c = self._create("C", category="todo")
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="review", before_work_item_id=None,
        )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, early_review.pk)

    def test_cross_category_move_to_done_sets_completed_at(self):
        c = self._create("C", category="todo")
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="done", before_work_item_id=None,
        )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["done"])
        self.assertIsNotNone(c.completed_at)


# ── 7. Atomic rollback ────────────────────────────────────────────


class AtomicRollbackTest(_MyWorkBoardOrderBase, TestCase):
    def test_failed_placement_rolls_back_status_and_personal_order(self):
        a = self._create("A")
        b = self._create("B")
        c = self._create("C", position=7)
        # C positioned in the Todo column first.
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=b.pk,
        )
        before_state = self._board_state()
        before_rows = self._rows(self.alex)
        self.assertEqual(
            before_rows,
            {a.pk: ("todo", 1), c.pk: ("todo", 2), b.pk: ("todo", 3)},
        )

        # The personal placement fails INSIDE the transaction, after
        # the canonical status change was written: everything must
        # roll back together.
        with mock.patch.object(
            MyWorkBoardPosition.objects,
            "update_or_create",
            side_effect=WorkItemDomainError("placement failed"),
        ):
            with self.assertRaises(WorkItemDomainError):
                move_my_work_item(
                    user=self.alex, work_item=c,
                    status_category="review", before_work_item_id=None,
                )

        c.refresh_from_db()
        # Canonical status unchanged (rolled back)…
        self.assertEqual(c.status_definition_id, self.status_ids["todo"])
        # …no history event was persisted…
        self.assertEqual(self._history_events(c), [])
        # …and the personal order is exactly as before.
        self.assertEqual(self._board_state(), before_state)
        self.assertEqual(self._rows(self.alex), before_rows)

    def test_invalid_anchor_cross_category_changes_nothing(self):
        d = self._create(
            "D", category="review", assignee_ids=[self.chris.pk]
        )
        c = self._create("C", category="todo")
        before_state = self._board_state()
        client = APIClient()
        _login(client, "alex")

        # D is in Review but NOT in alex's My Work projection → the
        # anchor is invalid; the cross-category move is rejected
        # before anything changes.
        response = client.post(
            f"/api/me/work-items/{c.pk}/reorder/",
            data=json.dumps(
                {"statusCategory": "review", "beforeWorkItemId": d.pk}
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["todo"])
        self.assertEqual(self._board_state(), before_state)
        self.assertFalse(
            MyWorkBoardPosition.objects.filter(user=self.alex).exists()
        )
        self.assertEqual(self._history_events(c), [])

    def test_anchor_in_wrong_category_rejected_without_change(self):
        p = self._create(
            "P", category="in_progress", assignee_ids=[self.alex.pk]
        )
        c = self._create("C", category="todo")
        before_state = self._board_state()
        client = APIClient()
        _login(client, "alex")

        response = client.post(
            f"/api/me/work-items/{c.pk}/reorder/",
            data=json.dumps(
                {"statusCategory": "review", "beforeWorkItemId": p.pk}
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["todo"])
        self.assertEqual(self._board_state(), before_state)
        self.assertFalse(
            MyWorkBoardPosition.objects.filter(user=self.alex).exists()
        )


# ── 8. Missing target ─────────────────────────────────────────────


class MissingTargetTest(_MyWorkBoardOrderBase, TestCase):
    def _deactivate_review(self):
        review = self.project.status_definitions.get(
            category=WorkItemStatusDefinition.Category.REVIEW
        )
        review.active = False
        review.save(update_fields=["active"])

    def test_no_active_review_definition_rejects_move(self):
        c = self._create("C", category="todo")
        before_state = self._board_state()
        client = APIClient()
        _login(client, "alex")
        self._deactivate_review()

        # The Project has no active Review definition → the move is
        # invalid and nothing changes.
        response = client.post(
            f"/api/me/work-items/{c.pk}/reorder/",
            data=json.dumps({"statusCategory": "review"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["todo"])
        self.assertEqual(self._board_state(), before_state)
        self.assertFalse(
            MyWorkBoardPosition.objects.filter(user=self.alex).exists()
        )
        self.assertEqual(self._history_events(c), [])

    def test_service_missing_target_raises(self):
        self._deactivate_review()
        c = self._create("C", category="todo")
        before_state = self._board_state()
        with self.assertRaises(WorkItemDomainError):
            move_my_work_item(
                user=self.alex, work_item=c,
                status_category="review", before_work_item_id=None,
            )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["todo"])
        self.assertEqual(self._board_state(), before_state)


# ── 9. Authorization / non-leaking ────────────────────────────────


class AuthorizationTest(_MyWorkBoardOrderBase, TestCase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def move_as(self, work_item_id, status_category, before=_UNSET):
        payload = {"statusCategory": status_category}
        if before is not _UNSET:
            payload["beforeWorkItemId"] = before
        return self.client.post(
            f"/api/me/work-items/{work_item_id}/reorder/",
            data=json.dumps(payload),
            content_type="application/json",
        )

    def test_anonymous_rejected(self):
        c = self._create("C")
        response = self.move_as(c.pk, "todo")
        self.assertEqual(response.status_code, 401)

    def test_item_outside_users_my_work_is_404(self):
        # Assigned to chris only: invisible to alex's My Work.
        c = self._create("C", assignee_ids=[self.chris.pk])
        _login(self.client, "alex")
        response = self.move_as(c.pk, "todo")
        self.assertEqual(response.status_code, 404)

    def test_unassigned_item_is_404(self):
        c = self._create("C", assignee_ids=[])
        _login(self.client, "alex")
        response = self.move_as(c.pk, "todo")
        self.assertEqual(response.status_code, 404)

    def test_viewer_assignment_never_enters_my_work(self):
        # A viewer is not a canonical assignee; even a directly
        # forged assignment row must not enter the My Work
        # projection (role filter, defense in depth).
        c = self._create("C", assignee_ids=[self.alex.pk])
        WorkItemAssignee.objects.create(work_item=c, user=self.laura)
        _login(self.client, "laura")
        response = self.move_as(c.pk, "todo")
        self.assertEqual(response.status_code, 404)

    def test_group_member_without_project_membership_is_404(self):
        c = self._create("C", assignee_ids=[self.alex.pk])
        WorkItemAssignee.objects.create(work_item=c, user=self.maria)
        _login(self.client, "maria")
        response = self.move_as(c.pk, "todo")
        self.assertEqual(response.status_code, 404)

    def test_anchor_outside_users_my_work_is_400(self):
        own = self._create("OWN")
        other = self._create("OTHER", assignee_ids=[self.chris.pk])
        _login(self.client, "alex")
        response = self.move_as(own.pk, "todo", before=other.pk)
        self.assertEqual(response.status_code, 400)

    def test_anchor_cannot_be_the_moved_item(self):
        c = self._create("C")
        _login(self.client, "alex")
        response = self.move_as(c.pk, "todo", before=c.pk)
        self.assertEqual(response.status_code, 400)

    def test_unknown_work_item_is_404(self):
        _login(self.client, "alex")
        response = self.move_as(999999, "todo")
        self.assertEqual(response.status_code, 404)

    def test_invalid_status_category_is_400(self):
        c = self._create("C")
        _login(self.client, "alex")
        response = self.move_as(c.pk, "backlog")
        self.assertEqual(response.status_code, 400)
        # No personal row created.
        self.assertFalse(
            MyWorkBoardPosition.objects.filter(user=self.alex).exists()
        )

    def test_invalid_before_work_item_id_is_400(self):
        c = self._create("C")
        _login(self.client, "alex")
        response = self.move_as(c.pk, "todo", before="not-an-id")
        self.assertEqual(response.status_code, 400)


# ── 10. External status change voids the stale category ───────────


class StaleCategoryTest(_MyWorkBoardOrderBase, TestCase):
    def test_external_status_change_does_not_apply_old_position(self):
        a = self._create("A")
        b = self._create("B")
        c = self._create("C")
        # C explicitly positioned 2nd in the Todo column.
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=b.pk,
        )
        self.assertEqual(
            self._rows(self.alex),
            {a.pk: ("todo", 1), c.pk: ("todo", 2), b.pk: ("todo", 3)},
        )

        # D positioned in the Review column before C arrives.
        d = self._create("D", category="review")
        move_my_work_item(
            user=self.alex, work_item=d,
            status_category="review", before_work_item_id=None,
        )

        # Another canonical surface moves C to Review (status-only
        # transition; it does NOT touch the personal row).
        transition_work_item_status(
            work_item=c, actor=self.alex,
            status_definition_id=self.status_ids["review"],
        )
        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["review"])

        # The stale Todo position is NOT applied as a Review
        # position: C has no effective position in Review…
        self.assertEqual(
            effective_my_work_board_positions(self.alex, [c.pk]), {}
        )
        # …and in the Review column it sorts after the positioned D.
        self.assertEqual(
            self._effective_column(self.alex, "review"),
            [d.pk, c.pk],
        )
        # The Todo column keeps A/B without C.
        self.assertEqual(
            self._effective_column(self.alex, "todo"), [a.pk, b.pk]
        )

        # Until My Work ordering establishes a position for the new
        # category.
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="review", before_work_item_id=d.pk,
        )
        self.assertEqual(
            self._effective_column(self.alex, "review"),
            [c.pk, d.pk],
        )
        self.assertEqual(
            self._rows(self.alex),
            {a.pk: ("todo", 1), b.pk: ("todo", 3),
             d.pk: ("review", 2), c.pk: ("review", 1)},
        )

    def test_api_exposes_null_position_after_external_move(self):
        c = self._create("C")
        b = self._create("B")
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=b.pk,
        )
        client = APIClient()
        _login(client, "alex")

        # Move to Review through the canonical transition endpoint.
        response = client.post(
            f"/api/work-items/{c.pk}/transition-status/",
            data=json.dumps(
                {"statusDefinitionId": self.status_ids["review"]}
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)

        response = client.get("/api/me/work-items/")
        items = {item["id"]: item for item in response.json()}
        self.assertEqual(items[c.pk]["statusCategory"], "review")
        # The stale Todo position is not exposed as a Review position.
        self.assertIsNone(items[c.pk]["myWorkBoardPosition"])
        # B keeps its Todo position (two-item column: C=1, B=2).
        self.assertEqual(items[b.pk]["myWorkBoardPosition"], 2)


# ── 11. Project Board isolation ───────────────────────────────────


class ProjectBoardIsolationApiTest(_MyWorkBoardOrderBase, TestCase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()
        _login(self.client, "alex")

    def test_cross_column_move_preserves_project_board_column_order(self):
        # Project Board columns with an explicit manual order.
        d = self._create("D", category="review", position=1)
        e = self._create("E", category="review", position=2)
        c = self._create("C", category="todo", position=5)
        before = {
            wi.pk: (wi.status_definition_id, wi.board_position)
            for wi in WorkItem.objects.filter(project=self.project)
        }

        response = self.client.post(
            f"/api/me/work-items/{c.pk}/reorder/",
            data=json.dumps(
                {
                    "statusCategory": "review",
                    "beforeWorkItemId": d.pk,
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)

        after = {
            wi.pk: (wi.status_definition_id, wi.board_position)
            for wi in WorkItem.objects.filter(project=self.project)
        }
        # ONLY the moved item's status changed; every board_position
        # (moved item AND siblings) is value-for-value identical.
        self.assertEqual(after[c.pk][1], before[c.pk][1])
        self.assertEqual(after[c.pk][0], self.status_ids["review"])
        for pk, (status, pos) in before.items():
            if pk != c.pk:
                self.assertEqual(after[pk], (status, pos))

    def test_archived_project_cross_column_move_rejected(self):
        c = self._create("C", category="todo")
        self.project.archived_at = "2026-01-01T00:00:00Z"
        self.project.save(update_fields=["archived_at"])
        before_state = self._board_state()

        response = self.client.post(
            f"/api/me/work-items/{c.pk}/reorder/",
            data=json.dumps({"statusCategory": "review"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

        c.refresh_from_db()
        self.assertEqual(c.status_definition_id, self.status_ids["todo"])
        self.assertEqual(self._board_state(), before_state)
        self.assertFalse(
            MyWorkBoardPosition.objects.filter(user=self.alex).exists()
        )


# ── 12. Deletion / stale data ─────────────────────────────────────


class DeletionTest(_MyWorkBoardOrderBase, TestCase):
    def test_deleting_a_work_item_removes_its_personal_rows(self):
        a = self._create("A")
        b = self._create("B")
        c = self._create("C")
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=b.pk,
        )
        self.assertEqual(
            MyWorkBoardPosition.objects.filter(user=self.alex).count(), 3
        )

        delete_work_item(work_item=c, actor=self.alex)

        self.assertFalse(
            MyWorkBoardPosition.objects.filter(work_item_id=c.pk).exists()
        )
        self.assertEqual(
            self._rows(self.alex),
            {a.pk: ("todo", 1), b.pk: ("todo", 3)},
        )
        # The surviving column is still deterministic and usable.
        self.assertEqual(
            self._effective_column(self.alex, "todo"), [a.pk, b.pk]
        )

    def test_deleting_anchor_item_keeps_ordering_valid(self):
        a = self._create("A")
        b = self._create("B")
        c = self._create("C")
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=b.pk,
        )
        delete_work_item(work_item=b, actor=self.alex)
        # A and C keep their positions; the column renders A, C.
        self.assertEqual(
            self._effective_column(self.alex, "todo"), [a.pk, c.pk]
        )

    def test_lost_assignment_never_exposes_stale_metadata(self):
        c = self._create("C", assignee_ids=[self.alex.pk, self.chris.pk])
        b = self._create("B", assignee_ids=[self.alex.pk, self.chris.pk])
        # Chris positions C in his own column…
        move_my_work_item(
            user=self.chris, work_item=c,
            status_category="todo", before_work_item_id=b.pk,
        )
        # …then loses the assignment.
        WorkItemAssignee.objects.filter(
            work_item=c, user=self.chris
        ).delete()

        # Chris's projection no longer contains C — the stale row
        # can therefore never be read through the API.
        projection_ids = set(
            personal_my_work_queryset(self.chris)
            .values_list("pk", flat=True)
        )
        self.assertNotIn(c.pk, projection_ids)

        client = APIClient()
        _login(client, "chris")
        response = client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        items = {item["id"]: item for item in response.json()}
        # C is absent from the payload entirely (no stale metadata,
        # no access)…
        self.assertNotIn(c.pk, items)
        # …while B keeps Chris's personal position.
        self.assertEqual(items[b.pk]["myWorkBoardPosition"], 2)

    def test_lost_project_access_never_exposes_stale_metadata(self):
        c = self._create("C", assignee_ids=[self.chris.pk])
        b = self._create("B", assignee_ids=[self.chris.pk])
        move_my_work_item(
            user=self.chris, work_item=c,
            status_category="todo", before_work_item_id=b.pk,
        )
        # Chris loses Project access (the projection requires the
        # ProjectMembership as well as the assignment).
        from projects.models import ProjectMembership

        ProjectMembership.objects.filter(
            project=self.project, user=self.chris
        ).delete()

        # Chris's My Work is empty: nothing is visible and no stale
        # personal metadata is exposed or grants access.
        client = APIClient()
        _login(client, "chris")
        response = client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])


# ── Misc contract details ─────────────────────────────────────────


class ContractDetailsTest(_MyWorkBoardOrderBase, TestCase):
    def test_success_response_carries_canonical_payload(self):
        c = self._create("C")
        client = APIClient()
        _login(client, "alex")
        response = client.post(
            f"/api/me/work-items/{c.pk}/reorder/",
            data=json.dumps({"statusCategory": "todo"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["id"], c.pk)
        self.assertEqual(payload["projectId"], self.project.pk)
        self.assertEqual(payload["title"], "C")
        self.assertEqual(
            payload["statusDefinitionId"], self.status_ids["todo"]
        )

    def test_repeated_move_to_same_position_is_stable(self):
        a = self._create("A")
        b = self._create("B")
        c = self._create("C")
        # C is at the end → moving it to the end again is stable.
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=None,
        )
        self.assertEqual(
            self._effective_column(self.alex, "todo"),
            [a.pk, b.pk, c.pk],
        )
        self.assertEqual(self._history_events(c), [])
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=None,
        )
        self.assertEqual(
            self._effective_column(self.alex, "todo"),
            [a.pk, b.pk, c.pk],
        )
        self.assertEqual(self._history_events(c), [])


# ── 13. Serialization: lock order + deterministic composition ─────


class SerializationContractTest(_MyWorkBoardOrderBase, TestCase):
    """Deterministic regression for the per-user serialization
    contract.

    The product invariant under test: the requesting user's User row
    is the FIRST lock root of every move — same-user My Work reorder
    operations (even across Projects) serialize on that one stable
    per-user row, and personal column normalization never locks
    canonical sibling Work Items, so different users do not contend
    on those rows merely because their personal columns overlap
    (cross-category moves may still legitimately contend on the
    canonical Project / moved Work Item locks the status mutation
    requires). A
    same-category personal reorder takes NO canonical Project /
    Work Item row lock (the sibling Work Items used to compute the
    personal column are read, never locked — a Work Item assigned to
    several users must not become a cross-user lock target), and the
    canonical Project / moved Work Item locks are taken only on the
    cross-category path, where the canonical status mutation
    requires them.

    The earlier true-concurrency threaded tests demonstrated the
    pre-fix deadlock but fail in the repository-wide Django test
    harness (worker-thread connections; ENVIRONMENT/HARNESS), so the
    contract is now pinned deterministically: a select_for_update
    call-order spy for the narrow lock contract, plus plain
    sequential database behavior for composition and isolation.
    """

    def _second_project(self):
        return create_project(
            research_group=self.data["group"],
            creator=self.alex,
            name="Paper ABC",
        )

    def _create_in(self, project, title, assignee_ids=None):
        status_ids = {
            status.category: status.pk
            for status in project.status_definitions.all()
        }
        return create_work_item(
            project=project,
            actor=self.alex,
            type_definition_id=(
                project.type_definitions.get(name="Task").pk
            ),
            title=title,
            status_definition_id=status_ids["todo"],
            assignee_ids=(
                assignee_ids if assignee_ids is not None else [self.alex.pk]
            ),
        )

    def _spy_lock_order(self):
        """Record every select_for_update acquisition of the current
        move, tagged by the locked model class.

        The spy hooks QuerySet.select_for_update — the single
        acquisition point for every row lock in move_my_work_item
        (manager-level ``Model.objects.select_for_update()`` calls
        delegate to the same QuerySet method) — and each spy call
        delegates to the REAL method, so the move still runs against
        the actual database with genuine row locks.
        """
        order = []
        original = QuerySet.select_for_update

        def wrapper(self, *args, **kwargs):
            order.append(self.model)
            return original(self, *args, **kwargs)

        return order, mock.patch.object(
            QuerySet, "select_for_update", wrapper
        )

    def test_user_row_is_the_first_lock_root_of_the_move(self):
        """The requesting user's User row is locked FIRST inside the
        move — and a same-category personal reorder takes NO other
        canonical row lock: after the per-user root only the user's
        own personal-position rows are locked, never the Project row
        or any Work Item row (sibling Work Items are read, not
        locked) — so concurrent same-user moves (even in different
        Projects) serialize on one stable per-user row, and personal
        column normalization never locks canonical sibling Work
        Items: two users with overlapping assignments do not
        contend on canonical Work Item rows merely because their
        personal columns overlap."""
        a = self._create("A")
        b = self._create("B")
        user_model = get_user_model()

        order, patcher = self._spy_lock_order()
        with patcher:
            moved = move_my_work_item(
                user=self.alex, work_item=a,
                status_category="todo", before_work_item_id=b.pk,
            )

        self.assertEqual(moved.pk, a.pk)
        # Lock order: the User row is the first lock root; every
        # lock after it is the user's own personal-position row.
        self.assertEqual(order[0], user_model)
        self.assertEqual(set(order[1:]), {MyWorkBoardPosition})
        # No canonical row lock at all on a same-category personal
        # reorder.
        self.assertNotIn(Project, order)
        self.assertNotIn(WorkItem, order)
        # The per-user lock root is acquired exactly once per move.
        self.assertEqual(order.count(user_model), 1)
        # The move itself still applied the personal ordering.
        self.assertEqual(
            self._rows(self.alex),
            {a.pk: ("todo", 1), b.pk: ("todo", 2)},
        )

    def test_user_row_locks_first_on_cross_category_moves_too(self):
        """The cross-category path takes the canonical Project +
        moved Work Item locks — only where the canonical status
        mutation requires them — AFTER the per-user root: the User
        row is still the FIRST lock root and the only per-user lock,
        then the Project + moved Work Item locks (the canonical
        transition re-acquires them as a no-op), then only the
        user's own personal-position rows."""
        a = self._create("A", category="todo")
        b = self._create("B", category="review")
        user_model = get_user_model()

        order, patcher = self._spy_lock_order()
        with patcher:
            move_my_work_item(
                user=self.alex, work_item=a,
                status_category="review", before_work_item_id=b.pk,
            )

        self.assertEqual(order[0], user_model)
        self.assertEqual(order.count(user_model), 1)
        # The canonical Project / moved Work Item locks come right
        # after the per-user root, the canonical transition
        # re-validates under the same locks, then only the user's
        # own personal-position rows.
        self.assertEqual(order[1], Project)
        self.assertEqual(order[2], WorkItem)
        self.assertEqual(
            set(order[3:]), {Project, WorkItem, MyWorkBoardPosition}
        )

    def test_same_category_move_locks_no_shared_sibling_work_items(self):
        """The cross-user ABBA configuration: the moved Work Item
        and its column siblings are each assigned to TWO users, so
        both users' personal columns overlap while each holds its
        own User-row lock. A same-category reorder must take NO
        canonical Project / Work Item row lock — only the per-user
        root and the user's own personal-position rows — so two
        users with overlapping assignments can never deadlock on
        each other's shared canonical Work Item rows."""
        a = self._create("A", assignee_ids=[self.alex.pk, self.chris.pk])
        b = self._create("B", assignee_ids=[self.alex.pk, self.chris.pk])
        c = self._create("C", assignee_ids=[self.alex.pk, self.chris.pk])
        user_model = get_user_model()

        order, patcher = self._spy_lock_order()
        with patcher:
            move_my_work_item(
                user=self.alex, work_item=a,
                status_category="todo", before_work_item_id=b.pk,
            )

        # No canonical row lock at all: the Project row and every
        # Work Item row (moved item and multi-assignee siblings) are
        # read, never select_for_update locked.
        self.assertNotIn(Project, order)
        self.assertNotIn(WorkItem, order)
        # Only the per-user root, then the user's own position rows.
        self.assertEqual(order[0], user_model)
        self.assertEqual(order.count(user_model), 1)
        self.assertEqual(set(order[1:]), {MyWorkBoardPosition})
        # The personal ordering was applied (A before B on the
        # unpositioned column [A, B, C] stays [A, B, C]) — and the
        # co-assignee's shared column was not touched.
        self.assertEqual(
            self._rows(self.alex),
            {a.pk: ("todo", 1), b.pk: ("todo", 2), c.pk: ("todo", 3)},
        )
        self.assertEqual(self._rows(self.chris), {})

    def test_sequential_cross_project_moves_stay_deterministic_and_unique(
        self,
    ):
        """The sequential composition the User-row lock enforces
        under concurrency: two same-user moves across Projects apply
        one after the other (the second reads the state the first
        left behind) and the final personal positions are
        deterministic and unique — never a stale-column snapshot."""
        a = self._create("A")  # Project 1
        b = self._create("B")  # Project 1
        p2 = self._second_project()
        c = self._create_in(p2, "C")  # Project 2
        d = self._create_in(p2, "D")  # Project 2

        move_my_work_item(
            user=self.alex, work_item=a,
            status_category="todo", before_work_item_id=c.pk,
        )
        move_my_work_item(
            user=self.alex, work_item=c,
            status_category="todo", before_work_item_id=a.pk,
        )

        # "A before C" on the unpositioned column [A, B, C, D] →
        # [B, A, C, D]; then "C before A" applied to the state the
        # first move left behind → [B, C, A, D].
        self.assertEqual(
            self._rows(self.alex),
            {
                b.pk: ("todo", 1),
                c.pk: ("todo", 2),
                a.pk: ("todo", 3),
                d.pk: ("todo", 4),
            },
        )
        positions = [pos for _, pos in self._rows(self.alex).values()]
        self.assertEqual(sorted(positions), [1, 2, 3, 4])

    def test_different_user_ordering_stays_isolated_under_interleaving(
        self,
    ):
        """Interleaved moves by different users (different per-user
        lock rows) each produce their own deterministic column and
        never touch the other user's ordering."""
        x = self._create("X")
        w = self._create("W")
        p2 = self._second_project()
        add_project_membership(
            project=p2,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        y = self._create_in(p2, "Y", assignee_ids=[self.chris.pk])
        z = self._create_in(p2, "Z", assignee_ids=[self.chris.pk])

        # Interleave the two users' moves over time.
        move_my_work_item(
            user=self.alex, work_item=w,
            status_category="todo", before_work_item_id=x.pk,
        )
        move_my_work_item(
            user=self.chris, work_item=z,
            status_category="todo", before_work_item_id=y.pk,
        )
        move_my_work_item(
            user=self.alex, work_item=x,
            status_category="todo", before_work_item_id=w.pk,
        )
        move_my_work_item(
            user=self.chris, work_item=y,
            status_category="todo", before_work_item_id=z.pk,
        )

        # Each user's final column is exactly their own
        # composition; no user's rows were written by the other.
        self.assertEqual(
            self._rows(self.alex),
            {x.pk: ("todo", 1), w.pk: ("todo", 2)},
        )
        self.assertEqual(
            self._rows(self.chris),
            {y.pk: ("todo", 1), z.pk: ("todo", 2)},
        )
