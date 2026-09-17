"""Tests for the stable semantic kind of WorkItem type definitions.

The display ``name`` of a WorkItemTypeDefinition is presentation
metadata; the semantic kind (task / epic / milestone / deliverable) is
stable machine-readable metadata that runtime code must never infer
from the name.

Covers:
- canonical default definitions expose their canonical kind
- custom / unclassified definitions carry no kind and are never
  classified (neither at creation nor by any name-based inference)
- renaming a definition never changes its kind
- two Projects may use different display names for the same kind
- the configuration API exposes the kind and never lets a client
  set or change it (authorization unchanged)
- the kind migration is provenance-safe: it assigns no semantic kind
  to any pre-existing row, even one whose display name exactly
  matches a canonical default name
"""

from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient, APITestCase

from projects.configuration_services import (
    create_type_definition,
    update_type_definition,
)
from projects.models import (
    Project,
    ProjectMembership,
    WorkItemTypeDefinition,
)
from projects.services import add_project_membership, create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

User = get_user_model()


def _make_project(name, creator, group):
    return create_project(
        research_group=group,
        creator=creator,
        name=name,
    )


class _ProjectSetupMixin:
    def setUp(self):
        super().setUp()
        self.alex = User.objects.create_user(
            username="kind_alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="kind_chris", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="FG Kind", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = _make_project("Kind Project", self.alex, self.group)


class DefaultTypeKindTest(_ProjectSetupMixin, TestCase):
    """Domain: canonical defaults carry the fixed semantic kind."""

    def test_default_types_carry_canonical_kinds(self):
        kinds = {
            d.name: d.kind
            for d in WorkItemTypeDefinition.objects.filter(
                project=self.project
            )
        }
        self.assertEqual(kinds, {
            "Epic": "epic",
            "Milestone": "milestone",
            "Deliverable": "deliverable",
            "Task": "task",
        })

    def test_custom_type_has_no_canonical_kind(self):
        t = create_type_definition(self.project, self.alex, "Figure")
        self.assertIsNone(t.kind)

    def test_renaming_default_type_preserves_kind(self):
        task = self.project.type_definitions.get(name="Task")
        self.assertEqual(task.kind, "task")

        update_type_definition(task, self.alex, name="Experiment step")
        task.refresh_from_db()

        self.assertEqual(task.name, "Experiment step")
        self.assertEqual(task.kind, "task")

    def test_kind_is_not_inferred_from_name_at_runtime(self):
        """A custom type created LATER with a canonical-looking name
        gets no kind: classification happens only when the system
        creates the canonical defaults at Project creation — never
        from the name."""
        task = self.project.type_definitions.get(name="Task")
        # Free the canonical name by renaming the default away (the
        # default keeps its kind).
        update_type_definition(task, self.alex, name="Experiment step")

        impostor = create_type_definition(self.project, self.alex, "Task")

        self.assertIsNone(impostor.kind)
        task.refresh_from_db()
        self.assertEqual(task.kind, "task")

    def test_two_projects_different_names_same_kind(self):
        other = _make_project("Kind Project Two", self.alex, self.group)

        task_a = self.project.type_definitions.get(name="Task")
        task_b = other.type_definitions.get(name="Task")
        update_type_definition(task_a, self.alex, name="To-do")
        update_type_definition(task_b, self.alex, name="Aufgabe")
        task_a.refresh_from_db()
        task_b.refresh_from_db()

        self.assertNotEqual(task_a.name, task_b.name)
        self.assertEqual(task_a.kind, "task")
        self.assertEqual(task_b.kind, "task")


class _ConfigApiSetupMixin:
    @classmethod
    def setUpTestData(cls):
        cls.alex = User.objects.create_user(
            username="kind_api_alex", password="Pass1!",
        )
        cls.chris = User.objects.create_user(
            username="kind_api_chris", password="Pass1!",
        )
        cls.group = ResearchGroup.objects.create(
            name="FG Kind API", created_by=cls.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group, user=cls.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group, user=cls.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        cls.project = _make_project(
            "Kind API Project", cls.alex, cls.group,
        )
        add_project_membership(
            project=cls.project,
            actor=cls.alex,
            target_user=cls.chris,
            role=ProjectMembership.Role.MEMBER,
        )

    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def login(self, username):
        self.client.get("/api/auth/csrf/")
        csrf_token = (
            self.client.cookies.get("csrftoken").value
        )
        response = self.client.post(
            "/api/auth/login/",
            data={
                "username": username,
                "password": "Pass1!",
            },
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)


class TypeKindConfigurationApiTest(_ConfigApiSetupMixin, APITestCase):
    """API: the kind is exposed read-only; clients cannot set it."""

    def test_configuration_payload_exposes_kind(self):
        create_type_definition(self.project, self.alex, "Figure")
        self.login("kind_api_alex")

        response = self.client.get(
            f"/api/projects/{self.project.pk}/work-item-configuration/"
        )

        self.assertEqual(response.status_code, 200)
        kinds = {
            t["name"]: t["kind"]
            for t in response.json()["types"]
        }
        self.assertEqual(kinds, {
            "Epic": "epic",
            "Milestone": "milestone",
            "Deliverable": "deliverable",
            "Task": "task",
            "Figure": None,
        })

    def test_create_type_ignores_client_supplied_kind(self):
        self.login("kind_api_alex")

        response = self.client.post(
            f"/api/projects/{self.project.pk}/work-item-configuration/types/",
            data={"name": "Figure", "kind": "task"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["kind"], None)

    def test_update_type_ignores_client_supplied_kind(self):
        figure = create_type_definition(self.project, self.alex, "Figure")
        self.login("kind_api_alex")

        response = self.client.patch(
            f"/api/projects/{self.project.pk}/work-item-configuration/types/{figure.pk}/",
            data={"kind": "epic"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["kind"], None)
        figure.refresh_from_db()
        self.assertIsNone(figure.kind)

    def test_rename_via_api_preserves_kind(self):
        task = self.project.type_definitions.get(name="Task")
        self.login("kind_api_alex")

        response = self.client.patch(
            f"/api/projects/{self.project.pk}/work-item-configuration/types/{task.pk}/",
            data={"name": "Experiment step", "kind": "epic"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "Experiment step")
        self.assertEqual(response.json()["kind"], "task")

    def test_configuration_kind_is_owner_protected(self):
        """Authorization is unchanged: a member (non-owner) cannot
        create or update type definitions."""
        self.login("kind_api_chris")

        create_response = self.client.post(
            f"/api/projects/{self.project.pk}/work-item-configuration/types/",
            data={"name": "Figure"},
            content_type="application/json",
        )
        self.assertEqual(create_response.status_code, 403)

        task = self.project.type_definitions.get(name="Task")
        update_response = self.client.patch(
            f"/api/projects/{self.project.pk}/work-item-configuration/types/{task.pk}/",
            data={"name": "Experiment step"},
            content_type="application/json",
        )
        self.assertEqual(update_response.status_code, 403)
        task.refresh_from_db()
        self.assertEqual(task.name, "Task")


# ── Kind migration (projects/0006): provenance-safe ──


class TypeKindMigrationProvenanceTest(TransactionTestCase):
    """The kind migration must never attribute semantic kind from
    presentation/configuration state.

    Key invariant: a pre-existing legacy row with ``name = "Task"``
    and no machine-readable proof that it was the canonical system
    Task must NOT acquire ``kind = "task"`` solely because of its
    name — the same holds for the other canonical names, for case
    variants, and for rows that additionally match the legacy
    canonical creation order.

    Stepping the ``projects`` app back/forward around ``0006`` on the
    live test connection exercises the real migration operation
    (AddField — and the ABSENCE of any backfill) instead of a copy
    of its logic. ``TransactionTestCase`` (no wrapping savepoint) is
    required: every step and every legacy row is committed in its own
    transaction, because PostgreSQL refuses an ALTER TABLE on a table
    that still carries pending trigger events from earlier DML in the
    SAME transaction (unique-index trigger events left by INSERTs).
    """

    @classmethod
    def _step(cls, target):
        from django.db import connections
        from django.db.migrations.executor import MigrationExecutor

        MigrationExecutor(connections["default"]).migrate([target])

    def _create_project(self, name):
        user = User.objects.create(username=f"prov_{name}")
        group = ResearchGroup.objects.create(
            name=name, created_by=user,
        )
        ResearchGroupMembership.objects.create(
            research_group=group,
            user=user,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        project = Project.objects.create(
            name=name,
            research_group=group,
            created_by=user,
        )
        ProjectMembership.objects.create(
            project=project,
            research_group=group,
            user=user,
            role=ProjectMembership.Role.OWNER,
            added_by=user,
        )
        return project

    def test_migration_never_classifies_from_display_name(self):
        # 1) Create the "legacy" rows while the kind column still
        #    exists; every row is NULL — exactly the pre-migration
        #    state. Committed in their own transaction (the test
        #    class runs without a wrapping savepoint).
        project_a = self._create_project("Provenance Project A")
        project_b = self._create_project("Provenance Project B")
        project_c = self._create_project("Provenance Project C")

        # Project A: the four canonical default names exactly as the
        # system creates them, plus custom types — one a
        # renamed-default stand-in.
        for name in ("Epic", "Milestone", "Deliverable", "Task"):
            WorkItemTypeDefinition.objects.create(
                project=project_a, name=name,
            )
        WorkItemTypeDefinition.objects.create(
            project=project_a, name="Experiment",
        )
        WorkItemTypeDefinition.objects.create(
            project=project_a, name="Experiment step",
        )

        # Project B: the four canonical names in exactly the legacy
        # work_items/0003 creation order (order 0..3) — the
        # strongest name + order shape the history ever left behind.
        # It still must NOT be classified.
        for order, name in enumerate(
            ("Epic", "Milestone", "Deliverable", "Task"),
        ):
            WorkItemTypeDefinition.objects.create(
                project=project_b, name=name, order=order,
            )

        # Project C: a case VARIANT of a canonical name only (a
        # manually created "task") — no case-insensitive matching.
        # (It cannot share a Project with a "Task" row: names are
        # case-insensitively unique per Project.)
        WorkItemTypeDefinition.objects.create(
            project=project_c, name="task",
        )

        # 2) Step back to just BEFORE the kind migration (the
        #    column is dropped; the rows survive as legacy data).
        self._step(
            ("projects", "0005_projectmembership_research_group"),
        )

        # 3) Step forward: AddField runs for real over the
        #    pre-existing rows.
        self._step(("projects", "0006_workitemtypedefinition_kind"))

        # 4) EVERY pre-existing row stays unclassified — including
        #    the rows whose names exactly match the canonical
        #    defaults (and the legacy creation order).
        legacy_rows = WorkItemTypeDefinition.objects.filter(
            project__in=[project_a, project_b, project_c],
        )
        self.assertEqual(legacy_rows.count(), 11)
        for row in legacy_rows:
            self.assertIsNone(
                row.kind,
                f"pre-existing definition {row.name!r} must not "
                "acquire a semantic kind from its display name",
            )
