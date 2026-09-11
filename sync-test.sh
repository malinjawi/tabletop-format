#!/usr/bin/env bash
# sync-test.sh — the spine, end to end: a published sheet is the source of truth,
# a designer edits it, and every downstream output follows. Self-contained.
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$(mktemp -d)"; trap 'rm -rf "$SCRATCH"' EXIT
tar -C "$REPO" --exclude='.git' --exclude='node_modules' --exclude='beta-site' --exclude='data' \
    --exclude='examples/*/exports' -cf - . | tar -C "$SCRATCH" -xf -
cd "$SCRATCH"
export GIT_AUTHOR_NAME=t GIT_COMMITTER_NAME=t GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_EMAIL=t@x
git init -qb main . >/dev/null && git add -A && git commit -qm baseline >/dev/null
MPORT=$(( (RANDOM % 900) + 4500 )); SPORT=$(( (RANDOM % 2000) + 56000 ))
node tools/sheet-mock.mjs --port $MPORT >/dev/null 2>&1 & MPID=$!
DB_PATH="$SCRATCH/p.db" CACHE_DIR="$SCRATCH/cache" node server.mjs --port $SPORT > "$SCRATCH/s.log" 2>&1 & SPID=$!
sleep 1.7
set +e
node tools/sync-check.mjs "http://localhost:$SPORT" "http://localhost:$MPORT/sheet.csv"
RC=$?
kill $SPID $MPID 2>/dev/null || true
[ $RC -ne 0 ] && { echo "--- server log ---"; tail -15 "$SCRATCH/s.log"; }
exit $RC
