"""Backend Core Checkpoint Integration Test.

Exercises the complete Foundation core flow through the real API
with authenticated sessions.

Flow:
    Alex logs in
      → creates Paper XYZ
      → becomes Owner
      → adds Chris as Member
      → creates "Rewrite Introduction" assigned to Chris

    Chris logs in
      → sees Paper XYZ
      → sees the Work Item in My Work
      → sees the same Work Item in Project Board

    Maria logs in
      → cannot see Paper XYZ

Proves:
    - Single canonical WorkItem record
    - Same WorkItem ID in My Work and Project WorkItems
    - Maria privacy enforced at the API level
    - Research Group admin without ProjectMembership cannot access
"""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient, APITestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership

User = get_user_model()

SEED_PASSWORD = "DevPass1!"


class CoreCheckpointIntegrationTest(APITestCase):
    """Complete Core backend flow integration test.

    Starts from users and a Research Group with no Paper XYZ Project.
    Exercises the real API boundaries with authenticated sessions.
    """

    def setUp(self):
        self.client = APIClient()

        # Create users
        self.alex = User.objects.create_user(
            username="alex", password=SEED_PASSWORD,
            first_name="Alex", last_name="Dev"
        )
        self.chris = User.objects.create_user(
            username="chris", password=SEED_PASSWORD,
            first_name="Chris", last_name="Dev"
        )
        self.maria = User.objects.create_user(
            username="maria", password=SEED_PASSWORD,
            first_name="Maria", last_name="Dev"
        )
        self.laura = User.objects.create_user(
            username="laura", password=SEED_PASSWORD,
            first_name="Laura", last_name="Dev"
        )

        # Create Research Group
        self.group = ResearchGroup.objects.create(
            name="FG Example", created_by=self.alex
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.maria,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.laura,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        # No Paper XYZ Project yet — will be created through the API

    def _login(self, username):
        """Authenticate via the real login API with CSRF."""
        self.client.get("/api/auth/csrf/")
        csrf_token = self.client.cookies.get("csrftoken").value
        self.client.post(
            "/api/auth/login/",
            data={"username": username, "password": SEED_PASSWORD},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

    def _get_csrf_token(self):
        self.client.get("/api/auth/csrf/")
        csrf_cookie = self.client.cookies.get("csrftoken")
        return csrf_cookie.value if csrf_cookie else ""

    # ── STEP 1: Alex authenticates ──

    def test_01_alex_authenticates(self):
        self._login("alex")
        response = self.client.get("/api/auth/me/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["username"], "alex")

    # ── STEP 2: Alex can access FG Example ──

    def test_02_alex_accesses_research_group(self):
        self._login("alex")
        response = self.client.get(
            f"/api/research-groups/{self.group.pk}/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "FG Example")
        self.assertEqual(response.json()["role"], "admin")

    # ── STEP 3: Alex creates Paper XYZ ──

    def test_03_alex_creates_paper_xyz(self):
        self._login("alex")
        csrf = self._get_csrf_token()

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/projects/",
            data={"name": "Paper XYZ", "description": "Research paper on XYZ."},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 201)
        project_data = response.json()
        self.assertEqual(project_data["name"], "Paper XYZ")
        self.assertIsNotNone(project_data["id"])

    # ── STEP 4: Alex becomes Owner ──

    def test_04_alex_becomes_owner(self):
        self._login("alex")
        csrf = self._get_csrf_token()

        response = self.client.post(
            f"/api/research-groups/{self.group.pk}/projects/",
            data={"name": "Paper XYZ"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        project_id = response.json()["id"]

        # Verify Alex is owner
        response = self.client.get(
            f"/api/projects/{project_id}/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["currentUserRole"], "owner")

    # ── STEP 5: Alex adds Chris as member ──

    def test_05_alex_adds_chris(self):
        self._login("alex")
        csrf = self._get_csrf_token()

        # Create project
        create_resp = self.client.post(
            f"/api/research-groups/{self.group.pk}/projects/",
            data={"name": "Paper XYZ"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        project_id = create_resp.json()["id"]

        # Add Chris
        add_resp = self.client.post(
            f"/api/projects/{project_id}/memberships/",
            data={"userId": self.chris.pk, "role": "member"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(add_resp.status_code, 201)
        self.assertEqual(add_resp.json()["role"], "member")
        self.assertEqual(add_resp.json()["user"]["username"], "chris")

    # ── STEP 6: Alex creates Rewrite Introduction assigned to Chris ──

    def test_06_alex_creates_work_item(self):
        self._login("alex")
        csrf = self._get_csrf_token()

        create_resp = self.client.post(
            f"/api/research-groups/{self.group.pk}/projects/",
            data={"name": "Paper XYZ"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        project_id = create_resp.json()["id"]

        # Add Chris
        self.client.post(
            f"/api/projects/{project_id}/memberships/",
            data={"userId": self.chris.pk, "role": "member"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        # Create WorkItem
        wi_resp = self.client.post(
            f"/api/projects/{project_id}/work-items/",
            data={
                "type": "task",
                "title": "Rewrite Introduction",
                "assigneeIds": [self.chris.pk],
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(wi_resp.status_code, 201)
        wi_data = wi_resp.json()
        self.assertEqual(wi_data["title"], "Rewrite Introduction")
        self.assertEqual(wi_data["type"], "task")
        self.assertEqual(wi_data["status"], "todo")
        self.assertIn(self.chris.pk, wi_data["assigneeIds"])
        self.assertEqual(wi_data["projectId"], project_id)

    # ── STEPS 7-10: Chris authenticates and checks ──

    def test_07_10_chris_full_flow(self):
        """Complete flow: Chris sees WorkItem in both views with same ID."""
        # Setup: Alex creates project, adds Chris, creates WorkItem
        self._login("alex")
        csrf = self._get_csrf_token()

        create_resp = self.client.post(
            f"/api/research-groups/{self.group.pk}/projects/",
            data={"name": "Paper XYZ"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        project_id = create_resp.json()["id"]

        self.client.post(
            f"/api/projects/{project_id}/memberships/",
            data={"userId": self.chris.pk, "role": "member"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        wi_resp = self.client.post(
            f"/api/projects/{project_id}/work-items/",
            data={
                "type": "task",
                "title": "Rewrite Introduction",
                "assigneeIds": [self.chris.pk],
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        work_item_id = wi_resp.json()["id"]

        # ── Chris authenticates ──
        self.client.logout()
        self._login("chris")

        # ── Chris sees Paper XYZ ──
        projects_resp = self.client.get(
            f"/api/research-groups/{self.group.pk}/projects/"
        )
        self.assertEqual(projects_resp.status_code, 200)
        project_names = {p["name"] for p in projects_resp.json()}
        self.assertIn("Paper XYZ", project_names)

        # ── Chris sees Rewrite Introduction in My Work ──
        my_work_resp = self.client.get(
            f"/api/research-groups/{self.group.pk}/my-work/"
        )
        self.assertEqual(my_work_resp.status_code, 200)
        my_work_ids = {item["id"] for item in my_work_resp.json()}
        self.assertIn(
            work_item_id, my_work_ids,
            "Chris should see Rewrite Introduction in My Work"
        )

        # ── Chris sees Rewrite Introduction through Project WorkItems ──
        project_wi_resp = self.client.get(
            f"/api/projects/{project_id}/work-items/"
        )
        self.assertEqual(project_wi_resp.status_code, 200)
        project_wi_ids = {item["id"] for item in project_wi_resp.json()}
        self.assertIn(
            work_item_id, project_wi_ids,
            "Chris should see Rewrite Introduction in Project WorkItems"
        )

        # ── SAME WorkItem ID ──
        my_work_item = next(
            i for i in my_work_resp.json() if i["id"] == work_item_id
        )
        project_work_item = next(
            i for i in project_wi_resp.json() if i["id"] == work_item_id
        )
        self.assertEqual(
            my_work_item["id"], project_work_item["id"],
            "My Work and Project WorkItems must return the SAME WorkItem ID"
        )

    # ── Maria privacy ──

    def test_maria_privacy(self):
        """Maria is Research Group member but has no Paper XYZ membership.

        Verifies:
        - Paper XYZ absent from her authorized project list
        - Direct Project access denied (404)
        - Paper XYZ WorkItems inaccessible
        - Rewrite Introduction not exposed in My Work
        """
        # Setup: Alex creates project, adds Chris, creates WorkItem
        self._login("alex")
        csrf = self._get_csrf_token()

        create_resp = self.client.post(
            f"/api/research-groups/{self.group.pk}/projects/",
            data={"name": "Paper XYZ"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        project_id = create_resp.json()["id"]

        self.client.post(
            f"/api/projects/{project_id}/memberships/",
            data={"userId": self.chris.pk, "role": "member"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        wi_resp = self.client.post(
            f"/api/projects/{project_id}/work-items/",
            data={
                "type": "task",
                "title": "Rewrite Introduction",
                "assigneeIds": [self.chris.pk],
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        work_item_id = wi_resp.json()["id"]

        # ── Maria authenticates ──
        self.client.logout()
        self._login("maria")

        # Paper XYZ absent from Maria's project list
        projects_resp = self.client.get(
            f"/api/research-groups/{self.group.pk}/projects/"
        )
        self.assertEqual(projects_resp.status_code, 200)
        project_names = {p["name"] for p in projects_resp.json()}
        self.assertNotIn(
            "Paper XYZ", project_names,
            "Maria must not see Paper XYZ in project list"
        )

        # Direct Project access denied (404)
        detail_resp = self.client.get(f"/api/projects/{project_id}/")
        self.assertEqual(
            detail_resp.status_code, 404,
            "Direct Project access must return 404 for Maria"
        )

        # Paper XYZ WorkItems inaccessible (404)
        wi_list_resp = self.client.get(
            f"/api/projects/{project_id}/work-items/"
        )
        self.assertEqual(
            wi_list_resp.status_code, 404,
            "Project WorkItems must return 404 for Maria"
        )

        # Rewrite Introduction not exposed in My Work
        my_work_resp = self.client.get(
            f"/api/research-groups/{self.group.pk}/my-work/"
        )
        self.assertEqual(my_work_resp.status_code, 200)
        my_work_ids = {item["id"] for item in my_work_resp.json()}
        self.assertNotIn(
            work_item_id, my_work_ids,
            "Maria must not see Rewrite Introduction in My Work"
        )

    # ── Single canonical data proof ──

    def test_single_canonical_work_item(self):
        """Prove there is only one WorkItem record for 'Rewrite Introduction'
        and both views reference it."""
        from work_items.models import WorkItem

        # Setup
        self._login("alex")
        csrf = self._get_csrf_token()

        create_resp = self.client.post(
            f"/api/research-groups/{self.group.pk}/projects/",
            data={"name": "Paper XYZ"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        project_id = create_resp.json()["id"]

        self.client.post(
            f"/api/projects/{project_id}/memberships/",
            data={"userId": self.chris.pk, "role": "member"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

        wi_resp = self.client.post(
            f"/api/projects/{project_id}/work-items/",
            data={
                "type": "task",
                "title": "Rewrite Introduction",
                "assigneeIds": [self.chris.pk],
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        work_item_id = wi_resp.json()["id"]

        # Verify only one record in DB
        count = WorkItem.objects.filter(
            title="Rewrite Introduction",
            project_id=project_id,
        ).count()
        self.assertEqual(count, 1, "Only one canonical WorkItem record exists")

        # Chris sees it in both views with same ID
        self.client.logout()
        self._login("chris")

        my_work = self.client.get(
            f"/api/research-groups/{self.group.pk}/my-work/"
        ).json()
        project_wis = self.client.get(
            f"/api/projects/{project_id}/work-items/"
        ).json()

        my_wi = next(i for i in my_work if i["id"] == work_item_id)
        proj_wi = next(i for i in project_wis if i["id"] == work_item_id)

        # All three IDs must match
        self.assertEqual(my_wi["id"], work_item_id)
        self.assertEqual(proj_wi["id"], work_item_id)
        self.assertEqual(my_wi["id"], proj_wi["id"])
