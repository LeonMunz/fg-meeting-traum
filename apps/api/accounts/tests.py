from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import TestCase

User = get_user_model()


class UserModelConfigurationTest(TestCase):
    """Verify the swappable user model is correctly configured."""

    def test_auth_user_model_points_to_accounts(self):
        self.assertEqual(settings.AUTH_USER_MODEL, "accounts.User")

    def test_get_user_model_returns_accounts_user(self):
        self.assertEqual(User.__name__, "User")
        self.assertEqual(User._meta.app_label, "accounts")

    def test_user_has_standard_fields(self):
        """User should have standard AbstractUser fields."""
        user = User.objects.create_user(
            username="testuser",
            email="test@example.com",
            password="SecretPass1!",
        )
        self.assertEqual(user.username, "testuser")
        self.assertEqual(user.email, "test@example.com")
        self.assertEqual(user.first_name, "")
        self.assertEqual(user.last_name, "")
        self.assertFalse(user.is_superuser)
        self.assertFalse(user.is_staff)


class UserPasswordTest(TestCase):
    """Verify Django password hashing works with the custom User model."""

    def test_password_is_hashed(self):
        user = User.objects.create_user(
            username="hashed",
            password="SecurePass123!",
        )
        # The raw password should never be stored.
        self.assertNotEqual(user.password, "SecurePass123!")
        # Django stores a hash with an algorithm prefix.
        self.assertTrue(user.password.startswith("pbkdf2_"))

    def test_check_password_success(self):
        user = User.objects.create_user(
            username="checkuser",
            password="CorrectPass1!",
        )
        self.assertTrue(user.check_password("CorrectPass1!"))

    def test_check_password_failure(self):
        user = User.objects.create_user(
            username="checkuser2",
            password="CorrectPass1!",
        )
        self.assertFalse(user.check_password("WrongPass"))

    def test_set_password_updates_hash(self):
        user = User.objects.create_user(
            username="setuser",
            password="OldPass1!",
        )
        old_hash = user.password
        user.set_password("NewPass1!")
        user.save()
        self.assertNotEqual(user.password, old_hash)
        self.assertTrue(user.check_password("NewPass1!"))
        self.assertFalse(user.check_password("OldPass1!"))


class UserAuthenticationTest(TestCase):
    """Verify normal Django authentication works with the custom model."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="authuser",
            password="AuthPass1!",
        )

    def test_login_with_correct_credentials(self):
        from django.contrib.auth import authenticate

        authenticated = authenticate(
            username="authuser",
            password="AuthPass1!",
        )
        self.assertEqual(authenticated, self.user)

    def test_login_with_wrong_password(self):
        from django.contrib.auth import authenticate

        authenticated = authenticate(
            username="authuser",
            password="WrongPass",
        )
        self.assertIsNone(authenticated)

    def test_login_with_nonexistent_user(self):
        from django.contrib.auth import authenticate

        authenticated = authenticate(
            username="doesnotexist",
            password="SomePass1!",
        )
        self.assertIsNone(authenticated)
