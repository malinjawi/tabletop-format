#!/usr/bin/env bash
# launch-gate.sh — one repeatable controlled-alpha release gate.
#
# Local/CI (real Git + protocol-faithful Forge mock):
#   ./launch-gate.sh
#
# Add production-backend conformance against dedicated disposable services:
#   FORGE_CONFORMANCE_PG_URL=postgres://... \
#   FORGEJO_TEST_IMAGE=codeberg.org/forgejo/forgejo@sha256:... \
#   POSTGRES_TEST_IMAGE=postgres@sha256:... \
#   ALPINE_TEST_IMAGE=alpine@sha256:... \
#   FORGE_GATEWAY_TEST_IMAGE=sha256:<locally-built-image-id> \
#   FORGE_RESTORE_DRILL=1 \
#   REQUIRE_PRODUCTION_BACKENDS=1 ./launch-gate.sh
#
# FORGE_CONFORMANCE_PG_URL must name a dedicated test database. The Store-2
# conformance creates/migrates tables. Alternatively, FORGE_LIVE_URL plus admin
# credentials can target an already isolated Forgejo; that journey deletes only
# its own alice/tidepool and bob/tidepool-bob repositories before running.
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
run "production deployment contract" node tools/production-config-check.mjs
run "single-use pilot invitation workflow" node tools/test-pilot-invite-registration.mjs
run "SQLite/PostgreSQL Store-2 conformance" ./store2-pg-test.sh

deploy_preflight=0
if [ -n "${FORGE_DEPLOY_ENV:-}" ]; then
  preflight_args=(--env "$FORGE_DEPLOY_ENV")
  [ "${FORGE_DEPLOY_ONLINE:-0}" != "1" ] || preflight_args+=(--online)
  [ -z "${FORGE_DEPLOY_EVIDENCE:-}" ] || preflight_args+=(--evidence "$FORGE_DEPLOY_EVIDENCE")
  run "actual production host preflight" node deploy/preflight.mjs "${preflight_args[@]}"
  deploy_preflight=1
else
  printf '\nSKIP actual host preflight: set FORGE_DEPLOY_ENV, and FORGE_DEPLOY_ONLINE=1 after DNS is live.\n'
fi

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
elif [ -n "${FORGEJO_TEST_IMAGE:-}" ]; then
  run "disposable real Forgejo journey" ./tools/disposable-forgejo-check.sh
  production_backends=$((production_backends + 1))
else
  printf '\nSKIP real Forgejo conformance: set FORGE_LIVE_URL plus test-admin credentials, or FORGEJO_TEST_IMAGE to a digest-pinned image.\n'
fi

restore_drill=0
gateway_image_drill=0
if [ "${FORGE_RESTORE_DRILL:-0}" = "1" ]; then
  run "disposable synchronized backup/restore drill" ./tools/disposable-restore-drill.sh
  restore_drill=1
  [ -z "${FORGE_GATEWAY_TEST_IMAGE:-}" ] || gateway_image_drill=1
else
  printf '\nSKIP disaster-recovery proof: set FORGE_RESTORE_DRILL=1 plus digest-pinned Forgejo, Postgres, and Alpine images.\n'
fi

if [ "${REQUIRE_PRODUCTION_BACKENDS:-0}" = "1" ] && [ "$production_backends" -ne 2 ]; then
  printf '\nFAIL: production backend evidence required, but PostgreSQL and live Forgejo were not both supplied.\n' >&2
  exit 1
fi
if [ "${REQUIRE_RESTORE_DRILL:-0}" = "1" ] && [ "$restore_drill" -ne 1 ]; then
  printf '\nFAIL: release policy requires the disposable backup/restore drill.\n' >&2
  exit 1
fi
if [ "${REQUIRE_GATEWAY_IMAGE_DRILL:-0}" = "1" ] && [ "$gateway_image_drill" -ne 1 ]; then
  printf '\nFAIL: release policy requires restore verification through the exact production gateway image.\n' >&2
  exit 1
fi
if [ "${REQUIRE_DEPLOY_PREFLIGHT:-0}" = "1" ] && [ "$deploy_preflight" -ne 1 ]; then
  printf '\nFAIL: release policy requires the actual production host preflight.\n' >&2
  exit 1
fi

printf '\nCONTROLLED-ALPHA LAUNCH GATE GREEN'
if [ "$production_backends" -eq 2 ]; then
  printf ' — including PostgreSQL and real Forgejo.\n'
else
  printf ' — including PostgreSQL; real Forgejo was optional and skipped.\n'
fi
