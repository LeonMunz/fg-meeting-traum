"""Fast password hashers for the backend test process only.

This module is imported exclusively from ``config.settings_test`` (the
backend test settings module). It must never be imported from
``config.settings``, ``config.settings_production``, or
``config.settings_e2e``: production and E2E password hashing keeps the
Django-default work factor.
"""

from django.contrib.auth.hashers import PBKDF2PasswordHasher


class FastPBKDF2PasswordHasher(PBKDF2PasswordHasher):
    """PBKDF2-SHA256 with a single iteration, for backend test runs only.

    The algorithm, salt handling, and hash format remain identical to
    the production hasher; only the iteration count drops to 1 so the
    backend test suite does not pay the production key-derivation cost
    on every ``create_user``/``set_password``/verification.
    """

    iterations = 1
