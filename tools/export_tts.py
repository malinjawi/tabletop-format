#!/usr/bin/env python3
"""Forge -> Tabletop Simulator save, adapter format v0.3.

Cards, versioned deck setups, component textures, component placement, and snap
points are derived from one exact Forge tree. Hosted exports use immutable Forge
cache URLs; local exports use file:// URLs. Unsupported custom-art dice fail
closed rather than silently becoming the wrong object.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
import sys
from pathlib import Path

import yaml
from PIL import Image
from render_support import render_faces

ROOT = Path(__file__).resolve().parent.parent
MAX_COLS, MAX_ROWS, MAX_SHEET = 10, 7, 4096
MAX_FACES_PER_SHEET = MAX_COLS * MAX_ROWS
WORLD_SCALE = 0.025
TTS_ADAPTER_VERSION = 4


def load_json(path: Path):
    return json.loads(path.read_text())


def load_documents(directory: Path):
    documents = []
    if not directory.is_dir():
        return documents
    for path in sorted(directory.iterdir()):
        if path.suffix.lower() not in (".json", ".yaml", ".yml"):
            continue
        doc = load_json(path) if path.suffix.lower() == ".json" else yaml.safe_load(path.read_text())
        documents.extend(doc if isinstance(doc, list) else [doc])
    return documents


def choose_setup(game_dir: Path, requested: str | None):
    setup_dir = game_dir / "setups"
    paths = sorted(path for path in setup_dir.glob("*") if path.suffix.lower() in (".json", ".yaml", ".yml"))
    if not paths:
        if requested:
            raise ValueError(f"setup '{requested}' was requested but this game has no setups")
        return None, None
    for path in paths:
        doc = load_json(path) if path.suffix.lower() == ".json" else yaml.safe_load(path.read_text())
        if not requested or requested in (doc.get("id"), path.stem, str(path)):
            return doc, path.relative_to(game_dir).as_posix()
    raise ValueError(f"setup '{requested}' was not found")


def stable_guid(*parts) -> str:
    return hashlib.sha256("\0".join(map(str, parts)).encode()).hexdigest()[:6]


def transform(x=0, y=1, z=0, rot_y=0, rot_z=0, scale_x=1, scale_y=1, scale_z=1):
    return {
        "posX": round(x, 4), "posY": round(y, 4), "posZ": round(z, 4),
        "rotX": 0, "rotY": round(rot_y, 4), "rotZ": round(rot_z, 4),
        "scaleX": round(scale_x, 4), "scaleY": round(scale_y, 4), "scaleZ": round(scale_z, 4),
    }


def world_point(position: dict, board: dict):
    return ((float(position["x"]) - board["width"] / 2) * WORLD_SCALE,
            (float(position["y"]) - board["height"] / 2) * WORLD_SCALE)


def zone_point(zone: dict, board: dict):
    position, size = zone["position"], zone["size"]
    return world_point({"x": position["x"] + size["width"] / 2,
                        "y": position["y"] + size["height"] / 2}, board)


def provenance(game: dict, printing: dict, card: dict):
    prov = printing.get("provenance") or {}
    creator = printing.get("artist") or prov.get("creator") or (game.get("default_provenance") or {}).get("creator", "")
    license_name = prov.get("license") or game.get("license", "")
    source = prov.get("source") or ""
    fields = {"forge_card_id": card.get("id"), "forge_printing_id": printing.get("id")}
    if creator:
        fields["credit"] = creator
    if license_name:
        fields["license"] = license_name
    if source:
        fields["source"] = source
    return fields


def build_sheets(game_dir: Path, printings: list[dict], out_dir: Path, face_url_arg: str, back_url_arg: str | None):
    faces_dir = game_dir / "exports" / "faces"
    render_faces(game_dir)
    for stale in out_dir.glob("sheet*.png"):
        stale.unlink()
    with Image.open(faces_dir / f"{printings[0]['id']}.png") as first:
        source_w, source_h = first.size
    batches = [printings[index:index + MAX_FACES_PER_SHEET] for index in range(0, len(printings), MAX_FACES_PER_SHEET)]
    sheets = []
    for sheet_no, batch in enumerate(batches, 1):
        cols = min(MAX_COLS, len(batch))
        rows = -(-len(batch) // cols)
        scale = min(1.0, MAX_SHEET / (cols * source_w), MAX_SHEET / (rows * source_h))
        cell_w, cell_h = int(source_w * scale), int(source_h * scale)
        sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), "white")
        for slot, printing in enumerate(batch):
            with Image.open(faces_dir / f"{printing['id']}.png") as original:
                image = original.convert("RGB")
                if image.size != (cell_w, cell_h):
                    image = image.resize((cell_w, cell_h), Image.Resampling.LANCZOS)
                sheet.paste(image, ((slot % cols) * cell_w, (slot // cols) * cell_h))
        filename = "sheet.png" if len(batches) == 1 else f"sheet-{sheet_no}.png"
        path = out_dir / filename
        sheet.save(path)
        if face_url_arg:
            if len(batches) > 1 and "{sheet}" not in face_url_arg:
                raise ValueError("multi-sheet TTS export requires {sheet} in --face-url")
            url = face_url_arg.replace("{sheet}", str(sheet_no))
        else:
            url = path.resolve().as_uri()
        sheets.append({"path": path, "file": filename, "url": url, "cols": cols, "rows": rows,
                       "width": sheet.width, "height": sheet.height})
    back_path = out_dir / "back.png"
    with Image.open(faces_dir / "_back.png") as back:
        back.save(back_path)
    return sheets, back_path, back_url_arg or back_path.resolve().as_uri()


def card_catalog(game: dict, cards: list[dict], printings: list[dict], sheets: list[dict], back_url: str):
    cards_by_id = {card["id"]: card for card in cards}
    printing_by_card = {}
    catalog = {}
    for index, printing in enumerate(printings):
        card_id = printing["card_id"]
        if card_id not in cards_by_id:
            raise ValueError(f"printing '{printing['id']}' references missing card '{card_id}'")
        sheet_no = index // MAX_FACES_PER_SHEET + 1
        card_id_number = sheet_no * 100 + index % MAX_FACES_PER_SHEET
        spec = {"printing": printing, "card": cards_by_id[card_id], "card_id": card_id_number}
        catalog[printing["id"]] = spec
        printing_by_card.setdefault(card_id, spec)
    custom_decks = {str(number): {
        "FaceURL": sheet["url"], "BackURL": back_url,
        "NumWidth": sheet["cols"], "NumHeight": sheet["rows"],
        "BackIsHidden": True, "UniqueBack": False,
    } for number, sheet in enumerate(sheets, 1)}
    return cards_by_id, printing_by_card, catalog, custom_decks


def contained_card(game: dict, spec: dict):
    printing, card = spec["printing"], spec["card"]
    name = card.get("name", card["id"])
    if printing.get("variant"):
        name = f"{name} ({printing['variant']})"
    prov = provenance(game, printing, card)
    gmnotes = " · ".join(value for value in (
        f"Credit: {prov.get('credit')}" if prov.get("credit") else "",
        f"License: {prov.get('license')}" if prov.get("license") else "",
        f"Source: {prov.get('source')}" if prov.get("source") else "",
        f"Forge card: {card['id']}", f"Forge printing: {printing['id']}",
    ) if value)
    return {
        "Name": "Card", "CardID": spec["card_id"], "Nickname": name,
        "Description": card.get("text", ""),
        "GMNotes": gmnotes,
        "Tags": [game["id"], f"card:{card['id']}"], "Transform": transform(rot_y=180, rot_z=180),
    }


def deck_object(game: dict, nickname: str, specs: list[dict], custom_decks: dict, xf: dict, guid_key: str):
    contained = [contained_card(game, spec) for spec in specs]
    if len(specs) == 1:
        card = dict(contained[0])
        card.update({"Name": "CardCustom", "GUID": stable_guid(game["id"], guid_key),
                     "Transform": xf, "CustomDeck": custom_decks})
        return card
    return {
        "Name": "DeckCustom", "GUID": stable_guid(game["id"], guid_key), "Nickname": nickname,
        "Description": f"Versioned Forge card stack · {guid_key}", "Transform": xf,
        "DeckIDs": [spec["card_id"] for spec in specs], "CustomDeck": custom_decks,
        "ContainedObjects": contained, "Tags": [game["id"], "forge-card-stack"],
    }


def build_card_objects(game: dict, printings: list[dict], printing_by_card: dict, catalog: dict,
                       custom_decks: dict, setup: dict | None, ref: str):
    if not setup:
        specs = []
        for printing in printings:
            specs.extend([catalog[printing["id"]]] * int(printing.get("quantity", 1)))
        return [deck_object(game, f"{game.get('title', game['id'])} deck", specs, custom_decks,
                            transform(rot_y=180, rot_z=180), "complete-deck")]

    board = setup["board"]
    zones = {zone["id"]: zone for zone in setup.get("zones", [])}
    decks = {deck["id"]: deck for deck in load_documents(Path(game["__dir__"]) / "decks")}
    placed = {}
    for placement in setup.get("placements", []):
        key = (placement["deck_id"], placement["card_id"])
        placed[key] = placed.get(key, 0) + int(placement.get("quantity", 1))
    objects = []
    for placement in setup.get("placements", []):
        if placement["zone_id"] not in zones:
            raise ValueError(f"placement '{placement['id']}' references missing zone '{placement['zone_id']}'")
        spec = printing_by_card.get(placement["card_id"])
        if not spec:
            raise ValueError(f"placement '{placement['id']}' references card with no printing '{placement['card_id']}'")
        x, z = zone_point(zones[placement["zone_id"]], board)
        for copy in range(int(placement.get("quantity", 1))):
            objects.append(deck_object(game, placement.get("name", spec["card"].get("name", placement["id"])), [spec], custom_decks,
                                       transform(x=x + copy * .12, y=1 + copy * .05, z=z,
                                                 rot_y=zones[placement["zone_id"]].get("rotation", 0),
                                                 rot_z=0 if placement.get("face", "up") == "up" else 180),
                                       f"placement:{placement['id']}:{copy}"))
    for stack in setup.get("stacks", []):
        deck = decks.get(stack["deck_id"])
        if not deck:
            raise ValueError(f"stack '{stack['id']}' references missing deck '{stack['deck_id']}'")
        if stack["zone_id"] not in zones:
            raise ValueError(f"stack '{stack['id']}' references missing zone '{stack['zone_id']}'")
        specs = []
        for card_id, quantity in deck.get("cards", {}).items():
            remaining = int(quantity) - placed.get((deck["id"], card_id), 0)
            if remaining < 0:
                raise ValueError(f"setup removes more '{card_id}' cards than deck '{deck['id']}' contains")
            if remaining and card_id not in printing_by_card:
                raise ValueError(f"deck '{deck['id']}' references card with no printing '{card_id}'")
            specs.extend([printing_by_card[card_id]] * remaining)
        if not specs:
            continue
        if stack.get("shuffle"):
            seed = hashlib.sha256(f"{game['id']}:{setup['id']}:{stack['id']}:{ref}".encode()).digest()
            random.Random(seed).shuffle(specs)
        x, z = zone_point(zones[stack["zone_id"]], board)
        objects.append(deck_object(game, stack.get("name") or deck.get("name") or stack["id"], specs, custom_decks,
                                   transform(x=x, z=z, rot_y=zones[stack["zone_id"]].get("rotation", 0),
                                             rot_z=0 if stack.get("face") == "up" else 180),
                                   f"stack:{stack['id']}"))
    return objects


def component_url(base_url: str, directory: Path, filename: str):
    return f"{base_url.rstrip('/')}/{filename}" if base_url else (directory / filename).resolve().as_uri()


def component_notes(game: dict, component: dict, ref: str):
    rights = []
    for artwork in component.get("artwork", []):
        if artwork.get("rights"):
            rights.append({"face": artwork.get("face"), "path": artwork.get("path"), **artwork["rights"]})
    return json.dumps({
        "forge_component_id": component["id"], "forge_ref": ref,
        "game_license": game.get("license"), "artwork_rights": rights,
    }, ensure_ascii=False, sort_keys=True)


def supported_standard_die(component: dict):
    faces = component.get("faces") or []
    count = len(faces) if faces else int(component.get("attributes", {}).get("sides", 6))
    if count not in (4, 6, 8, 10, 12, 20):
        return None
    if faces:
        expected = list(range(1, count + 1))
        if [face.get("value") for face in faces] != expected or any(face.get("art") or face.get("glyph") for face in faces):
            return None
    return count


def custom_component_object(game: dict, component: dict, assets_dir: Path, base_url: str,
                            ref: str, copy: int, xf: dict, face: str):
    assets = {asset["side"]: asset for asset in component["assets"]}
    front = component_url(base_url, assets_dir, assets["front"]["file"])
    back = component_url(base_url, assets_dir, assets.get("back", assets["front"])["file"])
    kind, shape = component["kind"], component.get("shape", "rounded-rectangle")
    width, height = component["size_mm"]["width"], component["size_mm"]["height"]
    xf = dict(xf)
    xf.update({"scaleX": round(max(.2, width / 25.4), 4), "scaleY": 1, "scaleZ": round(max(.2, height / 25.4), 4)})
    if face == "back":
        xf["rotZ"] = 180
    common = {
        "GUID": stable_guid(game["id"], ref, component["id"], copy),
        "Nickname": component["name"], "Description": component.get("description", ""),
        "GMNotes": component_notes(game, component, ref),
        "Transform": xf, "Tags": [game["id"], "forge-component", f"component:{component['id']}", f"kind:{kind}"],
    }
    if kind == "die":
        sides = supported_standard_die(component)
        if not sides:
            raise ValueError(f"component '{component['id']}' uses custom die faces; TTS needs a validated atlas and rotation map, which this adapter does not fabricate")
        return {**common, "Name": f"Die_{sides}"}
    image = {"ImageURL": front, "ImageSecondaryURL": back, "ImageScalar": 1, "WidthScale": 0}
    if kind == "board":
        return {**common, "Name": "Custom_Board", "Locked": True, "CustomImage": image}
    if kind in ("standee", "meeple", "figurine"):
        return {**common, "Name": "Figurine_Custom", "CustomImage": image}
    if kind in ("tile", "player-aid"):
        tile_type = {"rectangle": 0, "hexagon": 1, "circle": 2, "rounded-rectangle": 3}.get(shape, 3)
        image["CustomTile"] = {"Type": tile_type, "Thickness": 0.2, "Stackable": True, "Stretch": True}
        return {**common, "Name": "Custom_Tile", "CustomImage": image}
    image["CustomToken"] = {"Thickness": 0.2, "MergeDistancePixels": 15, "Stackable": True}
    obj = {**common, "Name": "Custom_Token", "CustomImage": image}
    if kind == "dial":
        start = float(component.get("attributes", {}).get("start_value", 0))
        maximum = float(component.get("attributes", {}).get("max_value", 10))
        step = float(component.get("attributes", {}).get("step", 1))
        if step > 0 and maximum >= start and (maximum - start) / step <= 35:
            values = [start + index * step for index in range(round((maximum - start) / step) + 1)]
            obj["RotationValues"] = [{"Value": int(value) if value.is_integer() else value,
                                      "Rotation": {"x": 0, "y": round(index * 360 / len(values), 4), "z": 0}}
                                     for index, value in enumerate(values)]
    return obj


def build_component_objects(game: dict, setup: dict | None, assets_manifest: dict, assets_dir: Path,
                            base_url: str, ref: str):
    board = setup.get("board") if setup else {"width": 1600, "height": 1000}
    by_id = {component["id"]: component for component in assets_manifest.get("components", [])}
    used = {component_id: 0 for component_id in by_id}
    objects, placement_receipts = [], []
    if setup:
        for placement in setup.get("pieces", []):
            component = by_id.get(placement["component_id"])
            if not component:
                raise ValueError(f"piece placement '{placement['id']}' references missing component '{placement['component_id']}'")
            quantity = int(placement.get("quantity", 1))
            if used[component["id"]] + quantity > component["resolved_quantity"]:
                raise ValueError(f"setup places more '{component['id']}' pieces than the resolved inventory contains")
            x, z = world_point(placement["position"], board)
            for offset in range(quantity):
                copy = used[component["id"]]
                xf = transform(x=x + offset * .18, y=.85 + offset * .05, z=z,
                               rot_y=placement.get("rotation", 0))
                objects.append(custom_component_object(game, component, assets_dir, base_url, ref, copy, xf,
                                                        placement.get("face", "front")))
                used[component["id"]] += 1
            placement_receipts.append({"placement_id": placement["id"], "component_id": component["id"],
                                       "quantity": quantity, "source_position": placement["position"],
                                       "world_position": {"x": x, "z": z}, "face": placement.get("face", "front")})
    supply_index = 0
    board_width = board["width"] * WORLD_SCALE
    for component in assets_manifest.get("components", []):
        remaining = component["resolved_quantity"] - used[component["id"]]
        for _ in range(remaining):
            copy = used[component["id"]]
            if component["kind"] == "board" and not setup and copy == 0:
                x, z, y = 0, 0, .6
            else:
                column, row = supply_index % 8, supply_index // 8
                x, z, y = board_width / 2 + 3 + column * 1.75, -board["height"] * WORLD_SCALE / 2 + 2 + row * 1.75, .85
                supply_index += 1
            objects.append(custom_component_object(game, component, assets_dir, base_url, ref, copy,
                                                    transform(x=x, y=y, z=z), "front"))
            used[component["id"]] += 1
    return objects, placement_receipts


def snap_points(game: dict, setup: dict | None):
    if not setup:
        return []
    board = setup["board"]
    points = []
    for zone in setup.get("zones", []):
        x, z = zone_point(zone, board)
        points.append({"Position": {"x": round(x, 4), "y": 1, "z": round(z, 4)},
                       "Rotation": {"x": 0, "y": zone.get("rotation", 0), "z": 0},
                       "Tags": [game["id"], f"zone:{zone['id']}"]})
    for placement in setup.get("pieces", []):
        x, z = world_point(placement["position"], board)
        points.append({"Position": {"x": round(x, 4), "y": 1, "z": round(z, 4)},
                       "Rotation": {"x": 0, "y": placement.get("rotation", 0), "z": 0},
                       "Tags": [game["id"], f"component:{placement['component_id']}"]})
    for counter in setup.get("counters", []):
        x, z = world_point(counter["position"], board)
        points.append({"Position": {"x": round(x, 4), "y": 1, "z": round(z, 4)},
                       "Rotation": {"x": 0, "y": 0, "z": 0},
                       "Tags": [game["id"], f"counter:{counter['id']}"]})
    return points


def color_diffuse(value: str | None):
    text = str(value or "#ffffff").lstrip("#")
    if len(text) == 3:
        text = "".join(character * 2 for character in text)
    if len(text) != 6 or any(character not in "0123456789abcdefABCDEF" for character in text):
        text = "ffffff"
    return {"r": round(int(text[0:2], 16) / 255, 6),
            "g": round(int(text[2:4], 16) / 255, 6),
            "b": round(int(text[4:6], 16) / 255, 6)}


def build_counter_objects(game: dict, setup: dict | None, ref: str):
    if not setup:
        return []
    board = setup["board"]
    objects = []
    for counter in setup.get("counters", []):
        x, z = world_point(counter["position"], board)
        bounds = {key: counter[key] for key in ("minimum", "maximum") if key in counter}
        objects.append({
            "Name": "Counter", "GUID": stable_guid(game["id"], ref, "setup-counter", counter["id"]),
            "Nickname": counter["name"],
            "Description": "Interactive TTS counter generated from a versioned Forge setup.",
            "GMNotes": json.dumps({"forge_counter_id": counter["id"], "forge_ref": ref,
                                   "declared_bounds": bounds}, sort_keys=True),
            "Transform": transform(x=x, y=.85, z=z), "ColorDiffuse": color_diffuse(counter.get("color")),
            "Counter": {"value": int(counter["initial"])},
            "Tags": [game["id"], "forge-setup-counter", f"counter:{counter['id']}"],
        })
    return objects


def sha256(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description="Forge exact version -> Tabletop Simulator save")
    parser.add_argument("game_dir")
    parser.add_argument("--face-url", default="")
    parser.add_argument("--back-url")
    parser.add_argument("--component-base-url", default="")
    parser.add_argument("--setup", help="setup id, filename stem, or path (default: first setup; optional if no setups exist)")
    parser.add_argument("--ref", default="working-tree")
    args = parser.parse_args()

    game_dir = Path(args.game_dir).resolve()
    game = yaml.safe_load((game_dir / "game.yaml").read_text())
    game["__dir__"] = str(game_dir)
    cards = load_json(game_dir / "components" / "cards.json")
    printings = load_json(game_dir / "components" / "printings.json")
    if not printings:
        raise ValueError("no printings to export")
    setup, setup_source = choose_setup(game_dir, args.setup)
    out_dir = game_dir / "exports" / "tts"
    out_dir.mkdir(parents=True, exist_ok=True)
    sheets, back_path, back_url = build_sheets(game_dir, printings, out_dir, args.face_url, args.back_url)
    _, printing_by_card, catalog, custom_decks = card_catalog(game, cards, printings, sheets, back_url)
    card_objects = build_card_objects(game, printings, printing_by_card, catalog, custom_decks, setup, args.ref)

    assets_manifest = None
    component_objects, placement_receipts = [], []
    tokens_path = game_dir / "components" / "tokens.json"
    components_dir = out_dir / "components"
    if tokens_path.is_file() and load_json(tokens_path):
        result = subprocess.run(["node", str(ROOT / "tools" / "render_components.mjs"), str(game_dir), str(components_dir),
                                 "--ref", args.ref], cwd=ROOT, capture_output=True, text=True)
        if result.returncode:
            raise ValueError(result.stderr.strip() or result.stdout.strip() or "component rasterization failed")
        assets_manifest = load_json(components_dir / "component-assets.json")
        component_objects, placement_receipts = build_component_objects(
            game, setup, assets_manifest, components_dir, args.component_base_url, args.ref)

    authors = ", ".join(author.get("name", "") for author in (game.get("authors") or []))
    byline = " · ".join(value for value in (f"By {authors}" if authors else "",
                                              f"License: {game.get('license')}" if game.get("license") else "") if value)
    notes = [f"{game.get('title', game['id'])} — Forge exact-version TTS build", f"Source: {args.ref}"]
    if setup:
        notes.append(f"Setup: {setup['name']} ({setup['id']})")
        notes.extend([f"• {instruction}" for instruction in setup.get("instructions", [])])
    if byline:
        notes.append(byline)
    default_creator = (game.get("default_provenance") or {}).get("creator", "")
    credited = []
    cards_by_id = {card["id"]: card for card in cards}
    for printing in printings:
        card = cards_by_id[printing["card_id"]]
        creator = provenance(game, printing, card).get("credit", "")
        if creator and creator != default_creator:
            credited.append(f"  {card.get('name', card['id'])}: {creator}")
    if credited:
        notes.extend(["", "Art credits (credit follows the work):", *credited])
    game.pop("__dir__", None)
    setup_suffix = f" · {setup['name']}" if setup else ""
    counter_objects = build_counter_objects(game, setup, args.ref)
    save = {
        "SaveName": f"{game.get('title', game['id'])}{setup_suffix}",
        "GameMode": game.get("title", game["id"]),
        "VersionNumber": f"v{game.get('version', '0.1.0')}",
        "Note": "\n".join(notes), "SnapPoints": snap_points(game, setup),
        "ObjectStates": [*card_objects, *component_objects, *counter_objects],
    }
    out_path = out_dir / f"{game['id']}.json"
    out_path.write_text(json.dumps(save, indent=2, ensure_ascii=False) + "\n")
    component_assets = []
    if assets_manifest:
        for component in assets_manifest["components"]:
            for asset in component["assets"]:
                path = components_dir / asset["file"]
                component_assets.append({**asset, "sha256": sha256(path),
                                         "url": component_url(args.component_base_url, components_dir, asset["file"])})
    manifest = {
        "format": "forge-tabletop-simulator", "version": TTS_ADAPTER_VERSION,
        "source_ref": args.ref, "game_id": game["id"],
        "setup": {"id": setup["id"], "source": setup_source} if setup else None,
        "outputs": {"save": out_path.name,
                    "card_sheets": [{"file": sheet["file"], "width": sheet["width"], "height": sheet["height"],
                                     "sha256": sha256(sheet["path"]), "url": sheet["url"]} for sheet in sheets],
                    "card_back": {"file": back_path.name, "sha256": sha256(back_path), "url": back_url},
                    "component_assets": component_assets},
        "objects": {"card_stacks": len(card_objects), "components": len(component_objects),
                    "setup_counters": len(counter_objects),
                    "snap_points": len(save["SnapPoints"])},
        "component_placements": placement_receipts,
        "rights": assets_manifest.get("rights") if assets_manifest else None,
        "boundaries": [
            "Tabletop Simulator is a downstream adapter; Forge data, designs, artwork rights, setup, and Git ref remain authoritative.",
            "Versioned setup card stacks, explicit card placements, component placements, remaining component supplies, and zone snap points are staged.",
            "Setup counters become native interactive TTS Counter objects with their committed initial value; declared minimum/maximum remain provenance metadata rather than scripted enforcement.",
            "Custom-art dice require a validated texture atlas and face rotation map and fail closed until supplied.",
        ],
    }
    (out_dir / "tts-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"TTS export: {len(printings)} unique card faces on {len(sheets)} sheet(s), "
          f"{len(card_objects)} card stack(s), {len(component_objects)} component object(s) -> {out_path}")
    if not args.face_url and not args.back_url and not args.component_base_url:
        print("  NOTE: assets use local file:// URLs; pass hosted URL options for a shareable mod")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError) as error:
        print(f"export_tts: {error}", file=sys.stderr)
        raise SystemExit(1)
