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
say "== UI generators =="
check "game page builds" python3 tools/build_site.py examples/ember --diff "$SCRATCH/patched.json" -o "$SCRATCH/site.html"
[ -s "$SCRATCH/site.html" ] && grep -q "Remix this game" "$SCRATCH/site.html" && ok "game page has remix affordance" || bad "game page content"
check "editor builds" python3 tools/build_editor.py examples/ember -o "$SCRATCH/editor.html"
grep -q "cards: DATA.cards\|const DATA" "$SCRATCH/editor.html" && ok "editor embeds game data" || bad "editor embeds game data"

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
