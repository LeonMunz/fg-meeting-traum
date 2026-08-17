from .settings import *

DATABASES["default"]["OPTIONS"] = {
    **DATABASES["default"].get("OPTIONS", {}),
    "options": "-c search_path=fg_e2e",
}

CSRF_TRUSTED_ORIGINS = [
    "http://127.0.0.1:4173",
]
