#!/usr/bin/env python3
"""check_licenses.py - license & provenance checker, format v0.1 (locked decisions D8/D11).
Usage: python3 tools/check_licenses.py <game-dir>

Publishing gate: a platform (or a careful human) runs this before a project
goes public. Errors block publishing; warnings demand a look.

Checks:
  - game license present, known, and deliberately chosen
  - imported content ('imported-see-source') never publishes as-is
  - every printing has resolvable provenance (own or game default)
  - AI/mixed assets declare the tool used; 'unknown' provenance flagged
  - remix attribution chain intact when attribution block present
  - NC-licensed source vs commercial red flags (heuristic)
"""
import json, sys
from pathlib import Path
import yaml

KNOWN_LICENSES = {
    "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0",
    "CC-BY-ND-4.0", "MIT", "Apache-2.0", "proprietary",
}
NC_LICENSES = {"CC-BY-NC-4.0", "CC-BY-NC-SA-4.0"}

game_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
if not game_dir:
    sys.exit("Usage: python3 tools/check_licenses.py <game-dir>")

errors, warnings = [], []
err, warn = errors.append, warnings.append

game = yaml.safe_load((game_dir / "game.yaml").read_text())
printings = json.loads((game_dir / "components/printings.json").read_text())
default_prov = game.get("default_provenance")

# --- game license ---
lic = (game.get("license") or "").strip()
if not lic:
    err("game.yaml: no license — choose one before publishing")
elif lic == "imported-see-source":
    err("license is 'imported-see-source' — imported content needs a deliberate "
        "licensing decision (and possibly the source community's/publisher's permission) before publishing")
elif lic not in KNOWN_LICENSES:
    warn(f"license '{lic}' is not a recognized SPDX/CC identifier — double-check it")

# --- attribution chain (remixes) ---
attr = game.get("attribution")
if attr:
    if not attr.get("source_license"):
        warn("attribution present but source_license missing — record what the original allowed")
    elif attr["source_license"] in NC_LICENSES and lic not in NC_LICENSES and lic != "proprietary":
        err(f"source was {attr['source_license']} (NonCommercial): this remix must also be NC")
    if attr.get("source_license", "").endswith("SA-4.0") and lic != attr.get("source_license"):
        err(f"source was ShareAlike ({attr['source_license']}): remix must carry the same license, got '{lic}'")

# --- provenance per printing ---
missing, unknown, ai_untooled = [], [], []
for p in printings:
    prov = p.get("provenance") or default_prov
    if not prov:
        missing.append(p["id"]); continue
    if prov.get("source") == "unknown":
        unknown.append(p["id"])
    if prov.get("source") in ("ai", "mixed") and not prov.get("ai_tool"):
        ai_untooled.append(p["id"])

if missing:
    err(f"{len(missing)} printing(s) with no provenance and no game default: {', '.join(missing[:5])}"
        + (" …" if len(missing) > 5 else ""))
if unknown:
    warn(f"{len(unknown)} printing(s) with 'unknown' provenance — resolve before publishing: "
         + ", ".join(unknown[:5]) + (" …" if len(unknown) > 5 else ""))
if ai_untooled:
    warn(f"{len(ai_untooled)} AI/mixed printing(s) missing ai_tool declaration: "
         + ", ".join(ai_untooled[:5]) + (" …" if len(ai_untooled) > 5 else ""))

# --- report ---
covered = len(printings) - len(missing)
print(f"License: {lic or '(none)'}")
if attr:
    print(f"Remix of: {attr.get('source_title')} ({attr.get('source_license', '?')})")
print(f"Provenance coverage: {covered}/{len(printings)} printings")
for e in errors:   print(f"  ERROR  {e}")
for w in warnings: print(f"  warn   {w}")
if errors:
    print(f"\nBLOCKED — {len(errors)} error(s), {len(warnings)} warning(s)"); sys.exit(1)
print(f"\nPUBLISHABLE — 0 errors, {len(warnings)} warning(s)")
