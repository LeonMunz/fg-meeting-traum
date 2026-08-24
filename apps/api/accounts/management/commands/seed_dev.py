"""Idempotent development seed command.

Creates synthetic users, research groups, memberships, and projects.
Safe to run multiple times without duplicating data.

Usage:
    python manage.py seed_dev

Development credentials:
    All users have password: DevPass1!

Projects:
    Paper XYZ (Alex=owner, Chris=member, Laura=viewer, Maria=none)
    Maria Private Project (Maria=owner, everyone else=none)
"""

import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from research_groups.models import ResearchGroup, ResearchGroupMembership
from projects.models import Project, ProjectMembership
from projects.services import (
    _create_default_work_item_configuration,
    add_project_membership,
)
from work_items.models import WorkItem, WorkItemAssignee
from work_items.services import create_work_item

User = get_user_model()

SEED_PASSWORD = os.getenv("SEED_PASSWORD", "DevPass1!")


class Command(BaseCommand):
    help = "Seed the database with synthetic development data (idempotent)."

    def handle(self, *args, **options):
        users_created, users_updated = self._seed_users()
        group_created = self._seed_research_group()
        group_memberships_created = self._seed_memberships()
        projects_created, project_memberships_created = self._seed_projects()
        work_items_created = self._seed_work_items()

        self.stdout.write(
            self.style.SUCCESS(
                f"Seed complete: "
                f"{users_created} users created, {users_updated} updated, "
                f"{group_created} research group created, "
                f"{group_memberships_created} group memberships created, "
                f"{projects_created} projects created, "
                f"{project_memberships_created} project memberships created, "
                f"{work_items_created} work items seeded."
            )
        )

    def _seed_users(self):
        usernames = ["alex", "chris", "maria", "laura"]
        first_names = {
            "alex": "Alex",
            "chris": "Chris",
            "maria": "Maria",
            "laura": "Laura",
        }
        created = 0
        updated = 0
        for username in usernames:
            user, is_new = User.objects.get_or_create(
                username=username,
                defaults={
                    "first_name": first_names[username],
                    "last_name": "Dev",
                    "email": f"{username}@example.com",
                },
            )
            if is_new:
                user.set_password(SEED_PASSWORD)
                user.save()
                created += 1
                self.stdout.write(f"  Created user: {username}")
            else:
                updated += 1
                self.stdout.write(f"  User exists: {username}")
        return created, updated

    def _seed_research_group(self):
        alex, _ = User.objects.get_or_create(username="alex")
        group, is_new = ResearchGroup.objects.get_or_create(
            name="FG Example",
            defaults={"created_by": alex},
        )
        if is_new:
            self.stdout.write(f"  Created research group: {group.name}")
        else:
            self.stdout.write(f"  Research group exists: {group.name}")
        return 1 if is_new else 0

    def _seed_memberships(self):
        group = ResearchGroup.objects.get(name="FG Example")
        memberships = [
            ("alex", ResearchGroupMembership.Role.ADMIN),
            ("chris", ResearchGroupMembership.Role.MEMBER),
            ("maria", ResearchGroupMembership.Role.MEMBER),
            ("laura", ResearchGroupMembership.Role.MEMBER),
        ]
        created = 0
        for username, role in memberships:
            user = User.objects.get(username=username)
            _, is_new = ResearchGroupMembership.objects.get_or_create(
                research_group=group,
                user=user,
                defaults={"role": role},
            )
            if is_new:
                created += 1
                self.stdout.write(f"  Created membership: {username} → {group.name} ({role})")
        return created

    def _seed_projects(self):
        group = ResearchGroup.objects.get(name="FG Example")
        alex = User.objects.get(username="alex")
        chris = User.objects.get(username="chris")
        maria = User.objects.get(username="maria")
        laura = User.objects.get(username="laura")

        projects_created = 0
        memberships_created = 0

        # ── Paper XYZ ──
        paper_xyz, is_new = Project.objects.get_or_create(
            name="Paper XYZ",
            defaults={
                "research_group": group,
                "created_by": alex,
                "status": Project.Status.ACTIVE,
                "description": "Research paper on XYZ.",
            },
        )
        if is_new:
            projects_created += 1
            self.stdout.write(f"  Created project: {paper_xyz.name}")
            # Alex is owner (created_by), but need to create the membership
            pm, created = ProjectMembership.objects.get_or_create(
                project=paper_xyz, user=alex,
                defaults={"role": ProjectMembership.Role.OWNER, "added_by": alex},
            )
            if created:
                memberships_created += 1
            _create_default_work_item_configuration(paper_xyz)
        else:
            self.stdout.write(f"  Project exists: {paper_xyz.name}")

        # Chris → member
        _, is_new = ProjectMembership.objects.get_or_create(
            project=paper_xyz, user=chris,
            defaults={"role": ProjectMembership.Role.MEMBER, "added_by": alex},
        )
        if is_new:
            memberships_created += 1
            self.stdout.write(f"  Chris → {paper_xyz.name} (member)")

        # Laura → viewer
        _, is_new = ProjectMembership.objects.get_or_create(
            project=paper_xyz, user=laura,
            defaults={"role": ProjectMembership.Role.VIEWER, "added_by": alex},
        )
        if is_new:
            memberships_created += 1
            self.stdout.write(f"  Laura → {paper_xyz.name} (viewer)")

        # Maria has NO membership in Paper XYZ

        # ── Maria Private Project ──
        maria_project, is_new = Project.objects.get_or_create(
            name="Maria Private Project",
            defaults={
                "research_group": group,
                "created_by": maria,
                "status": Project.Status.ACTIVE,
                "description": "Private project owned by Maria.",
            },
        )
        if is_new:
            projects_created += 1
            self.stdout.write(f"  Created project: {maria_project.name}")
            # Maria is owner
            pm, created = ProjectMembership.objects.get_or_create(
                project=maria_project, user=maria,
                defaults={"role": ProjectMembership.Role.OWNER, "added_by": maria},
            )
            if created:
                memberships_created += 1
            _create_default_work_item_configuration(maria_project)
        else:
            self.stdout.write(f"  Project exists: {maria_project.name}")

        # Alex/Chris/Laura have NO membership in Maria's project

        return projects_created, memberships_created

    def _seed_work_items(self):
        """Seed WorkItems for Paper XYZ (idempotent).

        Creates:
        - Epic: Literature Review (no assignee, status=in_progress)
        - Task: Rewrite Introduction (Chris, status=todo)
        - Milestone: First Draft Complete (Alex, status=todo)

        Uses get_or_create on title within the project for idempotency.
        """
        paper_xyz = Project.objects.get(name="Paper XYZ")
        alex = User.objects.get(username="alex")
        chris = User.objects.get(username="chris")

        epic_type = paper_xyz.type_definitions.get(name="Epic")
        task_type = paper_xyz.type_definitions.get(name="Task")
        milestone_type = paper_xyz.type_definitions.get(name="Milestone")
        todo_status = paper_xyz.status_definitions.get(name="Todo")
        in_progress_status = paper_xyz.status_definitions.get(name="In Progress")

        created = 0

        # ── Epic: Literature Review ──
        epic, is_new = WorkItem.objects.get_or_create(
            project=paper_xyz,
            title="Literature Review",
            defaults={
                "type_definition": epic_type,
                "status_definition": in_progress_status,
                "created_by": alex,
                "description": "Survey and summarize related work.",
            },
        )
        if is_new:
            created += 1
            self.stdout.write(f"  Created WorkItem: [epic] Literature Review")

        # ── Task: Rewrite Introduction (child of Epic) ──
        task, is_new = WorkItem.objects.get_or_create(
            project=paper_xyz,
            title="Rewrite Introduction",
            defaults={
                "type_definition": task_type,
                "status_definition": todo_status,
                "parent": epic,
                "created_by": alex,
                "description": "Update introduction with new context from literature review.",
            },
        )
        if is_new:
            created += 1
            self.stdout.write(f"  Created WorkItem: [task] Rewrite Introduction")
            # Assign Chris
            WorkItemAssignee.objects.get_or_create(
                work_item=task, user=chris,
            )
            self.stdout.write(f"  Assigned Chris → Rewrite Introduction")

        # ── Milestone: First Draft Complete ──
        milestone, is_new = WorkItem.objects.get_or_create(
            project=paper_xyz,
            title="First Draft Complete",
            defaults={
                "type_definition": milestone_type,
                "status_definition": todo_status,
                "created_by": alex,
                "description": "All sections drafted and ready for internal review.",
                "due_date": "2025-12-01",
            },
        )
        if is_new:
            created += 1
            self.stdout.write(f"  Created WorkItem: [milestone] First Draft Complete")
            # Assign Alex
            WorkItemAssignee.objects.get_or_create(
                work_item=milestone, user=alex,
            )
            self.stdout.write(f"  Assigned Alex → First Draft Complete")

        return created
