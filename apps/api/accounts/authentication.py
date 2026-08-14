"""Minimal DRF session authentication.

Uses standard DRF SessionAuthentication with one small customization:
authenticate_header() returns a value so that 401 responses include a
WWW-Authenticate header and are not coerced to 403 by DRF's
handle_exception().

CSRF is enforced by SessionAuthentication for authenticated unsafe
requests (POST/PUT/PATCH/DELETE). Login/Logout endpoints add explicit
CSRF enforcement via @method_decorator(csrf_protect).
"""

from rest_framework.authentication import SessionAuthentication


class FGSessionAuthentication(SessionAuthentication):
    """Standard session auth with authenticate_header for 401 responses."""

    def authenticate_header(self, request):
        """Return a WWW-Authenticate header so 401 is preserved."""
        return 'Session'
