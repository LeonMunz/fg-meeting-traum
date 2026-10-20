"""Authenticated SSE invalidation transport for Work Items (RT-03A).

Transport foundation only:

- ``GET /api/work-items/events/`` — one authenticated
  ``text/event-stream`` per connection (existing Django session auth;
  anonymous -> 401, inactive account -> 401 via the standard
  middleware mapping, listener connection failure -> 5xx, all
  answered BEFORE any stream bytes).
- One dedicated PostgreSQL ``LISTEN`` connection per open stream (the
  stream's own connection, not the Django request connection; released
  only in the stream's own cleanup path).
- Per-delivery re-authorization against the connected user's CURRENT
  session and scope access (deny by default). Identity-level
  invalidation (session destroyed, user deactivated/deleted) closes the
  stream at the next delivery; scope revocation suppresses only the
  affected events and the stream stays open. Malformed or unknown
  payloads are suppressed (fail closed).
- A small internal ``pg_notify`` publication interface, commit-attached:
  the ``pg_notify`` runs inside the caller's active transaction, so
  PostgreSQL delivers the notification on commit and nothing on
  rollback.

Events are minimal invalidations (scope pointers, never Work Item data):
``open`` (own user id), ``work_item_changed`` (``projectId``), and
``my_work_changed`` (no Work Item data).

Canonical contract: ``docs/architecture.md`` (Realtime). Production
Work Item mutations are NOT wired to the publisher yet (RT-03B).
"""

from __future__ import annotations

import json
import time
from typing import Iterator, Optional, Tuple

import psycopg
from django.contrib.sessions.models import Session
from django.db import connections
from django.db import transaction
from django.http import JsonResponse, StreamingHttpResponse
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from accounts.models import User
from authorization.capabilities import Capability
from authorization.service import resolve_project_scope

# Single NOTIFY channel for Work Item invalidations (all scopes).
NOTIFY_CHANNEL = "fg_work_items"

# pg_stat_activity marker for the dedicated per-stream listener
# connections (operational visibility + cleanup verification).
LISTENER_APPLICATION_NAME = "fg-realtime-listener"

LISTENER_CONNECT_TIMEOUT_SECONDS = 5

# SSE lifecycle constants (the documented stream contract).
KEEPALIVE_INTERVAL_SECONDS = 15.0
STREAM_MAX_AGE_SECONDS = 30 * 60

_SSE_KEEPALIVE_FRAME = ": ping\n\n"

SCOPE_PROJECT = "project"
SCOPE_USER = "user"


class ListenerUnavailableError(Exception):
    """The dedicated LISTEN connection could not be established."""


# ── Internal publication interface (commit-attached) ────────────────


def _notify(payload: dict) -> None:
    """Run ``SELECT pg_notify`` on the caller's active transaction.

    The notification is delivered by PostgreSQL on COMMIT of that
    transaction and never on rollback. Publishing outside an active
    transaction is a contract violation and fails loudly.
    """
    if transaction.get_autocommit():
        raise RuntimeError(
            "Work Item invalidation publication must run inside an active "
            "database transaction: the pg_notify is delivered on commit "
            "and suppressed on rollback."
        )
    message = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    with connections["default"].cursor() as cursor:
        cursor.execute("SELECT pg_notify(%s, %s)", (NOTIFY_CHANNEL, message))


def publish_project_work_item_changed(project_id: int) -> None:
    """Publish one project-scope Work Item invalidation for a Project.

    Internal interface for RT-03B (canonical Work Item mutation
    services). MUST be called inside the mutation's own
    ``transaction.atomic()`` block.
    """
    _notify({"scope": SCOPE_PROJECT, "projectId": int(project_id)})


def publish_my_work_changed(user_id: int) -> None:
    """Publish one personal-scope My Work invalidation for exactly one
    addressed user.

    Internal interface for RT-03B. Same commit-attached contract as
    ``publish_project_work_item_changed``.
    """
    _notify({"scope": SCOPE_USER, "userId": int(user_id)})


# ── Dedicated LISTEN connection (one per stream) ────────────────────


def _listener_connection_params() -> dict:
    db_settings = connections["default"].settings_dict
    params = {
        "dbname": db_settings["NAME"],
        "user": db_settings.get("USER"),
        "password": db_settings.get("PASSWORD"),
        "host": db_settings.get("HOST") or None,
        "port": db_settings.get("PORT") or None,
        "application_name": LISTENER_APPLICATION_NAME,
        "connect_timeout": LISTENER_CONNECT_TIMEOUT_SECONDS,
        # The listener only ever LISTENs: it never runs statements that
        # need a transaction. psycopg3 does not deliver notifications on
        # a connection with an open (implicit) transaction, so the
        # listener runs in autocommit mode.
        "autocommit": True,
    }
    return {key: value for key, value in params.items() if value not in (None, "")}


class ListenerConnection:
    """One dedicated PostgreSQL ``LISTEN`` connection for one stream.

    This is the stream's own connection — NOT the Django request
    connection, which closes at request end (``CONN_MAX_AGE = 0``). It
    is released only in the stream's cleanup path.
    """

    def __init__(self) -> None:
        self._connection = None
        try:
            connection = psycopg.connect(**_listener_connection_params())
        except Exception as exc:  # connection refused / DB unavailable
            raise ListenerUnavailableError(str(exc)) from exc
        try:
            with connection.cursor() as cursor:
                # NOTIFY_CHANNEL is a module constant (never
                # client-supplied), so direct interpolation is safe;
                # LISTEN is a utility statement without bind support.
                cursor.execute(f"LISTEN {NOTIFY_CHANNEL}")
        except Exception as exc:
            connection.close()
            raise ListenerUnavailableError(str(exc)) from exc
        self._connection = connection

    def iter_notifications(self, timeout: float):
        """Yield queued channel notifications for at most ``timeout``
        seconds (StopIteration on timeout without a notification)."""
        return self._connection.notifies(timeout=timeout)

    def close(self) -> None:
        connection, self._connection = self._connection, None
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


def open_listener() -> ListenerConnection:
    """Open the stream's dedicated LISTEN connection.

    Raises ``ListenerUnavailableError`` when the connection cannot be
    established; the endpoint then answers 5xx before any stream bytes.
    """
    return ListenerConnection()


# ── SSE framing and payload contract ────────────────────────────────


def sse_event_frame(event: str, payload: dict) -> str:
    """Render one SSE event frame (events carry minimal invalidation
    payloads only: scope + id, never Work Item data)."""
    data = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return f"event: {event}\ndata: {data}\n\n"


def parse_notification_payload(payload) -> Optional[Tuple[str, int]]:
    """Parse one channel payload into ``(scope, scope_id)``.

    Returns ``None`` for malformed, unknown, or tampered payloads:
    invalid notifications fail closed (suppressed, never forwarded).
    """
    if not isinstance(payload, str):
        return None
    try:
        data = json.loads(payload)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    scope = data.get("scope")
    if scope == SCOPE_PROJECT:
        if set(data) != {"scope", "projectId"}:
            return None
        scope_id = data["projectId"]
    elif scope == SCOPE_USER:
        if set(data) != {"scope", "userId"}:
            return None
        scope_id = data["userId"]
    else:
        return None
    if isinstance(scope_id, bool) or not isinstance(scope_id, int):
        return None
    return scope, scope_id


# ── Per-delivery re-authorization ───────────────────────────────────


def _session_still_valid(session_key: str) -> bool:
    """The same canonical check Django's session store uses: the
    session row must still exist and not be expired."""
    return Session.objects.filter(
        session_key=session_key,
        expire_date__gt=timezone.now(),
    ).exists()


def _handle_notification(payload, user_id: int, session_key: str):
    """Re-authorize one notification for one open stream.

    Returns ``(frame, stream_closed)``: ``frame`` is the SSE frame to
    write or ``None`` (suppressed); ``stream_closed`` is True when
    identity-level invalidation must end the stream.

    Never trusts the connection-time ``request.user``: identity is
    re-resolved (session row + current user row) and project scope is
    re-resolved against CURRENT access on every delivery.
    """
    parsed = parse_notification_payload(payload)
    if parsed is None:
        return None, False

    user = User.objects.filter(pk=user_id).first()
    if user is None or not user.is_active or not _session_still_valid(session_key):
        return None, True

    scope, scope_id = parsed
    if scope == SCOPE_USER:
        # Personal events reach only the addressed user.
        if scope_id != user.pk:
            return None, False
        return sse_event_frame("my_work_changed", {}), False

    # scope == SCOPE_PROJECT: the identical canonical read boundary of
    # the Work Item list endpoint — a current ProjectMembership
    # (owner/member/viewer) AND a current ResearchGroupMembership in
    # the Project's group. Lookup failures (deleted Project, unknown
    # id) fail closed: suppress, never forward.
    project_scope = resolve_project_scope(user, scope_id)
    if project_scope is None or not project_scope.has(Capability.PROJECT_READ):
        return None, False
    return sse_event_frame("work_item_changed", {"projectId": scope_id}), False


# ── Stream generator and endpoint ───────────────────────────────────


def _event_stream(user_id: int, session_key: str, listener: ListenerConnection) -> Iterator[str]:
    """The stream body: open handshake, keep-alives, re-authorized
    invalidation events, the 30-minute limit, and guaranteed listener
    cleanup.

    One ``notifies()`` generator is kept across loop iterations until
    it times out (StopIteration) and a fresh one is created: a single
    poll can carry several notifications in one batch, and every queued
    notification must be processed, not just the first.
    """
    try:
        yield sse_event_frame("open", {"userId": user_id})
        deadline = time.monotonic() + STREAM_MAX_AGE_SECONDS
        next_keepalive = time.monotonic() + KEEPALIVE_INTERVAL_SECONDS
        notification_gen = None
        while True:
            now = time.monotonic()
            remaining = deadline - now
            if remaining <= 0:
                return
            wait = min(remaining, max(next_keepalive - now, 0.0))
            try:
                if notification_gen is None:
                    notification_gen = listener.iter_notifications(timeout=wait)
                notification = next(notification_gen)
            except StopIteration:
                # The generator's wait window elapsed without a
                # notification: keep-alive / deadline bookkeeping below.
                notification_gen = None
                notification = None
            except Exception:
                # The listener connection died mid-stream: end the
                # stream cleanly. The client reconnects and refetches
                # authoritative state (the documented recovery path).
                return
            now = time.monotonic()
            if now >= deadline:
                return
            if notification is None:
                if now >= next_keepalive:
                    yield _SSE_KEEPALIVE_FRAME
                    next_keepalive = now + KEEPALIVE_INTERVAL_SECONDS
                continue
            try:
                frame, stream_closed = _handle_notification(notification.payload, user_id, session_key)
            except Exception:
                # Per-delivery lookup/authorization failure: fail
                # closed for this event only (suppress); never block
                # the stream.
                frame, stream_closed = None, False
            if stream_closed:
                return
            if frame is not None:
                yield frame
    finally:
        listener.close()


@require_http_methods(["GET"])
def work_item_event_stream(request):
    """``GET /api/work-items/events/`` — authenticated SSE
    invalidation stream (RT-03A).

    - anonymous            -> 401 (before any stream bytes)
    - inactive account     -> 401 (the AuthenticationMiddleware maps
      an inactive user to AnonymousUser through the ModelBackend; this
      matches every other API endpoint and the architecture doc's own
      recovery contract — "an inactive user answers 401 as well" —
      which the client treats as terminal authentication loss)
    - listener unavailable -> 503 (before any stream bytes)
    - success              -> 200 ``text/event-stream`` with the
      ``open`` handshake, keep-alives, re-authorized events, and a
      30-minute server-side limit.

    The explicit ``is_active`` guard (403) is defense in depth: it is
    unreachable while the standard middleware/backend combination maps
    inactive users to anonymous, and stays correct if that ever
    changes.
    """
    if not request.user.is_authenticated:
        return JsonResponse({"error": "Authentication required."}, status=401)
    if not request.user.is_active:
        return JsonResponse({"error": "Account disabled."}, status=403)
    session_key = request.session.session_key
    if not session_key:
        return JsonResponse({"error": "Authentication required."}, status=401)
    try:
        listener = open_listener()
    except ListenerUnavailableError:
        return JsonResponse({"error": "Event stream temporarily unavailable."}, status=503)
    response = StreamingHttpResponse(
        _event_stream(request.user.pk, session_key, listener),
        content_type="text/event-stream",
    )
    response["Cache-Control"] = "no-cache"
    # The dedicated listener connection is a stream-owned resource;
    # close it when the response is closed (client disconnect or
    # stream end), independent of iterator consumption.
    response._resource_closers.append(listener.close)
    return response
