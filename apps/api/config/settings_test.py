"""Backend-test-only Django settings.

Import with ``DJANGO_SETTINGS_MODULE=config.settings_test``.

Everything inherits from ``config.settings`` unchanged, except
``PASSWORD_HASHERS``: backend tests run with
``config.test_hashers.FastPBKDF2PasswordHasher`` (PBKDF2-SHA256, single
iteration) so the test suite does not pay the production
key-derivation cost. ``manage.py check`` and the migration-drift check
keep running on ``config.settings``; browser E2E keeps running on
``config.settings_e2e``; production keeps running on
``config.settings_production``.
"""

from .settings import *  # noqa: F401,F403

PASSWORD_HASHERS = [
    "config.test_hashers.FastPBKDF2PasswordHasher",
]
