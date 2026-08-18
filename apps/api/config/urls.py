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
from research_groups.views import (
    ResearchGroupDetailView,
    ResearchGroupListView,
    ResearchGroupMemberCandidateListView,
    ResearchGroupMembershipDetailView,
    ResearchGroupMembershipListView,
)


from work_items.views import (
    PersonalMyWorkView,
    MyWorkView,
    ProjectWorkItemListCreateView,
    WorkItemDetailView,
)

from meetings.views import (
    MeetingDetailView,
    MeetingItemDetailView,
    MeetingItemListCreateView,
    MeetingItemWorkItemCreateView,
    MeetingParticipantDetailView,
    MeetingParticipantListCreateView,
    ResearchGroupMeetingListCreateView,
)

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
    path('api/research-groups/<int:group_id>/member-candidates/', ResearchGroupMemberCandidateListView.as_view(), name='research-group-member-candidates'),
    path('api/research-groups/<int:group_id>/memberships/', ResearchGroupMembershipListView.as_view(), name='research-group-memberships-list'),
    path('api/research-groups/<int:group_id>/memberships/<int:membership_id>/', ResearchGroupMembershipDetailView.as_view(), name='research-group-membership-detail'),
    path('api/research-groups/<int:group_id>/projects/', ResearchGroupProjectListView.as_view(), name='research-group-projects-list'),
    path('api/projects/<int:project_id>/', ProjectDetailView.as_view(), name='project-detail'),
    path('api/projects/<int:project_id>/memberships/', ProjectMembershipListView.as_view(), name='project-memberships-list'),
    path('api/projects/<int:project_id>/memberships/<int:membership_id>/', ProjectMembershipDetailView.as_view(), name='project-membership-detail'),
    path('api/research-groups/<int:group_id>/members/', ResearchGroupMembersView.as_view(), name='research-group-members'),
    # Work Items
    path('api/projects/<int:project_id>/work-items/', ProjectWorkItemListCreateView.as_view(), name='project-work-items-list'),
    path('api/work-items/<int:work_item_id>/', WorkItemDetailView.as_view(), name='work-item-detail'),
    # My Work — authorized projection over assigned WorkItems
    path('api/me/work-items/', PersonalMyWorkView.as_view(), name='personal-my-work'),
    path('api/research-groups/<int:group_id>/my-work/', MyWorkView.as_view(), name='research-group-my-work'),

    # Meetings
    path('api/research-groups/<int:group_id>/meetings/', ResearchGroupMeetingListCreateView.as_view(), name='research-group-meetings-list'),
    path('api/meetings/<int:meeting_id>/', MeetingDetailView.as_view(), name='meeting-detail'),
    path('api/meetings/<int:meeting_id>/participants/', MeetingParticipantListCreateView.as_view(), name='meeting-participants-list'),
    path('api/meetings/<int:meeting_id>/participants/<int:participant_id>/', MeetingParticipantDetailView.as_view(), name='meeting-participant-detail'),
    path('api/meetings/<int:meeting_id>/items/', MeetingItemListCreateView.as_view(), name='meeting-items-list'),
    path('api/meeting-items/<int:meeting_item_id>/', MeetingItemDetailView.as_view(), name='meeting-item-detail'),
    path('api/meeting-items/<int:meeting_item_id>/work-items/', MeetingItemWorkItemCreateView.as_view(), name='meeting-item-work-items-create'),
]
