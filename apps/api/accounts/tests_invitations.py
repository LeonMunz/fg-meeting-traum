"""Account invitation behavioral tests.

Covers:
- creation (normalization, 7-day expiry, one-time raw token, no raw
  token persisted)
- duplicate-pending rejection (exact / case / whitespace variants; the
  original invitation and its token stay fully usable; no membership is
  created) and the revoked / expired / effectively-expired paths that
  allow a new invitation
- listing (own only, no secrets, effective state)
- revocation (own only, non-leaking 404)
- acceptance (existing-account flow, no account or membership creation)
- security: unauthenticated / inactive denial, mismatched email,
  expired / revoked / already-accepted tokens
- real CSRF enforcement on all mutation endpoints
"""

import hashlib
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from projects.models import ProjectMembership
from research_groups.models import ResearchGroupMembership

from .invitation_services import (
    digest_invitation_token,
    generate_invitation_token,
    normalize_invitation_email,
)
from .models import AccountInvitation

User = get_user_model()

PASSWORD = "InvitePass1!"
LIST_URL = "/api/account-invitations/"
ACCEPT_URL = "/api/account-invitations/accept/"


def _login(client, username, password=PASSWORD):
    """Log in through the real endpoint with CSRF, like the browser does."""
    client.get("/api/auth/csrf/")
    csrf_token = client.cookies["csrftoken"].value
    return client.post(
        "/api/auth/login/",
        data={"username": username, "password": password},
        content_type="application/json",
        HTTP_X_CSRFTOKEN=csrf_token,
    )


def _revoke_url(public_id):
    return f"/api/account-invitations/{public_id}/revoke/"


# Non-account target used by creation tests: nobody with this email has a
# User account, so the existing-account guard does not apply.
TARGET = "dup_target@example.com"


def _historical_token_for(inviter, email):
    """Create a pre-existing PENDING AccountInvitation record directly.

    The production creation endpoint rejects emails that already belong
    to an account, so the existing-account redemption tests (preview /
    acceptance / wrong-account guard) need an invitation record that
    predates that rule. This fixture helper writes that historical record
    at the domain level with the canonical token/normalization helpers —
    it is not a bypass of the production creation endpoint.
    """
    token = generate_invitation_token()
    invitation = AccountInvitation.objects.create(
        invited_by=inviter,
        invited_email=normalize_invitation_email(email),
        token_digest=digest_invitation_token(token),
        status=AccountInvitation.Status.PENDING,
        expires_at=timezone.now() + timedelta(days=7),
    )
    return invitation, token


class CreateInvitationTest(APITestCase):
    """An active account invites a global account by email."""

    def setUp(self):
        self.inviter = User.objects.create_user(
            "inviter", email="inviter@example.com", password=PASSWORD
        )
        self.assertEqual(_login(self.client, "inviter").status_code, 200)

    def _create(self, target_email):
        return self.client.post(
            LIST_URL,
            data={"targetEmail": target_email},
            content_type="application/json",
        )

    def test_create_invitation_normalizes_email_and_returns_token_once(self):
        response = self._create(" Person@Example.COM ")
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertEqual(data["invitedEmail"], "person@example.com")
        self.assertEqual(data["status"], "pending")
        token = data["token"]
        self.assertTrue(token)

        row = AccountInvitation.objects.get(invited_by=self.inviter)
        self.assertEqual(row.invited_email, "person@example.com")
        self.assertEqual(row.status, AccountInvitation.Status.PENDING)
        self.assertEqual(row.token_digest, digest_invitation_token(token))
        self.assertIsNotNone(row.public_id)
        self.assertIsNotNone(row.created_at)
        self.assertIsNotNone(row.expires_at)
        self.assertIsNone(row.accepted_at)
        self.assertIsNone(row.accepted_by_id)
        self.assertIsNone(row.revoked_at)

        # The raw token is not persisted anywhere on the model.
        self.assertNotIn(token, row.token_digest)
        self.assertNotIn(token, str(row))
        self.assertNotIn(token, str(row.public_id))
        self.assertNotIn(token, repr(row))

        # The token is returned exactly once: the list never exposes it
        # or its digest.
        list_body = self.client.get(LIST_URL).content.decode()
        self.assertNotIn(token, list_body)
        self.assertNotIn(row.token_digest, list_body)

    def test_invitation_expires_exactly_seven_days_after_creation(self):
        response = self._create("new@example.com")
        self.assertEqual(response.status_code, 201)
        row = AccountInvitation.objects.get(invited_by=self.inviter)
        self.assertEqual(row.expires_at - row.created_at, timedelta(days=7))

    def test_create_requires_a_valid_email(self):
        for target in ("not-an-email", "", "   "):
            response = self._create(target)
            self.assertEqual(response.status_code, 400, target)
        response = self.client.post(
            LIST_URL, data={}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(AccountInvitation.objects.exists())

    def test_unauthenticated_cannot_create_list_revoke_or_accept(self):
        anonymous = APIClient()
        self.assertEqual(anonymous.get(LIST_URL).status_code, 401)
        self.assertEqual(
            anonymous.post(
                LIST_URL,
                data={"targetEmail": "x@example.com"},
                content_type="application/json",
            ).status_code,
            401,
        )
        self.assertEqual(
            anonymous.post(
                _revoke_url(str(uuid.uuid4())),
                content_type="application/json",
            ).status_code,
            401,
        )
        self.assertEqual(
            anonymous.post(
                ACCEPT_URL,
                data={"token": "whatever"},
                content_type="application/json",
            ).status_code,
            401,
        )
        self.assertFalse(AccountInvitation.objects.exists())

    def test_inactive_account_cannot_create_invitation(self):
        self.inviter.is_active = False
        self.inviter.save(update_fields=["is_active"])
        response = self._create("new@example.com")
        self.assertEqual(response.status_code, 401)
        self.assertFalse(AccountInvitation.objects.exists())

    def test_inactive_session_cannot_accept_invitation(self):
        # Historical invitation record for the inviter's own account
        # email (the production create endpoint now rejects account
        # emails with account_exists).
        _invitation, token = _historical_token_for(self.inviter, "inviter@example.com")

        self.inviter.is_active = False
        self.inviter.save(update_fields=["is_active"])

        response = self.client.post(
            ACCEPT_URL, data={"token": token}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 401)

        row = AccountInvitation.objects.get(invited_by=self.inviter)
        self.assertEqual(row.status, AccountInvitation.Status.PENDING)


class DuplicatePendingInvitationTest(APITestCase):
    """An effective pending invitation blocks duplicate creation.

    All creation tests here target a non-account email (TARGET): the
    existing-account guard (which answers account emails with
    account_exists before the pending check) is covered separately in
    ``ExistingAccountInvitationTest``.
    """

    def setUp(self):
        self.inviter = User.objects.create_user(
            "dup_inviter", email="dup_inviter@example.com", password=PASSWORD
        )
        self.invitee = User.objects.create_user(
            "dup_invitee", email="dup_invitee@example.com", password=PASSWORD
        )
        self.assertEqual(_login(self.client, "dup_inviter").status_code, 200)

    def _create(self, target_email=TARGET):
        return self.client.post(
            LIST_URL,
            data={"targetEmail": target_email},
            content_type="application/json",
        )

    def _snapshot(self, public_id):
        row = AccountInvitation.objects.get(public_id=public_id)
        return (
            row.status,
            row.token_digest,
            row.expires_at,
            row.created_at,
            row.revoked_at,
            row.accepted_at,
            row.accepted_by_id,
        )

    def test_first_invitation_succeeds_and_duplicate_is_rejected(self):
        first = self._create()
        self.assertEqual(first.status_code, 201)
        public_id = first.json()["id"]

        second = self._create()
        self.assertEqual(second.status_code, 409)
        data = second.json()
        self.assertEqual(data["code"], "pending_invitation_exists")
        self.assertTrue(data["error"])

        # No second invitation was created.
        self.assertEqual(
            AccountInvitation.objects.filter(invited_email=TARGET).count(),
            1,
        )
        row = AccountInvitation.objects.get(public_id=public_id)
        self.assertEqual(row.status, AccountInvitation.Status.PENDING)

    def test_case_variant_is_rejected(self):
        self.assertEqual(self._create().status_code, 201)
        response = self._create("DUP_TARGET@Example.COM")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "pending_invitation_exists")
        self.assertEqual(
            AccountInvitation.objects.filter(invited_email=TARGET).count(),
            1,
        )

    def test_whitespace_variant_is_rejected(self):
        self.assertEqual(self._create("  dup_target@example.com  ").status_code, 201)
        response = self._create("dup_target@example.com\t")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "pending_invitation_exists")
        self.assertEqual(
            AccountInvitation.objects.filter(invited_email=TARGET).count(),
            1,
        )

    def test_duplicate_rejection_leaves_original_invitation_unchanged(self):
        first = self._create()
        self.assertEqual(first.status_code, 201)
        before = self._snapshot(first.json()["id"])

        self.assertEqual(self._create().status_code, 409)

        # Status, token digest, expiry, creation timestamp, and the
        # revocation/acceptance fields are all untouched.
        self.assertEqual(self._snapshot(first.json()["id"]), before)

    def test_duplicate_rejection_keeps_original_token_usable(self):
        _invitation, first_token = _historical_token_for(self.inviter, TARGET)
        self.assertEqual(self._create().status_code, 409)

        # The original token still previews successfully.
        preview = self.client.post(
            "/api/auth/registration-invitation/",
            data={"token": first_token},
            content_type="application/json",
        )
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.json()["status"], "pending")
        self.assertTrue(preview.json()["usable"])

        # ...and can still be used through the normal registration flow.
        register = self.client.post(
            "/api/auth/register/",
            data={
                "token": first_token,
                "username": "dup_target_user",
                "password": "Zebra!Correct99x",
            },
            content_type="application/json",
        )
        self.assertEqual(register.status_code, 201)
        row = AccountInvitation.objects.get(invited_by=self.inviter)
        self.assertEqual(
            row.status, AccountInvitation.Status.ACCEPTED
        )
        self.assertEqual(
            row.accepted_by_id, User.objects.get(username="dup_target_user").pk
        )

    def test_duplicate_rejection_creates_no_membership(self):
        self.assertEqual(self._create().status_code, 201)
        self.assertEqual(self._create().status_code, 409)
        self.assertEqual(ResearchGroupMembership.objects.count(), 0)
        self.assertEqual(ProjectMembership.objects.count(), 0)

    def test_revoked_invitation_allows_new_invitation(self):
        first = self._create()
        self.assertEqual(first.status_code, 201)
        self.assertEqual(
            self.client.post(_revoke_url(first.json()["id"])).status_code, 200
        )

        second = self._create()
        self.assertEqual(second.status_code, 201)
        rows = sorted(
            AccountInvitation.objects.filter(invited_by=self.inviter),
            key=lambda row: row.created_at,
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].status, AccountInvitation.Status.REVOKED)
        self.assertEqual(rows[1].status, AccountInvitation.Status.PENDING)

    def test_expired_invitation_allows_new_invitation(self):
        first = self._create()
        self.assertEqual(first.status_code, 201)
        row = AccountInvitation.objects.get(public_id=first.json()["id"])
        row.expires_at = timezone.now() - timedelta(seconds=1)
        row.save(update_fields=["expires_at"])
        # The revoke attempt persists the terminal EXPIRED transition.
        self.assertEqual(
            self.client.post(_revoke_url(row.public_id)).status_code, 404
        )
        row.refresh_from_db()
        self.assertEqual(row.status, AccountInvitation.Status.EXPIRED)

        second = self._create()
        self.assertEqual(second.status_code, 201)
        self.assertEqual(
            AccountInvitation.objects.filter(
                invited_by=self.inviter,
                status=AccountInvitation.Status.PENDING,
            ).count(),
            1,
        )

    def test_effectively_expired_pending_does_not_block_creation(self):
        self.assertEqual(self._create().status_code, 201)
        row = AccountInvitation.objects.get(invited_by=self.inviter)
        row.expires_at = timezone.now() - timedelta(seconds=1)
        row.save(update_fields=["expires_at"])

        second = self._create()
        self.assertEqual(second.status_code, 201)
        # The effectively expired PENDING row is persisted as EXPIRED by
        # the creation operation; exactly one PENDING row remains.
        row.refresh_from_db()
        self.assertEqual(row.status, AccountInvitation.Status.EXPIRED)
        self.assertEqual(
            AccountInvitation.objects.filter(
                invited_by=self.inviter,
                status=AccountInvitation.Status.PENDING,
            ).count(),
            1,
        )


class ExistingAccountInvitationTest(APITestCase):
    """The create endpoint rejects emails that already belong to an account.

    The guard reuses the canonical normalized lookup (trim + lowercase),
    answers ``account_exists`` with the canonical 409 discriminator (the
    same status registration already uses for this code), and takes
    precedence over ``pending_invitation_exists``. Already-existing
    invitation records for account emails are still redeemed through the
    existing preview/acceptance flow.
    """

    def setUp(self):
        self.inviter = User.objects.create_user(
            "acct_inviter", email="acct_inviter@example.com", password=PASSWORD
        )
        self.existing = User.objects.create_user(
            "acct_existing",
            email="acct_existing@example.com",
            password=PASSWORD,
        )
        self.assertEqual(_login(self.client, "acct_inviter").status_code, 200)

    def _create(self, target_email="acct_existing@example.com"):
        return self.client.post(
            LIST_URL,
            data={"targetEmail": target_email},
            content_type="application/json",
        )

    def test_existing_account_email_is_rejected_with_account_exists(self):
        response = self._create()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "account_exists")
        self.assertTrue(response.json()["error"])
        # No invitation row and no raw token in the response.
        self.assertFalse(AccountInvitation.objects.exists())
        self.assertNotIn("token", response.json())

    def test_case_variant_existing_account_is_rejected(self):
        response = self._create("ACCT_EXISTING@Example.COM")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "account_exists")
        self.assertFalse(AccountInvitation.objects.exists())

    def test_whitespace_variant_existing_account_is_rejected(self):
        response = self._create("  acct_existing@example.com  ")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "account_exists")
        self.assertFalse(AccountInvitation.objects.exists())

    def test_inactive_existing_account_is_rejected(self):
        self.existing.is_active = False
        self.existing.save(update_fields=["is_active"])
        response = self._create()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "account_exists")
        self.assertFalse(AccountInvitation.objects.exists())

    def test_account_exists_takes_precedence_over_pending(self):
        # A historical pending invitation for the same (account) email
        # exists; creation must answer account_exists, not
        # pending_invitation_exists, and leave the old record untouched.
        _invitation, _token = _historical_token_for(
            self.inviter, "acct_existing@example.com"
        )
        snapshot = (
            AccountInvitation.objects.get(invited_by=self.inviter).status,
            AccountInvitation.objects.get(invited_by=self.inviter).token_digest,
        )
        response = self._create()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "account_exists")
        self.assertEqual(AccountInvitation.objects.count(), 1)
        row = AccountInvitation.objects.get(invited_by=self.inviter)
        self.assertEqual((row.status, row.token_digest), snapshot)

    def test_historical_invitation_for_account_still_redeemed(self):
        # Pre-existing invitation record for an account email: preview
        # and the existing-account acceptance flow keep working.
        _invitation, token = _historical_token_for(
            self.inviter, "acct_existing@example.com"
        )
        preview = self.client.post(
            "/api/auth/registration-invitation/",
            data={"token": token},
            content_type="application/json",
        )
        self.assertEqual(preview.status_code, 200)
        data = preview.json()
        self.assertEqual(data["status"], "pending")
        self.assertTrue(data["usable"])
        self.assertTrue(data["accountExists"])

        existing_client = APIClient()
        _login(existing_client, "acct_existing")
        response = existing_client.post(
            ACCEPT_URL, data={"token": token}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 200)
        row = AccountInvitation.objects.get(invited_by=self.inviter)
        self.assertEqual(row.status, AccountInvitation.Status.ACCEPTED)
        self.assertEqual(row.accepted_by_id, self.existing.pk)

    def test_rejection_creates_no_membership(self):
        self.assertEqual(self._create().status_code, 409)
        self.assertEqual(ResearchGroupMembership.objects.count(), 0)
        self.assertEqual(ProjectMembership.objects.count(), 0)


class ListInvitationsTest(APITestCase):
    """Listing is own-invitations only and exposes no secrets."""

    def setUp(self):
        self.user_a = User.objects.create_user(
            "list_a", email="list_a@example.com", password=PASSWORD
        )
        self.user_b = User.objects.create_user(
            "list_b", email="list_b@example.com", password=PASSWORD
        )
        self.assertEqual(_login(self.client, "list_a").status_code, 200)

        created = self.client.post(
            LIST_URL,
            data={"targetEmail": "a-target@example.com"},
            content_type="application/json",
        )
        self.created_token = created.json()["token"]
        self.created_id = created.json()["id"]

        other_client = APIClient()
        _login(other_client, "list_b")
        other_created = other_client.post(
            LIST_URL,
            data={"targetEmail": "b-target@example.com"},
            content_type="application/json",
        )
        self.other_id = other_created.json()["id"]

    def test_list_returns_only_own_invitations_with_effective_state(self):
        response = self.client.get(LIST_URL)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        ids = [item["id"] for item in data["invitations"]]
        self.assertEqual(ids, [self.created_id])
        self.assertEqual(data["invitations"][0]["status"], "pending")
        self.assertEqual(
            data["invitations"][0]["invitedEmail"], "a-target@example.com"
        )

        # No secrets leak: neither the raw token nor the digest.
        body = response.content.decode()
        self.assertNotIn(self.created_token, body)
        self.assertNotIn(
            digest_invitation_token(self.created_token), body
        )

    def test_expired_pending_is_reported_expired_in_list(self):
        row = AccountInvitation.objects.get(public_id=self.created_id)
        row.expires_at = timezone.now() - timedelta(seconds=1)
        row.save(update_fields=["expires_at"])

        data = self.client.get(LIST_URL).json()
        self.assertEqual(data["invitations"][0]["status"], "expired")
        # The list evaluates state and persists the EXPIRED transition.
        row.refresh_from_db()
        self.assertEqual(row.status, AccountInvitation.Status.EXPIRED)


class RevokeInvitationTest(APITestCase):
    """Only the original inviter can revoke, and only while pending."""

    def setUp(self):
        # The inviter's own (normalized) email is the invited email, so the
        # same authenticated session is the matching-email acceptor.
        self.inviter = User.objects.create_user(
            "revoke_a", email="revoke-target@example.com", password=PASSWORD
        )
        self.other = User.objects.create_user(
            "revoke_b", email="revoke_b@example.com", password=PASSWORD
        )
        self.assertEqual(_login(self.client, "revoke_a").status_code, 200)
        # Historical invitation record for an existing account: the
        # production create endpoint now rejects account emails with
        # account_exists, so the record is written directly.
        created, self.token = _historical_token_for(
            self.inviter, "revoke-target@example.com"
        )
        self.public_id = created.public_id

    def test_inviter_can_revoke_own_pending_invitation(self):
        response = self.client.post(_revoke_url(self.public_id))
        self.assertEqual(response.status_code, 200)
        row = AccountInvitation.objects.get(public_id=self.public_id)
        self.assertEqual(row.status, AccountInvitation.Status.REVOKED)
        self.assertIsNotNone(row.revoked_at)

        # The revoked token is immediately unusable.
        response = self.client.post(
            ACCEPT_URL, data={"token": self.token}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 404)

        # Re-revoking is the same non-leaking 404.
        response = self.client.post(_revoke_url(self.public_id))
        self.assertEqual(response.status_code, 404)

    def test_other_user_cannot_revoke_and_gets_non_leaking_404(self):
        other_client = APIClient()
        _login(other_client, "revoke_b")
        response = other_client.post(_revoke_url(self.public_id))
        self.assertEqual(response.status_code, 404)

        row = AccountInvitation.objects.get(public_id=self.public_id)
        self.assertEqual(row.status, AccountInvitation.Status.PENDING)

        # Unknown ids answer the identical 404.
        response = other_client.post(_revoke_url(str(uuid.uuid4())))
        self.assertEqual(response.status_code, 404)

    def test_expired_invitation_cannot_be_manually_revoked(self):
        row = AccountInvitation.objects.get(public_id=self.public_id)
        row.expires_at = timezone.now() - timedelta(seconds=1)
        row.save(update_fields=["expires_at"])

        response = self.client.post(_revoke_url(self.public_id))
        self.assertEqual(response.status_code, 404)
        row.refresh_from_db()
        self.assertEqual(row.status, AccountInvitation.Status.EXPIRED)


class AcceptInvitationTest(APITestCase):
    """Existing-account acceptance: bind token to the matching account."""

    def setUp(self):
        self.inviter = User.objects.create_user(
            "accept_a", email="accept_a@example.com", password=PASSWORD
        )
        self.invitee = User.objects.create_user(
            "accept_b", email="accept_b@example.com", password=PASSWORD
        )
        self._login_inviter()

    def _login_inviter(self):
        self.client = APIClient()
        _login(self.client, "accept_a")

    def _create_for(self, email="accept_b@example.com"):
        # Pre-existing invitation record for the existing account (the
        # production create endpoint no longer creates invitations for
        # account emails); the behavior under test is the redemption
        # flow itself.
        _invitation, token = _historical_token_for(self.inviter, email)
        return token

    def _accept(self, token, username="accept_b"):
        client = APIClient()
        _login(client, username)
        return client.post(
            ACCEPT_URL, data={"token": token}, content_type="application/json"
        )

    def test_matching_email_accepts_and_persists_atomically(self):
        token = self._create_for()
        users_before = User.objects.count()
        self.assertEqual(ResearchGroupMembership.objects.count(), 0)
        self.assertEqual(ProjectMembership.objects.count(), 0)

        response = self._accept(token)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "accepted")
        self.assertEqual(data["acceptedUserId"], self.invitee.pk)

        row = AccountInvitation.objects.get(invited_by=self.inviter)
        self.assertEqual(row.status, AccountInvitation.Status.ACCEPTED)
        self.assertEqual(row.accepted_by_id, self.invitee.pk)
        self.assertIsNotNone(row.accepted_at)

        # No new account and no membership of any kind is created.
        self.assertEqual(User.objects.count(), users_before)
        self.assertEqual(ResearchGroupMembership.objects.count(), 0)
        self.assertEqual(ProjectMembership.objects.count(), 0)

    def test_second_acceptance_fails(self):
        token = self._create_for()
        self.assertEqual(self._accept(token).status_code, 200)
        self.assertEqual(self._accept(token).status_code, 404)

    def test_mismatched_email_cannot_accept(self):
        token = self._create_for("accept_b@example.com")
        other = User.objects.create_user(
            "accept_c", email="accept_c@example.com", password=PASSWORD
        )
        response = self._accept(token, username="accept_c")
        self.assertEqual(response.status_code, 400)

        row = AccountInvitation.objects.get(invited_by=self.inviter)
        self.assertEqual(row.status, AccountInvitation.Status.PENDING)
        self.assertIsNone(row.accepted_by_id)

    def test_normalized_email_match_ignores_case_and_whitespace(self):
        token = self._create_for(" ACCEPT_B@EXAMPLE.COM ")
        self.assertEqual(self._accept(token).status_code, 200)

    def test_expired_invitation_cannot_be_accepted(self):
        token = self._create_for()
        row = AccountInvitation.objects.get(invited_by=self.inviter)
        row.expires_at = timezone.now() - timedelta(seconds=1)
        row.save(update_fields=["expires_at"])

        response = self._accept(token)
        self.assertEqual(response.status_code, 410)

        row.refresh_from_db()
        self.assertEqual(row.status, AccountInvitation.Status.EXPIRED)
        self.assertIsNone(row.accepted_by_id)

    def test_revoked_invitation_cannot_be_accepted(self):
        token = self._create_for()
        row = AccountInvitation.objects.get(invited_by=self.inviter)
        self.assertEqual(self.client.post(_revoke_url(row.public_id)).status_code, 200)

        self.assertEqual(self._accept(token).status_code, 404)

    def test_unknown_token_is_not_found(self):
        self.assertEqual(self._accept("never-issued-token").status_code, 404)


class InvitationCSRFTest(TestCase):
    """Real CSRF enforcement (enforce_csrf_checks) on invitation mutations."""

    def setUp(self):
        self.user = User.objects.create_user(
            "invitecsrf", email="invitecsrf@example.com", password=PASSWORD
        )
        self.client = Client(enforce_csrf_checks=True)
        self.assertEqual(_login(self.client, "invitecsrf").status_code, 200)

    def _csrf_headers(self):
        self.client.get("/api/auth/csrf/")
        return {"HTTP_X_CSRFTOKEN": self.client.cookies["csrftoken"].value}

    def test_create_without_csrf_is_rejected(self):
        response = self.client.post(
            LIST_URL,
            data={"targetEmail": "csrf-target@example.com"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
        self.assertFalse(AccountInvitation.objects.exists())

        response = self.client.post(
            LIST_URL,
            data={"targetEmail": "csrf-target@example.com"},
            content_type="application/json",
            **self._csrf_headers(),
        )
        self.assertEqual(response.status_code, 201)

    def test_revoke_without_csrf_is_rejected(self):
        created = self.client.post(
            LIST_URL,
            data={"targetEmail": "csrf-target@example.com"},
            content_type="application/json",
            **self._csrf_headers(),
        )
        public_id = created.json()["id"]

        response = self.client.post(_revoke_url(public_id))
        self.assertEqual(response.status_code, 403)
        row = AccountInvitation.objects.get(public_id=public_id)
        self.assertEqual(row.status, AccountInvitation.Status.PENDING)

    def test_accept_without_csrf_is_rejected(self):
        # Historical invitation record for an existing account (the
        # production create endpoint now rejects account emails).
        _invitation, token = _historical_token_for(
            self.user, "invitecsrf@example.com"
        )

        response = self.client.post(
            ACCEPT_URL, data={"token": token}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 403)
        row = AccountInvitation.objects.get(invited_by=self.user)
        self.assertEqual(row.status, AccountInvitation.Status.PENDING)

        response = self.client.post(
            ACCEPT_URL,
            data={"token": token},
            content_type="application/json",
            **self._csrf_headers(),
        )
        self.assertEqual(response.status_code, 200)
