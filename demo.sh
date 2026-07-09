#!/usr/bin/env bash
# demo.sh — the Phase 0 "wow demo" in one command.
# Spreadsheet -> game -> validate -> render -> PnP PDF + TTS mod -> balance patch -> semantic diff
set -e
cd "$(dirname "$0")"

echo "=== 1. Import a designer's spreadsheet (30 seconds to migrate) ==="
node tools/import-csv.mjs examples/harbor-nine.csv examples/harbor-nine --title "Harbor Nine"

echo
echo "=== 2. Validate (schemas + referential integrity) ==="
python3 tools/validate.py examples/harbor-nine

echo
echo "=== 3. Render card faces ==="
python3 tools/render_cards.py examples/harbor-nine

echo
echo "=== 4. Export: print-and-play PDF + Tabletop Simulator mod ==="
python3 tools/export_pnp.py examples/harbor-nine
python3 tools/export_tts.py examples/harbor-nine

echo
echo "=== 5. Balance patch: nerf the Smuggler, buff the Skiff ==="
python3 - <<'EOF'
import json
cards = json.load(open('examples/harbor-nine/components/cards.json'))
for c in cards:
    if c['id'] == 'smuggler_s_sloop': c['attributes']['cost'] = 3
    if c['id'] == 'fishing_skiff':   c['text'] = 'Dawn: gain 2 cargo.'
json.dump(cards, open('/tmp/harbor-patched.json','w'), indent=2)
EOF

echo "=== 6. Semantic diff (this is the moment) ==="
node tools/diff.mjs examples/harbor-nine/components/cards.json /tmp/harbor-patched.json

echo
echo "Done. exports/ has the PDF and the TTS mod. Fork it. Compare it. Ship it."
