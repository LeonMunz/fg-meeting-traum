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
from projects.services import add_project_membership

User = get_user_model()

SEED_PASSWORD = os.getenv("SEED_PASSWORD", "DevPass1!")


class Command(BaseCommand):
    help = "Seed the database with synthetic development data (idempotent)."

    def handle(self, *args, **options):
        users_created, users_updated = self._seed_users()
        group_created = self._seed_research_group()
        group_memberships_created = self._seed_memberships()
        projects_created, project_memberships_created = self._seed_projects()

        self.stdout.write(
            self.style.SUCCESS(
                f"Seed complete: "
                f"{users_created} users created, {users_updated} updated, "
                f"{group_created} research group created, "
                f"{group_memberships_created} group memberships created, "
                f"{projects_created} projects created, "
                f"{project_memberships_created} project memberships created."
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
        else:
            self.stdout.write(f"  Project exists: {maria_project.name}")

        # Alex/Chris/Laura have NO membership in Maria's project

        return projects_created, memberships_created
