"""Backward-compatible Markdown content persistence for MeetingItem.

Adds the transitional ``content`` column to ``meetings_item``: the
full-length Markdown source of one agenda item (Markdown source, never
rendered HTML; unbounded, so the 255-character title limit does NOT
apply to it).

The column is added with an empty default and then backfilled for
every existing item from the legacy ``title`` / ``notes`` pair: the
title, followed by the notes separated by a single blank line when the
notes are present (whitespace-only notes count as absent). The stored
``title`` and ``notes`` columns are NEVER rewritten by this migration;
existing records remain readable and no title or notes data is lost.
The backfill rule is the exact rule the canonical domain services
(``create_meeting_item`` / ``update_meeting_item``) apply on every
supported write, so a legacy row and a freshly written row carry
identical ``content`` for the same stored pair (the migration keeps
the original stored values verbatim; the application stores stripped
values, so both forms converge on the same derived content).

From this migration forward, every supported MeetingItem creation and
update keeps ``content`` synchronized with the effective legacy
pair; the legacy title/notes write contract remains AUTHORITATIVE —
``content`` is not yet the authoritative write field. Explicit
Markdown-content writing is a later API/domain slice.

Idempotent: re-running the data step never rewrites an already
consistent row.
"""

from django.db import migrations, models


def _build_content(title, notes):
    """The canonical transitional content derivation rule.

    Mirrors ``meetings.services.meeting_item_content_from_legacy``
    (migrations must stay self-contained, so the rule is duplicated
    here rather than imported).
    """
    notes = (notes or "").strip()
    if not notes:
        return title
    return f"{title}\n\n{notes}"


def backfill_meeting_item_content(apps, schema_editor):
    """Derive ``content`` for every existing MeetingItem row.

    Works against existing populated databases: rows are processed in
    stable id order and only rows whose ``content`` differs from the
    derived value are touched (a bulk column default of ``""`` was
    written by the AddField above for every pre-existing row). The
    per-row ``update`` targets a single primary key, so it is safe
    under concurrency with writers of OTHER rows; ``title`` and
    ``notes`` are never modified.
    """
    MeetingItem = apps.get_model("meetings", "MeetingItem")
    for item in MeetingItem.objects.order_by("id").iterator(chunk_size=1000):
        expected = _build_content(item.title, item.notes)
        if item.content != expected:
            MeetingItem.objects.filter(pk=item.pk).update(content=expected)


def noop(apps, schema_editor):
    return None


class Migration(migrations.Migration):

    dependencies = [
        ("meetings", "0020_meetingrecurrenceparticipant"),
    ]

    operations = [
        migrations.AddField(
            model_name="meetingitem",
            name="content",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.RunPython(
            backfill_meeting_item_content,
            noop,
        ),
    ]
