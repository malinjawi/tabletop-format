#!/usr/bin/env bash
# build_beta.sh — assemble the deployable public-beta site into beta-site/.
# Output is a plain static folder: drop it on GitHub Pages / Cloudflare Pages /
# any web server. No build tools needed to serve it.
set -e
cd "$(dirname "$0")"
OUT=beta-site
mkdir -p "$OUT"

echo "== building hub =="
python3 tools/build_hub.py -o "$OUT/hub.html"

echo "== building editors =="
python3 tools/build_editor.py examples/ember -o "$OUT/editor-ember.html"
python3 tools/build_editor.py examples/netrunner-urbp -o "$OUT/editor-netrunner.html"

echo "== rendering + exports (web-weight downloads; full 300dpi via CLI) =="
mkdir -p "$OUT/downloads"
for g in ember harbor-nine; do
  python3 tools/render_cards.py "examples/$g" >/dev/null
  python3 tools/export_pnp.py "examples/$g" --dpi 150 >/dev/null
  python3 tools/export_tts.py "examples/$g" >/dev/null
  cp "examples/$g/exports/$g-pnp.pdf" "$OUT/downloads/" 2>/dev/null || true
done
cp examples/ember/exports/tts/ember.json "$OUT/downloads/ember-tts.json" 2>/dev/null || true
# restore print-quality exports in the repo tree
for g in ember harbor-nine; do python3 tools/export_pnp.py "examples/$g" >/dev/null; done

echo "== landing page =="
cp beta/index.html "$OUT/index.html"

echo "== done =="
du -sh "$OUT" | awk '{print "beta-site: " $1}'
echo "Deploy: push this folder to a gh-pages branch, or point Cloudflare Pages at it."
echo "Remember: replace YOUR-ORG/YOUR-REPO links in index.html after you push."
