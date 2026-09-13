"""Concurrency tests: simultaneous final-owner mutations never leave
an active Project without an Owner.

The Project row lock serializes owner-set validation and mutation; the
second operation revalidates the owner set after acquiring the lock.
"""

import threading

from django.db import connection as _db

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase

from research_groups.models import ResearchGroup, ResearchGroupMembership

from .models import Project, ProjectMembership
from .services import (
    ProjectDomainError,
    change_membership_role,
    create_project,
    remove_membership,
)

User = get_user_model()


class FinalOwnerConcurrencyTest(TransactionTestCase):
    def setUp(self):
        self.owner_a = User.objects.create_user(username="owner_a", password="Pass1!")
        self.owner_b = User.objects.create_user(username="owner_b", password="Pass1!")
        self.group = ResearchGroup.objects.create(name="G", created_by=self.owner_a)
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner_a,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.owner_b,
            role=ResearchGroupMembership.Role.MEMBER,
        )
        self.project = create_project(
            research_group=self.group,
            creator=self.owner_a,
            name="P",
        )
        ProjectMembership.objects.create(
            project=self.project,
            user=self.owner_b,
            role=ProjectMembership.Role.OWNER,
            added_by=self.owner_a,
        )

    def _owner_count(self):
        return (
            ProjectMembership.objects.filter(
                project=self.project,
                role=ProjectMembership.Role.OWNER,
            ).count()
        )

    def test_simultaneous_final_owner_removal_and_downgrade(
        self,
    ):
        # Two Owners. T1 (actor B) removes A; T2 (actor A) downgrades B.
        # Whichever commits second must be rejected: the owner set it
        # validated must have changed under the lock.
        membership_a = ProjectMembership.objects.get(
            project=self.project, user=self.owner_a
        )
        membership_b = ProjectMembership.objects.get(
            project=self.project, user=self.owner_b
        )

        results = {}
        barrier = threading.Barrier(2)

        def worker_remove():
            barrier.wait()
            try:
                remove_membership(
                    membership=membership_a,
                    actor=self.owner_b,
                )
                results["remove"] = None
            except ProjectDomainError as exc:
                results["remove"] = exc.message
            finally:
                _db.close()

        def worker_downgrade():
            barrier.wait()
            try:
                change_membership_role(
                    membership=membership_b,
                    actor=self.owner_a,
                    new_role=ProjectMembership.Role.MEMBER,
                )
                results["downgrade"] = None
            except ProjectDomainError as exc:
                results["downgrade"] = exc.message
            finally:
                _db.close()

        threads = [
            threading.Thread(target=worker_remove),
            threading.Thread(target=worker_downgrade),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        # The invariant: at least one owner always remains.
        self.assertGreaterEqual(self._owner_count(), 1)

        # Exactly one of the two conflicting operations succeeded.
        succeeded = sum(1 for value in results.values() if value is None)
        self.assertEqual(succeeded, 1)
        self.assertEqual(len(results), 2)
