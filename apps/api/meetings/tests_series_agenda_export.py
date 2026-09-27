"""API tests for the MeetingSeries agenda JSON export endpoint.

Contract under test:
``GET /api/meeting-series/{series_id}/agenda-export.json``
- read-only, side-effect-free JSON document (schema version 1),
- canonical MeetingSeries read authorization (non-leaking 404),
- deterministic content and a safe attachment filename.
"""

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils.text import slugify
from rest_framework import status
from rest_framework.test import APIClient

from projects.models import ProjectMembership
from projects.services import (
    add_project_membership,
    archive_project,
    create_project,
)
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)

from .models import MeetingSeries, MeetingSeriesSection
from .services import (
    create_series_section,
    reorder_series_sections,
)


User = get_user_model()


def _export_url(series):
    return f"/api/meeting-series/{series.pk}/agenda-export.json"


class MeetingSeriesAgendaExportApiTest(TestCase):
    """Document contract of the agenda JSON export (group-scoped)."""

    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="export-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="export-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="export-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Agenda Export Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.chris,
            role=ResearchGroupMembership.Role.MEMBER,
        )

        self.series = MeetingSeries.objects.create(
            research_group=self.group,
            title="FG Weekly",
            description="Weekly meeting.",
            created_by=self.alex,
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    # ── Authentication / authorization ───────────────────────────

    def test_authentication_is_required(self):
        response = self.client.get(_export_url(self.series))
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_group_member_can_export(self):
        self.login(self.chris)
        response = self.client.get(_export_url(self.series))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["schemaVersion"], 1)

    def test_unknown_series_returns_404(self):
        self.login(self.chris)
        response = self.client.get(
            "/api/meeting-series/999999/agenda-export.json",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_out_of_scope_access_is_non_leaking_404(self):
        create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Secret section",
        )
        self.login(self.maria)  # not a Research Group member

        response = self.client.get(_export_url(self.series))

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(),
            {"error": "Meeting series not found"},
        )
        self.assertNotIn("Secret section", str(response.content))
        self.assertNotIn("FG Weekly", str(response.content))

    # ── Read-only / side-effect free ─────────────────────────────

    def test_export_rejects_write_methods(self):
        self.login(self.chris)
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    _export_url(self.series),
                )
                self.assertEqual(
                    response.status_code,
                    status.HTTP_405_METHOD_NOT_ALLOWED,
                )

    def test_export_is_side_effect_free(self):
        section = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Check-In",
        )
        self.login(self.chris)

        self.series.refresh_from_db()
        updated_at_before = self.series.updated_at
        section_count_before = MeetingSeriesSection.objects.count()

        response = self.client.get(_export_url(self.series))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.series.refresh_from_db()
        section.refresh_from_db()
        self.assertEqual(self.series.updated_at, updated_at_before)
        self.assertEqual(section.name, "Check-In")
        self.assertEqual(
            MeetingSeriesSection.objects.count(),
            section_count_before,
        )

    # ── Document shape ───────────────────────────────────────────

    def test_exact_schema_version_and_field_shape(self):
        top = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="TOPs",
            description="Decisions.",
        )
        check_in = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Check-In",
        )
        legacy = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Legacy",
            description="Archived topics.",
        )
        legacy.is_active = False
        legacy.save(update_fields=["is_active"])

        # Reorder (canonical service) so the canonical order differs
        # from insertion order.
        reorder_series_sections(
            meeting_series=self.series,
            actor=self.alex,
            section_ids=[check_in.pk, legacy.pk, top.pk],
        )

        self.login(self.chris)
        response = self.client.get(_export_url(self.series))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json(),
            {
                "schemaVersion": 1,
                "sections": [
                    {
                        "name": "Check-In",
                        "description": "",
                        "isActive": True,
                    },
                    {
                        "name": "Legacy",
                        "description": "Archived topics.",
                        "isActive": False,
                    },
                    {
                        "name": "TOPs",
                        "description": "Decisions.",
                        "isActive": True,
                    },
                ],
            },
        )

    def test_export_order_matches_canonical_sections_order(self):
        sections = [
            create_series_section(
                meeting_series=self.series,
                actor=self.alex,
                name=name,
            )
            for name in ("Alpha", "Beta", "Gamma", "Delta")
        ]
        alpha, beta, gamma, delta = sections
        reorder_series_sections(
            meeting_series=self.series,
            actor=self.alex,
            section_ids=[beta.pk, delta.pk, alpha.pk, gamma.pk],
        )

        self.login(self.chris)
        export = self.client.get(_export_url(self.series))
        listing = self.client.get(
            f"/api/meeting-series/{self.series.pk}/sections/",
        )

        self.assertEqual(
            [item["name"] for item in export.json()["sections"]],
            [item["name"] for item in listing.json()],
        )

    def test_empty_agenda_exports_empty_section_list(self):
        self.login(self.chris)
        response = self.client.get(_export_url(self.series))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json(),
            {"schemaVersion": 1, "sections": []},
        )

    def test_export_is_deterministic(self):
        create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Check-In",
        )
        self.login(self.chris)

        first = self.client.get(_export_url(self.series))
        second = self.client.get(_export_url(self.series))

        self.assertEqual(first.content, second.content)

    # ── Content type / attachment filename ───────────────────────

    def test_content_type_and_attachment_filename(self):
        self.login(self.chris)
        response = self.client.get(_export_url(self.series))

        self.assertEqual(
            response["Content-Type"],
            "application/json",
        )
        self.assertEqual(
            response["Content-Disposition"],
            'attachment; filename="fg-weekly.json"',
        )

    def test_attachment_filename_is_derived_safely_from_title(self):
        series = MeetingSeries.objects.create(
            research_group=self.group,
            title='Weekly / Sync; x=1 "quotes"',
            created_by=self.alex,
        )
        self.login(self.chris)

        response = self.client.get(_export_url(series))

        self.assertEqual(
            response["Content-Disposition"],
            f'attachment; filename="{slugify(series.title)}.json"',
        )

    def test_attachment_filename_falls_back_for_unsluggable_title(self):
        series = MeetingSeries.objects.create(
            research_group=self.group,
            title="🚀",
            created_by=self.alex,
        )
        self.login(self.chris)

        response = self.client.get(_export_url(series))

        self.assertEqual(
            response["Content-Disposition"],
            'attachment; filename="meeting-template.json"',
        )


class MeetingSeriesAgendaExportScopeApiTest(TestCase):
    """Authorization of the agenda JSON export for project-scoped
    Templates (reuses the canonical MeetingSeries read rule)."""

    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="export-scope-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="export-scope-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="export-scope-maria", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="export-scope-laura", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Export Scope Group", created_by=self.alex,
        )
        for user in (self.alex, self.chris, self.maria, self.laura):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

        self.project = create_project(
            research_group=self.group,
            creator=self.alex,
            name="Private Project",
        )
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.chris,
            role=ProjectMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project,
            actor=self.alex,
            target_user=self.laura,
            role=ProjectMembership.Role.VIEWER,
        )

        self.series = MeetingSeries.objects.create(
            research_group=self.group,
            scope=MeetingSeries.Scope.PROJECT,
            project=self.project,
            title="Private Weekly",
            created_by=self.alex,
        )
        create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Private section",
        )

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def test_project_owner_can_export(self):
        self.login(self.alex)
        response = self.client.get(_export_url(self.series))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [item["name"] for item in response.json()["sections"]],
            ["Private section"],
        )

    def test_project_member_can_export(self):
        self.login(self.chris)
        response = self.client.get(_export_url(self.series))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_project_viewer_can_export(self):
        self.login(self.laura)
        response = self.client.get(_export_url(self.series))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_group_member_without_project_membership_gets_404(self):
        self.login(self.maria)
        response = self.client.get(_export_url(self.series))

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(),
            {"error": "Meeting series not found"},
        )
        self.assertNotIn("Private section", str(response.content))
        self.assertNotIn("Private Weekly", str(response.content))

    def test_other_project_membership_does_not_authorize(self):
        # maria owns another Project in the same group but has NO
        # membership in this private project.
        create_project(
            research_group=self.group,
            creator=self.maria,
            name="Other Private Project",
        )
        self.login(self.maria)

        response = self.client.get(_export_url(self.series))

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertNotIn("Private section", str(response.content))

    def test_archived_project_template_stays_readable(self):
        archive_project(project=self.project, actor=self.alex)
        self.login(self.chris)

        response = self.client.get(_export_url(self.series))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["schemaVersion"], 1)
