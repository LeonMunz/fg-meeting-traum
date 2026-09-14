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
    - affected Work Item identity (``workItemId``) plus its CURRENT
      display title (``workItemTitle``) and owning Project /
      Research Group context (the requester can read the Work Item,
      so its current label and context are in scope);
    - ``changes``: exactly ``AuditEvent.data["changes"]`` (the
      Work Item structured diff contract; see work_items.services),
      or ``{}`` for events that carry none (e.g. work_item.created).
      The stored ``statusDefinition`` refs carry the fixed semantic
      ``category``, so a completion (transition into ``done``) is
      distinguishable from an ordinary status change from the
      persisted event alone.
    """

    id = serializers.IntegerField()
    eventType = serializers.CharField(source="event_type")
    actor = serializers.SerializerMethodField()
    workItemId = serializers.PrimaryKeyRelatedField(
        source="work_item", read_only=True,
    )
    workItemTitle = serializers.CharField(
        source="work_item.title", read_only=True,
    )
    projectId = serializers.PrimaryKeyRelatedField(
        source="work_item.project", read_only=True,
    )
    projectName = serializers.CharField(
        source="work_item.project.name", read_only=True,
    )
    researchGroupId = serializers.PrimaryKeyRelatedField(
        source="work_item.project.research_group", read_only=True,
    )
    researchGroupName = serializers.CharField(
        source="work_item.project.research_group.name", read_only=True,
    )
    changes = serializers.SerializerMethodField()
    createdAt = serializers.DateTimeField(source="created_at")

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

    def get_changes(self, obj):
        data = obj.data or {}
        return data.get("changes", {})
