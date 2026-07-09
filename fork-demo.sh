#!/usr/bin/env bash
# fork-demo.sh — the platform's fork/PR model demonstrated with bare git repos.
# Usage: ./fork-demo.sh [scratch-dir]
# What Forgejo will do via API (POST /forks, PRs), shown with the underlying
# primitives: publish → fork → diverge → semantic-diff review → merge.
set -e
SCRATCH="${1:-$(mktemp -d)}"; SRV="$SCRATCH/server"; REPO="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SRV/alice" "$SRV/bob"
A(){ export GIT_AUTHOR_NAME=alice GIT_COMMITTER_NAME=alice GIT_AUTHOR_EMAIL=a@x GIT_COMMITTER_EMAIL=a@x; }
B(){ export GIT_AUTHOR_NAME=bob GIT_COMMITTER_NAME=bob GIT_AUTHOR_EMAIL=b@x GIT_COMMITTER_EMAIL=b@x; }

echo "== 1. alice publishes her game (bare repo = what the platform hosts) =="
A; git init -q --bare -b main "$SRV/alice/ember.git"
git clone -q "$REPO" "$SCRATCH/alice-work"
git -C "$SCRATCH/alice-work" remote set-url origin "$SRV/alice/ember.git"
git -C "$SCRATCH/alice-work" push -q origin main

echo "== 2. bob clicks Remix (server-side clone — POST /forks) =="
git clone -q --bare "$SRV/alice/ember.git" "$SRV/bob/ember.git"
git -C "$SRV/bob/ember.git" symbolic-ref HEAD refs/heads/main

echo "== 3. bob rebalances on his fork =="
B; git clone -q "$SRV/bob/ember.git" "$SCRATCH/bob-work"
python3 - "$SCRATCH/bob-work" <<'EOF'
import json, sys
p = sys.argv[1] + '/examples/ember/components/cards.json'
cards = json.load(open(p))
for c in cards:
    if c['id'] == 'cinder_rat': c['attributes']['power'] = 2
json.dump(cards, open(p, 'w'), indent=2)
EOF
git -C "$SCRATCH/bob-work" commit -qam "rebalance: Cinder Rat to 2 power"
git -C "$SCRATCH/bob-work" push -q origin main

echo "== 4. the pull request: alice reviews bob's changes as CARDS, not JSON =="
cd "$SCRATCH/alice-work"
git config diff.cards.command "node tools/git-diff-cards.mjs"
git remote add bob "$SRV/bob/ember.git"; git fetch -q bob
git diff main..bob/main -- examples/ember/components/cards.json

echo "== 5. alice accepts — bob's authorship lives in history forever =="
A; git merge -q --no-edit bob/main && git push -q origin main
git log --format='  %h %an  %s' -3
echo; echo "Scratch: $SCRATCH (safe to delete)"
