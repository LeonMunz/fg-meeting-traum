"""Project WorkItem configuration service operations.

All mutations are transactionally safe, Project-authorized, owner-only,
and preserve domain invariants.
"""

from django.db import transaction
from django.db.models import Max

from .models import (
    Project,
    ProjectMembership,
    WorkItemLabelDefinition,
    WorkItemStatusDefinition,
    WorkItemTypeDefinition,
)


class ConfigurationError(Exception):
    """Raised when a configuration invariant is violated."""

    def __init__(self, message):
        self.message = message
        super().__init__(message)


# ── Helpers ──


def _require_owner(project, actor):
    """Require actor is a Project owner. Raise ConfigurationError otherwise."""
    membership = ProjectMembership.objects.filter(
        project=project, user=actor
    ).first()
    if membership is None or membership.role != ProjectMembership.Role.OWNER:
        raise ConfigurationError("Only a Project owner can modify configuration.")


def _validate_name(name):
    if not name or not name.strip():
        raise ConfigurationError("Name must not be blank.")
    return name.strip()


def _check_name_unique(project, model, name, exclude_id=None):
    """Case-insensitive name uniqueness within Project."""
    qs = model.objects.filter(project=project)
    if exclude_id is not None:
        qs = qs.exclude(pk=exclude_id)
    if qs.filter(name__iexact=name).exists():
        raise ConfigurationError(
            f"A definition with name '{name}' already exists in this Project."
        )


# ── Type operations ──


def create_type_definition(project, actor, name, order=None):
    """Create a new TypeDefinition.

    Requires owner. Name must be case-insensitively unique within Project.
    """
    _require_owner(project, actor)
    name = _validate_name(name)

    with transaction.atomic():
        project_ref = Project.objects.select_for_update().get(pk=project.pk)
        _require_owner(project_ref, actor)
        _check_name_unique(project_ref, WorkItemTypeDefinition, name)

        max_order = (
            WorkItemTypeDefinition.objects.filter(project=project_ref)
            .aggregate(max_order=Max("order"))["max_order"]
        )
        if max_order is None:
            max_order = -1

        return WorkItemTypeDefinition.objects.create(
            project=project_ref,
            name=name,
            order=order if order is not None else max_order + 1,
        )


def update_type_definition(definition, actor, name=None, order=None, active=None):
    """Update an existing TypeDefinition.

    Owner only. Cannot deactivate the final active type.
    """
    _require_owner(definition.project, actor)

    with transaction.atomic():
        definition = WorkItemTypeDefinition.objects.select_for_update().get(
            pk=definition.pk
        )
        _require_owner(definition.project, actor)

        if name is not None:
            name = _validate_name(name)
            _check_name_unique(
                definition.project, WorkItemTypeDefinition, name,
                exclude_id=definition.pk,
            )
            definition.name = name

        if order is not None:
            definition.order = order

        if active is not None:
            if not active and WorkItemTypeDefinition.objects.filter(
                project=definition.project, active=True
            ).count() <= 1:
                raise ConfigurationError(
                    "Cannot deactivate the final active type."
                )
            definition.active = active

        definition.save(
            update_fields=[f for f in ("name", "order", "active")
                          if f in (name is not None, order is not None,
                                   active is not None) or True]
        )
        return definition


def reorder_type_definitions(project, actor, definition_order_pairs):
    """Reorder TypeDefinitions.

    definition_order_pairs: list of (definition_id, order).
    """
    _require_owner(project, actor)

    with transaction.atomic():
        project_ref = Project.objects.select_for_update().get(pk=project.pk)
        _require_owner(project_ref, actor)

        def_ids = [p[0] for p in definition_order_pairs]
        definitions = list(WorkItemTypeDefinition.objects.filter(
            project=project_ref, pk__in=def_ids
        ))
        def_map = {d.pk: d for d in definitions}

        for def_id, order in definition_order_pairs:
            if def_id in def_map:
                def_map[def_id].order = order

        WorkItemTypeDefinition.objects.bulk_update(
            definitions, ["order"], batch_size=500,
        )


# ── Status operations ──


def create_status_definition(project, actor, name, category, is_default=False,
                              order=None):
    """Create a new StatusDefinition.

    Requires owner. Enforces default-status invariant.
    """
    _require_owner(project, actor)
    name = _validate_name(name)

    if category not in WorkItemStatusDefinition.Category.values:
        raise ConfigurationError(f"Invalid status category: {category}")

    with transaction.atomic():
        project_ref = Project.objects.select_for_update().get(pk=project.pk)
        _require_owner(project_ref, actor)
        _check_name_unique(project_ref, WorkItemStatusDefinition, name)

        if is_default:
            if category != WorkItemStatusDefinition.Category.TODO:
                raise ConfigurationError(
                    "Default status must have category 'todo'."
                )
            # Clear existing default
            WorkItemStatusDefinition.objects.filter(
                project=project_ref, active=True, is_default=True
            ).update(is_default=False)

        max_order = (
            WorkItemStatusDefinition.objects.filter(project=project_ref)
            .aggregate(max_order=Max("order"))["max_order"]
        )
        if max_order is None:
            max_order = -1

        return WorkItemStatusDefinition.objects.create(
            project=project_ref,
            name=name,
            category=category,
            is_default=is_default,
            order=order if order is not None else max_order + 1,
        )


def update_status_definition(definition, actor, name=None, order=None,
                              active=None, category=None, is_default=None):
    """Update an existing StatusDefinition.

    Owner only. Enforces all status invariants.
    """
    _require_owner(definition.project, actor)

    with transaction.atomic():
        definition = WorkItemStatusDefinition.objects.select_for_update().get(
            pk=definition.pk
        )
        _require_owner(definition.project, actor)
        project = definition.project

        if name is not None:
            name = _validate_name(name)
            _check_name_unique(
                project, WorkItemStatusDefinition, name,
                exclude_id=definition.pk,
            )
            definition.name = name

        if order is not None:
            definition.order = order

        if category is not None:
            if category not in WorkItemStatusDefinition.Category.values:
                raise ConfigurationError(
                    f"Invalid status category: {category}"
                )
            # Category immutable once referenced by WorkItem
            if definition.work_items.exists():
                raise ConfigurationError(
                    "Cannot change category of a Status referenced by WorkItems."
                )
            # If changing away from todo and this is the default, clear default
            if (is_default or definition.is_default and
                    category != WorkItemStatusDefinition.Category.TODO):
                definition.is_default = False
            definition.category = category

        if is_default is not None:
            if is_default:
                if category is not None:
                    cat = category
                else:
                    cat = definition.category
                if cat != WorkItemStatusDefinition.Category.TODO:
                    raise ConfigurationError(
                        "Default status must have category 'todo'."
                    )
                WorkItemStatusDefinition.objects.filter(
                    project=project, active=True, is_default=True
                ).update(is_default=False)
                definition.is_default = True
            else:
                # Cannot deactivate the last active todo default without
                # replacement — check if this is the only active default todo
                if definition.category == WorkItemStatusDefinition.Category.TODO:
                    other_defaults = WorkItemStatusDefinition.objects.filter(
                        project=project, active=True,
                        is_default=True,
                        category=WorkItemStatusDefinition.Category.TODO,
                    ).exclude(pk=definition.pk)
                    # If this IS the current default, need replacement
                    if definition.is_default and other_defaults.count() == 0:
                        raise ConfigurationError(
                            "Cannot deactivate the only active default status. "
                            "Set another 'todo' status as default first."
                        )

        if active is not None:
            if not active:
                # Cannot deactivate current default
                if definition.is_default:
                    raise ConfigurationError(
                        "Cannot deactivate the current default status. "
                        "Set another 'todo' status as default first."
                    )
                # If deactivating a todo status, ensure default is safe
                if definition.category == WorkItemStatusDefinition.Category.TODO:
                    other_todo = WorkItemStatusDefinition.objects.filter(
                        project=project, active=True,
                        category=WorkItemStatusDefinition.Category.TODO,
                    ).exclude(pk=definition.pk).count()
                    if other_todo == 0 and WorkItemStatusDefinition.objects.filter(
                        project=project, active=True, is_default=True
                    ).count() <= 1:
                        raise ConfigurationError(
                            "Cannot deactivate the final active 'todo' status."
                        )
            definition.active = active

        definition.save()
        return definition


def reorder_status_definitions(project, actor, definition_order_pairs):
    """Reorder StatusDefinitions."""
    _require_owner(project, actor)

    with transaction.atomic():
        project_ref = Project.objects.select_for_update().get(pk=project.pk)
        _require_owner(project_ref, actor)

        def_ids = [p[0] for p in definition_order_pairs]
        definitions = list(WorkItemStatusDefinition.objects.filter(
            project=project_ref, pk__in=def_ids
        ))
        def_map = {d.pk: d for d in definitions}

        for def_id, order in definition_order_pairs:
            if def_id in def_map:
                def_map[def_id].order = order

        WorkItemStatusDefinition.objects.bulk_update(
            definitions, ["order"], batch_size=500,
        )


# ── Label operations ──


def create_label_definition(project, actor, name, order=None):
    """Create a new LabelDefinition."""
    _require_owner(project, actor)
    name = _validate_name(name)

    with transaction.atomic():
        project_ref = Project.objects.select_for_update().get(pk=project.pk)
        _require_owner(project_ref, actor)
        _check_name_unique(project_ref, WorkItemLabelDefinition, name)

        max_order = (
            WorkItemLabelDefinition.objects.filter(project=project_ref)
            .aggregate(max_order=Max("order"))["max_order"]
        )
        if max_order is None:
            max_order = -1

        return WorkItemLabelDefinition.objects.create(
            project=project_ref,
            name=name,
            order=order if order is not None else max_order + 1,
        )


def update_label_definition(definition, actor, name=None, order=None,
                             active=None):
    """Update an existing LabelDefinition."""
    _require_owner(definition.project, actor)

    with transaction.atomic():
        definition = WorkItemLabelDefinition.objects.select_for_update().get(
            pk=definition.pk
        )
        _require_owner(definition.project, actor)

        if name is not None:
            name = _validate_name(name)
            _check_name_unique(
                definition.project, WorkItemLabelDefinition, name,
                exclude_id=definition.pk,
            )
            definition.name = name

        if order is not None:
            definition.order = order

        if active is not None:
            definition.active = active

        definition.save()
        return definition


def reorder_label_definitions(project, actor, definition_order_pairs):
    """Reorder LabelDefinitions."""
    _require_owner(project, actor)

    with transaction.atomic():
        project_ref = Project.objects.select_for_update().get(pk=project.pk)
        _require_owner(project_ref, actor)

        def_ids = [p[0] for p in definition_order_pairs]
        definitions = list(WorkItemLabelDefinition.objects.filter(
            project=project_ref, pk__in=def_ids
        ))
        def_map = {d.pk: d for d in definitions}

        for def_id, order in definition_order_pairs:
            if def_id in def_map:
                def_map[def_id].order = order

        WorkItemLabelDefinition.objects.bulk_update(
            definitions, ["order"], batch_size=500,
        )
