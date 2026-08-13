"""Custom base APIView with optional CSRF enforcement.

When a view sets `requires_csrf_token = True`, the CSRF token is
checked in `initial()` for unsafe HTTP methods (POST/PUT/PATCH/DELETE).

This is needed because Django's CsrfViewMiddleware.process_view() checks
`hasattr(callback, 'requires_csrf_token')`, but DRF's `as_view()` returns
an inner closure function that doesn't carry class attributes.
"""

from django.middleware.csrf import (
    CsrfViewMiddleware,
    RejectRequest,
    get_token,
)
from rest_framework.exceptions import PermissionDenied
from rest_framework.views import APIView as DRFAPIView


CSRF_SAFE_METHODS = ("GET", "HEAD", "OPTIONS", "TRACE")


class APIView(DRFAPIView):
    """Base APIView with optional DRF-level CSRF enforcement."""

    requires_csrf_token: bool = False

    def initial(self, request, *args, **kwargs):
        if self.requires_csrf_token and request.method not in CSRF_SAFE_METHODS:
            self._enforce_csrf(request)
        super().initial(request, *args, **kwargs)

    def _enforce_csrf(self, request):
        """Check the CSRF token using Django's CsrfViewMiddleware logic."""
        # Ensure CSRF cookie/secret is available on the request.
        # get_token() reads the cookie (if present) into request.META['CSRF_COOKIE']
        # so that the middleware's _get_secret() can find it.
        get_token(request)
        middleware = CsrfViewMiddleware(lambda r: None)
        try:
            middleware._check_token(request)
        except RejectRequest as exc:
            raise PermissionDenied(exc.reason)
