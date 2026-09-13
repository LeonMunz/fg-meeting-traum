"""Session registry middleware.

Ensures every authenticated session has a server-side registry row
(``accounts.UserSession``). Rows are created lazily so that sessions
established outside the login endpoint (e.g. the Django admin) and
pre-existing legacy sessions are covered.

The registry is metadata only; authentication always comes from the Django
session. The per-request cost is a single indexed lookup on
``UserSession.session_key``.
"""

from .services import register_user_session


class SessionRegistryMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        session = getattr(request, "session", None)
        user = getattr(request, "user", None)
        session_key = session.session_key if session is not None else None
        if (
            session_key
            and user is not None
            and user.is_authenticated
            and user.is_active
        ):
            register_user_session(user, session_key)
        return self.get_response(request)
