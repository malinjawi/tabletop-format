#!/usr/bin/env python3
"""check_deck.py - deck legality checker, format v0.1.
Usage: python3 tools/check_deck.py <game-dir> <deck.json> [--format <format_id>]

Enforces, in order:
  1. deck schema + every card exists
  2. format card pool: each card must have >=1 printing in a pool set
  3. deck_rules min/max size
  4. per-card deck_limit
  5. active restriction: banned cards illegal; restricted cards limited to 1
This is the NSG/LCG stewardship loop as running code: publish a dated
restriction document, and every deck in the community can re-check itself.
"""
import json, sys
from pathlib import Path
import yaml

args = sys.argv[1:]
if len(args) < 2:
    sys.exit("Usage: python3 tools/check_deck.py <game-dir> <deck.json> [--format <id>]")
game_dir, deck_path = Path(args[0]), Path(args[1])
fmt_override = args[args.index("--format") + 1] if "--format" in args else None

def load_dir(d):
    p = game_dir / d
    if not p.is_dir(): return []
    out = []
    for f in sorted(p.iterdir()):
        if f.suffix in (".yaml", ".yml", ".json"):
            doc = yaml.safe_load(f.read_text())
            out.extend(doc if isinstance(doc, list) else [doc])
    return out

deck = json.loads(deck_path.read_text())
cards = {c["id"]: c for c in json.loads((game_dir / "components/cards.json").read_text())}
printings = json.loads((game_dir / "components/printings.json").read_text())
formats = {f["id"]: f for f in load_dir("formats")}
restrictions = {r["id"]: r for r in load_dir("restrictions")}

errors, warnings = [], []
fmt_id = fmt_override or deck.get("format_id")
fmt = formats.get(fmt_id)
if fmt_id and not fmt:
    errors.append(f"format '{fmt_id}' not found")

# 1. cards exist
for cid in deck["cards"]:
    if cid not in cards:
        errors.append(f"unknown card '{cid}'")

total = sum(deck["cards"].values())
print(f"Deck: {deck['name']}  ({total} cards)")
print(f"Format: {fmt['name'] if fmt else '(none — limits only)'}")

if fmt:
    # 2. card pool
    pool_sets = set(fmt["card_pool"])
    in_pool = {p["card_id"] for p in printings if p["set_id"] in pool_sets}
    for cid in deck["cards"]:
        if cid in cards and cid not in in_pool:
            errors.append(f"'{cards[cid]['name']}' has no printing in the {fmt_id} card pool")
    # 3. size
    rules = fmt.get("deck_rules") or {}
    if rules.get("min_size") and total < rules["min_size"]:
        errors.append(f"deck has {total} cards; format minimum is {rules['min_size']}")
    if rules.get("max_size") and total > rules["max_size"]:
        errors.append(f"deck has {total} cards; format maximum is {rules['max_size']}")
    # 5. restriction
    r = restrictions.get(fmt.get("active_restriction_id") or "")
    if r:
        print(f"Restriction: {r.get('name', r['id'])} (from {r.get('date_start')})")
        for cid in deck["cards"]:
            if cid in (r.get("banned") or []):
                errors.append(f"'{cards[cid]['name']}' is BANNED in {fmt_id}")
            if cid in (r.get("restricted") or []) and deck["cards"][cid] > 1:
                errors.append(f"'{cards[cid]['name']}' is RESTRICTED to 1 copy; deck has {deck['cards'][cid]}")

# 4. deck_limit (applies with or without a format)
for cid, n in deck["cards"].items():
    c = cards.get(cid)
    if c and c.get("deck_limit") is not None and n > c["deck_limit"]:
        errors.append(f"'{c['name']}' deck_limit is {c['deck_limit']}; deck has {n}")

for e in errors:   print(f"  ILLEGAL  {e}")
for w in warnings: print(f"  warn     {w}")
if errors:
    print(f"\nILLEGAL — {len(errors)} violation(s)"); sys.exit(1)
print("\nLEGAL")
