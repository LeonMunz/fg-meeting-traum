from accounts.api import APIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import ResearchGroup, ResearchGroupMembership
from .serializers import ResearchGroupSerializer


class ResearchGroupListView(APIView):
    """List Research Groups the current user belongs to.

    Only returns groups where request.user has a ResearchGroupMembership.
    Requires authentication.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        memberships = ResearchGroupMembership.objects.filter(
            user=request.user,
        ).select_related("research_group")

        groups = []
        for membership in memberships:
            groups.append({
                "id": membership.research_group.pk,
                "name": membership.research_group.name,
                "role": membership.role,
            })

        return Response(groups)


class ResearchGroupDetailView(APIView):
    """Get a Research Group if the current user is a member.

    Returns 404 for groups the user cannot access (avoids leaking existence).
    Requires authentication.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            membership = ResearchGroupMembership.objects.get(
                research_group_id=pk,
                user=request.user,
            )
        except (ResearchGroupMembership.DoesNotExist, ResearchGroup.DoesNotExist):
            return Response(
                {"error": "Research group not found"},
                status=404,
            )

        group = membership.research_group
        return Response({
            "id": group.pk,
            "name": group.name,
            "role": membership.role,
        })
