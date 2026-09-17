"""Tests for the persistent server-side My Work preferences.

Covers the Slice 1 contract of the My Work Filter System:
- authenticated GET/PATCH /api/me/preferences/my-work/ over a
  complete snapshot (viewMode + researchGroupIds + projectIds +
  workItemTypes),
- default snapshot for users without a preference row,
- fail-closed structural validation,
- canonical semantic type kind values only (never display names),
- current access always wins over stored IDs (stale selections are
  sanitized on the next load and the cleaned state is persisted),
- Research Group → Project selection dependency,
- preferences are personal view state, never authorization.
"""

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext

from rest_framework.test import APIClient, APITestCase

from projects.configuration_services import (
    create_type_definition,
    update_type_definition,
)
from projects.models import ProjectMembership
from projects.services import create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.models import MyWorkPreferences, WorkItemAssignee
from work_items.my_work_preferences import (
    default_my_work_snapshot,
)
from work_items.services import create_work_item

User = get_user_model()

URL = "/api/me/preferences/my-work/"


class MyWorkPreferencesApiTest(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = User.objects.create_user(
            username="prefs_alice",
            password="TestPass1!",
        )
        cls.bob = User.objects.create_user(
            username="prefs_bob",
            password="TestPass1!",
        )
        # dave has NO memberships at all.
        cls.dave = User.objects.create_user(
            username="prefs_dave",
            password="TestPass1!",
        )

        # group_c exists but nobody in this fixture belongs to it
        # (inaccessible-group probe).
        cls.group_a = ResearchGroup.objects.create(
            name="FG Cognitive Science",
            created_by=cls.alice,
        )
        cls.group_b = ResearchGroup.objects.create(
            name="Robotics Lab",
            created_by=cls.alice,
        )
        cls.group_c = ResearchGroup.objects.create(
            name="Quantum Group",
            created_by=cls.bob,
        )

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

        # alice owns pa1 (group_a) and pb1 (group_b);
        # pa2 (group_a) is bob's — alice has group access but NO
        # ProjectMembership in pa2.
        cls.pa1 = create_project(
            research_group=cls.group_a,
            creator=cls.alice,
            name="Paper XYZ",
        )
        cls.pb1 = create_project(
            research_group=cls.group_b,
            creator=cls.alice,
            name="Robot Study",
        )
        cls.pa2 = create_project(
            research_group=cls.group_a,
            creator=cls.bob,
            name="Bob's Private Project",
        )

        cls.work_a = create_work_item(
            project=cls.pa1,
            actor=cls.alice,
            type_definition_id=cls.pa1.type_definitions.get(name="Task").pk,
            title="Rewrite Introduction",
            assignee_ids=[cls.alice.pk],
        )

    def setUp(self):
        self.client = APIClient()

    # ── helpers ────────────────────────────────────────────────

    def _login(self, user, username=None):
        username = username or user.username
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        response = self.client.post(
            "/api/auth/login/",
            data={
                "username": username,
                "password": "TestPass1!",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)
        self._csrf = csrf_token

    def _get(self):
        return self.client.get(URL)

    def _patch(self, payload):
        return self.client.patch(
            URL,
            data=payload,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=self._csrf,
        )

    def _row(self, user):
        return MyWorkPreferences.objects.filter(user=user).first()

    def _row_groups(self, user):
        return set(
            MyWorkPreferences.objects.filter(user=user)
            .values_list("research_groups__pk", flat=True)
        )

    def _row_projects(self, user):
        return set(
            MyWorkPreferences.objects.filter(user=user)
            .values_list("projects__pk", flat=True)
        )

    def _assert_snapshot(self, response, view_mode, groups, projects, types):
        body = response.json()
        self.assertEqual(body["viewMode"], view_mode)
        self.assertEqual(set(body["researchGroupIds"]), set(groups))
        self.assertEqual(set(body["projectIds"]), set(projects))
        self.assertEqual(set(body["workItemTypes"]), set(types))

    # ── authentication ─────────────────────────────────────────

    def test_anonymous_get_rejected(self):
        response = self.client.get(URL)
        self.assertEqual(response.status_code, 401)

    def test_anonymous_patch_rejected(self):
        response = self.client.patch(
            URL,
            data={"viewMode": "list"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)

    # ── defaults ───────────────────────────────────────────────

    def test_first_get_returns_default_snapshot(self):
        self._login(self.alice)
        response = self._get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), default_my_work_snapshot())
        self.assertEqual(
            response.json(),
            {
                "viewMode": "board",
                "researchGroupIds": [],
                "projectIds": [],
                "workItemTypes": [],
            },
        )
        # A clean read does not create a preference row.
        self.assertIsNone(self._row(self.alice))

    # ── round trip + view mode ─────────────────────────────────

    def test_patch_then_get_round_trip(self):
        self._login(self.alice)
        payload = {
            "viewMode": "list",
            "researchGroupIds": [self.group_a.pk],
            "projectIds": [self.pa1.pk],
            "workItemTypes": ["task", "epic"],
        }
        response = self._patch(payload)
        self.assertEqual(response.status_code, 200)
        self._assert_snapshot(
            response, "list", [self.group_a.pk], [self.pa1.pk],
            ["task", "epic"],
        )
        response = self._get()
        self.assertEqual(response.status_code, 200)
        self._assert_snapshot(
            response, "list", [self.group_a.pk], [self.pa1.pk],
            ["task", "epic"],
        )

    def test_view_mode_persists_board_and_list(self):
        self._login(self.alice)
        response = self._patch({"viewMode": "list"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["viewMode"], "list")
        self.assertEqual(self._get().json()["viewMode"], "list")

        response = self._patch({"viewMode": "board"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["viewMode"], "board")
        self.assertEqual(self._get().json()["viewMode"], "board")

    def test_all_four_semantic_type_kinds_persist(self):
        self._login(self.alice)
        kinds = ["task", "epic", "milestone", "deliverable"]
        response = self._patch({"workItemTypes": kinds})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            sorted(response.json()["workItemTypes"]),
            sorted(kinds),
        )
        self.assertEqual(
            sorted(self._get().json()["workItemTypes"]),
            sorted(kinds),
        )

    # ── semantic kind validation ───────────────────────────────

    def test_invalid_semantic_type_values_are_not_persisted(self):
        self._login(self.alice)
        response = self._patch(
            {"workItemTypes": ["task", "banana", "Epic", "TASK", "epic"]}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["workItemTypes"], ["task", "epic"])
        self.assertEqual(
            self._get().json()["workItemTypes"], ["task", "epic"]
        )
        self.assertEqual(
            self._row(self.alice).work_item_types, ["task", "epic"]
        )

    def test_display_names_are_never_semantic_kinds(self):
        # Custom types whose display names LOOK like canonical kinds
        # (or like arbitrary lowercase names) carry kind=NULL and
        # must never be treated as semantic type filter values.
        task_default = self.pa1.type_definitions.get(name="Task")
        self.assertEqual(task_default.kind, "task")
        # Free the canonical name (the default keeps its kind)...
        update_type_definition(task_default, self.alice, name="To-do")
        # ...so a custom type can wear a canonical-looking name.
        impostor = create_type_definition(self.pa1, self.alice, "Task")
        self.assertIsNone(impostor.kind)
        experiment = create_type_definition(self.pa1, self.alice, "experiment")
        self.assertIsNone(experiment.kind)

        self._login(self.alice)
        # "Task" is a display name (not a kind value); "experiment"
        # matches a custom type name but is not a canonical kind.
        # Only the genuine kind value "task" survives.
        response = self._patch(
            {"workItemTypes": ["Task", "experiment", "task"]}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["workItemTypes"], ["task"])
        self.assertEqual(self._get().json()["workItemTypes"], ["task"])

    # ── user isolation ─────────────────────────────────────────

    def test_two_users_have_independent_preferences(self):
        self._login(self.alice)
        self._patch(
            {
                "viewMode": "list",
                "researchGroupIds": [self.group_a.pk],
                "projectIds": [self.pa1.pk],
                "workItemTypes": ["task"],
            }
        )

        self._login(self.bob)
        body = self._get().json()
        self.assertEqual(body["viewMode"], "board")
        self.assertEqual(body["researchGroupIds"], [])
        self.assertEqual(body["projectIds"], [])
        self.assertEqual(body["workItemTypes"], [])

        # Bob's own save must not disturb Alice's state.
        self._patch(
            {
                "viewMode": "board",
                "researchGroupIds": [self.group_a.pk],
                "projectIds": [self.pa2.pk],
                "workItemTypes": ["epic"],
            }
        )
        self._login(self.alice)
        body = self._get().json()
        self.assertEqual(body["viewMode"], "list")
        self.assertEqual(body["researchGroupIds"], [self.group_a.pk])
        self.assertEqual(body["projectIds"], [self.pa1.pk])
        self.assertEqual(body["workItemTypes"], ["task"])

    # ── access-constrained selection ───────────────────────────

    def test_accessible_research_group_selection_persists(self):
        self._login(self.alice)
        response = self._patch(
            {"researchGroupIds": [self.group_a.pk, self.group_b.pk]}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            set(response.json()["researchGroupIds"]),
            {self.group_a.pk, self.group_b.pk},
        )
        self.assertEqual(
            set(self._get().json()["researchGroupIds"]),
            {self.group_a.pk, self.group_b.pk},
        )
        self.assertEqual(
            self._row_groups(self.alice),
            {self.group_a.pk, self.group_b.pk},
        )

    def test_accessible_project_selection_persists(self):
        self._login(self.alice)
        response = self._patch(
            {"projectIds": [self.pa1.pk, self.pb1.pk]}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            set(response.json()["projectIds"]),
            {self.pa1.pk, self.pb1.pk},
        )
        self.assertEqual(
            self._row_projects(self.alice),
            {self.pa1.pk, self.pb1.pk},
        )

    def test_inaccessible_research_group_not_persisted_or_returned(self):
        self._login(self.alice)
        response = self._patch(
            {"researchGroupIds": [self.group_c.pk, self.group_a.pk]}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["researchGroupIds"], [self.group_a.pk])
        self.assertEqual(self._get().json()["researchGroupIds"], [self.group_a.pk])
        self.assertEqual(self._row_groups(self.alice), {self.group_a.pk})

    def test_inaccessible_project_not_persisted_or_returned(self):
        # pa2: alice has Research Group membership in group_a but NO
        # ProjectMembership in pa2 → group membership alone never
        # suffices.
        self._login(self.alice)
        response = self._patch(
            {"projectIds": [self.pa2.pk, self.pa1.pk]}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["projectIds"], [self.pa1.pk])
        self.assertEqual(self._get().json()["projectIds"], [self.pa1.pk])
        self.assertEqual(self._row_projects(self.alice), {self.pa1.pk})

    def test_inaccessible_project_in_inaccessible_group_dropped(self):
        # An unknown/foreign project ID never leaks, even combined
        # with an inaccessible group.
        self._login(self.alice)
        response = self._patch(
            {
                "researchGroupIds": [self.group_c.pk],
                "projectIds": [self.pa2.pk],
            }
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["researchGroupIds"], [])
        self.assertEqual(response.json()["projectIds"], [])

    # ── Research Group → Project dependency ────────────────────

    def test_project_incompatible_with_selected_groups_removed(self):
        self._login(self.alice)
        response = self._patch(
            {
                "researchGroupIds": [self.group_a.pk],
                "projectIds": [self.pa1.pk, self.pb1.pk],
            }
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["researchGroupIds"], [self.group_a.pk])
        # pb1 belongs to group_b and must not survive normalization.
        self.assertEqual(response.json()["projectIds"], [self.pa1.pk])
        self.assertEqual(self._get().json()["projectIds"], [self.pa1.pk])

    def test_empty_group_selection_permits_any_accessible_project(self):
        self._login(self.alice)
        response = self._patch(
            {
                "researchGroupIds": [],
                "projectIds": [self.pa1.pk, self.pb1.pk],
            }
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["researchGroupIds"], [])
        self.assertEqual(
            set(response.json()["projectIds"]),
            {self.pa1.pk, self.pb1.pk},
        )

    # ── stale access handling ──────────────────────────────────

    def test_stale_research_group_removed_after_membership_loss(self):
        self._login(self.alice)
        self._patch(
            {
                "researchGroupIds": [self.group_a.pk, self.group_b.pk],
                "projectIds": [self.pa1.pk, self.pb1.pk],
            }
        )

        # Alice loses group_b: her pb1 ProjectMembership must go
        # first (composite-FK RESTRICT), then the group membership —
        # the same order the offboarding workflow uses.
        ProjectMembership.objects.filter(
            project=self.pb1, user=self.alice,
        ).delete()
        ResearchGroupMembership.objects.filter(
            research_group=self.group_b, user=self.alice,
        ).delete()

        response = self._get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["researchGroupIds"], [self.group_a.pk])
        # pb1 disappears with its group; pa1 survives.
        self.assertEqual(response.json()["projectIds"], [self.pa1.pk])

    def test_stale_project_removed_after_access_loss(self):
        self._login(self.alice)
        self._patch(
            {
                "researchGroupIds": [],
                "projectIds": [self.pa1.pk, self.pb1.pk],
            }
        )

        # Alice loses Project access in pb1 (keeps group_b).
        ProjectMembership.objects.filter(
            project=self.pb1, user=self.alice,
        ).delete()

        response = self._get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["researchGroupIds"], [])
        self.assertEqual(response.json()["projectIds"], [self.pa1.pk])

    def test_sanitization_persists_cleaned_state(self):
        self._login(self.alice)
        self._patch(
            {
                "researchGroupIds": [self.group_b.pk],
                "projectIds": [self.pb1.pk],
            }
        )

        ProjectMembership.objects.filter(
            project=self.pb1, user=self.alice,
        ).delete()
        ResearchGroupMembership.objects.filter(
            research_group=self.group_b, user=self.alice,
        ).delete()

        # The first GET triggers sanitization...
        response = self._get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["researchGroupIds"], [])
        self.assertEqual(response.json()["projectIds"], [])

        # ...and the cleaned state must BE the persisted state, not a
        # temporary projection: the DB row itself is cleaned.
        row = self._row(self.alice)
        self.assertIsNotNone(row)
        self.assertEqual(set(row.research_groups.all().values_list("pk", flat=True)), set())
        self.assertEqual(set(row.projects.all().values_list("pk", flat=True)), set())
        self.assertEqual(row.work_item_types, [])
        self.assertEqual(row.view_mode, "board")

        # A second GET returns the same cleaned state from the DB.
        response = self._get()
        self.assertEqual(response.json()["researchGroupIds"], [])
        self.assertEqual(response.json()["projectIds"], [])

    # ── preferences are never authorization ────────────────────

    def test_preferences_never_grant_access_to_my_work(self):
        # dave has NO memberships. Give him a preference row pointing
        # at alice's group/project and a work item assigned to him in
        # that project: none of it may surface in /api/me/work-items/.
        prefs, _ = MyWorkPreferences.objects.get_or_create(
            user=self.dave,
            defaults={"view_mode": "board"},
        )
        prefs.research_groups.add(self.group_a)
        prefs.projects.add(self.pa1)
        prefs.work_item_types = ["task"]
        prefs.save()
        WorkItemAssignee.objects.create(
            work_item=self.work_a, user=self.dave,
        )

        self._login(self.dave)
        response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_preferences_do_not_grant_project_read_access(self):
        self._login(self.alice)
        # Attempting to select pa2 (no membership) is sanitized...
        response = self._patch({"projectIds": [self.pa2.pk]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["projectIds"], [])
        # ...and pa2 remains unreadable exactly as before.
        response = self.client.get(f"/api/projects/{self.pa2.pk}/")
        self.assertEqual(response.status_code, 404)

    def test_own_access_survives_sanitization(self):
        # Saving a preference must never revoke the user's REAL
        # access: alice still sees her assigned work item.
        self._login(self.alice)
        self._patch(
            {
                "researchGroupIds": [self.group_a.pk],
                "projectIds": [self.pa1.pk],
                "workItemTypes": ["task"],
            }
        )
        response = self.client.get("/api/me/work-items/")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["id"], self.work_a.pk)

    # ── fail-closed structural validation ──────────────────────

    def test_invalid_view_mode_rejected(self):
        self._login(self.alice)
        response = self._patch({"viewMode": "kanban"})
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(self._row(self.alice))

        response = self._patch({"viewMode": 5})
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(self._row(self.alice))

    def test_invalid_payload_structure_rejected(self):
        self._login(self.alice)
        for payload in (
            {"researchGroupIds": "group_a"},
            {"researchGroupIds": [self.group_a.pk, "x"]},
            {"projectIds": [str(self.pa1.pk)]},
            {"projectIds": [True]},
            {"workItemTypes": 5},
            {"workItemTypes": ["task", 1]},
        ):
            with self.subTest(payload=payload):
                response = self._patch(payload)
                self.assertEqual(response.status_code, 400)
        self.assertIsNone(self._row(self.alice))

    def test_patch_missing_fields_default_to_empty(self):
        # The contract is a COMPLETE snapshot: missing categories
        # fail closed to their defaults (no implicit "no change").
        self._login(self.alice)
        self._patch(
            {
                "viewMode": "list",
                "researchGroupIds": [self.group_a.pk],
                "projectIds": [self.pa1.pk],
                "workItemTypes": ["task"],
            }
        )
        response = self._patch({"viewMode": "list"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "viewMode": "list",
                "researchGroupIds": [],
                "projectIds": [],
                "workItemTypes": [],
            },
        )

    def test_duplicate_ids_deduplicated(self):
        self._login(self.alice)
        response = self._patch(
            {
                "researchGroupIds": [
                    self.group_a.pk, self.group_a.pk, self.group_b.pk,
                ],
                "projectIds": [self.pa1.pk, self.pa1.pk, self.pb1.pk],
                "workItemTypes": ["task", "task"],
            }
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            sorted(response.json()["researchGroupIds"]),
            sorted([self.group_a.pk, self.group_b.pk]),
        )
        self.assertEqual(
            sorted(response.json()["projectIds"]),
            sorted([self.pa1.pk, self.pb1.pk]),
        )
        self.assertEqual(response.json()["workItemTypes"], ["task"])

    # ── query budget (no per-ID lookup pattern) ────────────────

    def test_get_query_count_is_bounded(self):
        self._login(self.alice)
        self._patch(
            {
                "viewMode": "board",
                "researchGroupIds": [self.group_a.pk, self.group_b.pk],
                "projectIds": [self.pa1.pk, self.pb1.pk],
                "workItemTypes": ["task", "epic", "milestone", "deliverable"],
            }
        )
        with CaptureQueriesContext(connection) as ctx:
            response = self._get()
        self.assertEqual(response.status_code, 200)
        # A per-ID lookup over the stored selections (2 groups +
        # 2 projects) would add at least 4 extra queries on top of
        # the constant boundary queries.
        self.assertLessEqual(len(ctx.captured_queries), 12)
