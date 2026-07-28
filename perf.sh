#!/usr/bin/env bash
# perf.sh — scale & concurrency smoke (NF3 evidence). Separate from e2e.sh so the
# functional suite stays fast; run both before any release: ./e2e.sh && ./perf.sh
REPO="$(cd "$(dirname "$0")" && pwd)"
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }  # BSD date lacks %N
SCRATCH="$(mktemp -d)"
PASS=0; FAIL=0; FAILED=()
say(){ printf '%s\n' "$*"; }
ok(){ PASS=$((PASS+1)); say "  PASS  $1"; }
bad(){ FAIL=$((FAIL+1)); FAILED+=("$1"); say "  FAIL  $1 ${2:+— $2}"; }
tar -C "$REPO" --exclude='.git' --exclude='node_modules' --exclude='examples/*/exports' --exclude='beta-site' -cf - . | tar -C "$SCRATCH" -xf -
cd "$SCRATCH"
export GIT_AUTHOR_NAME=perf GIT_COMMITTER_NAME=perf GIT_AUTHOR_EMAIL=p@x GIT_COMMITTER_EMAIL=p@x
git init -qb main . && git add -A && git commit -qm baseline

say "== scale & concurrency smoke (NF3 evidence, not just correctness) =="
python3 -c "
import csv, random
random.seed(9)
rows=[['name','type','text','cost','power','deck_limit']]
for i in range(150):
    rows.append([f'Card {i:03d}', random.choice(['ember','ward','tool','figure']),
                 f'Test effect number {i} with [spark] symbol.', random.randint(0,6),
                 random.randint(0,8), random.randint(1,3)])
csv.writer(open('$SCRATCH/big.csv','w')).writerows(rows)"
T0=$(now_ms)
node tools/import-csv.mjs "$SCRATCH/big.csv" "$SCRATCH/big-game" --title "Big Game" >/dev/null 2>&1
python3 tools/validate.py "$SCRATCH/big-game" >/dev/null 2>&1
T1=$(now_ms)
VMS=$(( T1-T0 ))
[ $VMS -lt 5000 ] && ok "150-card import+validate in ${VMS}ms (<5s)" || bad "big-game validate slow" "${VMS}ms"
head -25 "$SCRATCH/big.csv" > "$SCRATCH/mid.csv"
node tools/import-csv.mjs "$SCRATCH/mid.csv" "$SCRATCH/mid-game" --title "Mid Game" >/dev/null 2>&1
T0=$(now_ms)
python3 tools/render_cards.py "$SCRATCH/mid-game" >/dev/null 2>&1
T1=$(now_ms)
RMS=$(( T1-T0 ))
NREN=$(ls "$SCRATCH/mid-game/exports/faces" 2>/dev/null | wc -l | tr -d ' ')
[ "$NREN" -ge 24 ] && ok "24 faces rendered in ${RMS}ms (~$((RMS/24))ms/card ref renderer; 300-card set ≈ $((RMS*25/2/1000))s)" || bad "mid render" "$NREN faces"
# concurrency: two simultaneous PUTs must not corrupt the repo
CPORT=$(( (RANDOM % 2000) + 28000 ))
node server.mjs --port $CPORT > "$SCRATCH/csrv.log" 2>&1 &
CPID=$!
sleep 1.5
curl -s "localhost:$CPORT/api/games/ember/cards" > "$SCRATCH/base.json"
python3 -c "
import json
c=json.load(open('$SCRATCH/base.json'))
for x in c:
    if x['id']=='kindling': x['attributes']['power']=8
json.dump(c,open('$SCRATCH/w1.json','w'))
c=json.load(open('$SCRATCH/base.json'))
for x in c:
    if x['id']=='bellows': x['attributes']['cost']=3
json.dump(c,open('$SCRATCH/w2.json','w'))"
curl -s -X PUT -H 'content-type: application/json' --data @"$SCRATCH/w1.json" "localhost:$CPORT/api/games/ember/cards" > "$SCRATCH/r1.json" &
W1=$!
curl -s -X PUT -H 'content-type: application/json' --data @"$SCRATCH/w2.json" "localhost:$CPORT/api/games/ember/cards" > "$SCRATCH/r2.json" &
W2=$!
wait $W1 $W2
kill $CPID 2>/dev/null
git fsck --no-progress >/dev/null 2>&1 && ok "repo integrity after concurrent PUTs (git fsck clean)" || bad "git fsck after concurrency"
python3 -c "import json; json.load(open('examples/ember/components/cards.json'))" && ok "cards.json parseable after concurrent PUTs" || bad "cards.json corrupted"
python3 tools/validate.py examples/ember >/dev/null 2>&1 && ok "game still validates after concurrent PUTs" || bad "post-concurrency validate"
git checkout -q -- examples/ember/components/cards.json 2>/dev/null || true

say ""

say ""
say "perf: $PASS passed, $FAIL failed"
[ $FAIL -gt 0 ] && { for f in "${FAILED[@]}"; do say "  x $f"; done; exit 1; }
say "PERF GREEN"
