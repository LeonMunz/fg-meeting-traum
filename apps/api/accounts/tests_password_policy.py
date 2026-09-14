"""Registration password-policy contract tests.

Covers the non-consuming ``POST /api/auth/registration-password-policy/``
endpoint and the registration password-failure parity:

- the configured Django validators are the sole source of truth: every
  requirement state comes from running ``get_default_password_validators()``
  against the same transient candidate User identity that registration
  validation uses (client username + invitation-authoritative email);
- the aggregate ``valid`` and the per-validator states match the result of
  Django's actual ``validate_password`` path used by registration (parity);
- the invited email is server-authoritative and cannot be client-substituted;
- repeated policy checks never consume the invitation, create a User, or
  create memberships, and a later real registration still succeeds;
- unknown / expired / revoked / already-used invitations map onto the same
  discriminators as the canonical registration flow;
- an existing-account invitation follows the registration-preview contract
  (``accountExists``) without opening a new account path;
- empty username/password are valid candidate form state;
- the candidate password is never echoed back in any response.

Real CSRF enforcement lives in ``tests_csrf.py``.
"""

import re

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import (
    MinimumLengthValidator,
    get_default_password_validators,
    validate_password,
)
from django.core.exceptions import ValidationError
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from projects.models import ProjectMembership
from research_groups.models import ResearchGroupMembership

from .invitation_services import create_account_invitation
from .tests_invitations import _historical_token_for
from .models import AccountInvitation

User = get_user_model()

REGISTER_URL = "/api/auth/register/"
PREVIEW_URL = "/api/auth/registration-invitation/"
POLICY_URL = "/api/auth/registration-password-policy/"

# Strong password that passes every configured Django validator.
VALID_PASSWORD = "Zebra!Correct99x"
# Single-failure candidates (verified against the configured validators).
SHORT_PASSWORD = "Xk!9bQz"            # only too short
SIMILAR_USERNAME_PASSWORD = "regnewuser1!"  # only too similar (username)
COMMON_PASSWORD = "password123"       # only too common
NUMERIC_PASSWORD = "24681357"         # only entirely numeric
# Simultaneous failures: too short + too common + entirely numeric.
MULTI_FAIL_PASSWORD = "1234"

INVITED_RAW = " Person@Example.COM "  # normalizes to person@example.com
INVITED = "person@example.com"

# The four configured Django validation codes in AUTH_PASSWORD_VALIDATORS
# order (similarity, minimum length, common, numeric).
EXPECTED_CODES = [
    "password_too_similar",
    "password_too_short",
    "password_too_common",
    "password_entirely_numeric",
]


def _inviter():
    return User.objects.create_user(
        username="policyinviter",
        email="policyinviter@example.com",
        password=VALID_PASSWORD,
    )


def _token_for(email=INVITED_RAW, actor=None):
    invitation, token = create_account_invitation(
        actor=actor or _inviter(), invited_email=email
    )
    return invitation, token


def _policy(
    client,
    token,
    username="regnewuser",
    password=VALID_PASSWORD,
    extra=None,
):
    body = {"token": token, "username": username, "password": password}
    if extra:
        body.update(extra)
    return client.post(
        POLICY_URL, data=body, content_type="application/json"
    )


def _register(client, token, username="regnewuser", password=VALID_PASSWORD):
    return client.post(
        REGISTER_URL,
        data={"token": token, "username": username, "password": password},
        content_type="application/json",
    )


def _requirement(data, code):
    matches = [r for r in data["requirements"] if r["code"] == code]
    assert len(matches) == 1, f"expected exactly one {code}, got {data}"
    return matches[0]


def _assert_read_only(captured_queries):
    """No DB writes and no mutation-oriented row locks among the queries."""
    statements = [q["sql"].upper() for q in captured_queries]
    assert not any(
        re.search(r"\b(INSERT|UPDATE|DELETE)\b", sql) for sql in statements
    ), statements
    assert not any("FOR UPDATE" in sql for sql in statements), statements


class PasswordPolicySuccessTest(APITestCase):
    """A valid invitation + fully satisfying password reports all satisfied."""

    def setUp(self):
        self.invitation, self.token = _token_for()
        self.users_before = User.objects.count()

    def test_valid_password_reports_all_requirements_satisfied(self):
        response = _policy(self.client, self.token)
        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertTrue(data["valid"])
        self.assertFalse(data["accountExists"])
        self.assertEqual(
            [r["code"] for r in data["requirements"]], EXPECTED_CODES
        )
        for requirement in data["requirements"]:
            self.assertTrue(requirement["satisfied"], requirement)
            self.assertEqual(
                set(requirement), {"code", "label", "satisfied"}
            )
            self.assertTrue(requirement["label"])

    def test_pending_policy_check_executes_no_writes_or_row_locks(self):
        with CaptureQueriesContext(connection) as ctx:
            response = _policy(self.client, self.token)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["valid"])
        _assert_read_only(ctx.captured_queries)

    def test_candidate_password_never_echoed(self):
        secret = "EchoMe!99xQ"
        _policy(self.client, self.token, password=secret)
        body = self.client.post(
            POLICY_URL,
            data={
                "token": self.token,
                "username": "regnewuser",
                "password": secret,
            },
            content_type="application/json",
        )
        self.assertNotIn(secret, str(body.content))


class PasswordPolicySingleFailureTest(APITestCase):
    """Each configured validator failure is reported by its Django code."""

    def setUp(self):
        self.invitation, self.token = _token_for()

    def test_too_short(self):
        data = _policy(self.client, self.token, password=SHORT_PASSWORD).json()
        self.assertFalse(data["valid"])
        self.assertFalse(_requirement(data, "password_too_short")["satisfied"])
        self.assertTrue(_requirement(data, "password_too_similar")["satisfied"])
        self.assertTrue(_requirement(data, "password_too_common")["satisfied"])
        self.assertTrue(
            _requirement(data, "password_entirely_numeric")["satisfied"]
        )

    def test_too_similar_to_username(self):
        data = _policy(
            self.client, self.token, password=SIMILAR_USERNAME_PASSWORD
        ).json()
        self.assertFalse(data["valid"])
        self.assertFalse(
            _requirement(data, "password_too_similar")["satisfied"]
        )
        self.assertTrue(_requirement(data, "password_too_short")["satisfied"])
        self.assertTrue(_requirement(data, "password_too_common")["satisfied"])
        self.assertTrue(
            _requirement(data, "password_entirely_numeric")["satisfied"]
        )

    def test_too_common(self):
        data = _policy(self.client, self.token, password=COMMON_PASSWORD).json()
        self.assertFalse(data["valid"])
        self.assertFalse(_requirement(data, "password_too_common")["satisfied"])
        self.assertTrue(_requirement(data, "password_too_similar")["satisfied"])
        self.assertTrue(_requirement(data, "password_too_short")["satisfied"])
        self.assertTrue(
            _requirement(data, "password_entirely_numeric")["satisfied"]
        )

    def test_entirely_numeric(self):
        data = _policy(
            self.client, self.token, password=NUMERIC_PASSWORD
        ).json()
        self.assertFalse(data["valid"])
        self.assertFalse(
            _requirement(data, "password_entirely_numeric")["satisfied"]
        )
        self.assertTrue(_requirement(data, "password_too_similar")["satisfied"])
        self.assertTrue(_requirement(data, "password_too_short")["satisfied"])
        self.assertTrue(_requirement(data, "password_too_common")["satisfied"])


class PasswordPolicyMultipleFailuresTest(APITestCase):
    def test_all_simultaneous_failures_are_returned(self):
        _, token = _token_for()
        data = _policy(self.client, token, password=MULTI_FAIL_PASSWORD).json()
        self.assertFalse(data["valid"])
        self.assertFalse(_requirement(data, "password_too_short")["satisfied"])
        self.assertFalse(_requirement(data, "password_too_common")["satisfied"])
        self.assertFalse(
            _requirement(data, "password_entirely_numeric")["satisfied"]
        )
        self.assertTrue(_requirement(data, "password_too_similar")["satisfied"])


class PasswordPolicyLabelsTest(APITestCase):
    """Labels come from the backend validators, not duplicated copy."""

    def test_labels_are_the_configured_validators_help_texts(self):
        _, token = _token_for()
        data = _policy(self.client, token).json()
        configured = get_default_password_validators()
        self.assertEqual(len(data["requirements"]), len(configured))
        for requirement, validator in zip(
            data["requirements"], configured
        ):
            self.assertEqual(requirement["label"], validator.get_help_text())

    def test_minimum_length_label_reflects_configured_parameter(self):
        _, token = _token_for()
        data = _policy(self.client, token).json()
        configured = next(
            v
            for v in get_default_password_validators()
            if isinstance(v, MinimumLengthValidator)
        )
        label = _requirement(data, "password_too_short")["label"]
        self.assertIn(str(configured.min_length), label)


class PasswordPolicySimilarityIdentityTest(APITestCase):
    """The candidate identity is username + the invited email."""

    def test_invited_email_participates_in_similarity(self):
        # "quixotic" is part of the invited email, not the username.
        _, token = _token_for(email="quixotic@corp.io")
        data = _policy(
            self.client,
            token,
            username="innocuoususer",
            password="Quixotic2024x!",
        ).json()
        self.assertFalse(data["valid"])
        self.assertFalse(
            _requirement(data, "password_too_similar")["satisfied"]
        )

    def test_client_cannot_substitute_the_invited_email(self):
        # Similar to the invited email's local part, not to the username.
        _, token = _token_for(email="quixotic@corp.io")
        data = _policy(
            self.client,
            token,
            username="innocuoususer",
            password="Quixotic2024x!",
        ).json()
        # A client-supplied email is rejected fail-closed, exactly like
        # registration — it can never replace the invited email.
        response = _policy(
            self.client,
            token,
            username="innocuoususer",
            password="Quixotic2024x!",
            extra={"email": "other@elsewhere.com"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(
            _requirement(data, "password_too_similar")["satisfied"]
        )


class PasswordPolicyEmptyCandidateTest(APITestCase):
    """Empty form values are valid candidate state, not malformed input."""

    def setUp(self):
        self.invitation, self.token = _token_for()

    def test_empty_username_and_password(self):
        response = _policy(
            self.client, self.token, username="", password=""
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertFalse(data["valid"])
        self.assertFalse(_requirement(data, "password_too_short")["satisfied"])
        self.assertTrue(_requirement(data, "password_too_similar")["satisfied"])
        self.assertTrue(_requirement(data, "password_too_common")["satisfied"])
        self.assertTrue(
            _requirement(data, "password_entirely_numeric")["satisfied"]
        )

    def test_empty_username_with_valid_password(self):
        response = _policy(self.client, self.token, username="")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["valid"])

    def test_empty_password_with_username(self):
        response = _policy(self.client, self.token, password="")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertFalse(data["valid"])
        self.assertFalse(_requirement(data, "password_too_short")["satisfied"])


class PasswordPolicyNonConsumingTest(APITestCase):
    """Policy checks never consume the invitation or create anything."""

    def setUp(self):
        self.invitation, self.token = _token_for()
        self.users_before = User.objects.count()

    def _assert_invitation_intact(self):
        self.invitation.refresh_from_db()
        self.assertEqual(self.invitation.status, AccountInvitation.Status.PENDING)
        self.assertIsNone(self.invitation.accepted_at)
        self.assertIsNone(self.invitation.accepted_by_id)
        self.assertEqual(User.objects.count(), self.users_before)
        self.assertEqual(ResearchGroupMembership.objects.count(), 0)
        self.assertEqual(ProjectMembership.objects.count(), 0)

    def test_repeated_checks_do_not_consume_and_registration_still_succeeds(
        self
    ):
        for password in (
            VALID_PASSWORD,
            SHORT_PASSWORD,
            COMMON_PASSWORD,
            NUMERIC_PASSWORD,
            MULTI_FAIL_PASSWORD,
            "",
        ):
            response = _policy(self.client, self.token, password=password)
            self.assertEqual(response.status_code, 200)
            self._assert_invitation_intact()

        # The invitation is still usable after arbitrary policy checks.
        preview = self.client.post(
            PREVIEW_URL,
            data={"token": self.token},
            content_type="application/json",
        )
        self.assertEqual(preview.status_code, 200)
        self.assertTrue(preview.json()["usable"])

        response = _register(self.client, self.token)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(User.objects.count(), self.users_before + 1)
        self.invitation.refresh_from_db()
        self.assertEqual(
            self.invitation.status, AccountInvitation.Status.ACCEPTED
        )


class PasswordPolicyInvitationStatesTest(APITestCase):
    """Unknown/terminal invitations map onto the registration contract."""

    def test_unknown_token(self):
        response = _policy(self.client, "no-such-token")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["code"], "invalid_token")

    def test_expired_invitation_is_reported_without_persisting(self):
        invitation, token = _token_for()
        invitation.expires_at = timezone.now()
        invitation.save(update_fields=["expires_at"])
        users_before = User.objects.count()

        # Effectively expired PENDING -> canonical 410 expired.
        with CaptureQueriesContext(connection) as ctx:
            response = _policy(self.client, token)
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["code"], "expired")

        # Strictly read-only: no writes, no row locks, and the row remains
        # persisted PENDING with no acceptance fields and no side effects.
        _assert_read_only(ctx.captured_queries)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.PENDING)
        self.assertIsNone(invitation.accepted_at)
        self.assertIsNone(invitation.accepted_by_id)
        self.assertEqual(User.objects.count(), users_before)
        self.assertEqual(ResearchGroupMembership.objects.count(), 0)
        self.assertEqual(ProjectMembership.objects.count(), 0)

        # Repeated checks remain side-effect free and keep reporting
        # expired.
        response = _policy(self.client, token)
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["code"], "expired")
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.PENDING)
        self.assertIsNone(invitation.accepted_at)
        self.assertIsNone(invitation.accepted_by_id)

        # Actual registration keeps its canonical behavior: it still
        # reports expired and is the flow that persists the EXPIRED
        # transition.
        registration = _register(self.client, token)
        self.assertEqual(registration.status_code, 410)
        self.assertEqual(registration.json()["code"], "expired")
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.EXPIRED)

    def test_revoked_invitation(self):
        invitation, token = _token_for()
        invitation.status = AccountInvitation.Status.REVOKED
        invitation.revoked_at = timezone.now()
        invitation.save(update_fields=["status", "revoked_at"])

        response = _policy(self.client, token)
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["code"], "revoked")

    def test_already_used_invitation(self):
        invitation, token = _token_for()
        created = User.objects.create_user(
            username="regnewuser",
            email=INVITED,
            password=VALID_PASSWORD,
        )
        invitation.status = AccountInvitation.Status.ACCEPTED
        invitation.accepted_at = timezone.now()
        invitation.accepted_by = created
        invitation.save(
            update_fields=["status", "accepted_at", "accepted_by"]
        )

        response = _policy(self.client, token)
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["code"], "already_used")

    def test_existing_account_invitation_follows_preview_contract(self):
        # An account with the invited normalized email already exists.
        User.objects.create_user(
            username="existinguser",
            email=INVITED.upper(),  # storage format intentionally loose
            password=VALID_PASSWORD,
        )
        # Historical invitation record for an existing account (the
        # production create endpoint no longer creates invitations for
        # account emails); the policy/preview contract is what is tested.
        invitation, token = _historical_token_for(_inviter(), INVITED_RAW)

        response = _policy(self.client, token)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["accountExists"])
        self.assertIn("requirements", data)

        # No new account path: real registration still reports
        # account_exists and leaves the invitation pending.
        registration = _register(self.client, token)
        self.assertEqual(registration.status_code, 409)
        self.assertEqual(registration.json()["code"], "account_exists")
        invitation.refresh_from_db()
        self.assertEqual(
            invitation.status, AccountInvitation.Status.PENDING
        )


class RegistrationPasswordFailureParityTest(APITestCase):
    """Failed registration reconciles with the live policy contract."""

    def setUp(self):
        self.invitation, self.token = _token_for()

    def test_failed_registration_returns_same_requirements_schema(self):
        policy = _policy(
            self.client, self.token, password=MULTI_FAIL_PASSWORD
        ).json()

        registration = _register(self.client, self.token, password=MULTI_FAIL_PASSWORD)
        self.assertEqual(registration.status_code, 400)
        body = registration.json()
        self.assertEqual(body["code"], "password")
        self.assertEqual(
            body["error"], "The password does not meet the requirements."
        )
        self.assertEqual(
            [r["code"] for r in body["requirements"]],
            [r["code"] for r in policy["requirements"]],
        )
        self.assertEqual(
            body["requirements"], policy["requirements"]
        )
        # The invitation was not consumed by the failed registration.
        self.invitation.refresh_from_db()
        self.assertEqual(
            self.invitation.status, AccountInvitation.Status.PENDING
        )
        self.assertNotIn(MULTI_FAIL_PASSWORD, str(registration.content))


class RegistrationValidatorParityTest(APITestCase):
    """The policy endpoint's aggregate result must match the result of
    Django's actual configured password-validation path used by
    registration (``validate_password`` against the candidate identity).
    This catches future validator configuration drift.
    """

    CANDIDATES = [
        VALID_PASSWORD,
        SHORT_PASSWORD,
        SIMILAR_USERNAME_PASSWORD,
        COMMON_PASSWORD,
        NUMERIC_PASSWORD,
        MULTI_FAIL_PASSWORD,
        "",
    ]

    def test_policy_validity_matches_validate_password(self):
        _, token = _token_for()
        username = "regnewuser"
        for password in self.CANDIDATES:
            with self.subTest(password=password):
                candidate = User(username=username, email=INVITED)
                try:
                    validate_password(password, candidate)
                    django_says_valid = True
                except ValidationError:
                    django_says_valid = False

                data = _policy(
                    self.client, token, username=username, password=password
                ).json()
                self.assertEqual(data["valid"], django_says_valid)
                # Per-validator states agree with validate_password as a
                # whole: valid only when every requirement is satisfied.
                self.assertEqual(
                    data["valid"],
                    all(r["satisfied"] for r in data["requirements"]),
                )
