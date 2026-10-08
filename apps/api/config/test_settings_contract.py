"""Settings-module contract for the fast backend-test hasher boundary.

Pins which settings module each execution context uses, and that the
fast single-iteration password hasher is visible only to backend test
runs:

- ``config.settings`` (normal/default): Django-default PBKDF2
  (``pbkdf2_sha256``, 1,000,000 iterations).
- ``config.settings_test`` (backend tests only):
  ``config.test_hashers.FastPBKDF2PasswordHasher``
  (``pbkdf2_sha256``, 1 iteration).
- ``config.settings_e2e`` (browser E2E): normal PBKDF2, fast test
  hasher absent.

The E2E module is probed in a separate interpreter: importing
``config.settings_e2e`` mutates the inherited ``DATABASES`` dict at
import time, so it must never be imported into the active backend-test
process.
"""

import json
import os
import subprocess
import sys

from django.conf import settings
from django.contrib.auth.hashers import (
    check_password,
    get_hasher,
    make_password,
)
from django.test import SimpleTestCase

API_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NORMAL_HASHER = "django.contrib.auth.hashers.PBKDF2PasswordHasher"
FAST_TEST_HASHER = "config.test_hashers.FastPBKDF2PasswordHasher"


def run_settings_probe(settings_module, code):
    """Evaluate Django settings in a fresh interpreter (never active)."""
    environment = os.environ.copy()
    environment["DJANGO_SETTINGS_MODULE"] = settings_module
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=API_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


PROBE_CODE = (
    "import json\n"
    "from django.conf import settings\n"
    "from django.contrib.auth.hashers import get_hasher\n"
    "hasher = get_hasher()\n"
    "print(json.dumps({\n"
    "    'hashers': settings.PASSWORD_HASHERS,\n"
    "    'algorithm': hasher.algorithm,\n"
    "    'iterations': hasher.iterations,\n"
    "}))\n"
)


class ActiveTestProcessContract(SimpleTestCase):
    """The active backend-test process runs with the fast hasher only."""

    def test_active_settings_use_only_the_fast_test_hasher(self):
        self.assertEqual(settings.PASSWORD_HASHERS, [FAST_TEST_HASHER])

    def test_active_hasher_is_single_iteration_pbkdf2_sha256(self):
        hasher = get_hasher()
        self.assertEqual(hasher.algorithm, "pbkdf2_sha256")
        self.assertEqual(hasher.iterations, 1)

    def test_active_hasher_round_trips_the_hash_format(self):
        # make_password/check_password use the active first hasher
        # (the fast test hasher) end to end.
        encoded = make_password("contract-probe-password")
        self.assertTrue(encoded.startswith("pbkdf2_sha256$1$"))
        self.assertTrue(check_password("contract-probe-password", encoded))
        self.assertFalse(check_password("wrong-password", encoded))

    def test_e2e_settings_module_is_not_imported_into_the_active_process(self):
        # config.settings_e2e mutates the inherited DATABASES dict at
        # import time (OPTIONS["options"] = "-c search_path=fg_e2e");
        # that override must not be visible in the backend-test process.
        # Django's connection handler adds an empty OPTIONS dict during
        # normal startup, so assert on the search_path override itself.
        from config import settings as normal_settings

        options = normal_settings.DATABASES["default"].get("OPTIONS", {})
        self.assertNotIn("options", options)
        self.assertNotIn("search_path=fg_e2e", options.get("options", ""))


class NormalSettingsContract(SimpleTestCase):
    """Normal settings keep the Django-default PBKDF2 work factor."""

    def test_normal_settings_keep_default_pbkdf2(self):
        result = run_settings_probe("config.settings", PROBE_CODE)
        self.assertEqual(result.returncode, 0, result.stderr)
        contract = json.loads(result.stdout)
        # Normal settings define no PASSWORD_HASHERS, so the Django
        # global default list applies: the primary (first) hasher must
        # be the default PBKDF2 with the production work factor, and
        # the fast test hasher must be absent.
        self.assertEqual(contract["hashers"][0], NORMAL_HASHER)
        self.assertEqual(contract["algorithm"], "pbkdf2_sha256")
        self.assertEqual(contract["iterations"], 1000000)
        self.assertNotIn(FAST_TEST_HASHER, contract["hashers"])


class E2ESettingsContract(SimpleTestCase):
    """E2E settings stay on normal PBKDF2 (probed in a subprocess)."""

    def test_e2e_settings_use_normal_pbkdf2_without_the_fast_test_hasher(self):
        result = run_settings_probe("config.settings_e2e", PROBE_CODE)
        self.assertEqual(result.returncode, 0, result.stderr)
        contract = json.loads(result.stdout)
        self.assertEqual(contract["hashers"][0], NORMAL_HASHER)
        self.assertEqual(contract["algorithm"], "pbkdf2_sha256")
        self.assertEqual(contract["iterations"], 1000000)
        self.assertNotIn(FAST_TEST_HASHER, contract["hashers"])
