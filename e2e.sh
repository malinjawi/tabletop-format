#!/usr/bin/env bash
# e2e.sh — full end-to-end integration test for the format + tools (v0.1).
# Runs every pipeline in a scratch copy (never mutates the repo), counts
# PASS/FAIL, exits nonzero on any failure. This is the repo's standing
# integration test: keep it green (CONTRIBUTING.md makes it law).
#
# Requires: python3 (+PyYAML, jsonschema, Pillow), node >= 20, git.
# Node validator (ajv) is used when node_modules exists; Python twin otherwise.
REPO="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$(mktemp -d)"
PASS=0; FAIL=0; FAILED=()

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); FAILED+=("$1"); say "  FAIL  $1 ${2:+— $2}"; }
check(){ # check <name> <command...>  (expects exit 0)
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}
check_fails(){ # inverse: command MUST exit nonzero
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$name" "expected failure, got success"; else ok "$name"; fi
}

say "e2e: scratch at $SCRATCH"
tar -C "$REPO" --exclude='.git' --exclude='node_modules' --exclude='examples/*/exports' -cf - . | tar -C "$SCRATCH" -xf -
cd "$SCRATCH"

say ""
say "== schemas =="
SCHEMA_OK=1
for f in schemas/*.schema.json; do python3 -c "import json;json.load(open('$f'))" 2>/dev/null || { SCHEMA_OK=0; bad "schema parses: $f"; }; done
[ $SCHEMA_OK -eq 1 ] && ok "all schemas parse ($(ls schemas/*.schema.json | wc -l | tr -d ' ') files)"
check "node validator syntax" node --check tools/validate.mjs
for t in tools/*.mjs tools/lib/*.mjs; do node --check "$t" 2>/dev/null || bad "syntax: $t"; done
ok "all .mjs tools pass node --check"

say ""
say "== validation (3 example games) =="
for g in ember harbor-nine netrunner-urbp; do
  check "validate $g" python3 tools/validate.py "examples/$g"
done

say ""
say "== importers =="
check "csv import" node tools/import-csv.mjs examples/harbor-nine.csv "$SCRATCH/out-csv" --title "CSV Game"
check "csv round-trip validates" python3 tools/validate.py "$SCRATCH/out-csv"
check "nrdb import" node tools/import-nrdb.mjs examples/nrdb-fixture "$SCRATCH/out-nrdb" --title "NRDB Game"
check "nrdb round-trip validates" python3 tools/validate.py "$SCRATCH/out-nrdb"
NRDB_CARDS=$(python3 -c "import json;print(len(json.load(open('$SCRATCH/out-nrdb/components/cards.json'))))")
[ "$NRDB_CARDS" = "7" ] && ok "nrdb imported 7 cards" || bad "nrdb card count" "got $NRDB_CARDS"

say ""
say "== semantic diff =="
python3 - <<EOF
import json
c = json.load(open('examples/ember/components/cards.json'))
c[0]['attributes']['cost'] = 9
json.dump(c, open('$SCRATCH/patched.json','w'))
EOF
node tools/diff.mjs examples/ember/components/cards.json "$SCRATCH/patched.json" > "$SCRATCH/diff.out"
grep -q "cost: 0 → 9" "$SCRATCH/diff.out" && ok "diff reports field change" || bad "diff reports field change"

say ""
say "== render & export (ember) =="
check "render faces" python3 tools/render_cards.py examples/ember
NFACES=$(ls examples/ember/exports/faces/*.png | wc -l | tr -d ' ')
[ "$NFACES" = "11" ] && ok "render count (10 printings + back)" || bad "render count" "got $NFACES"
check "pnp pdf" python3 tools/export_pnp.py examples/ember
[ -s examples/ember/exports/ember-pnp.pdf ] && ok "pnp pdf non-empty" || bad "pnp pdf non-empty"
check "tts export" python3 tools/export_tts.py examples/ember
DECKIDS=$(python3 -c "import json;s=json.load(open('examples/ember/exports/tts/ember.json'));print(len(s['ObjectStates'][0]['DeckIDs']))")
QSUM=$(python3 -c "import json;print(sum(p.get('quantity',1) for p in json.load(open('examples/ember/components/printings.json'))))")
[ "$DECKIDS" = "$QSUM" ] && ok "tts deck honors quantities ($DECKIDS cards)" || bad "tts quantities" "$DECKIDS != $QSUM"

say ""
say "== decks & legality =="
printf '3 Kindling\n2 Twin Flame\n2 Ash Cloak\n1 Bellows\n1 Wildfire\n2 Ember Thief\n1 Last Light\n2 Cinder Rat\n' > "$SCRATCH/list.txt"
check "decklist import" node tools/import-decklist.mjs examples/ember "$SCRATCH/list.txt" --name "E2E Deck" --format standard
check "legal deck passes" python3 tools/check_deck.py examples/ember examples/ember/decks/e2e-deck.json
python3 -c "
import json; d=json.load(open('examples/ember/decks/e2e-deck.json'))
d['cards']['wildfire']=2; json.dump(d,open('$SCRATCH/cheat.json','w'))"
check_fails "restricted violation caught" python3 tools/check_deck.py examples/ember "$SCRATCH/cheat.json"

say ""
say "== licensing gate =="
check "original game publishable" python3 tools/check_licenses.py examples/ember
check_fails "imported content blocked" python3 tools/check_licenses.py examples/netrunner-urbp

say ""
say "== rules & tokens =="
grep -q "## Turn structure" examples/ember/rules/rules.md && ok "rulebook has real content" || bad "rulebook content"
python3 -c "
import json; t=json.load(open('examples/ember/components/tokens.json')); assert len(t)>=3" && ok "tokens present" || bad "tokens present"
python3 -c "
import json
t=json.load(open('examples/ember/components/tokens.json'))
t[0]['symbol']='nonexistent_symbol'
json.dump(t,open('examples/ember/components/tokens.json','w'))"
check_fails "undeclared token symbol caught" python3 tools/validate.py examples/ember
git checkout -q -- examples/ember/components/tokens.json 2>/dev/null || python3 -c "
import json
t=json.load(open('examples/ember/components/tokens.json'))
t[0]['symbol']='spark'
json.dump(t,open('examples/ember/components/tokens.json','w'),indent=2)"
check "validate ember (restored)" python3 tools/validate.py examples/ember

say ""
say "== playtests & stats =="
NPT=$(ls examples/ember/playtests/*.json 2>/dev/null | wc -l | tr -d ' ')
[ "$NPT" -ge 3 ] && ok "playtest sessions present ($NPT)" || bad "playtest sessions"
check "stats runs" python3 tools/stats.py examples/ember
python3 tools/stats.py examples/ember | grep -q "DECISION TRAIL" && ok "stats shows decision trail" || bad "stats decision trail"
python3 tools/stats.py examples/ember --json | python3 -c "import json,sys;d=json.load(sys.stdin);assert d['sessions']>=3" && ok "stats --json parses" || bad "stats --json"
python3 -c "
import json
s=json.load(open('examples/ember/playtests/2026-06-20-first-blood.json'))
s['card_notes'][0]['card_id']='ghost_card'
json.dump(s,open('$SCRATCH/badpt.json','w'))
import shutil; shutil.copy('$SCRATCH/badpt.json','examples/ember/playtests/2026-06-20-first-blood.json')"
check_fails "playtest bad card ref caught" python3 tools/validate.py examples/ember
cp "$REPO"/examples/ember/playtests/*.json examples/ember/playtests/
check "validate ember (playtests restored)" python3 tools/validate.py examples/ember

say ""
say "== plugin system & setup UI =="
node tools/fmt.mjs plugins | grep -q "csv" && node tools/fmt.mjs plugins | grep -q "pnp" && ok "plugin registry drives fmt" || bad "plugin registry"
node tools/fmt.mjs import nosuch 2>&1 | grep -q "Available" && ok "unknown plugin lists alternatives" || bad "unknown plugin msg"
python3 -c "
import json
p=json.load(open('tools/plugins.json'))
p['exporters']['e2etest']={'runner':'node','script':'diff.mjs','usage':'<a> <b>','desc':'e2e dummy'}
json.dump(p,open('tools/plugins.json','w'))"
node tools/fmt.mjs export e2etest examples/ember/components/cards.json examples/ember/components/cards.json >/dev/null 2>&1 && ok "drop-in plugin dispatches (manifest only)" || bad "drop-in plugin"
cp "$REPO/tools/plugins.json" tools/plugins.json
python3 tools/build_editor.py examples/ember -o "$SCRATCH/editor2.html" >/dev/null
grep -q "renderSetup" "$SCRATCH/editor2.html" && grep -q "downloadGameYaml" "$SCRATCH/editor2.html" && ok "editor has Game Setup (schema editing) UI" || bad "editor setup UI"

say ""
say "== community layer =="
check "community.yaml validates" python3 tools/validate.py examples/ember
check "credits runs" python3 tools/credits.py examples/ember
grep -q "playtester" examples/ember/CREDITS.md && ok "playtesters auto-credited" || bad "playtester credit"
grep -q "lead designer" examples/ember/CREDITS.md && ok "declared roles in credits" || bad "declared roles"
python3 -c "
import yaml
c=yaml.safe_load(open('examples/ember/community.yaml'))
c['governance']['model']='dictatorship'
yaml.safe_dump(c,open('examples/ember/community.yaml','w'))"
check_fails "invalid governance model caught" python3 tools/validate.py examples/ember
cp "$REPO/examples/ember/community.yaml" examples/ember/community.yaml
check "validate ember (community restored)" python3 tools/validate.py examples/ember

say ""
say "== jams =="
check "jam entry qualifies (ember vs first-flame)" python3 tools/check_jam.py examples/ember jams/first-flame-jam.yaml
python3 -c "
import yaml
j=yaml.safe_load(open('jams/first-flame-jam.yaml'))
j['constraints']['max_cards']=3
yaml.safe_dump(j,open('$SCRATCH/tightjam.yaml','w'))"
check_fails "over-limit entry rejected" python3 tools/check_jam.py examples/ember "$SCRATCH/tightjam.yaml"
python3 -c "
import yaml
j=yaml.safe_load(open('jams/first-flame-jam.yaml'))
j['theme']='submarines'
yaml.safe_dump(j,open('$SCRATCH/offtheme.yaml','w'))"
check_fails "theme-word check enforced" python3 tools/check_jam.py examples/ember "$SCRATCH/offtheme.yaml"

say ""
say "== UI generators =="
python3 tools/build_hub.py -o "$SCRATCH/hub.html" >/dev/null 2>&1 \
  && grep -q "profilePage" "$SCRATCH/hub.html" \
  && python3 -c "
import re,json
src=open('$SCRATCH/hub.html').read()
js=re.findall(r'<script>(.*?)</script>',src,re.S)[-1]
d=json.loads(re.search(r'const DATA = (\{.*?\});\n',js,re.S).group(1))
names=[p['name'] for p in d['people']]
assert 'Sam' in names and 'Priya' in names, names
sam=[p for p in d['people'] if p['name']=='Sam'][0]
assert sam['sessions']>=2 and sam['entries']==[]
" && ok "hub computes user profiles from git+playtests" || bad "hub profiles"
check "game page builds" python3 tools/build_site.py examples/ember --diff "$SCRATCH/patched.json" -o "$SCRATCH/site.html"
[ -s "$SCRATCH/site.html" ] && grep -q "Remix this game" "$SCRATCH/site.html" && ok "game page has remix affordance" || bad "game page content"
check "editor builds" python3 tools/build_editor.py examples/ember -o "$SCRATCH/editor.html"
grep -q "cards: DATA.cards\|const DATA" "$SCRATCH/editor.html" && ok "editor embeds game data" || bad "editor embeds game data"
grep -q "importCSVText" "$SCRATCH/editor.html" && ok "editor has in-browser CSV import (happy path)" || bad "editor CSV import"
python3 -c "
import re
src=open('$SCRATCH/editor.html').read()
js=re.findall(r'<script>(.*?)</script>',src,re.S)[-1]
open('$SCRATCH/edjs.js','w').write(js)"
node --check "$SCRATCH/edjs.js" && ok "editor JS (with importer) parses" || bad "editor JS syntax"

say ""
say "== git porcelain (scratch repo) =="
export GIT_AUTHOR_NAME=e2e GIT_COMMITTER_NAME=e2e GIT_AUTHOR_EMAIL=e2e@test GIT_COMMITTER_EMAIL=e2e@test
git init -qb main "$SCRATCH" && git -C "$SCRATCH" add -A && git -C "$SCRATCH" commit -qm "init"
python3 - <<EOF
import json
p='$SCRATCH/examples/ember/components/cards.json'
c=json.load(open(p)); c[0]['attributes']['cost']=5; json.dump(c,open(p,'w'))
EOF
node tools/fmt-git.mjs save examples/ember > "$SCRATCH/save.out" 2>&1
grep -q "cards: changed 1 card" "$SCRATCH/save.out" && ok "fmt save auto-writes commit message" || bad "fmt save message" "$(head -1 "$SCRATCH/save.out")"
git -C "$SCRATCH" log -1 --format=%B | grep -q "Kindling" && ok "commit body names the card" || bad "commit body names the card"
node tools/fmt-git.mjs history examples/ember -n 1 2>/dev/null | grep -q "cost: 0 → 5" && ok "fmt history shows semantic change" || bad "fmt history"
check "fmt changelog writes file" node tools/fmt-git.mjs changelog examples/ember
[ -s examples/ember/CHANGELOG.md ] && ok "CHANGELOG.md non-empty" || bad "CHANGELOG.md"
node tools/fmt-git.mjs release examples/ember 9.9.9 >/dev/null 2>&1
git -C "$SCRATCH" tag | grep -q v9.9.9 && ok "fmt release tags" || bad "fmt release tags"
git -C "$SCRATCH" config diff.cards.command "node $SCRATCH/tools/git-diff-cards.mjs"
python3 - <<EOF
import json
p='$SCRATCH/examples/ember/components/cards.json'
c=json.load(open(p)); c[1]['attributes']['power']=7; json.dump(c,open(p,'w'))
EOF
git -C "$SCRATCH" diff -- examples/ember/components/cards.json | grep -q "power: 0 → 7" && ok "git diff speaks cards (driver)" || bad "git diff driver"

say ""
say "== platform server (Block G v0) =="
PORT=$(( (RANDOM % 2000) + 18000 ))
node server.mjs --port $PORT > "$SCRATCH/srv.log" 2>&1 &
SRVPID=$!
sleep 1.5
NGAMES=$(curl -s "localhost:$PORT/api/games" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null)
[ "$NGAMES" = "3" ] && ok "server discovers 3 games" || bad "server discovery" "got '$NGAMES'"
curl -s "localhost:$PORT/api/games/ember/cards" | python3 -c "
import json,sys
cards=json.load(sys.stdin)
for c in cards:
    if c['id']=='kindling': c['attributes']['power']=3
json.dump(cards,open('$SCRATCH/put.json','w'))" 2>/dev/null
PUTMSG=$(curl -s -X PUT -H 'content-type: application/json' --data @"$SCRATCH/put.json" "localhost:$PORT/api/games/ember/cards" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('saved'),d.get('message',''))" 2>/dev/null)
echo "$PUTMSG" | grep -q "True cards: changed 1 card" && ok "HTTP PUT → git commit w/ auto message" || bad "HTTP PUT commit" "$PUTMSG"
git log -1 --format=%s | grep -q "Kindling" && ok "commit subject names the card" || git log -1 --format=%B | grep -q "Kindling" && ok "commit body names the card" || bad "commit content"
python3 -c "
import json
c=json.load(open('$SCRATCH/put.json')); c[0]['attributes']['power']='bad'
json.dump(c,open('$SCRATCH/badput.json','w'))"
BADCODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' --data @"$SCRATCH/badput.json" "localhost:$PORT/api/games/ember/cards")
[ "$BADCODE" = "422" ] && ok "invalid PUT rejected (422) with rollback" || bad "invalid PUT" "got $BADCODE"
curl -s "localhost:$PORT/api/games/ember/validate" | grep -q '"ok": true' && ok "post-rollback state validates" || bad "rollback state"
kill $SRVPID 2>/dev/null

say ""
say "== beta hardening =="
PORT2=$(( (RANDOM % 2000) + 21000 ))
node server.mjs --port $PORT2 --readonly > "$SCRATCH/ro.log" 2>&1 &
ROPID=$!
sleep 1.5
ROCODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -d '[]' "localhost:$PORT2/api/games/ember/cards")
[ "$ROCODE" = "403" ] && ok "readonly mode blocks writes (403)" || bad "readonly mode" "got $ROCODE"
GETCODE=$(curl -s -o /dev/null -w '%{http_code}' "localhost:$PORT2/api/games")
[ "$GETCODE" = "200" ] && ok "readonly mode still serves reads" || bad "readonly reads" "got $GETCODE"
kill $ROPID 2>/dev/null

say ""
say "== fork demo (full publish→fork→PR→merge loop) =="
git -C "$SCRATCH" checkout -q -- .
bash fork-demo.sh "$SCRATCH/forkdemo" > "$SCRATCH/fork.out" 2>&1 \
  && grep -q "semantic card diff" "$SCRATCH/fork.out" \
  && grep -q "bob" "$SCRATCH/fork.out" \
  && ok "fork demo end-to-end" || bad "fork demo" "$(tail -2 "$SCRATCH/fork.out" | head -1)"

say ""
say "=================================================="
say "e2e: $PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
  for f in "${FAILED[@]}"; do say "  ✗ $f"; done
  exit 1
fi
say "ALL GREEN — the loop is real."
