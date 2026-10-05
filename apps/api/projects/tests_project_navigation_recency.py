"""Personal Project navigation recency (Project Quick Access) tests.

Domain behavior (canonical service operations) + API contract:

- ``record_project_open``: the V1 personal relevance signal
  (explicit Project open/navigation); server-owned timestamp;
  current canonical Project read access required; one row per
  ProjectMembership, updated on repeated opens.
- ``get_personal_project_quick_access``: bounded (5) personal
  read model per Research Group; opened newest-first, then
  never-opened by created_at DESC / PK DESC; never-opened after
  opened; archived and inaccessible Projects excluded; recency
  never grants access, other users' activity never affects the
  order.
- ``get_global_personal_project_quick_access``: bounded (5)
  personal read model across ALL accessible Research Groups
  (GLOBAL ordering — Research Group membership/order never
  partitions or influences the ranking); identical access / archive
  / recency rules; pure read (never mutates recency, Projects,
  preferences, or Activity).
- Membership lifecycle: removing a ProjectMembership deletes its
  recency row; a later-recreated membership starts without
  historical recency.
- Existing Project APIs stay unchanged: ordinary Project GET
  never creates/updates recency; the Research Group Project list
  contract is untouched by recency.
"""

from datetime import datetime, timedelta, timezone as dt_timezone

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from audit_history.models import AuditEvent
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
    WorkspaceNavigationPreferences,
)
from projects.models import (
    Project,
    ProjectMembership,
    ProjectNavigationRecency,
)
from projects.services import (
    ProjectDomainError,
    add_project_membership,
    archive_project,
    create_project,
    get_personal_project_quick_access,
    record_project_open,
    remove_membership,
)

User = get_user_model()
SEED_PASSWORD = "DevPass1!"

# Deterministic test-time anchors (aware UTC).
BASE = datetime(2026, 9, 1, tzinfo=dt_timezone.utc)


def _make_user(username):
    return User.objects.create_user(username=username, password=SEED_PASSWORD)


def _make_group(name, admin):
    group = ResearchGroup.objects.create(name=name, created_by=admin)
    ResearchGroupMembership.objects.create(
        research_group=group,
        user=admin,
        role=ResearchGroupMembership.Role.ADMIN,
    )
    return group


def _join(group, user, role=ResearchGroupMembership.Role.MEMBER):
    ResearchGroupMembership.objects.create(
        research_group=group, user=user, role=role,
    )


def _set_created_at(project, dt):
    Project.objects.filter(pk=project.pk).update(created_at=dt)


def _set_opened(user, project, dt):
    """Deterministically set a user's personal recency for a Project."""
    membership = ProjectMembership.objects.get(project=project, user=user)
    ProjectNavigationRecency.objects.update_or_create(
        project_membership=membership,
        defaults={"last_opened_at": dt},
    )


# ── Domain: record_project_open ──────────────────────────────────


class RecordProjectOpenDomainTest(TestCase):
    """Service-level behavior of the explicit personal open."""

    def setUp(self):
        super().setUp()
        self.alex = _make_user("alex")
        self.chris = _make_user("chris")
        self.maria = _make_user("maria")
        self.group = _make_group("QA Group", self.alex)
        _join(self.group, self.chris)
        _join(self.group, self.maria)
        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Alpha",
        )
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        self.alex_membership = ProjectMembership.objects.get(
            project=self.project, user=self.alex,
        )

    def test_first_open_creates_exactly_one_personal_recency_row(self):
        self.assertEqual(ProjectNavigationRecency.objects.count(), 0)

        recency = record_project_open(
            actor=self.alex, project=self.project,
        )

        self.assertEqual(ProjectNavigationRecency.objects.count(), 1)
        row = ProjectNavigationRecency.objects.get()
        self.assertEqual(row.project_membership, self.alex_membership)
        self.assertEqual(row.project_membership.user, self.alex)
        self.assertIsNotNone(row.last_opened_at)
        self.assertIsNotNone(recency.last_opened_at)

    def test_second_open_updates_the_same_row(self):
        first = record_project_open(actor=self.alex, project=self.project)
        stale = BASE  # far in the past
        ProjectNavigationRecency.objects.filter(
            pk=first.pk,
        ).update(last_opened_at=stale)

        second = record_project_open(actor=self.alex, project=self.project)

        self.assertEqual(ProjectNavigationRecency.objects.count(), 1)
        self.assertEqual(second.pk, first.pk)
        self.assertGreater(second.last_opened_at, stale)

    def test_open_does_not_mutate_project_membership_or_preferences(self):
        self.project.refresh_from_db()
        self.alex_membership.refresh_from_db()
        project_updated_at = self.project.updated_at
        role = self.alex_membership.role
        added_at = self.alex_membership.added_at
        added_by = self.alex_membership.added_by_id
        self.assertEqual(
            WorkspaceNavigationPreferences.objects.filter(
                user=self.alex,
            ).count(),
            0,
        )

        record_project_open(actor=self.alex, project=self.project)

        self.project.refresh_from_db()
        self.alex_membership.refresh_from_db()
        self.assertEqual(self.project.updated_at, project_updated_at)
        self.assertEqual(self.alex_membership.role, role)
        self.assertEqual(self.alex_membership.added_at, added_at)
        self.assertEqual(self.alex_membership.added_by_id, added_by)
        self.assertEqual(
            WorkspaceNavigationPreferences.objects.filter(
                user=self.alex,
            ).count(),
            0,
        )

    def test_open_records_no_activity_event(self):
        before = AuditEvent.objects.count()

        record_project_open(actor=self.alex, project=self.project)

        self.assertEqual(AuditEvent.objects.count(), before)

    def test_open_without_project_membership_persists_nothing(self):
        # Maria is in the Research Group but has no ProjectMembership.
        with self.assertRaises(ProjectDomainError):
            record_project_open(actor=self.maria, project=self.project)

        self.assertEqual(ProjectNavigationRecency.objects.count(), 0)
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.project, user=self.maria,
            ).exists()
        )

    def test_open_with_unknown_project_persists_nothing(self):
        with self.assertRaises(ProjectDomainError):
            record_project_open(
                actor=self.alex, project=Project(pk=999_999),
            )

        self.assertEqual(ProjectNavigationRecency.objects.count(), 0)

    def test_membership_removal_deletes_the_personal_recency_row(self):
        record_project_open(actor=self.chris, project=self.project)
        self.assertTrue(
            ProjectNavigationRecency.objects.filter(
                project_membership__user=self.chris,
            ).exists()
        )

        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=self.chris,
        )
        remove_membership(membership=chris_membership, actor=self.alex)

        self.assertFalse(
            ProjectNavigationRecency.objects.filter(
                project_membership__user=self.chris,
            ).exists()
        )

    def test_readded_membership_starts_without_historical_recency(self):
        first = record_project_open(actor=self.chris, project=self.project)

        chris_membership = ProjectMembership.objects.get(
            project=self.project, user=self.chris,
        )
        remove_membership(membership=chris_membership, actor=self.alex)
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )

        # No resurrected row for the new membership.
        self.assertFalse(
            ProjectNavigationRecency.objects.filter(
                project_membership__user=self.chris,
            ).exists()
        )
        # The Quick Access read model shows the Project as never opened.
        candidates = get_personal_project_quick_access(
            actor=self.chris, research_group=self.group,
        )
        entry = next(
            c for c in candidates if c["id"] == self.project.pk
        )
        self.assertIsNone(entry["lastOpenedAt"])

        # The next open starts a fresh personal recency.
        second = record_project_open(actor=self.chris, project=self.project)
        self.assertEqual(
            ProjectNavigationRecency.objects.filter(
                project_membership__user=self.chris,
            ).count(),
            1,
        )
        self.assertGreater(second.last_opened_at, first.last_opened_at)


# ── API: POST /api/me/projects/{id}/open/ ─────────────────────────


class PersonalProjectOpenApiTest(APITestCase):
    """Endpoint contract of the explicit personal open."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.alex = _make_user("alex")
        self.chris = _make_user("chris")
        self.maria = _make_user("maria")
        self.group = _make_group("QA Group", self.alex)
        _join(self.group, self.chris)
        _join(self.group, self.maria)
        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Alpha",
        )
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )

    def _login(self, user):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        self.client.post(
            "/api/auth/login/",
            data={
                "username": user.username,
                "password": SEED_PASSWORD,
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

    def _open(self, project_id, payload=None):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        return self.client.post(
            f"/api/me/projects/{project_id}/open/",
            data=payload,
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

    def test_anonymous_open_is_rejected(self):
        response = self.client.post(
            f"/api/me/projects/{self.project.pk}/open/",
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(ProjectNavigationRecency.objects.count(), 0)

    def test_open_accessible_project_returns_minimal_representation(self):
        self._login(self.alex)

        response = self._open(self.project.pk)

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(
            set(data.keys()), {"projectId", "lastOpenedAt"},
        )
        self.assertEqual(data["projectId"], self.project.pk)
        self.assertIsInstance(data["lastOpenedAt"], str)

    def test_client_supplied_timestamp_is_ignored(self):
        self._login(self.alex)

        response = self._open(
            self.project.pk,
            payload={"lastOpenedAt": "2020-01-01T00:00:00+00:00"},
        )

        self.assertEqual(response.status_code, 200)
        row = ProjectNavigationRecency.objects.get()
        # The server owns the timestamp: it is "now", not 2020.
        now = timezone.now()
        self.assertLess(now - row.last_opened_at, timedelta(seconds=10))
        self.assertNotEqual(
            row.last_opened_at.year, 2020,
        )

    def test_open_without_project_membership_is_404_and_persists_nothing(self):
        self._login(self.maria)

        response = self._open(self.project.pk)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(ProjectNavigationRecency.objects.count(), 0)

    def test_open_project_of_another_group_is_404(self):
        bob = _make_user("bob")
        other_group = _make_group("Other Group", bob)
        other_project = create_project(
            research_group=other_group,
            creator=bob,
            name="Foreign",
        )
        self._login(self.alex)

        response = self._open(other_project.pk)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(ProjectNavigationRecency.objects.count(), 0)

    def test_open_unknown_project_id_is_404(self):
        self._login(self.alex)

        response = self._open(999_999)

        self.assertEqual(response.status_code, 404)

    def test_ordinary_project_get_does_not_create_recency(self):
        self._login(self.alex)

        detail = self.client.get(f"/api/projects/{self.project.pk}/")
        group_list = self.client.get(
            f"/api/research-groups/{self.group.pk}/projects/",
        )

        self.assertEqual(detail.status_code, 200)
        self.assertEqual(group_list.status_code, 200)
        self.assertEqual(ProjectNavigationRecency.objects.count(), 0)

    def test_open_without_csrf_token_is_rejected(self):
        # Real-enforcement CSRF contract (DRF SessionAuthentication),
        # same convention as the personal-notes mutations.
        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.force_login(self.alex)

        response = csrf_client.post(
            f"/api/me/projects/{self.project.pk}/open/",
            data={},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(ProjectNavigationRecency.objects.count(), 0)

        csrf_client.get("/api/auth/csrf/")
        token = csrf_client.cookies["csrftoken"].value
        response = csrf_client.post(
            f"/api/me/projects/{self.project.pk}/open/",
            data={},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(ProjectNavigationRecency.objects.count(), 1)


# ── API: GET /api/research-groups/{id}/project-quick-access/ ──────


class ProjectQuickAccessApiTest(APITestCase):
    """The personal Quick Access read model contract."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.alice = _make_user("alice")
        self.bob = _make_user("bob")
        self.dave = _make_user("dave")
        self.group = _make_group("QA Group", self.alice)
        _join(self.group, self.bob)
        _join(self.group, self.dave)

        # Seven Projects owned by alice; bob is a member of all of
        # them, dave has none. created_at is controlled explicitly
        # (P1 oldest … P7 newest).
        self.projects = []
        for idx in range(1, 8):
            project = create_project(
                research_group=self.group,
                creator=self.alice,
                name=f"Project {idx}",
            )
            add_project_membership(
                project=project,
                actor=self.alice,
                target_user=self.bob,
                role=ProjectMembership.Role.MEMBER,
            )
            _set_created_at(project, BASE + timedelta(hours=idx))
            self.projects.append(project)
        (
            self.p1, self.p2, self.p3,
            self.p4, self.p5, self.p6, self.p7,
        ) = self.projects

    def _login(self, user):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        self.client.post(
            "/api/auth/login/",
            data={
                "username": user.username,
                "password": SEED_PASSWORD,
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

    def _quick_access(self):
        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/project-quick-access/",
        )
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _names(self, data):
        return [item["name"] for item in data]

    def test_anonymous_is_rejected(self):
        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/project-quick-access/",
        )
        self.assertEqual(response.status_code, 401)

    def test_inaccessible_group_returns_empty_list(self):
        # Dave is in the group but reads no Project.
        self._login(self.dave)
        self.assertEqual(self._quick_access(), [])

        # A user outside the group entirely.
        erin = _make_user("erin")
        self._login(erin)
        self.assertEqual(self._quick_access(), [])

    def test_returns_only_projects_the_caller_can_currently_read(self):
        # P8 is readable by alice but NOT by bob, with the newest
        # created_at: a broken access filter would surface it first —
        # the bound cannot hide that.
        foreign_to_bob = create_project(
            research_group=self.group,
            creator=self.alice,
            name="Project 8",
        )
        _set_created_at(
            foreign_to_bob, BASE + timedelta(days=200),
        )

        self._login(self.bob)
        data = self._quick_access()

        # All seven are readable by bob, but the result is bounded to
        # five: the never-opened fallback (created_at DESC) returns
        # P7 … P3.
        self.assertEqual(
            [item["id"] for item in data],
            [
                self.p7.pk, self.p6.pk, self.p5.pk,
                self.p4.pk, self.p3.pk,
            ],
        )
        self.assertNotIn(foreign_to_bob.pk, [item["id"] for item in data])

        # For alice, the same Project IS readable and — as the newest
        # never-opened candidate — leads her list.
        self._login(self.alice)
        alice_data = self._quick_access()
        self.assertEqual(alice_data[0]["id"], foreign_to_bob.pk)
        # Every row carries the caller's own recency (None: never
        # opened yet) and the group scope — nothing else leaks.
        for item in data:
            self.assertEqual(
                set(item.keys()),
                {"id", "researchGroupId", "name", "lastOpenedAt"},
            )
            self.assertEqual(item["researchGroupId"], self.group.pk)
            self.assertIsNone(item["lastOpenedAt"])

    def test_never_returns_projects_of_another_group(self):
        bob = self.bob
        other_group = _make_group("Other Group", bob)
        other_project = create_project(
            research_group=other_group,
            creator=bob,
            name="Foreign Project",
        )
        # Newer created_at than every in-group Project: if the group
        # scoping were broken it would land inside the five-candidate
        # window — the bound cannot hide a broken filter here.
        _set_created_at(other_project, BASE + timedelta(days=100))
        self._login(self.bob)
        data = self._quick_access()

        self.assertNotIn(other_project.pk, [item["id"] for item in data])

    def test_archived_projects_are_excluded(self):
        _set_opened(self.bob, self.p7, BASE + timedelta(days=9))
        archive_project(project=self.p7, actor=self.alice)

        self._login(self.bob)
        data = self._quick_access()

        self.assertNotIn(self.p7.name, self._names(data))
        self.assertEqual(len(data), 5)
        # P7 (newest created_at) is absent, so the bounded result is
        # the next five by the never-opened fallback.
        self.assertEqual(
            self._names(data),
            ["Project 6", "Project 5", "Project 4", "Project 3",
             "Project 2"],
        )

    def test_opened_projects_sort_newest_first(self):
        _set_opened(self.bob, self.p1, BASE + timedelta(days=1))
        _set_opened(self.bob, self.p2, BASE + timedelta(days=3))
        _set_opened(self.bob, self.p3, BASE + timedelta(days=2))

        self._login(self.bob)
        self.assertEqual(
            self._names(self._quick_access())[:3],
            ["Project 2", "Project 3", "Project 1"],
        )

    def test_never_opened_sort_after_opened_with_fallback(self):
        _set_opened(self.bob, self.p1, BASE + timedelta(days=1))

        self._login(self.bob)
        self.assertEqual(
            self._names(self._quick_access()),
            [
                # opened first (newest personal open),
                "Project 1",
                # never-opened after: created_at DESC (P7 … P4),
                # bounded to five candidates
                "Project 7", "Project 6", "Project 5",
                "Project 4",
            ],
        )

    def test_never_opened_equal_created_at_tie_breaks_by_pk_desc(self):
        for project in (self.p5, self.p6, self.p7):
            _set_created_at(project, BASE + timedelta(days=30))

        self._login(self.bob)
        self.assertEqual(
            self._names(self._quick_access()),
            # P5/P6/P7 share the newest created_at: PK DESC breaks
            # the tie; then P4/P3 by created_at DESC (bounded to 5).
            ["Project 7", "Project 6", "Project 5", "Project 4",
             "Project 3"],
        )

    def test_equal_recency_timestamps_resolve_by_pk_desc(self):
        # Same personal timestamp on P1 and P2; P2 has the higher
        # primary key AND the older created_at — PK DESC must win.
        _set_created_at(self.p1, BASE + timedelta(days=40))
        same_ts = BASE + timedelta(days=5)
        _set_opened(self.bob, self.p1, same_ts)
        _set_opened(self.bob, self.p2, same_ts)

        self._login(self.bob)
        self.assertEqual(
            self._names(self._quick_access())[:2],
            ["Project 2", "Project 1"],
        )

    def test_result_is_bounded_to_five_candidates(self):
        _set_opened(self.bob, self.p1, BASE + timedelta(days=1))

        self._login(self.bob)
        data = self._quick_access()

        self.assertEqual(len(data), 5)
        self.assertEqual(
            self._names(data),
            ["Project 1", "Project 7", "Project 6", "Project 5",
             "Project 4"],
        )

    def test_other_users_activity_never_affects_personal_order(self):
        # P3 is inside BOTH users' five-candidate window (it is the
        # last never-opened candidate by created_at DESC), so the
        # comparison is meaningful for each personal list.
        alice_ts = BASE + timedelta(days=10)
        _set_opened(self.alice, self.p3, alice_ts)

        self._login(self.bob)
        bob_data = self._quick_access()
        bob_p3 = next(
            item for item in bob_data if item["id"] == self.p3.pk
        )
        # Bob never opened P3: his recency for it is null, and his
        # order is his own (P3 stays on the never-opened fallback).
        self.assertIsNone(bob_p3["lastOpenedAt"])
        self.assertEqual(
            self._names(bob_data),
            ["Project 7", "Project 6", "Project 5", "Project 4",
             "Project 3"],
        )

        self._login(self.alice)
        alice_data = self._quick_access()
        alice_p3 = next(
            item for item in alice_data if item["id"] == self.p3.pk
        )
        # Alice's own open leads her list.
        self.assertEqual(alice_p3["lastOpenedAt"], alice_ts.isoformat())
        self.assertEqual(self._names(alice_data)[0], "Project 3")
        self.assertEqual(
            self._names(alice_data),
            ["Project 3", "Project 7", "Project 6", "Project 5",
             "Project 4"],
        )

    def test_rg_project_list_contract_is_unchanged_by_recency(self):
        self._login(self.bob)
        before = self.client.get(
            f"/api/research-groups/{self.group.pk}/projects/",
        ).json()

        _set_opened(self.bob, self.p1, BASE + timedelta(days=1))
        _set_opened(self.bob, self.p2, BASE + timedelta(days=2))

        after = self.client.get(
            f"/api/research-groups/{self.group.pk}/projects/",
        ).json()

        self.assertEqual(after, before)
        for item in after:
            self.assertNotIn("lastOpenedAt", item)


# ── API: GET /api/me/project-quick-access/ (GLOBAL read model) ─────


class GlobalProjectQuickAccessApiTest(APITestCase):
    """The GLOBAL personal Quick Access read model contract.

    Two Research Groups, three Projects each; alice, bob, and dave
    hold current ProjectMembership on ALL six Projects (alice owns
    the Alpha Projects, bob owns the Beta Projects). created_at is
    controlled explicitly: Alpha 1 < Alpha 2 < Alpha 3 < Beta 1 <
    Beta 2 < Beta 3 (hours 1..6 after BASE).
    """

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.alice = _make_user("alice")
        self.bob = _make_user("bob")
        self.dave = _make_user("dave")

        self.group_a = _make_group("Alpha Group", self.alice)
        self.group_b = _make_group("Beta Group", self.bob)
        _join(self.group_a, self.bob)
        _join(self.group_b, self.alice)
        _join(self.group_a, self.dave)
        _join(self.group_b, self.dave)

        (
            self.pa1, self.pa2, self.pa3,
        ) = [
            create_project(
                research_group=self.group_a,
                creator=self.alice,
                name=f"Alpha {idx}",
            )
            for idx in (1, 2, 3)
        ]
        (
            self.pb1, self.pb2, self.pb3,
        ) = [
            create_project(
                research_group=self.group_b,
                creator=self.bob,
                name=f"Beta {idx}",
            )
            for idx in (1, 2, 3)
        ]
        for project in (self.pa1, self.pa2, self.pa3):
            add_project_membership(
                project=project,
                actor=self.alice,
                target_user=self.bob,
                role=ProjectMembership.Role.MEMBER,
            )
            add_project_membership(
                project=project,
                actor=self.alice,
                target_user=self.dave,
                role=ProjectMembership.Role.MEMBER,
            )
        for project in (self.pb1, self.pb2, self.pb3):
            add_project_membership(
                project=project,
                actor=self.bob,
                target_user=self.alice,
                role=ProjectMembership.Role.MEMBER,
            )
            add_project_membership(
                project=project,
                actor=self.bob,
                target_user=self.dave,
                role=ProjectMembership.Role.MEMBER,
            )
        _set_created_at(self.pa1, BASE + timedelta(hours=1))
        _set_created_at(self.pa2, BASE + timedelta(hours=2))
        _set_created_at(self.pa3, BASE + timedelta(hours=3))
        _set_created_at(self.pb1, BASE + timedelta(hours=4))
        _set_created_at(self.pb2, BASE + timedelta(hours=5))
        _set_created_at(self.pb3, BASE + timedelta(hours=6))

        self.all_projects = (
            self.pa1, self.pa2, self.pa3,
            self.pb1, self.pb2, self.pb3,
        )

    def _login(self, user):
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        self.client.post(
            "/api/auth/login/",
            data={
                "username": user.username,
                "password": SEED_PASSWORD,
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

    def _global_quick_access(self):
        response = self.client.get("/api/me/project-quick-access/")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _names(self, data):
        return [item["name"] for item in data]

    def test_anonymous_is_rejected(self):
        response = self.client.get("/api/me/project-quick-access/")
        self.assertEqual(response.status_code, 401)

    def test_cross_group_personal_recency_ordering(self):
        # Alice opened Projects in BOTH groups; the global list must
        # interleave them by her personal recency — group identity
        # must not partition the ranking.
        _set_opened(self.alice, self.pa1, BASE + timedelta(days=1))
        _set_opened(self.alice, self.pa3, BASE + timedelta(days=2))
        _set_opened(self.alice, self.pb2, BASE + timedelta(days=3))

        self._login(self.alice)
        data = self._global_quick_access()

        self.assertEqual(
            self._names(data),
            [
                # personally opened, newest personal open first —
                # across Research Groups:
                "Beta 2", "Alpha 3", "Alpha 1",
                # never-opened fallback (created_at DESC):
                "Beta 3", "Beta 1",
            ],
        )
        # The leading row belongs to the OTHER Research Group's
        # Project — a per-group partition would never surface it.
        self.assertEqual(data[0]["id"], self.pb2.pk)
        self.assertEqual(data[0]["researchGroupId"], self.group_b.pk)
        self.assertEqual(
            data[0]["lastOpenedAt"],
            (BASE + timedelta(days=3)).isoformat(),
        )

    def test_opened_projects_precede_never_opened_globally(self):
        # One opened Project in group A must lead over every
        # never-opened Project of BOTH groups, regardless of
        # created_at.
        _set_opened(self.alice, self.pa1, BASE + timedelta(days=1))

        self._login(self.alice)
        data = self._global_quick_access()

        self.assertEqual(
            self._names(data),
            [
                "Alpha 1",
                # never-opened after, GLOBALLY by created_at DESC:
                "Beta 3", "Beta 2", "Beta 1", "Alpha 3",
            ],
        )
        self.assertEqual(
            data[0]["lastOpenedAt"],
            (BASE + timedelta(days=1)).isoformat(),
        )

    def test_never_opened_fallback_is_global_created_at_desc(self):
        self._login(self.alice)
        data = self._global_quick_access()

        # Six accessible Projects across two groups, bounded to five:
        # newest created_at first, interleaving both Research Groups.
        self.assertEqual(
            self._names(data),
            ["Beta 3", "Beta 2", "Beta 1", "Alpha 3", "Alpha 2"],
        )
        # Never-opened Projects carry no personal timestamp.
        for item in data:
            self.assertIsNone(item["lastOpenedAt"])

    def test_equal_recency_timestamps_resolve_by_pk_desc(self):
        # Same personal timestamp on an Alpha and a Beta Project; the
        # higher primary key (Beta 1, created later) must win.
        self.assertGreater(self.pb1.pk, self.pa1.pk)
        same_ts = BASE + timedelta(days=5)
        _set_opened(self.alice, self.pa1, same_ts)
        _set_opened(self.alice, self.pb1, same_ts)

        self._login(self.alice)
        self.assertEqual(
            self._names(self._global_quick_access())[:2],
            ["Beta 1", "Alpha 1"],
        )

    def test_equal_created_at_tie_breaks_by_pk_desc(self):
        for project in (self.pa3, self.pb1, self.pb2):
            _set_created_at(project, BASE + timedelta(days=30))

        self._login(self.alice)
        self.assertEqual(
            self._names(self._global_quick_access()),
            # Alpha 3 / Beta 1 / Beta 2 share the newest created_at:
            # PK DESC (Beta 2 > Beta 1 > Alpha 3); then the remaining
            # by created_at DESC (Beta 3, Alpha 2), bounded to five.
            ["Beta 2", "Beta 1", "Alpha 3", "Beta 3", "Alpha 2"],
        )

    def test_bound_is_global_not_per_research_group(self):
        # Three more group A Projects (newest of all) — a per-Research
        # Group bound would return well more than five items total.
        for idx in (4, 5, 6):
            project = create_project(
                research_group=self.group_a,
                creator=self.alice,
                name=f"Alpha {idx}",
            )
            _set_created_at(
                project, BASE + timedelta(hours=10 + idx),
            )

        self._login(self.alice)
        data = self._global_quick_access()

        self.assertEqual(len(data), 5)
        # Group A claims three of the FIVE global slots; group B gets
        # the remaining two — and exactly one of group A's six is cut.
        self.assertEqual(
            self._names(data),
            ["Alpha 6", "Alpha 5", "Alpha 4", "Beta 3", "Beta 2"],
        )

    def test_archived_projects_are_excluded(self):
        # The archived Project is freshly OPENED by alice: its
        # recency must neither include it nor occupy a slot.
        _set_opened(self.alice, self.pb3, BASE + timedelta(days=9))
        archive_project(project=self.pb3, actor=self.bob)

        self._login(self.alice)
        data = self._global_quick_access()

        self.assertNotIn("Beta 3", self._names(data))
        self.assertEqual(
            self._names(data),
            ["Beta 2", "Beta 1", "Alpha 3", "Alpha 2", "Alpha 1"],
        )

    def test_projects_without_current_membership_are_excluded(self):
        # Newest-created Project in group A readable by alice and
        # dave, but NOT by bob (no ProjectMembership).
        foreign = create_project(
            research_group=self.group_a,
            creator=self.alice,
            name="Alpha 9",
        )
        _set_created_at(foreign, BASE + timedelta(days=100))
        add_project_membership(
            project=foreign,
            actor=self.alice,
            target_user=self.dave,
            role=ProjectMembership.Role.MEMBER,
        )

        self._login(self.bob)
        self.assertNotIn(
            foreign.pk, [item["id"] for item in self._global_quick_access()],
        )

        self._login(self.dave)
        # For dave it IS the newest never-opened candidate — a broken
        # access filter would hide exactly that.
        self.assertEqual(
            self._names(self._global_quick_access()),
            ["Alpha 9", "Beta 3", "Beta 2", "Beta 1", "Alpha 3"],
        )

    def test_revoked_membership_removes_project_from_global_list(self):
        # Bob's fresh personal open must not keep the Project eligible
        # once his membership is removed (recency is never
        # authorization; the CASCADE deletes his recency row).
        _set_opened(self.bob, self.pa1, BASE + timedelta(days=50))
        membership = ProjectMembership.objects.get(
            project=self.pa1, user=self.bob,
        )
        remove_membership(membership=membership, actor=self.alice)

        self.assertFalse(
            ProjectNavigationRecency.objects.filter(
                project_membership__user=self.bob,
                project_membership__project=self.pa1,
            ).exists()
        )

        self._login(self.bob)
        self.assertEqual(
            self._names(self._global_quick_access()),
            ["Beta 3", "Beta 2", "Beta 1", "Alpha 3", "Alpha 2"],
        )

    def test_other_users_recency_never_affects_order(self):
        # Bob's fresh open of Alpha 2 (inside alice's five-candidate
        # window) must neither promote it nor carry his timestamp.
        _set_opened(self.bob, self.pa2, BASE + timedelta(days=50))

        self._login(self.alice)
        data = self._global_quick_access()
        self.assertEqual(
            self._names(data),
            ["Beta 3", "Beta 2", "Beta 1", "Alpha 3", "Alpha 2"],
        )
        alpha_2 = next(
            item for item in data if item["id"] == self.pa2.pk
        )
        self.assertIsNone(alpha_2["lastOpenedAt"])

    def test_same_project_set_ranks_differently_per_user(self):
        # Both users read the SAME six Projects; each personal open
        # leads its own list.
        _set_opened(self.alice, self.pa1, BASE + timedelta(days=1))
        _set_opened(self.bob, self.pb3, BASE + timedelta(days=1))

        self._login(self.alice)
        alice_data = self._global_quick_access()
        self.assertEqual(alice_data[0]["name"], "Alpha 1")

        self._login(self.bob)
        bob_data = self._global_quick_access()
        self.assertEqual(bob_data[0]["name"], "Beta 3")
        self.assertNotEqual(
            self._names(alice_data), self._names(bob_data),
        )

    def test_empty_eligible_set_returns_empty_list(self):
        # No Research Group memberships at all.
        erin = _make_user("erin")
        self._login(erin)
        self.assertEqual(self._global_quick_access(), [])

        # In a Research Group but without any ProjectMembership.
        frank = _make_user("frank")
        _join(self.group_a, frank)
        self._login(frank)
        self.assertEqual(self._global_quick_access(), [])

    def test_each_item_shape_and_group_ownership(self):
        self._login(self.alice)
        data = self._global_quick_access()

        expected_group = {
            self.pa1.pk: self.group_a.pk,
            self.pa2.pk: self.group_a.pk,
            self.pa3.pk: self.group_a.pk,
            self.pb1.pk: self.group_b.pk,
            self.pb2.pk: self.group_b.pk,
            self.pb3.pk: self.group_b.pk,
        }
        for item in data:
            # V1 shape: no researchGroupName, no extra fields.
            self.assertEqual(
                set(item.keys()),
                {"id", "researchGroupId", "name", "lastOpenedAt"},
            )
            self.assertEqual(
                item["researchGroupId"],
                expected_group[item["id"]],
            )
        # The snapshot spans BOTH Research Groups.
        self.assertEqual(
            {item["researchGroupId"] for item in data},
            {self.group_a.pk, self.group_b.pk},
        )

    def test_get_is_pure_no_domain_mutation(self):
        self._login(self.alice)

        for project in self.all_projects:
            project.refresh_from_db()
        updated_before = {
            p.pk: p.updated_at for p in self.all_projects
        }
        memberships_before = sorted(
            (
                m.pk, m.project_id, m.user_id, m.role,
                m.added_at, m.added_by_id,
            )
            for m in ProjectMembership.objects.all()
        )
        recency_before = ProjectNavigationRecency.objects.count()
        audit_before = AuditEvent.objects.count()
        prefs_before = WorkspaceNavigationPreferences.objects.filter(
            user=self.alice,
        ).count()
        self.assertEqual(prefs_before, 0)

        data = self._global_quick_access()
        self.assertEqual(len(data), 5)
        # A second read is equally pure.
        self._global_quick_access()

        self.assertEqual(
            ProjectNavigationRecency.objects.count(), recency_before,
        )
        self.assertEqual(AuditEvent.objects.count(), audit_before)
        self.assertEqual(
            WorkspaceNavigationPreferences.objects.filter(
                user=self.alice,
            ).count(),
            prefs_before,
        )
        for project in self.all_projects:
            project.refresh_from_db()
            self.assertEqual(
                project.updated_at, updated_before[project.pk],
            )
        self.assertEqual(
            sorted(
                (
                    m.pk, m.project_id, m.user_id, m.role,
                    m.added_at, m.added_by_id,
                )
                for m in ProjectMembership.objects.all()
            ),
            memberships_before,
        )
