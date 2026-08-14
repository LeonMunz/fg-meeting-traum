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

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from rest_framework.test import APIClient, APITestCase

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
