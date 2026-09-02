#!/usr/bin/env bash
# store2-pg-test.sh — prove the Postgres driver: the SAME conformance script
# runs against node:sqlite (dev) and a throwaway PostgreSQL 16, and must be green
# on both. It prefers Docker, falls back to a locally installed PostgreSQL 16,
# or accepts FORGE_CONFORMANCE_PG_URL for a dedicated test database.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"
CN=""; PG_TMP=""; LOCAL_PG_STARTED=0
cleanup() {
  local status=$?
  if [ "$LOCAL_PG_STARTED" = "1" ] && [ -n "$PG_TMP" ]; then
    "$PG_BIN/pg_ctl" -D "$PG_TMP/data" stop -m fast >/dev/null 2>&1 || true
  fi
  if [ -n "$CN" ]; then docker rm -f "$CN" >/dev/null 2>&1 || true; fi
  case "$PG_TMP" in "${TMPDIR:-/tmp}"/forge-store2-pg.*) find "$PG_TMP" -depth -delete 2>/dev/null || true ;; esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "== leg 1: dev driver (node:sqlite) =="
node tools/store2-conformance.mjs

node -e "require.resolve('pg')" 2>/dev/null || { echo "installing pg (deploy-time dep, --no-save)…"; npm i pg --no-save --silent; }

if [ -n "${FORGE_CONFORMANCE_PG_URL:-}" ]; then
  echo "== leg 2: PRODUCTION driver (caller-supplied dedicated PostgreSQL) =="
  DB=postgres PG_URL="$FORGE_CONFORMANCE_PG_URL" node tools/store2-conformance.mjs
  echo ""
  echo "STORE-2 GREEN ON BOTH DRIVERS — the Postgres swap is a config change."
  exit 0
fi

PGPORT=$(( (RANDOM % 2000) + 55000 ))
if command -v docker >/dev/null 2>&1; then
  CN="store2-pg-$$"
  echo "== leg 2: PRODUCTION driver (postgres:16-alpine on :$PGPORT) =="
  if docker run -d --rm --name "$CN" -e POSTGRES_PASSWORD=confpass -e POSTGRES_DB=platform \
      -p "$PGPORT:5432" postgres:16-alpine >/dev/null 2>&1; then
    for _ in $(seq 1 60); do
      docker exec "$CN" pg_isready -U postgres -q 2>/dev/null && break
      sleep 0.5
    done
    DB=postgres PG_URL="postgres://postgres:confpass@127.0.0.1:$PGPORT/platform" node tools/store2-conformance.mjs
    echo ""
    echo "STORE-2 GREEN ON BOTH DRIVERS — the Postgres swap is a config change."
    exit 0
  fi
  echo "Docker PostgreSQL was unavailable; trying an isolated native PostgreSQL 16 cluster."
  docker rm -f "$CN" >/dev/null 2>&1 || true
  CN=""
fi

if command -v pg_config >/dev/null 2>&1; then
  PG_BIN="$(pg_config --bindir)"
elif [ -x /opt/homebrew/opt/postgresql@16/bin/pg_ctl ]; then
  PG_BIN=/opt/homebrew/opt/postgresql@16/bin
elif [ -x /usr/local/opt/postgresql@16/bin/pg_ctl ]; then
  PG_BIN=/usr/local/opt/postgresql@16/bin
else
  echo "PostgreSQL 16 unavailable: install it or set FORGE_CONFORMANCE_PG_URL to a dedicated test database." >&2
  exit 1
fi

PG_MAJOR="$($PG_BIN/postgres --version | sed -E 's/.* ([0-9]+).*/\1/')"
[ "$PG_MAJOR" = "16" ] || { echo "PostgreSQL 16 required for conformance; found $($PG_BIN/postgres --version)" >&2; exit 1; }
PG_TMP="$(mktemp -d "${TMPDIR:-/tmp}/forge-store2-pg.XXXXXX")"
echo "== leg 2: PRODUCTION driver (isolated native PostgreSQL 16 on :$PGPORT) =="
"$PG_BIN/initdb" -D "$PG_TMP/data" -A trust --no-locale --encoding=UTF8 >/dev/null
"$PG_BIN/pg_ctl" -D "$PG_TMP/data" -l "$PG_TMP/postgres.log" -o "-h 127.0.0.1 -p $PGPORT" start >/dev/null
LOCAL_PG_STARTED=1
"$PG_BIN/createdb" -h 127.0.0.1 -p "$PGPORT" platform
DB=postgres PG_URL="postgres://$(id -un)@127.0.0.1:$PGPORT/platform" node tools/store2-conformance.mjs

echo ""
echo "STORE-2 GREEN ON BOTH DRIVERS — the Postgres swap is a config change."
