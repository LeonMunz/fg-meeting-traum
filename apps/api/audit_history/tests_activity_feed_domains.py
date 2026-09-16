"""Behavioral API tests for the Activity feed ``domains`` filter.

``GET /api/activity/?domains=...`` narrows the permission-filtered feed
to one or more of the four approved Activity domains (work_item /
meeting / project / research_group) using OR semantics, and does so in
the database BEFORE pagination.

Contract under test:
- An absent (or empty) ``domains`` param leaves the feed unchanged, and
  OR-ing all four domains equals the unfiltered feed.
- Every returned event belongs to a selected domain (its event_type
  prefix); the filter never widens visibility or grants access.
- Duplicates normalize harmlessly; stray empty segments are ignored; a
  value naming no domain, or containing any unknown domain, is rejected
  400 before any query runs (no partial execution).
- The filter runs in the database BEFORE the bounded pagination slice,
  so a page holds the newest events of the selected domains.
- Ordering is preserved: a domain filter returns the subsequence of the
  unfiltered (-created_at, -id) feed, never a per-domain regrouping.
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from audit_history.models import AuditEvent
from meetings.models import MeetingSection
from meetings.services import (
    MeetingAuditEventType,
    create_meeting,
    create_meeting_item,
    schedule_meeting_item_follow_up,
)
from projects.services import archive_project, create_project
from research_groups.models import ResearchGroupMembership
from research_groups.services import (
    ResearchGroupAuditEventType,
    offboard_research_group_member,
)
from work_items.services import update_work_item
from work_items.tests_api import _setup_test_data

User = get_user_model()

FEED_URL = "/api/activity/"
ALL_DOMAINS = "work_item,meeting,project,research_group"


class ActivityFeedDomainsTest(APITestCase):
    @classmethod
    def setUpTestData(cls):
        # Standard scenario: alex (group admin + Paper XYZ owner), chris
        # (member), maria (member, NO Paper XYZ membership), laura
        # (viewer); one work item "Rewrite Introduction".
        cls.data = _setup_test_data()

    def setUp(self):
        self.client = APIClient()
        self.alex = self.data["alex"]
        self.maria = self.data["maria"]
        self.group = self.data["group"]
        self.paper_xyz = self.data["paper_xyz"]
        self.wi = self.data["work_item"]
        self._wi_seq = 0
        self._populate_one_per_domain()

    # -- fixture: exactly one event in each of the four domains, all
    #    readable by alex --
    def _populate_one_per_domain(self):
        # meeting.*
        self.meeting = create_meeting(
            research_group=self.group, actor=self.alex,
            title="Domain Probe Meeting",
            scheduled_at=timezone.now() + timedelta(days=1),
        )
        # project.* (on a dedicated probe project so paper_xyz + its
        # work item remain mutable for the ordering/pagination tests)
        self.probe_project = create_project(
            research_group=self.group, creator=self.alex,
            name="Domain Probe Project",
        )
        archive_project(project=self.probe_project, actor=self.alex)
        # research_group.* (offboard a dedicated member so the standard
        # users stay untouched for the authorization test)
        self.rg_subject = User.objects.create_user(
            username="feed-dom-rg", password="Pass1!",
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group, user=self.rg_subject,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        offboard_research_group_member(
            membership=ResearchGroupMembership.objects.get(
                research_group=self.group, user=self.rg_subject,
            ),
            actor=self.alex,
        )

    # -- feed access --
    def _login(self, user):
        self.client.force_login(user)

    def _feed(self, user, **params):
        self._login(user)
        return self.client.get(FEED_URL, params or None)

    def _feed_entries(self, user, **params):
        response = self._feed(user, **params)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _feed_ids(self, user, **params):
        return [e["id"] for e in self._feed_entries(user, **params)]

    # -- domain classification (mirrors the API event_type-prefix rule) --
    @staticmethod
    def _domain_of(event_type):
        return event_type.split(".", 1)[0]

    def _domain_ids(self, user, **params):
        by = {}
        for e in self._feed_entries(user, **params):
            by.setdefault(self._domain_of(e["eventType"]), []).append(e["id"])
        return by

    # -- event helpers --
    def _work_item_event_ids(self):
        return list(
            AuditEvent.objects.filter(work_item=self.wi)
            .order_by("pk").values_list("pk", flat=True)
        )

    def _add_work_item_events(self, count):
        for _ in range(count):
            self._wi_seq += 1
            update_work_item(
                work_item=self.wi, actor=self.alex,
                title=f"DOM probe {self._wi_seq}",
            )

    def _meeting_created_id(self, meeting):
        return (
            AuditEvent.objects.filter(
                meeting=meeting,
                event_type=MeetingAuditEventType.CREATED,
            ).values_list("pk", flat=True)[0]
        )

    # -- tests --
    def test_no_filter_is_unchanged_and_equals_all_four(self):
        self.assertEqual(
            self._feed_ids(self.alex),
            self._feed_ids(self.alex, domains=ALL_DOMAINS),
        )
        self.assertEqual(
            set(self._domain_ids(self.alex)),
            {"work_item", "meeting", "project", "research_group"},
        )

    def test_single_domain_returns_only_that_domain(self):
        expected = self._domain_ids(self.alex)
        for domain in ("work_item", "meeting", "project", "research_group"):
            with self.subTest(domain=domain):
                got = self._domain_ids(self.alex, domains=domain)
                self.assertEqual(set(got), {domain})
                self.assertEqual(sorted(got[domain]), sorted(expected[domain]))

    def test_multiple_domains_use_or_semantics(self):
        expected = self._domain_ids(self.alex)
        with self.subTest():
            got = self._domain_ids(self.alex, domains="meeting,project")
            self.assertEqual(set(got), {"meeting", "project"})
            self.assertEqual(sorted(got["meeting"]), sorted(expected["meeting"]))
            self.assertEqual(sorted(got["project"]), sorted(expected["project"]))
        with self.subTest():
            got = self._domain_ids(self.alex, domains="work_item,meeting")
            self.assertEqual(set(got), {"work_item", "meeting"})

    def test_duplicate_domains_are_harmless(self):
        self.assertEqual(
            self._feed_ids(self.alex, domains="meeting,meeting"),
            self._feed_ids(self.alex, domains="meeting"),
        )
        self.assertEqual(
            self._feed_ids(self.alex, domains="meeting,meeting,work_item"),
            self._feed_ids(self.alex, domains="meeting,work_item"),
        )

    def test_unknown_domain_rejected_with_400(self):
        for value in (
            "banana",
            "meeting,banana",
            "work_item,banana",
            "workitem",    # missing underscore
            "Work Item",   # wrong casing / spacing
            "MEETING",     # wrong casing
            "meeting.",    # trailing separator
        ):
            with self.subTest(value=value):
                response = self._feed(self.alex, domains=value)
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.json())

    def test_malformed_domain_values(self):
        # present-but-empty -> treated as no filter (feed unchanged)
        self.assertEqual(
            self._feed_ids(self.alex, domains=""),
            self._feed_ids(self.alex),
        )
        # stray empty segments are ignored
        self.assertEqual(
            self._feed_ids(self.alex, domains="meeting,"),
            self._feed_ids(self.alex, domains="meeting"),
        )
        self.assertEqual(
            self._feed_ids(self.alex, domains=",meeting"),
            self._feed_ids(self.alex, domains="meeting"),
        )
        # a value that names NO domain is a malformed filter -> 400
        for value in (",", ",,"):
            with self.subTest(value=value):
                self.assertEqual(
                    self._feed(self.alex, domains=value).status_code, 400,
                )

    def test_domain_filter_runs_before_pagination(self):
        base = timezone.now()
        # 12 newer Work Item update events (13 total incl. the created).
        self._add_work_item_events(12)
        wi_ids = self._work_item_event_ids()
        # 2 more meetings (setUp created 1 -> 3 meetings total).
        extra = [
            create_meeting(
                research_group=self.group, actor=self.alex,
                title=f"Old Meeting {i}",
                scheduled_at=timezone.now() + timedelta(days=10),
            )
            for i in range(2)
        ]
        meeting_ids = [
            self._meeting_created_id(m) for m in [self.meeting] + extra
        ]
        # Deterministic ordering: every Work Item event strictly newer
        # than every Meeting event.
        for k, eid in enumerate(wi_ids):
            AuditEvent.objects.filter(pk=eid).update(
                created_at=base + timedelta(minutes=100 + k),
            )
        for k, eid in enumerate(meeting_ids):
            AuditEvent.objects.filter(pk=eid).update(
                created_at=base + timedelta(minutes=1 + k),
            )
        # The unfiltered newest page is entirely Work Item events ...
        first_page = self._feed_entries(self.alex, limit=12)
        self.assertTrue(all(
            self._domain_of(e["eventType"]) == "work_item"
            for e in first_page
        ))
        first_ids = {e["id"] for e in first_page}
        # ... so an in-memory filter over that page would return zero
        # Meetings. The correct filter narrows BEFORE pagination and
        # returns the Meetings that sit just beyond the unfiltered page.
        meeting_page = self._feed_entries(self.alex, limit=12, domains="meeting")
        self.assertEqual({e["id"] for e in meeting_page}, set(meeting_ids))
        self.assertFalse(set(meeting_ids) & first_ids)

    def test_ordering_preserved_within_domain_filter(self):
        base = timezone.now()
        self._add_work_item_events(3)
        wi_ids = self._work_item_event_ids()  # 1 created + 3 updated
        for k, eid in enumerate(wi_ids):
            AuditEvent.objects.filter(pk=eid).update(
                created_at=base + timedelta(minutes=3 * k + 1),
            )
        # Interleave the setUp Meeting event between them (no ties).
        meeting_id = self._meeting_created_id(self.meeting)
        AuditEvent.objects.filter(pk=meeting_id).update(
            created_at=base + timedelta(minutes=2),
        )
        unfiltered_ids = [e["id"] for e in self._feed_entries(self.alex)]
        filtered_ids = self._feed_ids(self.alex, domains="work_item")
        expected = [i for i in unfiltered_ids if i in set(wi_ids)]
        self.assertGreater(len(expected), 1)
        self.assertEqual(filtered_ids, expected)

    def test_domain_filter_is_a_subset_of_unfiltered(self):
        by_domain = self._domain_ids(self.alex)
        for domain in ("work_item", "meeting", "project", "research_group"):
            with self.subTest(domain=domain):
                self.assertEqual(
                    self._feed_ids(self.alex, domains=domain),
                    by_domain.get(domain, []),
                )

    def test_domain_filter_never_widens_visibility(self):
        # maria: current group member with NO Paper XYZ / probe-project
        # membership -> cannot read those work items or project events,
        # and is not a participant/creator of the probe Meeting.
        # Filtering to those domains must return nothing.
        self.assertEqual(self._feed_entries(self.maria, domains="work_item"), [])
        self.assertEqual(self._feed_entries(self.maria, domains="project"), [])
        self.assertEqual(self._feed_entries(self.maria, domains="meeting"), [])
        # She keeps GROUP_READ, so the Research Group event is visible.
        self.assertEqual(
            [e["eventType"] for e in self._feed_entries(
                self.maria, domains="research_group",
            )],
            [ResearchGroupAuditEventType.MEMBER_OFFBOARDED],
        )

    def test_follow_up_scheduled_is_meeting_domain(self):
        target = create_meeting(
            research_group=self.group, actor=self.alex,
            title="Follow-up Target",
            scheduled_at=timezone.now() + timedelta(days=7),
        )
        source_item = create_meeting_item(
            meeting=self.meeting,
            meeting_section=MeetingSection.objects.get(meeting=self.meeting),
            actor=self.alex,
            title="Source item for follow-up",
        )
        schedule_meeting_item_follow_up(
            source_meeting_item=source_item,
            target_meeting=target,
            target_meeting_section=MeetingSection.objects.get(meeting=target),
            actor=self.alex,
        )
        follow_ids = set(
            AuditEvent.objects.filter(
                event_type=MeetingAuditEventType.FOLLOW_UP_SCHEDULED,
            ).values_list("pk", flat=True)
        )
        self.assertEqual(len(follow_ids), 1)
        # Classified under the meeting domain ...
        self.assertEqual(
            set(self._feed_ids(self.alex, domains="meeting")) & follow_ids,
            follow_ids,
        )
        # ... and excluded from every non-meeting domain.
        others = set(self._feed_ids(
            self.alex, domains="work_item,project,research_group",
        ))
        self.assertFalse(others & follow_ids)
