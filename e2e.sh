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
mint() { curl -s -X POST "localhost:$1/api/auth/register" -H 'content-type: application/json' \
  -d '{"handle":"suite-'$RANDOM'","email":"s'$RANDOM'@e2e.io","password":"longenough1"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])"; }
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
tar -C "$REPO" --exclude='.git' --exclude='node_modules' --exclude='tmp' --exclude='examples/*/exports' -cf - . | tar -C "$SCRATCH" -xf -
cd "$SCRATCH" || { echo "FATAL: cannot cd to scratch"; exit 2; }
# The scratch copy intentionally excludes dependency bytes, but Node tools still
# resolve the exact dependencies installed for this checkout.
[ ! -d "$REPO/node_modules" ] || ln -s "$REPO/node_modules" "$SCRATCH/node_modules"
# SAFETY: git must never walk up into the real repo (scratch has no .git of its own
# until section 'git porcelain' inits it). Without this, a failed scratch copy would
# make git commit/reset --hard operate on the source repo and destroy work.
export GIT_CEILING_DIRECTORIES="$(dirname "$SCRATCH")"
[ -f "$SCRATCH/server.mjs" ] || { echo "FATAL: scratch copy incomplete — aborting before any git op"; exit 2; }

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
python3 - <<'PY' && ok "tts carries provenance (GMNotes credit on every card + visible in-game Note)" || bad "tts provenance"
import json
s=json.load(open('examples/ember/exports/tts/ember.json'))
co=s['ObjectStates'][0]['ContainedObjects']
assert co and all(o.get('GMNotes') for o in co), "every card needs a GMNotes credit"
assert 'License' in co[0]['GMNotes']
assert 'TBD' in s.get('Note',''), "non-default art credit surfaced in the Note panel"
assert any('(alt-art)' in o['Nickname'] for o in co), "variant reflected in the nickname"
PY
python3 -c "import json,sys;d=json.load(open('examples/ember/exports/tts/ember.json'))['ObjectStates'][0]['CustomDeck']['1'];sys.exit(0 if d['NumWidth']<=10 and d['NumHeight']<=7 else 1)" && ok "tts sheet within TTS grid limits (<=10x7)" || bad "tts sheet limits"
check "ttc export" python3 tools/export_ttc.py examples/ember
TTCPACK=examples/ember/exports/ttc/Ember/cards
[ -f "$TTCPACK/config.cfg" ] && [ -f "$TTCPACK/stacks.cfg" ] && [ -f "$TTCPACK/_back.png" ] && ok "ttc pack: cards/ + config.cfg + stacks.cfg + _back.png" || bad "ttc pack layout"
grep -q 'back_face = "_back.png"' "$TTCPACK/config.cfg" && grep -q 'license = "CC0-1.0"' "$TTCPACK/config.cfg" && ok "ttc config.cfg: shared back_face + game license" || bad "ttc config"
grep -q 'author = "TBD"' "$TTCPACK/config.cfg" && ok "ttc carries per-card provenance (credit follows the work onto the table)" || bad "ttc provenance"
TTCITEMS=$(python3 -c "import re;t=open('$TTCPACK/stacks.cfg').read();print(t.count('\"'))")
TTCITEMS=$(python3 -c "import re;t=open('$TTCPACK/stacks.cfg').read();m=re.search(r'items = \[(.*?)\]',t,re.S);print(m.group(1).count(chr(34))//2)")
[ "$TTCITEMS" = "$QSUM" ] && ok "ttc stacks.cfg deck honors quantities ($TTCITEMS cards)" || bad "ttc deck qty" "$TTCITEMS != $QSUM"
python3 -c "import zipfile;z=zipfile.ZipFile('examples/ember/exports/ttc/ember-ttc.zip');import sys;sys.exit(0 if (z.testzip() is None and any('config.cfg' in n for n in z.namelist())) else 1)" && ok "ttc distributable zip valid (unzip into TabletopClub/assets/)" || bad "ttc zip"
say "== interop importers (bring outside work in) =="
check "tts import (round-trip)" node tools/import-tts.mjs examples/ember/exports/tts/ember.json "$SCRATCH/tts-rt" --title "Ember RT"
RTQ=$(python3 -c "import json;print(sum(p.get('quantity',1) for p in json.load(open('$SCRATCH/tts-rt/components/printings.json'))))")
[ "$RTQ" = "$QSUM" ] && ok "tts import round-trips the deck size ($RTQ cards)" || bad "tts round-trip qty" "$RTQ != $QSUM"
python3 tools/validate.py "$SCRATCH/tts-rt" >/dev/null 2>&1 && ok "tts-imported game validates" || bad "tts import validate"
grep -q '"artist"' "$SCRATCH/tts-rt/components/printings.json" && ok "tts import carries GMNotes credit back (provenance round-trip)" || bad "tts import provenance"
printf '%s' '{"location":"screentop","duration_minutes":22,"players":[{"name":"Rae","result":"WIN","elo":1400},{"name":"Kai","result":"loss"}],"card_notes":[{"card_id":"wildfire","tag":"Balance","note":"snowballs"},{"card_id":"x","tag":"bogus","note":"drop"}],"secret":"nope"}' > "$SCRATCH/sess.json"
check "playtest ingest" node tools/import-playtest.mjs "$SCRATCH/tts-rt" "$SCRATCH/sess.json" --ref abc1234 --date 2026-07-30
python3 tools/validate.py "$SCRATCH/tts-rt" >/dev/null 2>&1 && ok "ingested playtest validates against the schema" || bad "playtest ingest validate"
python3 -c "import json;s=json.load(open('$SCRATCH/tts-rt/playtests/2026-07-30-screentop.json'));assert s['version_ref']=='abc1234';assert all(p.get('result') in (None,'win','loss','draw') for p in s['players']);assert all('elo' not in p for p in s['players']);assert len(s.get('card_notes',[]))==1" && ok "ingest normalizes: version pinned, results validated, junk + bad-tag dropped" || bad "playtest ingest normalize"
python3 tools/stats.py "$SCRATCH/tts-rt" --json 2>/dev/null | python3 -c "import json,sys;assert json.load(sys.stdin)['sessions']>=1" && ok "stats aggregates the ingested session" || bad "playtest ingest stats"
say "== interop: nanDECK bridge (script + CSV; nothing runs server-side) =="
check "nandeck export" python3 tools/export_nandeck.py examples/ember
NDCSV=examples/ember/exports/nandeck/ember.csv; NDTXT=examples/ember/exports/nandeck/ember.txt
NDROWS=$(python3 -c "import csv;print(sum(1 for _ in csv.reader(open('$NDCSV')))-1)")
[ "$NDROWS" = "$QSUM" ] && ok "nandeck csv: one row per physical card ($NDROWS == deck size)" || bad "nandeck row count" "$NDROWS != $QSUM"
grep -q '^LINK=ember.csv' "$NDTXT" && grep -q '^CARDSIZE=' "$NDTXT" && grep -q '\[name\]' "$NDTXT" && grep -q '\[text\]' "$NDTXT" && ok "nandeck script binds LINK + CARDSIZE + [name]/[text] columns" || bad "nandeck script"
head -1 "$NDCSV" | grep -q name && head -1 "$NDCSV" | grep -q cost && head -1 "$NDCSV" | grep -q collector_number && ok "nandeck csv header carries the referenced columns" || bad "nandeck header"
python3 -c "import csv,sys;rows=list(csv.DictReader(open('$NDCSV')));sys.exit(0 if all('[' not in r['text'] for r in rows) else 1)" && ok "symbol tokens rewritten so they don't collide with nanDECK [column] syntax" || bad "nandeck symbol escape"
say "== card themes (HTML/CSS render, swappable) =="
check "html render (themed)" python3 tools/render_html.py examples/ember --theme classic -o "$SCRATCH/cards.html"
HC=$(python3 -c "print(open('$SCRATCH/cards.html').read().count('data-type='))")
[ "$HC" -ge 6 ] && grep -q 'data-theme="classic"' "$SCRATCH/cards.html" && grep -q 'Cinzel' "$SCRATCH/cards.html" && ok "themed sheet renders all cards + inlines theme & web fonts ($HC)" || bad "html render"
python3 tools/render_html.py examples/ember --theme foil -o "$SCRATCH/foil.html" && grep -q 'background:#20242b' "$SCRATCH/foil.html" && ok "swapping --theme swaps the whole look (foil is dark)" || bad "theme swap"
python3 tools/render_html.py examples/ember --theme nope >/dev/null 2>&1 && bad "unknown theme should fail" || ok "unknown theme rejected with the available list"
[ -f themes/classic.css ] && [ -f themes/minimal.css ] && [ -f themes/foil.css ] && ok "3 built-in themes shipped in themes/" || bad "themes missing"

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
node tools/import-csv.mjs jams/spark-jam-starter.csv "$SCRATCH/spark-start" --title "Spark Starter" >/dev/null 2>&1
check "drafted Spark Jam starter qualifies (the one-click-join invariant)" python3 tools/check_jam.py "$SCRATCH/spark-start" jams/spark-jam.yaml
python3 -c "import yaml,json,jsonschema;jsonschema.Draft7Validator(json.load(open('schemas/jam.schema.json'))).validate(yaml.safe_load(open('jams/spark-jam.yaml').read()))" && ok "spark-jam.yaml valid against jam.schema.json" || bad "spark-jam schema"

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
NGAMES=$(curl -s "localhost:$PORT/api/games" | python3 -c "import json,sys;d=json.load(sys.stdin);need={'ember','harbor-nine','netrunner-urbp'};slugs={g['slug'] for g in d};assert need<=slugs;print(len(d))" 2>/dev/null)
[ -n "$NGAMES" ] && ok "server discovers the game catalog ($NGAMES games, core examples present)" || bad "server discovery" "missing core examples"
curl -s "localhost:$PORT/api/games/ember/cards" | python3 -c "
import json,sys
cards=json.load(sys.stdin)
for c in cards:
    if c['id']=='kindling': c['attributes']['power']=3
json.dump(cards,open('$SCRATCH/put.json','w'))" 2>/dev/null
GTOK=$(mint $PORT)
ANON=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' --data @"$SCRATCH/put.json" "localhost:$PORT/api/games/ember/cards")
[ "$ANON" = "401" ] && ok "anonymous commit REJECTED (401) — the hole is closed" || bad "anonymous commit allowed" "$ANON"
PUTMSG=$(curl -s -X PUT -H 'content-type: application/json' -H "Authorization: Bearer $GTOK" --data @"$SCRATCH/put.json" "localhost:$PORT/api/games/ember/cards" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('saved'),d.get('message',''))" 2>/dev/null)
echo "$PUTMSG" | grep -q "True cards: changed 1 card" && ok "HTTP PUT → git commit w/ auto message" || bad "HTTP PUT commit" "$PUTMSG"
git log -1 --format=%s | grep -q "Kindling" && ok "commit subject names the card" || git log -1 --format=%B | grep -q "Kindling" && ok "commit body names the card" || bad "commit content"
# editing is NOT cards-only, and NOT a separate page: general artifact write + /edit redirect
REDIR=$(curl -s -o /dev/null -w '%{redirect_url}' "localhost:$PORT/edit/ember")
case "$REDIR" in *"#/g/ember/cards/edit") ok "/edit/:slug redirects into the SPA route (#/g/:slug/cards/edit)";; *) bad "edit redirect" "$REDIR";; esac
ANONART=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -d '{"path":"rules/rules.md","content":"x"}' "localhost:$PORT/api/games/ember/artifact")
[ "$ANONART" = "401" ] && ok "artifact write requires auth (401)" || bad "artifact auth" "$ANONART"
ARTMSG=$(curl -s -X PUT -H 'content-type: application/json' -H "Authorization: Bearer $GTOK" -d '{"path":"rules/rules.md","content":"# Ember\n\nEdited rulebook via artifact route."}' "localhost:$PORT/api/games/ember/artifact" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('saved'),d.get('message'))" 2>/dev/null)
echo "$ARTMSG" | grep -q "True rules: update rulebook" && ok "rules editable as an artifact → committed (not just cards)" || bad "artifact rules commit" "$ARTMSG"
BADART=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -H "Authorization: Bearer $GTOK" -d '{"path":"../secret","content":"x"}' "localhost:$PORT/api/games/ember/artifact")
[ "$BADART" = "422" ] && ok "artifact path allowlist blocks traversal (422)" || bad "artifact allowlist" "$BADART"
python3 -c "
import json
c=json.load(open('$SCRATCH/put.json')); c[0]['attributes']['power']='bad'
json.dump(c,open('$SCRATCH/badput.json','w'))"
BADCODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -H "Authorization: Bearer $GTOK" --data @"$SCRATCH/badput.json" "localhost:$PORT/api/games/ember/cards")
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
say "== SPEC conformance (audit fixes) =="
python3 tools/validate.py examples/ember 2>&1 | grep -q "not found" \
  && bad "ember asset refs resolve" || ok "ember asset refs resolve (icons exist)"
python3 -c "
import yaml
g=yaml.safe_load(open('examples/ember/game.yaml'))
g['symbols'][0]['asset']='assets/icons/bogus.png'
yaml.safe_dump(g,open('examples/ember/game.yaml','w'))"
python3 tools/validate.py examples/ember 2>&1 | grep -q "bogus.png' not found" \
  && ok "dangling asset reference warned" || bad "dangling asset warning"
cp "$REPO/examples/ember/game.yaml" examples/ember/game.yaml
# fork attribution auto-commit (SPEC §9) on a one-game-one-repo layout
export GIT_AUTHOR_NAME=origin GIT_COMMITTER_NAME=origin GIT_AUTHOR_EMAIL=o@x GIT_COMMITTER_EMAIL=o@x
mkdir -p "$SCRATCH/solo" && cp -r examples/ember/* "$SCRATCH/solo/" 2>/dev/null
git init -qb main "$SCRATCH/solo" >/dev/null 2>&1 && git -C "$SCRATCH/solo" add -A && git -C "$SCRATCH/solo" commit -qm init
git clone -q --bare "$SCRATCH/solo" "$SCRATCH/solo-origin.git" && git -C "$SCRATCH/solo-origin.git" symbolic-ref HEAD refs/heads/main
node tools/fmt-git.mjs fork "$SCRATCH/solo-origin.git" "$SCRATCH/solo-fork.git" >/dev/null 2>&1
git clone -q "$SCRATCH/solo-fork.git" "$SCRATCH/solo-fork-wc" 2>/dev/null
grep -q "attribution:" "$SCRATCH/solo-fork-wc/game.yaml" 2>/dev/null \
  && grep -q "source_id: ember" "$SCRATCH/solo-fork-wc/game.yaml" \
  && ok "fmt fork auto-commits attribution block (SPEC §9)" || bad "fork attribution"

say ""
say "== LFS write path (SPEC §7 landmine workaround, against protocol mock w/ R2 layout) =="
LPORT=$(( (RANDOM % 2000) + 24000 ))
LSTORE="$SCRATCH/lfs-store"
node tools/lfs-mock-server.mjs --port $LPORT --store "$LSTORE" > "$SCRATCH/lfs.log" 2>&1 &
LPID=$!
sleep 1
python3 -c "
from PIL import Image
Image.new('RGB',(300,420),(140,47,27)).save('$SCRATCH/art.png')"
export GIT_AUTHOR_NAME=lfs GIT_COMMITTER_NAME=lfs GIT_AUTHOR_EMAIL=l@x GIT_COMMITTER_EMAIL=l@x
node tools/add-asset.mjs "$SCRATCH/solo" "$SCRATCH/art.png" --as assets/art/test_card.png --lfs-url "http://localhost:$LPORT" --commit > "$SCRATCH/add.out" 2>&1
grep -q "LFS: uploaded" "$SCRATCH/add.out" && ok "asset uploaded via LFS batch protocol" || bad "LFS upload" "$(cat "$SCRATCH/add.out" | head -2)"
head -1 "$SCRATCH/solo/assets/art/test_card.png" | grep -q "git-lfs.github.com/spec/v1" && ok "git holds 3-line POINTER, not binary" || bad "pointer file"
OID=$(grep -o 'sha256:[0-9a-f]*' "$SCRATCH/solo/assets/art/test_card.png" | cut -d: -f2)
[ -f "$LSTORE/lfs/${OID:0:2}/${OID:2:2}/$OID" ] && ok "blob stored at R2 key layout lfs/xx/yy/oid" || bad "R2 key layout"
git -C "$SCRATCH/solo" log -1 --format=%s | grep -q "assets: add" && ok "pointer committed atomically via porcelain" || bad "pointer commit"
node -e "
import('./tools/lib/lfs.mjs').then(async lfs => {
  const fs = await import('node:fs');
  const ptr = fs.readFileSync('$SCRATCH/solo/assets/art/test_card.png','utf8');
  const buf = await lfs.downloadAsset('http://localhost:$LPORT', ptr);
  const orig = fs.readFileSync('$SCRATCH/art.png');
  process.exit(buf.equals(orig) ? 0 : 1);
})" && ok "round-trip download sha-verified, bytes identical" || bad "LFS round-trip"
head -c 200 /dev/urandom > "$SCRATCH/evil.exe" 2>/dev/null || python3 -c "open('$SCRATCH/evil.exe','wb').write(b'x'*200)"
node tools/add-asset.mjs "$SCRATCH/solo" "$SCRATCH/evil.exe" --lfs-url "http://localhost:$LPORT" >/dev/null 2>&1 && bad "type allowlist" "exe accepted" || ok "disallowed type rejected (limits.mjs)"
say ""
say "== asset pipeline over HTTP (server → LFS/portable → commit → render) =="
APORT=$(( (RANDOM % 2000) + 26000 ))
LFS_URL="http://localhost:$LPORT" node server.mjs --port $APORT > "$SCRATCH/asrv.log" 2>&1 &
APID=$!
sleep 1.5
python3 -c "
from PIL import Image
Image.new('RGB',(200,120),(30,120,200)).save('$SCRATCH/blue.png')"
ATOK=$(mint $APORT)
RSP=$(curl -s -X POST -H "Authorization: Bearer $ATOK" --data-binary @"$SCRATCH/blue.png" "localhost:$APORT/api/games/ember/assets?path=assets/art/e2e_blue.png")
echo "$RSP" | grep -q '"mode": "lfs"' && ok "server upload → LFS mode (pointer committed)" || bad "server LFS upload" "$RSP"
head -1 examples/ember/assets/art/e2e_blue.png | grep -q "git-lfs" && ok "repo holds pointer, not binary" || bad "server pointer on disk"
git log -1 --format=%s | grep -q "assets: add assets/art/e2e_blue.png" && ok "asset auto-committed" || bad "asset commit"
curl -s "localhost:$APORT/api/games/ember/assets/art/e2e_blue.png" -o "$SCRATCH/blue_back.png"
python3 -c "
import hashlib
a=hashlib.sha256(open('$SCRATCH/blue.png','rb').read()).hexdigest()
b=hashlib.sha256(open('$SCRATCH/blue_back.png','rb').read()).hexdigest()
assert a==b, (a,b)" && ok "GET materializes pointer from LFS, bytes identical" || bad "asset GET round-trip"
BADRSP=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $ATOK" --data-binary @"$SCRATCH/blue.png" "localhost:$APORT/api/games/ember/assets?path=assets/x.exe")
[ "$BADRSP" = "422" ] && ok "server rejects disallowed type (422)" || bad "server type gate" "got $BADRSP"
kill $APID 2>/dev/null
say ""
say "== renderer uses real art =="
python3 tools/render_cards.py examples/ember >/dev/null 2>&1
python3 -c "
from PIL import Image
px=Image.open('examples/ember/exports/faces/p_wildfire_core.png').getpixel((375,400))
assert px[0]>90 and px[0]>px[2], px" && ok "wildfire face shows real flame art (pixel-verified)" || bad "art rendering"
kill $LPID 2>/dev/null

say ""
say "== Store 2 slice 1: auth, stars, claims, games index (real SQL via node:sqlite) =="
SPORT=$(( (RANDOM % 2000) + 30000 ))
DB_PATH="$SCRATCH/platform.db" node server.mjs --port $SPORT > "$SCRATCH/s2.log" 2>&1 &
SPID2=$!
sleep 1.5
REG=$(curl -s -X POST -H 'content-type: application/json' -d '{"handle":"linja","email":"l@example.com","password":"hunter2hunter2"}' "localhost:$SPORT/api/auth/register")
TOKEN=$(echo "$REG" | python3 -c "import json,sys;print(json.load(sys.stdin).get('token',''))")
[ ${#TOKEN} = 64 ] && ok "register → session token" || bad "register" "$REG"
DUP=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"handle":"linja","email":"x@example.com","password":"hunter2hunter2"}' "localhost:$SPORT/api/auth/register")
[ "$DUP" = "409" ] && ok "duplicate handle rejected (409)" || bad "dup register" "$DUP"
BADPW=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"handle":"linja","password":"wrong-password"}' "localhost:$SPORT/api/auth/login")
[ "$BADPW" = "401" ] && ok "wrong password rejected (401)" || bad "bad login" "$BADPW"
NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "localhost:$SPORT/api/stars/ember")
[ "$NOAUTH" = "401" ] && ok "unauthenticated star rejected (401)" || bad "unauth star" "$NOAUTH"
STAR=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN" "localhost:$SPORT/api/stars/ember")
echo "$STAR" | grep -q '"stars": 1' && ok "star ember → count 1" || bad "star" "$STAR"
curl -s "localhost:$SPORT/api/games" | python3 -c "
import json,sys
g={x['slug']:x for x in json.load(sys.stdin)}
assert g['ember']['stars']==1 and g['harbor-nine']['stars']==0, g" && ok "games index serves star counts (DA-3)" || bad "games index stars"
CLAIM=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"author":"Sam"}' "localhost:$SPORT/api/claims")
[ "$CLAIM" = "201" ] && ok "claim author string 'Sam' (DA-7)" || bad "claim" "$CLAIM"
curl -s -H "Authorization: Bearer $TOKEN" "localhost:$SPORT/api/me" | python3 -c "
import json,sys
me=json.load(sys.stdin)
assert 'Sam' in me['claims'] and 'ember' in me['starred'], me" && ok "/api/me: claims + starred coherent" || bad "/api/me"
UNSTAR=$(curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "localhost:$SPORT/api/stars/ember")
echo "$UNSTAR" | grep -q '"stars": 0' && ok "unstar → count 0" || bad "unstar" "$UNSTAR"
kill $SPID2 2>/dev/null

say "== Store 3: derived cache — immutable sha-addressed URLs (DA-5) =="
CPORT3=$(( (RANDOM % 2000) + 32000 ))
export CACHE_DIR="$SCRATCH/cache"
DB_PATH="$SCRATCH/platform.db" node server.mjs --port $CPORT3 > "$SCRATCH/s3.log" 2>&1 &
SPID3=$!
sleep 1.5
SHA0=$(git rev-parse --short HEAD)
EXP=$(curl -s -X POST "localhost:$CPORT3/api/games/ember/export/tts")
echo "$EXP" | grep -q "\"ref\": \"$SHA0\"" && ok "export keyed by current sha ($SHA0)" || bad "export sha key" "$EXP"
TTSURL=$(echo "$EXP" | python3 -c "import json,sys;print(json.load(sys.stdin)['urls'][0])")
HDR=$(curl -s -D - -o "$SCRATCH/tts_cached.json" "localhost:$CPORT3$TTSURL" | tr -d '\r')
echo "$HDR" | grep -q "max-age=31536000, immutable" && ok "immutable cache headers on cache URL" || bad "immutable headers"
python3 -c "import json; json.load(open('$SCRATCH/tts_cached.json'))" && ok "cached TTS save parses" || bad "cached tts"
EXP2=$(curl -s -X POST "localhost:$CPORT3/api/games/ember/export/tts")
echo "$EXP2" | grep -q '"cached": true' && ok "second export = cache hit (idempotent per key)" || bad "cache hit" "$EXP2"
# history immutability: change a card, new sha exports separately; OLD url still serves
python3 -c "
import json
p='examples/ember/components/cards.json'; c=json.load(open(p))
c[0]['attributes']['power']=4; json.dump(c,open(p,'w'),indent=2)"
git commit -qam "e2e: bump kindling power"
SHA1=$(git rev-parse --short HEAD)
EXP3=$(curl -s -X POST "localhost:$CPORT3/api/games/ember/export/tts")
echo "$EXP3" | grep -q "\"ref\": \"$SHA1\"" && ok "new commit → new cache ref ($SHA1)" || bad "new ref" "$EXP3"
curl -s -o /dev/null -w '%{http_code}' "localhost:$CPORT3$TTSURL" | grep -q 200 && ok "OLD sha URL still serves (immutability across edits)" || bad "old url"
[ -d "$SCRATCH/cache/exports/ember/$SHA0" ] && [ -d "$SCRATCH/cache/exports/ember/$SHA1" ] && ok "both refs coexist under R2-layout keys" || bad "key layout"
# GC: age SHA0, keep SHA1 → SHA0 removed, SHA1 kept (tags-forever policy = keep set)
node -e "
import('./platform/cache.mjs').then(c => {
  c._ageForTest('exports/ember/$SHA0', 40*24*3600*1000);
  const removed = c.gc({ keep: new Set(['$SHA1']) });
  if (!removed.includes('exports/ember/$SHA0')) process.exit(1);
})" && [ ! -d "$SCRATCH/cache/exports/ember/$SHA0" ] && [ -d "$SCRATCH/cache/exports/ember/$SHA1" ] \
  && ok "GC removes aged refs, keeps protected refs (DA-5 policy)" || bad "gc policy"
kill $SPID3 2>/dev/null
git reset -q --hard HEAD~1 2>/dev/null || true
unset CACHE_DIR

say "== FEATURE: live editor → Save → git commit (complete loop) =="
EPORT=$(( (RANDOM % 2000) + 34000 ))
DB_PATH="$SCRATCH/platform.db" node server.mjs --port $EPORT > "$SCRATCH/ed.log" 2>&1 &
EPID=$!
sleep 1.5
ETOK=$(mint $EPORT)
curl -s "localhost:$EPORT/edit/ember?raw" > "$SCRATCH/live-editor.html"
grep -q "saveToServer" "$SCRATCH/live-editor.html" && grep -q '"live_slug": "ember"' "$SCRATCH/live-editor.html" \
  && ok "GET /edit/ember serves live editor with Save wired" || bad "live editor page"
# simulate exactly what the Save button does
BEFORE_SHA=$(git rev-parse --short HEAD)
node -e "
const cards = JSON.parse(require('fs').readFileSync('examples/ember/components/cards.json','utf8'));
cards.find(c=>c.id==='twin_flame').attributes.cost = 3;
fetch('http://localhost:$EPORT/api/games/ember/cards',{method:'PUT',
  headers:{'content-type':'application/json','Authorization':'Bearer $ETOK'}, body:JSON.stringify(cards)})
  .then(r=>r.json()).then(d=>{
    if(!(d.saved && d.commit && /Twin Flame/.test(d.message))) process.exit(1);
    console.log('commit:', d.commit, '—', d.message);
  }).catch(()=>process.exit(1))" && ok "Save button flow → commit w/ auto message" || bad "save flow"
AFTER_SHA=$(git rev-parse --short HEAD)
[ "$BEFORE_SHA" != "$AFTER_SHA" ] && git log -1 --format=%b | grep -q "Twin Flame" \
  && ok "commit landed in history, body names the card" || bad "commit in history"
# editor page rebuilds with fresh data after the commit (cache invalidation)
curl -s "localhost:$EPORT/edit/ember?raw" | grep -q '"cost": 3' && ok "editor page reflects committed change (cache invalidated)" || bad "editor cache invalidation"
# invalid save via the same path → 422, nothing committed
node -e "
const cards = JSON.parse(require('fs').readFileSync('examples/ember/components/cards.json','utf8'));
cards[0].attributes.cost = 'NaN-ish';
fetch('http://localhost:$EPORT/api/games/ember/cards',{method:'PUT',
  headers:{'content-type':'application/json','Authorization':'Bearer $ETOK'}, body:JSON.stringify(cards)})
  .then(r=>process.exit(r.status===422?0:1)).catch(()=>process.exit(1))" \
  && [ "$(git rev-parse --short HEAD)" = "$AFTER_SHA" ] \
  && ok "invalid save → 422 toast path, history untouched" || bad "invalid save"
kill $EPID 2>/dev/null
git reset -q --hard $BEFORE_SHA 2>/dev/null || true

say "== FEATURE: hub auth UI + live stars =="
HPORT=$(( (RANDOM % 2000) + 36000 ))
DB_PATH="$SCRATCH/platform.db" node server.mjs --port $HPORT > "$SCRATCH/hub2.log" 2>&1 &
HPID=$!
sleep 2
curl -s "localhost:$HPORT/" > "$SCRATCH/live-hub.html"
grep -q "authModal" "$SCRATCH/live-hub.html" && grep -q "toggleStar" "$SCRATCH/live-hub.html" \
  && grep -q "refreshLive" "$SCRATCH/live-hub.html" && ok "live hub ships auth modal + star wiring" || bad "hub auth UI markers"
grep -q "liveSuggestions" "$SCRATCH/live-hub.html" && grep -q "proposePr" "$SCRATCH/live-hub.html" \
  && grep -q "mergePr" "$SCRATCH/live-hub.html" && ok "live hub ships PR review+merge wiring" || bad "hub PR wiring"
grep -q "function play(g)" "$SCRATCH/live-hub.html" && grep -q "_pshuffle" "$SCRATCH/live-hub.html" && ok "live hub ships the Play tab (seeded deterministic draw)" || bad "hub play wiring"
grep -q "liveAnalytics" "$SCRATCH/live-hub.html" && grep -q "liveReleases" "$SCRATCH/live-hub.html" && grep -q "loadFeed" "$SCRATCH/live-hub.html" && ok "live hub ships analytics + releases + activity feed wiring" || bad "hub round-2/3 wiring"
grep -q "openEditor" "$SCRATCH/live-hub.html" && grep -q "ed-canvas" "$SCRATCH/live-hub.html" \
  && grep -q "edPreview" "$SCRATCH/live-hub.html" && grep -q "edCommit" "$SCRATCH/live-hub.html" \
  && ok "live hub ships the IN-HUB card editor (drawer + live canvas preview + commit/propose)" || bad "hub editor wiring"
grep -q "liveIssues" "$SCRATCH/live-hub.html" && grep -q "commentThread" "$SCRATCH/live-hub.html" \
  && grep -q "commentPr" "$SCRATCH/live-hub.html" && ok "live hub ships Issues tab + comment threads (issues & PRs)" || bad "hub issues wiring"
grep -q "EDITABLE_TABS" "$SCRATCH/live-hub.html" && grep -q "rulesEdit" "$SCRATCH/live-hub.html" \
  && grep -q "g/\${g.slug}/cards/edit" "$SCRATCH/live-hub.html" && ok "hub: editing is a routed mode (#/g/:slug/:tab/edit) for cards AND rules" || bad "hub edit routing"
grep -q "exportMenu" "$SCRATCH/live-hub.html" && grep -q "Tabletop Club" "$SCRATCH/live-hub.html" \
  && ok "live hub Export offers Tabletop Club / TTS / PnP downloads" || bad "hub export wiring"
grep -q "Create my edition" "$SCRATCH/live-hub.html" && grep -q "Nothing is sent upstream" "$SCRATCH/live-hub.html" \
  && grep -q "Your independent edition" "$SCRATCH/live-hub.html" && grep -q "Propose upstream" "$SCRATCH/live-hub.html" \
  && ok "north-star UI: exact-version edition is independent; upstream proposal stays optional" || bad "north-star edition UI"
# the exact sequence the UI runs: register → star → counts reflect → unstar
node -e "
(async () => {
  const base='http://localhost:$HPORT';
  const reg=await (await fetch(base+'/api/auth/register',{method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({handle:'hubuser',email:'h@x.co',password:'longenough1'})})).json();
  const H={Authorization:'Bearer '+reg.token};
  const s1=await (await fetch(base+'/api/stars/ember',{method:'PUT',headers:H})).json();
  if(!(s1.starred&&s1.stars>=1)) process.exit(1);
  const me=await (await fetch(base+'/api/me',{headers:H})).json();
  if(!me.starred.includes('ember')) process.exit(1);
  const games=await (await fetch(base+'/api/games')).json();
  const ember=games.find(g=>g.slug==='ember');
  if(ember.stars<1) process.exit(1);
  const s0=await (await fetch(base+'/api/stars/ember',{method:'DELETE',headers:H})).json();
  if(s0.starred!==false) process.exit(1);
  console.log('UI sequence: register→star→me→counts→unstar all coherent');
})().catch(()=>process.exit(1))" && ok "star UI sequence end-to-end vs live API" || bad "star UI sequence"
kill $HPID 2>/dev/null

say "== FEATURE: one-click fork with attribution =="
FPORT=$(( (RANDOM % 2000) + 38000 ))
DB_PATH="$SCRATCH/platform.db" node server.mjs --port $FPORT > "$SCRATCH/fork2.log" 2>&1 &
FPID=$!
sleep 1.5
node -e "
(async () => {
  const base='http://localhost:$FPORT';
  const reg=await (await fetch(base+'/api/auth/register',{method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({handle:'forker',email:'f@x.co',password:'longenough1'})})).json();
  const H={Authorization:'Bearer '+reg.token,'content-type':'application/json'};
  const noauth=await fetch(base+'/api/games/ember/fork',{method:'POST'});
  if(noauth.status!==401) process.exit(1);
  const oldCards=await (await fetch(base+'/api/games/ember/cards')).json();
  const hist=await (await fetch(base+'/api/games/ember/history')).json();
  const pinned=hist[0]&&hist[0].sha;
  if(!pinned) process.exit(5);
  const changed=JSON.parse(JSON.stringify(oldCards)); changed[0].text+=' LATER SOURCE EDIT';
  const edit=await fetch(base+'/api/games/ember/cards',{method:'PUT',headers:H,body:JSON.stringify(changed)});
  if(edit.status!==200) process.exit(6);
  const f=await (await fetch(base+'/api/games/ember/fork',{method:'POST',headers:H,body:JSON.stringify({ref:pinned})})).json();
  if(!(f.slug==='ember-forker' && f.forked_from==='ember' && f.commit && f.source_ref===pinned)) process.exit(2);
  const forkCards=await (await fetch(base+'/api/games/ember-forker/cards')).json();
  if(forkCards[0].text!==oldCards[0].text || forkCards[0].text.includes('LATER SOURCE EDIT')) process.exit(7);
  const again=await fetch(base+'/api/games/ember/fork',{method:'POST',headers:H});
  if(again.status!==409 || !(await again.json()).existing) process.exit(3);
  const games=await (await fetch(base+'/api/games')).json();
  const fk=games.find(g=>g.slug==='ember-forker');
  if(!(fk && fk.forked_from==='ember')) process.exit(4);
  console.log('exact fork:', f.slug, f.source_ref, f.commit);
})().catch(e=>{console.error(e);process.exit(9)})" && ok "fork flow: 401→auth→201→409 dup→indexed w/ forked_from" || bad "fork flow"
grep -q "attribution:" "$SCRATCH/examples/ember-forker/game.yaml" \
  && grep -q "source_id: ember" "$SCRATCH/examples/ember-forker/game.yaml" \
  && grep -q "source_ref:" "$SCRATCH/examples/ember-forker/game.yaml" \
  && grep -q "id: ember-forker" "$SCRATCH/examples/ember-forker/game.yaml" \
  && ok "fork's game.yaml: new id + exact source ref + SPEC §9 attribution" || bad "fork attribution yaml"
git log -1 --format='%an %s' | grep -q "forker fork: ember@.* → ember-forker" && ok "fork commit authored by the forker and pins its source" || bad "fork commit author"
python3 tools/validate.py "$SCRATCH/examples/ember-forker" >/dev/null 2>&1 && ok "fork validates as a complete game" || bad "fork validates"
curl -s "localhost:$FPORT/" | grep -q "ember-forker" && ok "hub rebake includes the fork" || bad "hub shows fork"
kill $FPID 2>/dev/null

say "== FEATURE: pull requests across forks (the remix loop) =="
PRPORT=$(( (RANDOM % 2000) + 36000 ))
DB_PATH="$SCRATCH/platform.db" node server.mjs --port $PRPORT > "$SCRATCH/pr.log" 2>&1 &
PRPID=$!
sleep 1.5
node -e "
(async () => {
  const base='http://localhost:$PRPORT';
  const j=(r)=>r.json();
  const reg=async(h)=>(await j(await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:h,email:h+'@x.co',password:'longenough1'})}))).token;
  const T1=await reg('prhost'), T2=await reg('prbuddy');
  const A=(t)=>({Authorization:'Bearer '+t,'content-type':'application/json'});
  const csv='name,type,text,cost\nSpark,unit,Deal 1.,1\nWall,unit,Block.,2';
  const host=await j(await fetch(base+'/api/games',{method:'POST',headers:A(T1),body:JSON.stringify({title:'Pr Demo',csv})}));
  if(host.slug!=='pr-demo') process.exit(1);
  const fk=await j(await fetch(base+'/api/games/pr-demo/fork',{method:'POST',headers:A(T2)}));
  if(fk.slug!=='pr-demo-prbuddy') process.exit(2);
  let cards=await j(await fetch(base+'/api/games/pr-demo-prbuddy/cards'));
  cards.find(c=>c.id==='spark').text='Deal 2.';
  const ed=await j(await fetch(base+'/api/games/pr-demo-prbuddy/cards',{method:'PUT',headers:A(T2),body:JSON.stringify(cards)}));
  if(!ed.saved) process.exit(3);
  const pr=await j(await fetch(base+'/api/games/pr-demo/prs',{method:'POST',headers:A(T2),body:JSON.stringify({from:'pr-demo-prbuddy',title:'Spark buff'})}));
  if(!(pr.id && pr.changes.some(c=>c.card==='spark'))) process.exit(4);
  if((await fetch(base+'/api/games/pr-demo/prs/'+pr.id+'/review',{method:'POST',headers:A(T2),body:JSON.stringify({verdict:'approve'})})).status!==403) process.exit(15);
  if((await fetch(base+'/api/games/pr-demo/prs/'+pr.id+'/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({verdict:'approve'})})).status!==401) process.exit(16);
  if((await fetch(base+'/api/games/pr-demo/prs/'+pr.id+'/review',{method:'POST',headers:A(T1),body:JSON.stringify({verdict:'nope'})})).status!==422) process.exit(19);
  const rv=await fetch(base+'/api/games/pr-demo/prs/'+pr.id+'/review',{method:'POST',headers:A(T1),body:JSON.stringify({verdict:'approve'})});
  if(rv.status!==201) process.exit(17);
  const det=await j(await fetch(base+'/api/games/pr-demo/prs/'+pr.id));
  if(!(det.reviews && det.reviews.some(x=>x.verdict==='approve' && x.reviewer_handle==='prhost'))) process.exit(18);
  if((await fetch(base+'/api/games/pr-demo/prs/'+pr.id+'/merge',{method:'POST',headers:A(T2)})).status!==403) process.exit(5);
  if((await fetch(base+'/api/games/pr-demo/prs/'+pr.id+'/merge',{method:'POST'})).status!==401) process.exit(6);
  const m=await j(await fetch(base+'/api/games/pr-demo/prs/'+pr.id+'/merge',{method:'POST',headers:A(T1)}));
  if(!(m.merged && m.commit)) process.exit(7);
  const after=await j(await fetch(base+'/api/games/pr-demo/cards'));
  if(after.find(c=>c.id==='spark').text!=='Deal 2.') process.exit(8);
  const st=await j(await fetch(base+'/api/games/pr-demo/prs/'+pr.id));
  if(st.status!=='merged') process.exit(10);
  if((await fetch(base+'/api/games/pr-demo/prs/'+pr.id+'/merge',{method:'POST',headers:A(T1)})).status!==409) process.exit(11);
  cards=await j(await fetch(base+'/api/games/pr-demo-prbuddy/cards'));
  cards.find(c=>c.id==='wall').text='Block 2.';
  await fetch(base+'/api/games/pr-demo-prbuddy/cards',{method:'PUT',headers:A(T2),body:JSON.stringify(cards)});
  const pr2=await j(await fetch(base+'/api/games/pr-demo/prs',{method:'POST',headers:A(T2),body:JSON.stringify({from:'pr-demo-prbuddy',title:'Wall buff'})}));
  let host2=await j(await fetch(base+'/api/games/pr-demo/cards'));
  host2.find(c=>c.id==='wall').text='Block 3.';
  await fetch(base+'/api/games/pr-demo/cards',{method:'PUT',headers:A(T1),body:JSON.stringify(host2)});
  const cm=await fetch(base+'/api/games/pr-demo/prs/'+pr2.id+'/merge',{method:'POST',headers:A(T1)});
  if(cm.status!==409) process.exit(12);
  const cj=await cm.json();
  if(!(cj.conflicts||[]).includes('wall')) process.exit(13);
  const list=await j(await fetch(base+'/api/games/pr-demo/prs'));
  if(!(list.length===2 && list.some(x=>x.status==='merged') && list.some(x=>x.status==='open'))) process.exit(14);
  console.log('pr flow complete');
})().catch(e=>{console.error(e);process.exit(9)})" && ok "PR flow: open → review (401 anon/403 non-maintainer/422 bad verdict/owner approves) → owner merges → change applied → 409 on re-merge" || bad "PR flow"
git log -5 --format='%an|%s' | grep -q "prbuddy|merge: Spark buff" && ok "merge commit AUTHORED AS THE PROPOSER (credit follows the work)" || bad "merge authorship"
git log -5 --format='%b' | grep -q "merged-by: prhost" && ok "merge trailer records merged-by (owner accountability)" || bad "merged-by trailer"
node -e "process.exit(0)" && python3 tools/validate.py "$SCRATCH/examples/pr-demo" >/dev/null 2>&1 && ok "post-merge game still validates" || bad "post-merge validation"
kill $PRPID 2>/dev/null

say "== ACCESS CONTROL: owner/collaborator matrix + edit-as-PR =="
AZPORT=$(( (RANDOM % 2000) + 32000 ))
DB_PATH="$SCRATCH/platform.db" node server.mjs --port $AZPORT > "$SCRATCH/az.log" 2>&1 &
AZPID=$!
sleep 1.5
node -e "
(async () => {
  const base='http://localhost:$AZPORT';
  const j=(r)=>r.json();
  const reg=async(h)=>(await j(await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:h,email:h+'@x.co',password:'longenough1'})}))).token;
  const A=(t)=>({Authorization:'Bearer '+t,'content-type':'application/json'});
  const TD=await reg('dana'), TC=await reg('carol');
  const host=await j(await fetch(base+'/api/games',{method:'POST',headers:A(TD),body:JSON.stringify({title:'Az Demo',csv:'name,type,text,cost\\nBolt,spell,Zap.,1\\nShield,gear,Guard.,2'})}));
  if(host.slug!=='az-demo') process.exit(1);
  const cards=await j(await fetch(base+'/api/games/az-demo/cards'));
  cards[0].text='Zap 2.';
  // access endpoint drives the editor's commit-vs-propose choice
  const accO=await j(await fetch(base+'/api/games/az-demo/access',{headers:A(TD)}));
  if(!(accO.canWrite===true && accO.isOwner===true)) process.exit(20);
  const accC=await j(await fetch(base+'/api/games/az-demo/access',{headers:A(TC)}));
  if(accC.canWrite!==false) process.exit(21);
  // carol (no access) direct commit → 403 + propose flag
  const c403=await fetch(base+'/api/games/az-demo/cards',{method:'PUT',headers:A(TC),body:JSON.stringify(cards)});
  if(c403.status!==403 || !(await j(c403)).propose) process.exit(2);
  // carol proposes instead → auto-fork + PR
  const prop=await j(await fetch(base+'/api/games/az-demo/cards/propose',{method:'POST',headers:A(TC),body:JSON.stringify({cards,title:'Bolt buff'})}));
  if(!(prop.proposed && prop.pr && prop.fork==='az-demo-carol')) process.exit(3);
  const prs=await j(await fetch(base+'/api/games/az-demo/prs'));
  if(!(prs.length===1 && prs[0].author_handle==='carol' && prs[0].from_slug==='az-demo-carol')) process.exit(4);
  // dana merges carol's proposal
  const m=await j(await fetch(base+'/api/games/az-demo/prs/'+prop.pr+'/merge',{method:'POST',headers:A(TD)}));
  if(!m.merged) process.exit(5);
  const after=await j(await fetch(base+'/api/games/az-demo/cards'));
  if(after[0].text!=='Zap 2.') process.exit(6);
  // collaborator lifecycle: grant → direct commit OK → revoke → 403 again
  const g=await fetch(base+'/api/games/az-demo/collaborators/carol',{method:'PUT',headers:A(TD)});
  if(g.status!==200) process.exit(7);
  after[1].text='Guard 2.';
  const direct=await fetch(base+'/api/games/az-demo/cards',{method:'PUT',headers:A(TC),body:JSON.stringify(after)});
  if(direct.status!==200) process.exit(8);
  // non-owner cannot manage access
  if((await fetch(base+'/api/games/az-demo/collaborators/dana',{method:'PUT',headers:A(TC)})).status!==403) process.exit(9);
  const r=await fetch(base+'/api/games/az-demo/collaborators/carol',{method:'DELETE',headers:A(TD)});
  if(r.status!==200) process.exit(10);
  const again=await fetch(base+'/api/games/az-demo/cards',{method:'PUT',headers:A(TC),body:JSON.stringify(cards)});
  if(again.status!==403) process.exit(11);
  console.log('authz matrix complete');
})().catch(e=>{console.error(e);process.exit(12)})" && ok "authz: 403+propose → auto-fork PR → merge → grant → direct commit → revoke → 403" || bad "authz matrix"
git log -8 --format='%an|%s' | grep -q "carol|cards: changed 1 card" && ok "carol's proposal commit authored as carol in HER fork" || bad "propose authorship"
kill $AZPID 2>/dev/null

say "== FEATURE: issues + threaded comments (the community layer) =="
ISPORT=$(( (RANDOM % 2000) + 30000 ))
DB_PATH="$SCRATCH/platform.db" node server.mjs --port $ISPORT > "$SCRATCH/iss.log" 2>&1 &
ISPID=$!
sleep 1.5
node -e "
(async () => {
  const base='http://localhost:$ISPORT';
  const j=(r)=>r.json();
  const reg=async(h)=>(await j(await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:h,email:h+'@x.co',password:'longenough1'})}))).token;
  const A=(t)=>({Authorization:'Bearer '+t,'content-type':'application/json'});
  const OWN=await reg('issowner'), REP=await reg('reporter'), OTH=await reg('bystander');
  const host=await j(await fetch(base+'/api/games',{method:'POST',headers:A(OWN),body:JSON.stringify({title:'Iss Demo',csv:'name,type,text,cost\\nBolt,spell,Zap.,1'})}));
  if(host.slug!=='iss-demo') process.exit(1);
  if((await fetch(base+'/api/games/iss-demo/issues',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'x'})})).status!==401) process.exit(2);
  const iss=await j(await fetch(base+'/api/games/iss-demo/issues',{method:'POST',headers:A(REP),body:JSON.stringify({title:'Bolt too cheap',body:'1/1 feels low'})}));
  if(!(iss.number===1 && iss.status==='open')) process.exit(3);
  const iss2=await j(await fetch(base+'/api/games/iss-demo/issues',{method:'POST',headers:A(OTH),body:JSON.stringify({title:'typo'})}));
  if(iss2.number!==2) process.exit(4);
  const list=await j(await fetch(base+'/api/games/iss-demo/issues'));
  if(!(list.length===2 && list[0].number===2 && list.find(i=>i.number===1).author_handle==='reporter')) process.exit(5);
  await fetch(base+'/api/games/iss-demo/issues/1/comments',{method:'POST',headers:A(OWN),body:JSON.stringify({body:'Good catch, bumping to 2.'})});
  const c=await j(await fetch(base+'/api/games/iss-demo/issues/1/comments',{method:'POST',headers:A(REP),body:JSON.stringify({body:'thanks!'})}));
  if(!(c.comments.length===2 && c.comments[1].author_handle==='reporter')) process.exit(6);
  const det=await j(await fetch(base+'/api/games/iss-demo/issues/1'));
  if(!(det.title==='Bolt too cheap' && det.comments.length===2 && det.status==='open')) process.exit(7);
  if((await fetch(base+'/api/games/iss-demo/issues/1/close',{method:'POST',headers:A(OTH)})).status!==403) process.exit(8);
  const cl=await j(await fetch(base+'/api/games/iss-demo/issues/1/close',{method:'POST',headers:A(REP)}));
  if(cl.status!=='closed') process.exit(9);
  const cl2=await j(await fetch(base+'/api/games/iss-demo/issues/2/close',{method:'POST',headers:A(OWN)}));
  if(cl2.status!=='closed') process.exit(10);
  await fetch(base+'/api/games/iss-demo/fork',{method:'POST',headers:A(REP)});
  let cards=await j(await fetch(base+'/api/games/iss-demo-reporter/cards'));
  cards[0].attributes={cost:2}; cards[0].text='Zap harder.';
  await fetch(base+'/api/games/iss-demo-reporter/cards',{method:'PUT',headers:A(REP),body:JSON.stringify(cards)});
  const pr=await j(await fetch(base+'/api/games/iss-demo/prs',{method:'POST',headers:A(REP),body:JSON.stringify({from:'iss-demo-reporter',title:'Bolt to 2'})}));
  const pc=await j(await fetch(base+'/api/games/iss-demo/prs/'+pr.id+'/comments',{method:'POST',headers:A(OWN),body:JSON.stringify({body:'LGTM, merging.'})}));
  if(pc.comments.length!==1) process.exit(11);
  const prd=await j(await fetch(base+'/api/games/iss-demo/prs/'+pr.id));
  if(!(prd.comments && prd.comments.length===1 && prd.comments[0].author_handle==='issowner')) process.exit(12);
  console.log('issues+comments complete');
})().catch(e=>{console.error(e);process.exit(13)})" && ok "issues: 401 gate -> open -> number-per-game -> thread -> author/owner close (403 for others)" || bad "issues flow"
kill $ISPID 2>/dev/null

say "== FEATURE: Google Sheets working copy → reviewed game candidate =="
SYNCPORT=$(( (RANDOM % 1500) + 41000 ))
SHEETPORT=$(( SYNCPORT + 2000 ))
node tools/sheet-mock.mjs --port $SHEETPORT > "$SCRATCH/sheet-mock.log" 2>&1 &
SHEETPID=$!
DB_PATH="$SCRATCH/sheet-sync.db" CACHE_DIR="$SCRATCH/sheet-sync-cache" \
  node server.mjs --port $SYNCPORT > "$SCRATCH/sheet-sync-server.log" 2>&1 &
SYNCPID=$!
sleep 1.5
if node tools/sync-check.mjs "http://127.0.0.1:$SYNCPORT" "http://127.0.0.1:$SHEETPORT/sheet.csv" > "$SCRATCH/sheet-sync-check.log" 2>&1; then
  ok "Sheets: stable ids → candidate token → validation/render payload → three-way merge → stale-review guards → all exports"
else
  bad "Sheets reviewed-candidate connector" "$(tail -1 "$SCRATCH/sheet-sync-check.log")"
fi
if node tools/sheets-addon-check.mjs "http://127.0.0.1:$SYNCPORT" > "$SCRATCH/sheets-addon-check.log" 2>&1; then
  ok "actual Code.gs: sign in → attach private tab → dirty hint → check → exact candidate commit"
else
  bad "Google Sheets Apps Script connector" "$(tail -1 "$SCRATCH/sheets-addon-check.log")"
fi
kill $SYNCPID $SHEETPID 2>/dev/null

say ""
say "(perf: run ./perf.sh separately)"

say ""
say "=================================================="
say "e2e: $PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
  for f in "${FAILED[@]}"; do say "  ✗ $f"; done
  exit 1
fi
say "ALL GREEN — the loop is real."
