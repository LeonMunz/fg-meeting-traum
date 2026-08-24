from django.contrib import admin

from .models import WorkItem, WorkItemAssignee, WorkItemComment


@admin.register(WorkItem)
class WorkItemAdmin(admin.ModelAdmin):
    """Read-only admin for WorkItem to prevent bypassing service-layer invariants."""
    list_display = ("title", "type_definition", "status_definition", "project", "created_by", "created_at")
    list_filter = ("type_definition", "status_definition", "project")
    search_fields = ("title",)
    raw_id_fields = ("project", "parent", "created_by", "type_definition", "status_definition")
    readonly_fields = (
        "id", "project", "type_definition", "title", "description", "status_definition",
        "parent", "due_date", "blocked_reason", "completed_at",
        "created_at", "updated_at", "created_by",
    )

    def has_add_permission(self, request):
        """Prevent adding WorkItems through Django admin."""
        return False

    def has_change_permission(self, request, obj=None):
        """Prevent changing WorkItems through Django admin."""
        return False

    def has_delete_permission(self, request, obj=None):
        """Prevent deleting WorkItems through Django admin."""
        return False


@admin.register(WorkItemAssignee)
class WorkItemAssigneeAdmin(admin.ModelAdmin):
    """Read-only admin for WorkItemAssignee to prevent bypassing assignment invariants."""
    list_display = ("work_item", "user")
    list_filter = ("user",)
    raw_id_fields = ("work_item", "user")
    readonly_fields = ("id", "work_item", "user")

    def has_add_permission(self, request):
        """Prevent adding assignees through Django admin."""
        return False

    def has_change_permission(self, request, obj=None):
        """Prevent changing assignees through Django admin."""
        return False

    def has_delete_permission(self, request, obj=None):
        """Prevent deleting assignees through Django admin."""
        return False


@admin.register(WorkItemComment)
class WorkItemCommentAdmin(admin.ModelAdmin):
    """Read-only admin for WorkItemComment to prevent bypassing service-layer invariants."""
    list_display = ("work_item", "author", "created_at", "updated_at")
    list_filter = ("author",)
    raw_id_fields = ("work_item", "author")
    readonly_fields = (
        "id", "work_item", "author", "body", "created_at", "updated_at",
    )

    def has_add_permission(self, request):
        """Prevent adding comments through Django admin."""
        return False

    def has_change_permission(self, request, obj=None):
        """Prevent changing comments through Django admin."""
        return False

    def has_delete_permission(self, request, obj=None):
        """Prevent deleting comments through Django admin."""
        return False
