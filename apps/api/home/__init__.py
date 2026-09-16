"""Home composition layer (cross-domain, read-only).

Plain Python package — NOT a Django app (no models, not in
INSTALLED_APPS). It hosts the neutral Home composition layer that
combines the four already-implemented Home read-model services into
the single authenticated Home aggregate API (``home.views``).

Composition + serialization only: no domain logic lives here.
Eligibility predicates, authorization, ordering, time windows,
deduplication, and completion semantics all stay in the read-model
services:

- ``work_items.home_attention`` (Needs attention)
- ``home_timeline.timeline`` (Today & next)
- ``work_items.home_my_work`` (My work)
- ``home_continue.continue_working`` (Continue working)

Canonical domain reference: ``docs/domain/home.md``.
"""
