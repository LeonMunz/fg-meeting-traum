"""Concurrency tests for account invitations.

Real PostgreSQL row locks and the partial unique index
(``uniq_account_invitation_pending_email``) are exercised through
threaded service calls (repository concurrency harness):

- concurrent acceptance of one token: exactly one ACCEPTED transition;
- concurrent creation for one normalized email: exactly one creation
  succeeds, the losing attempt fails with ``pending_invitation_exists``,
  and at most one PENDING invitation / usable token survives (both with
  and without a pre-existing effective pending invitation).
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

    def test_concurrent_creation_leaves_exactly_one_pending(self):
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
        # Exactly one creation wins and inserts the single PENDING row;
        # the other attempt is rejected deterministically.
        self.assertEqual(pending.count(), 1)
        self.assertEqual(rows.count(), 1)

        successes = [
            value for value in results.values() if isinstance(value, tuple)
        ]
        rejections = [
            value for value in results.values()
            if isinstance(value, AccountInvitationDomainError)
        ]
        self.assertEqual(len(results), 2)
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(rejections), 1)
        self.assertEqual(rejections[0].code, "pending_invitation_exists")

        # At most one of the returned tokens is usable: only the token
        # whose digest belongs to the surviving PENDING row can be
        # accepted.
        pending_digest = list(pending.values_list("token_digest", flat=True))[0]
        usable_tokens = sum(
            1
            for _invitation, raw_token in successes
            if digest_invitation_token(raw_token) == pending_digest
        )
        self.assertEqual(usable_tokens, 1)

    def test_concurrent_creation_against_effective_pending_is_rejected(self):
        create_account_invitation(
            actor=self.inviter, invited_email="guarded@example.com"
        )
        original = AccountInvitation.objects.get(invited_email="guarded@example.com")
        original.refresh_from_db()
        original_snapshot = (
            original.status,
            original.token_digest,
            original.expires_at,
            original.created_at,
            original.revoked_at,
        )

        inviter_a = User.objects.create_user(
            username="cguard_a",
            email="cguard_a@example.com",
            password="CInvPass1!",
        )
        inviter_b = User.objects.create_user(
            username="cguard_b",
            email="cguard_b@example.com",
            password="CInvPass1!",
        )

        results = {}
        barrier = threading.Barrier(2)

        def worker(name, actor):
            barrier.wait()
            try:
                results[name] = create_account_invitation(
                    actor=actor, invited_email="guarded@example.com"
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

        # Both attempts are rejected; the original invitation and its
        # token are completely unchanged and no second PENDING row exists.
        self.assertEqual(len(results), 2)
        for value in results.values():
            self.assertIsInstance(value, AccountInvitationDomainError)
            self.assertEqual(value.code, "pending_invitation_exists")

        original.refresh_from_db()
        self.assertEqual(
            (
                original.status,
                original.token_digest,
                original.expires_at,
                original.created_at,
                original.revoked_at,
            ),
            original_snapshot,
        )
        self.assertEqual(
            AccountInvitation.objects.filter(
                invited_email="guarded@example.com"
            ).count(),
            1,
        )
        self.assertEqual(
            AccountInvitation.objects.filter(
                invited_email="guarded@example.com",
                status=AccountInvitation.Status.PENDING,
            ).count(),
            1,
        )
