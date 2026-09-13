"""Invite-only account registration behavioral tests.

Covers the registration / session / security matrix:
- a valid pending token creates exactly one normalized-email account and
  atomically accepts the invitation;
- the client cannot choose the email (a client-supplied email is rejected);
- no valid token (missing / invalid / expired / revoked / used / replaced)
  creates no User and does not consume a valid invitation;
- an existing (incl. inactive) matching normalized email blocks signup and
  leaves the invitation pending;
- weak password / duplicate username create no User and leave the
  invitation reusable;
- successful registration authenticates a normal revocable Django session
  (registered in UserSession, listed, revocable, logged out) and grants no
  ResearchGroup/Project membership;
- the new active account keeps the already-established right to create a
  ResearchGroup.

CSRF real-enforcement lives in ``tests_csrf.py`` (Client
``enforce_csrf_checks=True``); those endpoints use the same ``csrf_protect``
pattern as login, so plain ``APIClient`` calls here run without CSRF.
"""

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from projects.models import ProjectMembership
from research_groups.models import ResearchGroupMembership

from .invitation_services import create_account_invitation
from .models import AccountInvitation, UserSession

User = get_user_model()

REGISTER_URL = "/api/auth/register/"
PREVIEW_URL = "/api/auth/registration-invitation/"

# Strong, non-similar-to-username/email password (passes all configured
# Django validators).
PASSWORD = "Zebra!Correct99x"
INVITED_RAW = " Person@Example.COM "  # normalizes to person@example.com
INVITED = "person@example.com"


def _inviter():
    return User.objects.create_user(
        username="reginviter",
        email="reginviter@example.com",
        password=PASSWORD,
    )


def _token_for(email=INVITED_RAW, actor=None):
    """Create a pending invitation via the service and return (invitation,
    raw token). The inviter is created as a side effect when no actor is
    given, so capture any user-count baseline AFTER this call."""
    invitation, token = create_account_invitation(
        actor=actor or _inviter(), invited_email=email
    )
    return invitation, token


def _register(client, token, username="regnewuser", password=PASSWORD, email=None):
    body = {"token": token, "username": username, "password": password}
    if email is not None:
        body["email"] = email
    return client.post(
        REGISTER_URL, data=body, content_type="application/json"
    )


class RegistrationSuccessTest(APITestCase):
    """A valid pending token redeems into one normalized-email account."""

    def setUp(self):
        self.invitation, self.token = _token_for()
        self.users_before = User.objects.count()
        self.assertEqual(ResearchGroupMembership.objects.count(), 0)
        self.assertEqual(ProjectMembership.objects.count(), 0)

    def test_valid_token_creates_one_normalized_account(self):
        response = _register(self.client, self.token)
        self.assertEqual(response.status_code, 201)
        data = response.json()

        created = User.objects.get(pk=data["id"])
        self.assertEqual(created.email, INVITED)
        self.assertEqual(created.username, "regnewuser")
        self.assertIsNotNone(created.password)  # hashed, not plaintext
        self.assertNotEqual(created.password, PASSWORD)
        self.assertTrue(created.is_active)

        # Exactly one new user; email is the normalized invited email.
        self.assertEqual(User.objects.count(), self.users_before + 1)
        self.assertEqual(User.objects.filter(email=INVITED).count(), 1)

    def test_invitation_atomically_accepted_by_created_user(self):
        response = _register(self.client, self.token)
        self.assertEqual(response.status_code, 201)
        created = User.objects.get(pk=response.json()["id"])

        self.invitation.refresh_from_db()
        self.assertEqual(self.invitation.status, AccountInvitation.Status.ACCEPTED)
        self.assertEqual(self.invitation.accepted_by_id, created.pk)
        self.assertIsNotNone(self.invitation.accepted_at)

    def test_no_membership_or_access_created(self):
        response = _register(self.client, self.token)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(ResearchGroupMembership.objects.count(), 0)
        self.assertEqual(ProjectMembership.objects.count(), 0)
        self.assertEqual(
            ResearchGroupMembership.objects.filter(
                user_id=response.json()["id"]
            ).count(),
            0,
        )

    def test_browser_authenticated_immediately(self):
        response = _register(self.client, self.token)
        self.assertEqual(response.status_code, 201)
        me = self.client.get("/api/auth/me/")
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["email"], INVITED)
        self.assertEqual(me.json()["username"], "regnewuser")

    def test_new_account_can_create_research_group(self):
        """Existing authorization stays intact; no invite-derived permission."""
        response = _register(self.client, self.token)
        self.assertEqual(response.status_code, 201)
        created = User.objects.get(pk=response.json()["id"])
        self.assertEqual(
            self.client.post(
                "/api/research-groups/",
                data={"name": "Fresh Group"},
                content_type="application/json",
            ).status_code,
            201,
        )
        self.assertTrue(
            ResearchGroupMembership.objects.filter(
                user=created, role=ResearchGroupMembership.Role.ADMIN
            ).exists()
        )


class RegistrationFailureTest(APITestCase):
    """No valid token -> no User, and a valid invite is not consumed."""

    def test_registration_without_token_fails_and_creates_no_user(self):
        before = User.objects.count()
        response = self.client.post(
            REGISTER_URL,
            data={"username": "regnewuser", "password": PASSWORD},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["code"], "invalid_token")
        self.assertEqual(User.objects.count(), before)

    def test_invalid_token_fails_and_creates_no_user(self):
        before = User.objects.count()
        response = _register(
            self.client, "not-a-real-token", username="regnewuser"
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["code"], "invalid_token")
        self.assertEqual(User.objects.count(), before)

    def test_expired_token_fails_and_persists_expired(self):
        invitation, token = _token_for()
        invitation.expires_at = timezone.now() - timezone.timedelta(seconds=1)
        invitation.save(update_fields=["expires_at"])
        before = User.objects.count()

        response = _register(self.client, token)
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["code"], "expired")
        self.assertEqual(User.objects.count(), before)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.EXPIRED)

    def test_revoked_token_fails_and_creates_no_user(self):
        invitation, token = _token_for()
        # A second invitation for the same email revokes the first (system
        # replacement) — the original token is now terminal-revoked.
        replacement = create_account_invitation(
            actor=invitation.invited_by, invited_email=INVITED
        )[0]
        self.assertEqual(replacement.status, AccountInvitation.Status.PENDING)
        before = User.objects.count()

        response = _register(self.client, token)
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["code"], "revoked")
        self.assertEqual(User.objects.count(), before)

    def test_already_used_token_fails_and_creates_no_second_user(self):
        _invitation, token = _token_for()
        first = _register(self.client, token)
        self.assertEqual(first.status_code, 201)
        before = User.objects.count()

        second = _register(self.client, token)
        self.assertEqual(second.status_code, 410)
        self.assertEqual(second.json()["code"], "already_used")
        self.assertEqual(User.objects.count(), before)

    def test_replaced_old_token_fails_and_creates_no_user(self):
        inviter = _inviter()
        _invitation1, old_token = _token_for(actor=inviter)
        # A second invitation for the same email replaces (revokes) the first.
        _invitation2, _new_token = _token_for(actor=inviter)
        before = User.objects.count()

        response = _register(self.client, old_token)
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["code"], "revoked")
        self.assertEqual(User.objects.count(), before)

    def test_client_cannot_choose_email(self):
        invitation, token = _token_for()
        before = User.objects.count()
        response = _register(self.client, token, email="attacker@example.com")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(User.objects.count(), before)
        # The invitation is untouched and still usable for the real email.
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.PENDING)


class RegistrationCollisionTest(APITestCase):
    """Existing matching normalized email blocks duplicate signup."""

    def test_existing_normalized_email_blocks_and_invite_stays_pending(self):
        # An existing account holds the invited email in a case/whitespace
        # variant; the normalized comparison must still detect the collision.
        User.objects.create_user(
            username="existingperson",
            email="PERSON@EXAMPLE.COM",
            password=PASSWORD,
        )
        invitation, token = _token_for(INVITED_RAW)
        before = User.objects.count()

        response = _register(self.client, token)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "account_exists")
        self.assertEqual(User.objects.count(), before)

        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.PENDING)
        self.assertIsNone(invitation.accepted_by_id)

    def test_whitespace_variant_existing_email_blocks(self):
        User.objects.create_user(
            username="existingws",
            email="  person@example.com  ",
            password=PASSWORD,
        )
        _invitation, token = _token_for(INVITED_RAW)
        before = User.objects.count()

        response = _register(self.client, token)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(User.objects.count(), before)

    def test_inactive_existing_matching_account_also_blocks(self):
        User.objects.create_user(
            username="existinginactive",
            email=INVITED,
            password=PASSWORD,
            is_active=False,
        )
        _invitation, token = _token_for(INVITED_RAW)
        before = User.objects.count()

        response = _register(self.client, token)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "account_exists")
        # No duplicate created for the (inactive) account's email.
        self.assertEqual(User.objects.filter(email=INVITED).count(), 1)
        self.assertEqual(User.objects.count(), before)

    def test_existing_account_uses_login_plus_accept_instead(self):
        """The documented path for a collision: sign in, then accept."""
        existing = User.objects.create_user(
            username="existingperson", email=INVITED, password=PASSWORD
        )
        invitation, token = _token_for(INVITED_RAW)

        self.assertEqual(_register(self.client, token).status_code, 409)
        # The existing account can redeem via the existing acceptance flow.
        self.client.force_login(existing)
        resp = self.client.post(
            "/api/account-invitations/accept/",
            data={"token": token},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.ACCEPTED)
        self.assertEqual(invitation.accepted_by_id, existing.pk)
        # Still exactly one account for that email.
        self.assertEqual(User.objects.filter(email=INVITED).count(), 1)


class RegistrationCredentialValidationTest(APITestCase):
    """Invalid credentials create no User and leave the invitation reusable."""

    def test_weak_password_creates_no_user_and_invite_reusable(self):
        invitation, token = _token_for()
        before = User.objects.count()
        response = _register(self.client, token, password="short")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "password")
        self.assertEqual(User.objects.count(), before)

        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.PENDING)
        # The same invitation still works with a strong password.
        retry = _register(self.client, token, password=PASSWORD)
        self.assertEqual(retry.status_code, 201)

    def test_all_numeric_password_rejected(self):
        _invitation, token = _token_for()
        before = User.objects.count()
        response = _register(self.client, token, password="12345678")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "password")
        self.assertEqual(User.objects.count(), before)

    def test_duplicate_username_creates_no_user_and_invite_reusable(self):
        User.objects.create_user(
            username="regnewuser", email="someoneelse@example.com",
            password=PASSWORD,
        )
        invitation, token = _token_for()
        before = User.objects.count()
        response = _register(self.client, token)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "username")
        self.assertEqual(User.objects.count(), before)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.PENDING)

    def test_invalid_username_rejected(self):
        _invitation, token = _token_for()
        before = User.objects.count()
        response = _register(self.client, token, username="has space")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "username")
        self.assertEqual(User.objects.count(), before)


class RegistrationSessionTest(APITestCase):
    """Registration establishes a normal revocable Django session."""

    def setUp(self):
        self._invitation, self.token = _token_for()

    def _register_and_get_user(self):
        response = _register(self.client, self.token)
        self.assertEqual(response.status_code, 201)
        return User.objects.get(pk=response.json()["id"])

    def test_session_registered_in_usersession(self):
        created = self._register_and_get_user()
        rows = UserSession.objects.filter(user=created)
        self.assertEqual(rows.count(), 1)
        # The registered key is the live (post-rotation) session key.
        self.assertEqual(
            rows.first().session_key, self.client.session.session_key
        )

    def test_session_listed_as_current(self):
        self._register_and_get_user()
        data = self.client.get("/api/auth/sessions/").json()
        self.assertEqual(len(data["sessions"]), 1)
        self.assertTrue(data["sessions"][0]["isCurrent"])

    def test_registered_session_can_use_me(self):
        self._register_and_get_user()
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

    def test_revoke_registered_session_invalidates_browser(self):
        created = self._register_and_get_user()
        session_id = UserSession.objects.get(user=created).public_id
        self.assertEqual(
            self.client.post(
                f"/api/auth/sessions/{session_id}/revoke/"
            ).status_code,
            200,
        )
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)
        self.assertFalse(UserSession.objects.filter(user=created).exists())

    def test_revoke_others_and_revoke_all_still_work(self):
        created = self._register_and_get_user()
        self.assertEqual(
            self.client.post("/api/auth/sessions/revoke-others/").status_code,
            200,
        )
        # Current session survives revoke-others.
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)
        self.assertEqual(
            self.client.post("/api/auth/sessions/revoke-all/").status_code,
            200,
        )
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)

    def test_logout_invalidates_registered_session(self):
        created = self._register_and_get_user()
        self.assertEqual(
            self.client.post("/api/auth/logout/").status_code,
            200,
        )
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)
        self.assertFalse(UserSession.objects.filter(user=created).exists())


class RegistrationPreviewTest(APITestCase):
    """Non-consuming preview of a registration token."""

    def setUp(self):
        self.invitation, self.token = _token_for()
        self.users_before = User.objects.count()

    def _preview(self, token=None, client=None):
        client = client or self.client
        return client.post(
            PREVIEW_URL,
            data={"token": token if token is not None else self.token},
            content_type="application/json",
        )

    def test_preview_valid_pending_token(self):
        response = self._preview()
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "pending")
        self.assertTrue(data["usable"])
        self.assertEqual(data["invitedEmail"], INVITED)
        self.assertIs(False, data["accountExists"])
        self.assertIsNotNone(data["expiresAt"])

    def test_preview_does_not_consume_invitation(self):
        self.assertEqual(self._preview().status_code, 200)
        self.invitation.refresh_from_db()
        self.assertEqual(self.invitation.status, AccountInvitation.Status.PENDING)
        self.assertEqual(_register(self.client, self.token).status_code, 201)

    def test_preview_reports_existing_account(self):
        User.objects.create_user(
            username="previews", email=INVITED, password=PASSWORD
        )
        data = self._preview().json()
        self.assertTrue(data["accountExists"])
        # Still usable: the collision is reported, not enforced here.
        self.assertTrue(data["usable"])

    def test_preview_does_not_authenticate(self):
        self.assertEqual(self._preview().status_code, 200)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)
        self.assertEqual(User.objects.count(), self.users_before)

    def test_preview_expired_token_persists_expired(self):
        self.invitation.expires_at = timezone.now() - timezone.timedelta(seconds=1)
        self.invitation.save(update_fields=["expires_at"])
        response = self._preview()
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "expired")
        self.assertFalse(data["usable"])
        # Terminal: the invited email is not disclosed.
        self.assertNotIn("invitedEmail", data)
        self.invitation.refresh_from_db()
        self.assertEqual(self.invitation.status, AccountInvitation.Status.EXPIRED)

    def test_preview_unknown_token_is_not_found(self):
        response = self._preview(token="never-issued")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(User.objects.count(), self.users_before)


class RegistrationRealCSRFTest(TestCase):
    """Real CSRF enforcement for the unauthenticated registration POSTs."""

    def setUp(self):
        self.inviter = _inviter()
        self._invitation, self.token = _token_for(actor=self.inviter)
        self.client = Client(enforce_csrf_checks=True)

    def _csrf(self):
        self.client.get("/api/auth/csrf/")
        return self.client.cookies["csrftoken"].value

    def test_register_without_csrf_is_rejected_and_creates_no_user(self):
        before = User.objects.count()
        response = self.client.post(
            REGISTER_URL,
            data={"token": self.token, "username": "csrfnew", "password": PASSWORD},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(User.objects.count(), before)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)

    def test_register_with_csrf_succeeds_and_authenticates(self):
        token = self._csrf()
        response = self.client.post(
            REGISTER_URL,
            data={"token": self.token, "username": "csrfnew", "password": PASSWORD},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

    def test_preview_without_csrf_is_rejected(self):
        response = self.client.post(
            PREVIEW_URL, data={"token": self.token}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 403)

    def test_preview_with_csrf_succeeds(self):
        token = self._csrf()
        response = self.client.post(
            PREVIEW_URL,
            data={"token": self.token},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 200)
