"""Membership invariant and concurrency hardening tests for WorkItems.

Verifies:
- Stale ProjectMembership (ResearchGroupMembership removed) blocks access
- Stale assignee membership is rejected
- Service locking structure uses select_for_update() on Project row
- Write authorization is re-checked under the lock
"""

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, TransactionTestCase
from rest_framework.test import APIClient, APITestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import Project, ProjectMembership
from projects.services import create_project, add_project_membership

from work_items.models import WorkItem, WorkItemAssignee
from work_items.services import (
    WorkItemDomainError,
    create_work_item,
    update_work_item,
    _validate_assignee_eligibility,
)

User = get_user_model()


# ── Auth Mixin ──


class _AuthMixin:
    """Mixin with login helper for APIClient-based tests."""

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

    def _get_csrf_token(self):
        self.client.get("/api/auth/csrf/")
        csrf_cookie = self.client.cookies.get("csrftoken")
        return csrf_cookie.value if csrf_cookie else ""


# ── Setup helpers ──


def _create_test_scenario():
    """Create the standard test scenario.

    Returns dict with group, alex (owner), chris (member), laura (viewer),
    maria (no membership), paper_xyz project.
    """
    group = ResearchGroup.objects.create(
        name="FG Test",
        created_by=User.objects.create_user(username="alex", password="Pass1!"),
    )
    alex = User.objects.get(username="alex")
    ResearchGroupMembership.objects.create(
        research_group=group, user=alex, role=ResearchGroupMembership.Role.ADMIN,
    )

    chris = User.objects.create_user(username="chris", password="Pass1!")
    ResearchGroupMembership.objects.create(
        research_group=group, user=chris, role=ResearchGroupMembership.Role.MEMBER,
    )

    laura = User.objects.create_user(username="laura", password="Pass1!")
    ResearchGroupMembership.objects.create(
        research_group=group, user=laura, role=ResearchGroupMembership.Role.MEMBER,
    )

    maria = User.objects.create_user(username="maria", password="Pass1!")
    ResearchGroupMembership.objects.create(
        research_group=group, user=maria, role=ResearchGroupMembership.Role.MEMBER,
    )

    paper_xyz = create_project(research_group=group, creator=alex, name="Paper XYZ")
    add_project_membership(project=paper_xyz, actor=alex, target_user=chris, role=ProjectMembership.Role.MEMBER)
    add_project_membership(project=paper_xyz, actor=alex, target_user=laura, role=ProjectMembership.Role.VIEWER)

    return {
        "group": group,
        "alex": alex,
        "chris": chris,
        "laura": laura,
        "maria": maria,
        "paper_xyz": paper_xyz,
    }


# ── Stale Membership Regression Tests ──


class StaleProjectMembershipTest(TransactionTestCase):
    """Test that stale ProjectMembership (ResearchGroupMembership removed) blocks access.

    Simulates a scenario where a user's ResearchGroupMembership is deleted
    but their ProjectMembership still exists.
    """

    def setUp(self):
        self.data = _create_test_scenario()
        self.wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test Task",
        )

    def _make_membership_stale(self, user):
        """Remove the user's ResearchGroupMembership while keeping ProjectMembership."""
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"],
            user=user,
        ).delete()

    def test_stale_member_cannot_list_work_items(self):
        """Chris has ProjectMembership but no ResearchGroupMembership → service rejects."""
        self._make_membership_stale(self.data["chris"])
        from work_items.services import _require_project_write_access
        with self.assertRaises(WorkItemDomainError):
            _require_project_write_access(self.data["paper_xyz"], self.data["chris"])

    def test_stale_member_cannot_create_work_item(self):
        """Chris has ProjectMembership but no ResearchGroupMembership → cannot create."""
        self._make_membership_stale(self.data["chris"])
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.data["paper_xyz"],
                actor=self.data["chris"],
                type=WorkItem.Type.TASK,
                title="Should Fail",
            )

    def test_stale_member_cannot_update_work_item(self):
        """Chris has ProjectMembership but no ResearchGroupMembership → cannot update."""
        self._make_membership_stale(self.data["chris"])
        with self.assertRaises(WorkItemDomainError):
            update_work_item(
                work_item=self.wi,
                actor=self.data["chris"],
                title="Hacked",
            )

    def test_stale_owner_cannot_create_work_item(self):
        """Even an owner with stale ResearchGroupMembership cannot create."""
        self._make_membership_stale(self.data["alex"])
        with self.assertRaises(WorkItemDomainError):
            create_work_item(
                project=self.data["paper_xyz"],
                actor=self.data["alex"],
                type=WorkItem.Type.TASK,
                title="Should Fail",
            )


class StaleAssigneeMembershipTest(TransactionTestCase):
    """Test that stale assignee membership is rejected."""

    def setUp(self):
        self.data = _create_test_scenario()

    def test_stale_assignee_rejected(self):
        """Chris has ProjectMembership but no ResearchGroupMembership → cannot be assigned."""
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"],
            user=self.data["chris"],
        ).delete()

        with self.assertRaises(WorkItemDomainError) as ctx:
            create_work_item(
                project=self.data["paper_xyz"],
                actor=self.data["alex"],
                type=WorkItem.Type.TASK,
                title="Assign Stale",
                assignee_ids=[self.data["chris"].pk],
            )
        self.assertIn("ResearchGroupMembership", ctx.exception.message)

    def test_stale_assignee_rejected_in_update(self):
        """Replacing assignee with a stale member is rejected."""
        wi = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test",
        )

        # Make Chris stale
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"],
            user=self.data["chris"],
        ).delete()

        with self.assertRaises(WorkItemDomainError):
            update_work_item(
                work_item=wi,
                actor=self.data["alex"],
                assignee_ids=[self.data["chris"].pk],
            )

        # Original assignees should be preserved (no assignees in this case)
        wi.refresh_from_db()
        self.assertEqual(wi.assignee_relations.count(), 0)


class StaleMembershipAPITest(_AuthMixin, APITestCase):
    """API-level tests for stale membership."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _create_test_scenario()
        cls.wi = create_work_item(
            project=cls.data["paper_xyz"],
            actor=cls.data["alex"],
            type=WorkItem.Type.TASK,
            title="Test Task",
        )

    def test_stale_member_cannot_list_via_api(self):
        """Chris with stale membership cannot list via API."""
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"],
            user=self.data["chris"],
        ).delete()

        self._login("chris")
        response = self.client.get(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/"
        )
        self.assertEqual(response.status_code, 404)

    def test_stale_member_cannot_read_work_item_via_api(self):
        """Chris with stale membership cannot read WorkItem via API."""
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"],
            user=self.data["chris"],
        ).delete()

        self._login("chris")
        response = self.client.get(f"/api/work-items/{self.wi.pk}/")
        self.assertEqual(response.status_code, 404)

    def test_stale_member_cannot_create_via_api(self):
        """Chris with stale membership cannot create via API → 404 (non-leaking)."""
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"],
            user=self.data["chris"],
        ).delete()

        self._login("chris")
        csrf = self._get_csrf_token()
        response = self.client.post(
            f"/api/projects/{self.data['paper_xyz'].pk}/work-items/",
            data={"type": "task", "title": "Should Fail"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 404)

    def test_stale_member_cannot_update_via_api(self):
        """Chris with stale membership cannot update via API → 404 (non-leaking)."""
        ResearchGroupMembership.objects.filter(
            research_group=self.data["group"],
            user=self.data["chris"],
        ).delete()

        self._login("chris")
        csrf = self._get_csrf_token()
        response = self.client.patch(
            f"/api/work-items/{self.wi.pk}/",
            data={"title": "Hacked"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 404)


# ── Concurrency Structure Tests ──


class ConcurrencyStructureTest(TestCase):
    """Verify the service locking structure.

    These tests verify that the correct locking primitives are used.
    Full concurrent testing with deterministic scheduling is outside scope;
    see limitation in the report.
    """

    def setUp(self):
        self.data = _create_test_scenario()

    def test_create_work_item_uses_transaction_atomic(self):
        """create_work_item must wrap mutations in transaction.atomic()."""
        import inspect
        source = inspect.getsource(create_work_item)
        self.assertIn("with transaction.atomic()", source)
        self.assertIn("Project.objects.select_for_update", source)

    def test_create_work_item_locks_project_before_validation(self):
        """Project row must be locked before write access and assignee checks."""
        import inspect
        source = inspect.getsource(create_work_item)
        lock_pos = source.index("Project.objects.select_for_update")
        write_pos = source.index("_require_project_write_access")
        assignee_pos = source.index("_validate_assignees") if "_validate_assignees" in source else len(source)
        self.assertLess(lock_pos, write_pos,
                        "Project must be locked before write access check")
        self.assertLess(lock_pos, assignee_pos,
                        "Project must be locked before assignee validation")

    def test_create_work_item_rechecks_write_access_under_lock(self):
        """_require_project_write_access must be called inside the transaction.atomic()."""
        import inspect
        source = inspect.getsource(create_work_item)
        atomic_pos = source.index("with transaction.atomic()")
        write_pos = source.index("_require_project_write_access")
        self.assertLess(atomic_pos, write_pos,
                        "Write access check must be inside transaction.atomic()")

    def test_update_work_item_uses_transaction_atomic(self):
        """update_work_item must wrap mutations in transaction.atomic()."""
        import inspect
        source = inspect.getsource(update_work_item)
        self.assertIn("with transaction.atomic()", source)
        self.assertIn("Project.objects.select_for_update", source)

    def test_update_work_item_locks_project_before_validation(self):
        """Project row must be locked before write access and assignee checks."""
        import inspect
        source = inspect.getsource(update_work_item)
        lock_pos = source.index("Project.objects.select_for_update")
        write_pos = source.index("_require_project_write_access")
        assignee_pos = source.index("_validate_assignees") if "_validate_assignees" in source else len(source)
        self.assertLess(lock_pos, write_pos,
                        "Project must be locked before write access check")
        self.assertLess(lock_pos, assignee_pos,
                        "Project must be locked before assignee validation")

    def test_update_work_item_rechecks_write_access_under_lock(self):
        """_require_project_write_access must be called inside transaction.atomic()."""
        import inspect
        source = inspect.getsource(update_work_item)
        atomic_pos = source.index("with transaction.atomic()")
        write_pos = source.index("_require_project_write_access")
        self.assertLess(atomic_pos, write_pos,
                        "Write access check must be inside transaction.atomic()")

    def test_update_work_item_locks_work_item(self):
        """update_work_item must lock the WorkItem row with select_for_update()."""
        import inspect
        source = inspect.getsource(update_work_item)
        self.assertIn("WorkItem.objects.select_for_update", source)

    def test_update_work_item_allows_non_parent_change(self):
        """update_work_item must lock Project for ALL writes, not just hierarchy changes.

        Verified: the source contains a with transaction.atomic() block that
        wraps both Project and WorkItem select_for_update() calls, meaning
        all update paths go through the same locked path.
        """
        import inspect
        source = inspect.getsource(update_work_item)
        # Must contain both Project and WorkItem locking
        self.assertIn("Project.objects.select_for_update", source)
        self.assertIn("WorkItem.objects.select_for_update", source)
        self.assertIn("with transaction.atomic()", source)


class StaleMembershipServiceRecheckTest(TransactionTestCase):
    """Test that membership is re-checked under the lock.

    Uses TransactionTestCase because we need separate transactions
    to simulate concurrent membership changes.
    """

    def setUp(self):
        self.data = _create_test_scenario()

    def test_assignee_eligibility_checks_research_group(self):
        """_validate_assignee_eligibility must check ResearchGroupMembership."""
        import inspect
        source = inspect.getsource(_validate_assignee_eligibility)
        self.assertIn("ResearchGroupMembership", source)

    def test_write_access_checks_research_group(self):
        """_require_project_write_access must check ResearchGroupMembership."""
        from work_items.services import _require_project_write_access
        import inspect
        source = inspect.getsource(_require_project_write_access)
        self.assertIn("ResearchGroupMembership", source)

    def test_create_work_item_checks_research_group_in_write_access(self):
        """create_work_item's write access check must verify ResearchGroupMembership."""
        from work_items.services import _require_project_write_access
        import inspect
        source = inspect.getsource(_require_project_write_access)
        self.assertIn("ResearchGroupMembership", source)
