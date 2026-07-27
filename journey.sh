#!/usr/bin/env bash
# journey.sh — run the SYSTEM CONFIRMATION (tools/journey.mjs): a continuous
# two-user story over a live platform (LFS mock, SQL, cache) in a scratch copy.
# The release trio: ./e2e.sh && ./perf.sh && ./journey.sh
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$(mktemp -d)"
echo "journey: scratch at $SCRATCH"
tar -C "$REPO" --exclude='.git' --exclude='node_modules' --exclude='beta-site' \
    --exclude='examples/*/exports' -cf - . | tar -C "$SCRATCH" -xf -
cd "$SCRATCH"
export GIT_AUTHOR_NAME=platform GIT_COMMITTER_NAME=platform
export GIT_AUTHOR_EMAIL=platform@x GIT_COMMITTER_EMAIL=platform@x
git init -qb main . && git add -A && git commit -qm "baseline"

LPORT=$(( (RANDOM % 2000) + 40000 ))
SPORT=$(( (RANDOM % 2000) + 42000 ))
node tools/lfs-mock-server.mjs --port $LPORT --store "$SCRATCH/lfs-store" > "$SCRATCH/lfs.log" 2>&1 &
LPID=$!
LFS_URL="http://localhost:$LPORT" DB_PATH="$SCRATCH/platform.db" CACHE_DIR="$SCRATCH/cache" \
  node server.mjs --port $SPORT > "$SCRATCH/server.log" 2>&1 &
SPID=$!
sleep 1.5

node tools/journey.mjs "http://localhost:$SPORT"
RC=$?
kill $SPID $LPID 2>/dev/null || true
exit $RC
