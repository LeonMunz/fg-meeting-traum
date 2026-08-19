"""Tests for WorkItem comments: model, service layer, and the
GET/POST /api/work-items/{id}/comments/ + PATCH/DELETE
/api/work-item-comments/{id}/ APIs.

Comments are human discussion, deliberately separate from AuditEvent
history — they are never recorded as audit events (see
work_items.tests_history for that contract).
"""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APITestCase

from .models import WorkItem, WorkItemComment
from .services import (
    WorkItemDomainError,
    create_work_item,
    create_work_item_comment,
    delete_work_item_comment,
    update_work_item_comment,
)
from .tests_api import _AuthMixin, _setup_test_data

User = get_user_model()


# ── Service-layer tests ──


class CreateWorkItemCommentServiceTest(TestCase):
    def setUp(self):
        self.data = _setup_test_data()

    def test_owner_can_create_comment(self):
        comment = create_work_item_comment(
            work_item=self.data["work_item"],
            actor=self.data["alex"],
            body="Looks good to me.",
        )

        self.assertEqual(comment.author, self.data["alex"])
        self.assertEqual(comment.body, "Looks good to me.")
        self.assertEqual(
            comment.work_item, self.data["work_item"],
        )

    def test_member_can_create_comment(self):
        comment = create_work_item_comment(
            work_item=self.data["work_item"],
            actor=self.data["chris"],
            body="I'll take this one.",
        )
        self.assertEqual(comment.author, self.data["chris"])

    def test_viewer_cannot_create_comment(self):
        with self.assertRaises(WorkItemDomainError):
            create_work_item_comment(
                work_item=self.data["work_item"],
                actor=self.data["laura"],
                body="Trying to comment.",
            )

    def test_non_member_cannot_create_comment(self):
        with self.assertRaises(WorkItemDomainError):
            create_work_item_comment(
                work_item=self.data["work_item"],
                actor=self.data["maria"],
                body="Trying to comment.",
            )

    def test_empty_body_rejected(self):
        with self.assertRaises(WorkItemDomainError):
            create_work_item_comment(
                work_item=self.data["work_item"],
                actor=self.data["alex"],
                body="",
            )

    def test_whitespace_only_body_rejected(self):
        with self.assertRaises(WorkItemDomainError):
            create_work_item_comment(
                work_item=self.data["work_item"],
                actor=self.data["alex"],
                body="   \n\t  ",
            )

    def test_body_is_stripped(self):
        comment = create_work_item_comment(
            work_item=self.data["work_item"],
            actor=self.data["alex"],
            body="  Trimmed please.  ",
        )
        self.assertEqual(comment.body, "Trimmed please.")


class UpdateDeleteWorkItemCommentServiceTest(TestCase):
    def setUp(self):
        self.data = _setup_test_data()
        self.comment = create_work_item_comment(
            work_item=self.data["work_item"],
            actor=self.data["chris"],
            body="Original comment.",
        )

    def test_author_can_edit_own_comment(self):
        updated = update_work_item_comment(
            comment=self.comment,
            actor=self.data["chris"],
            body="Edited comment.",
        )
        self.assertEqual(updated.body, "Edited comment.")

    def test_non_author_cannot_edit_comment(self):
        with self.assertRaises(WorkItemDomainError):
            update_work_item_comment(
                comment=self.comment,
                actor=self.data["alex"],
                body="Trying to edit someone else's comment.",
            )

    def test_edit_rejects_empty_body(self):
        with self.assertRaises(WorkItemDomainError):
            update_work_item_comment(
                comment=self.comment,
                actor=self.data["chris"],
                body="   ",
            )

    def test_author_can_delete_own_comment(self):
        delete_work_item_comment(
            comment=self.comment, actor=self.data["chris"],
        )
        self.assertFalse(
            WorkItemComment.objects.filter(
                pk=self.comment.pk,
            ).exists()
        )

    def test_non_author_cannot_delete_comment(self):
        with self.assertRaises(WorkItemDomainError):
            delete_work_item_comment(
                comment=self.comment, actor=self.data["alex"],
            )
        self.assertTrue(
            WorkItemComment.objects.filter(
                pk=self.comment.pk,
            ).exists()
        )


# ── API tests ──


class WorkItemCommentListCreateApiTest(_AuthMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def _list(self, username, work_item):
        self._login(username)
        return self.client.get(
            f"/api/work-items/{work_item.pk}/comments/"
        )

    def _create(self, username, work_item, body):
        self._login(username)
        csrf = self._get_csrf_token()
        return self.client.post(
            f"/api/work-items/{work_item.pk}/comments/",
            data={"body": body},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

    # 1. authorized owner/member can create comment

    def test_owner_can_create_comment(self):
        response = self._create(
            "alex", self.data["work_item"], "Owner comment.",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            response.json()["body"], "Owner comment.",
        )

    def test_member_can_create_comment(self):
        response = self._create(
            "chris", self.data["work_item"], "Member comment.",
        )
        self.assertEqual(response.status_code, 201)

    # 2. viewer cannot create

    def test_viewer_cannot_create_comment(self):
        response = self._create(
            "laura", self.data["work_item"], "Viewer comment.",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            WorkItemComment.objects.filter(
                work_item=self.data["work_item"],
            ).count(),
            0,
        )

    # 3. RG member without ProjectMembership cannot read/create

    def test_non_member_cannot_read_comments(self):
        response = self._list(
            "maria", self.data["work_item"],
        )
        self.assertEqual(response.status_code, 404)

    def test_non_member_cannot_create_comment(self):
        response = self._create(
            "maria", self.data["work_item"], "Trying to comment.",
        )
        self.assertEqual(response.status_code, 404)

    # 4. anonymous cannot read/create

    def test_anonymous_cannot_read_comments(self):
        response = self.client.get(
            f"/api/work-items/{self.data['work_item'].pk}/comments/"
        )
        self.assertEqual(response.status_code, 401)

    def test_anonymous_cannot_create_comment(self):
        response = self.client.post(
            f"/api/work-items/{self.data['work_item'].pk}/comments/",
            data={"body": "Anonymous comment."},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)

    # 5. empty/whitespace-only body rejected

    def test_empty_body_rejected(self):
        response = self._create(
            "alex", self.data["work_item"], "",
        )
        self.assertEqual(response.status_code, 400)

    def test_whitespace_only_body_rejected(self):
        response = self._create(
            "alex", self.data["work_item"], "   ",
        )
        self.assertEqual(response.status_code, 400)

    # 6. comments belong only to the requested WorkItem

    def test_comments_scoped_to_requested_work_item_only(self):
        wi_b = create_work_item(
            project=self.data["paper_xyz"],
            actor=self.data["alex"],
            type=WorkItem.Type.TASK,
            title="Work Item B",
        )
        self._create(
            "alex", self.data["work_item"], "Comment on A.",
        )
        self._create(
            "alex", wi_b, "Comment on B.",
        )

        response_a = self._list("alex", self.data["work_item"])
        response_b = self._list("alex", wi_b)

        bodies_a = [c["body"] for c in response_a.json()]
        bodies_b = [c["body"] for c in response_b.json()]

        self.assertEqual(bodies_a, ["Comment on A."])
        self.assertEqual(bodies_b, ["Comment on B."])

    # 7. newest-first ordering

    def test_returns_newest_first(self):
        self._create(
            "alex", self.data["work_item"], "First.",
        )
        self._create(
            "chris", self.data["work_item"], "Second.",
        )

        response = self._list("alex", self.data["work_item"])
        bodies = [c["body"] for c in response.json()]
        self.assertEqual(bodies, ["Second.", "First."])

    # 8. author data serialized correctly

    def test_response_shape_and_author_serialization(self):
        self._create(
            "chris", self.data["work_item"], "Shape check.",
        )
        response = self._list("alex", self.data["work_item"])
        body = response.json()

        self.assertEqual(len(body), 1)
        entry = body[0]
        self.assertEqual(
            set(entry.keys()),
            {
                "id", "workItemId", "author", "body",
                "createdAt", "updatedAt",
            },
        )
        self.assertEqual(
            entry["workItemId"], self.data["work_item"].pk,
        )
        self.assertEqual(
            entry["author"],
            {
                "id": self.data["chris"].pk,
                "username": "chris",
                "firstName": "",
                "lastName": "",
            },
        )
        self.assertEqual(entry["body"], "Shape check.")

    def test_owner_member_viewer_can_all_read(self):
        self._create(
            "alex", self.data["work_item"], "Readable by all.",
        )
        for username in ("alex", "chris", "laura"):
            response = self._list(
                username, self.data["work_item"],
            )
            self.assertEqual(
                response.status_code, 200, msg=username,
            )
            self.assertEqual(len(response.json()), 1)


class WorkItemCommentDetailApiTest(_AuthMixin, APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()

    def setUp(self):
        super().setUp()
        self.comment = create_work_item_comment(
            work_item=self.data["work_item"],
            actor=self.data["chris"],
            body="Chris's original comment.",
        )

    def _patch(self, username, comment_id, body):
        self._login(username)
        csrf = self._get_csrf_token()
        return self.client.patch(
            f"/api/work-item-comments/{comment_id}/",
            data={"body": body},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

    def _delete(self, username, comment_id):
        self._login(username)
        csrf = self._get_csrf_token()
        return self.client.delete(
            f"/api/work-item-comments/{comment_id}/",
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )

    # 9. own edit/delete

    def test_author_can_edit_own_comment(self):
        response = self._patch(
            "chris", self.comment.pk, "Edited by author.",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["body"], "Edited by author.",
        )

    def test_author_can_delete_own_comment(self):
        response = self._delete("chris", self.comment.pk)
        self.assertEqual(response.status_code, 204)
        self.assertFalse(
            WorkItemComment.objects.filter(
                pk=self.comment.pk,
            ).exists()
        )

    # 10. another normal member cannot edit/delete someone else's comment

    def test_another_member_cannot_edit_others_comment(self):
        response = self._patch(
            "alex", self.comment.pk, "Hijacked edit.",
        )
        self.assertEqual(response.status_code, 403)
        self.comment.refresh_from_db()
        self.assertEqual(
            self.comment.body, "Chris's original comment.",
        )

    def test_another_member_cannot_delete_others_comment(self):
        response = self._delete("alex", self.comment.pk)
        self.assertEqual(response.status_code, 403)
        self.assertTrue(
            WorkItemComment.objects.filter(
                pk=self.comment.pk,
            ).exists()
        )

    def test_edit_rejects_empty_body(self):
        response = self._patch("chris", self.comment.pk, "   ")
        self.assertEqual(response.status_code, 400)

    def test_non_member_cannot_edit_or_delete(self):
        response = self._patch(
            "maria", self.comment.pk, "Trying to edit.",
        )
        self.assertEqual(response.status_code, 404)

        response = self._delete("maria", self.comment.pk)
        self.assertEqual(response.status_code, 404)

    def test_anonymous_cannot_edit_or_delete(self):
        response = self.client.patch(
            f"/api/work-item-comments/{self.comment.pk}/",
            data={"body": "Anon edit."},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)

        response = self.client.delete(
            f"/api/work-item-comments/{self.comment.pk}/",
        )
        self.assertEqual(response.status_code, 401)


class WorkItemCommentAdminIsolationTest(_AuthMixin, APITestCase):
    """A private Project's comments must never leak across Projects,
    even to a Research Group admin without ProjectMembership —
    matching WorkItemAdminIsolationTest for plain WorkItem reads."""

    @classmethod
    def setUpTestData(cls):
        cls.data = _setup_test_data()
        cls.maria_project = _create_maria_project(cls.data)
        cls.maria_work_item = create_work_item(
            project=cls.maria_project,
            actor=cls.data["maria"],
            type=WorkItem.Type.TASK,
            title="Maria's private task",
        )
        cls.maria_comment = create_work_item_comment(
            work_item=cls.maria_work_item,
            actor=cls.data["maria"],
            body="Private comment.",
        )

    def test_admin_cannot_read_private_project_comments(self):
        self._login("alex")
        response = self.client.get(
            f"/api/work-items/{self.maria_work_item.pk}/comments/"
        )
        self.assertEqual(response.status_code, 404)

    def test_admin_cannot_edit_or_delete_private_project_comment(self):
        self._login("alex")
        csrf = self._get_csrf_token()

        response = self.client.patch(
            f"/api/work-item-comments/{self.maria_comment.pk}/",
            data={"body": "Hijacked."},
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 404)

        response = self.client.delete(
            f"/api/work-item-comments/{self.maria_comment.pk}/",
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(response.status_code, 404)


def _create_maria_project(data):
    """Create a Project owned by Maria that Alex has no
    ProjectMembership in, to test cross-Project isolation."""
    from projects.services import create_project

    return create_project(
        research_group=data["group"],
        creator=data["maria"],
        name="Maria's Private Project",
    )
