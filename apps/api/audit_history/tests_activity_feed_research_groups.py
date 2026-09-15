"""Behavioral API tests for the Research Group Activity feed slice.

GET /api/activity/ now projects the pre-existing Research Group
audit event (docs/domain/activity.md \u00a74b) with READ-time
authorization:

- research_group.member_offboarded is visible iff the requester can
  read the event's Research Group TODAY through the canonical
  GROUP_READ rule (current ResearchGroupMembership; both the member
  and the admin role grant read) \u2014 the identical rule of
  Research Group reads (resolve_group_scope / GROUP_READ).
- Losing group membership immediately removes the historical
  Research Group events (read-time, not creation-time,
  authorization) \u2014 even for the event's subject_user (the
  offboarded member): subject_user is event context, never an
  authorization input.
- actor (the user who performed the offboarding) and subjectUser
  (the offboarded member) are serialized independently with the
  public user-ref representation only.
- Research Group deletion is not supported: the event's
  research_group FK is NOT NULL / RESTRICT, so a Research Group
  with audit events cannot be deleted \u2014 no retained event state
  exists whose current read authorization could not be evaluated.
- Structured payload only: exactly the allowlisted persisted
  offboarding summary keys, never the raw AuditEvent.data.

Setup reuses the standard Work Item scenario
(work_items.tests_api._setup_test_data):

FG Example group:
- alex:  group admin, Paper XYZ owner
- chris: group member, Paper XYZ member (assigned to the Work Item)
- maria: group member, NO Paper XYZ membership
- laura: group member, Paper XYZ viewer
"""

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.utils import timezone
from rest_framework.test import APITestCase

from audit_history.models import AuditEvent
from projects.services import ProjectAuditEventType
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from research_groups.services import (
    ResearchGroupAuditEventType,
    offboard_research_group_member,
)
from work_items.tests_api import _setup_test_data

User = get_user_model()

FEED_URL = "/api/activity/"

RG_OFFBOARDED = ResearchGroupAuditEventType.MEMBER_OFFBOARDED


def _offboard_chris_via_api(client, data):
    """Offboard chris through the canonical membership offboarding
    endpoint (the group admin resolves his Work Item assignment)."""
    membership = ResearchGroupMembership.objects.get(
        research_group=data["group"], user=data["chris"],
    )
    client.force_login(data["alex"])
    response = client.post(
        f"/api/research-groups/{data['group'].pk}"
        f"/memberships/{membership.pk}/offboarding/",
        data={
            "projects": [
                {
                    "projectId": data["paper_xyz"].pk,
                    "assignmentResolution": {"mode": "unassign"},
                },
            ],
        },
        content_type="application/json",
    )
    assert response.status_code == 200, response.content
    assert not ResearchGroupMembership.objects.filter(
        research_group=data["group"], user=data["chris"],
    ).exists()


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


# \u2500\u2500 Visibility + contract \u2500\u2500


class ResearchGroupFeedVisibilityTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_each_current_read_role_sees_offboarded_event(self):
        _offboard_chris_via_api(self.client, self.data)

        # Both current roles that grant GROUP_READ (admin and
        # member) see the Research Group event.
        for username in ("alex", "laura", "maria"):
            with self.subTest(username=username):
                self.assertIn(
                    RG_OFFBOARDED,
                    self._feed_types(self.data[username]),
                )

    def test_entry_is_machine_identifiable_with_structured_payload(self):
        _offboard_chris_via_api(self.client, self.data)

        entries = self._feed_entries(self.data["alex"])
        rg = [
            e for e in entries if e["eventType"] == RG_OFFBOARDED
        ]
        self.assertEqual(len(rg), 1)
        entry = rg[0]

        # Explicitly machine-identifiable: stable machine code + the
        # group identity, with every other identity pair null (not
        # forced into Project / Work Item / Meeting fields).
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
        self.assertEqual(
            entry["eventType"], "research_group.member_offboarded",
        )
        self.assertEqual(entry["researchGroupId"], self.data["group"].pk)
        self.assertEqual(entry["researchGroupName"], "FG Example")
        self.assertIsNone(entry["projectId"])
        self.assertIsNone(entry["projectName"])
        self.assertIsNone(entry["workItemId"])
        self.assertIsNone(entry["workItemTitle"])
        self.assertIsNone(entry["meetingId"])
        self.assertIsNone(entry["meetingTitle"])

        # Structured payload: exactly the allowlisted persisted
        # offboarding summary keys \u2014 never the raw
        # AuditEvent.data.
        self.assertEqual(
            entry["changes"],
            {
                "removedProjectMembershipCount": 1,
                "affectedWorkItemCount": 1,
                "transferredAssignmentCount": 0,
                "unassignedAssignmentCount": 1,
                "ownershipTransferCount": 0,
                "archivedProjectCount": 0,
            },
        )
        event = AuditEvent.objects.get(event_type=RG_OFFBOARDED)
        self.assertEqual(set(event.data), set(entry["changes"]))

    def test_rg_event_shares_global_ordering_with_all_other_activity(self):
        _offboard_chris_via_api(self.client, self.data)

        # alex (group admin + Paper XYZ owner) can read every event
        # in this scenario, so his feed must equal the full
        # deterministic reverse-chronological order over the UNION
        # of Work Item, Project, and Research Group events.
        expected = list(
            AuditEvent.objects
            .order_by("-created_at", "-id")
            .values_list("id", flat=True)
        )
        entries = self._feed_entries(self.data["alex"])
        self.assertEqual([e["id"] for e in entries], expected)
        self.assertEqual(
            set(self._feed_types(self.data["alex"])),
            {
                "work_item.created",
                ProjectAuditEventType.MEMBER_ASSIGNMENTS_RESOLVED,
                RG_OFFBOARDED,
            },
        )

    def test_group_read_access_does_not_leak_project_activity(self):
        _offboard_chris_via_api(self.client, self.data)

        # maria has GROUP_READ but NO Paper XYZ membership: she sees
        # the Research Group event and nothing of the Project's
        # activity (Research Group read access never implies
        # Project read access).
        entries = self._feed_entries(self.data["maria"])
        self.assertEqual(
            [e["eventType"] for e in entries],
            [RG_OFFBOARDED],
        )
        rendered = str(entries)
        self.assertNotIn("Rewrite Introduction", rendered)
        self.assertNotIn(
            self.data["paper_xyz"].pk,
            [e["projectId"] for e in entries],
        )


# \u2500\u2500 Authorization: current membership only, per group \u2500\u2500


class ResearchGroupFeedAuthorizationTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = User.objects.create_user(
            username="rg-feed-a-admin", password="DevPass1!",
        )
        cls.target = User.objects.create_user(
            username="rg-feed-a-target", password="DevPass1!",
        )
        cls.other = User.objects.create_user(
            username="rg-feed-a-other", password="DevPass1!",
        )
        cls.outsider = User.objects.create_user(
            username="rg-feed-a-outsider", password="DevPass1!",
        )

        cls.group_a = ResearchGroup.objects.create(
            name="RG Feed Group A", created_by=cls.admin,
        )
        cls.group_b = ResearchGroup.objects.create(
            name="RG Feed Group B", created_by=cls.other,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_a, user=cls.admin,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_a, user=cls.target,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_b, user=cls.other,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_b, user=cls.target,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_b, user=cls.outsider,
            role=ResearchGroupMembership.Role.MEMBER,
        )

    def _offboard(self, group, user, actor):
        offboard_research_group_member(
            membership=ResearchGroupMembership.objects.get(
                research_group=group, user=user,
            ),
            actor=actor,
        )

    def test_current_membership_only_grants_rg_activity(self):
        # No events yet: every feed is empty.
        for user in (self.admin, self.target, self.other, self.outsider):
            self.assertEqual(self._feed_entries(user), [])

        # Offboard the target from group A (actor: the group A
        # admin). The target keeps its group B membership.
        self._offboard(self.group_a, self.target, self.admin)

        # The group A admin sees the event...
        self.assertEqual(
            self._feed_types(self.admin), [RG_OFFBOARDED],
        )
        # ...while a member of ONLY the other group sees nothing of
        # it: no RG event, no group A id/name leak.
        for user in (self.other, self.outsider):
            with self.subTest(user=user.username):
                entries = self._feed_entries(user)
                self.assertEqual(entries, [])
                rendered = str(entries)
                self.assertNotIn("RG Feed Group A", rendered)
                self.assertNotIn(
                    self.group_a.pk,
                    [e["researchGroupId"] for e in entries],
                )

    def test_offboarded_target_is_subject_user_but_keeps_nothing(self):
        # 1. Offboard the target from A: the event's subject_user is
        #    the target.
        self._offboard(self.group_a, self.target, self.admin)
        event_a = AuditEvent.objects.get(event_type=RG_OFFBOARDED)
        self.assertEqual(event_a.subject_user_id, self.target.pk)
        self.assertEqual(event_a.research_group_id, self.group_a.pk)

        # 2. While the target still belongs to group B, offboard the
        #    outsider from B, creating a second RG event there.
        self._offboard(self.group_b, self.outsider, self.other)

        # 3. The target lost group A at offboarding: the historical
        #    group A event \u2014 whose subject_user IS the target \u2014
        #    must not remain in the target's feed. Subject identity
        #    grants nothing; current group B membership still grants
        #    the group B event.
        entries = self._feed_entries(self.target)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["eventType"], RG_OFFBOARDED)
        self.assertEqual(entries[0]["researchGroupId"], self.group_b.pk)
        self.assertNotIn(
            event_a.pk, [e["id"] for e in entries],
        )
        rendered = str(entries)
        self.assertNotIn("RG Feed Group A", rendered)
        self.assertNotIn(
            self.group_a.pk,
            [e["researchGroupId"] for e in entries],
        )

    def test_user_without_any_group_membership_gets_empty_feed(self):
        self._offboard(self.group_a, self.target, self.admin)
        self._offboard(self.group_b, self.outsider, self.other)

        nobody = User.objects.create_user(
            username="rg-feed-a-nobody", password="DevPass1!",
        )
        self.assertEqual(self._feed_entries(nobody), [])


# \u2500\u2500 Offboarding / revocation (read-time authorization) \u2500\u2500


class ResearchGroupFeedRevocationTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_offboarding_removes_historical_rg_events_at_read_time(self):
        alex = self.data["alex"]
        laura = self.data["laura"]
        maria = self.data["maria"]

        # 1. First offboarding: maria is a plain member (no Project
        #    memberships, no assignments \u2014 no resolutions
        #    required).
        offboard_research_group_member(
            membership=ResearchGroupMembership.objects.get(
                research_group=self.data["group"], user=maria,
            ),
            actor=alex,
        )

        # 2. While laura still has current group membership, the
        #    historical Research Group event is visible to her.
        self.assertIn(
            RG_OFFBOARDED, self._feed_types(laura),
        )

        # 3. Canonical offboarding of laura (viewer, no assignments:
        #    no Project resolutions required).
        offboard_research_group_member(
            membership=ResearchGroupMembership.objects.get(
                research_group=self.data["group"], user=laura,
            ),
            actor=alex,
        )
        self.assertFalse(
            ResearchGroupMembership.objects
            .filter(research_group=self.data["group"], user=laura)
            .exists()
        )

        # 4. Laura is now BOTH a former group reader AND the
        #    subject_user of the newest event: the historical
        #    Research Group events disappear from her feed at read
        #    time. Subject identity retains nothing (she also lost
        #    her Project viewer access, so her whole feed empties).
        self.assertEqual(self._feed_entries(laura), [])

        # 5. The remaining group admin still sees both historical
        #    Research Group events: read-time, not creation-time,
        #    authorization.
        self.assertEqual(
            self._feed_types(alex).count(RG_OFFBOARDED), 2,
        )


# \u2500\u2500 actor vs subjectUser semantics \u2500\u2500


class ResearchGroupFeedActorSubjectTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def test_actor_and_subject_serialize_independently(self):
        # actor = alex (performs the offboarding), subject = chris
        # (the offboarded member) \u2014 two different users.
        _offboard_chris_via_api(self.client, self.data)

        entries = self._feed_entries(self.data["alex"])
        entry = [
            e for e in entries if e["eventType"] == RG_OFFBOARDED
        ][0]

        self.assertEqual(entry["actor"]["id"], self.data["alex"].pk)
        self.assertEqual(entry["actor"]["username"], "alex")
        self.assertEqual(
            entry["subjectUser"]["id"], self.data["chris"].pk,
        )
        self.assertEqual(entry["subjectUser"]["username"], "chris")
        self.assertNotEqual(
            entry["actor"]["id"], entry["subjectUser"]["id"],
        )

        # No additional user-profile data on either reference: the
        # public user-ref representation only.
        for ref in (entry["actor"], entry["subjectUser"]):
            self.assertEqual(
                set(ref.keys()),
                {"id", "username", "firstName", "lastName"},
            )


# \u2500\u2500 Pagination: unauthorized RG events removed BEFORE paging \u2500\u2500


class ResearchGroupFeedPaginationTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin_a = User.objects.create_user(
            username="rg-feed-pa-admin", password="DevPass1!",
        )
        cls.reader = User.objects.create_user(
            username="rg-feed-pa-reader", password="DevPass1!",
        )
        cls.admin_b = User.objects.create_user(
            username="rg-feed-pb-admin", password="DevPass1!",
        )
        cls.group_a = ResearchGroup.objects.create(
            name="RG Feed Page A", created_by=cls.admin_a,
        )
        cls.group_b = ResearchGroup.objects.create(
            name="RG Feed Page B", created_by=cls.admin_b,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_a, user=cls.admin_a,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_a, user=cls.reader,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group_b, user=cls.admin_b,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        # 12 offboardable members per group (no Project
        # memberships, so each offboarding records exactly one RG
        # event).
        cls.members_a = []
        cls.members_b = []
        for i in range(12):
            member_a = User.objects.create_user(
                username=f"rg-feed-pa-m{i}", password="DevPass1!",
            )
            ResearchGroupMembership.objects.create(
                research_group=cls.group_a, user=member_a,
                role=ResearchGroupMembership.Role.MEMBER,
            )
            cls.members_a.append(member_a)
            member_b = User.objects.create_user(
                username=f"rg-feed-pb-m{i}", password="DevPass1!",
            )
            ResearchGroupMembership.objects.create(
                research_group=cls.group_b, user=member_b,
                role=ResearchGroupMembership.Role.MEMBER,
            )
            cls.members_b.append(member_b)

    def test_interleaved_unauthorized_rg_events_create_no_holes(self):
        # Offboard both groups' members alternately so the event
        # ids interleave.
        for member_a, member_b in zip(self.members_a, self.members_b):
            offboard_research_group_member(
                membership=ResearchGroupMembership.objects.get(
                    research_group=self.group_a, user=member_a,
                ),
                actor=self.admin_a,
            )
            offboard_research_group_member(
                membership=ResearchGroupMembership.objects.get(
                    research_group=self.group_b, user=member_b,
                ),
                actor=self.admin_b,
            )

        # Equalize timestamps so the canonical order is purely
        # (-created_at, -id) == interleaved by id.
        fixed = timezone.now()
        AuditEvent.objects.filter(
            research_group__in=[self.group_a, self.group_b],
        ).update(created_at=fixed)

        authorized_ids = set(
            AuditEvent.objects
            .filter(research_group=self.group_a)
            .values_list("id", flat=True)
        )
        self.assertEqual(len(authorized_ids), 12)

        # Page 1 must be exactly 10 AUTHORIZED events \u2014 with
        # post-pagination filtering it would contain only ~5.
        page_1 = self._feed_entries(self.reader, limit=10)
        self.assertEqual(len(page_1), 10)
        self.assertEqual(
            [e["id"] for e in page_1],
            sorted(authorized_ids, reverse=True)[:10],
        )
        self.assertEqual(
            {e["researchGroupId"] for e in page_1},
            {self.group_a.pk},
        )

        # The full page walk yields exactly the authorized events \u2014
        # no gaps, no unauthorized ids, no group B metadata.
        all_ids = []
        for offset in (0, 10):
            body = self._feed_entries(self.reader, limit=10, offset=offset)
            all_ids.extend(e["id"] for e in body)
            self.assertNotIn("RG Feed Page B", str(body))
            self.assertNotIn(
                self.group_b.pk, [e["researchGroupId"] for e in body],
            )
        self.assertEqual(set(all_ids), authorized_ids)
        self.assertEqual(len(all_ids), 12)


# \u2500\u2500 Deletion: not supported; authorization stays evaluable \u2500\u2500


class ResearchGroupFeedDeletionTest(_FeedClientMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = User.objects.create_user(
            username="rg-feed-d-admin", password="DevPass1!",
        )
        cls.target = User.objects.create_user(
            username="rg-feed-d-target", password="DevPass1!",
        )
        cls.group = ResearchGroup.objects.create(
            name="RG Feed Deletion Group", created_by=cls.admin,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group, user=cls.admin,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=cls.group, user=cls.target,
            role=ResearchGroupMembership.Role.MEMBER,
        )

    def test_group_with_events_cannot_be_deleted(self):
        # Create the RG event through the canonical offboarding
        # path.
        offboard_research_group_member(
            membership=ResearchGroupMembership.objects.get(
                research_group=self.group, user=self.target,
            ),
            actor=self.admin,
        )
        self.assertTrue(
            AuditEvent.objects
            .filter(event_type=RG_OFFBOARDED, research_group=self.group)
            .exists()
        )

        # Research Group deletion is NOT supported: there is no
        # deletion endpoint/service, and the NOT NULL / RESTRICT
        # AuditEvent.research_group FK makes the database itself
        # refuse to delete a group that has audit events. Current
        # read authorization therefore always remains evaluable for
        # a retained RG event \u2014 no retained-event state exists
        # that could be invisible to the read-time rule (fail
        # closed).
        with self.assertRaises(IntegrityError):
            self.group.delete()
        self.assertTrue(
            ResearchGroup.objects.filter(pk=self.group.pk).exists()
        )
