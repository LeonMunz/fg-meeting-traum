"""Authentication and session tests.

Covers:
- Health endpoint remains public
- CSRF cookie endpoint
- Login with/without CSRF
- Logout with/without CSRF
- /me/ endpoint behavior
- Impersonation prevention
- Protected API default auth requirement
"""

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.test import Client, TestCase
from rest_framework.test import APIClient, APITestCase

from .models import UserSession

User = get_user_model()


class HealthEndpointTest(TestCase):
    """Verify the health endpoint remains public."""

    def test_health_is_public_without_auth(self):
        response = Client().get('/api/health/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})


class CSRFEndpointTest(APITestCase):
    """Verify CSRF cookie endpoint works."""

    def setUp(self):
        self.client = APIClient()

    def test_csrf_endpoint_is_public(self):
        response = self.client.get('/api/auth/csrf/')
        self.assertEqual(response.status_code, 200)

    def test_csrf_endpoint_sets_cookie(self):
        response = self.client.get('/api/auth/csrf/')
        self.assertIn('csrftoken', self.client.cookies)


class LoginLogoutTest(APITestCase):
    """Verify session login/logout flow with CSRF."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="sessionuser",
            password="SessionPass1!",
        )

    def _get_csrf_token(self):
        """Helper: obtain a CSRF token via the csrf endpoint."""
        self.client.get('/api/auth/csrf/')
        csrf_cookie = self.client.cookies.get('csrftoken')
        return csrf_cookie.value if csrf_cookie else ''

    def test_successful_login(self):
        csrf_token = self._get_csrf_token()
        response = self.client.post(
            '/api/auth/login/',
            data={"username": "sessionuser", "password": "SessionPass1!"},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["username"], "sessionuser")
        self.assertEqual(data["id"], self.user.pk)

    def test_login_creates_session(self):
        """After login, /api/auth/me/ should return the user."""
        csrf_token = self._get_csrf_token()
        self.client.post(
            '/api/auth/login/',
            data={"username": "sessionuser", "password": "SessionPass1!"},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        response = self.client.get('/api/auth/me/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["username"], "sessionuser")

    def test_invalid_password(self):
        csrf_token = self._get_csrf_token()
        response = self.client.post(
            '/api/auth/login/',
            data={"username": "sessionuser", "password": "WrongPass"},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn("error", response.json())

    def test_invalid_username(self):
        csrf_token = self._get_csrf_token()
        response = self.client.post(
            '/api/auth/login/',
            data={"username": "nonexistent", "password": "SomePass1!"},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 401)

    def test_login_without_csrf_is_rejected(self):
        """Login (POST) without CSRF token should be rejected (403).

        LoginView is protected by csrf_protect in urls.py.
        Django's Client with enforce_csrf_checks=True validates CSRF.
        """
        django_client = Client(enforce_csrf_checks=True)
        response = django_client.post(
            '/api/auth/login/',
            data={"username": "sessionuser", "password": "SessionPass1!"},
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 403)

    def test_logout_ends_session(self):
        csrf_token = self._get_csrf_token()
        self.client.post(
            '/api/auth/login/',
            data={"username": "sessionuser", "password": "SessionPass1!"},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.client.get('/api/auth/csrf/')
        csrf_token = self.client.cookies.get('csrftoken').value

        response = self.client.post(
            '/api/auth/logout/',
            data={},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)

        response = self.client.get('/api/auth/me/')
        self.assertEqual(response.status_code, 401)

    def test_logout_without_csrf_is_rejected(self):
        """Logout (POST) without CSRF token should be rejected (403).

        LogoutView is protected by csrf_protect in urls.py.
        We use Django's Client with enforce_csrf_checks=True and
        force_login() to simulate an authenticated user.
        """
        django_client = Client(enforce_csrf_checks=True)
        django_client.force_login(self.user)

        response = django_client.post(
            '/api/auth/logout/',
            data={},
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 403)


class MeEndpointTest(APITestCase):
    """Verify /api/auth/me/ behavior."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="meuser",
            first_name="Max",
            last_name="Mueller",
            email="max@example.com",
            password="MePass1!",
        )

    def _login(self):
        self.client.get('/api/auth/csrf/')
        csrf_token = self.client.cookies.get('csrftoken').value
        self.client.post(
            '/api/auth/login/',
            data={"username": "meuser", "password": "MePass1!"},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )

    def test_me_returns_current_user(self):
        self._login()
        response = self.client.get('/api/auth/me/')
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["id"], self.user.pk)
        self.assertEqual(data["username"], "meuser")
        self.assertEqual(data["firstName"], "Max")
        self.assertEqual(data["lastName"], "Mueller")
        self.assertEqual(data["email"], "max@example.com")

    def test_me_anonymous_returns_401(self):
        response = self.client.get('/api/auth/me/')
        self.assertEqual(response.status_code, 401)

    def test_me_does_not_expose_password(self):
        self._login()
        response = self.client.get('/api/auth/me/')
        data = response.json()
        self.assertNotIn("password", data)
        self.assertNotIn("is_superuser", data)

    def test_me_does_not_allow_impersonation(self):
        """A client-supplied user ID cannot impersonate another user."""
        other_user = User.objects.create_user(
            username="otheruser",
            password="OtherPass1!",
        )
        self._login()
        response = self.client.get(f'/api/auth/me/?userId={other_user.pk}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["username"], "meuser")


class ProtectedAPIDefaultTest(APITestCase):
    """Verify that protected APIs require authentication by default."""

    def setUp(self):
        self.client = APIClient()

    def test_unauthenticated_request_to_protected_endpoint_fails(self):
        response = self.client.get('/api/auth/me/')
        self.assertEqual(response.status_code, 401)


class InactiveLoginTest(APITestCase):
    """Inactive accounts must not authenticate."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="inactiveuser",
            password="InactivePass1!",
        )

    def test_inactive_user_login_fails(self):
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        response = self.client.post(
            '/api/auth/login/',
            data={
                "username": "inactiveuser",
                "password": "InactivePass1!",
            },
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 401)
        # No session was established for the inactive user.
        self.assertFalse(
            UserSession.objects.filter(user=self.user).exists()
        )


class SessionFixationAndLogoutTest(TestCase):
    """Session-fixation and server-side logout invalidation.

    Uses the plain Django Client for cookie-level precision (multiple
    independent "browsers" via separate Client instances).
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username="fixuser",
            password="FixPass1!",
        )

    def _login(self, client):
        client.get('/api/auth/csrf/')
        csrf_token = client.cookies['csrftoken'].value
        return client.post(
            '/api/auth/login/',
            data={"username": "fixuser", "password": "FixPass1!"},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )

    def test_login_rotates_the_pre_login_session_key(self):
        client = Client()
        # Establish a pre-login (anonymous) session with a real key.
        client.session.save()
        pre_login_key = client.session.session_key
        self.assertIsNotNone(pre_login_key)

        response = self._login(client)
        self.assertEqual(response.status_code, 200)
        post_login_key = client.session.session_key

        self.assertNotEqual(pre_login_key, post_login_key)
        # The pre-login session row is gone (Django flush + cycle).
        self.assertFalse(
            Session.objects.filter(pk=pre_login_key).exists()
        )
        # The registry points at the post-rotation key only.
        self.assertEqual(
            list(
                UserSession.objects.filter(user=self.user)
                .values_list("session_key", flat=True)
            ),
            [post_login_key],
        )

    def test_pre_login_session_cannot_authenticate_after_login(self):
        client = Client()
        client.session.save()
        pre_login_key = client.session.session_key
        response = self._login(client)
        self.assertEqual(response.status_code, 200)

        # A browser that still presents the pre-login session cookie is
        # anonymous.
        attacker = Client()
        attacker.cookies[settings.SESSION_COOKIE_NAME] = pre_login_key
        me = attacker.get('/api/auth/me/')
        self.assertEqual(me.status_code, 401)

    def test_login_response_does_not_expose_session_credential(self):
        client = Client()
        response = self._login(client)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertNotIn(client.session.session_key, str(body))
        self.assertNotIn("sessionKey", body)
        self.assertNotIn("session", body)

    def test_logout_invalidates_the_current_session_server_side(self):
        client = Client()
        self._login(client)
        session_key = client.session.session_key
        self.assertTrue(
            Session.objects.filter(pk=session_key).exists()
        )

        client.get('/api/auth/csrf/')
        csrf_token = client.cookies['csrftoken'].value
        response = client.post(
            '/api/auth/logout/',
            data={},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)

        # The Django session row and the registry row are both gone.
        self.assertFalse(
            Session.objects.filter(pk=session_key).exists()
        )
        self.assertFalse(
            UserSession.objects.filter(session_key=session_key).exists()
        )

    def test_logged_out_session_replay_cannot_authenticate(self):
        client = Client()
        self._login(client)
        session_key = client.session.session_key

        client.get('/api/auth/csrf/')
        csrf_token = client.cookies['csrftoken'].value
        client.post(
            '/api/auth/logout/',
            data={},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        # A browser replaying the logged-out session cookie is anonymous.
        replayer = Client()
        replayer.cookies[settings.SESSION_COOKIE_NAME] = session_key
        me = replayer.get('/api/auth/me/')
        self.assertEqual(me.status_code, 401)
        protected = replayer.get('/api/auth/sessions/')
        self.assertEqual(protected.status_code, 401)
