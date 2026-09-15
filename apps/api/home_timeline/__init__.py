"""Home timeline read models (cross-domain, read-only).

Plain Python package — NOT a Django app (no models, not in
INSTALLED_APPS). It hosts the neutral Home read-model services that
combine more than one domain, in particular the "Today & next"
timeline candidate read model (``home_timeline.timeline``).

Single-domain Home read slices live next to their owning domain
(e.g. ``work_items.home_attention``).

Canonical domain reference: ``docs/domain/home.md``.
"""
