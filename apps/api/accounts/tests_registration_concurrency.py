"""Concurrency tests for invite-only account registration.

Real PostgreSQL row locks on the invitation row are exercised through
threaded service calls (repository concurrency harness):

- concurrent registration with one valid token: exactly one User is created,
  exactly one operation succeeds, the invitation ends ACCEPTED exactly once
  with ``accepted_by`` pointing at the single created User, and the losing
  attempt creates no (orphan) account.

The invitation row is the concurrency boundary; no in-process mutex or mock
concurrency is used.
"""

import threading

from django.contrib.auth import get_user_model
from django.db import connection as _db
from django.test import TransactionTestCase

from .invitation_services import (
    RegistrationDomainError,
    create_account_invitation,
    register_account_from_invitation,
)
from .models import AccountInvitation

User = get_user_model()


class RegistrationConcurrencyTest(TransactionTestCase):
    def setUp(self):
        self.inviter = User.objects.create_user(
            username="regc_inviter",
            email="regc_inviter@example.com",
            password="RegCPass1!",
        )

    def test_concurrent_registration_creates_exactly_one_account(self):
        _, token = create_account_invitation(
            actor=self.inviter, invited_email="regc_invitee@example.com"
        )
        invited_email = "regc_invitee@example.com"

        results = {}
        barrier = threading.Barrier(2)

        def worker(name, username):
            barrier.wait()
            try:
                results[name] = register_account_from_invitation(
                    token=token, username=username, password="RegCPass1!"
                )
            except RegistrationDomainError as exc:
                results[name] = exc
            finally:
                _db.close()

        threads = [
            threading.Thread(target=worker, args=("a", "regc_a")),
            threading.Thread(target=worker, args=("b", "regc_b")),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        users = [v for v in results.values() if isinstance(v, User)]
        errors = [v for v in results.values() if isinstance(v, RegistrationDomainError)]
        self.assertEqual(len(users), 1)
        self.assertEqual(len(errors), 1)
        self.assertEqual(len(results), 2)

        created = users[0]
        self.assertEqual(created.email, invited_email)

        # Exactly one User carries the invited email — no orphan account.
        self.assertEqual(
            User.objects.filter(email=invited_email).count(), 1
        )

        invitation = AccountInvitation.objects.get(invited_by=self.inviter)
        invitation.refresh_from_db()
        # Accepted exactly once, by the single created user.
        self.assertEqual(invitation.status, AccountInvitation.Status.ACCEPTED)
        self.assertEqual(invitation.accepted_by_id, created.pk)
        self.assertIsNotNone(invitation.accepted_at)

        # The losing attempt is a stable, non-creating failure.
        self.assertEqual(errors[0].code, "already_used")

    def test_late_registration_after_success_fails_cleanly(self):
        _, token = create_account_invitation(
            actor=self.inviter, invited_email="regc_late@example.com"
        )
        created = register_account_from_invitation(
            token=token, username="regc_late", password="RegCPass1!"
        )
        _db.close()

        with self.assertRaises(RegistrationDomainError) as ctx:
            register_account_from_invitation(
                token=token, username="regc_late2", password="RegCPass1!"
            )
            _db.close()
        self.assertEqual(ctx.exception.code, "already_used")
        self.assertEqual(
            User.objects.filter(email="regc_late@example.com").count(), 1
        )
        self.assertEqual(User.objects.filter(pk=created.pk).count(), 1)
