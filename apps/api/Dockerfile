FROM ghcr.io/astral-sh/uv:0.12.16@sha256:adc68cd785ca65ea25c0611043b0a00b4ea3a22e1b54102fc084406d888082ee AS uv

FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv

COPY --from=uv /uv /uvx /bin/
WORKDIR /build

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c AS runtime

ENV DJANGO_SETTINGS_MODULE=config.settings_production \
    PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --home-dir /home/app app

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY manage.py ./
COPY accounts ./accounts
COPY audit_history ./audit_history
COPY authorization ./authorization
COPY config ./config
COPY home ./home
COPY home_continue ./home_continue
COPY home_timeline ./home_timeline
COPY meetings ./meetings
COPY personal_notes ./personal_notes
COPY projects ./projects
COPY research_groups ./research_groups
COPY work_items ./work_items

USER 10001:10001

# Build-time packaging acceptance (pre-publication gate): initialize Django
# with the production settings module and load every configured
# application, using safe non-production dummy values only. No
# infrastructure is contacted, no migration runs, and nothing is written.
# If an INSTALLED_APPS entry is missing or unimportable in this image
# (for example an app that was never copied above), the build fails here
# and no immutable production image can be published for the revision.
RUN DJANGO_SECRET_KEY=fg-image-build-check-only \
    POSTGRES_DB=build_check \
    POSTGRES_USER=build_check \
    POSTGRES_PASSWORD=build_check \
    POSTGRES_HOST=127.0.0.1 \
    POSTGRES_PORT=5432 \
    DJANGO_ALLOWED_HOSTS=build-check.invalid \
    DJANGO_CSRF_TRUSTED_ORIGINS=https://build-check.invalid \
    python manage.py check

EXPOSE 8000

CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--access-logfile", "-", "--error-logfile", "-", "config.wsgi:application"]
