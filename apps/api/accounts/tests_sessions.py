"""Session registry and session-management tests.

Covers:
- registry model / migration agreement (registry rows, unique keys)
- multiple simultaneous sessions per user
- lazy registration via SessionRegistryMiddleware
- liveness filtering + dead-row pruning in list_user_sessions
- selected / all-others / all revocation (service + API level)
- cross-user non-leaking behavior
- no session credential leakage in API responses
"""

import uuid

from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from .models import UserSession
from .services import (
    list_user_sessions,
    register_user_session,
    revoke_all_sessions,
    revoke_other_sessions,
    revoke_user_session,
)

User = get_user_model()

PASSWORD = "SessionPass1!"


def _login(client, username, password=PASSWORD):
    """Log in through the real endpoint with CSRF, like the browser does."""
    client.get("/api/auth/csrf/")
    csrf_token = client.cookies["csrftoken"].value
    response = client.post(
        "/api/auth/login/",
        data={"username": username, "password": password},
        content_type="application/json",
        HTTP_X_CSRFTOKEN=csrf_token,
    )
    return response


class SessionRegistryModelTest(TestCase):
    """Registry model and migration agreement."""

    def setUp(self):
        self.user = User.objects.create_user("reguser", password=PASSWORD)

    def test_register_creates_one_row(self):
        register_user_session(self.user, "key-1")
        row = UserSession.objects.get(user=self.user, session_key="key-1")
        self.assertIsInstance(row.public_id, uuid.UUID)
        self.assertIsNotNone(row.created_at)

    def test_register_is_idempotent(self):
        register_user_session(self.user, "key-1")
        register_user_session(self.user, "key-1")
        self.assertEqual(
            UserSession.objects.filter(user=self.user).count(), 1
        )

    def test_multiple_sessions_per_user(self):
        for key in ("key-a", "key-b", "key-c"):
            register_user_session(self.user, key)
        self.assertEqual(
            UserSession.objects.filter(user=self.user).count(), 3
        )

    def test_session_key_is_unique(self):
        other = User.objects.create_user("regother", password=PASSWORD)
        register_user_session(self.user, "shared-key")
        with self.assertRaises(Exception):
            with __import__("django.db", fromlist=["transaction"]).transaction.atomic():
                UserSession.objects.create(
                    user=other,
                    session_key="shared-key",
                )

    def test_list_returns_only_live_sessions_and_prunes_dead(self):
        Session.objects.create(
            session_key="live-key",
            session_data="{}",
            expire_date=timezone.now() + timezone.timedelta(days=1),
        )
        Session.objects.create(
            session_key="dead-key",
            session_data="{}",
            expire_date=timezone.now() - timezone.timedelta(seconds=1),
        )
        register_user_session(self.user, "live-key")
        register_user_session(self.user, "dead-key")

        live_rows = list_user_sessions(self.user, current_session_key="live-key")
        self.assertEqual([r.session_key for r in live_rows], ["live-key"])
        # Dead registry row is pruned.
        self.assertFalse(
            UserSession.objects.filter(session_key="dead-key").exists()
        )

    def test_registry_row_without_django_session_is_not_active(self):
        register_user_session(self.user, "orphan-key")
        rows = list_user_sessions(self.user, current_session_key=None)
        self.assertEqual(rows, [])
        self.assertFalse(UserSession.objects.exists())

    def test_list_orders_newest_first(self):
        for key in ("older", "newer"):
            Session.objects.create(
                session_key=key,
                session_data="{}",
                expire_date=timezone.now() + timezone.timedelta(days=1),
            )
        register_user_session(self.user, "older")
        register_user_session(self.user, "newer")
        rows = list_user_sessions(self.user, current_session_key=None)
        self.assertEqual(
            [r.session_key for r in rows], ["newer", "older"]
        )


class MultiSessionLoginTest(APITestCase):
    """Multiple independent browsers of the same account."""

    def setUp(self):
        self.user = User.objects.create_user("multiuser", password=PASSWORD)
        self.browser_a = APIClient()
        self.browser_b = APIClient()
        self.browser_c = APIClient()

    def _login_all(self):
        for client in (self.browser_a, self.browser_b, self.browser_c):
            response = _login(client, "multiuser")
            self.assertEqual(response.status_code, 200)

    def test_three_logins_create_three_registry_rows(self):
        self._login_all()
        rows = UserSession.objects.filter(user=self.user)
        self.assertEqual(rows.count(), 3)
        # Registry keys agree with the Django session store.
        django_keys = set(
            Session.objects.filter(expire_date__gte=timezone.now())
            .values_list("session_key", flat=True)
        )
        self.assertEqual(set(rows.values_list("session_key", flat=True)), django_keys)

    def test_all_three_browsers_stay_authenticated(self):
        self._login_all()
        for client in (self.browser_a, self.browser_b, self.browser_c):
            response = client.get("/api/auth/me/")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                response.json()["username"], "multiuser"
            )

    def test_lazy_registration_for_session_created_outside_login_view(self):
        """Sessions established without the login endpoint (e.g. admin)
        get a registry row on the first authenticated request."""
        client = APIClient()
        client.force_login(self.user)
        response = client.get("/api/auth/me/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            UserSession.objects.filter(
                user=self.user,
                session_key=client.session.session_key,
            ).exists()
        )


def _public_id_for(client):
    """Registry public id of this browser's session (test-side lookup)."""
    row = UserSession.objects.get(session_key=client.session.session_key)
    return row.public_id


class SessionManagementAPITest(APITestCase):
    """Session-management API with three independent browsers of one user."""

    def setUp(self):
        self.user = User.objects.create_user("sesapiuser", password=PASSWORD)
        self.browser_a = APIClient()
        self.browser_b = APIClient()
        self.browser_c = APIClient()
        for client in (self.browser_a, self.browser_b, self.browser_c):
            response = _login(client, "sesapiuser")
            self.assertEqual(response.status_code, 200)

    def _me_status(self, client):
        return client.get("/api/auth/me/").status_code

    def test_anonymous_cannot_list_sessions(self):
        anon = APIClient()
        response = anon.get("/api/auth/sessions/")
        self.assertEqual(response.status_code, 401)

    def test_list_returns_only_own_sessions_with_metadata_only(self):
        response = self.browser_a.get("/api/auth/sessions/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        sessions = data["sessions"]
        self.assertEqual(len(sessions), 3)

        own_keys = {
            self.browser_a.session.session_key,
            self.browser_b.session.session_key,
            self.browser_c.session.session_key,
        }
        registry_rows = UserSession.objects.filter(user=self.user)
        for session in sessions:
            self.assertEqual(set(session.keys()), {"id", "createdAt", "isCurrent"})
            uuid.UUID(session["id"])  # raises if not a UUID
            # Raw Django session keys must never appear in the response.
        body = str(data)
        for key in own_keys:
            self.assertNotIn(key, body)

        current = [s for s in sessions if s["isCurrent"]]
        self.assertEqual(len(current), 1)
        self.assertEqual(
            current[0]["id"], str(_public_id_for(self.browser_a))
        )
        # The listing matches the user's live registry rows exactly.
        self.assertEqual(
            {s["id"] for s in sessions},
            {str(r.public_id) for r in registry_rows},
        )

    def test_revoke_selected_session_invalidates_only_that_browser(self):
        target_id = str(_public_id_for(self.browser_b))
        response = self.browser_a.post(f"/api/auth/sessions/{target_id}/revoke/")
        self.assertEqual(response.status_code, 200)

        self.assertEqual(self._me_status(self.browser_a), 200)
        self.assertEqual(self._me_status(self.browser_b), 401)
        self.assertEqual(self._me_status(self.browser_c), 200)

        # The Django session row of the revoked browser is gone.
        self.assertFalse(
            Session.objects.filter(
                pk=self.browser_b.session.session_key
            ).exists()
        )
        self.assertFalse(
            UserSession.objects.filter(
                session_key=self.browser_b.session.session_key
            ).exists()
        )

    def test_revoke_unknown_session_is_non_leaking_404(self):
        unknown = uuid.uuid4()
        response = self.browser_a.post(f"/api/auth/sessions/{unknown}/revoke/")
        self.assertEqual(response.status_code, 404)
        # Re-revoking an already-revoked id is the same non-leaking 404.
        target_id = str(_public_id_for(self.browser_b))
        first = self.browser_a.post(f"/api/auth/sessions/{target_id}/revoke/")
        self.assertEqual(first.status_code, 200)
        second = self.browser_a.post(f"/api/auth/sessions/{target_id}/revoke/")
        self.assertEqual(second.status_code, 404)
        self.assertEqual(first.json(), {"detail": "Session revoked"})
        self.assertEqual(second.json(), {"error": "Session not found"})

    def test_revoke_others_keeps_current_session(self):
        response = self.browser_a.post("/api/auth/sessions/revoke-others/")
        self.assertEqual(response.status_code, 200)

        self.assertEqual(self._me_status(self.browser_a), 200)
        self.assertEqual(self._me_status(self.browser_b), 401)
        self.assertEqual(self._me_status(self.browser_c), 401)

        # The current session still sees exactly one session (itself).
        listing = self.browser_a.get("/api/auth/sessions/").json()["sessions"]
        self.assertEqual(len(listing), 1)
        self.assertTrue(listing[0]["isCurrent"])

    def test_revoke_all_includes_current_session(self):
        response = self.browser_a.post("/api/auth/sessions/revoke-all/")
        self.assertEqual(response.status_code, 200)

        self.assertEqual(self._me_status(self.browser_a), 401)
        self.assertEqual(self._me_status(self.browser_b), 401)
        self.assertEqual(self._me_status(self.browser_c), 401)
        self.assertFalse(UserSession.objects.filter(user=self.user).exists())

    def test_revoke_all_then_fresh_login_only_new_session_survives(self):
        self.browser_a.post("/api/auth/sessions/revoke-all/")
        self.assertEqual(self._me_status(self.browser_b), 401)

        # A new browser B login after revoke-all works and is isolated.
        self.browser_b = APIClient()
        _login(self.browser_b, "sesapiuser")
        self.assertEqual(self._me_status(self.browser_b), 200)
        listing = self.browser_b.get("/api/auth/sessions/").json()["sessions"]
        self.assertEqual(len(listing), 1)


class CrossUserSessionAccessTest(APITestCase):
    """Users can inspect/revoke only their own sessions (non-leaking)."""

    def setUp(self):
        self.user_one = User.objects.create_user("xuser1", password=PASSWORD)
        self.user_two = User.objects.create_user("xuser2", password=PASSWORD)
        self.browser_one = APIClient()
        self.browser_two = APIClient()
        self.assertEqual(_login(self.browser_one, "xuser1").status_code, 200)
        self.assertEqual(_login(self.browser_two, "xuser2").status_code, 200)

    def test_cannot_list_other_users_sessions(self):
        sessions = self.browser_one.get("/api/auth/sessions/").json()["sessions"]
        self.assertEqual(len(sessions), 1)
        self.assertEqual(
            sessions[0]["id"], str(_public_id_for(self.browser_one))
        )

    def test_cannot_revoke_other_users_session_non_leaking(self):
        foreign_id = str(_public_id_for(self.browser_two))
        response = self.browser_one.post(
            f"/api/auth/sessions/{foreign_id}/revoke/"
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            response.json(), {"error": "Session not found"}
        )
        # The foreign session is untouched.
        self.assertEqual(self.browser_two.get("/api/auth/me/").status_code, 200)
        self.assertEqual(
            self.browser_two.get("/api/auth/sessions/").json()["sessions"][0][
                "id"
            ],
            foreign_id,
        )

    def test_revoke_others_and_revoke_all_never_touch_other_users(self):
        self.browser_one.post("/api/auth/sessions/revoke-others/")
        self.browser_two.post("/api/auth/sessions/revoke-all/")
        # user_one still fully authenticated after both operations.
        self.assertEqual(self.browser_one.get("/api/auth/me/").status_code, 200)
        self.assertEqual(
            self.browser_one.get("/api/auth/sessions/").json()["sessions"][0][
                "isCurrent"
            ],
            True,
        )


class InactiveSessionBehaviorTest(TestCase):
    """An already-authenticated session ceases to be authenticated the
    moment the account becomes inactive (no Membership changes, no
    offboarding)."""

    def setUp(self):
        from django.test import Client

        self.user = User.objects.create_user(
            "deactuser", password="DeactPass1!"
        )
        self.client = Client()

    def _login(self):
        self.client.get("/api/auth/csrf/")
        token = self.client.cookies["csrftoken"].value
        return self.client.post(
            "/api/auth/login/",
            data={"username": "deactuser", "password": "DeactPass1!"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )

    def test_inactive_account_loses_authenticated_access_on_unchanged_session(self):
        # 1. Active user logs in.
        self.assertEqual(self._login().status_code, 200)

        # 2. The session successfully accesses protected endpoints.
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)
        self.assertEqual(
            self.client.get("/api/auth/sessions/").status_code, 200
        )
        session_key = self.client.session.session_key

        # 3. The account becomes inactive server-side.
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])

        # 4. The same unchanged browser session retries.
        self.assertEqual(
            self.client.get("/api/auth/me/").status_code, 401
        )
        self.assertEqual(
            self.client.get("/api/auth/sessions/").status_code, 401
        )
        self.assertEqual(
            self.client.get("/api/research-groups/").status_code, 401
        )

        # The session row remains (revocation is not deactivation); it
        # simply no longer authenticates, and no registry row is created
        # for the inactive account.
        self.assertTrue(
            Session.objects.filter(pk=session_key).exists()
        )
        self.assertEqual(
            UserSession.objects.filter(user=self.user).count(), 1
        )
