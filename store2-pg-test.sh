#!/usr/bin/env bash
# store2-pg-test.sh — prove the Postgres driver: the SAME conformance script
# runs against node:sqlite (dev) and a throwaway Postgres 16 (docker), and
# must be green on both. Requires Docker; installs the one prod dep (pg) locally.
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"

echo "== leg 1: dev driver (node:sqlite) =="
node tools/store2-conformance.mjs

command -v docker >/dev/null || { echo "docker not found — Postgres leg skipped"; exit 1; }
node -e "require.resolve('pg')" 2>/dev/null || { echo "installing pg (deploy-time dep, --no-save)…"; npm i pg --no-save --silent; }

PGPORT=$(( (RANDOM % 2000) + 55000 ))
CN="store2-pg-$$"
echo "== leg 2: PRODUCTION driver (postgres:16-alpine on :$PGPORT) =="
docker run -d --rm --name "$CN" -e POSTGRES_PASSWORD=confpass -e POSTGRES_DB=platform \
  -p "$PGPORT:5432" postgres:16-alpine >/dev/null
trap 'docker rm -f "$CN" >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 30); do docker exec "$CN" pg_isready -U postgres -q 2>/dev/null && break; sleep 0.5; done

DB=postgres PG_URL="postgres://postgres:confpass@localhost:$PGPORT/platform" node tools/store2-conformance.mjs

echo ""
echo "STORE-2 GREEN ON BOTH DRIVERS — the Postgres swap is a config change."
echo "Full production profile (all three stores prod-shaped) against your live spike stack:"
echo "  docker run -d --name platform-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=platform -p 55432:5432 postgres:16-alpine"
echo "  DB=postgres PG_URL=postgres://postgres:devpass@localhost:55432/platform FORGE_URL=http://localhost:3000 ./journey-forgejo.sh"
