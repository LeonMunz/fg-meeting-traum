from django.contrib.auth import get_user_model
from django.test import TestCase, Client
from rest_framework.test import APIClient, APITestCase

User = get_user_model()


class HealthEndpointTest(TestCase):
    """Verify the health endpoint remains public."""

    def setUp(self):
        self.client = Client()

    def test_health_is_public_without_auth(self):
        response = self.client.get('/api/health/')
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
        # Django sets the csrf cookie
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
        # Verify session is established via /me/
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

        Django's CsrfViewMiddleware enforces CSRF on unsafe methods.
        We use the Django test Client which enforces CSRF by default.
        """
        from django.test import Client
        django_client = Client()
        response = django_client.post(
            '/api/auth/login/',
            data={"username": "sessionuser", "password": "SessionPass1!"},
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 403)

    def test_logout_ends_session(self):
        csrf_token = self._get_csrf_token()
        # Login first
        self.client.post(
            '/api/auth/login/',
            data={"username": "sessionuser", "password": "SessionPass1!"},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        # Get a fresh CSRF token (login may have rotated the session)
        self.client.get('/api/auth/csrf/')
        csrf_token = self.client.cookies.get('csrftoken').value

        # Logout
        response = self.client.post(
            '/api/auth/logout/',
            data={},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(response.status_code, 200)

        # Verify session is gone
        response = self.client.get('/api/auth/me/')
        self.assertEqual(response.status_code, 401)


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
        # The /me/ endpoint does not accept a user ID parameter.
        # It must return the authenticated user, not a fake one.
        response = self.client.get(f'/api/auth/me/?userId={other_user.pk}')
        self.assertEqual(response.status_code, 200)
        # Returns the logged-in user, NOT the other user
        self.assertEqual(response.json()["username"], "meuser")


class ProtectedAPIDefaultTest(APITestCase):
    """Verify that protected APIs require authentication by default."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="protecteduser",
            password="ProtectedPass1!",
        )

    def test_unauthenticated_request_to_protected_endpoint_fails(self):
        """Any DRF endpoint without explicit AllowAny should require auth."""
        response = self.client.get('/api/auth/me/')
        self.assertEqual(response.status_code, 401)
