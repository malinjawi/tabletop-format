#!/usr/bin/env python3
"""check_jam.py - jam entry qualifier ("fmt jam-check"), format v0.1.
Usage: python3 tools/check_jam.py <game-dir> <jam.yaml>

Constraints are DATA (jam.schema.json), so "does my entry qualify" is a
command, not a moderator ruling. Checks the jam file against its schema,
then the game against the jam's constraints.
"""
import json, sys
from pathlib import Path
import yaml
import jsonschema

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas"

args = sys.argv[1:]
if len(args) < 2: sys.exit("Usage: python3 tools/check_jam.py <game-dir> <jam.yaml>")
game_dir, jam_path = Path(args[0]), Path(args[1])

jam = yaml.safe_load(jam_path.read_text())
schema = json.loads((SCHEMA_DIR / "jam.schema.json").read_text())
errors = []
try:
    jsonschema.Draft7Validator(schema).validate(jam)
except jsonschema.ValidationError as e:
    sys.exit(f"jam file invalid: {e.message}")

game = yaml.safe_load((game_dir / "game.yaml").read_text())
cards = json.loads((game_dir / "components/cards.json").read_text())
printings = json.loads((game_dir / "components/printings.json").read_text())
c = jam.get("constraints") or {}

print(f"Entry check: {game.get('title')} → {jam['title']} (theme: {jam['theme']})")

if c.get("max_cards") is not None and len(cards) > c["max_cards"]:
    errors.append(f"{len(cards)} unique cards; jam max is {c['max_cards']}")
if c.get("min_cards") is not None and len(cards) < c["min_cards"]:
    errors.append(f"{len(cards)} unique cards; jam min is {c['min_cards']}")
deck_size = sum(p.get("quantity", 1) for p in printings)
if c.get("max_deck_size") is not None and deck_size > c["max_deck_size"]:
    errors.append(f"{deck_size} physical cards; jam max is {c['max_deck_size']}")
if c.get("required_license"):
    if game.get("license") not in c["required_license"]:
        errors.append(f"license '{game.get('license')}' not in jam's allowed list: {', '.join(c['required_license'])}")
if c.get("theme_word_required"):
    theme = jam["theme"].lower()
    hay = (game.get("title", "") + " " + game.get("description", "")).lower()
    hay += " ".join((x.get("name", "") + " " + x.get("text", "")).lower() for x in cards)
    rules = game_dir / "rules" / "rules.md"
    if rules.exists(): hay += rules.read_text().lower()
    if theme not in hay:
        errors.append(f"theme word '{jam['theme']}' not found in title, cards, or rules")

for e in errors: print(f"  NOT QUALIFIED  {e}")
if errors:
    print(f"\nNOT QUALIFIED — {len(errors)} issue(s)"); sys.exit(1)
print(f"\nQUALIFIED — {len(cards)} cards, {deck_size} physical, license {game.get('license')}")
if c.get("notes"): print(f"Human-judged rules still apply: {c['notes'].strip()}")
