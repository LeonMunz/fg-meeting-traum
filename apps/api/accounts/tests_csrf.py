"""Real CSRF enforcement and cookie contract tests.

Uses ``Client(enforce_csrf_checks=True)`` so Django's CsrfViewMiddleware
is genuinely active (ordinary test clients bypass CSRF). DRF views are
``csrf_exempt`` at the middleware level, so their CSRF checks come from
DRF SessionAuthentication — both paths are exercised here.
"""

from django.contrib.auth import get_user_model
from django.test import Client, TestCase

from .invitation_services import create_account_invitation
from .models import UserSession

User = get_user_model()

PASSWORD = "CsrfPass1!"
USERNAME = "csrfuser"


class RealCSRFEnforcementTest(TestCase):
    """Cookie possession alone must never authorize a mutation."""

    def setUp(self):
        self.user = User.objects.create_user(USERNAME, password=PASSWORD)
        self.client = Client(enforce_csrf_checks=True)

    def _login(self, client, with_token=True):
        client.get("/api/auth/csrf/")
        token = client.cookies["csrftoken"].value
        headers = {"HTTP_X_CSRFTOKEN": token} if with_token else {}
        return client.post(
            "/api/auth/login/",
            data={"username": USERNAME, "password": PASSWORD},
            content_type="application/json",
            **headers,
        )

    def test_login_without_csrf_is_rejected(self):
        response = self.client.post(
            "/api/auth/login/",
            data={"username": USERNAME, "password": PASSWORD},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)

    def test_login_with_csrf_succeeds(self):
        response = self._login(self.client)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

    def test_logout_without_csrf_is_rejected_and_session_survives(self):
        self._login(self.client)
        response = self.client.post(
            "/api/auth/logout/",
            data={},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
        # The failed mutation must not have logged the user out.
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

    def test_session_revocation_without_csrf_is_rejected(self):
        self._login(self.client)
        other = Client(enforce_csrf_checks=True)
        self._login(other)
        target = UserSession.objects.get(
            session_key=other.session.session_key
        ).public_id

        response = self.client.post(
            f"/api/auth/sessions/{target}/revoke/"
        )
        self.assertEqual(response.status_code, 403)
        # The other session is untouched.
        self.assertEqual(other.get("/api/auth/me/").status_code, 200)

        # With a valid token the same mutation succeeds.
        self.client.get("/api/auth/csrf/")
        token = self.client.cookies["csrftoken"].value
        response = self.client.post(
            f"/api/auth/sessions/{target}/revoke/",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(other.get("/api/auth/me/").status_code, 401)

    def test_revoke_others_without_csrf_is_rejected(self):
        self._login(self.client)
        other = Client(enforce_csrf_checks=True)
        self._login(other)

        response = self.client.post(
            "/api/auth/sessions/revoke-others/"
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(other.get("/api/auth/me/").status_code, 200)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

    def test_revoke_all_without_csrf_is_rejected(self):
        self._login(self.client)
        response = self.client.post("/api/auth/sessions/revoke-all/")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

    def test_authenticated_application_mutation_requires_csrf(self):
        """A cookie-authenticated mutation of an existing application
        endpoint fails without CSRF and succeeds with it."""
        self._login(self.client)

        response = self.client.post(
            "/api/research-groups/",
            data={"name": "Gamma"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

        self.client.get("/api/auth/csrf/")
        token = self.client.cookies["csrftoken"].value
        response = self.client.post(
            "/api/research-groups/",
            data={"name": "Gamma"},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 201)

class RegistrationPasswordPolicyCSRFTest(TestCase):
    """The non-consuming password-policy POST is CSRF-protected like the
    other public mutation-style auth endpoints (no csrf_exempt shortcut)."""

    def setUp(self):
        self.inviter = User.objects.create_user(
            username="policycsrfinviter",
            email="policycsrfinviter@example.com",
            password=PASSWORD,
        )
        self.invitation, self.token = create_account_invitation(
            actor=self.inviter, invited_email="policycsrf@example.com"
        )
        self.client = Client(enforce_csrf_checks=True)

    def _body(self):
        return {
            "token": self.token,
            "username": "policycsrfuser",
            "password": "PolicyPass1!",
        }

    def test_policy_post_without_csrf_is_rejected(self):
        response = self.client.post(
            "/api/auth/registration-password-policy/",
            data=self._body(),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    def test_policy_post_with_csrf_succeeds(self):
        self.client.get("/api/auth/csrf/")
        token = self.client.cookies["csrftoken"].value
        response = self.client.post(
            "/api/auth/registration-password-policy/",
            data=self._body(),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["valid"])
