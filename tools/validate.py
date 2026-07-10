#!/usr/bin/env python3
"""validate.py - Python twin of validate.mjs (format v0.1).
Usage: python3 tools/validate.py <game-directory>
Pass 1: JSON Schema validation. Pass 2: referential integrity + typed attributes.
"""
import json, re, sys
from pathlib import Path

import yaml
import jsonschema

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas"
BASE = "https://spec.example.dev/schemas/"

game_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
if not game_dir:
    sys.exit("Usage: python3 tools/validate.py <game-directory>")

schemas = {f.name: json.loads(f.read_text()) for f in SCHEMA_DIR.glob("*.schema.json")}
store = {s["$id"]: s for s in schemas.values()}
# Draft-07 engine fallback (our v0.1 schemas use only draft-07-compatible features).
validators = {}
for name, s in schemas.items():
    resolver = jsonschema.RefResolver(base_uri=s["$id"], referrer=s, store=store)
    validators[name.replace(".schema.json", "")] = jsonschema.Draft7Validator(s, resolver=resolver)

errors, warnings = [], []
err, warn = errors.append, warnings.append

def load(rel):
    p = game_dir / rel
    if not p.exists():
        return None
    return json.loads(p.read_text()) if p.suffix == ".json" else yaml.safe_load(p.read_text())

def load_dir(d):
    p = game_dir / d
    if not p.is_dir():
        return []
    out = []
    for f in sorted(p.iterdir()):
        if f.suffix in (".yaml", ".yml", ".json"):
            doc = load(Path(d) / f.name)
            out.extend(doc if isinstance(doc, list) else [doc])
    return out

def check(kind, doc, label):
    for e in validators[kind].iter_errors(doc):
        err(f"{label}: /{'/'.join(map(str, e.path))} {e.message}")

print(f"Validating {game_dir}\n")

game = load("game.yaml")
if game is None:
    sys.exit("ERROR: game.yaml missing")
check("game", game, "game.yaml")

cards = load("components/cards.json") or []
for i, c in enumerate(cards): check("card", c, f"cards[{i}] ({c.get('id','?')})")
printings = load("components/printings.json") or []
for i, p in enumerate(printings): check("printing", p, f"printings[{i}] ({p.get('id','?')})")
sets_ = load_dir("sets")
for i, s in enumerate(sets_): check("set", s, f"sets[{i}] ({s.get('id','?')})")
formats = load_dir("formats")
for i, f in enumerate(formats): check("format", f, f"formats[{i}] ({f.get('id','?')})")
restrictions = load_dir("restrictions")
for i, r in enumerate(restrictions): check("restriction", r, f"restrictions[{i}] ({r.get('id','?')})")
rulings = load("rulings/rulings.json") or []
for i, r in enumerate(rulings): check("ruling", r, f"rulings[{i}]")
decks = load_dir("decks")
for i, d in enumerate(decks): check("deck", d, f"decks[{i}] ({d.get('id','?')})")
tokens = load("components/tokens.json") or []
for i, t in enumerate(tokens): check("token", t, f"tokens[{i}] ({t.get('id','?')})")
playtests = load_dir("playtests")
for i, s in enumerate(playtests): check("playtest", s, f"playtests[{i}] ({s.get('id','?')})")

# Pass 2
def dupes(arr, label):
    seen = set()
    for x in arr:
        if x["id"] in seen: err(f"duplicate {label} id '{x['id']}'")
        seen.add(x["id"])
for arr, label in [(cards,"card"),(printings,"printing"),(sets_,"set"),(formats,"format"),(restrictions,"restriction")]:
    dupes(arr, label)

card_ids = {c["id"] for c in cards}
set_ids = {s["id"] for s in sets_}
restriction_ids = {r["id"] for r in restrictions}

for p in printings:
    if p["card_id"] not in card_ids: err(f"printing '{p['id']}': card_id '{p['card_id']}' not found")
    if p["set_id"] not in set_ids: err(f"printing '{p['id']}': set_id '{p['set_id']}' not found")
for f in formats:
    for s in f["card_pool"]:
        if s not in set_ids: err(f"format '{f['id']}': card_pool set '{s}' not found")
    ar = f.get("active_restriction_id")
    if ar and ar not in restriction_ids: err(f"format '{f['id']}': restriction '{ar}' not found")
for r in restrictions:
    for c in (r.get("banned") or []) + (r.get("restricted") or []):
        if c not in card_ids: err(f"restriction '{r['id']}': card '{c}' not found")
for i, r in enumerate(rulings):
    if r["card_id"] not in card_ids: err(f"ruling[{i}]: card '{r['card_id']}' not found")
format_ids = {f["id"] for f in formats}
for d in decks:
    for cid in d.get("cards", {}):
        if cid not in card_ids: err(f"deck '{d['id']}': card '{cid}' not found")
    if d.get("format_id") and d["format_id"] not in format_ids:
        err(f"deck '{d['id']}': format '{d['format_id']}' not found")

defs = {d["key"]: d for d in game.get("attribute_definitions") or []}
TYPES = {"integer": int, "number": (int, float), "string": str, "boolean": bool}
for c in cards:
    for k, v in (c.get("attributes") or {}).items():
        d = defs.get(k)
        if not d:
            warn(f"card '{c['id']}': attribute '{k}' not declared in game.yaml"); continue
        ok = isinstance(v, TYPES[d["type"]]) and not (d["type"] in ("integer","number") and isinstance(v, bool))
        if not ok: err(f"card '{c['id']}': attribute '{k}' should be {d['type']}, got {type(v).__name__} ({v!r})")
    for d in defs.values():
        if d.get("required") and d["key"] not in (c.get("attributes") or {}):
            err(f"card '{c['id']}': missing required attribute '{d['key']}'")

declared_symbols = {s["key"] for s in game.get("symbols") or []}
for c in cards:
    for m in re.finditer(r"\[([a-z0-9_]+)\]", c.get("text") or ""):
        if m.group(1) not in declared_symbols:
            warn(f"card '{c['id']}': text uses undeclared symbol [{m.group(1)}]")
dupes(tokens, "token")
for t in tokens:
    if t.get("symbol") and t["symbol"] not in declared_symbols:
        err(f"token '{t['id']}': symbol '{t['symbol']}' not declared in game.yaml")
deck_ids = {d["id"] for d in decks}
for s in playtests:
    for n in s.get("card_notes") or []:
        if n["card_id"] not in card_ids:
            err(f"playtest '{s['id']}': card_note references unknown card '{n['card_id']}'")
    for d in s.get("decisions") or []:
        if d.get("card_id") and d["card_id"] not in card_ids:
            err(f"playtest '{s['id']}': decision references unknown card '{d['card_id']}'")
    for p in s.get("players") or []:
        if p.get("deck_id") and p["deck_id"] not in deck_ids:
            warn(f"playtest '{s['id']}': player deck '{p['deck_id']}' not found in decks/")

for s in sets_:
    if s.get("size") is not None:
        actual = sum(1 for p in printings if p["set_id"] == s["id"])
        if actual != s["size"]: warn(f"set '{s['id']}': declares size {s['size']}, has {actual} printings")

for e in errors: print(f"  ERROR  {e}")
for w in warnings: print(f"  warn   {w}")
print(f"\n{len(cards)} cards, {len(printings)} printings, {len(sets_)} sets, "
      f"{len(formats)} formats, {len(restrictions)} restrictions, {len(rulings)} rulings")
if errors:
    print(f"\nFAIL — {len(errors)} error(s), {len(warnings)} warning(s)"); sys.exit(1)
print(f"\nOK — 0 errors, {len(warnings)} warning(s)")
