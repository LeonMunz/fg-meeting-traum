#!/usr/bin/env bash
#
# Repository verification helper for agent tasks.
#
# Usage:
#   ./scripts/agent-verify.sh frontend   # repo hygiene + typecheck + lint + unit tests
#   ./scripts/agent-verify.sh backend    # repo hygiene + Django system check + migration check
#   ./scripts/agent-verify.sh full       # frontend checks + backend checks
#
# This script is verification-only: it must not mutate application or repository
# state, and it does NOT run the complete Django test suite. Targeted and full
# application tests remain task-dependent and are run separately.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Django commands run through the repository virtualenv interpreter directly,
# consistent with the existing supervisor verification setup. The helper must
# fail immediately and preserve the real stderr/exit code, so there is no
# retry-on-command-failure logic here.
django() {
  local script_args=("$@")
  (cd "$REPO_ROOT/apps/api" && exec ./.venv/bin/python manage.py "${script_args[@]}")
}

run() {
  # Run a command with a clear phase heading; fail immediately on non-zero exit.
  local phase="$1"
  shift
  printf '\n\033[1m==> %s\033[0m\n' "$phase"
  printf '$ %s\n' "$*"
  "$@"
}

check_frontend() {
  run "frontend: repo hygiene (git diff HEAD --check)" git diff HEAD --check
  run "frontend: typecheck" npm run typecheck
  run "frontend: lint" npm run lint
  run "frontend: unit tests" npm run test:unit --workspace=web
}

check_backend() {
  run "backend: repo hygiene (git diff HEAD --check)" git diff HEAD --check
  run "backend: Django system check" django check
  run "backend: migration integrity" django makemigrations --check --dry-run
}

case "${1:-}" in
  frontend)
    check_frontend
    ;;
  backend)
    check_backend
    ;;
  full)
    check_frontend
    check_backend
    ;;
  *)
    printf 'Usage: %s {frontend|backend|full}\n' "$0" >&2
    exit 2
    ;;
esac

printf '\n\033[1mAll requested checks passed.\033[0m\n'
