"""Integration tests for the RT-03A SSE / PostgreSQL LISTEN-NOTIFY
transport (``work_items.realtime``).

Real database transactions and real dedicated LISTEN connections are
used throughout (``TransactionTestCase`` so test-side publications can
commit); pure mock tests do NOT substitute for the PostgreSQL fan-out
evidence. The Django test client drives the endpoint; stream frames are
consumed manually so the tests control exactly when the stream blocks.

Contract under test: ``docs/architecture.md`` (Realtime) — connection
authorization (401/403 before stream bytes), the SSE frame contract,
commit-attached publication, per-delivery re-authorization (identity +
scope), suppression of malformed payloads, multi-connection fan-out,
revocation semantics, and listener-connection cleanup.
"""

import json
import time
import unittest.mock as mock

import psycopg
from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.test import Client, SimpleTestCase, TransactionTestCase

from accounts.models import UserSession
from accounts.services import revoke_user_session
from projects.models import ProjectMembership
from projects.services import add_project_membership, create_project
from research_groups.models import ResearchGroup, ResearchGroupMembership

import work_items.realtime as realtime
from work_items.realtime import (
    ListenerUnavailableError,
    open_listener,
    publish_my_work_changed,
    publish_project_work_item_changed,
)

User = get_user_model()

EVENTS_URL = "/api/work-items/events/"

# Scaled-down keep-alive interval for fast suppression/cadence tests
# (production default stays 15 s in work_items.realtime).
FAST_KEEPALIVE = 0.15


def _parse_sse_frame(frame):
    """Parse one SSE frame into ``(event, data)``; comment frames
    (keep-alives) yield ``(None, None)``."""
    event = None
    data = None
    for line in frame.splitlines():
        if line.startswith("event:"):
            event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data = line[len("data:"):].strip()
    return event, data


class _Stream:
    """One open stream driven through the Django test client.

    ``chunks`` reads frames lazily; ``generator`` is the underlying
    stream generator (the response's ``_iterator``), closed to simulate
    a client disconnect.
    """

    def __init__(self, client, response):
        self.client = client
        self.response = response
        self.generator = response._iterator
        self._chunks = iter(response.streaming_content)

    def next_frame(self):
        frame = next(self._chunks)
        # The test client encodes str chunks to bytes; normalize back.
        if isinstance(frame, (bytes, bytearray)):
            frame = bytes(frame).decode("utf-8")
        return frame

    def close(self):
        try:
            self.generator.close()
        except (StopIteration, AttributeError):
            pass
        self.response.close()


class RealtimeTransportBase(TransactionTestCase):
    """Fixture: one Research Group with an owner, a member, a viewer,
    and a group member without Project membership; one Project owned by
    the owner with member + viewer memberships."""

    def setUp(self):
        self.owner = User.objects.create_user(
            username="rt_owner", password="RtPass1!"
        )
        self.member = User.objects.create_user(
            username="rt_member", password="RtPass1!"
        )
        self.viewer = User.objects.create_user(
            username="rt_viewer", password="RtPass1!"
        )
        self.outsider = User.objects.create_user(
            username="rt_outsider", password="RtPass1!"
        )

        self.group = ResearchGroup.objects.create(
            name="RT Group", created_by=self.owner
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        for user in (self.member, self.viewer, self.outsider):
            ResearchGroupMembership.objects.create(
                research_group=self.group,
                user=user,
                role=ResearchGroupMembership.Role.MEMBER,
            )

        self.project = create_project(
            research_group=self.group, creator=self.owner, name="RT Project A"
        )
        add_project_membership(
            project=self.project,
            actor=self.owner,
            target_user=self.member,
            role=ProjectMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project,
            actor=self.owner,
            target_user=self.viewer,
            role=ProjectMembership.Role.VIEWER,
        )

    # ── helpers ─────────────────────────────────────────────────────

    def _client(self, user):
        client = Client()
        self.assertTrue(client.login(username=user.username, password="RtPass1!"))
        return client

    def _open_stream(self, user):
        """Open an authenticated stream and consume the open handshake.

        Returns ``(_Stream, open_frame)``; the stream generator is
        suspended at its first yield point.
        """
        client = self._client(user)
        response = client.get(EVENTS_URL)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/event-stream")
        stream = _Stream(client, response)
        return stream, stream.next_frame()

    def _publish_project_event(self, project=None):
        with transaction.atomic():
            publish_project_work_item_changed((project or self.project).pk)

    def _publish_my_work_event(self, user):
        with transaction.atomic():
            publish_my_work_changed(user.pk)

    def _raw_notify(self, payload):
        """Publish an arbitrary (possibly malformed) payload on the
        channel — the test-side stand-in for a tampered notification."""
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_notify(%s, %s)", (realtime.NOTIFY_CHANNEL, payload)
                )

    def _listener_count(self):
        """Dedicated listener connections visible to PostgreSQL."""
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE application_name = %s",
                (realtime.LISTENER_APPLICATION_NAME,),
            )
            return cursor.fetchone()[0]


class ConnectionAuthorizationTests(RealtimeTransportBase):
    """1. Authenticated vs unauthenticated connection establishment."""

    def test_anonymous_rejected_before_stream_bytes(self):
        response = Client().get(EVENTS_URL)
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("text/event-stream", response["Content-Type"])

    def test_inactive_user_rejected_before_stream_bytes(self):
        # Deactivated AFTER login: the AuthenticationMiddleware maps
        # an inactive user to anonymous (ModelBackend), so the answer
        # is 401 — uniform with every other API endpoint and with the
        # architecture doc's recovery contract ("an inactive user
        # answers 401 as well", terminal authentication loss for the
        # client).
        user = User.objects.create_user(
            username="rt_inactive", password="RtPass1!"
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=user,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        add_project_membership(
            project=self.project,
            actor=self.owner,
            target_user=user,
            role=ProjectMembership.Role.MEMBER,
        )

        client = Client()
        self.assertTrue(client.login(username=user.username, password="RtPass1!"))
        user.is_active = False
        user.save(update_fields=["is_active"])

        response = client.get(EVENTS_URL)
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("text/event-stream", response["Content-Type"])

    def test_authenticated_stream_opens_with_open_event(self):
        stream, open_frame = self._open_stream(self.owner)
        try:
            event, data = _parse_sse_frame(open_frame)
            self.assertEqual(event, "open")
            self.assertEqual(json.loads(data), {"userId": self.owner.pk})
            self.assertEqual(stream.response["Cache-Control"], "no-cache")
        finally:
            stream.close()

    def test_open_event_carries_only_the_own_user_id(self):
        stream, open_frame = self._open_stream(self.member)
        try:
            lines = open_frame.splitlines()
            self.assertEqual(lines[0], "event: open")
            self.assertEqual(lines[1], f"data: {{\"userId\":{self.member.pk}}}")
            self.assertEqual(lines[2], "")
            # No other user identity may appear in the handshake.
            self.assertNotIn(str(self.owner.pk), open_frame)
        finally:
            stream.close()

    def test_non_get_rejected(self):
        client = self._client(self.owner)
        response = client.post(EVENTS_URL)
        self.assertEqual(response.status_code, 405)


class SseLifecycleTests(RealtimeTransportBase):
    """2. SSE format, keep-alive cadence, and the server-side limit."""

    def test_keepalive_frames_at_interval(self):
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", 0.2
        ):
            stream, _ = self._open_stream(self.owner)
            try:
                t0 = time.monotonic()
                self.assertEqual(stream.next_frame(), ": ping\n\n")
                t1 = time.monotonic()
                self.assertEqual(stream.next_frame(), ": ping\n\n")
                t2 = time.monotonic()
            finally:
                stream.close()
        # Roughly every (scaled) interval: never faster, no unbounded
        # drift within the test window.
        self.assertGreaterEqual(t1 - t0, 0.1)
        self.assertGreaterEqual(t2 - t1, 0.1)
        self.assertLess(t1 - t0, 2.0)
        self.assertLess(t2 - t1, 2.0)

    def test_stream_closes_at_max_age_and_releases_listener(self):
        baseline = self._listener_count()
        with mock.patch.object(realtime, "STREAM_MAX_AGE_SECONDS", 0.4):
            stream, _ = self._open_stream(self.owner)
            try:
                start = time.monotonic()
                with self.assertRaises(StopIteration):
                    stream.next_frame()
                elapsed = time.monotonic() - start
            finally:
                stream.close()
        self.assertGreaterEqual(elapsed, 0.35)
        # Normal termination releases the dedicated listener connection.
        self.assertEqual(self._listener_count(), baseline)


class DeliveryTests(RealtimeTransportBase):
    """3. Test-published NOTIFY signals reach the stream, and 8.
    personal events never reach other users."""

    def _assert_project_event_delivered(self, user):
        stream, _ = self._open_stream(user)
        try:
            self._publish_project_event()
            event, data = _parse_sse_frame(stream.next_frame())
            self.assertEqual(event, "work_item_changed")
            self.assertEqual(json.loads(data), {"projectId": self.project.pk})
        finally:
            stream.close()

    def test_project_event_delivered_to_owner(self):
        self._assert_project_event_delivered(self.owner)

    def test_project_event_delivered_to_member(self):
        self._assert_project_event_delivered(self.member)

    def test_project_event_delivered_to_viewer(self):
        # Authorized viewers are part of the canonical read boundary.
        self._assert_project_event_delivered(self.viewer)

    def test_my_work_event_delivered_to_addressed_user(self):
        stream, _ = self._open_stream(self.owner)
        try:
            self._publish_my_work_event(self.owner)
            event, data = _parse_sse_frame(stream.next_frame())
            self.assertEqual(event, "my_work_changed")
            self.assertEqual(json.loads(data), {})
        finally:
            stream.close()

    def test_my_work_event_does_not_reach_other_users(self):
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            owner_stream, _ = self._open_stream(self.owner)
            member_stream, _ = self._open_stream(self.member)
            try:
                self._publish_my_work_event(self.owner)

                event, data = _parse_sse_frame(owner_stream.next_frame())
                self.assertEqual(event, "my_work_changed")
                self.assertEqual(json.loads(data), {})

                # The member's stream suppresses the foreign personal
                # event and stays open.
                frame = member_stream.next_frame()
                self.assertEqual(frame, ": ping\n\n")
                self.assertNotIn(str(self.owner.pk), frame)
            finally:
                owner_stream.close()
                member_stream.close()

    def test_malformed_and_tampered_payloads_are_suppressed(self):
        payloads = [
            "{not-json",  # not JSON
            "null",  # JSON, not an object
            "[]",  # not an object
            '"string"',  # not an object
            '{"scope": "project"}',  # missing projectId
            '{"scope": "user"}',  # missing userId
            '{"scope": "project", "projectId": "7"}',  # wrong type
            '{"scope": "project", "projectId": 7.5}',  # wrong type
            '{"scope": "project", "projectId": true}',  # bool is not int
            '{"scope": "unknown", "projectId": 1}',  # unknown scope
            '{"projectId": 1}',  # no scope
            '{"scope": "project", "projectId": 1, "extra": "x"}',  # extra key
        ]
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            stream, _ = self._open_stream(self.owner)
            try:
                for payload in payloads:
                    self._raw_notify(payload)
                    # Suppressed: no event frame; the stream stays open
                    # and its next yield is a keep-alive.
                    frame = stream.next_frame()
                    self.assertEqual(frame, ": ping\n\n", payload)
            finally:
                stream.close()

    def test_unknown_project_id_is_suppressed(self):
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            stream, _ = self._open_stream(self.owner)
            try:
                self._raw_notify('{"scope": "project", "projectId": 999999}')
                self.assertEqual(stream.next_frame(), ": ping\n\n")
            finally:
                stream.close()


class FanOutTests(RealtimeTransportBase):
    """4. Two independent listener connections receive the same
    committed signal; 9. visibility is commit-attached."""

    def test_two_independent_listeners_receive_same_committed_signal(self):
        stream, _ = self._open_stream(self.owner)
        # An independent LISTEN connection simulating a second worker
        # process.
        raw_listener = open_listener()
        try:
            self._publish_project_event()

            event, data = _parse_sse_frame(stream.next_frame())
            self.assertEqual(event, "work_item_changed")
            self.assertEqual(json.loads(data), {"projectId": self.project.pk})

            notification = next(
                raw_listener.iter_notifications(timeout=2.0), None
            )
            self.assertIsNotNone(notification)
            self.assertEqual(notification.channel, realtime.NOTIFY_CHANNEL)
            self.assertEqual(
                json.loads(notification.payload),
                {"scope": "project", "projectId": self.project.pk},
            )
        finally:
            raw_listener.close()
            stream.close()

    def test_notification_visible_only_after_commit(self):
        raw_listener = open_listener()
        try:
            with transaction.atomic():
                publish_project_work_item_changed(self.project.pk)
                # Still uncommitted: nothing may be visible.
                pending = next(
                    raw_listener.iter_notifications(timeout=0.5), None
                )
                self.assertIsNone(pending)
            # Committed: exactly one notification, visible now.
            notification = next(
                raw_listener.iter_notifications(timeout=2.0), None
            )
            self.assertIsNotNone(notification)
            self.assertEqual(
                json.loads(notification.payload),
                {"scope": "project", "projectId": self.project.pk},
            )
        finally:
            raw_listener.close()


class AuthorizationRevocationTests(RealtimeTransportBase):
    """5. No project data leak to unauthorized users; 6. project
    revocation mid-connection; 7. session revocation mid-connection."""

    def test_outsider_receives_no_project_event(self):
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            stream, _ = self._open_stream(self.outsider)
            try:
                self._publish_project_event()
                frame = stream.next_frame()
                # Nothing about the inaccessible Project may become
                # observable: no event frame, no project id, no timing
                # (a keep-alive is all that appears).
                self.assertEqual(frame, ": ping\n\n")
                self.assertNotIn(str(self.project.pk), frame)
                # The stream stays open for the outsider's other scopes.
                self.assertEqual(stream.next_frame(), ": ping\n\n")
            finally:
                stream.close()

    def test_project_revocation_stops_events_and_keeps_stream_open(self):
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            stream, _ = self._open_stream(self.member)
            try:
                # Baseline: the member currently receives Project A events.
                self._publish_project_event()
                event, data = _parse_sse_frame(stream.next_frame())
                self.assertEqual(event, "work_item_changed")
                self.assertEqual(
                    json.loads(data), {"projectId": self.project.pk}
                )

                # Revoke the ProjectMembership (committed).
                ProjectMembership.objects.filter(
                    user=self.member, project=self.project
                ).delete()

                # No further Project A event is delivered...
                self._publish_project_event()
                frame = stream.next_frame()
                self.assertEqual(frame, ": ping\n\n")
                self.assertNotIn(str(self.project.pk), frame)

                # ...while a still-authorized Project keeps delivering
                # on the SAME open stream.
                project_b = create_project(
                    research_group=self.group,
                    creator=self.owner,
                    name="RT Project B",
                )
                add_project_membership(
                    project=project_b,
                    actor=self.owner,
                    target_user=self.member,
                    role=ProjectMembership.Role.MEMBER,
                )
                self._publish_project_event(project_b)
                event, data = _parse_sse_frame(stream.next_frame())
                self.assertEqual(event, "work_item_changed")
                self.assertEqual(
                    json.loads(data), {"projectId": project_b.pk}
                )
            finally:
                stream.close()

    def test_session_revocation_closes_stream_at_next_delivery(self):
        stream, _ = self._open_stream(self.owner)
        session_key = stream.client.session.session_key
        try:
            registry_row = UserSession.objects.filter(
                user=self.owner, session_key=session_key
            ).first()
            self.assertIsNotNone(registry_row)
            self.assertTrue(
                revoke_user_session(self.owner, registry_row.public_id)
            )

            # The next delivery closes the stream without delivering
            # the event.
            self._publish_project_event()
            with self.assertRaises(StopIteration):
                stream.next_frame()

            # A reconnect attempt with the dead session is rejected
            # (terminal 401 per the SSE recovery contract).
            reconnect = stream.client.get(EVENTS_URL)
            self.assertEqual(reconnect.status_code, 401)
            self.assertNotIn("text/event-stream", reconnect["Content-Type"])
        finally:
            stream.close()

    def test_user_deactivation_closes_stream_at_next_delivery(self):
        stream, _ = self._open_stream(self.member)
        try:
            self.member.is_active = False
            self.member.save(update_fields=["is_active"])

            self._publish_project_event()
            with self.assertRaises(StopIteration):
                stream.next_frame()

            # The deactivated user's dead-identity reconnect is
            # rejected (401 through the middleware's anonymous
            # mapping; terminal for the client's recovery contract).
            reconnect = stream.client.get(EVENTS_URL)
            self.assertEqual(reconnect.status_code, 401)
        finally:
            stream.close()


class CommitRollbackTests(RealtimeTransportBase):
    """9. Committed vs rolled-back publication (real transactions)."""

    def test_rolled_back_publication_delivers_nothing(self):
        with mock.patch.object(
            realtime, "KEEPALIVE_INTERVAL_SECONDS", FAST_KEEPALIVE
        ):
            stream, _ = self._open_stream(self.owner)
            try:
                with self.assertRaises(RuntimeError):
                    with transaction.atomic():
                        publish_project_work_item_changed(self.project.pk)
                        raise RuntimeError("simulated post-write failure")

                # The rolled-back publication delivered nothing.
                frame = stream.next_frame()
                self.assertEqual(frame, ": ping\n\n")
                self.assertNotIn(str(self.project.pk), frame)
            finally:
                stream.close()

    def test_publisher_refuses_outside_active_transaction(self):
        # TransactionTestCase runs with autocommit: no active
        # transaction, so publication must fail loudly rather than
        # emit an immediately-visible notification.
        with self.assertRaises(RuntimeError):
            publish_project_work_item_changed(self.project.pk)
        with self.assertRaises(RuntimeError):
            publish_my_work_changed(self.owner.pk)


class ListenerFailureTests(RealtimeTransportBase):
    """11. A failed listener build never produces a seemingly
    successful stream."""

    def test_listener_open_failure_answers_5xx_before_stream_bytes(self):
        with mock.patch.object(
            realtime,
            "open_listener",
            side_effect=ListenerUnavailableError("simulated outage"),
        ):
            client = self._client(self.owner)
            response = client.get(EVENTS_URL)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("text/event-stream", response["Content-Type"])
        self.assertIn("error", response.json())

    def test_db_connect_failure_maps_to_5xx(self):
        with mock.patch.object(
            realtime.psycopg,
            "connect",
            side_effect=psycopg.OperationalError("connection refused"),
        ):
            client = self._client(self.owner)
            response = client.get(EVENTS_URL)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("text/event-stream", response["Content-Type"])


class ConnectionCleanupTests(RealtimeTransportBase):
    """10. The dedicated listener connection returns to baseline when
    the stream ends (verified against PostgreSQL itself)."""

    def test_listener_connection_closed_on_client_disconnect(self):
        baseline = self._listener_count()
        stream, _ = self._open_stream(self.owner)
        try:
            self.assertEqual(self._listener_count(), baseline + 1)
        finally:
            # Simulated client disconnect: the stream generator is
            # closed, receives GeneratorExit, and its cleanup path
            # closes the listener connection.
            stream.close()
        self.assertEqual(self._listener_count(), baseline)

    def test_listener_connection_closed_on_response_close(self):
        baseline = self._listener_count()
        stream, _ = self._open_stream(self.owner)
        try:
            self.assertEqual(self._listener_count(), baseline + 1)
            # The response-level resource closer releases the listener
            # even when the iterator is not fully consumed.
            stream.response.close()
        finally:
            stream.generator.close()
        self.assertEqual(self._listener_count(), baseline)


class PayloadParsingTests(SimpleTestCase):
    """The payload contract fails closed (no DB required)."""

    def test_valid_project_payload(self):
        self.assertEqual(
            realtime.parse_notification_payload(
                '{"scope": "project", "projectId": 7}'
            ),
            ("project", 7),
        )

    def test_valid_user_payload(self):
        self.assertEqual(
            realtime.parse_notification_payload('{"scope": "user", "userId": 9}'),
            ("user", 9),
        )

    def test_malformed_and_tampered_payloads_fail_closed(self):
        invalid = [
            None,
            123,
            b'{"scope": "project", "projectId": 1}',
            "{",
            "null",
            "[]",
            '"string"',
            '{"scope": "project"}',
            '{"scope": "user"}',
            '{"scope": "project", "projectId": "7"}',
            '{"scope": "project", "projectId": 7.5}',
            '{"scope": "project", "projectId": true}',
            '{"scope": "unknown", "projectId": 1}',
            '{"projectId": 1}',
            '{"scope": "project", "projectId": 1, "extra": "x"}',
            '{"scope": "project", "projectId": 1, "userId": 2}',
        ]
        for payload in invalid:
            self.assertIsNone(
                realtime.parse_notification_payload(payload), payload
            )
