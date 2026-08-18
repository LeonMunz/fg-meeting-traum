import os

from django.core.management import BaseCommand, CommandError, call_command
from django.db import connection


class Command(BaseCommand):
    help = "Reset the isolated PostgreSQL schema used by browser E2E tests."

    def handle(self, *args, **options):
        settings_module = os.environ.get(
            "DJANGO_SETTINGS_MODULE",
            "",
        )

        if settings_module != "config.settings_e2e":
            raise CommandError(
                "reset_e2e may only run with "
                "DJANGO_SETTINGS_MODULE=config.settings_e2e"
            )

        self.stdout.write("Resetting fg_e2e schema...")

        with connection.cursor() as cursor:
            cursor.execute(
                "DROP SCHEMA IF EXISTS fg_e2e CASCADE"
            )
            cursor.execute("CREATE SCHEMA fg_e2e")

        connection.close()

        self.stdout.write("Applying migrations...")

        call_command(
            "migrate",
            interactive=False,
            verbosity=0,
        )

        self.stdout.write("Seeding deterministic E2E data...")

        call_command(
            "seed_dev",
            verbosity=0,
        )

        call_command(
            "seed_e2e_scope",
            verbosity=0,
        )

        self.stdout.write(
            self.style.SUCCESS(
                "E2E database state is ready."
            )
        )
