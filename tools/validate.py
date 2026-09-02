#!/usr/bin/env python3
"""validate.py - Python twin of validate.mjs (format v0.1).
Usage: python3 tools/validate.py <game-directory>
Pass 1: JSON Schema validation. Pass 2: referential integrity + typed attributes.
"""
import json, re, sys
from pathlib import Path

import yaml
import jsonschema

from card_design import MANIFEST as CARD_DESIGN_MANIFEST, card_matches_family
from design_engines import MANIFEST as DESIGN_ENGINES_MANIFEST, load_design_engines

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas"
BASE = "https://spec.example.dev/schemas/"
SOURCE_ASSETS_MANIFEST = "assets/manifest.json"
SOURCE_ASSET_ROOTS = {"assets", "templates", "rules", "setups", "boards", "components", "design"}

game_dir = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
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
setups = load_dir("setups")
for i, s in enumerate(setups): check("setup", s, f"setups[{i}] ({s.get('id','?')})")
tokens = load("components/tokens.json") or []
for i, t in enumerate(tokens): check("token", t, f"tokens[{i}] ({t.get('id','?')})")
playtests = load_dir("playtests")
for i, s in enumerate(playtests): check("playtest", s, f"playtests[{i}] ({s.get('id','?')})")
community = load("community.yaml")
if community is not None: check("community", community, "community.yaml")
rights_manifest = load("forge/rights.json")
if rights_manifest is not None: check("rights", rights_manifest, "forge/rights.json")
source_assets_manifest = load(SOURCE_ASSETS_MANIFEST)
if source_assets_manifest is not None:
    check("source-assets", source_assets_manifest, SOURCE_ASSETS_MANIFEST)
layout = load("templates/layout.yaml")
if layout is not None: check("layout", layout, "templates/layout.yaml")
card_design_manifest = load(CARD_DESIGN_MANIFEST)
design_engines_manifest = load(DESIGN_ENGINES_MANIFEST)
card_design = None
design_engines = None
pnpink_adapters = []
if design_engines_manifest is not None:
    check("design-engines", design_engines_manifest, DESIGN_ENGINES_MANIFEST)
if card_design_manifest is not None:
    check("card-design", card_design_manifest, CARD_DESIGN_MANIFEST)
if card_design_manifest is not None or design_engines_manifest is not None:
    try:
        design_engines = load_design_engines(game_dir)
        card_design = design_engines.get("card_design") if design_engines else None
        for component in card_design["components"]:
            check("layout-fragment", load(component["source"]), component["source"])
        for family in card_design["families"]:
            check("layout-fragment", load(family["source"]), family["source"])
            check("layout", family["layout"], f"compiled family {family['id']}")
        for engine in (engine for engine in design_engines["engines"] if engine["type"] == "pnpink"):
            adapter = load(engine["source"])
            check("pnpink-adapter", adapter, engine["source"])
            pnpink_adapters.append((engine, adapter))
    except (OSError, ValueError, KeyError) as exc:
        err(f"{DESIGN_ENGINES_MANIFEST}: {exc}")
source_overlay = load("templates/source-overlay.yaml")
if source_overlay is not None: check("source-overlay", source_overlay, "templates/source-overlay.yaml")
production = load("templates/production.json")
if production is not None: check("production", production, "templates/production.json")
affinity_binding = load("templates/affinity/forge-affinity.json")
if affinity_binding is not None: check("affinity-binding", affinity_binding, "templates/affinity/forge-affinity.json")
design_brief = load("design/brief.json")
if design_brief is not None: check("design-brief", design_brief, "design/brief.json")
prototype = load("design/prototype.json")
if prototype is not None: check("prototype", prototype, "design/prototype.json")
rulebook_pipeline_manifest = load("rules/pipeline.yaml")
if rulebook_pipeline_manifest is not None:
    check("rulebook-pipeline", rulebook_pipeline_manifest, "rules/pipeline.yaml")
    active_id = rulebook_pipeline_manifest.get("active")
    pipelines = rulebook_pipeline_manifest.get("pipelines") or []
    active = next((pipeline for pipeline in pipelines if pipeline.get("id") == active_id), None)
    if active is None:
        err(f"rules/pipeline.yaml: active pipeline '{active_id}' does not exist")
    elif active.get("status") != "active":
        err(f"rules/pipeline.yaml: active pipeline '{active_id}' must have status active")
    if len([pipeline for pipeline in pipelines if pipeline.get("status") == "active"]) != 1:
        err("rules/pipeline.yaml: exactly one rulebook pipeline must have status active")
rulebook_publications_manifest = load("rules/publications/manifest.json")
rulebook_publication = None
rulebook_publication_path = None
if rulebook_publications_manifest is not None:
    check("rulebook-publications", rulebook_publications_manifest, "rules/publications/manifest.json")
    active_id = rulebook_publications_manifest.get("active")
    publications = rulebook_publications_manifest.get("publications") or []
    active = next((publication for publication in publications if publication.get("id") == active_id), None)
    if active is None:
        err(f"rules/publications/manifest.json: active publication '{active_id}' does not exist")
    else:
        rulebook_publication_path = active.get("source")
        rulebook_publication = load(rulebook_publication_path)
        if rulebook_publication is None:
            err(f"rules/publications/manifest.json: source '{rulebook_publication_path}' does not exist")
        else:
            check("rulebook-publication", rulebook_publication, rulebook_publication_path)
            if rulebook_publication.get("id") != active_id:
                err(f"{rulebook_publication_path}: id must match active publication '{active_id}'")
    if len([publication for publication in publications if publication.get("status") == "active"]) != 1:
        err("rules/publications/manifest.json: exactly one rulebook publication must have status active")

# Pass 2
def dupes(arr, label):
    seen = set()
    for x in arr:
        if x["id"] in seen: err(f"duplicate {label} id '{x['id']}'")
        seen.add(x["id"])
for arr, label in [(cards,"card"),(printings,"printing"),(sets_,"set"),(formats,"format"),(restrictions,"restriction"),(setups,"setup")]:
    dupes(arr, label)

card_ids = {c["id"] for c in cards}

if isinstance(source_assets_manifest, dict):
    packages = source_assets_manifest.get("packages")
    packages = packages if isinstance(packages, list) else []
    package_ids = set()
    root = game_dir.resolve()
    for package in packages:
        if not isinstance(package, dict):
            continue
        package_id = package.get("id", "?")
        if package_id in package_ids:
            err(f"{SOURCE_ASSETS_MANIFEST}: duplicate source package id '{package_id}'")
        package_ids.add(package_id)
        files = (package.get("source_files") or []) + (package.get("previews") or [])
        if not package.get("source_files") and not package.get("external"):
            err(f"{SOURCE_ASSETS_MANIFEST} package '{package_id}': package has neither source files nor an external reference")
        for record in files:
            if not isinstance(record, dict):
                continue
            rel = record.get("path")
            parts = rel.split("/") if isinstance(rel, str) else []
            safe = bool(parts) and parts[0] in SOURCE_ASSET_ROOTS and not Path(rel).is_absolute()
            safe = safe and "\\" not in rel and all(part not in ("", ".", "..") for part in parts)
            if not safe:
                err(f"{SOURCE_ASSETS_MANIFEST} package '{package_id}': source path is not an allowed game-relative source: {rel}")
                continue
            path = (root / rel).resolve()
            try:
                path.relative_to(root)
            except ValueError:
                err(f"{SOURCE_ASSETS_MANIFEST} package '{package_id}': source path escapes the game: {rel}")
                continue
            if (not path.exists() or not path.is_file()) and not record.get("optional"):
                err(f"{SOURCE_ASSETS_MANIFEST} package '{package_id}': missing required source file: {rel}")

if rulebook_publication:
    setup_ids = {setup["id"] for setup in setups}
    used_cards = set((rulebook_publication.get("dependencies") or {}).get("cards") or [])
    used_assets = set((rulebook_publication.get("dependencies") or {}).get("assets") or [])
    for page in rulebook_publication.get("pages") or []:
        for block in page.get("blocks") or []:
            if block.get("card_id"): used_cards.add(block["card_id"])
            used_cards.update(block.get("card_ids") or [])
            for placement in block.get("placements") or []:
                if placement.get("card_id"): used_cards.add(placement["card_id"])
            if block.get("asset"): used_assets.add(block["asset"])
    for card_id in used_cards:
        if card_id not in card_ids: err(f"{rulebook_publication_path}: card '{card_id}' not found")
    for setup_id in (rulebook_publication.get("dependencies") or {}).get("setups") or []:
        if setup_id not in setup_ids: err(f"{rulebook_publication_path}: setup '{setup_id}' not found")
    for asset in used_assets | set((rulebook_publication.get("dependencies") or {}).get("fonts") or []):
        if not (game_dir / asset).exists(): err(f"{rulebook_publication_path}: linked file '{asset}' not found")

if design_engines:
    active = next((engine for engine in design_engines["engines"] if engine["id"] == design_engines["active"]), None)
    if active and active["status"] != "active":
        err(f"{DESIGN_ENGINES_MANIFEST}: selected engine '{design_engines['active']}' must have status active")
    if len([engine for engine in design_engines["engines"] if engine["status"] == "active"]) != 1:
        err(f"{DESIGN_ENGINES_MANIFEST}: exactly one engine must have status active")

if card_design:
    family_ids = {family["id"] for family in card_design["families"]}
    for component in card_design["components"]:
        applies = component.get("applies_to")
        if applies != "*":
            for family_id in applies or []:
                if family_id not in family_ids:
                    err(f"{CARD_DESIGN_MANIFEST}: component '{component['id']}' references unknown family '{family_id}'")
    order = set(card_design.get("region_order") or [])
    for family in card_design["families"]:
        ids = [region["id"] for region in family["layout"]["regions"]]
        if len(ids) != len(set(ids)): err(f"compiled family '{family['id']}' has duplicate region ids")
        for region_id in ids:
            if region_id not in order: err(f"compiled family '{family['id']}' region '{region_id}' is absent from region_order")
        for specimen in family.get("specimens") or []:
            if specimen not in card_ids: err(f"card design family '{family['id']}' references missing specimen '{specimen}'")
    for card in cards:
        matched = [family["id"] for family in card_design["families"] if card_matches_family(card, family.get("match"))]
        if len(matched) != 1:
            err(f"card design must match '{card['id']}' exactly once; matched {matched or 'none'}")

for engine, adapter in pnpink_adapters:
    declared = set(engine.get("families") or [])
    adapted = {family["id"] for family in adapter.get("families") or []}
    if declared != adapted:
        err(f"{engine['source']}: family list must match engine '{engine['id']}'")
    design_root = (game_dir / "templates/card-design").resolve()
    template_path = (game_dir / (adapter.get("template") or "")).resolve()
    try:
        template_path.relative_to(design_root)
    except ValueError:
        err(f"{engine['source']}: template escapes templates/card-design/: {adapter.get('template')}")
        continue
    if not template_path.exists():
        err(f"{engine['source']}: template does not exist: {adapter.get('template')}")
        continue
    svg = template_path.read_text()
    ids = set(re.findall(r'\bid=["\']([^"\']+)["\']', svg))
    for family in adapter.get("families") or []:
        if family["specimen"] not in card_ids:
            err(f"{engine['source']}: missing specimen '{family['specimen']}'")
        if family["bbox"] not in ids:
            err(f"{adapter['template']}: missing bbox id '{family['bbox']}'")
        for target in (family.get("fields") or {}).values():
            if target not in ids:
                err(f"{adapter['template']}: missing field id '{target}'")

def source_get(obj, path):
    value = obj
    for key in str(path or "").split("."):
        if not key: continue
        if not isinstance(value, dict): return None
        value = value.get(key)
    return value

def source_delete(obj, path):
    keys = [key for key in str(path or "").split(".") if key]
    parent = obj
    for key in keys[:-1]:
        if not isinstance(parent, dict): return
        parent = parent.get(key)
    if isinstance(parent, dict) and keys: parent.pop(keys[-1], None)

def source_matches(card, match):
    for path, wanted in (match or {}).items():
        choices = wanted if isinstance(wanted, list) else [wanted]
        if source_get(card, path) not in choices: return False
    return True

def source_signature(card, regions, nonvisual_fields=None):
    copy = json.loads(json.dumps(card))
    for path in nonvisual_fields or []:
        source_delete(copy, path)
    for region in regions:
        if region.get("source", "card") == "card":
            source_delete(copy, region["src"])
    return source_hash(copy)

def source_hash(value):
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    hash_ = 0x811c9dc5
    for ch in text:
        hash_ ^= ord(ch)
        hash_ = (hash_ * 0x01000193) & 0xffffffff
    return f"fnv1a:{hash_:08x}"

def source_printing_signature(printing, regions):
    copy = {
        "set_id": printing.get("set_id"),
        "collector_number": printing.get("collector_number"),
        "artist": printing.get("artist"),
        "flavor_text": printing.get("flavor_text"),
        "variant": printing.get("variant"),
    }
    for region in regions:
        if region.get("source", "card") == "printing":
            source_delete(copy, region["src"])
    return source_hash(copy)
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
        elif d.get("choices") and v not in d["choices"]:
            err(f"card '{c['id']}': attribute '{k}' must be one of {d['choices']!r}, got {v!r}")
    for d in defs.values():
        if d.get("required") and d["key"] not in (c.get("attributes") or {}):
            err(f"card '{c['id']}': missing required attribute '{d['key']}'")

declared_symbols = {s["key"] for s in game.get("symbols") or []}
for c in cards:
    for m in re.finditer(r"\[([a-z0-9_]+)\]", c.get("text") or ""):
        if m.group(1) not in declared_symbols:
            warn(f"card '{c['id']}': text uses undeclared symbol [{m.group(1)}]")
# asset paths must resolve (SPEC §7: no dangling references)
for s in game.get("symbols") or []:
    if s.get("asset") and not (game_dir / s["asset"]).exists():
        warn(f"symbol '{s['key']}': asset '{s['asset']}' not found")
for p in printings:
    for key in ("art", "back", "scan"):
        if p.get(key) and not (game_dir / p[key]).exists():
            warn(f"printing '{p['id']}': {key} asset '{p[key]}' not found")
if source_overlay:
    pinned_source = None
    if source_overlay.get("baseline_data"):
        pinned_path = game_dir / source_overlay["baseline_data"]
        if not pinned_path.exists():
            err(f"source overlay baseline data '{source_overlay['baseline_data']}' not found")
        else:
            pinned_source = json.loads(pinned_path.read_text())
            if source_overlay.get("source_ref") and pinned_source.get("source_ref") != source_overlay["source_ref"]:
                err(f"source overlay source_ref does not match '{source_overlay['baseline_data']}'")
    printing_cards = {p["card_id"] for p in printings if p.get("scan")}
    for cid in (source_overlay.get("baselines") or {}):
        if cid not in card_ids: err(f"source overlay baseline '{cid}': card not found")
    for cid in printing_cards:
        if cid not in (source_overlay.get("baselines") or {}):
            err(f"source overlay: scan-backed card '{cid}' has no immutable baseline")
    for region in source_overlay.get("regions") or []:
        exact_strategies = sum(bool(region.get(key)) for key in ("samples", "patches"))
        if exact_strategies > 1 or not (exact_strategies or region.get("render")):
            err(f"source overlay region '{region['id']}': declare samples or patches, optionally with render fallback, or render alone")
    for region in source_overlay.get("regions") or []:
        for value, cid in (region.get("samples") or {}).items():
            if cid not in card_ids:
                err(f"source overlay region '{region['id']}' sample '{value}': card '{cid}' not found")
            if cid not in printing_cards:
                err(f"source overlay region '{region['id']}' sample '{value}': card '{cid}' has no source scan")
    for region in source_overlay.get("regions") or []:
        for value, asset in (region.get("patches") or {}).items():
            if not re.match(r"^(?:data:|https?:|file:)", asset, re.I) and not (game_dir / asset).exists():
                err(f"source overlay region '{region['id']}' patch '{value}': asset '{asset}' not found")
    for card in cards:
        baseline = (source_overlay.get("baselines") or {}).get(card["id"])
        if not baseline: continue
        printing = next((item for item in printings if item["card_id"] == card["id"]), {})
        baseline_card = ((pinned_source or {}).get("cards") or {}).get(card["id"], card)
        baseline_printing = ((pinned_source or {}).get("printings") or {}).get(printing.get("id"), printing)
        regions = [r for r in source_overlay.get("regions") or [] if source_matches(baseline_card, r.get("match"))]
        signature = source_signature(baseline_card, regions, source_overlay.get("nonvisual_card_fields") or [])
        if signature != baseline["signature"]:
            err(f"source overlay baseline '{card['id']}': signature is stale (expected {signature})")
        printing_signature = source_printing_signature(baseline_printing, regions)
        if printing_signature != baseline.get("printing_signature"):
            err(f"source overlay baseline '{card['id']}': printing signature is stale (expected {printing_signature})")
        for region in regions:
            printing_source = region.get("source", "card") == "printing"
            key = f"printing.{region['src']}" if printing_source else region["src"]
            if key not in (baseline.get("values") or {}):
                err(f"source overlay baseline '{card['id']}': value '{key}' is missing")
                continue
            # A mapped value is allowed to diverge from the immutable baseline:
            # that is the edit the overlay exists to render.  When a pinned
            # semantic snapshot is present, compare the baseline metadata to
            # that snapshot rather than to the mutable working card.
            if pinned_source:
                expected = source_get(baseline_printing if printing_source else baseline_card, region["src"])
                actual = (baseline.get("values") or {}).get(key)
                if expected != actual:
                    err(f"source overlay baseline '{card['id']}': value '{key}' is stale")
if production:
    template_ids = set()
    cards_by_id = {card["id"]: card for card in cards}
    for template in production.get("templates") or []:
        tid = template["id"]
        if tid in template_ids: err(f"production template '{tid}': duplicate id")
        template_ids.add(tid)
        if not (game_dir / template["template"]).is_file():
            err(f"production template '{tid}': SVG '{template['template']}' not found")
        for resource in template.get("resources") or []:
            if not (game_dir / resource).is_file():
                err(f"production template '{tid}': resource '{resource}' not found")
        layers = set()
        for binding in template.get("bindings") or []:
            layer = binding["layer"].lower()
            if layer in layers: err(f"production template '{tid}': duplicate layer '{binding['layer']}'")
            layers.add(layer)
        for cid, baseline in (template.get("baselines") or {}).items():
            card = cards_by_id.get(cid)
            if not card:
                err(f"production template '{tid}': baseline card '{cid}' not found"); continue
            if not source_matches(card, template.get("match")):
                err(f"production template '{tid}': baseline card '{cid}' does not match its template selector")
            bindings = [binding for binding in template.get("bindings") or [] if binding.get("source", "card") == "card"]
            signature = source_signature(card, [{"src": binding["field"]} for binding in bindings])
            if signature != baseline["signature"]:
                err(f"production template '{tid}' baseline '{cid}': signature is stale (expected {signature})")
            for binding in bindings:
                expected = source_get(card, binding["field"])
                actual = (baseline.get("values") or {}).get(binding["field"])
                if expected != actual:
                    err(f"production template '{tid}' baseline '{cid}': value '{binding['field']}' is stale")
dupes(tokens, "token")
for t in tokens:
    if t.get("symbol") and t["symbol"] not in declared_symbols:
        err(f"token '{t['id']}': symbol '{t['symbol']}' not declared in game.yaml")
deck_ids = {d["id"] for d in decks}
deck_by_id = {d["id"]: d for d in decks}
for s in setups:
    seat_ids, zone_ids, item_ids = set(), set(), set()
    for seat in s.get("seats") or []:
        if seat["id"] in seat_ids: err(f"setup '{s['id']}': duplicate seat id '{seat['id']}'")
        seat_ids.add(seat["id"])
    for zone in s.get("zones") or []:
        if zone["id"] in zone_ids: err(f"setup '{s['id']}': duplicate zone id '{zone['id']}'")
        zone_ids.add(zone["id"])
        if zone.get("seat_id") and zone["seat_id"] not in seat_ids:
            err(f"setup '{s['id']}': zone '{zone['id']}' references unknown seat '{zone['seat_id']}'")
        if zone.get("visibility") == "seat" and not zone.get("seat_id"):
            err(f"setup '{s['id']}': private zone '{zone['id']}' needs seat_id")
    stacked_decks = set()
    for stack in s.get("stacks") or []:
        if stack["id"] in item_ids: err(f"setup '{s['id']}': duplicate setup item id '{stack['id']}'")
        item_ids.add(stack["id"])
        if stack["deck_id"] not in deck_ids: err(f"setup '{s['id']}': stack '{stack['id']}' references unknown deck '{stack['deck_id']}'")
        if stack["zone_id"] not in zone_ids: err(f"setup '{s['id']}': stack '{stack['id']}' references unknown zone '{stack['zone_id']}'")
        if stack["deck_id"] in stacked_decks: err(f"setup '{s['id']}': deck '{stack['deck_id']}' is used by more than one stack")
        stacked_decks.add(stack["deck_id"])
    placed_counts = {}
    for placement in s.get("placements") or []:
        if placement["id"] in item_ids: err(f"setup '{s['id']}': duplicate setup item id '{placement['id']}'")
        item_ids.add(placement["id"])
        deck = deck_by_id.get(placement["deck_id"])
        if not deck: err(f"setup '{s['id']}': placement '{placement['id']}' references unknown deck '{placement['deck_id']}'")
        if placement["card_id"] not in card_ids: err(f"setup '{s['id']}': placement '{placement['id']}' references unknown card '{placement['card_id']}'")
        if placement["zone_id"] not in zone_ids: err(f"setup '{s['id']}': placement '{placement['id']}' references unknown zone '{placement['zone_id']}'")
        key = (placement["deck_id"], placement["card_id"])
        placed_counts[key] = placed_counts.get(key, 0) + placement.get("quantity", 1)
        if deck and placement["card_id"] not in (deck.get("cards") or {}):
            err(f"setup '{s['id']}': placement '{placement['id']}' card '{placement['card_id']}' is not in deck '{placement['deck_id']}'")
    for (did, cid), count in placed_counts.items():
        available = ((deck_by_id.get(did) or {}).get("cards") or {}).get(cid, 0)
        if count > available: err(f"setup '{s['id']}': places {count}x '{cid}' from deck '{did}', but it only contains {available}")
    for counter in s.get("counters") or []:
        if counter["id"] in item_ids: err(f"setup '{s['id']}': duplicate setup item id '{counter['id']}'")
        item_ids.add(counter["id"])
        if counter.get("seat_id") and counter["seat_id"] not in seat_ids:
            err(f"setup '{s['id']}': counter '{counter['id']}' references unknown seat '{counter['seat_id']}'")
        if counter.get("minimum") is not None and counter["initial"] < counter["minimum"]:
            err(f"setup '{s['id']}': counter '{counter['id']}' starts below its minimum")
        if counter.get("maximum") is not None and counter["initial"] > counter["maximum"]:
            err(f"setup '{s['id']}': counter '{counter['id']}' starts above its maximum")
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
      f"{len(formats)} formats, {len(restrictions)} restrictions, {len(rulings)} rulings, {len(setups)} setups")
if errors:
    print(f"\nFAIL — {len(errors)} error(s), {len(warnings)} warning(s)"); sys.exit(1)
print(f"\nOK — 0 errors, {len(warnings)} warning(s)")
