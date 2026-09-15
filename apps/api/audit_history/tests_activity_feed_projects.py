"""Behavioral API tests for the Project Activity feed slice.

GET /api/activity/ now projects the pre-existing Project audit events
(docs/domain/activity.md §4b) with READ-time authorization:

- A Project event is visible iff the requester can read the affected
  Project TODAY through the canonical Project read boundary (current
  ProjectMembership owner/member/viewer + current
  ResearchGroupMembership) — the identical rule of Project reads
  (resolve_project_scope / PROJECT_READ).
- Research Group membership/admin status alone never grants Project
  Activity.
- Archiving is not deletion: an archived Project keeps normal read
  authorization; the archive state itself neither grants nor revokes
  anything.
- project.deleted fails closed: the event is recorded before the
  Project row is deleted, its ``project`` FK is nulled by the
  deletion, and it stays durably persisted but is NEVER returned —
  the retained research_group scope, actor, subject user, and payload
  grant nothing.
- subject_user is event context, never authorization, never
  fabricated, and serialized only through the public user-ref
  representation.

Setup reuses the standard Work Item scenario
(work_items.tests_api._setup_test_data):

FG Example group:
- alex:  group admin, Paper XYZ owner
- chris: group member, Paper XYZ member
- maria: group member, NO Paper XYZ membership
- laura: group member, Paper XYZ viewer
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from audit_history.models import AuditEvent
from meetings.services import create_meeting
from projects.models import Project, ProjectMembership
from projects.services import (
    ProjectAuditEventType,
    add_project_membership,
    archive_project,
    change_membership_role,
    create_project,
    restore_project,
)
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from research_groups.services import (
    ResearchGroupProjectOffboardingResolution,
    offboard_research_group_member,
)
from work_items.tests_api import _setup_test_data

User = get_user_model()

FEED_URL = "/api/activity/"

PROJECT_EVENT_TYPES = frozenset(
    {
        ProjectAuditEventType.MEMBER_ASSIGNMENTS_RESOLVED,
        ProjectAuditEventType.OWNERSHIP_RESOLVED_FOR_OFFBOARDING,
        ProjectAuditEventType.ARCHIVED,
        ProjectAuditEventType.RESTORED,
        ProjectAuditEventType.DELETED,
    }
)


class _FeedClientMixin:
    """APITestCase-based feed access with force_login."""

    def _login(self, user):
        self.client.force_login(user)

    def _feed(self, user, **params):
        self._login(user)
        return self.client.get(FEED_URL, params or None)

    def _feed_entries(self, user, **params):
        response = self._feed(user, **params)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _feed_types(self, user, **params):
        return [e["eventType"] for e in self._feed_entries(user, **params)]


# ── Visibility ──


class ProjectFeedVisibilityTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_authorized_user_sees_project_activity(self):
        paper_xyz = self.data["paper_xyz"]

        archive_project(project=paper_xyz, actor=self.data["alex"])

        # laura: Paper XYZ viewer — canonical Project read access.
        entries = self._feed_entries(self.data["laura"])
        archived = [
            e for e in entries
            if e["eventType"] == ProjectAuditEventType.ARCHIVED
        ]
        self.assertEqual(len(archived), 1)
        entry = archived[0]
        self.assertEqual(entry["projectId"], paper_xyz.pk)
        self.assertEqual(entry["projectName"], "Paper XYZ")
        self.assertEqual(
            entry["researchGroupId"], self.data["group"].pk,
        )
        self.assertEqual(entry["researchGroupName"], "FG Example")
        self.assertEqual(entry["actor"]["id"], self.data["alex"].pk)
        self.assertEqual(entry["actor"]["username"], "alex")
        # The archive is an operation about the Project itself: no
        # Work Item / Meeting identity, no subject user.
        self.assertIsNone(entry["workItemId"])
        self.assertIsNone(entry["meetingId"])
        self.assertIsNone(entry["subjectUser"])
        # Structured payload, allowlisted keys only.
        self.assertEqual(entry["changes"], {"status": "active"})

    def test_multiple_project_event_types_appear(self):
        paper_xyz = self.data["paper_xyz"]
        chris = self.data["chris"]

        # 1. project.member_assignments_resolved: chris (member,
        #    assigned to the existing Work Item) becomes viewer with
        #    the assignments resolved through the canonical service.
        membership = ProjectMembership.objects.get(
            project=paper_xyz, user=chris,
        )
        change_membership_role(
            membership=membership,
            actor=self.data["alex"],
            new_role=ProjectMembership.Role.VIEWER,
            assignment_resolution="unassign",
        )
        # 2. + 3. archive / restore.
        archive_project(project=paper_xyz, actor=self.data["alex"])
        restore_project(project=paper_xyz, actor=self.data["alex"])

        types = set(self._feed_types(self.data["alex"]))
        self.assertEqual(
            types & PROJECT_EVENT_TYPES,
            {
                ProjectAuditEventType.MEMBER_ASSIGNMENTS_RESOLVED,
                ProjectAuditEventType.ARCHIVED,
                ProjectAuditEventType.RESTORED,
            },
        )

    def test_project_events_share_global_ordering_with_meeting_and_work_item(self):
        paper_xyz = self.data["paper_xyz"]
        alex = self.data["alex"]

        # The fixture already carries one work_item.created event
        # (Paper XYZ). Add one Project event and one Meeting event.
        archive_project(project=paper_xyz, actor=alex)
        create_meeting(
            research_group=self.data["group"],
            actor=alex,
            title="Feed ordering meeting",
            scheduled_at=timezone.now() + timedelta(days=30),
        )

        # alex can read everything in this scenario (owner + meeting
        # creator), so the feed must equal the full deterministic
        # reverse-chronological order over the UNION.
        expected = list(
            AuditEvent.objects
            .order_by("-created_at", "-id")
            .values_list("id", flat=True)
        )
        entries = self._feed_entries(alex)
        self.assertEqual([e["id"] for e in entries], expected)

        # The Project entry is explicitly identifiable: machine
        # eventType + projectId, with the other identity pairs null.
        project_entries = [
            e for e in entries
            if e["eventType"] == ProjectAuditEventType.ARCHIVED
        ]
        self.assertEqual(len(project_entries), 1)
        entry = project_entries[0]
        self.assertEqual(entry["projectId"], paper_xyz.pk)
        self.assertIsNone(entry["workItemId"])
        self.assertIsNone(entry["workItemTitle"])
        self.assertIsNone(entry["meetingId"])
        self.assertIsNone(entry["meetingTitle"])


# ── Authorization (canonical Project read rule, per role) ──


class ProjectFeedAuthorizationTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_all_project_read_roles_see_project_activity(self):
        # Every existing Project role that grants PROJECT_READ
        # (owner / member / viewer) sees the Project Activity.
        archive_project(
            project=self.data["paper_xyz"], actor=self.data["alex"],
        )

        for username in ("alex", "chris", "laura"):
            with self.subTest(username=username):
                self.assertIn(
                    ProjectAuditEventType.ARCHIVED,
                    self._feed_types(self.data[username]),
                )

    def test_user_without_project_read_access_sees_no_project_events(self):
        # maria: Research Group member, NO Paper XYZ membership.
        archive_project(
            project=self.data["paper_xyz"], actor=self.data["alex"],
        )
        restore_project(
            project=self.data["paper_xyz"], actor=self.data["alex"],
        )

        self.assertEqual(self._feed_entries(self.data["maria"]), [])

    def test_group_admin_without_project_membership_gets_no_project_activity(self):
        # alex is the Research Group ADMIN. A private Project with
        # rich Project Activity that alex has no membership in must
        # stay invisible — admin status alone never grants it, and
        # nothing (ids, names, actor, subject, payload) may leak.
        secret_project = create_project(
            research_group=self.data["group"],
            creator=self.data["chris"],
            name="Secret Beta",
        )
        archive_project(project=secret_project, actor=self.data["chris"])
        restore_project(project=secret_project, actor=self.data["chris"])

        body = self._feed_entries(self.data["alex"])
        self.assertNotIn(
            secret_project.pk, [e["projectId"] for e in body],
        )
        self.assertFalse(
            set(self._feed_types(self.data["alex"]))
            & PROJECT_EVENT_TYPES,
        )
        rendered = str(body)
        self.assertNotIn("Secret Beta", rendered)
        self.assertNotIn("chris", rendered)


# ── Archived Projects: normal authorization, not deletion ──


class ProjectFeedArchivedTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_archived_event_remains_visible_to_current_reader(self):
        # Archiving is not deletion: a user who retains canonical
        # Project read access still sees the project.archived event
        # while the Project is archived.
        archive_project(
            project=self.data["paper_xyz"], actor=self.data["alex"],
        )
        self.assertIsNotNone(
            Project.objects
            .get(pk=self.data["paper_xyz"].pk)
            .archived_at
        )

        self.assertIn(
            ProjectAuditEventType.ARCHIVED,
            self._feed_types(self.data["laura"]),
        )

    def test_archive_state_does_not_bypass_or_revoke_authorization(self):
        archive_project(
            project=self.data["paper_xyz"], actor=self.data["alex"],
        )

        # Does not grant: the non-member still sees nothing.
        self.assertEqual(self._feed_entries(self.data["maria"]), [])
        # Does not revoke: the existing reader still sees it.
        self.assertIn(
            ProjectAuditEventType.ARCHIVED,
            self._feed_types(self.data["chris"]),
        )


# ── Access revocation (read-time authorization) ──


class ProjectFeedRevocationTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_membership_removal_removes_project_events_at_read_time(self):
        laura = self.data["laura"]

        # 1. Initially authorized: the historical Project event is
        #    visible to the viewer.
        archive_project(
            project=self.data["paper_xyz"], actor=self.data["alex"],
        )
        self.assertIn(
            ProjectAuditEventType.ARCHIVED,
            self._feed_types(laura),
        )

        # Membership mutations are read-only-blocked while archived;
        # restore through the canonical path first.
        restore_project(
            project=self.data["paper_xyz"], actor=self.data["alex"],
        )

        # 2. Normal domain path: the owner removes laura's
        #    ProjectMembership through the membership API.
        membership = self.data["paper_xyz"].memberships.get(user=laura)
        self._login(self.data["alex"])
        response = self.client.delete(
            f"/api/projects/{self.data['paper_xyz'].pk}/memberships/"
            f"{membership.pk}/",
        )
        self.assertEqual(response.status_code, 200)

        # 3. The same historical event is gone from laura's feed —
        #    while the owner still sees it: read-time authorization.
        self.assertEqual(self._feed_entries(laura), [])
        self.assertIn(
            ProjectAuditEventType.ARCHIVED,
            self._feed_types(self.data["alex"]),
        )


# ── Deleted Projects: durable, but fail closed in the feed ──


class ProjectFeedDeletedTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        # An empty disposable Project (no Work Items) that can be
        # permanently deleted through the canonical path.
        cls.doomed = create_project(
            research_group=cls.data["group"],
            creator=cls.data["alex"],
            name="Doomed Project",
        )

    def test_deleted_project_events_persist_but_never_returned(self):
        alex = self.data["alex"]
        doomed = self.doomed

        archive_project(project=doomed, actor=alex)
        # Sanity: while the Project exists (archived), the event is
        # visible to its owner.
        self.assertIn(
            ProjectAuditEventType.ARCHIVED, self._feed_types(alex),
        )

        # Canonical deletion: archived + empty Project, owner-only.
        self._login(alex)
        response = self.client.delete(f"/api/projects/{doomed.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            Project.objects.filter(pk=doomed.pk).exists()
        )

        # 11. Durable persistence per current audit semantics: both
        #     events survive with the project FK nulled; the deleted
        #     event keeps its flat snapshot.
        deleted = AuditEvent.objects.get(
            event_type=ProjectAuditEventType.DELETED,
            data__projectId=doomed.pk,
        )
        self.assertIsNone(deleted.project_id)
        self.assertEqual(deleted.data["projectName"], "Doomed Project")
        self.assertEqual(deleted.actor_id, alex.pk)
        archived = AuditEvent.objects.filter(
            event_type=ProjectAuditEventType.ARCHIVED,
        ).get()
        self.assertIsNone(archived.project_id)

        # 12. Neither event is returned — not even for alex, who is
        #     the actor, the former owner, and the group admin.
        body = self._feed_entries(alex)
        self.assertNotIn(deleted.pk, [e["id"] for e in body])
        self.assertNotIn(archived.pk, [e["id"] for e in body])
        self.assertNotIn(
            ProjectAuditEventType.DELETED,
            [e["eventType"] for e in body],
        )

        # 13. The retained scope/payload data grants nothing: no
        #     Project id, name, group signal, or existence leak.
        rendered = str(body)
        self.assertNotIn("Doomed Project", rendered)
        self.assertNotIn(doomed.pk, [e["projectId"] for e in body])
        self.assertNotIn(doomed.pk, [e["workItemId"] for e in body])
        self.assertNotIn(doomed.pk, [e["meetingId"] for e in body])
        # A non-member of the deleted Project also sees nothing of it
        # (its membership rows are gone with the Project).
        self.assertEqual(
            [e for e in self._feed_entries(self.data["chris"])
             if "Doomed" in str(e)],
            [],
        )


# ── Offboarding: ownership resolution event + revocation ──


class ProjectFeedOffboardingTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = User.objects.create_user(
            username="feed-p-ob-admin", password="DevPass1!",
        )
        cls.bob = User.objects.create_user(
            username="feed-p-ob-bob", password="DevPass1!",
        )
        cls.erin = User.objects.create_user(
            username="feed-p-ob-erin", password="DevPass1!",
        )
        cls.group = ResearchGroup.objects.create(
            name="Feed Offboard RG", created_by=cls.admin,
        )
        for user, role in (
            (cls.admin, ResearchGroupMembership.Role.ADMIN),
            (cls.bob, ResearchGroupMembership.Role.ADMIN),
            (cls.erin, ResearchGroupMembership.Role.MEMBER),
        ):
            ResearchGroupMembership.objects.create(
                research_group=cls.group, user=user, role=role,
            )
        # bob is the FINAL owner of an active Project; erin is an
        # existing member (eligible ownership replacement).
        cls.project = create_project(
            research_group=cls.group, creator=cls.bob,
            name="Solo Alpha",
        )
        add_project_membership(
            project=cls.project, actor=cls.bob, target_user=cls.erin,
            role=ProjectMembership.Role.MEMBER,
        )

    def test_ownership_event_visible_to_remaining_reader_only(self):
        # Before offboarding: no events, no access for the admin
        # (group admin, NO Project membership).
        self.assertEqual(self._feed_entries(self.erin), [])
        self.assertEqual(self._feed_entries(self.admin), [])

        offboard_research_group_member(
            membership=ResearchGroupMembership.objects.get(
                research_group=self.group, user=self.bob,
            ),
            actor=self.admin,
            project_resolutions=[
                ResearchGroupProjectOffboardingResolution(
                    project_id=self.project.pk,
                    ownership_resolution="transfer",
                    ownership_replacement_user=self.erin,
                ),
            ],
        )

        # erin (now owner, still a reader) sees exactly the
        # ownership event, with the offboarded final owner as
        # subject user (context, not authorization).
        entries = self._feed_entries(self.erin)
        ownership = [
            e for e in entries
            if e["eventType"]
            == ProjectAuditEventType.OWNERSHIP_RESOLVED_FOR_OFFBOARDING
        ]
        self.assertEqual(len(ownership), 1)
        entry = ownership[0]
        self.assertEqual(entry["projectId"], self.project.pk)
        self.assertEqual(entry["projectName"], "Solo Alpha")
        self.assertEqual(entry["actor"]["id"], self.admin.pk)
        self.assertEqual(
            set(entry["changes"].keys()),
            {"resolution", "replacementUserId", "replacementPreviousRole"},
        )
        self.assertEqual(entry["changes"]["resolution"], "transfer")
        self.assertEqual(
            entry["changes"]["replacementUserId"], self.erin.pk,
        )
        self.assertEqual(
            entry["changes"]["replacementPreviousRole"], "member",
        )
        # 14./16. subject_user serialized with the public user-ref
        # representation only.
        self.assertEqual(
            set(entry["subjectUser"].keys()),
            {"id", "username", "firstName", "lastName"},
        )
        self.assertEqual(entry["subjectUser"]["id"], self.bob.pk)
        self.assertEqual(entry["subjectUser"]["username"], "feed-p-ob-bob")

        # The offboarded owner loses access at read time: his feed
        # no longer contains the event about his former Project.
        self.assertEqual(self._feed_entries(self.bob), [])
        # Group admin without Project membership: still nothing.
        self.assertEqual(self._feed_entries(self.admin), [])


# ── subject_user semantics ──


class ProjectFeedSubjectUserTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_subject_user_serialized_with_public_user_ref_only(self):
        paper_xyz = self.data["paper_xyz"]
        chris = self.data["chris"]

        # chris (member) is assigned to the fixture Work Item; making
        # him a viewer with unassignment records
        # project.member_assignments_resolved with subject_user=chris.
        membership = ProjectMembership.objects.get(
            project=paper_xyz, user=chris,
        )
        change_membership_role(
            membership=membership,
            actor=self.data["alex"],
            new_role=ProjectMembership.Role.VIEWER,
            assignment_resolution="unassign",
        )

        entries = self._feed_entries(self.data["alex"])
        resolved = [
            e for e in entries
            if e["eventType"]
            == ProjectAuditEventType.MEMBER_ASSIGNMENTS_RESOLVED
        ]
        self.assertEqual(len(resolved), 1)
        entry = resolved[0]

        # 14. Serialized with exactly the intended user-display
        #     fields (same convention as actor).
        self.assertEqual(
            set(entry["subjectUser"].keys()),
            {"id", "username", "firstName", "lastName"},
        )
        self.assertEqual(entry["subjectUser"]["id"], chris.pk)
        self.assertEqual(entry["subjectUser"]["username"], "chris")

        # Structured payload: exactly the allowlisted persisted keys.
        self.assertEqual(
            set(entry["changes"].keys()),
            {
                "resolution",
                "affectedWorkItemCount",
                "replacementUserId",
                "membershipAction",
                "previousRole",
                "newRole",
            },
        )
        self.assertEqual(entry["changes"]["resolution"], "unassign")
        self.assertEqual(entry["changes"]["affectedWorkItemCount"], 1)
        self.assertIsNone(entry["changes"]["replacementUserId"])
        self.assertEqual(entry["changes"]["membershipAction"], "role_changed")
        self.assertEqual(entry["changes"]["previousRole"], "member")
        self.assertEqual(entry["changes"]["newRole"], "viewer")

    def test_events_without_subject_user_return_null_not_fabricated(self):
        paper_xyz = self.data["paper_xyz"]

        archive_project(project=paper_xyz, actor=self.data["alex"])
        restore_project(project=paper_xyz, actor=self.data["alex"])

        for username in ("alex", "chris", "laura"):
            with self.subTest(username=username):
                for entry in self._feed_entries(self.data[username]):
                    if entry["eventType"] in (
                        ProjectAuditEventType.ARCHIVED,
                        ProjectAuditEventType.RESTORED,
                    ):
                        self.assertIsNone(entry["subjectUser"])
                    # Work Item events never carry a subject user.
                    if entry["eventType"] in (
                        "work_item.created",
                        "work_item.updated",
                    ):
                        self.assertIsNone(entry["subjectUser"])


# ── Pagination: unauthorized Project events removed BEFORE paging ──


class ProjectFeedPaginationTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_interleaved_unauthorized_project_events_create_no_holes(self):
        alex = self.data["alex"]
        chris = self.data["chris"]
        paper_xyz = self.data["paper_xyz"]
        secret_project = create_project(
            research_group=self.data["group"],
            creator=chris,
            name="Secret Gamma",
        )

        # 16 authorized + 16 unauthorized Project events, created
        # alternately so their ids interleave; timestamps are then
        # equalized so the canonical order is purely (-created_at,
        # -id) == interleaved by id.
        for _ in range(8):
            archive_project(project=paper_xyz, actor=alex)
            archive_project(project=secret_project, actor=chris)
            restore_project(project=secret_project, actor=chris)
            restore_project(project=paper_xyz, actor=alex)

        fixed = timezone.now()
        AuditEvent.objects.filter(
            project__in=[paper_xyz, secret_project],
        ).update(created_at=fixed)

        authorized_ids = set(
            AuditEvent.objects
            .filter(project=paper_xyz)
            .values_list("id", flat=True)
        )

        # Page 1 must be exactly 10 AUTHORIZED events — with
        # post-pagination filtering it would contain only ~5.
        page_1 = self._feed_entries(alex, limit=10)
        self.assertEqual(len(page_1), 10)
        page_1_ids = [entry["id"] for entry in page_1]
        self.assertEqual(
            page_1_ids,
            sorted(authorized_ids, reverse=True)[:10],
        )

        # The full page walk yields exactly the authorized events —
        # no gaps, no unauthorized ids, no secret metadata.
        all_ids = []
        for offset in (0, 10):
            body = self._feed_entries(alex, limit=10, offset=offset)
            all_ids.extend(e["id"] for e in body)
            self.assertNotIn("Secret Gamma", str(body))
        self.assertEqual(set(all_ids), authorized_ids)
        self.assertEqual(len(all_ids), len(authorized_ids))


# ── Response contract (additive: subjectUser) ──


class ProjectFeedPayloadContractTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_project_entry_contract(self):
        paper_xyz = self.data["paper_xyz"]
        archive_project(project=paper_xyz, actor=self.data["alex"])

        entries = self._feed_entries(self.data["alex"])
        entry = [
            e for e in entries
            if e["eventType"] == ProjectAuditEventType.ARCHIVED
        ][0]

        # The Work Item + Meeting contract keys plus subjectUser.
        self.assertEqual(
            set(entry.keys()),
            {
                "id",
                "eventType",
                "actor",
                "subjectUser",
                "workItemId",
                "workItemTitle",
                "meetingId",
                "meetingTitle",
                "projectId",
                "projectName",
                "researchGroupId",
                "researchGroupName",
                "changes",
                "createdAt",
            },
        )
        self.assertEqual(entry["projectId"], paper_xyz.pk)
        self.assertEqual(entry["projectName"], "Paper XYZ")
        # Stable machine code, never a rendered sentence.
        self.assertEqual(entry["eventType"], "project.archived")
