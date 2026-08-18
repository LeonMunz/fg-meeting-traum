"""Seed deterministic multi-Research-Group data for browser E2E tests."""

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from projects.models import Project
from projects.services import create_project
from research_groups.models import (
    ResearchGroup,
    ResearchGroupMembership,
)
from work_items.models import WorkItem
from work_items.services import create_work_item

User = get_user_model()


class Command(BaseCommand):
    help = "Seed additional multi-group data used only by browser E2E tests."

    def handle(self, *args, **options):
        alex = User.objects.get(username="alex")

        group, _ = ResearchGroup.objects.get_or_create(
            name="Robotics Lab",
            defaults={
                "created_by": alex,
            },
        )

        membership, _ = (
            ResearchGroupMembership.objects.get_or_create(
                research_group=group,
                user=alex,
                defaults={
                    "role": ResearchGroupMembership.Role.ADMIN,
                },
            )
        )

        if (
            membership.role
            != ResearchGroupMembership.Role.ADMIN
        ):
            membership.role = (
                ResearchGroupMembership.Role.ADMIN
            )
            membership.save(
                update_fields=["role"],
            )

        project = Project.objects.filter(
            research_group=group,
            name="E2E Robot Study",
        ).first()

        if project is None:
            project = create_project(
                research_group=group,
                creator=alex,
                name="E2E Robot Study",
            )

        work_item = WorkItem.objects.filter(
            project=project,
            title="E2E Analyze robot data",
        ).first()

        if work_item is None:
            work_item = create_work_item(
                project=project,
                actor=alex,
                type="task",
                title="E2E Analyze robot data",
                assignee_ids=[alex.pk],
            )

        self.stdout.write(
            self.style.SUCCESS(
                "Multi-group E2E scope data ready: "
                f"{group.name} / "
                f"{project.name} / "
                f"{work_item.title}"
            )
        )
