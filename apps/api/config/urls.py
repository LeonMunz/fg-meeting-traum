"""
URL configuration for config project.
"""
from django.contrib import admin

from django.urls import path
from django.views.decorators.csrf import csrf_protect

from accounts.views import CSRFEndpoint, LoginView, LogoutView, MeView
from config.health import HealthCheckView
from projects.views import (
    ProjectArchiveView,
    ProjectDetailView,
    ProjectMembershipDetailView,
    ProjectMembershipListView,
    ProjectRestoreView,
    ProjectWorkItemConfigurationView,
    ProjectWorkItemLabelDetailView,
    ProjectWorkItemLabelsView,
    ProjectWorkItemStatusDetailView,
    ProjectWorkItemStatusesView,
    ProjectWorkItemTypeDetailView,
    ProjectWorkItemTypesView,
    ResearchGroupMembersView,
    ResearchGroupProjectListView,
)
from research_groups.views import (
    ResearchGroupDetailView,
    ResearchGroupListView,
    ResearchGroupMemberCandidateListView,
    ResearchGroupMembershipDetailView,
    ResearchGroupMembershipOffboardingView,
    ResearchGroupMembershipListView,
)


from work_items.views import (
    PersonalMyWorkView,
    MyWorkView,
    ProjectWorkItemListCreateView,
    WorkItemCommentDetailView,
    WorkItemCommentListCreateView,
    WorkItemDetailView,
    WorkItemReorderView,
    WorkItemHistoryView,
)

from meetings.views import (
    MeetingDetailView,
    MeetingEndView,
    MeetingReopenView,
    MeetingStartView,
    MeetingItemDetailView,
    MeetingItemNoteListCreateView,
    MeetingItemListCreateView,
    MeetingItemWorkItemCreateView,
    MeetingNoteDetailView,
    MeetingParticipantDetailView,
    MeetingParticipantListCreateView,
    MeetingSectionListCreateView,
    MeetingSectionReorderView,
    MeetingSectionDetailView,
    MeetingSeriesCreateOccurrenceView,
    MeetingSeriesDetailView,
    MeetingSeriesListCreateView,
    MeetingSeriesSectionDetailView,
    MeetingSeriesSectionListCreateView,
    MeetingSeriesSectionReorderView,
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
    path('api/research-groups/<int:group_id>/memberships/<int:membership_id>/offboarding/', ResearchGroupMembershipOffboardingView.as_view(), name='research-group-membership-offboarding'),
    path('api/research-groups/<int:group_id>/projects/', ResearchGroupProjectListView.as_view(), name='research-group-projects-list'),
    path('api/projects/<int:project_id>/', ProjectDetailView.as_view(), name='project-detail'),
    path('api/projects/<int:project_id>/archive/', ProjectArchiveView.as_view(), name='project-archive'),
    path('api/projects/<int:project_id>/restore/', ProjectRestoreView.as_view(), name='project-restore'),
    path('api/projects/<int:project_id>/memberships/', ProjectMembershipListView.as_view(), name='project-memberships-list'),
    path('api/projects/<int:project_id>/memberships/<int:membership_id>/', ProjectMembershipDetailView.as_view(), name='project-membership-detail'),
    path('api/research-groups/<int:group_id>/members/', ResearchGroupMembersView.as_view(), name='research-group-members'),
    # Work Items
    path('api/projects/<int:project_id>/work-items/', ProjectWorkItemListCreateView.as_view(), name='project-work-items-list'),
    path('api/work-items/<int:work_item_id>/', WorkItemDetailView.as_view(), name='work-item-detail'),
    path('api/work-items/<int:work_item_id>/reorder/', csrf_protect_view(WorkItemReorderView), name='work-item-reorder'),
    path('api/work-items/<int:work_item_id>/history/', WorkItemHistoryView.as_view(), name='work-item-history'),
    path('api/work-items/<int:work_item_id>/comments/', WorkItemCommentListCreateView.as_view(), name='work-item-comments-list'),
    path('api/work-item-comments/<int:comment_id>/', WorkItemCommentDetailView.as_view(), name='work-item-comment-detail'),
    # My Work — authorized projection over assigned WorkItems
    path('api/me/work-items/', PersonalMyWorkView.as_view(), name='personal-my-work'),
    path('api/research-groups/<int:group_id>/my-work/', MyWorkView.as_view(), name='research-group-my-work'),

    # Work Item Configuration
    path('api/projects/<int:project_id>/work-item-configuration/', csrf_protect_view(ProjectWorkItemConfigurationView), name='project-work-item-config'),
    path('api/projects/<int:project_id>/work-item-configuration/types/', csrf_protect_view(ProjectWorkItemTypesView), name='project-work-item-types'),
    path('api/projects/<int:project_id>/work-item-configuration/types/<int:definition_id>/', csrf_protect_view(ProjectWorkItemTypeDetailView), name='project-work-item-type-detail'),
    path('api/projects/<int:project_id>/work-item-configuration/statuses/', csrf_protect_view(ProjectWorkItemStatusesView), name='project-work-item-statuses'),
    path('api/projects/<int:project_id>/work-item-configuration/statuses/<int:definition_id>/', csrf_protect_view(ProjectWorkItemStatusDetailView), name='project-work-item-status-detail'),
    path('api/projects/<int:project_id>/work-item-configuration/labels/', csrf_protect_view(ProjectWorkItemLabelsView), name='project-work-item-labels'),
    path('api/projects/<int:project_id>/work-item-configuration/labels/<int:definition_id>/', csrf_protect_view(ProjectWorkItemLabelDetailView), name='project-work-item-label-detail'),

    # Meetings
    path('api/research-groups/<int:group_id>/meetings/', ResearchGroupMeetingListCreateView.as_view(), name='research-group-meetings-list'),
    path('api/meetings/<int:meeting_id>/', MeetingDetailView.as_view(), name='meeting-detail'),
    path('api/meetings/<int:meeting_id>/start', MeetingStartView.as_view(), name='meeting-start'),
    path('api/meetings/<int:meeting_id>/end', MeetingEndView.as_view(), name='meeting-end'),
    path('api/meetings/<int:meeting_id>/reopen', MeetingReopenView.as_view(), name='meeting-reopen'),
    path('api/meetings/<int:meeting_id>/participants/', MeetingParticipantListCreateView.as_view(), name='meeting-participants-list'),
    path('api/meetings/<int:meeting_id>/participants/<int:participant_id>/', MeetingParticipantDetailView.as_view(), name='meeting-participant-detail'),
    path('api/meetings/<int:meeting_id>/items/', MeetingItemListCreateView.as_view(), name='meeting-items-list'),
    path('api/meetings/<int:meeting_id>/sections/', MeetingSectionListCreateView.as_view(), name='meeting-sections-list'),
    path('api/meetings/<int:meeting_id>/sections/reorder/', MeetingSectionReorderView.as_view(), name='meeting-sections-reorder'),
    path('api/meeting-sections/<int:section_id>/', MeetingSectionDetailView.as_view(), name='meeting-section-detail'),
    path('api/meeting-items/<int:meeting_item_id>/', MeetingItemDetailView.as_view(), name='meeting-item-detail'),
    path('api/meeting-items/<int:meeting_item_id>/notes/', MeetingItemNoteListCreateView.as_view(), name='meeting-item-notes-list'),
    path('api/meeting-notes/<int:note_id>/', MeetingNoteDetailView.as_view(), name='meeting-note-detail'),
    path('api/meeting-items/<int:meeting_item_id>/work-items/', MeetingItemWorkItemCreateView.as_view(), name='meeting-item-work-items-create'),

    # Meeting Series
    path('api/research-groups/<int:group_id>/meeting-series/', MeetingSeriesListCreateView.as_view(), name='research-group-meeting-series-list'),
    path('api/meeting-series/<int:series_id>/', MeetingSeriesDetailView.as_view(), name='meeting-series-detail'),
    path('api/meeting-series/<int:series_id>/sections/', MeetingSeriesSectionListCreateView.as_view(), name='meeting-series-sections-list'),
    path('api/meeting-series/<int:series_id>/sections/reorder/', MeetingSeriesSectionReorderView.as_view(), name='meeting-series-sections-reorder'),
    path('api/meeting-series/<int:series_id>/occurrences/', MeetingSeriesCreateOccurrenceView.as_view(), name='meeting-series-occurrences'),
    path('api/meeting-series-sections/<int:section_id>/', MeetingSeriesSectionDetailView.as_view(), name='meeting-series-section-detail'),
]
