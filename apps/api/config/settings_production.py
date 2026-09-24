"""Fail-closed production settings for the same-origin HTTPS deployment.

Import with ``DJANGO_SETTINGS_MODULE=config.settings_production``.

The deployment process must select this module explicitly. It requires all
secret, PostgreSQL, public-host, and CSRF-origin inputs from the environment.
Local development continues to use ``config.settings`` and its conveniences.
"""

import os
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

from .settings import *  # noqa: F401,F403

DEBUG = False


def _required_environment(name: str, *, preserve_whitespace: bool = False) -> str:
    value = os.environ.get(name)
    if value is None or not value.strip():
        raise ImproperlyConfigured(
            f"Production settings require a non-empty {name} environment variable."
        )
    return value if preserve_whitespace else value.strip()


def _required_csv(name: str) -> list[str]:
    raw_value = _required_environment(name)
    values = [value.strip() for value in raw_value.split(",")]
    if any(not value for value in values):
        raise ImproperlyConfigured(
            f"Production settings require {name} to contain only non-empty values."
        )
    return values

# Production cookie contract.
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

# Never run production on the committed development secret key, and
# never on a missing/blank deployment value: an empty signing key would
# let anyone forge signed session cookies for arbitrary users.
_DEV_SECRET_KEY = SECRET_KEY  # the inherited development value
SECRET_KEY = _required_environment("DJANGO_SECRET_KEY", preserve_whitespace=True)
if SECRET_KEY == _DEV_SECRET_KEY:
    raise ImproperlyConfigured(
        "Production settings require a non-empty deployment-provided "
        "DJANGO_SECRET_KEY; the development SECRET_KEY must never "
        "sign production session cookies."
    )

# Production must never inherit the usable local PostgreSQL defaults.
DATABASES = {
    "default": {
        **DATABASES["default"],
        "NAME": _required_environment("POSTGRES_DB"),
        "USER": _required_environment("POSTGRES_USER"),
        "PASSWORD": _required_environment(
            "POSTGRES_PASSWORD", preserve_whitespace=True
        ),
        "HOST": _required_environment("POSTGRES_HOST"),
        "PORT": _required_environment("POSTGRES_PORT"),
    }
}

ALLOWED_HOSTS = _required_csv("DJANGO_ALLOWED_HOSTS")
if any(
    host == "*"
    or "://" in host
    or "/" in host
    or any(character.isspace() for character in host)
    for host in ALLOWED_HOSTS
):
    raise ImproperlyConfigured(
        "DJANGO_ALLOWED_HOSTS must contain explicit comma-separated hostnames "
        "without schemes, paths, whitespace, or wildcards."
    )

CSRF_TRUSTED_ORIGINS = _required_csv("DJANGO_CSRF_TRUSTED_ORIGINS")
for origin in CSRF_TRUSTED_ORIGINS:
    try:
        parsed_origin = urlsplit(origin)
        parsed_origin.port  # Validate a supplied port while parsing the origin.
    except ValueError as error:
        raise ImproperlyConfigured(
            "DJANGO_CSRF_TRUSTED_ORIGINS must contain valid HTTPS origins."
        ) from error

    if (
        parsed_origin.scheme != "https"
        or not parsed_origin.hostname
        or "*" in parsed_origin.hostname
        or parsed_origin.username is not None
        or parsed_origin.password is not None
        or parsed_origin.path not in ("", "/")
        or parsed_origin.query
        or parsed_origin.fragment
        or "\\" in origin
        or any(character.isspace() for character in origin)
    ):
        raise ImproperlyConfigured(
            "DJANGO_CSRF_TRUSTED_ORIGINS must contain explicit HTTPS origins "
            "without credentials, paths, queries, fragments, or wildcards."
        )

# TLS terminates at one trusted reverse proxy. The application port must stay
# private so untrusted clients cannot forge X-Forwarded-Proto. Django trusts
# only that canonical proxy signal and redirects every non-secure request.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
