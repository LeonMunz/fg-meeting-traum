from django.contrib.auth import authenticate, login, logout
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from django.middleware.csrf import get_token as csrf_get_token


class CSRFEndpoint(APIView):
    """Public endpoint that ensures a CSRF cookie is set."""

    permission_classes = [AllowAny]

    def get(self, request):
        # get_token() ensures the CSRF cookie is set on the response.
        csrf_get_token(request)
        return Response({"detail": "CSRF cookie set"})


class LoginView(APIView):
    """Authenticate a user and create a server session.

    CSRF protection is enforced by csrf_protect in urls.py.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        username = request.data.get("username", "")
        password = request.data.get("password", "")

        user = authenticate(username=username, password=password)
        if user is None:
            return Response(
                {"error": "Invalid username or password"},
                status=401,
            )

        login(request, user)

        return Response({
            "id": user.pk,
            "username": user.username,
            "firstName": user.first_name,
            "lastName": user.last_name,
            "email": user.email,
        })


class LogoutView(APIView):
    """Terminate the current Django session.

    CSRF protection is enforced by csrf_protect in urls.py.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        logout(request)
        return Response({"detail": "Logged out"})


class MeView(APIView):
    """Return the current authenticated user.

    Unauthenticated requests receive a 401.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        return Response({
            "id": user.pk,
            "username": user.username,
            "firstName": user.first_name,
            "lastName": user.last_name,
            "email": user.email,
        })
