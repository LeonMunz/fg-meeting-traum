from rest_framework.response import Response
from rest_framework.views import APIView


class HealthCheckView(APIView):
    """Simple health check endpoint. No authentication or database access."""

    def get(self, request):  # noqa: ARG002
        return Response({"status": "ok"})
