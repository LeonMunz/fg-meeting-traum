from django.test import TestCase, Client


class HealthCheckTest(TestCase):
    def test_health_returns_ok(self):
        client = Client()
        response = client.get('/api/health/')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})
