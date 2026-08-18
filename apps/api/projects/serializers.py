from rest_framework import serializers

from .models import Project


class ProjectSerializer(serializers.ModelSerializer):
    """Serialize a Project with the current user's role."""

    researchGroupId = serializers.PrimaryKeyRelatedField(
        source="research_group", read_only=True
    )
    currentUserRole = serializers.CharField(read_only=True)
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)
    archivedAt = serializers.DateTimeField(
        source="archived_at",
        read_only=True,
    )
    updatedAt = serializers.DateTimeField(source="updated_at", read_only=True)

    class Meta:
        model = Project
        fields = (
            "id",
            "researchGroupId",
            "name",
            "description",
            "status",
            "archivedAt",
            "currentUserRole",
            "createdAt",
            "updatedAt",
        )
        read_only_fields = fields
