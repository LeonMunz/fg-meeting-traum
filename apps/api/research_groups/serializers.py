from rest_framework import serializers

from .models import ResearchGroup


class ResearchGroupSerializer(serializers.ModelSerializer):
    """Serialize ResearchGroup with the current user's role."""

    role = serializers.CharField(read_only=True)

    class Meta:
        model = ResearchGroup
        fields = ("id", "name", "role")
        read_only_fields = fields
