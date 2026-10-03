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
