"""Custom DRF authentication that does not enforce CSRF at the DRF layer."""

from rest_framework.authentication import SessionAuthentication


class NoCSRFSessionAuthentication(SessionAuthentication):
    """Session authentication without DRF-level CSRF enforcement.

    Also provides an authenticate_header() so that 401 responses
    include a WWW-Authenticate challenge and are not coerced to 403.
    """

    def enforce_csrf(self, request):
        return  # Skip DRF CSRF enforcement; Django middleware handles it.

    def authenticate_header(self, request):
        """Return a WWW-Authenticate header so 401 is preserved."""
        return 'Session'
