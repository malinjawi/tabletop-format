#!/usr/bin/env bash
# launch-gate.sh — one repeatable controlled-alpha release gate.
#
# Local/CI (real Git + protocol-faithful Forge mock):
#   ./launch-gate.sh
#
# Add production-backend conformance against dedicated disposable services:
#   FORGE_CONFORMANCE_PG_URL=postgres://... \
#   FORGE_LIVE_URL=https://git.example.test \
#   FORGE_LIVE_ADMIN_USER=root FORGE_LIVE_ADMIN_PASS=... \
#   REQUIRE_PRODUCTION_BACKENDS=1 ./launch-gate.sh
#
# FORGE_CONFORMANCE_PG_URL must name a dedicated test database. The Store-2
# conformance creates/migrates tables. The live Forgejo journey deletes only its
# own alice/tidepool and bob/tidepool-bob repositories before running.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

candidate_sha="$(git rev-parse HEAD)"
candidate_dirty="$(git status --porcelain)"
if [ "${FORGE_REQUIRE_CLEAN_TREE:-0}" = "1" ] && [ -n "$candidate_dirty" ]; then
  printf 'FAIL: release candidates must be committed; the working tree is dirty.\n' >&2
  exit 1
fi
if [ -n "$candidate_dirty" ]; then
  printf 'Forge launch candidate: working tree based on %s (not releasable until committed).\n' "$candidate_sha"
else
  printf 'Forge launch candidate: %s\n' "$candidate_sha"
fi

run() {
  printf '\n== %s ==\n' "$1"
  shift
  "$@"
}

run "toolchain" npm run doctor
run "production dependency audit" npm audit --omit=dev
run "Python dependency integrity" "${FORGE_PYTHON:-$ROOT/.venv/bin/python}" -m pip check
run "static types" npm run typecheck
run "adapter contracts" node tools/check-adapters.mjs
run "portable project server round-trip" node tools/test-forge-project-server.mjs
run "responsive Explore browser smoke" node tools/ui-smoke.mjs
run "functional integration" ./e2e.sh
run "local two-user golden journey" ./journey.sh
run "Forge protocol journey" ./journey-forgejo.sh
run "bounded performance and concurrency" ./perf.sh
run "production Compose shape" docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet
run "SQLite/PostgreSQL Store-2 conformance" ./store2-pg-test.sh

production_backends=1

if [ -n "${FORGE_LIVE_URL:-}" ]; then
  if [ -z "${FORGE_LIVE_ADMIN_PASS:-}" ]; then
    printf '\nFAIL: FORGE_LIVE_ADMIN_PASS is required for the isolated live Forgejo journey.\n' >&2
    exit 1
  fi
  run "live Forgejo journey" env \
    FORGE_URL="$FORGE_LIVE_URL" \
    ADMIN_USER="${FORGE_LIVE_ADMIN_USER:-root}" \
    ADMIN_PASS="$FORGE_LIVE_ADMIN_PASS" \
    FORGE_ALLOW_FIXTURE_DELETE=1 \
    ./journey-forgejo.sh
  production_backends=$((production_backends + 1))
else
  printf '\nSKIP live Forgejo conformance: set FORGE_LIVE_URL and its test-admin credentials.\n'
fi

if [ "${REQUIRE_PRODUCTION_BACKENDS:-0}" = "1" ] && [ "$production_backends" -ne 2 ]; then
  printf '\nFAIL: production backend evidence required, but PostgreSQL and live Forgejo were not both supplied.\n' >&2
  exit 1
fi

printf '\nCONTROLLED-ALPHA LAUNCH GATE GREEN'
if [ "$production_backends" -eq 2 ]; then
  printf ' — including PostgreSQL and live Forgejo.\n'
else
  printf ' — including PostgreSQL; isolated live Forgejo was optional and skipped.\n'
fi
