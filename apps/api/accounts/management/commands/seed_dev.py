"""Idempotent development seed command.

Creates synthetic users, research groups, and memberships.
Safe to run multiple times without duplicating data.

Usage:
    python manage.py seed_dev

Development credentials:
    All users have password: DevPass1!
"""

import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from research_groups.models import ResearchGroup, ResearchGroupMembership

User = get_user_model()

SEED_PASSWORD = os.getenv("SEED_PASSWORD", "DevPass1!")


class Command(BaseCommand):
    help = "Seed the database with synthetic development data (idempotent)."

    def handle(self, *args, **options):
        users_created, users_updated = self._seed_users()
        group_created = self._seed_research_group()
        memberships_created = self._seed_memberships()

        self.stdout.write(
            self.style.SUCCESS(
                f"Seed complete: "
                f"{users_created} users created, {users_updated} updated, "
                f"{group_created} research group created, "
                f"{memberships_created} memberships created."
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
