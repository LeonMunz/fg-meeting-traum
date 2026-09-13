"""Production settings: secure-cookie transport for browser sessions.

Import with ``DJANGO_SETTINGS_MODULE=config.settings_production``.

Inherits the development base settings and enforces the production cookie
contract: session and CSRF cookies are only transmitted over HTTPS.
Local HTTP development keeps using ``config.settings`` (Secure off).

The production module refuses to start with the committed development
``SECRET_KEY`` or with a missing/blank ``DJANGO_SECRET_KEY``: the session
cookie is the bearer credential for the whole authentication foundation, so
it must be signed with a deployment-provided secret (``DJANGO_SECRET_KEY``),
and an empty signing key must never be accepted silently. ``ALLOWED_HOSTS`` stays empty unless the
deployment overrides it, so an unconfigured production server refuses all
requests instead of serving on a guessed host list.
"""

import os

from django.core.exceptions import ImproperlyConfigured

from .settings import *  # noqa: F401,F403

DEBUG = False

# Production cookie contract.
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

# Never run production on the committed development secret key, and
# never on a missing/blank deployment value: an empty signing key would
# let anyone forge signed session cookies for arbitrary users.
_DEV_SECRET_KEY = SECRET_KEY  # the inherited development value
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if not SECRET_KEY.strip() or SECRET_KEY == _DEV_SECRET_KEY:
    raise ImproperlyConfigured(
        "Production settings require a non-empty deployment-provided "
        "DJANGO_SECRET_KEY; the development SECRET_KEY must never "
        "sign production session cookies."
    )
