from django.contrib import admin

from .models import ResearchGroup, ResearchGroupMembership


@admin.register(ResearchGroup)
class ResearchGroupAdmin(admin.ModelAdmin):
    list_display = ("name", "created_by", "created_at")
    search_fields = ("name",)


@admin.register(ResearchGroupMembership)
class ResearchGroupMembershipAdmin(admin.ModelAdmin):
    list_display = ("research_group", "user", "role", "joined_at")
    list_filter = ("role",)
    search_fields = ("user__username", "research_group__name")
