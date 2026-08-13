from accounts.api import APIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


class HealthCheckView(APIView):
    """Simple health check endpoint. No authentication or database access."""

    permission_classes = [AllowAny]

    def get(self, request):  # noqa: ARG002
        return Response({"status": "ok"})
