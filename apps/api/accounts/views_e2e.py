"""Browser-E2E-only fixture endpoints.

Registered exclusively under the isolated E2E settings module
(``config.settings_e2e``, bound to the dedicated ``fg_e2e`` schema — see
``config/urls.py``). They exist for one reason: the production creation
endpoint intentionally rejects new invitations for emails that already
belong to an account (``account_exists``), while the existing-account
redemption flows (registration preview / sign-in / explicit accept) must
keep being exercised by the browser suite against pre-existing
("historical") invitation records — exactly the state the backend tests
build with their ``_historical_token_for`` helper.

Writing that historical row directly (canonical domain helpers, no
service call) is a test fixture, not product behavior: it bypasses the
production creation flow on purpose, creates no memberships, and the raw
token is returned exactly once, like production creation.
"""
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .invitation_services import (
    INVITATION_LIFETIME,
    digest_invitation_token,
    generate_invitation_token,
    normalize_invitation_email,
    serialize_account_invitation,
)
from .models import AccountInvitation


class E2EAccountInvitationFixtureView(APIView):
    """Create one historical PENDING account invitation (E2E fixture).

    Requires an authenticated, active session; the authenticated user
    becomes the inviter. CSRF is enforced by DRF session authentication
    exactly like every other mutation endpoint. The body is
    ``{"invitedEmail": "..."}``; the response is the standard
    non-secret invitation representation plus the raw token, returned
    exactly once.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not request.user.is_active:
            return Response(
                {
                    "error": "Only active accounts may create fixtures.",
                },
                status=403,
            )

        invited_email = request.data.get("invitedEmail") or ""
        normalized = normalize_invitation_email(invited_email)
        try:
            validate_email(normalized)
        except ValidationError:
            return Response(
                {
                    "error": "A valid e-mail address is required.",
                    "code": "invalid_email",
                },
                status=400,
            )

        token = generate_invitation_token()
        try:
            with transaction.atomic():
                invitation = AccountInvitation.objects.create(
                    invited_by=request.user,
                    invited_email=normalized,
                    token_digest=digest_invitation_token(token),
                    status=AccountInvitation.Status.PENDING,
                    # Provisional; tightened below so expiry is exactly
                    # 7 days after the persisted created_at.
                    expires_at=timezone.now() + INVITATION_LIFETIME,
                )
                invitation.expires_at = (
                    invitation.created_at + INVITATION_LIFETIME
                )
                invitation.save(update_fields=["expires_at"])
        except IntegrityError:
            # The partial unique index: an effective PENDING row for
            # this normalized email already exists.
            return Response(
                {
                    "error": "A pending invitation already exists "
                    "for this e-mail.",
                    "code": "pending_invitation_exists",
                },
                status=409,
            )

        data = serialize_account_invitation(invitation)
        data["token"] = token
        return Response(data, status=201)
