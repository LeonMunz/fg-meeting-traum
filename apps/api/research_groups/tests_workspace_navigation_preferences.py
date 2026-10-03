"""Tests for the persistent server-side workspace navigation preferences.

Covers the workspace navigation preferences contract
(``docs/domain/foundation.md`` §2):
- authenticated GET/PATCH /api/me/preferences/workspace-navigation/
  over a complete snapshot (researchGroupOrder +
  expandedResearchGroups + expandedProjectSections),
- deterministic default Research Group order (``created_at`` ASC,
  primary key ASC) for users without a preference row,
- a clean read never creates a row,
- complete-snapshot PATCH: stored order preserved for
  still-accessible Research Groups, stale / inaccessible IDs
  discarded, missing accessible groups appended in default order,
- current access always wins over stored IDs (stale selections are
  sanitized on the next load and the cleaned state is persisted),
- preferences are personal view state, never authorization,
- fail-closed structural validation (400, nothing persisted).
"""

import json
from datetime import datetime, timedelta, timezone

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext

from rest_framework.test import APIClient, APITestCase

from .models import (
    ResearchGroup,
    ResearchGroupMembership,
    WorkspaceNavigationPreferences,
)

User = get_user_model()

URL = "/api/me/preferences/workspace-navigation/"

# Deterministic created_at anchors for the default-order rules
# (``created_at`` ASC, then primary key ASC) — the established
# Activity-feed test pattern of pinning created_at explicitly.
BASE_CREATED_AT = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)


class WorkspaceNavigationPreferencesApiTest(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="wsnav_alice",
            password="TestPass1!",
        )
        cls.bob = User.objects.create_user(
            username="wsnav_bob",
            password="TestPass1!",
        )
        # dave has NO memberships at all.
        cls.dave = User.objects.create_user(
            username="wsnav_dave",
            password="TestPass1!",
        )

        # Controlled created_at so the deterministic default order
        # (created_at ASC, pk ASC) is explicit: a < b < c < d.
        cls.group_a = ResearchGroup.objects.create(
            name="FG Cognitive Science",
            created_by=cls.alice,
        )
        ResearchGroup.objects.filter(pk=cls.group_a.pk).update(
            created_at=BASE_CREATED_AT
        )
        cls.group_b = ResearchGroup.objects.create(
            name="Robotics Lab",
            created_by=cls.alice,
        )
        ResearchGroup.objects.filter(pk=cls.group_b.pk).update(
            created_at=BASE_CREATED_AT + timedelta(days=1)
        )
        # group_c / group_d: nobody belongs to them in the fixture —
        # group_c is the inaccessible-group probe, group_d becomes
        # accessible to alice in the late-join test.
        cls.group_c = ResearchGroup.objects.create(
            name="Quantum Group",
            created_by=cls.bob,
        )
        ResearchGroup.objects.filter(pk=cls.group_c.pk).update(
            created_at=BASE_CREATED_AT + timedelta(days=2)
        )
        cls.group_d = ResearchGroup.objects.create(
            name="Materials Group",
            created_by=cls.bob,
        )
        ResearchGroup.objects.filter(pk=cls.group_d.pk).update(
            created_at=BASE_CREATED_AT + timedelta(days=3)
        )

        # alice ∈ {a, b}; bob ∈ {a}; dave ∈ {}.
        for group in (cls.group_a, cls.group_b):
            ResearchGroupMembership.objects.create(
                research_group=group,
                user=cls.alice,
                role=ResearchGroupMembership.Role.MEMBER,
            )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_a,
            user=cls.bob,
            role=ResearchGroupMembership.Role.MEMBER,
        )

    def setUp(self):
        self.client = APIClient()

    # ── helpers ────────────────────────────────────────────────

    def _login(self, user):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        response = self.client.post(
            "/api/auth/login/",
            data={
                "username": user.username,
                "password": "TestPass1!",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)
        self._csrf = csrf_token

    def _get(self):
        return self.client.get(URL)

    def _patch(self, payload, raw=None):
        if raw is not None:
            return self.client.patch(
                URL,
                data=raw,
                content_type="application/json",
                HTTP_X_CSRFTOKEN=self._csrf,
            )
        return self.client.patch(
            URL,
            data=payload,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=self._csrf,
        )

    def _row(self, user):
        return WorkspaceNavigationPreferences.objects.filter(
            user=user
        ).first()

    def _assert_snapshot(
        self, response, order, expanded, project_sections
    ):
        body = response.json()
        self.assertEqual(body["researchGroupOrder"], order)
        self.assertEqual(
            body["expandedResearchGroups"], expanded
        )
        self.assertEqual(
            body["expandedProjectSections"], project_sections
        )

    # ── authentication ─────────────────────────────────────────

    def test_anonymous_get_rejected(self):
        response = self.client.get(URL)
        self.assertEqual(response.status_code, 401)

    def test_anonymous_patch_rejected(self):
        response = self.client.patch(
            URL,
            data={"researchGroupOrder": [self.group_a.pk]},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)

    # ── defaults (no row) ──────────────────────────────────────

    def test_get_without_row_returns_deterministic_order(self):
        # alice ∈ {a, b}; default order is created_at ASC (a < b).
        self._login(self.alice)
        response = self._get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "researchGroupOrder": [self.group_a.pk, self.group_b.pk],
                "expandedResearchGroups": [],
                "expandedProjectSections": [],
            },
        )

    def test_get_without_row_creates_no_row(self):
        self._login(self.alice)
        self.assertEqual(self._get().status_code, 200)
        self.assertEqual(
            WorkspaceNavigationPreferences.objects.count(), 0
        )
        self.assertIsNone(self._row(self.alice))

    def test_get_without_row_and_without_groups_returns_empty_order(
        self,
    ):
        self._login(self.dave)
        response = self._get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "researchGroupOrder": [],
                "expandedResearchGroups": [],
                "expandedProjectSections": [],
            },
        )
        self.assertIsNone(self._row(self.dave))

    # ── round trip ─────────────────────────────────────────────

    def test_patch_then_get_round_trip(self):
        self._login(self.alice)
        payload = {
            "researchGroupOrder": [
                self.group_b.pk,
                self.group_a.pk,
            ],
            "expandedResearchGroups": [self.group_a.pk],
            "expandedProjectSections": [
                self.group_b.pk,
                self.group_a.pk,
            ],
        }
        response = self._patch(payload)
        self.assertEqual(response.status_code, 200)
        self._assert_snapshot(
            response,
            [self.group_b.pk, self.group_a.pk],
            [self.group_a.pk],
            [self.group_b.pk, self.group_a.pk],
        )
        response = self._get()
        self.assertEqual(response.status_code, 200)
        self._assert_snapshot(
            response,
            [self.group_b.pk, self.group_a.pk],
            [self.group_a.pk],
            [self.group_b.pk, self.group_a.pk],
        )
        row = self._row(self.alice)
        self.assertIsNotNone(row)
        self.assertEqual(
            row.research_group_order,
            [self.group_b.pk, self.group_a.pk],
        )
        self.assertEqual(
            row.expanded_research_groups, [self.group_a.pk]
        )
        self.assertEqual(
            row.expanded_project_sections,
            [self.group_b.pk, self.group_a.pk],
        )

    # ── user isolation ─────────────────────────────────────────

    def test_two_users_have_independent_preferences(self):
        self._login(self.alice)
        self._patch(
            {
                "researchGroupOrder": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedResearchGroups": [self.group_a.pk],
                "expandedProjectSections": [self.group_b.pk],
            }
        )

        # bob (∈ {a} only) sees his own default, unaffected by
        # alice's state.
        self._login(self.bob)
        self._assert_snapshot(
            self._get(),
            [self.group_a.pk],
            [],
            [],
        )

        # Bob's own save must not disturb Alice's state.
        self._patch(
            {
                "researchGroupOrder": [self.group_a.pk],
                "expandedResearchGroups": [self.group_a.pk],
                "expandedProjectSections": [self.group_a.pk],
            }
        )
        self._login(self.alice)
        self._assert_snapshot(
            self._get(),
            [self.group_b.pk, self.group_a.pk],
            [self.group_a.pk],
            [self.group_b.pk],
        )

    # ── reordering never mutates domain data ──────────────────

    def test_reorder_never_mutates_research_group_domain_data(self):
        self._login(self.alice)
        before = {
            group.pk: (
                group.name,
                group.created_at,
                group.updated_at,
                group.created_by_id,
            )
            for group in ResearchGroup.objects.all()
        }
        group_count = ResearchGroup.objects.count()

        # Reorder + expand: a purely personal write.
        response = self._patch(
            {
                "researchGroupOrder": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedResearchGroups": [
                    self.group_a.pk,
                    self.group_b.pk,
                ],
                "expandedProjectSections": [self.group_a.pk],
            }
        )
        self.assertEqual(response.status_code, 200)

        # No Research Group row was created, renamed, reordered, or
        # rewritten (created_at / updated_at untouched).
        self.assertEqual(ResearchGroup.objects.count(), group_count)
        after = {
            group.pk: (
                group.name,
                group.created_at,
                group.updated_at,
                group.created_by_id,
            )
            for group in ResearchGroup.objects.all()
        }
        self.assertEqual(before, after)

        # Another user's ordering is untouched (bob's default is
        # still just [a]).
        self._login(self.bob)
        self._assert_snapshot(self._get(), [self.group_a.pk], [], [])

    # ── access-constrained normalization ───────────────────────

    def test_inaccessible_group_ids_not_persisted_or_returned(self):
        # group_c: nobody's group. Unknown ID 999999 probes the
        # non-leaking behavior.
        self._login(self.alice)
        response = self._patch(
            {
                "researchGroupOrder": [
                    self.group_c.pk,
                    self.group_a.pk,
                    999999,
                    self.group_b.pk,
                ],
                "expandedResearchGroups": [
                    self.group_c.pk,
                    self.group_a.pk,
                ],
                "expandedProjectSections": [self.group_c.pk],
            }
        )
        self.assertEqual(response.status_code, 200)
        # c and the unknown ID are discarded; a and b survive in the
        # stored relative order.
        self._assert_snapshot(
            response,
            [self.group_a.pk, self.group_b.pk],
            [self.group_a.pk],
            [],
        )
        self._assert_snapshot(
            self._get(),
            [self.group_a.pk, self.group_b.pk],
            [self.group_a.pk],
            [],
        )
        row = self._row(self.alice)
        self.assertNotIn(self.group_c.pk, row.research_group_order)
        self.assertNotIn(999999, row.research_group_order)
        self.assertNotIn(self.group_c.pk, row.expanded_research_groups)
        self.assertNotIn(self.group_c.pk, row.expanded_project_sections)

    def test_stale_group_removed_after_membership_loss(self):
        self._login(self.alice)
        self._patch(
            {
                "researchGroupOrder": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedResearchGroups": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedProjectSections": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
            }
        )

        # Alice loses group_b.
        ResearchGroupMembership.objects.filter(
            research_group=self.group_b, user=self.alice,
        ).delete()

        response = self._get()
        self.assertEqual(response.status_code, 200)
        # b disappears from the ordering and BOTH expansion
        # collections; a survives in the stored position — and
        # its still-valid expansion states are retained.
        self._assert_snapshot(
            response,
            [self.group_a.pk],
            [self.group_a.pk],
            [self.group_a.pk],
        )

    def test_sanitization_persists_cleaned_state(self):
        self._login(self.alice)
        self._patch(
            {
                "researchGroupOrder": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedResearchGroups": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedProjectSections": [self.group_b.pk],
            }
        )

        ResearchGroupMembership.objects.filter(
            research_group=self.group_b, user=self.alice,
        ).delete()

        # The first GET triggers sanitization...
        response = self._get()
        self.assertEqual(response.status_code, 200)
        # b is dropped everywhere; a's expansion states survive.
        self._assert_snapshot(
            response, [self.group_a.pk], [self.group_a.pk], []
        )

        # ...and the cleaned state must BE the persisted state, not
        # a temporary projection: the DB row itself is cleaned.
        row = self._row(self.alice)
        self.assertIsNotNone(row)
        self.assertEqual(row.research_group_order, [self.group_a.pk])
        self.assertEqual(row.expanded_research_groups, [self.group_a.pk])
        self.assertEqual(row.expanded_project_sections, [])

        # A second GET returns the same cleaned state from the DB.
        self._assert_snapshot(
            self._get(),
            [self.group_a.pk],
            [self.group_a.pk],
            [],
        )

    def test_newly_accessible_groups_appended_in_default_order(self):
        self._login(self.alice)
        # Store a personal order over the currently accessible
        # groups (b first, then a).
        self._patch(
            {
                "researchGroupOrder": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedResearchGroups": [],
                "expandedProjectSections": [],
            }
        )

        # Alice later joins group_c AND group_d (c created before
        # d → default order appends c, then d).
        for group in (self.group_c, self.group_d):
            ResearchGroupMembership.objects.create(
                research_group=group,
                user=self.alice,
                role=ResearchGroupMembership.Role.MEMBER,
            )

        response = self._get()
        self.assertEqual(response.status_code, 200)
        # Stored accessible entries keep their position; the newly
        # accessible groups are appended after them in the
        # deterministic default order (created_at ASC: c < d).
        self.assertEqual(
            response.json()["researchGroupOrder"],
            [
                self.group_b.pk,
                self.group_a.pk,
                self.group_c.pk,
                self.group_d.pk,
            ],
        )
        # The appended groups are persisted as part of the order.
        row = self._row(self.alice)
        self.assertEqual(
            row.research_group_order,
            [
                self.group_b.pk,
                self.group_a.pk,
                self.group_c.pk,
                self.group_d.pk,
            ],
        )

    def test_each_accessible_group_appears_exactly_once(self):
        self._login(self.alice)
        response = self._get()
        self.assertEqual(response.status_code, 200)
        order = response.json()["researchGroupOrder"]
        self.assertEqual(len(order), len(set(order)))
        self.assertEqual(
            set(order), {self.group_a.pk, self.group_b.pk}
        )

    # ── duplicates ─────────────────────────────────────────────

    def test_duplicate_ids_do_not_survive_normalization(self):
        self._login(self.alice)
        response = self._patch(
            {
                "researchGroupOrder": [
                    self.group_b.pk,
                    self.group_b.pk,
                    self.group_a.pk,
                    self.group_a.pk,
                    self.group_b.pk,
                ],
                "expandedResearchGroups": [
                    self.group_a.pk,
                    self.group_a.pk,
                    self.group_b.pk,
                ],
                "expandedProjectSections": [
                    self.group_b.pk,
                    self.group_b.pk,
                ],
            }
        )
        self.assertEqual(response.status_code, 200)
        # Order-preserving deduplication (b kept at its first
        # position); each group exactly once.
        self.assertEqual(
            response.json()["researchGroupOrder"],
            [self.group_b.pk, self.group_a.pk],
        )
        self.assertEqual(
            response.json()["expandedResearchGroups"],
            [self.group_a.pk, self.group_b.pk],
        )
        self.assertEqual(
            response.json()["expandedProjectSections"],
            [self.group_b.pk],
        )
        row = self._row(self.alice)
        self.assertEqual(
            row.research_group_order,
            [self.group_b.pk, self.group_a.pk],
        )
        self.assertEqual(
            row.expanded_research_groups,
            [self.group_a.pk, self.group_b.pk],
        )
        self.assertEqual(row.expanded_project_sections, [self.group_b.pk])

    # ── preferences are never authorization ────────────────────

    def test_preferences_never_grant_research_group_access(self):
        # dave has NO memberships. Give him a preference row
        # pointing at alice's groups: none of it may surface in the
        # Research Group collection or detail reads.
        prefs, _ = WorkspaceNavigationPreferences.objects.get_or_create(
            user=self.dave,
        )
        prefs.research_group_order = [
            self.group_a.pk,
            self.group_c.pk,
        ]
        prefs.expanded_research_groups = [self.group_a.pk]
        prefs.expanded_project_sections = [self.group_c.pk]
        prefs.save()

        self._login(self.dave)
        response = self.client.get("/api/research-groups/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])
        response = self.client.get(
            f"/api/research-groups/{self.group_a.pk}/"
        )
        self.assertEqual(response.status_code, 404)
        response = self.client.get(
            f"/api/research-groups/{self.group_c.pk}/"
        )
        self.assertEqual(response.status_code, 404)

        # His own preference snapshot is sanitized to empty — the
        # stored IDs are inaccessible and are dropped.
        self._assert_snapshot(self._get(), [], [], [])

    def test_own_access_survives_sanitization(self):
        # Saving a preference must never revoke the user's REAL
        # access: alice still lists her groups.
        self._login(self.alice)
        self._patch(
            {
                "researchGroupOrder": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedResearchGroups": [self.group_a.pk],
                "expandedProjectSections": [],
            }
        )
        response = self.client.get("/api/research-groups/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            {group["id"] for group in response.json()},
            {self.group_a.pk, self.group_b.pk},
        )

    # ── fail-closed structural validation ──────────────────────

    def test_invalid_payload_structure_rejected(self):
        self._login(self.alice)
        for payload in (
            {"researchGroupOrder": "group_a"},
            {"researchGroupOrder": [self.group_a.pk, "x"]},
            {"expandedResearchGroups": [str(self.group_a.pk)]},
            {"expandedResearchGroups": [True]},
            {"expandedProjectSections": {self.group_a.pk: 1}},
            {"expandedProjectSections": 5},
        ):
            with self.subTest(payload=payload):
                response = self._patch(payload)
                self.assertEqual(response.status_code, 400)
        # A JSON array is not a JSON object: rejected the same way.
        response = self._patch(
            None,
            raw=json.dumps([self.group_a.pk]),
        )
        self.assertEqual(response.status_code, 400)
        # Nothing was persisted.
        self.assertIsNone(self._row(self.alice))

    def test_invalid_payload_does_not_partially_mutate_stored_snapshot(
        self,
    ):
        self._login(self.alice)
        self._patch(
            {
                "researchGroupOrder": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedResearchGroups": [self.group_a.pk],
                "expandedProjectSections": [self.group_b.pk],
            }
        )
        before = self._row(self.alice)
        before_order = list(before.research_group_order)
        before_expanded = list(before.expanded_research_groups)
        before_sections = list(before.expanded_project_sections)

        response = self._patch(
            {
                "researchGroupOrder": [self.group_a.pk],
                "expandedResearchGroups": "not-a-list",
                "expandedProjectSections": [self.group_a.pk],
            }
        )
        self.assertEqual(response.status_code, 400)

        row = self._row(self.alice)
        self.assertEqual(row.pk, before.pk)
        self.assertEqual(row.research_group_order, before_order)
        self.assertEqual(row.expanded_research_groups, before_expanded)
        self.assertEqual(row.expanded_project_sections, before_sections)

    def test_patch_missing_fields_default_to_empty(self):
        # The contract is a COMPLETE snapshot: missing categories
        # fail closed to their defaults (no implicit "no change") —
        # the order falls back to the deterministic default order of
        # the user's accessible Research Groups.
        self._login(self.alice)
        self._patch(
            {
                "researchGroupOrder": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedResearchGroups": [self.group_a.pk],
                "expandedProjectSections": [self.group_b.pk],
            }
        )
        response = self._patch({})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "researchGroupOrder": [
                    self.group_a.pk,
                    self.group_b.pk,
                ],
                "expandedResearchGroups": [],
                "expandedProjectSections": [],
            },
        )

    # ── query budget (no per-ID lookup pattern) ────────────────

    def test_get_query_count_is_bounded(self):
        self._login(self.alice)
        self._patch(
            {
                "researchGroupOrder": [
                    self.group_b.pk,
                    self.group_a.pk,
                ],
                "expandedResearchGroups": [
                    self.group_a.pk,
                    self.group_b.pk,
                ],
                "expandedProjectSections": [self.group_a.pk],
            }
        )
        with CaptureQueriesContext(connection) as ctx:
            response = self._get()
        self.assertEqual(response.status_code, 200)
        # A per-ID lookup over the stored selections would add at
        # least as many extra queries as stored IDs on top of the
        # constant boundary queries.
        self.assertLessEqual(len(ctx.captured_queries), 12)
