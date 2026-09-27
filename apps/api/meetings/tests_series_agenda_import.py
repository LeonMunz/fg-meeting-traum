"""API + domain tests for the MeetingSeries agenda JSON import.

Contract under test:
``POST /api/meeting-series/{series_id}/agenda-import.json``
- version-1 portable agenda document (same shape as the export),
- strict validation (exact fields, exact types, no partial writes),
- atomic REPLACEMENT of the Template's complete editable Section set
  (contiguous positions from 0; active AND inactive preserved; an
  empty list clears the agenda),
- canonical scoped Template write authorization (non-leaking 404 /
  existing write-forbidden 403),
- snapshot isolation: existing occurrences are unchanged, a new
  occurrence snapshots the imported active Sections only,
- concurrency serialized on the Template row lock.
"""

import json
import threading
from datetime import date, time as dt_time, timedelta

from django.contrib.auth import get_user_model
from django.db import connection as db_connection
from django.db import transaction
from django.utils import timezone
from django.test import TestCase, TransactionTestCase
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

from .models import (
    Meeting,
    MeetingRecurrence,
    MeetingSection,
    MeetingSeries,
    MeetingSeriesSection,
)
from .services import (
    MeetingDomainError,
    create_meeting_from_series,
    create_meeting_recurrence,
    create_series_section,
    reorder_series_sections,
    replace_series_sections,
)


User = get_user_model()


def _import_url(series):
    return f"/api/meeting-series/{series.pk}/agenda-import.json"


def _export_url(series):
    return f"/api/meeting-series/{series.pk}/agenda-export.json"


def _document(sections):
    """Build a version-1 portable agenda document."""
    return {
        "schemaVersion": 1,
        "sections": [
            {
                "name": name,
                "description": description,
                "isActive": is_active,
            }
            for name, description, is_active in sections
        ],
    }


def _section_state(series):
    """(name, description, position, isActive) in canonical order."""
    return [
        (
            s.name,
            s.description,
            s.position,
            s.is_active,
        )
        for s in MeetingSeriesSection.objects.filter(
            meeting_series=series
        ).order_by("position", "id")
    ]


class MeetingSeriesAgendaImportDomainTest(TestCase):
    """Service-boundary behavior of the atomic replacement."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="imp-dom-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="imp-dom-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="imp-dom-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Import Domain Group", created_by=self.alex,
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
            created_by=self.alex,
        )
        create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Old A",
            description="Old description.",
        )
        old_b = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Old B",
        )
        old_b.is_active = False
        old_b.save(update_fields=["is_active"])

    def test_replace_replaces_complete_section_set(self):
        replace_series_sections(
            meeting_series=self.series,
            actor=self.chris,
            sections=[
                {"name": "New 1", "description": "D1", "isActive": True},
                {"name": "New 2", "description": "", "isActive": False},
                {"name": "New 3", "description": "D3", "isActive": True},
            ],
        )

        self.assertEqual(
            _section_state(self.series),
            [
                ("New 1", "D1", 0, True),
                ("New 2", "", 1, False),
                ("New 3", "D3", 2, True),
            ],
        )
        self.assertFalse(
            MeetingSeriesSection.objects.filter(
                meeting_series=self.series,
                name__in=("Old A", "Old B"),
            ).exists()
        )

    def test_replace_preserves_active_and_inactive_entries(self):
        replace_series_sections(
            meeting_series=self.series,
            actor=self.alex,
            sections=[
                {"name": "Active", "description": "", "isActive": True},
                {"name": "Inactive", "description": "", "isActive": False},
            ],
        )

        states = _section_state(self.series)
        self.assertEqual(
            [(name, is_active) for name, _, _, is_active in states],
            [("Active", True), ("Inactive", False)],
        )

    def test_replace_normalizes_name_and_description(self):
        replace_series_sections(
            meeting_series=self.series,
            actor=self.alex,
            sections=[
                {
                    "name": "  Padded  ",
                    "description": "  Padded description  ",
                    "isActive": True,
                },
            ],
        )

        self.assertEqual(
            _section_state(self.series),
            [("Padded", "Padded description", 0, True)],
        )

    def test_replace_allows_duplicate_names(self):
        replace_series_sections(
            meeting_series=self.series,
            actor=self.alex,
            sections=[
                {"name": "Same", "description": "", "isActive": True},
                {"name": "Same", "description": "Other", "isActive": False},
            ],
        )

        self.assertEqual(
            [name for name, _, _, _ in _section_state(self.series)],
            ["Same", "Same"],
        )

    def test_replace_with_empty_list_clears_agenda(self):
        replace_series_sections(
            meeting_series=self.series,
            actor=self.alex,
            sections=[],
        )

        self.assertEqual(_section_state(self.series), [])

    def test_replace_requires_scoped_write_access(self):
        before = _section_state(self.series)

        with self.assertRaises(MeetingDomainError):
            replace_series_sections(
                meeting_series=self.series,
                actor=self.maria,  # not a Research Group member
                sections=[
                    {"name": "Hacked", "description": "", "isActive": True},
                ],
            )

        self.assertEqual(_section_state(self.series), before)

    def test_failed_replace_leaves_prior_sections_unchanged(self):
        before = _section_state(self.series)

        with self.assertRaises(MeetingDomainError):
            replace_series_sections(
                meeting_series=self.series,
                actor=self.alex,
                sections=[
                    {"name": "Valid", "description": "", "isActive": True},
                    {"name": "   ", "description": "", "isActive": True},
                ],
            )

        self.assertEqual(_section_state(self.series), before)

    def test_replace_rejects_invalid_entries(self):
        invalid_docs = [
            # entry not an object
            [[{"name": 1}]],
            # missing field
            [[{"name": "A", "description": ""}]],
            # wrong types
            [
                [{"name": "A", "description": "", "isActive": "true"}],
                [{"name": 1, "description": "", "isActive": True}],
                [{"name": "A", "description": 7, "isActive": True}],
            ],
            # overlong name
            [[{"name": "x" * 256, "description": "", "isActive": True}]],
        ]
        before = _section_state(self.series)

        for doc in invalid_docs:
            with self.subTest(doc=doc):
                with self.assertRaises(MeetingDomainError):
                    replace_series_sections(
                        meeting_series=self.series,
                        actor=self.alex,
                        sections=doc[0],
                    )

        self.assertEqual(_section_state(self.series), before)


class MeetingSeriesAgendaImportApiTest(TestCase):
    """HTTP contract of the agenda JSON import (group-scoped)."""

    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="imp-api-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="imp-api-chris", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="imp-api-maria", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Import API Group", created_by=self.alex,
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
        create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Old A",
            description="Old description.",
        )
        old_b = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Old B",
        )
        old_b.is_active = False
        old_b.save(update_fields=["is_active"])

    def login(self, user):
        self.client.logout()
        self.client.force_login(user)

    def post_import(self, payload, raw=None):
        if raw is not None:
            return self.client.post(
                _import_url(self.series),
                raw,
                content_type="application/json",
            )
        return self.client.post(
            _import_url(self.series),
            payload,
            format="json",
        )

    # ── Authentication / authorization ───────────────────────────

    def test_authentication_is_required(self):
        response = self.post_import(_document([]))
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_group_member_can_import(self):
        self.login(self.chris)
        response = self.post_import(
            _document([("Check-In", "Round.", True)]),
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json(),
            {
                "schemaVersion": 1,
                "sections": [
                    {"name": "Check-In", "description": "Round.",
                     "isActive": True},
                ],
            },
        )
        self.assertEqual(
            _section_state(self.series),
            [("Check-In", "Round.", 0, True)],
        )

    def test_unknown_series_returns_404(self):
        self.login(self.chris)
        response = self.client.post(
            "/api/meeting-series/999999/agenda-import.json",
            _document([]),
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(),
            {"error": "Meeting series not found"},
        )

    def test_out_of_scope_access_is_non_leaking_404(self):
        self.login(self.maria)  # not a Research Group member

        response = self.post_import(_document([]))

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(),
            {"error": "Meeting series not found"},
        )
        self.assertNotIn("Old A", str(response.content))
        self.assertNotIn("FG Weekly", str(response.content))

    def test_write_methods_other_than_post_are_rejected(self):
        self.login(self.chris)
        before = _section_state(self.series)
        for method in ("get", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    _import_url(self.series),
                )
                self.assertEqual(
                    response.status_code,
                    status.HTTP_405_METHOD_NOT_ALLOWED,
                )
        self.assertEqual(_section_state(self.series), before)

    # ── Validation (400, no mutation) ────────────────────────────

    def _assert_invalid(self, payload, raw=None, fragment=None):
        self.login(self.chris)
        before = _section_state(self.series)
        response = self.post_import(payload, raw=raw)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        if fragment is not None:
            self.assertIn(fragment, str(response.json()))
        self.assertEqual(_section_state(self.series), before)

    def test_malformed_json_rejected(self):
        self._assert_invalid(None, raw="{not json")

    def test_non_object_top_level_rejected(self):
        self._assert_invalid(None, raw=json.dumps([1, 2, 3]))

    def test_missing_top_level_fields_rejected(self):
        self._assert_invalid(
            {"sections": []},
            fragment="schemaVersion",
        )
        self._assert_invalid(
            {"schemaVersion": 1},
            fragment="sections",
        )

    def test_extra_top_level_fields_rejected(self):
        self._assert_invalid(
            {
                "schemaVersion": 1,
                "sections": [],
                "templateTitle": "Not part of the document",
            },
            fragment="templateTitle",
        )

    def test_unsupported_schema_version_rejected(self):
        for version in (0, 2, -1):
            with self.subTest(version=version):
                doc = _document([])
                doc["schemaVersion"] = version
                self._assert_invalid(
                    doc,
                    fragment="version",
                )

    def test_schema_version_wrong_type_rejected(self):
        doc = _document([])
        doc["schemaVersion"] = "1"
        self._assert_invalid(doc, fragment="schemaVersion")

    def test_sections_must_be_a_list(self):
        self._assert_invalid(
            {"schemaVersion": 1, "sections": {"name": "A"}},
            fragment="sections",
        )
        self._assert_invalid(
            {"schemaVersion": 1, "sections": "A"},
            fragment="sections",
        )

    def test_entry_must_be_an_object(self):
        self._assert_invalid(
            {"schemaVersion": 1, "sections": ["A"]},
            fragment="must be an object",
        )

    def test_entry_missing_field_rejected(self):
        self._assert_invalid(
            _document_with([{"name": "A", "description": ""}]),
            fragment="isActive",
        )
        self._assert_invalid(
            _document_with([{"name": "A", "isActive": True}]),
            fragment="description",
        )

    def test_entry_extra_field_rejected(self):
        self._assert_invalid(
            _document_with([
                {
                    "name": "A",
                    "description": "",
                    "isActive": True,
                    "position": 9,
                },
            ]),
            fragment="position",
        )

    def test_entry_wrong_types_rejected(self):
        self._assert_invalid(
            _document_with([{"name": 1, "description": "",
                             "isActive": True}]),
            fragment="'name'",
        )
        self._assert_invalid(
            _document_with([{"name": "A", "description": 7,
                             "isActive": True}]),
            fragment="'description'",
        )
        self._assert_invalid(
            _document_with([{"name": "A", "description": "",
                             "isActive": "true"}]),
            fragment="'isActive'",
        )

    def test_blank_name_rejected(self):
        self._assert_invalid(
            _document([("   ", "", True)]),
            fragment="blank",
        )

    def test_overlong_name_rejected(self):
        self._assert_invalid(
            _document([("x" * 256, "", True)]),
            fragment="255",
        )

    def test_name_at_limit_is_accepted(self):
        self.login(self.chris)
        response = self.post_import(_document([("x" * 255, "", True)]))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            _section_state(self.series),
            [("x" * 255, "", 0, True)],
        )

    def test_invalid_document_with_valid_first_entry_no_partial_write(self):
        """A valid entry plus an invalid one must not delete/create
        anything — no partial replacement."""
        self.login(self.chris)
        before = _section_state(self.series)

        response = self.post_import(
            _document_with([
                {"name": "New", "description": "", "isActive": True},
                {"name": "", "description": "", "isActive": True},
            ]),
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(_section_state(self.series), before)

    # ── Replacement semantics ────────────────────────────────────

    def test_import_returns_canonical_imported_document(self):
        self.login(self.alex)
        response = self.post_import(
            _document([
                ("  Check-In  ", "  Round  ", True),
                ("Legacy", "", False),
                ("TOPs", "Decisions.", True),
            ]),
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json(),
            {
                "schemaVersion": 1,
                "sections": [
                    {"name": "Check-In", "description": "Round",
                     "isActive": True},
                    {"name": "Legacy", "description": "",
                     "isActive": False},
                    {"name": "TOPs", "description": "Decisions.",
                     "isActive": True},
                ],
            },
        )

    def test_import_sets_contiguous_positions_from_zero(self):
        self.login(self.alex)
        response = self.post_import(
            _document([("A", "", True), ("B", "", True), ("C", "", True)]),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        listing = self.client.get(
            f"/api/meeting-series/{self.series.pk}/sections/",
        )
        self.assertEqual(
            [(item["name"], item["position"]) for item in listing.json()],
            [("A", 0), ("B", 1), ("C", 2)],
        )

    def test_import_preserves_active_and_inactive(self):
        self.login(self.alex)
        response = self.post_import(
            _document([("Active", "", True), ("Inactive", "", False)]),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.assertEqual(
            _section_state(self.series),
            [("Active", "", 0, True), ("Inactive", "", 1, False)],
        )

    def test_import_allows_duplicate_names(self):
        self.login(self.alex)
        response = self.post_import(
            _document([("Same", "", True), ("Same", "Other", False)]),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            _section_state(self.series),
            [("Same", "", 0, True), ("Same", "Other", 1, False)],
        )

    def test_empty_import_clears_agenda(self):
        self.login(self.alex)
        response = self.post_import(_document([]))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json(),
            {"schemaVersion": 1, "sections": []},
        )
        self.assertEqual(_section_state(self.series), [])

    def test_import_does_not_mutate_template_metadata(self):
        series = self.series
        self.login(self.alex)

        response = self.post_import(
            _document([("New", "", True)]),
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        series.refresh_from_db()
        self.assertEqual(series.title, "FG Weekly")
        self.assertEqual(series.description, "Weekly meeting.")
        self.assertEqual(series.scope, MeetingSeries.Scope.GROUP)
        self.assertIsNone(series.project_id)
        self.assertFalse(series.is_archived)
        self.assertEqual(series.created_by_id, self.alex.pk)

    # ── Round trip ───────────────────────────────────────────────

    def test_export_source_import_target_export_target_semantic_equality(self):
        # Source with reordered, mixed active/inactive sections.
        source = MeetingSeries.objects.create(
            research_group=self.group,
            title="Source Weekly",
            created_by=self.alex,
        )
        top = create_series_section(
            meeting_series=source, actor=self.alex,
            name="TOPs", description="Decisions.",
        )
        check_in = create_series_section(
            meeting_series=source, actor=self.alex,
            name="Check-In", description="Round.",
        )
        legacy = create_series_section(
            meeting_series=source, actor=self.alex,
            name="Legacy", description="Archived.",
        )
        legacy.is_active = False
        legacy.save(update_fields=["is_active"])
        reorder_series_sections(
            meeting_series=source,
            actor=self.alex,
            section_ids=[check_in.pk, legacy.pk, top.pk],
        )

        # Target with a different prior agenda.
        target = MeetingSeries.objects.create(
            research_group=self.group,
            title="Target Weekly",
            created_by=self.alex,
        )
        create_series_section(
            meeting_series=target, actor=self.alex, name="Stale",
        )

        self.login(self.chris)

        source_doc = self.client.get(_export_url(source)).json()
        self.assertEqual(source_doc["schemaVersion"], 1)

        import_response = self.client.post(
            _import_url(target), source_doc, format="json",
        )
        self.assertEqual(import_response.status_code, status.HTTP_200_OK)

        # The import response equals the source document (the
        # canonical imported document), and the target's export
        # round-trips semantically.
        self.assertEqual(import_response.json(), source_doc)
        target_doc = self.client.get(_export_url(target)).json()
        self.assertEqual(target_doc, source_doc)


def _document_with(entries):
    return {"schemaVersion": 1, "sections": entries}


class MeetingSeriesAgendaImportScopeApiTest(TestCase):
    """Authorization of the agenda JSON import for project-scoped
    Templates (canonical scoped Template write rule)."""

    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="imp-scope-alex", password="Pass1!",
        )
        self.chris = User.objects.create_user(
            username="imp-scope-chris", password="Pass1!",
        )
        self.laura = User.objects.create_user(
            username="imp-scope-laura", password="Pass1!",
        )
        self.maria = User.objects.create_user(
            username="imp-scope-maria", password="Pass1!",
        )
        self.outsider = User.objects.create_user(
            username="imp-scope-outsider", password="Pass1!",
        )

        self.group = ResearchGroup.objects.create(
            name="Import Scope Group", created_by=self.alex,
        )
        for user in (self.alex, self.chris, self.laura, self.maria):
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

    def post_as(self, user):
        self.login(user)
        return self.client.post(
            _import_url(self.series),
            _document([("Imported", "", True)]),
            format="json",
        )

    def test_project_owner_can_import(self):
        response = self.post_as(self.alex)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            _section_state(self.series),
            [("Imported", "", 0, True)],
        )

    def test_project_member_can_import(self):
        response = self.post_as(self.chris)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_project_viewer_gets_write_forbidden_without_mutation(self):
        before = _section_state(self.series)
        response = self.post_as(self.laura)

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(
            response.json(),
            {
                "error": (
                    "You do not have permission to modify "
                    "this Project Meeting resource."
                )
            },
        )
        self.assertEqual(_section_state(self.series), before)

    def test_archived_project_gets_write_forbidden_without_mutation(self):
        archive_project(project=self.project, actor=self.alex)
        before = _section_state(self.series)

        for user in (self.alex, self.chris):
            with self.subTest(user=user.username):
                response = self.post_as(user)
                self.assertEqual(
                    response.status_code, status.HTTP_403_FORBIDDEN,
                )

        self.assertEqual(_section_state(self.series), before)

    def test_group_member_without_project_membership_gets_404(self):
        response = self.post_as(self.maria)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(),
            {"error": "Meeting series not found"},
        )
        self.assertNotIn("Private section", str(response.content))
        self.assertNotIn("Private Weekly", str(response.content))

    def test_outsider_gets_404(self):
        response = self.post_as(self.outsider)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertNotIn("Private section", str(response.content))

    def test_unknown_template_gets_404(self):
        self.login(self.alex)
        response = self.client.post(
            "/api/meeting-series/999999/agenda-import.json",
            _document([]),
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(),
            {"error": "Meeting series not found"},
        )

    def test_anonymous_gets_401(self):
        self.client.logout()
        response = self.client.post(
            _import_url(self.series),
            _document([]),
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)


class MeetingSeriesAgendaImportSnapshotTest(TestCase):
    """Snapshot isolation: existing occurrences and recurrence rows
    are unchanged by an import; a new occurrence snapshots only the
    imported active Sections."""

    def setUp(self):
        self.client = APIClient()

        self.alex = User.objects.create_user(
            username="imp-snap-alex", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Import Snapshot Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )

        self.series = MeetingSeries.objects.create(
            research_group=self.group,
            title="FG Weekly",
            created_by=self.alex,
        )
        create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Check-In",
            description="Round.",
        )
        create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="TOPs",
        )
        legacy = create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Legacy",
        )
        legacy.is_active = False
        legacy.save(update_fields=["is_active"])

        self.scheduled_at = (
            timezone.now().replace(microsecond=0) + timedelta(days=1)
        )
        self.meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at,
        )
        self.recurrence = create_meeting_recurrence(
            research_group=self.group,
            actor=self.alex,
            meeting_series=self.series,
            title="Weekly Recurrence",
            frequency="daily",
            interval=1,
            start_date=date(2026, 1, 5),
            local_time=dt_time(9, 30),
            timezone_name="Europe/Berlin",
        )

    def _import(self, sections):
        self.client.force_login(self.alex)
        return self.client.post(
            _import_url(self.series),
            _document(sections),
            format="json",
        )

    def test_existing_meeting_snapshot_is_unchanged_after_import(self):
        meeting_sections = list(
            MeetingSection.objects.filter(
                meeting=self.meeting,
            ).order_by("position", "id")
        )
        self.assertEqual(
            [(s.name, s.description, s.position, s.is_visible)
             for s in meeting_sections],
            [
                ("Check-In", "Round.", 0, True),
                ("TOPs", "", 1, True),
            ],
        )
        original_source_ids = {
            s.source_series_section_id for s in meeting_sections
        }
        meeting_title = self.meeting.title
        meeting_scheduled_at = self.meeting.scheduled_at

        response = self._import([
            ("New 1", "Fresh.", True),
            ("New 2", "", False),
            ("New 3", "", True),
        ])
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # The snapshot rows survive with unchanged content; the
        # provenance pointers to the replaced Template Sections are
        # cleared (SET_NULL) exactly like a Template deletion.
        updated = list(
            MeetingSection.objects.filter(
                meeting=self.meeting,
            ).order_by("position", "id")
        )
        self.assertEqual(len(updated), len(meeting_sections))
        self.assertEqual(
            [(s.name, s.description, s.position, s.is_visible)
             for s in updated],
            [
                ("Check-In", "Round.", 0, True),
                ("TOPs", "", 1, True),
            ],
        )
        for section in updated:
            self.assertIsNone(section.source_series_section_id)
        self.assertFalse(
            MeetingSeriesSection.objects.filter(
                pk__in=original_source_ids,
            ).exists()
        )

        self.meeting.refresh_from_db()
        self.assertEqual(self.meeting.title, meeting_title)
        self.assertEqual(
            self.meeting.scheduled_at, meeting_scheduled_at,
        )
        self.assertEqual(self.meeting.series_id, self.series.pk)

    def test_new_occurrence_snapshots_imported_active_sections_only(self):
        response = self._import([
            ("New 1", "Fresh.", True),
            ("New 2", "", False),
            ("New 3", "", True),
        ])
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        new_meeting = create_meeting_from_series(
            meeting_series=self.series,
            actor=self.alex,
            scheduled_at=self.scheduled_at + timedelta(days=7),
        )

        sections = list(
            MeetingSection.objects.filter(
                meeting=new_meeting,
            ).order_by("position", "id")
        )
        self.assertEqual(
            [(s.name, s.description, s.position, s.is_visible)
             for s in sections],
            [
                ("New 1", "Fresh.", 0, True),
                ("New 3", "", 1, True),
            ],
        )
        for section in sections:
            self.assertEqual(
                section.source_series_section.meeting_series_id,
                self.series.pk,
            )

        # The pre-existing Meeting is still untouched.
        old_names = {
            s.name
            for s in MeetingSection.objects.filter(meeting=self.meeting)
        }
        self.assertEqual(old_names, {"Check-In", "TOPs"})

    def test_existing_recurrence_row_is_unchanged(self):
        series_id_before = self.recurrence.series_id
        response = self._import([
            ("New 1", "", True),
        ])
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.recurrence.refresh_from_db()
        self.assertEqual(self.recurrence.series_id, series_id_before)
        self.assertEqual(self.recurrence.series_id, self.series.pk)
        self.assertEqual(self.recurrence.title, "Weekly Recurrence")
        self.assertEqual(self.recurrence.frequency, "daily")
        self.assertEqual(MeetingRecurrence.objects.count(), 1)
        self.assertEqual(
            Meeting.objects.filter(series=self.series).count(),
            1,  # only the pre-existing Meeting
        )


class MeetingSeriesAgendaImportConcurrencyTest(TransactionTestCase):
    """Concurrent replacements serialize on the Template row lock
    (real PostgreSQL): the final state is always exactly ONE complete
    imported set, never a partial mix."""

    def setUp(self):
        self.alex = User.objects.create_user(
            username="imp-race-alex", password="Pass1!",
        )
        self.group = ResearchGroup.objects.create(
            name="Import Race Group", created_by=self.alex,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.alex,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        self.series = MeetingSeries.objects.create(
            research_group=self.group,
            title="Race Template",
            created_by=self.alex,
        )
        create_series_section(
            meeting_series=self.series,
            actor=self.alex,
            name="Seed",
        )

    def _worker(self, results, errors, barrier, doc):
        def run():
            barrier.wait()
            try:
                results["sections"] = replace_series_sections(
                    meeting_series=self.series,
                    actor=self.alex,
                    sections=doc,
                )
            except Exception as exc:
                errors["error"] = exc
            finally:
                db_connection.close()

        return run

    def test_concurrent_replacements_never_mix(self):
        doc_a = [
            {"name": "A1", "description": "", "isActive": True},
            {"name": "A2", "description": "", "isActive": False},
        ]
        doc_b = [
            {"name": "B1", "description": "", "isActive": True},
            {"name": "B2", "description": "", "isActive": True},
            {"name": "B3", "description": "", "isActive": False},
        ]
        results, errors = {}, {}
        barrier = threading.Barrier(2)
        threads = [
            threading.Thread(
                target=self._worker(results, errors, barrier, doc),
            )
            for doc in (doc_a, doc_b)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        db_connection.close()

        self.assertEqual(errors, {})
        final = [
            (s.name, s.is_active)
            for s in MeetingSeriesSection.objects.filter(
                meeting_series=self.series,
            ).order_by("position", "id")
        ]
        self.assertIn(
            final,
            [
                [("A1", True), ("A2", False)],
                [("B1", True), ("B2", True), ("B3", False)],
            ],
        )
        positions = [
            s.position
            for s in MeetingSeriesSection.objects.filter(
                meeting_series=self.series,
            ).order_by("position", "id")
        ]
        self.assertEqual(positions, list(range(len(final))))

    def test_later_replacement_sees_committed_state(self):
        """A replacement that reaches the row lock only AFTER a
        concurrent transaction committed operates on the committed
        state: the serialized loser fully replaces the winner's set,
        so the final state is the loser's complete document."""
        winner_locked = threading.Event()
        release_winner = threading.Event()

        def winner():
            with transaction.atomic():
                MeetingSeries.objects.select_for_update().get(
                    pk=self.series.pk,
                )
                winner_locked.set()
                # A racer's in-flight committed replacement, held on
                # the same Template row lock.
                self.series.series_sections.all().delete()
                MeetingSeriesSection.objects.create(
                    meeting_series=self.series,
                    name="Winner",
                    position=0,
                    is_active=True,
                )
                release_winner.wait(timeout=30)
            db_connection.close()

        loser_result = {}
        loser_errors = {}

        def loser():
            try:
                loser_result["sections"] = replace_series_sections(
                    meeting_series=self.series,
                    actor=self.alex,
                    sections=[
                        {"name": "L1", "description": "",
                         "isActive": True},
                        {"name": "L2", "description": "",
                         "isActive": False},
                    ],
                )
            except Exception as exc:
                loser_errors["error"] = exc
            finally:
                db_connection.close()

        winner_thread = threading.Thread(target=winner)
        winner_thread.start()
        self.assertTrue(winner_locked.wait(timeout=30))

        loser_thread = threading.Thread(target=loser)
        loser_thread.start()
        # Give the loser time to block on the Template row lock while
        # the winner's transaction is still open.
        import time as time_module
        time_module.sleep(0.25)
        release_winner.set()
        loser_thread.join()
        winner_thread.join()
        db_connection.close()

        self.assertEqual(loser_errors, {})
        final = [
            (s.name, s.is_active)
            for s in MeetingSeriesSection.objects.filter(
                meeting_series=self.series,
            ).order_by("position", "id")
        ]
        self.assertEqual(
            final,
            [("L1", True), ("L2", False)],
        )
