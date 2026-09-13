import os

os.environ.setdefault(
    "DJANGO_SECRET_KEY",
    "config-tests-production-module-placeholder-key",
)

from django.test import TestCase, Client


class HealthCheckTest(TestCase):
    def test_health_returns_ok(self):
        client = Client()
        response = client.get('/api/health/')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})


class CookieContractTest(TestCase):
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

    def test_production_cookie_contract_is_secure(self):
        from config import settings_production

        self.assertTrue(settings_production.SESSION_COOKIE_HTTPONLY)
        self.assertTrue(settings_production.SESSION_COOKIE_SECURE)
        self.assertEqual(settings_production.SESSION_COOKIE_SAMESITE, "Lax")
        self.assertTrue(settings_production.CSRF_COOKIE_SECURE)
        self.assertEqual(settings_production.CSRF_COOKIE_SAMESITE, "Lax")
        self.assertFalse(settings_production.DEBUG)

    def test_production_module_refuses_blank_secret_key(self):
        """An empty/whitespace DJANGO_SECRET_KEY must fail fast too:
        an empty signing key would let anyone forge session cookies."""
        import importlib
        import sys

        from django.core.exceptions import ImproperlyConfigured

        saved = os.environ.pop("DJANGO_SECRET_KEY", None)
        try:
            os.environ["DJANGO_SECRET_KEY"] = "   "
            with self.assertRaises(ImproperlyConfigured):
                importlib.reload(sys.modules["config.settings_production"])
        finally:
            if saved is not None:
                os.environ["DJANGO_SECRET_KEY"] = saved
            # Restore a working module state for the other tests.
            importlib.reload(sys.modules["config.settings_production"])

    def test_production_module_refuses_development_secret_key(self):
        """Running the production module on the committed dev secret key
        must fail fast — never silently sign session cookies with it."""
        import importlib
        import sys

        from django.core.exceptions import ImproperlyConfigured

        saved = os.environ.pop("DJANGO_SECRET_KEY", None)
        try:
            with self.assertRaises(ImproperlyConfigured):
                importlib.reload(sys.modules["config.settings_production"])
        finally:
            if saved is not None:
                os.environ["DJANGO_SECRET_KEY"] = saved
            # Restore a working module state for the other tests.
            importlib.reload(sys.modules["config.settings_production"])
