from django.conf import settings
from django.db import models

from projects.models import Project
from research_groups.models import ResearchGroup
from work_items.models import WorkItem


class MeetingSeries(models.Model):
    """A recurring meeting format (e.g. 'FG Weekly').

    Not a historical occurrence — defines identity, scope, and the
    default Meeting structure (sections) for future occurrences.
    """

    class Scope(models.TextChoices):
        GROUP = "group", "Research group"
        PROJECT = "project", "Project"

    research_group = models.ForeignKey(
        ResearchGroup,
        on_delete=models.RESTRICT,
        related_name="meeting_series",
    )
    scope = models.CharField(
        max_length=16,
        choices=Scope.choices,
        default=Scope.GROUP,
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.RESTRICT,
        related_name="meeting_series",
        null=True,
        blank=True,
    )
    title = models.CharField(max_length=255)
    description = models.TextField(default="", blank=True)
    is_archived = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meeting_series",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meetings_series"
        ordering = ["title", "id"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(scope="group", project__isnull=True)
                    | models.Q(scope="project", project__isnull=False)
                ),
                name="meetings_series_scope_project_consistent",
            )
        ]

    def __str__(self):
        return self.title


class MeetingSeriesSection(models.Model):
    """One editable section in a MeetingSeries template.

    Supports name, optional description, deterministic position,
    and active/inactive state. When a Meeting occurrence is created
    from a Series, only active sections are snapshotted.
    """

    meeting_series = models.ForeignKey(
        MeetingSeries,
        on_delete=models.CASCADE,
        related_name="series_sections",
    )
    name = models.CharField(max_length=255)
    description = models.TextField(default="", blank=True)
    position = models.PositiveIntegerField()
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "meetings_series_section"
        ordering = ["position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["meeting_series", "position"],
                name="meetings_series_section_unique_series_position",
            )
        ]

    def __str__(self):
        return f"{self.meeting_series.title}: {self.name}"


class MeetingRecurrence(models.Model):
    """A persisted recurring-meeting schedule (V1 recurrence language).

    A MeetingRecurrence stores the RULE from which meeting occurrences are
    calculated on demand for an explicitly bounded range. It is NOT a
    Meeting Template: the MeetingSeries template concepts (title, sections,
    occurrence snapshots) are a distinct concept and remain unchanged.

    Invariants:

    - ``title`` is the canonical title of the recurring SERIES: it
      identifies the series even when zero Meetings have been
      materialized, and it is the DEFAULT title of a Meeting when a
      future occurrence is materialized. Once a Meeting exists, its
      title is Meeting-owned: changing the recurrence title never
      rewrites an already-materialized Meeting's title. The title is
      INDEPENDENT of the Template's title: it is never derived from a
      Template, and renaming a Template never changes it.
    - ``series`` is the canonical Meeting Template (``MeetingSeries``)
      whose ACTIVE Sections are the content source for FUTURE
      materializations of this schedule. It is nullable ONLY as a
      documented legacy compatibility state for recurrences created
      before the Template linkage existed: the domain creation service
      (``create_meeting_recurrence``) requires a valid, persisted,
      scope-consistent Template for every NEW recurrence, and
      materializing a STILL-VIRTUAL occurrence of a template-less
      recurrence is an explicit domain error.
    - A materialized Meeting is an independent snapshot: its Sections
      and content are Meeting-owned, so later Template edits — and even
      changing this reference — never rewrite any existing Meeting.
      Deleting the referenced Template preserves the Recurrence
      (``SET_NULL``, the same semantics as ``Meeting.series``); the
      recurrence then behaves like a legacy template-less recurrence.
    - Occurrences are derived values, never persisted Meetings: creating or
      expanding a recurrence must not pre-create Meeting rows.
    - The start date is the first actual occurrence (a weekly schedule's
      start weekday must be part of its weekday pattern).
    - Monthly recurrence keeps the start date's calendar day
      (``start_date.day``); months without that day produce NO occurrence
      (the date is skipped, never shifted to the month end).
    - The configured ``local_time`` is a wall-clock time in
      ``timezone_name`` and is preserved across DST transitions.
    - ``end_mode`` is exactly one of: ``no_end``, ``end_date`` (inclusive
      final calendar date), or ``count`` (total occurrences, INCLUDING the
      first). ``end_date`` and ``occurrence_count`` are mutually exclusive,
      and each belongs to its mode only (see DB constraints).
    """

    class Scope(models.TextChoices):
        GROUP = "group", "Research group"
        PROJECT = "project", "Project"

    class Frequency(models.TextChoices):
        DAILY = "daily", "Daily"
        WEEKLY = "weekly", "Weekly"
        MONTHLY = "monthly", "Monthly"

    class EndMode(models.TextChoices):
        NO_END = "no_end", "No end"
        END_DATE = "end_date", "End date"
        COUNT = "count", "Count"

    # Ownership / context — same shape as Meeting and MeetingSeries.
    research_group = models.ForeignKey(
        ResearchGroup,
        on_delete=models.RESTRICT,
        related_name="meeting_recurrences",
    )
    scope = models.CharField(
        max_length=16,
        choices=Scope.choices,
        default=Scope.GROUP,
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.RESTRICT,
        related_name="meeting_recurrences",
        null=True,
        blank=True,
    )

    # The canonical title of the recurring series (see class docstring):
    # available even with zero materialized Meetings and the default
    # source for a newly materialized Meeting's title. Same constraints
    # and normalization conventions as Meeting.title / MeetingSeries.title
    # (non-blank after strip, max_length 255 — enforced by the creation
    # service and the column).
    title = models.CharField(max_length=255)

    # The canonical Meeting Template (Meeting Series) for this schedule:
    # the Template whose active Sections are snapshotted into every
    # FUTURE materialized occurrence (see class docstring). Nullable
    # ONLY for legacy recurrences created before the Template linkage
    # existed (migration meetings/0019); every NEW recurrence must
    # reference a valid, persisted Template through the domain creation
    # service. SET_NULL on Template deletion: the recurrence and its
    # materialized Meetings are preserved, exactly like Meeting.series.
    series = models.ForeignKey(
        MeetingSeries,
        on_delete=models.SET_NULL,
        related_name="recurrences",
        null=True,
        blank=True,
    )

    # ── The recurrence rule ─────────────────────────────────────
    frequency = models.CharField(
        max_length=16,
        choices=Frequency.choices,
    )
    # Step in units of the frequency: N days / N weeks / N months.
    # Always >= 1 (enforced by constraint + service validation).
    interval = models.PositiveSmallIntegerField()
    # Selected weekdays for weekly recurrence ONLY: sorted ISO weekday
    # integers (0 = Monday .. 6 = Sunday, matching date.weekday()).
    # Empty list for daily / monthly schedules.
    weekdays = models.JSONField(default=list)
    # Local calendar date of the FIRST occurrence (wall-clock date in
    # ``timezone_name``, not a UTC date). For monthly schedules this date's
    # calendar day is the recurring day; the day is deliberately not stored
    # separately (derived from the start date).
    start_date = models.DateField()
    # Configured local wall-clock time in ``timezone_name``; preserved
    # across DST transitions.
    local_time = models.TimeField()
    # IANA timezone name (e.g. "Europe/Berlin"); validated at creation.
    timezone_name = models.CharField(max_length=64)
    end_mode = models.CharField(
        max_length=16,
        choices=EndMode.choices,
        default=EndMode.NO_END,
    )
    # Inclusive final calendar date; END_DATE mode only.
    end_date = models.DateField(null=True, blank=True)
    # Total occurrences INCLUDING the first; COUNT mode only.
    occurrence_count = models.PositiveIntegerField(null=True, blank=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meeting_recurrences",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meetings_recurrence"
        ordering = ["start_date", "id"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(scope="group", project__isnull=True)
                    | models.Q(scope="project", project__isnull=False)
                ),
                name="meetings_recurrence_scope_project_consistent",
            ),
            models.CheckConstraint(
                condition=models.Q(interval__gte=1),
                name="meetings_recurrence_interval_positive",
            ),
            # Exactly the fields of the selected end mode may be set:
            # no_end → neither; end_date → end_date only;
            # count → occurrence_count only.
            models.CheckConstraint(
                condition=(
                    models.Q(
                        end_mode="no_end",
                        end_date__isnull=True,
                        occurrence_count__isnull=True,
                    )
                    | models.Q(
                        end_mode="end_date",
                        end_date__isnull=False,
                        occurrence_count__isnull=True,
                    )
                    | models.Q(
                        end_mode="count",
                        end_date__isnull=True,
                        occurrence_count__isnull=False,
                    )
                ),
                name="meetings_recurrence_end_mode_consistent",
            ),
            models.CheckConstraint(
                condition=models.Q(end_date__isnull=True)
                | models.Q(end_date__gte=models.F("start_date")),
                name="meetings_recurrence_end_date_not_before_start",
            ),
            # Weekday selection is a weekly-only concept.
            models.CheckConstraint(
                condition=models.Q(frequency="weekly")
                | models.Q(weekdays=[]),
                name="meetings_recurrence_weekdays_only_weekly",
            ),
        ]

    def __str__(self):
        return (
            f"{self.title} ({self.frequency} every {self.interval} "
            f"from {self.start_date})"
        )


class MeetingRecurrenceExclusion(models.Model):
    """One persistently excluded original occurrence of a recurrence.

    An exclusion removes ONE virtual occurrence from the recurrence's
    EFFECTIVE occurrence set without materializing a concrete Meeting
    and without touching the recurrence rule (see §5a of
    ``docs/domain/meetings.md``). It is the persistence basis for a
    later "cancel/delete this one meeting" operation.

    Invariants:

    - An exclusion belongs to exactly one MeetingRecurrence and exactly
      one ORIGINAL rule-produced occurrence: ``original_scheduled_at``
      is the occurrence's immutable original scheduled start (the same
      aware instant the bounded expansion returns). It never depends on
      any alternate/moved datetime, and the canonical UUIDv5 occurrence
      identity is derived from this pair — no second occurrence-ID
      system is stored.
    - ``(recurrence, original_scheduled_at)`` is UNIQUE: at most one
      exclusion row per recurrence occurrence, even under concurrent
      writes.
    - Exclusions filter the effective occurrence set AFTER rule
      generation: they consume no occurrence and generate no
      replacement (a COUNT-limited series does not grow after an
      exclusion), and different recurrences with an occurrence at the
      same timestamp exclude independently.
    - Excluding an already-materialized occurrence is NOT supported by
      this concept: the domain service rejects it. Cancellation/deletion
      of a materialized occurrence is a separate, deferred operation.
    """

    recurrence = models.ForeignKey(
        MeetingRecurrence,
        on_delete=models.CASCADE,
        related_name="exclusions",
    )
    # The occurrence's IMMUTABLE original scheduled start (the same
    # aware instant the bounded expansion returns; in the recurrence's
    # stored timezone it is the original wall-clock start). Never an
    # alternate/moved time.
    original_scheduled_at = models.DateTimeField()
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meeting_recurrence_exclusions",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "meetings_recurrence_exclusion"
        ordering = ["original_scheduled_at", "id"]
        constraints = [
            # At most one exclusion per recurrence occurrence.
            models.UniqueConstraint(
                fields=["recurrence", "original_scheduled_at"],
                name="meetings_recurrence_exclusion_unique_occurrence",
            ),
        ]

    def __str__(self):
        return (
            f"Excluded occurrence {self.original_scheduled_at} "
            f"of recurrence {self.recurrence_id}"
        )


class Meeting(models.Model):
    """One concrete meeting occurrence inside a Research Group."""

    class Status(models.TextChoices):
        UPCOMING = "upcoming", "Upcoming"
        LIVE = "live", "Live"
        COMPLETED = "completed", "Completed"
        # Terminal cancellation state for one materialized recurring
        # occurrence: the Meeting row and all its content/history are
        # preserved; only the status changes, and the occurrence is
        # removed from the effective recurrence set through its
        # MeetingRecurrenceExclusion. Reached ONLY through the
        # dedicated cancellation domain operation — never through the
        # start/end/reopen lifecycle actions, and never reversible
        # (no restore/reactivate in V1).
        CANCELLED = "cancelled", "Cancelled"

    class Scope(models.TextChoices):
        GROUP = "group", "Research group"
        PROJECT = "project", "Project"

    research_group = models.ForeignKey(
        ResearchGroup,
        on_delete=models.RESTRICT,
        related_name="meetings",
    )
    scope = models.CharField(
        max_length=16,
        choices=Scope.choices,
        default=Scope.GROUP,
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.RESTRICT,
        related_name="meetings",
        null=True,
        blank=True,
    )
    series = models.ForeignKey(
        MeetingSeries,
        on_delete=models.SET_NULL,
        related_name="occurrences",
        null=True,
        blank=True,
    )
    # The MeetingRecurrence this meeting was materialized from (None for
    # standalone and Template-created Meetings). RESTRICT: a recurrence
    # with materialized Meetings cannot be deleted.
    recurrence = models.ForeignKey(
        MeetingRecurrence,
        on_delete=models.RESTRICT,
        related_name="materialized_meetings",
        null=True,
        blank=True,
    )
    title = models.CharField(max_length=255)
    scheduled_at = models.DateTimeField()
    # For materialized occurrence Meetings: the IMMUTABLE original
    # scheduled start of the recurrence occurrence (timezone-aware
    # instant; in the recurrence's stored timezone it is the original
    # wall-clock start). Independent of ``scheduled_at``, which is the
    # Meeting's own editable planned time and may later be moved by an
    # override without touching this original identity.
    original_scheduled_at = models.DateTimeField(
        null=True,
        blank=True,
    )
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.UPCOMING,
    )
    # The official agenda item the group is currently discussing.
    # Persisted on the Meeting: "current" is NOT a MeetingItem
    # outcome, and deleting the referenced item clears it (SET_NULL).
    # A Meeting can reference at most one current item; the service
    # layer guarantees the referenced item belongs to this Meeting.
    current_meeting_item = models.OneToOneField(
        "MeetingItem",
        on_delete=models.SET_NULL,
        related_name="+",
        null=True,
        blank=True,
    )
    started_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meetings",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meetings_meeting"
        ordering = ["scheduled_at", "id"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(scope="group", project__isnull=True)
                    | models.Q(scope="project", project__isnull=False)
                ),
                name="meetings_meeting_scope_project_consistent",
            ),
            # Recurrence provenance fields are paired: a materialized
            # occurrence Meeting has BOTH; an ordinary Meeting has NEITHER.
            models.CheckConstraint(
                condition=(
                    models.Q(
                        recurrence__isnull=True,
                        original_scheduled_at__isnull=True,
                    )
                    | models.Q(
                        recurrence__isnull=False,
                        original_scheduled_at__isnull=False,
                    )
                ),
                name="meetings_meeting_recurrence_original_paired",
            ),
            # One concrete Meeting per occurrence per recurrence: the
            # immutable original occurrence start uniquely identifies the
            # occurrence within its recurrence. NULL recurrence (ordinary
            # Meetings) is unconstrained.
            models.UniqueConstraint(
                fields=["recurrence", "original_scheduled_at"],
                name="meetings_meeting_unique_recurrence_occurrence",
            ),
        ]

    def __str__(self):
        return self.title


class MeetingSection(models.Model):
    """A historical snapshot of a Series section in one Meeting.

    Created when a Meeting occurrence is generated from a Series.
    Later changes to the Series template never mutate this record.
    """

    meeting = models.ForeignKey(
        Meeting,
        on_delete=models.CASCADE,
        related_name="meeting_sections",
    )
    source_series_section = models.ForeignKey(
        MeetingSeriesSection,
        on_delete=models.SET_NULL,
        related_name="snapshots",
        null=True,
        blank=True,
    )
    name = models.CharField(max_length=255)
    description = models.TextField(default="", blank=True)
    position = models.PositiveIntegerField()
    is_visible = models.BooleanField(default=True)

    class Meta:
        db_table = "meetings_section"
        ordering = ["position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["meeting", "position"],
                name="meetings_section_unique_meeting_position",
            )
        ]

    def __str__(self):
        return f"{self.meeting.title}: {self.name}"


class MeetingParticipant(models.Model):
    """A Research Group member participating in a Meeting."""

    meeting = models.ForeignKey(
        Meeting,
        on_delete=models.CASCADE,
        related_name="participant_relations",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="meeting_participations",
    )
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "meetings_participant"
        constraints = [
            models.UniqueConstraint(
                fields=["meeting", "user"],
                name="meetings_participant_unique_meeting_user",
            )
        ]

    def __str__(self):
        return f"{self.user.username} → {self.meeting.title}"


class MeetingItem(models.Model):
    """One ordered discussion / agenda item inside a Meeting."""

    class Outcome(models.TextChoices):
        NOT_DISCUSSED = "not_discussed", "Not discussed"
        DONE = "done", "Done"
        FOLLOW_UP = "follow_up", "Follow-up"

    meeting = models.ForeignKey(
        Meeting,
        on_delete=models.CASCADE,
        related_name="items",
    )
    meeting_section = models.ForeignKey(
        MeetingSection,
        on_delete=models.CASCADE,
        related_name="items",
    )
    title = models.CharField(max_length=255)
    notes = models.TextField(default="", blank=True)
    position = models.PositiveIntegerField()
    outcome = models.CharField(
        max_length=16,
        choices=Outcome.choices,
        default=Outcome.NOT_DISCUSSED,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meeting_items",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meetings_item"
        ordering = ["position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["meeting_section", "position"],
                name="meetings_item_unique_section_position",
            ),
        ]

    def __str__(self):
        return self.title


class MeetingItemFollowUp(models.Model):
    """A source item's scheduled continuation in an existing Meeting."""

    class Status(models.TextChoices):
        SCHEDULED = "scheduled", "Scheduled"
        NEEDS_RESCHEDULE = "needs_reschedule", "Needs reschedule"
        CANCELLED = "cancelled", "Cancelled"

    source_meeting_item = models.ForeignKey(
        MeetingItem,
        on_delete=models.CASCADE,
        related_name="follow_up_schedules",
    )
    target_meeting = models.ForeignKey(
        Meeting,
        on_delete=models.RESTRICT,
        related_name="targeted_follow_up_schedules",
    )
    target_meeting_section = models.ForeignKey(
        MeetingSection,
        on_delete=models.RESTRICT,
        related_name="targeted_follow_up_schedules",
    )
    target_meeting_item = models.ForeignKey(
        MeetingItem,
        on_delete=models.SET_NULL,
        related_name="source_follow_up_schedules",
        null=True,
        blank=True,
    )
    # True only when the target MeetingItem was created by the
    # scheduling operation and has not since been mutated.  This is
    # the provenance flag that makes the "provably untouched"
    # deletion decision conservative and deterministic.  Pre-existing
    # rows (pre-migration-0013) default to False: preserve, never
    # delete.
    target_pristine = models.BooleanField(default=False)
    # The agenda position assigned to the generated target item at
    # scheduling time.  Used to detect meaningful reorders: if the
    # target item's current position differs from this value, the
    # target is no longer provably untouched.  NULL for pre-migration
    # rows (treated as not provably pristine).
    target_item_created_position = models.PositiveIntegerField(
        null=True,
        blank=True,
    )
    status = models.CharField(
        max_length=24,
        choices=Status.choices,
        default=Status.SCHEDULED,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meeting_item_follow_ups",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meetings_item_follow_up"
        ordering = ["created_at", "id"]
        constraints = [
            # A non-NULL target must not equal the source item.
            # A NULL target is allowed only for cancelled follow-ups
            # (enforced by the second constraint below).
            models.CheckConstraint(
                condition=models.Q(
                    target_meeting_item__isnull=True
                )
                | ~models.Q(
                    target_meeting_item=models.F("source_meeting_item")
                ),
                name="meetings_follow_up_target_item_is_new",
            ),
            # Every non-cancelled follow-up must retain a concrete
            # target MeetingItem.  Null is only permitted after
            # cancellation (when the generated target may be deleted).
            models.CheckConstraint(
                condition=models.Q(
                    status="cancelled"
                )
                | models.Q(
                    target_meeting_item__isnull=False
                ),
                name="meetings_follow_up_active_target_required",
            ),
            models.UniqueConstraint(
                fields=["source_meeting_item"],
                condition=~models.Q(status="cancelled"),
                name="meetings_follow_up_one_active_per_source",
            ),
        ]

    def __str__(self):
        return f"Follow-up for {self.source_meeting_item.title}"


class MeetingNote(models.Model):
    """A persistent discussion note attached to one MeetingItem.

    A MeetingNote is protocol/diary context recorded *about* a MeetingItem
    during a Live Meeting. It is NOT a Work Item: a MeetingNote has no
    Project, no status, no assignment. A separate relation
    (MeetingItem -> WorkItem) remains the canonical link to durable
    project work.

    Invariants:
    - exactly one MeetingItem owner (CASCADE on deletion)
    - author derived from the authenticated request, never client-supplied
    - content is non-empty after strip
    - ordering is deterministic (created_at, id) so the API is stable
    """

    meeting_item = models.ForeignKey(
        MeetingItem,
        on_delete=models.CASCADE,
        related_name="note_relations",
    )
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="authored_meeting_notes",
    )
    content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "meetings_note"
        ordering = ["created_at", "id"]

    def __str__(self):
        return f"Note by {self.author.username} on {self.meeting_item.title}"


class MeetingItemWorkItem(models.Model):
    """Historical link from a Meeting item to a canonical WorkItem.

    When the WorkItem was created from a persisted MeetingNote, the
    link also records that exact Note (``meeting_note``), giving
    canonical Meeting -> MeetingItem -> MeetingNote -> WorkItem
    traceability. A Note has at most one primary WorkItem, enforced
    by the ``meeting_note`` unique constraint; links without a Note
    (plain MeetingItem origin) are unaffected.
    """

    meeting_item = models.ForeignKey(
        MeetingItem,
        on_delete=models.CASCADE,
        related_name="work_item_relations",
    )
    work_item = models.ForeignKey(
        WorkItem,
        on_delete=models.CASCADE,
        related_name="meeting_item_relations",
    )
    meeting_note = models.ForeignKey(
        MeetingNote,
        on_delete=models.CASCADE,
        related_name="work_item_relations",
        null=True,
        blank=True,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.RESTRICT,
        related_name="created_meeting_work_item_links",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "meetings_item_work_item"
        constraints = [
            models.UniqueConstraint(
                fields=["meeting_item", "work_item"],
                name="meetings_item_work_item_unique_pair",
            ),
            models.UniqueConstraint(
                fields=["meeting_note"],
                name="meetings_item_work_item_unique_note",
            ),
        ]

    def __str__(self):
        return f"{self.meeting_item.title} → {self.work_item.title}"
