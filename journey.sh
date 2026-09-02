#!/usr/bin/env bash
# journey.sh — run the SYSTEM CONFIRMATION (tools/journey.mjs): a continuous
# two-user story over a live platform (LFS mock, SQL, cache) in a scratch copy.
# The release trio: ./e2e.sh && ./perf.sh && ./journey.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/forge-journey.XXXXXX")"
LPID=""; SPID=""; WATCH_PID=""
LIMIT_MB="${FORGE_JOURNEY_SCRATCH_LIMIT_MB:-1536}"
cleanup() {
  local status=$?
  [ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null || true
  [ -n "$SPID" ] && kill "$SPID" 2>/dev/null || true
  [ -n "$LPID" ] && kill "$LPID" 2>/dev/null || true
  if [ "${FORGE_KEEP_SCRATCH:-0}" != "1" ]; then
    case "$SCRATCH" in "${TMPDIR:-/tmp}"/forge-journey.*) find "$SCRATCH" -depth -delete 2>/dev/null || true ;; esac
  else echo "journey: preserving scratch at $SCRATCH" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
echo "journey: scratch at $SCRATCH"
(
  while kill -0 $$ 2>/dev/null; do
    used=$(du -sm "$SCRATCH" 2>/dev/null | awk '{print $1+0}')
    if [ "$used" -gt "$LIMIT_MB" ]; then
      echo "journey: scratch exceeded ${LIMIT_MB} MB; stopping" >&2
      kill -TERM $$ 2>/dev/null || true
      exit
    fi
    sleep 5
  done
) & WATCH_PID=$!
tar -C "$REPO" --exclude='.git' --exclude='.venv' --exclude='node_modules' --exclude='beta-site' \
    --exclude='tmp' --exclude='output' --exclude='hub.html' --exclude='data/cache' \
    --exclude='data/forge-farm' --exclude='examples/*/exports' --exclude='examples/_fixtures' \
    -cf - . | tar -C "$SCRATCH" -xf -
ln -s "$REPO/node_modules" "$SCRATCH/node_modules"
ln -s "$REPO/.venv" "$SCRATCH/.venv"
cd "$SCRATCH"
export GIT_AUTHOR_NAME=platform GIT_COMMITTER_NAME=platform
export GIT_AUTHOR_EMAIL=platform@x GIT_COMMITTER_EMAIL=platform@x
git init -qb main . && git add -A && git commit -qm "baseline"

LPORT=$(( (RANDOM % 2000) + 40000 ))
SPORT=$(( (RANDOM % 2000) + 42000 ))
node tools/lfs-mock-server.mjs --port $LPORT --store "$SCRATCH/lfs-store" > "$SCRATCH/lfs.log" 2>&1 &
LPID=$!
LFS_URL="http://localhost:$LPORT" DB_PATH="$SCRATCH/platform.db" CACHE_DIR="$SCRATCH/cache" FORGE_NOW="2026-09-10T12:00:00Z" \
  node server.mjs --port $SPORT > "$SCRATCH/server.log" 2>&1 &
SPID=$!
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$SPORT/healthz" >/dev/null 2>&1 && break; sleep .5; done
curl -fsS "http://127.0.0.1:$SPORT/healthz" >/dev/null

node tools/journey.mjs "http://localhost:$SPORT"
