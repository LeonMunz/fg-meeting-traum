"""Activity API serializers.

Presentation-neutral: stable machine event codes + the persisted
structured diff only. No rendered sentences, no opaque AuditEvent
internals.
"""

from rest_framework import serializers


class ActivityEventSerializer(serializers.Serializer):
    """Structured Activity feed entry.

    Serializes an audit_history.AuditEvent for the aggregate Activity
    feed. Deliberately narrower than the AuditEvent record: no
    subject_user, no raw scope-row internals, no opaque data keys —
    only what a later feed projection needs:

    - event identity (``id``) + kind (``eventType``, a stable machine
      code, never a rendered sentence);
    - timestamp (``createdAt``);
    - actor, reusing the existing audit/history actor representation
      (``{"id", "username", "firstName", "lastName"}``); a historical
      actor whose account changed or was removed still serializes
      (the actor FK is RESTRICT precisely so historical identities
      stay addressable) and never breaks the feed;
    - affected object identity: Work Item events carry ``workItemId``
      plus the CURRENT display title (``workItemTitle``); Meeting
      events carry ``meetingId`` plus the CURRENT display title
      (``meetingTitle``); the non-matching pair is null. The requester
      can read the affected object (enforced before pagination), so its
      current label and context are in scope;
    - owning Project / Research Group context: Work Item events take it
      from the Work Item's Project; Meeting events from the Meeting's
      own scope (``projectId`` is null for group-scoped Meetings);
    - ``changes``: exactly ``AuditEvent.data["changes"]`` (the
      structured semantics contract; see work_items.services /
      meetings.services), or ``{}`` for events that carry none (e.g.
      work_item.created, meeting.created). The Work Item
      ``statusDefinition`` refs carry the fixed semantic ``category``,
      so a completion (transition into ``done``) is distinguishable
      from an ordinary status change from the persisted event alone.
    """

    id = serializers.IntegerField()
    eventType = serializers.CharField(source="event_type")
    actor = serializers.SerializerMethodField()
    workItemId = serializers.PrimaryKeyRelatedField(
        source="work_item", read_only=True,
    )
    workItemTitle = serializers.SerializerMethodField()
    meetingId = serializers.PrimaryKeyRelatedField(
        source="meeting", read_only=True,
    )
    meetingTitle = serializers.SerializerMethodField()
    projectId = serializers.SerializerMethodField()
    projectName = serializers.SerializerMethodField()
    researchGroupId = serializers.SerializerMethodField()
    researchGroupName = serializers.SerializerMethodField()
    changes = serializers.SerializerMethodField()
    createdAt = serializers.DateTimeField(source="created_at")

    def _object(self, obj):
        """The affected object: WorkItem or Meeting (never both)."""
        if obj.work_item is not None:
            return obj.work_item
        return obj.meeting

    def _project(self, obj):
        target = self._object(obj)
        if target is None:
            return None
        return target.project

    def _research_group(self, obj):
        if obj.work_item is not None:
            return obj.work_item.project.research_group
        if obj.meeting is not None:
            return obj.meeting.research_group
        return None

    def get_actor(self, obj):
        actor = obj.actor

        if actor is None:
            return None

        return {
            "id": actor.pk,
            "username": actor.username,
            "firstName": actor.first_name,
            "lastName": actor.last_name,
        }

    def get_workItemTitle(self, obj):
        if obj.work_item is None:
            return None
        return obj.work_item.title

    def get_meetingTitle(self, obj):
        if obj.meeting is None:
            return None
        return obj.meeting.title

    def get_projectId(self, obj):
        project = self._project(obj)
        if project is None:
            return None
        return project.pk

    def get_projectName(self, obj):
        project = self._project(obj)
        if project is None:
            return None
        return project.name

    def get_researchGroupId(self, obj):
        group = self._research_group(obj)
        if group is None:
            return None
        return group.pk

    def get_researchGroupName(self, obj):
        group = self._research_group(obj)
        if group is None:
            return None
        return group.name

    def get_changes(self, obj):
        data = obj.data or {}
        return data.get("changes", {})
