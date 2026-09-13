"""Concurrency tests for account invitations.

Real PostgreSQL row locks and the partial unique index
(``uniq_account_invitation_pending_email``) are exercised through
threaded service calls (repository concurrency harness):

- concurrent acceptance of one token: exactly one ACCEPTED transition;
- concurrent creation/replacement for one normalized email: at most one
  PENDING invitation and at most one usable token survive.
"""

import threading

from django.contrib.auth import get_user_model
from django.db import connection as _db
from django.test import TransactionTestCase

from .invitation_services import (
    AccountInvitationDomainError,
    accept_account_invitation,
    create_account_invitation,
    digest_invitation_token,
)
from .models import AccountInvitation

User = get_user_model()


class AccountInvitationConcurrencyTest(TransactionTestCase):
    def setUp(self):
        self.inviter = User.objects.create_user(
            username="cinviter",
            email="cinviter@example.com",
            password="CInvPass1!",
        )

    def test_concurrent_acceptance_succeeds_exactly_once(self):
        _, token = create_account_invitation(
            actor=self.inviter, invited_email="shared@example.com"
        )
        # Two distinct accounts holding the same (non-unique) email.
        actor_a = User.objects.create_user(
            username="caccept_a", email="shared@example.com", password="CAccPass1!"
        )
        actor_b = User.objects.create_user(
            username="caccept_b", email="shared@example.com", password="CAccPass1!"
        )

        results = {}
        barrier = threading.Barrier(2)

        def worker(name, actor):
            barrier.wait()
            try:
                results[name] = accept_account_invitation(
                    actor=actor, token=token
                )
            except AccountInvitationDomainError as exc:
                results[name] = exc
            finally:
                _db.close()

        threads = [
            threading.Thread(target=worker, args=("a", actor_a)),
            threading.Thread(target=worker, args=("b", actor_b)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        successes = [
            value for value in results.values()
            if isinstance(value, AccountInvitation)
        ]
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(results), 2)

        invitation = successes[0]
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.ACCEPTED)
        self.assertIsNotNone(invitation.accepted_at)
        self.assertIsNotNone(invitation.accepted_by_id)
        self.assertIn(invitation.accepted_by_id, (actor_a.pk, actor_b.pk))

        # A late acceptance still fails; the terminal state is stable.
        with self.assertRaises(AccountInvitationDomainError):
            accept_account_invitation(actor=actor_a, token=token)
            _db.close()
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AccountInvitation.Status.ACCEPTED)
        self.assertEqual(invitation.accepted_by_id, successes[0].accepted_by_id)

    def test_concurrent_replacement_leaves_at_most_one_pending(self):
        inviter_a = self.inviter
        inviter_b = User.objects.create_user(
            username="cinviter_b",
            email="cinviter_b@example.com",
            password="CInvPass1!",
        )
        email = "race@example.com"

        results = {}
        barrier = threading.Barrier(2)

        def worker(name, actor):
            barrier.wait()
            try:
                results[name] = create_account_invitation(
                    actor=actor, invited_email=email
                )
            except AccountInvitationDomainError as exc:
                results[name] = exc
            finally:
                _db.close()

        threads = [
            threading.Thread(target=worker, args=("a", inviter_a)),
            threading.Thread(target=worker, args=("b", inviter_b)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        rows = AccountInvitation.objects.filter(invited_email=email)
        pending = rows.filter(status=AccountInvitation.Status.PENDING)
        # At most one PENDING invitation survives — in practice exactly one:
        # the last replacement always inserts a fresh pending row.
        self.assertEqual(pending.count(), 1)
        self.assertTrue(
            set(rows.values_list("status", flat=True))
            <= {
                AccountInvitation.Status.PENDING,
                AccountInvitation.Status.REVOKED,
                AccountInvitation.Status.EXPIRED,
            }
        )

        # At most one of the returned tokens is usable: only the token
        # whose digest belongs to the surviving PENDING row can be accepted.
        pending_digest = list(pending.values_list("token_digest", flat=True))[0]
        usable_tokens = 0
        for value in results.values():
            if isinstance(value, tuple):
                _invitation, raw_token = value
                if digest_invitation_token(raw_token) == pending_digest:
                    usable_tokens += 1
        self.assertEqual(usable_tokens, 1)
