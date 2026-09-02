#!/usr/bin/env bash
# journey-forgejo.sh — THE PRODUCTION CONFIRMATION.
# The SAME 85-assertion two-user journey, but Store 1 is a real forge:
# per-user repos, batch commits with authorship, LFS pointers, archive
# materialization — every git-ledger assertion answered by the forge API.
#
#   standalone (CI/dev):     ./journey-forgejo.sh          (boots tools/forge-mock.mjs)
#   against disposable live Forgejo:
#     FORGE_URL=http://localhost:3000 FORGE_ALLOW_FIXTURE_DELETE=1 ./journey-forgejo.sh
#   The live path purges the alice/bob/charlie fixture users before it runs.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/forge-journey-forgejo.XXXXXX")"
cd "$REPO"
FPID=""; SPID=""; WATCH_PID=""
LIMIT_MB="${FORGE_JOURNEY_SCRATCH_LIMIT_MB:-1536}"
cleanup() {
  local status=$?
  [ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null || true
  [ -n "$SPID" ] && kill "$SPID" 2>/dev/null || true
  [ -n "$FPID" ] && kill "$FPID" 2>/dev/null || true
  case "$SCRATCH" in "${TMPDIR:-/tmp}"/forge-journey-forgejo.*) find "$SCRATCH" -depth -delete 2>/dev/null || true ;; esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
(
  while kill -0 $$ 2>/dev/null; do
    used=$(du -sm "$SCRATCH" 2>/dev/null | awk '{print $1+0}')
    if [ "$used" -gt "$LIMIT_MB" ]; then
      echo "journey-forgejo: scratch exceeded ${LIMIT_MB} MB; stopping" >&2
      kill -TERM $$ 2>/dev/null || true
      exit
    fi
    sleep 5
  done
) & WATCH_PID=$!

if [ -n "${FORGE_URL:-}" ]; then
  [ "${FORGE_ALLOW_FIXTURE_DELETE:-0}" = "1" ] || {
    echo "refusing live journey: set FORGE_ALLOW_FIXTURE_DELETE=1 only for an isolated test Forgejo" >&2
    exit 1
  }
  FORGE_MODE=live
  echo "journey-forgejo: LIVE forge at $FORGE_URL"
  ADMIN_USER=${ADMIN_USER:-root}; ADMIN_PASS=${ADMIN_PASS:-spikeroot123}
  FORGE_TOKEN=$(curl -s -u "$ADMIN_USER:$ADMIN_PASS" -X POST -H "Content-Type: application/json" \
    -d '{"name":"journey-'$RANDOM'","scopes":["all"]}' \
    "$FORGE_URL/api/v1/users/$ADMIN_USER/tokens" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).sha1||'')}catch{console.log('')}})")
  [ -n "$FORGE_TOKEN" ] || { echo "could not mint admin token (is the spike stack up? creds $ADMIN_USER)"; exit 1; }
  FORGE_BASIC="$ADMIN_USER:$ADMIN_PASS"
  # Idempotency: this journey owns these exact fixture identities on the
  # explicitly disposable Forgejo. Purging the users also removes any starter
  # repositories whose generated slug may vary with a jam theme.
  for fixture_user in alice bob charlie; do
    curl -s -o /dev/null -X DELETE -H "Authorization: token $FORGE_TOKEN" \
      "$FORGE_URL/api/v1/admin/users/$fixture_user?purge=true" || true
  done
else
  FORGE_MODE=mock
  FPORT=$(( (RANDOM % 2000) + 44000 ))
  echo "journey-forgejo: forge-mock on :$FPORT (protocol-faithful, real git repos)"
  node tools/forge-mock.mjs --port $FPORT --store "$SCRATCH/forge" > "$SCRATCH/forge.log" 2>&1 &
  FPID=$!
  FORGE_URL="http://localhost:$FPORT"; FORGE_TOKEN="mock-token"; FORGE_BASIC="root:mock"
  sleep 0.8
fi

# the journey OWNS whatever platform DB it is pointed at: reset for a clean run
# (persistent Postgres keeps alice/bob between runs; sqlite scratch never did)
if [ -n "${PG_URL:-}" ]; then
  PG_URL="$PG_URL" node --input-type=module -e "
const {default:pg}=await import('pg');
const p=new pg.Pool({connectionString:process.env.PG_URL});
await p.query('DROP TABLE IF EXISTS prs, stars, claims, sessions, jam_entries, games, users, schema_migrations CASCADE');
await p.end(); console.log('journey: platform postgres reset (migrations will recreate)');
"
fi

SPORT=$(( (RANDOM % 2000) + 46000 ))
STORE1=forgejo FORGE_URL="$FORGE_URL" FORGE_TOKEN="$FORGE_TOKEN" FORGE_BASIC="$FORGE_BASIC" \
  DB="${DB:-}" PG_URL="${PG_URL:-}" \
  DB_PATH="$SCRATCH/platform.db" CACHE_DIR="$SCRATCH/cache" FARM_DIR="$SCRATCH/farm" \
  FORGE_NOW="2026-09-10T12:00:00Z" node server.mjs --port $SPORT > "$SCRATCH/server.log" 2>&1 &
SPID=$!
for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:$SPORT/healthz" >/dev/null 2>&1 && break; sleep .5; done
curl -fsS "http://127.0.0.1:$SPORT/healthz" >/dev/null

if FORGE_URL="$FORGE_URL" FORGE_TOKEN="$FORGE_TOKEN" node tools/journey.mjs "http://localhost:$SPORT"; then
  echo ""
  if [ "$FORGE_MODE" = "live" ]; then
    echo "LIVE FORGEJO JOURNEY GREEN — same assertions as dev on a real Forgejo server."
  else
    echo "FORGE PROTOCOL JOURNEY GREEN — real Git repositories behind the protocol-faithful mock."
  fi
else
  RC=$?
  echo "--- server.log (tail) ---"; tail -25 "$SCRATCH/server.log"
  [ -n "$FPID" ] && { echo "--- forge.log (tail) ---"; tail -10 "$SCRATCH/forge.log"; }
  exit $RC
fi
