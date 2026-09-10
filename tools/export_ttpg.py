#!/usr/bin/env python3
"""Forge exact version -> native Tabletop Playground package, adapter v1.

The package contains current-schema object templates, local textures, a staged
``.vts`` game state, and a Forge receipt.  It is deliberately a file adapter:
installing/uploading the package remains an explicit Tabletop Playground editor
action, so Forge never claims a mod.io publish that did not happen.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import shutil
import subprocess
from collections import Counter
from pathlib import Path

import yaml
from PIL import Image, ImageDraw, ImageFont

from deterministic_archive import write_directory_zip
from render_support import card_size_mm, render_faces


ROOT = Path(__file__).resolve().parent.parent
ADAPTER_VERSION = 1
SCHEMA_COMMIT = "6ec22130a465096b3ae0808e746a9634fd92f0ca"
SAVE_STATE_VERSION = "1.1"
MAX_TEXTURE_SIDE = 4096
MAX_ATLAS_CELLS = 70
WORLD_SCALE = 0.05  # Forge board pixels -> TTPG centimetres.


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
    paths = sorted(path for path in (game_dir / "setups").glob("*")
                   if path.suffix.lower() in (".json", ".yaml", ".yml"))
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
    return hashlib.sha256("\0".join(map(str, parts)).encode()).hexdigest()[:32].upper()


def sha256(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_name(value, fallback="forge"):
    return re.sub(r"[^A-Za-z0-9._ -]+", "-", str(value or fallback)).strip(" .-") or fallback


def provenance(game: dict, printing: dict, card: dict):
    declared = printing.get("provenance") or printing.get("scan_provenance") or {}
    default = game.get("default_provenance") or {}
    return {
        "forge_card_id": card.get("id"),
        "forge_printing_id": printing.get("id"),
        "credit": printing.get("artist") or declared.get("creator") or default.get("creator") or "",
        "license": declared.get("license") or game.get("license") or "",
        "source": declared.get("source_url") or declared.get("source") or "",
    }


def card_atlases(game_dir: Path, game: dict, cards: list[dict], printings: list[dict],
                 textures: Path, package_guid: str):
    faces_dir = textures.parent / ".card-render"
    render_faces(game_dir, faces_dir)
    cards_by_id = {card["id"]: card for card in cards}
    with Image.open(faces_dir / f"{printings[0]['id']}.png") as sample:
        source_w, source_h = sample.size
    batches = [printings[index:index + MAX_ATLAS_CELLS]
               for index in range(0, len(printings), MAX_ATLAS_CELLS)]
    templates, catalog, outputs = [], {}, []
    for batch_no, batch in enumerate(batches, 1):
        cols = min(10, len(batch))
        rows = math.ceil(len(batch) / cols)
        scale = min(1, MAX_TEXTURE_SIDE / (cols * source_w), MAX_TEXTURE_SIDE / (rows * source_h))
        cell_w, cell_h = max(1, int(source_w * scale)), max(1, int(source_h * scale))
        atlas = Image.new("RGB", (cols * cell_w, rows * cell_h), "white")
        names, metadata, tags = {}, {}, {}
        template_guid = stable_guid(package_guid, "cards", batch_no)
        for index, printing in enumerate(batch):
            card = cards_by_id.get(printing["card_id"])
            if not card:
                raise ValueError(f"printing '{printing['id']}' references missing card '{printing['card_id']}'")
            source = faces_dir / f"{printing['id']}.png"
            if not source.is_file():
                raise ValueError(f"renderer did not produce '{source.name}'")
            with Image.open(source) as image:
                face = image.convert("RGB")
                if face.size != (cell_w, cell_h):
                    face = face.resize((cell_w, cell_h), Image.Resampling.LANCZOS)
                atlas.paste(face, ((index % cols) * cell_w, (index // cols) * cell_h))
            label = card.get("name", card["id"])
            if printing.get("variant"):
                label += f" ({printing['variant']})"
            names[str(index)] = label
            metadata[str(index)] = json.dumps(provenance(game, printing, card), ensure_ascii=False, sort_keys=True)
            tags[str(index)] = [game["id"], f"card:{card['id']}", f"printing:{printing['id']}"]
            catalog[printing["id"]] = {"template": template_guid, "index": index,
                                         "card": card, "printing": printing}
        texture_name = f"cards/front-{batch_no}.jpg"
        texture_path = textures / texture_name
        texture_path.parent.mkdir(parents=True, exist_ok=True)
        atlas.save(texture_path, quality=94, optimize=True, subsampling=0)
        template = base_template(template_guid, f"{game.get('title', game['id'])} cards {batch_no}", "Cardboard")
        template.update({
            "Type": "Card", "FrontTexture": texture_name, "BackTexture": "cards/back.png",
            "HiddenTexture": "", "BackIndex": -2, "HiddenIndex": -3,
            "NumHorizontal": cols, "NumVertical": rows,
            "Width": round(card_size_mm(game_dir)[0] / 10, 4),
            "Height": round(card_size_mm(game_dir)[1] / 10, 4),
            "Thickness": 0.05, "HiddenInHand": True, "UsedWithCardHolders": True,
            "CanStack": True, "UsePrimaryColorForSide": False,
            "FrontTextureOverrideExposed": False, "AllowFlippedInStack": False,
            "MirrorBack": True, "Model": "Rounded", "Indices": list(range(len(batch))),
            "CardNames": names, "CardMetadata": metadata, "CardTags": tags,
        })
        templates.append(template)
        outputs.append({"file": f"Textures/{texture_name}", "template_guid": template_guid,
                        "columns": cols, "rows": rows, "cards": len(batch),
                        "width": atlas.width, "height": atlas.height,
                        "sha256": sha256(texture_path)})
    back_source = faces_dir / "_back.png"
    if not back_source.is_file():
        raise ValueError("renderer did not produce _back.png")
    (textures / "cards").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(back_source, textures / "cards" / "back.png")
    return templates, catalog, outputs, faces_dir


def base_template(guid: str, name: str, surface="Cardboard"):
    return {
        "Type": "Card", "GUID": guid, "Name": name, "Metadata": "",
        "CollisionType": "Regular", "Friction": 0.7, "Restitution": 0.1,
        "Density": 0.5, "SurfaceType": surface, "Roughness": 1,
        "Metallic": 0, "PrimaryColor": {"R": 1, "G": 1, "B": 1},
        "SecondaryColor": {"R": 0, "G": 0, "B": 0}, "Flippable": True,
        "AutoStraighten": False, "ShouldSnap": True, "ScriptName": "",
        "Blueprint": "", "Models": [], "Collision": [], "SnapPointsGlobal": False,
        "SnapPoints": [], "ZoomViewDirection": {"X": 0, "Y": 0, "Z": 0}, "Tags": [],
    }


def create_thumbnail(game: dict, first_face: Path, output: Path):
    canvas = Image.new("RGB", (640, 360), "#17211f")
    with Image.open(first_face) as source:
        image = source.convert("RGB")
        image.thumbnail((260, 330), Image.Resampling.LANCZOS)
        canvas.paste(image, (28, (360 - image.height) // 2))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("Arial Bold.ttf", 34)
        small = ImageFont.truetype("Arial.ttf", 18)
    except OSError:
        font = small = ImageFont.load_default()
    title = str(game.get("title", game["id"]))
    words, lines, current = title.split(), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=font)[2] > 320 and current:
            lines.append(current); current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    y = 110
    for line in lines[:3]:
        draw.text((310, y), line, fill="white", font=font); y += 43
    draw.text((312, min(300, y + 12)), "Forge exact-version package", fill="#a8c7ba", font=small)
    canvas.save(output, quality=92, optimize=True)


def world_point(position: dict, board: dict):
    return ((float(position["x"]) - board["width"] / 2) * WORLD_SCALE,
            (board["height"] / 2 - float(position["y"])) * WORLD_SCALE)


def zone_point(zone: dict, board: dict):
    position, size = zone["position"], zone["size"]
    return world_point({"x": position["x"] + size["width"] / 2,
                        "y": position["y"] + size["height"] / 2}, board)


def quaternion(face="up", degrees=0):
    radians = math.radians(float(degrees)) / 2
    if face == "down":
        # 180 degrees around local X, plus the requested table rotation.
        return {"x": round(math.cos(radians), 8), "y": round(-math.sin(radians), 8),
                "z": 0, "w": 0}
    return {"x": 0, "y": 0, "z": round(math.sin(radians), 8), "w": round(math.cos(radians), 8)}


class StateIds:
    def __init__(self):
        self.value = 0

    def next(self):
        value, chars = self.value, "0123456789abcdefghijklmnopqrstuvwxyz"
        self.value += 1
        out = ""
        for _ in range(3):
            out = chars[value % 36] + out; value //= 36
        return out


def state_card(package_guid: str, name: str, specs: list[dict], x: float, y: float,
               ids: StateIds, face="up", rotation=0, tags=None, grounded=False):
    if not specs:
        raise ValueError(f"cannot stage empty stack '{name}'")
    first, rest = specs[0], specs[1:]
    return {
        "objectType": "Card",
        "transform": {"rotation": quaternion(face, rotation),
                      "translation": {"x": round(x, 6), "y": round(y, 6), "z": 1.1},
                      "scale3D": {"x": 1, "y": 1, "z": 1}},
        "simulatingPhysics": not grounded, "atlasIndex": first["index"],
        "frontTextureOverride": "", "inHand": False,
        "stackSerialization": [{"index": spec["index"], "templateId": spec["template"],
                                "frontTextureOverride": "", "flipped": False}
                               for spec in rest],
        "primaryColor": {"b": 255, "g": 255, "r": 255, "a": 255},
        "secondaryColor": {"b": 0, "g": 0, "r": 0, "a": 255},
        "metallic": 0, "roughness": 1, "friction": 0.7, "restitution": 0,
        "density": 0.5, "surfaceType": "SurfaceType4", "objectName": name,
        "objectDescription": "Generated from an exact Forge version.",
        "collisionType": "CB_Ground" if grounded else "CB_Regular",
        "templateId": first["template"], "shouldSnap": not grounded,
        "previousPosition": {"x": 0, "y": 0, "z": 0},
        "objectScriptPackage": package_guid, "objectScriptName": "",
        "persistentData": "", "persistentKeyData": {}, "uniqueId": ids.next(),
        "drawingLines": [], "objectTags": list(tags or []), "objectGroupId": -1,
        "ownerIndex": -1, "lightsOn": True, "bCanBeDamaged": False,
    }


def build_card_state(game: dict, game_dir: Path, printings: list[dict], catalog: dict,
                     setup: dict | None, ref: str, package_guid: str, ids: StateIds):
    printing_by_card = {}
    for printing in printings:
        printing_by_card.setdefault(printing["card_id"], catalog[printing["id"]])
    if not setup:
        specs = []
        for printing in printings:
            specs.extend([catalog[printing["id"]]] * max(1, int(printing.get("quantity", 1))))
        return [state_card(package_guid, f"{game.get('title', game['id'])} deck", specs,
                           0, 0, ids, "down", tags=[game["id"], "forge-card-stack"])], []
    board = setup["board"]
    zones = {zone["id"]: zone for zone in setup.get("zones", [])}
    decks = {deck["id"]: deck for deck in load_documents(game_dir / "decks")}
    placed = Counter()
    for placement in setup.get("placements", []):
        placed[(placement["deck_id"], placement["card_id"])] += int(placement.get("quantity", 1))
    objects, receipts = [], []
    for placement in setup.get("placements", []):
        zone = zones.get(placement["zone_id"])
        spec = printing_by_card.get(placement["card_id"])
        if not zone or not spec:
            raise ValueError(f"card placement '{placement['id']}' has a missing zone or printing")
        x, y = zone_point(zone, board)
        for copy in range(int(placement.get("quantity", 1))):
            objects.append(state_card(package_guid, placement.get("name") or spec["card"].get("name"),
                                      [spec], x + copy * .18, y, ids, placement.get("face", "up"),
                                      zone.get("rotation", 0), [game["id"], f"zone:{zone['id']}"]))
        receipts.append({"id": placement["id"], "kind": "card", "zone": zone["id"],
                         "quantity": int(placement.get("quantity", 1))})
    for stack in setup.get("stacks", []):
        deck, zone = decks.get(stack["deck_id"]), zones.get(stack["zone_id"])
        if not deck or not zone:
            raise ValueError(f"stack '{stack['id']}' has a missing deck or zone")
        specs = []
        for card_id, quantity in deck.get("cards", {}).items():
            remaining = int(quantity) - placed[(deck["id"], card_id)]
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
        x, y = zone_point(zone, board)
        objects.append(state_card(package_guid, stack.get("name") or deck.get("name") or stack["id"],
                                  specs, x, y, ids, stack.get("face", "down"), zone.get("rotation", 0),
                                  [game["id"], "forge-card-stack", f"zone:{zone['id']}"]))
        receipts.append({"id": stack["id"], "kind": "deck", "zone": zone["id"], "quantity": len(specs)})
    return objects, receipts


def component_templates(game: dict, game_dir: Path, package: Path, package_guid: str, ref: str):
    tokens = game_dir / "components" / "tokens.json"
    if not tokens.is_file() or not load_json(tokens):
        return [], {}, None
    rendered = package / ".component-render"
    result = subprocess.run(["node", str(ROOT / "tools" / "render_components.mjs"), str(game_dir),
                             str(rendered), "--ref", ref], cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        raise ValueError(result.stderr.strip() or result.stdout.strip() or "component rendering failed")
    manifest = load_json(rendered / "component-assets.json")
    templates, specs = [], {}
    target = package / "Textures" / "components"
    target.mkdir(parents=True, exist_ok=True)
    for component in manifest.get("components", []):
        if component.get("kind") == "die":
            raise ValueError(f"component '{component['id']}' is a die; TTPG needs a committed model and face-orientation map, which Forge does not fabricate")
        assets = {asset["side"]: asset for asset in component.get("assets", [])}
        if "front" not in assets:
            raise ValueError(f"component '{component['id']}' has no rendered front")
        for asset in assets.values():
            shutil.copyfile(rendered / asset["file"], target / asset["file"])
        guid = stable_guid(package_guid, "component", component["id"])
        shape = {"circle": "Round", "hexagon": "Hexagonal", "rectangle": "Square"}.get(component.get("shape"), "Rounded")
        template = base_template(guid, component["name"])
        template["Metadata"] = json.dumps({"forge_component_id": component["id"], "forge_ref": ref,
                                            "rights": component.get("artwork", [])}, ensure_ascii=False, sort_keys=True)
        template["Tags"] = [game["id"], "forge-component", f"kind:{component['kind']}"]
        template.update({
            "Type": "Card", "FrontTexture": f"components/{assets['front']['file']}",
            "BackTexture": f"components/{assets.get('back', assets['front'])['file']}",
            "HiddenTexture": "", "BackIndex": -2, "HiddenIndex": -3,
            "NumHorizontal": 1, "NumVertical": 1,
            "Width": round(float(component["size_mm"]["width"]) / 10, 4),
            "Height": round(float(component["size_mm"]["height"]) / 10, 4),
            "Thickness": 0.08 if component["kind"] != "board" else 0.12,
            "HiddenInHand": False, "UsedWithCardHolders": False,
            "CanStack": component["kind"] not in ("board", "dial", "standee", "meeple", "figurine"),
            "UsePrimaryColorForSide": False, "FrontTextureOverrideExposed": False,
            "AllowFlippedInStack": False, "MirrorBack": True, "Model": shape,
            "Indices": [0], "CardNames": {"0": component["name"]},
            "CardMetadata": {"0": template["Metadata"]},
            "CardTags": {"0": template["Tags"]},
        })
        templates.append(template)
        specs[component["id"]] = {"template": guid, "index": 0, "component": component}
    shutil.rmtree(rendered)
    return templates, specs, manifest


def build_component_state(game: dict, setup: dict | None, specs: dict, package_guid: str, ids: StateIds):
    if not specs:
        return [], []
    board = setup.get("board") if setup else {"width": 1600, "height": 1000}
    used = Counter()
    objects, receipts = [], []
    for placement in (setup or {}).get("pieces", []):
        spec = specs.get(placement["component_id"])
        if not spec:
            raise ValueError(f"piece placement '{placement['id']}' references missing component '{placement['component_id']}'")
        x, y = world_point(placement["position"], board)
        quantity = int(placement.get("quantity", 1))
        component = spec["component"]
        for copy in range(quantity):
            objects.append(state_card(package_guid, placement.get("name") or component["name"], [spec],
                                      x + copy * .15, y + copy * .15, ids,
                                      "down" if placement.get("face") == "back" else "up",
                                      placement.get("rotation", 0), [game["id"], f"component:{component['id']}"],
                                      grounded=component["kind"] == "board"))
        used[component["id"]] += quantity
        receipts.append({"id": placement["id"], "kind": "component", "component_id": component["id"],
                         "quantity": quantity})
    supply = 0
    for component_id, spec in specs.items():
        component = spec["component"]
        remaining = int(component.get("resolved_quantity", 1)) - used[component_id]
        if remaining < 0:
            raise ValueError(f"setup places more '{component_id}' pieces than the committed inventory contains")
        if not remaining:
            continue
        stackable = component["kind"] not in ("board", "dial", "standee", "meeple", "figurine")
        columns = min(8, remaining) if stackable else 1
        for offset in range(0, remaining, columns):
            count = min(columns, remaining - offset)
            row, column = divmod(supply, 4)
            x = (board["width"] / 2 - 120 - column * 115) * WORLD_SCALE
            y = (board["height"] / 2 - 80 - row * 115) * WORLD_SCALE
            objects.append(state_card(package_guid, f"{component['name']} supply", [spec] * count,
                                      x, -y, ids, "up", tags=[game["id"], "forge-component-supply",
                                                              f"component:{component_id}"],
                                      grounded=component["kind"] == "board"))
            supply += 1
    return objects, receipts


def counter_template(game: dict, counter: dict, package: Path, package_guid: str, ref: str):
    guid = stable_guid(package_guid, "counter", counter["id"])
    filename = f"counters/{counter['id']}.png"
    path = package / "Textures" / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    color = counter.get("color") or "#39424e"
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((12, 12, 500, 500), fill=color, outline="#f5f5f5", width=15)
    try:
        large = ImageFont.truetype("Arial Bold.ttf", 210)
        small = ImageFont.truetype("Arial Bold.ttf", 39)
    except OSError:
        large = small = ImageFont.load_default()
    value = str(counter["initial"])
    bounds = draw.textbbox((0, 0), value, font=large)
    draw.text(((512 - (bounds[2] - bounds[0])) / 2, 105), value, fill="white", font=large)
    label = counter["name"][:22].upper()
    bounds = draw.textbbox((0, 0), label, font=small)
    draw.text(((512 - (bounds[2] - bounds[0])) / 2, 385), label, fill="white", font=small)
    image.save(path, optimize=True)
    template = base_template(guid, counter["name"])
    metadata = json.dumps({"forge_counter_id": counter["id"], "forge_ref": ref,
                           "initial": counter["initial"],
                           "minimum": counter.get("minimum"), "maximum": counter.get("maximum")}, sort_keys=True)
    template.update({"Type": "Card", "Metadata": metadata, "FrontTexture": filename,
                     "BackTexture": filename, "HiddenTexture": "", "BackIndex": -2, "HiddenIndex": -3,
                     "NumHorizontal": 1, "NumVertical": 1, "Width": 2.5, "Height": 2.5,
                     "Thickness": 0.1, "HiddenInHand": False, "UsedWithCardHolders": False,
                     "CanStack": False, "UsePrimaryColorForSide": False,
                     "FrontTextureOverrideExposed": False, "AllowFlippedInStack": False,
                     "MirrorBack": True, "Model": "Round", "Indices": [0],
                     "CardNames": {"0": counter["name"]}, "CardMetadata": {"0": metadata},
                     "CardTags": {"0": [game["id"], "forge-setup-counter", f"counter:{counter['id']}"]},
                     "Tags": [game["id"], "forge-setup-counter"]})
    return template, {"template": guid, "index": 0}


def state_document(game: dict, setup: dict | None, package_guid: str, ref: str, objects: list[dict]):
    seats = (setup or {}).get("seats", [])
    names = [seat["name"] for seat in seats][:20]
    names.extend([f"Player {index + 1}" for index in range(len(names), 20)])
    colors = []
    for seat in seats[:20]:
        raw = str(seat.get("color") or "#999999").lstrip("#")
        try:
            colors.append({"r": int(raw[0:2], 16), "g": int(raw[2:4], 16), "b": int(raw[4:6], 16)})
        except (ValueError, IndexError):
            colors.append(False)
    colors.extend([False] * (20 - len(colors)))
    instructions = "\n".join((setup or {}).get("instructions", []))
    notes = f"{game.get('title', game['id'])}\nForge exact version: {ref}"
    if setup:
        notes += f"\nSetup: {setup['name']} ({setup['id']})"
    if instructions:
        notes += f"\n\n{instructions}"
    permissions = {name: -1 for name in ("delete", "objectLibrary", "copyPaste", "cardPeek",
                   "cardExplorer", "containerExplorer", "changeOwner", "changeTeam", "editZones",
                   "draw", "ground", "throw", "editLabels", "saveGame", "spectators")}
    return {
        "saveStateVersion": SAVE_STATE_VERSION,
        "gameState": {"measureUnit": 2.54, "rotationStep": 15, "notes": notes, "turnInfo": {},
                      "slotTeams": [0] * 20, "globalScriptPackage": "0" * 32,
                      "globalScriptName": "", "backgroundTexture": {"resourceName": "", "packageGuid": "0" * 32},
                      "phases": [], "spectatorsSeeEverything": False, "persistentData": "",
                      "persistentKeyData": {"forge": json.dumps({"game": game["id"], "ref": ref,
                                                                   "setup": (setup or {}).get("id")}, sort_keys=True)},
                      "permissions": permissions, "physicsLocked": False, "measureAngles": "None",
                      "alwaysSnap": True, "liftOverRegular": True, "gravityMultiplier": 1,
                      "slotIds": [""] * 20, "mapName": "HDRI_Milkyway", "currentTurn": 0,
                      "bCanBeDamaged": False},
        "requiredPackages": [{"name": game.get("title", game["id"]), "guid": package_guid}],
        "storedCameraSetups": [False] * 10, "playerCameraSetups": [False] * 20,
        "playerSlotNames": names, "customPlayerColors": colors,
        "lighting": {"intensity": 1, "specular": 1, "altitude": 90, "azimuth": 0,
                     "color": {"r": 255, "g": 255, "b": 255}},
        "floorHidden": False,
        "grid": {"type": 0, "snapType": 0, "visibility": 0,
                 "size": {"x": 2.54, "y": 2.54}, "offset": {"x": 0, "y": 0},
                 "rotation": 0, "color": {"r": 0, "g": 0, "b": 0, "a": 90}},
        "objects": objects, "zones": [], "labels": [],
    }


def main():
    parser = argparse.ArgumentParser(description="Forge exact version -> Tabletop Playground package")
    parser.add_argument("game_dir")
    parser.add_argument("--setup", help="setup id or filename stem (default: first setup)")
    parser.add_argument("--ref", default="working-tree")
    parser.add_argument("--output-dir")
    args = parser.parse_args()
    game_dir = Path(args.game_dir).resolve()
    game = yaml.safe_load((game_dir / "game.yaml").read_text())
    cards = load_json(game_dir / "components" / "cards.json")
    printings = load_json(game_dir / "components" / "printings.json")
    if not printings:
        raise ValueError("no printings to export")
    setup, setup_source = choose_setup(game_dir, args.setup)
    output = Path(args.output_dir).resolve() if args.output_dir else game_dir / "exports" / "ttPG"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    slug = safe_name(game.get("id") or game_dir.name).lower()
    package_name = safe_name(game.get("title") or slug)
    package = output / package_name
    textures, states = package / "Textures", package / "States"
    textures.mkdir(parents=True); states.mkdir(parents=True)
    package_guid = stable_guid("forge-ttpg-package", game["id"])

    card_templates, catalog, atlas_outputs, rendered_faces = card_atlases(
        game_dir, game, cards, printings, textures, package_guid)
    component_docs, component_specs, component_manifest = component_templates(game, game_dir, package, package_guid, args.ref)
    ids = StateIds()
    card_objects, card_receipts = build_card_state(game, game_dir, printings, catalog, setup,
                                                   args.ref, package_guid, ids)
    component_objects, component_receipts = build_component_state(game, setup, component_specs, package_guid, ids)
    counter_docs, counter_objects = [], []
    if setup:
        for counter in setup.get("counters", []):
            template, spec = counter_template(game, counter, package, package_guid, args.ref)
            counter_docs.append(template)
            x, y = world_point(counter["position"], setup["board"])
            counter_objects.append(state_card(package_guid, counter["name"], [spec], x, y, ids,
                                              tags=[game["id"], "forge-setup-counter", f"counter:{counter['id']}"]))

    manifest = {"Name": game.get("title", game["id"]), "Version": "1", "GUID": package_guid,
                "CopyProtection": False}
    # The package descriptor is case-sensitive on Windows/Linux installs.
    # Tabletop Playground's package contract names it ``Manifest.json``.
    (package / "Manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    for template in [*card_templates, *component_docs, *counter_docs]:
        (package / f"{template['GUID']}.json").write_text(json.dumps(template, indent=2, ensure_ascii=False) + "\n")
    state_name = f"{package_name}.vts"
    state = state_document(game, setup, package_guid, args.ref,
                           [*card_objects, *component_objects, *counter_objects])
    (states / state_name).write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    first_face = rendered_faces / f"{printings[0]['id']}.png"
    create_thumbnail(game, first_face, package / "Thumbnail.jpg")
    shutil.rmtree(rendered_faces)

    receipt = {
        "format": "forge-tabletop-playground", "version": ADAPTER_VERSION,
        "adapter": {"target": "Tabletop Playground", "object_template_schema_commit": SCHEMA_COMMIT,
                    "save_state_version": SAVE_STATE_VERSION},
        "source_ref": args.ref, "game_id": game["id"], "package_guid": package_guid,
        "setup": {"id": setup["id"], "source": setup_source} if setup else None,
        "outputs": {"state": f"States/{state_name}", "card_atlases": atlas_outputs,
                    "templates": len(card_templates) + len(component_docs) + len(counter_docs)},
        "objects": {"card_stacks": len(card_objects), "components": len(component_objects),
                    "setup_counters": len(counter_objects), "total": len(state["objects"])},
        "placements": [*card_receipts, *component_receipts],
        "rights": {"game_license": game.get("license"),
                   "component_assets": component_manifest.get("rights") if component_manifest else None},
        "boundaries": [
            "Forge source data, design assets, artwork rights, setup, and Git ref remain authoritative; package JSON and textures are derived.",
            "The ZIP installs as a local Tabletop Playground package. Uploading to mod.io is an explicit editor action and is not performed or claimed by Forge.",
            "Cards, committed deck quantities, explicit setup placements, remaining component inventory, and initial setup counters are staged in the saved state.",
            "Setup counters are visible initial-value markers; bounds are preserved in metadata but not enforced by a script.",
            "Custom dice fail closed until the game commits a model and face-orientation map.",
        ],
    }
    (package / "forge-ttpg-receipt.json").write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
    (package / "README.txt").write_text(
        f"{game.get('title', game['id'])} — Forge Tabletop Playground package\n\n"
        f"Exact Forge source: {args.ref}\n"
        f"Install: unzip this package folder into TabletopPlayground/PersistentDownloadDir, then load '{state_name}' in the editor/game.\n"
        "Publish: review the package in the Tabletop Playground editor and use its mod.io upload action. Forge does not upload it.\n"
    )
    archive = output / f"{slug}-ttpg-v{ADAPTER_VERSION}.zip"
    write_directory_zip(archive, package, package.name)
    receipt["archive"] = {"file": archive.name, "bytes": archive.stat().st_size, "sha256": sha256(archive)}
    (output / "ttpg-manifest.json").write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
    print(f"Tabletop Playground package: {archive} ({len(state['objects'])} staged objects, "
          f"{receipt['outputs']['templates']} templates)")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"export_ttpg: {error}", file=__import__("sys").stderr)
        raise SystemExit(1)
