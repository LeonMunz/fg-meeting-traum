import json
import os
import subprocess
import sys

from django.test import Client, SimpleTestCase, TestCase


class HealthCheckTest(TestCase):
    def test_health_returns_ok(self):
        client = Client()
        response = client.get('/api/health/')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})


class CookieContractTest(SimpleTestCase):
    """Cookie/CSRF contract, pinned per environment."""

    def test_development_cookie_contract_allows_local_http(self):
        from config import settings

        self.assertTrue(settings.SESSION_COOKIE_HTTPONLY)
        self.assertEqual(settings.SESSION_COOKIE_SAMESITE, "Lax")
        # Local HTTP development keeps Secure off.
        self.assertFalse(settings.SESSION_COOKIE_SECURE)
        # The SPA reads the CSRF token from document.cookie.
        self.assertFalse(settings.CSRF_COOKIE_HTTPONLY)
        self.assertEqual(settings.CSRF_COOKIE_SAMESITE, "Lax")


class ProductionSettingsContractTest(SimpleTestCase):
    """Evaluate each production configuration case in a fresh interpreter."""

    VALID_ENVIRONMENT = {
        "DJANGO_SECRET_KEY": "synthetic-settings-test-key-7Yz4pQ9mN2vK8cR5tW1xF6hJ3sL0dB",
        "POSTGRES_DB": "synthetic_db",
        "POSTGRES_USER": "synthetic_user",
        "POSTGRES_PASSWORD": "synthetic-password-not-a-real-secret",
        "POSTGRES_HOST": "database.internal",
        "POSTGRES_PORT": "5432",
        "DJANGO_ALLOWED_HOSTS": "workspace.example.test",
        "DJANGO_CSRF_TRUSTED_ORIGINS": "https://workspace.example.test",
    }

    def run_production_import(self, overrides=None, code=""):
        environment = os.environ.copy()
        environment.update(self.VALID_ENVIRONMENT)
        environment["DJANGO_SETTINGS_MODULE"] = "config.settings_production"
        for name, value in (overrides or {}).items():
            if value is None:
                environment.pop(name, None)
            else:
                environment[name] = value

        script = "from config import settings_production as settings\n" + code
        return subprocess.run(
            [sys.executable, "-c", script],
            cwd=os.path.dirname(os.path.dirname(__file__)),
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def assert_configuration_rejected(self, name, value=None):
        result = self.run_production_import({name: value})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(name, result.stderr)
        return result

    def test_production_security_and_proxy_contract(self):
        result = self.run_production_import(
            code=(
                "import json\n"
                "print(json.dumps({\n"
                "    'debug': settings.DEBUG,\n"
                "    'session_secure': settings.SESSION_COOKIE_SECURE,\n"
                "    'csrf_secure': settings.CSRF_COOKIE_SECURE,\n"
                "    'proxy_header': settings.SECURE_PROXY_SSL_HEADER,\n"
                "    'ssl_redirect': settings.SECURE_SSL_REDIRECT,\n"
                "}))\n"
            )
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        contract = json.loads(result.stdout)
        self.assertFalse(contract["debug"])
        self.assertTrue(contract["session_secure"])
        self.assertTrue(contract["csrf_secure"])
        self.assertEqual(
            contract["proxy_header"], ["HTTP_X_FORWARDED_PROTO", "https"]
        )
        self.assertTrue(contract["ssl_redirect"])

    def test_production_secret_is_required_and_development_secret_is_rejected(self):
        for value in (None, "   "):
            with self.subTest(value=value):
                self.assert_configuration_rejected("DJANGO_SECRET_KEY", value)

        result = self.run_production_import(
            code=(
                "import importlib, os\n"
                "from config import settings as development_settings\n"
                "os.environ['DJANGO_SECRET_KEY'] = development_settings.SECRET_KEY\n"
                "importlib.reload(settings)\n"
            )
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("development SECRET_KEY", result.stderr)

    def test_each_postgresql_input_is_required_and_non_blank(self):
        for name in (
            "POSTGRES_DB",
            "POSTGRES_USER",
            "POSTGRES_PASSWORD",
            "POSTGRES_HOST",
            "POSTGRES_PORT",
        ):
            for value in (None, "   "):
                with self.subTest(name=name, value=value):
                    self.assert_configuration_rejected(name, value)

    def test_valid_explicit_postgresql_configuration_is_accepted(self):
        result = self.run_production_import(
            code=(
                "import os\n"
                "database = settings.DATABASES['default']\n"
                "assert database['NAME'] == 'synthetic_db'\n"
                "assert database['USER'] == 'synthetic_user'\n"
                "assert database['PASSWORD'] == os.environ['POSTGRES_PASSWORD']\n"
                "assert database['HOST'] == 'database.internal'\n"
                "assert database['PORT'] == '5432'\n"
            )
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_allowed_hosts_accept_single_and_multiple_explicit_hosts(self):
        for value, expected in (
            ("workspace.example.test", ["workspace.example.test"]),
            (
                " workspace.example.test, api.example.test ",
                ["workspace.example.test", "api.example.test"],
            ),
        ):
            with self.subTest(value=value):
                result = self.run_production_import(
                    {"DJANGO_ALLOWED_HOSTS": value},
                    "import json\nprint(json.dumps(settings.ALLOWED_HOSTS))\n",
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), expected)

    def test_allowed_hosts_reject_missing_empty_and_wildcard_values(self):
        for value in (None, "", "   ", "*"):
            with self.subTest(value=value):
                self.assert_configuration_rejected("DJANGO_ALLOWED_HOSTS", value)

    def test_csrf_origins_are_explicit_https_and_do_not_include_development(self):
        result = self.run_production_import(
            {
                "DJANGO_CSRF_TRUSTED_ORIGINS": (
                    " https://workspace.example.test,https://admin.example.test "
                )
            },
            "import json\nprint(json.dumps(settings.CSRF_TRUSTED_ORIGINS))\n",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        origins = json.loads(result.stdout)
        self.assertEqual(
            origins,
            ["https://workspace.example.test", "https://admin.example.test"],
        )
        self.assertNotIn("http://localhost:5173", origins)
        self.assertNotIn("http://127.0.0.1:5173", origins)

    def test_csrf_origins_reject_missing_empty_and_invalid_values(self):
        for value in (
            None,
            "",
            "   ",
            "http://workspace.example.test",
            "https://workspace.example.test/path",
            "https://user:password@workspace.example.test",
            "https://*.example.test",
            "https:// workspace.example.test",
            "https://workspace.example.test\\unexpected",
            "not-an-origin",
        ):
            with self.subTest(value=value):
                self.assert_configuration_rejected(
                    "DJANGO_CSRF_TRUSTED_ORIGINS", value
                )

    def test_failure_messages_do_not_expose_database_password(self):
        sensitive_value = "sensitive-synthetic-password-value"
        result = self.run_production_import(
            {"POSTGRES_PASSWORD": sensitive_value, "POSTGRES_HOST": None}
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(sensitive_value, result.stdout)
        self.assertNotIn(sensitive_value, result.stderr)

    def test_development_settings_keep_local_defaults(self):
        environment = os.environ.copy()
        for name in self.VALID_ENVIRONMENT:
            environment.pop(name, None)
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "from config import settings\n"
                    "database = settings.DATABASES['default']\n"
                    "assert database['NAME'] == 'fg_workspace'\n"
                    "assert database['USER'] == 'fg_workspace'\n"
                    "assert database['PASSWORD'] == 'fg_workspace'\n"
                    "assert database['HOST'] == 'localhost'\n"
                    "assert database['PORT'] == '5432'\n"
                    "assert settings.ALLOWED_HOSTS == []\n"
                    "assert 'http://localhost:5173' in settings.CSRF_TRUSTED_ORIGINS\n"
                ),
            ],
            cwd=os.path.dirname(os.path.dirname(__file__)),
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
