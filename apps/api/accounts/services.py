"""Session registry and session-management operations.

The ``UserSession`` registry attributes each authenticated browser session
to its User. It is metadata only: it never grants authentication. The
Django session row (``django_session``) remains the authentication
credential, and every revocation operation destroys both the registry row
and the corresponding Django session row atomically.

Session lifecycle:
- created by the login endpoint (post-rotation key) or lazily by
  ``SessionRegistryMiddleware`` for any authenticated session;
- removed on logout (Django session destroyed by ``logout()``);
- removed on revocation (selected / all others / all);
- expired sessions are never listed: ``list_user_sessions`` cross-checks
  Django session liveness and prunes the user's own dead rows.
"""

from django.contrib.sessions.models import Session
from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import UserSession


def register_user_session(user, session_key):
    """Attach a registry row to an authenticated session (idempotent).

    Safe under concurrent registration races (unique ``session_key``).
    """
    try:
        UserSession.objects.get_or_create(
            user=user,
            session_key=session_key,
        )
    except IntegrityError:
        pass


def unregister_session(user, session_key):
    """Drop the registry row for one session (e.g. on logout)."""
    UserSession.objects.filter(
        user=user,
        session_key=session_key,
    ).delete()


def _session_is_alive(session_key):
    """True when the Django session row exists and has not expired."""
    return Session.objects.filter(
        pk=session_key,
        expire_date__gte=timezone.now(),
    ).exists()


def _destroy_django_sessions(session_keys):
    if session_keys:
        Session.objects.filter(session_key__in=session_keys).delete()


def list_user_sessions(user, current_session_key):
    """Return the user's currently active sessions, newest first.

    Only sessions whose Django session row is still alive (present and
    unexpired) are returned; dead registry rows of this user are pruned so
    the registry stays in agreement with the session store.
    """
    rows = list(
        UserSession.objects.filter(user=user).order_by("-created_at", "pk")
    )
    live_rows = []
    dead_pks = []
    for row in rows:
        if _session_is_alive(row.session_key):
            live_rows.append(row)
        else:
            dead_pks.append(row.pk)
    if dead_pks:
        UserSession.objects.filter(pk__in=dead_pks).delete()
    return live_rows


def serialize_user_session(row, current_session_key):
    """Non-secret session representation for the session-management API.

    Never includes the raw Django session key or any credential.
    """
    return {
        "id": str(row.public_id),
        "createdAt": row.created_at.isoformat(),
        "isCurrent": row.session_key == current_session_key,
    }


def revoke_user_session(user, public_id):
    """Revoke one session owned by ``user``.

    Returns True when a session was revoked. An unknown id and an id owned
    by another user both return False — the API answers the same
    non-leaking 404 for both.
    """
    with transaction.atomic():
        row = (
            UserSession.objects.select_for_update()
            .filter(user=user, public_id=public_id)
            .first()
        )
        if row is None:
            return False
        _destroy_django_sessions([row.session_key])
        row.delete()
    return True


def revoke_other_sessions(user, current_session_key):
    """Invalidate every session of ``user`` except the current one.

    Returns the number of sessions revoked (0 when none exist). The
    current session is never touched.
    """
    with transaction.atomic():
        rows = list(
            UserSession.objects.select_for_update()
            .filter(user=user)
            .exclude(session_key=current_session_key)
        )
        if not rows:
            return 0
        _destroy_django_sessions([row.session_key for row in rows])
        UserSession.objects.filter(
            user=user,
            pk__in=[row.pk for row in rows],
        ).delete()
        return len(rows)


def revoke_all_sessions(user):
    """Invalidate every session of ``user``, including the current one.

    Returns the number of sessions revoked (0 when none exist).
    """
    with transaction.atomic():
        rows = list(
            UserSession.objects.select_for_update().filter(user=user)
        )
        if not rows:
            return 0
        _destroy_django_sessions([row.session_key for row in rows])
        UserSession.objects.filter(
            user=user,
            pk__in=[row.pk for row in rows],
        ).delete()
        return len(rows)
