"""Concurrency tests: simultaneous final-admin (group Owner) mutations
never leave a ResearchGroup without an Owner.
"""

import threading

from django.db import connection as _db

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase

from .models import ResearchGroup, ResearchGroupMembership
from .services import (
    ResearchGroupDomainError,
    change_research_group_membership_role,
    remove_research_group_membership,
)

User = get_user_model()


class FinalAdminConcurrencyTest(TransactionTestCase):
    def setUp(self):
        self.admin_a = User.objects.create_user(username="admin_a", password="Pass1!")
        self.admin_b = User.objects.create_user(username="admin_b", password="Pass1!")
        self.group = ResearchGroup.objects.create(
            name="G", created_by=self.admin_a
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.admin_a,
            role=ResearchGroupMembership.Role.ADMIN,
        )
        ResearchGroupMembership.objects.create(
            research_group=self.group,
            user=self.admin_b,
            role=ResearchGroupMembership.Role.ADMIN,
        )

    def _admin_count(self):
        return ResearchGroupMembership.objects.filter(
            research_group=self.group,
            role=ResearchGroupMembership.Role.ADMIN,
        ).count()

    def test_simultaneous_final_admin_removal_and_downgrade(self):
        # Two admins. T1 (actor B) removes A; T2 (actor A) downgrades B.
        membership_a = ResearchGroupMembership.objects.get(
            research_group=self.group, user=self.admin_a
        )
        membership_b = ResearchGroupMembership.objects.get(
            research_group=self.group, user=self.admin_b
        )

        results = {}
        barrier = threading.Barrier(2)

        def worker_remove():
            barrier.wait()
            try:
                remove_research_group_membership(
                    membership=membership_a,
                    actor=self.admin_b,
                )
                results["remove"] = None
            except ResearchGroupDomainError as exc:
                results["remove"] = exc.message
            finally:
                _db.close()

        def worker_downgrade():
            barrier.wait()
            try:
                change_research_group_membership_role(
                    membership=membership_b,
                    actor=self.admin_a,
                    new_role=ResearchGroupMembership.Role.MEMBER,
                )
                results["downgrade"] = None
            except ResearchGroupDomainError as exc:
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

        self.assertGreaterEqual(self._admin_count(), 1)
        succeeded = sum(1 for value in results.values() if value is None)
        self.assertEqual(succeeded, 1)
        self.assertEqual(len(results), 2)
