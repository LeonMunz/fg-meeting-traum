"""
URL configuration for config project.
"""
from django.contrib import admin
from django.urls import path
from django.views.decorators.csrf import csrf_protect

from accounts.views import CSRFEndpoint, LoginView, LogoutView, MeView
from config.health import HealthCheckView
from projects.views import (
    ProjectDetailView,
    ProjectMembershipDetailView,
    ProjectMembershipListView,
    ResearchGroupMembersView,
    ResearchGroupProjectListView,
)
from research_groups.views import ResearchGroupDetailView, ResearchGroupListView


def csrf_protect_view(view_class):
    """Apply csrf_protect to a DRF view.

    DRF sets csrf_exempt=True on as_view() view functions, which causes
    csrf_protect to be a no-op. This helper removes csrf_exempt before
    wrapping with csrf_protect, ensuring Django's CsrfViewMiddleware
    actually enforces CSRF checks.
    """
    view_func = view_class.as_view()
    del view_func.csrf_exempt
    return csrf_protect(view_func)


urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/health/', HealthCheckView.as_view(), name='health'),
    path('api/auth/csrf/', CSRFEndpoint.as_view(), name='csrf'),
    path('api/auth/login/', csrf_protect_view(LoginView), name='login'),
    path('api/auth/logout/', csrf_protect_view(LogoutView), name='logout'),
    path('api/auth/me/', MeView.as_view(), name='me'),
    path('api/research-groups/', ResearchGroupListView.as_view(), name='research-groups-list'),
    path('api/research-groups/<int:pk>/', ResearchGroupDetailView.as_view(), name='research-groups-detail'),
    path('api/research-groups/<int:group_id>/projects/', ResearchGroupProjectListView.as_view(), name='research-group-projects-list'),
    path('api/projects/<int:project_id>/', ProjectDetailView.as_view(), name='project-detail'),
    path('api/projects/<int:project_id>/memberships/', ProjectMembershipListView.as_view(), name='project-memberships-list'),
    path('api/projects/<int:project_id>/memberships/<int:membership_id>/', ProjectMembershipDetailView.as_view(), name='project-membership-detail'),
    path('api/research-groups/<int:group_id>/members/', ResearchGroupMembersView.as_view(), name='research-group-members'),
]
