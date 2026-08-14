from django.contrib import admin

from .models import Project, ProjectMembership


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ("name", "research_group", "status", "created_by", "created_at")
    list_filter = ("status",)
    search_fields = ("name",)


@admin.register(ProjectMembership)
class ProjectMembershipAdmin(admin.ModelAdmin):
    list_display = ("project", "user", "role", "added_at", "added_by")
    list_filter = ("role",)
    search_fields = ("user__username", "project__name")
