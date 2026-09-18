"""Behavior tests for the reset_e2e management command's consent guard.

The destructive ``reset_e2e`` command must refuse to run unless BOTH
conditions hold, checked inside the command before any database mutation:

* ``DJANGO_SETTINGS_MODULE=config.settings_e2e`` (isolated E2E settings), and
* ``FG_ALLOW_E2E_RESET=1`` exactly (explicit consent to the reset).

Refusals must happen before any schema drop, migration, or seed. The
allowed path must keep the existing reset sequence working. All database
mutation points are instrumented (or made explosive) so these tests prove
behavior without ever touching a real database schema.
"""

import os
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase

import accounts.management.commands.reset_e2e as reset_e2e_module

CONSENT = "FG_ALLOW_E2E_RESET"
E2E_SETTINGS = "config.settings_e2e"
DEV_SETTINGS = "config.settings"


def _exploding(name):
    """A stand-in that fails the test loudly if the guarded mutation runs."""

    def _raise(*args, **kwargs):
        raise AssertionError(
            f"destructive operation started despite refusal: {name}"
        )

    return _raise


class ResetE2eConsentGuardTests(SimpleTestCase):
    """Consent and settings guards of the reset_e2e management command."""

    def _run_reset(
        self, settings_module, consent, connection_mock, call_cmd_mock
    ):
        """Call reset_e2e with controlled env and instrumented mutation points."""
        old_settings = os.environ.get("DJANGO_SETTINGS_MODULE")
        old_consent = os.environ.get(CONSENT)
        try:
            os.environ["DJANGO_SETTINGS_MODULE"] = settings_module
            if consent is None:
                os.environ.pop(CONSENT, None)
            else:
                os.environ[CONSENT] = consent
            with mock.patch.object(
                reset_e2e_module, "connection", connection_mock
            ), mock.patch.object(
                reset_e2e_module, "call_command", call_cmd_mock
            ):
                call_command("reset_e2e", stdout=StringIO())
        finally:
            if old_settings is None:
                os.environ.pop("DJANGO_SETTINGS_MODULE", None)
            else:
                os.environ["DJANGO_SETTINGS_MODULE"] = old_settings
            if old_consent is None:
                os.environ.pop(CONSENT, None)
            else:
                os.environ[CONSENT] = old_consent

    def _refusal_env(self):
        """Mutation points that fail the test if any destructive step starts."""
        connection_mock = mock.Mock(
            cursor=mock.Mock(side_effect=_exploding("connection.cursor()")),
            close=mock.Mock(side_effect=_exploding("connection.close()")),
        )
        call_cmd_mock = mock.Mock(
            side_effect=_exploding("call_command(...)")
        )
        return connection_mock, call_cmd_mock

    def _assert_refusal_message(self, error):
        message = str(error.exception)
        self.assertIn("reset_e2e", message)
        self.assertIn("REFUSED", message)
        self.assertIn("fg_e2e", message)
        self.assertIn("FG_ALLOW_E2E_RESET=1", message)

    def test_missing_consent_refused_before_any_database_operation(self):
        connection_mock, call_cmd_mock = self._refusal_env()
        with self.assertRaises(CommandError) as error:
            self._run_reset(E2E_SETTINGS, None, connection_mock, call_cmd_mock)
        self._assert_refusal_message(error)
        connection_mock.cursor.assert_not_called()
        connection_mock.close.assert_not_called()
        call_cmd_mock.assert_not_called()

    def test_empty_consent_refused_before_any_database_operation(self):
        connection_mock, call_cmd_mock = self._refusal_env()
        with self.assertRaises(CommandError) as error:
            self._run_reset(E2E_SETTINGS, "", connection_mock, call_cmd_mock)
        self._assert_refusal_message(error)
        connection_mock.cursor.assert_not_called()
        connection_mock.close.assert_not_called()
        call_cmd_mock.assert_not_called()

    def test_wrong_consent_values_refused_before_any_database_operation(self):
        for value in ("0", "2", "true", "yes", " 1", "1 "):
            with self.subTest(consent=value):
                connection_mock, call_cmd_mock = self._refusal_env()
                with self.assertRaises(CommandError) as error:
                    self._run_reset(
                        E2E_SETTINGS, value, connection_mock, call_cmd_mock
                    )
                self._assert_refusal_message(error)
                connection_mock.cursor.assert_not_called()
                connection_mock.close.assert_not_called()
                call_cmd_mock.assert_not_called()

    def test_exact_consent_allows_existing_reset_path(self):
        connection_mock = mock.MagicMock()
        cursor_ctx = connection_mock.cursor.return_value.__enter__.return_value
        call_cmd_mock = mock.Mock()
        self._run_reset(E2E_SETTINGS, "1", connection_mock, call_cmd_mock)
        # The original reset sequence runs unchanged, in order:
        cursor_ctx.execute.assert_any_call(
            "DROP SCHEMA IF EXISTS fg_e2e CASCADE"
        )
        cursor_ctx.execute.assert_any_call("CREATE SCHEMA fg_e2e")
        connection_mock.close.assert_called_once()
        self.assertEqual(
            [call.args[0] for call in call_cmd_mock.call_args_list],
            ["migrate", "seed_dev", "seed_e2e_scope"],
        )
        call_cmd_mock.assert_any_call(
            "migrate", interactive=False, verbosity=0
        )
        call_cmd_mock.assert_any_call("seed_dev", verbosity=0)
        call_cmd_mock.assert_any_call("seed_e2e_scope", verbosity=0)

    def test_settings_guard_still_effective_with_consent(self):
        connection_mock, call_cmd_mock = self._refusal_env()
        with self.assertRaises(CommandError) as error:
            self._run_reset(
                DEV_SETTINGS, "1", connection_mock, call_cmd_mock
            )
        self.assertIn("DJANGO_SETTINGS_MODULE=config.settings_e2e", str(error.exception))
        connection_mock.cursor.assert_not_called()
        connection_mock.close.assert_not_called()
        call_cmd_mock.assert_not_called()

    def test_settings_guard_refuses_without_consent(self):
        connection_mock, call_cmd_mock = self._refusal_env()
        with self.assertRaises(CommandError) as error:
            self._run_reset(
                DEV_SETTINGS, None, connection_mock, call_cmd_mock
            )
        self.assertIn("DJANGO_SETTINGS_MODULE=config.settings_e2e", str(error.exception))
        connection_mock.cursor.assert_not_called()
        connection_mock.close.assert_not_called()
        call_cmd_mock.assert_not_called()
