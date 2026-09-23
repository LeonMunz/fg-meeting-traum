"""
URL configuration for config project.
"""
from django.conf import settings
from django.contrib import admin

from django.urls import path
from django.views.decorators.csrf import csrf_protect

from audit_history.views import ActivityFeedView
from accounts.views import (
    AccountInvitationAcceptView,
    AccountInvitationListCreateView,
    AccountInvitationRevokeView,
    CSRFEndpoint,
    LoginView,
    LogoutView,
    MeView,
    RegisterView,
    RegistrationInvitationPreviewView,
    RegistrationPasswordPolicyView,
    SessionListView,
    SessionRevokeAllView,
    SessionRevokeOthersView,
    SessionRevokeView,
)
from accounts.views_e2e import E2EAccountInvitationFixtureView
from config.health import HealthCheckView
from home.views import HomeAggregateView
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
    MyWorkPreferencesView,
    ProjectWorkItemListCreateView,
    WorkItemCommentDetailView,
    WorkItemCommentListCreateView,
    WorkItemDetailView,
    WorkItemReorderView,
    WorkItemHistoryView,
    WorkItemStatusTransitionView,
)

from meetings.views import (
    MeetingCancelView,
    MeetingDetailView,
    MeetingEndView,
    MeetingReopenView,
    MeetingStartView,
    MeetingItemDetailView,
    MeetingItemDoneView,
    MeetingItemFocusView,
    MeetingItemFollowUpCancelView,
    MeetingItemFollowUpView,
    MeetingItemReopenView,
    MeetingItemFollowUpTargetListView,
    MeetingItemScheduleFollowUpView,
    MeetingItemNoteListCreateView,
    MeetingItemListCreateView,
    MeetingItemWorkItemCreateView,
    MeetingNoteDetailView,
    MeetingParticipantDetailView,
    MeetingParticipantListCreateView,
    MeetingRecurrenceCreateView,
    MeetingRecurrenceOccurrenceListView,
    MeetingRecurrenceOccurrenceExcludeView,
    MeetingRecurrenceOccurrenceMaterializeView,
    MeetingRecurrenceOccurrenceRescheduleView,
    MeetingRecurrencePersonalOccurrenceListView,
    MeetingSectionListCreateView,
    MeetingSectionReorderView,
    MeetingSectionDetailView,
    MeetingSeriesCreateOccurrenceView,
    MeetingSeriesDetailView,
    MeetingSeriesListCreateView,
    MeetingSeriesParticipantCandidateListView,
    MeetingSeriesSectionDetailView,
    MeetingSeriesSectionListCreateView,
    MeetingSeriesSectionReorderView,
    ResearchGroupMeetingParticipantCandidateListView,
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
    path('api/auth/register/', csrf_protect_view(RegisterView), name='register'),
    path('api/auth/registration-invitation/', csrf_protect_view(RegistrationInvitationPreviewView), name='registration-invitation'),
    path('api/auth/registration-password-policy/', csrf_protect_view(RegistrationPasswordPolicyView), name='registration-password-policy'),
    path('api/auth/sessions/', SessionListView.as_view(), name='sessions-list'),
    path('api/auth/sessions/<uuid:session_id>/revoke/', SessionRevokeView.as_view(), name='session-revoke'),
    path('api/auth/sessions/revoke-others/', SessionRevokeOthersView.as_view(), name='sessions-revoke-others'),
    path('api/auth/sessions/revoke-all/', SessionRevokeAllView.as_view(), name='sessions-revoke-all'),
    # Account Invitations (global account credential bootstrap; no membership)
    path('api/account-invitations/', AccountInvitationListCreateView.as_view(), name='account-invitations-list'),
    path('api/account-invitations/accept/', AccountInvitationAcceptView.as_view(), name='account-invitation-accept'),
    path('api/account-invitations/<uuid:public_id>/revoke/', AccountInvitationRevokeView.as_view(), name='account-invitation-revoke'),
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
    path('api/work-items/<int:work_item_id>/transition-status/', csrf_protect_view(WorkItemStatusTransitionView), name='work-item-status-transition'),
    path('api/work-items/<int:work_item_id>/history/', WorkItemHistoryView.as_view(), name='work-item-history'),
    path('api/work-items/<int:work_item_id>/comments/', WorkItemCommentListCreateView.as_view(), name='work-item-comments-list'),
    path('api/work-item-comments/<int:comment_id>/', WorkItemCommentDetailView.as_view(), name='work-item-comment-detail'),
    # Activity — permission-filtered aggregate feed over Work Item events
    path('api/activity/', ActivityFeedView.as_view(), name='activity-feed'),
    # My Work — authorized projection over assigned WorkItems
    path('api/me/work-items/', PersonalMyWorkView.as_view(), name='personal-my-work'),
    # My Work preferences — persisted personal view state (never authorization)
    path('api/me/preferences/my-work/', MyWorkPreferencesView.as_view(), name='my-work-preferences'),
    path('api/research-groups/<int:group_id>/my-work/', MyWorkView.as_view(), name='research-group-my-work'),

    # Home aggregate — read-only authenticated composition of the
    # four Home read models (Activity remains the separate /api/activity/)
    path('api/home/', HomeAggregateView.as_view(), name='home-aggregate'),

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
    path('api/research-groups/<int:group_id>/meetings/participant-candidates/', ResearchGroupMeetingParticipantCandidateListView.as_view(), name='research-group-meeting-participant-candidates'),
    path('api/meetings/<int:meeting_id>/', MeetingDetailView.as_view(), name='meeting-detail'),
    path('api/meetings/<int:meeting_id>/start', MeetingStartView.as_view(), name='meeting-start'),
    path('api/meetings/<int:meeting_id>/end', MeetingEndView.as_view(), name='meeting-end'),
    path('api/meetings/<int:meeting_id>/reopen', MeetingReopenView.as_view(), name='meeting-reopen'),
    path('api/meetings/<int:meeting_id>/cancel', MeetingCancelView.as_view(), name='meeting-cancel'),
    path('api/meetings/<int:meeting_id>/participants/', MeetingParticipantListCreateView.as_view(), name='meeting-participants-list'),
    path('api/meetings/<int:meeting_id>/participants/<int:participant_id>/', MeetingParticipantDetailView.as_view(), name='meeting-participant-detail'),
    path('api/meetings/<int:meeting_id>/items/', MeetingItemListCreateView.as_view(), name='meeting-items-list'),
    path('api/meetings/<int:meeting_id>/sections/', MeetingSectionListCreateView.as_view(), name='meeting-sections-list'),
    path('api/meetings/<int:meeting_id>/sections/reorder/', MeetingSectionReorderView.as_view(), name='meeting-sections-reorder'),
    path('api/meeting-sections/<int:section_id>/', MeetingSectionDetailView.as_view(), name='meeting-section-detail'),
    path('api/meeting-items/<int:meeting_item_id>/', MeetingItemDetailView.as_view(), name='meeting-item-detail'),
    path('api/meeting-items/<int:meeting_item_id>/focus', MeetingItemFocusView.as_view(), name='meeting-item-focus'),
    path('api/meeting-items/<int:meeting_item_id>/done', MeetingItemDoneView.as_view(), name='meeting-item-done'),
    path('api/meeting-items/<int:meeting_item_id>/reopen', MeetingItemReopenView.as_view(), name='meeting-item-reopen'),
    path('api/meeting-items/<int:meeting_item_id>/follow-up', MeetingItemFollowUpView.as_view(), name='meeting-item-follow-up'),
    path('api/meeting-items/<int:meeting_item_id>/schedule-follow-up', MeetingItemScheduleFollowUpView.as_view(), name='meeting-item-schedule-follow-up'),
    path('api/meeting-items/<int:meeting_item_id>/follow-up-targets/', MeetingItemFollowUpTargetListView.as_view(), name='meeting-item-follow-up-targets'),
    path('api/meeting-item-follow-ups/<int:follow_up_id>/cancel', MeetingItemFollowUpCancelView.as_view(), name='meeting-item-follow-up-cancel'),
    path('api/meeting-items/<int:meeting_item_id>/notes/', MeetingItemNoteListCreateView.as_view(), name='meeting-item-notes-list'),
    path('api/meeting-notes/<int:note_id>/', MeetingNoteDetailView.as_view(), name='meeting-note-detail'),
    path('api/meeting-items/<int:meeting_item_id>/work-items/', MeetingItemWorkItemCreateView.as_view(), name='meeting-item-work-items-create'),

    # Meeting Series
    path('api/research-groups/<int:group_id>/meeting-series/', MeetingSeriesListCreateView.as_view(), name='research-group-meeting-series-list'),
    path('api/meeting-series/<int:series_id>/', MeetingSeriesDetailView.as_view(), name='meeting-series-detail'),
    path('api/meeting-series/<int:series_id>/sections/', MeetingSeriesSectionListCreateView.as_view(), name='meeting-series-sections-list'),
    path('api/meeting-series/<int:series_id>/sections/reorder/', MeetingSeriesSectionReorderView.as_view(), name='meeting-series-sections-reorder'),
    path('api/meeting-series/<int:series_id>/occurrences/', MeetingSeriesCreateOccurrenceView.as_view(), name='meeting-series-occurrences'),
    path('api/meeting-series/<int:series_id>/participant-candidates/', MeetingSeriesParticipantCandidateListView.as_view(), name='meeting-series-participant-candidates'),
    path('api/meeting-series-sections/<int:section_id>/', MeetingSeriesSectionDetailView.as_view(), name='meeting-series-section-detail'),

    # Meeting Recurrences (bounded occurrence read + bounded personal
    # recurring-occurrence feed + idempotent occurrence materialization)
    path('api/meeting-recurrences/', MeetingRecurrenceCreateView.as_view(), name='meeting-recurrence-create'),
    path('api/meeting-recurrences/occurrences/', MeetingRecurrencePersonalOccurrenceListView.as_view(), name='meeting-recurrence-personal-occurrences'),
    path('api/meeting-recurrences/<int:recurrence_id>/occurrences/', MeetingRecurrenceOccurrenceListView.as_view(), name='meeting-recurrence-occurrences'),
    path('api/meeting-recurrences/<int:recurrence_id>/occurrences/exclude/', MeetingRecurrenceOccurrenceExcludeView.as_view(), name='meeting-recurrence-occurrence-exclude'),
    path('api/meeting-recurrences/<int:recurrence_id>/occurrences/materialize/', MeetingRecurrenceOccurrenceMaterializeView.as_view(), name='meeting-recurrence-occurrence-materialize'),
    path('api/meeting-recurrences/<int:recurrence_id>/occurrences/reschedule/', MeetingRecurrenceOccurrenceRescheduleView.as_view(), name='meeting-recurrence-occurrence-reschedule'),
]

# Browser-E2E-only fixture endpoints. Registered exclusively under the
# isolated E2E settings module (dedicated fg_e2e schema; the webServer in
# playwright.config.ts boots the API with it). Never reachable in any
# other environment.
if settings.SETTINGS_MODULE == "config.settings_e2e":
    urlpatterns += [
        path('api/e2e/fixture/account-invitation/', E2EAccountInvitationFixtureView.as_view(), name='e2e-account-invitation-fixture'),
    ]
