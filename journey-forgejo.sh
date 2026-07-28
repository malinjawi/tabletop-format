#!/usr/bin/env bash
# journey-forgejo.sh — THE PRODUCTION CONFIRMATION.
# The SAME 30-assertion two-user journey, but Store 1 is a real forge:
# per-user repos, batch commits with authorship, LFS pointers, archive
# materialization — every git-ledger assertion answered by the forge API.
#
#   standalone (CI/dev):     ./journey-forgejo.sh          (boots tools/forge-mock.mjs)
#   against live Forgejo:    FORGE_URL=http://localhost:3000 ./journey-forgejo.sh
#                            (spike stack: cd phase1-spike && docker compose up -d)
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$(mktemp -d)"
cd "$REPO"
FPID=""

if [ -n "$FORGE_URL" ]; then
  echo "journey-forgejo: LIVE forge at $FORGE_URL"
  ADMIN_USER=${ADMIN_USER:-root}; ADMIN_PASS=${ADMIN_PASS:-spikeroot123}
  FORGE_TOKEN=$(curl -s -u "$ADMIN_USER:$ADMIN_PASS" -X POST -H "Content-Type: application/json" \
    -d '{"name":"journey-'$RANDOM'","scopes":["all"]}' \
    "$FORGE_URL/api/v1/users/$ADMIN_USER/tokens" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).sha1||'')}catch{console.log('')}})")
  [ -n "$FORGE_TOKEN" ] || { echo "could not mint admin token (is the spike stack up? creds $ADMIN_USER)"; exit 1; }
  FORGE_BASIC="$ADMIN_USER:$ADMIN_PASS"
  # idempotency: clear any repos a previous journey created (users may remain)
  for R in alice/tidepool bob/tidepool-bob; do
    curl -s -o /dev/null -X DELETE -H "Authorization: token $FORGE_TOKEN" "$FORGE_URL/api/v1/repos/$R" || true
  done
else
  FPORT=$(( (RANDOM % 2000) + 44000 ))
  echo "journey-forgejo: forge-mock on :$FPORT (protocol-faithful, real git repos)"
  node tools/forge-mock.mjs --port $FPORT --store "$SCRATCH/forge" > "$SCRATCH/forge.log" 2>&1 &
  FPID=$!
  FORGE_URL="http://localhost:$FPORT"; FORGE_TOKEN="mock-token"; FORGE_BASIC="root:mock"
  sleep 0.8
fi

SPORT=$(( (RANDOM % 2000) + 46000 ))
STORE1=forgejo FORGE_URL="$FORGE_URL" FORGE_TOKEN="$FORGE_TOKEN" FORGE_BASIC="$FORGE_BASIC" \
  DB="${DB:-}" PG_URL="${PG_URL:-}" \
  DB_PATH="$SCRATCH/platform.db" CACHE_DIR="$SCRATCH/cache" FARM_DIR="$SCRATCH/farm" \
  node server.mjs --port $SPORT > "$SCRATCH/server.log" 2>&1 &
SPID=$!
sleep 1.5

if FORGE_URL="$FORGE_URL" FORGE_TOKEN="$FORGE_TOKEN" node tools/journey.mjs "http://localhost:$SPORT"; then
  kill $SPID $FPID 2>/dev/null || true
  echo ""
  echo "PRODUCTION JOURNEY GREEN — same assertions as dev, Store 1 on a real forge backend."
else
  RC=$?
  echo "--- server.log (tail) ---"; tail -25 "$SCRATCH/server.log"
  [ -n "$FPID" ] && { echo "--- forge.log (tail) ---"; tail -10 "$SCRATCH/forge.log"; }
  kill $SPID $FPID 2>/dev/null || true
  exit $RC
fi
