"""Browser-E2E-only Django settings (isolated fg_e2e schema).

Import with ``DJANGO_SETTINGS_MODULE=config.settings_e2e``.

Derives from ``config.settings`` but must not mutate mutable objects
owned by ``config.settings`` when imported (import purity): the star
import below binds ``DATABASES`` to the very dict object owned by the
base module, so the database configuration is rebuilt as an
independent structure — new outer dict, new per-alias entry, new
OPTIONS dict (every remaining DATABASES value is an immutable string).
Mutating this module's ``DATABASES`` afterwards can never leak back
into ``config.settings.DATABASES``. The runtime contract is unchanged:
the default database keeps every base entry plus the isolated
``fg_e2e`` search path.
"""

from .settings import *  # noqa: F401,F403

DATABASES = {
    "default": {
        **DATABASES["default"],
        "OPTIONS": {
            **DATABASES["default"].get("OPTIONS", {}),
            "options": "-c search_path=fg_e2e",
        },
    },
}

CSRF_TRUSTED_ORIGINS = [
    "http://127.0.0.1:4173",
]
