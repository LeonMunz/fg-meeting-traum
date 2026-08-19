from django.contrib import admin

from .models import AuditEvent


@admin.register(AuditEvent)
class AuditEventAdmin(admin.ModelAdmin):
    """Read-only admin for append-only historical events."""

    list_display = (
        "event_type",
        "research_group",
        "actor",
        "subject_user",
        "project",
        "work_item",
        "created_at",
    )

    list_filter = (
        "event_type",
        "research_group",
    )

    search_fields = (
        "event_type",
        "actor__username",
        "subject_user__username",
        "project__name",
        "work_item__title",
    )

    raw_id_fields = (
        "research_group",
        "actor",
        "subject_user",
        "project",
        "work_item",
    )

    readonly_fields = (
        "id",
        "research_group",
        "actor",
        "event_type",
        "subject_user",
        "project",
        "work_item",
        "data",
        "created_at",
    )

    def has_add_permission(
        self,
        request,
    ):
        return False

    def has_change_permission(
        self,
        request,
        obj=None,
    ):
        return False

    def has_delete_permission(
        self,
        request,
        obj=None,
    ):
        return False
