#!/usr/bin/env python3
"""Export a Forge setup as a native VirtualTabletop.io game.

The source of truth remains the Forge project: decks, card printings, and
setups/*.yaml. This adapter emits both a readable state JSON and an importable
.vtt ZIP. With --face-base-url, card images stay at immutable Forge cache URLs;
without it, canonical card renders are embedded in the .vtt package.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
import sys
import zlib
from pathlib import Path

from deterministic_archive import write_deterministic_zip

ROOT = Path(__file__).resolve().parent.parent
VTT_STATE_VERSION = 24
VTT_PINNED_COMMIT = "193a2e64709e46d6337d0e67168fdc1c6b7eb4da"
CARD_WIDTH = 103
CARD_HEIGHT = 160


def load_json(path: Path):
    return json.loads(path.read_text())


def load_yaml(path: Path):
    # Forge already ships js-yaml for its canonical Node validator and CLI.
    # Keeping this adapter on that parser avoids a second runtime dependency
    # solely for reading the setup document.
    script = (
        "import fs from 'node:fs'; import yaml from 'js-yaml'; "
        "process.stdout.write(JSON.stringify(yaml.load(fs.readFileSync(process.argv[1], 'utf8')) || {}));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script, str(path)],
        cwd=ROOT, capture_output=True, text=True,
    )
    if result.returncode:
        raise ValueError(f"could not parse {path}: {result.stderr.strip()}")
    return json.loads(result.stdout)


def load_documents(directory: Path):
    documents = []
    if not directory.is_dir():
        return documents
    for path in sorted(directory.iterdir()):
        if path.suffix.lower() not in (".json", ".yaml", ".yml"):
            continue
        doc = load_json(path) if path.suffix.lower() == ".json" else load_yaml(path)
        documents.extend(doc if isinstance(doc, list) else [doc])
    return documents


def choose_setup(game_dir: Path, requested: str | None):
    setup_dir = game_dir / "setups"
    paths = sorted(p for p in setup_dir.glob("*") if p.suffix.lower() in (".json", ".yaml", ".yml"))
    if not paths:
        raise ValueError("game has no setups/*.yaml; add a versioned setup before exporting a playable table")
    if requested:
        direct = Path(requested)
        if direct.is_file():
            return load_json(direct) if direct.suffix.lower() == ".json" else load_yaml(direct)
        for path in paths:
            doc = load_json(path) if path.suffix.lower() == ".json" else load_yaml(path)
            if doc.get("id") == requested or path.stem == requested:
                return doc
        raise ValueError(f"setup '{requested}' was not found")
    path = paths[0]
    return load_json(path) if path.suffix.lower() == ".json" else load_yaml(path)


def signed_crc32(data: bytes) -> int:
    value = zlib.crc32(data) & 0xFFFFFFFF
    return value - 0x100000000 if value >= 0x80000000 else value


class FaceResolver:
    def __init__(self, base_url: str | None, faces_dir: Path):
        self.base_url = base_url.rstrip("/") if base_url else None
        self.faces_dir = faces_dir
        self.assets: dict[str, bytes] = {}

    def url(self, filename: str) -> str:
        if self.base_url:
            return f"{self.base_url}/{filename}"
        path = self.faces_dir / filename
        if not path.is_file():
            raise ValueError(f"missing rendered face {path}")
        data = path.read_bytes()
        asset_name = f"{signed_crc32(data)}_{len(data)}"
        self.assets[asset_name] = data
        return f"/assets/{asset_name}"


def zone_widget(zone: dict) -> dict:
    position, size = zone["position"], zone["size"]
    layout = zone.get("layout", "free")
    widget = {
        "type": "holder",
        "id": zone["id"],
        "x": position["x"],
        "y": position["y"],
        "width": size["width"],
        "height": size["height"],
        "rotation": zone.get("rotation", 0),
        "text": zone["name"],
        "color": zone.get("color", "#ffffff18"),
        "textColor": "#ffffffaa",
        "dropTarget": {"type": "card"},
        "dropShadow": True,
        "alignChildren": layout != "free",
        "preventPiles": layout == "spread",
        "stackOffsetX": 30 if layout == "spread" else 0,
        "stackOffsetY": 0,
        "childrenPerOwner": zone.get("kind") == "hand",
        "css": {
            "border": "1px solid #ffffff35",
            "font-size": "13px",
            "font-weight": "600",
        },
    }
    if zone.get("visibility") == "seat":
        widget["onlyVisibleForSeat"] = zone["seat_id"]
        widget["linkedToSeat"] = zone["seat_id"]
    face = zone.get("card_face", "unchanged")
    if face != "unchanged":
        widget["onEnter"] = {"activeFace": 1 if face == "up" else 0}
    return widget


def counter_widget(counter: dict) -> dict:
    position = counter["position"]
    return {
        "type": "label",
        "id": counter["id"],
        "x": position["x"],
        "y": position["y"],
        "width": 185,
        "height": 30,
        "text": f"{counter['name']}: {counter['initial']}",
        "editable": True,
        "movable": False,
        "css": {
            "background": counter.get("color", "#39424e"),
            "border": "1px solid #ffffff55",
            "border-radius": "6px",
            "color": "white",
            "font-size": "14px",
            "font-weight": "700",
            "padding": "5px 8px",
        },
        "forgeCounter": {
            "initial": counter["initial"],
            "minimum": counter.get("minimum"),
            "maximum": counter.get("maximum"),
        },
    }


def build_state(game_dir: Path, setup: dict, face_resolver: FaceResolver, ref: str) -> dict:
    game = load_yaml(game_dir / "game.yaml")
    cards = load_json(game_dir / "components" / "cards.json")
    printings = load_json(game_dir / "components" / "printings.json")
    decks = load_documents(game_dir / "decks")
    cards_by_id = {card["id"]: card for card in cards}
    decks_by_id = {deck["id"]: deck for deck in decks}
    printing_by_card = {}
    for printing in printings:
        printing_by_card.setdefault(printing["card_id"], printing)

    used_card_ids = set()
    for stack in setup.get("stacks", []):
        deck = decks_by_id.get(stack["deck_id"])
        if not deck:
            raise ValueError(f"stack '{stack['id']}' references missing deck '{stack['deck_id']}'")
        used_card_ids.update(deck.get("cards", {}))
    for placement in setup.get("placements", []):
        used_card_ids.add(placement["card_id"])
    missing_printings = sorted(cid for cid in used_card_ids if cid not in printing_by_card)
    if missing_printings:
        raise ValueError(f"cards have no printing: {', '.join(missing_printings)}")

    back_url = face_resolver.url("_back.png")
    card_types = {}
    for card_id in sorted(used_card_ids):
        printing = printing_by_card[card_id]
        card = cards_by_id[card_id]
        card_types[printing["id"]] = {
            "front": face_resolver.url(f"{printing['id']}.png"),
            "name": card.get("name", card_id),
            "forgeCardID": card_id,
            "forgePrintingID": printing["id"],
        }

    board = setup["board"]
    state = {
        "_meta": {
            "version": VTT_STATE_VERSION,
            "gameSettings": {
                "boardSize": {"width": board["width"], "height": board["height"]},
                "legacyModes": {},
            },
            "info": {
                "name": f"{game.get('title', game.get('id', 'Forge game'))} · {setup['name']}",
                "description": setup.get("description", "Generated from a versioned Forge setup."),
                "players": str(len(setup.get("seats", []))),
                "mode": "vs" if len(setup.get("seats", [])) == 2 else "co-op",
                "attribution": f"Generated by Forge from {game.get('id', game_dir.name)} at {ref}.",
                "forgeRef": ref,
                "forgeSetup": setup["id"],
                "forgeAdapter": f"virtualtabletop@{VTT_PINNED_COMMIT}",
            },
        }
    }

    state["forge-board"] = {
        "id": "forge-board",
        "x": 0,
        "y": 0,
        "width": board["width"],
        "height": board["height"],
        "layer": -6,
        "movable": False,
        "clickable": False,
        "css": {
            "background": board.get("background", "#17211f"),
            "border": "none",
        },
    }

    state["forge-card-model"] = {
        "type": "deck",
        "id": "forge-card-model",
        "x": -500,
        "y": -500,
        "scale": 0,
        "cardDefaults": {"width": CARD_WIDTH, "height": CARD_HEIGHT},
        "cardTypes": card_types,
        "faceTemplates": [
            {
                "objects": [{
                    "type": "image", "x": 0, "y": 0,
                    "width": CARD_WIDTH, "height": CARD_HEIGHT,
                    "value": back_url,
                }]
            },
            {
                "objects": [{
                    "type": "image", "x": 0, "y": 0,
                    "width": CARD_WIDTH, "height": CARD_HEIGHT,
                    "dynamicProperties": {"value": "front"},
                }]
            },
        ],
    }

    zones_by_id = {zone["id"]: zone for zone in setup.get("zones", [])}
    hand_by_seat = {zone.get("seat_id"): zone["id"] for zone in setup.get("zones", []) if zone.get("kind") == "hand"}

    for index, seat in enumerate(setup.get("seats", []), 1):
        position = seat["position"]
        state[seat["id"]] = {
            "type": "seat",
            "id": seat["id"],
            "index": index,
            "x": position["x"],
            "y": position["y"],
            "width": 180,
            "height": 40,
            "rotation": seat.get("rotation", 0),
            "display": f"{seat['name']} · playerName",
            "displayEmpty": f"Sit as {seat['name']}",
            "player": "",
            "color": seat.get("color", "#999999"),
            "colorEmpty": seat.get("color", "#999999"),
            "hand": hand_by_seat.get(seat["id"]),
        }

    for zone in setup.get("zones", []):
        state[zone["id"]] = zone_widget(zone)

    state["forge-build"] = {
        "type": "label",
        "id": "forge-build",
        "x": 260,
        "y": board["height"] / 2 - 20,
        "width": board["width"] - 520,
        "height": 40,
        "text": f"{game.get('title', game.get('id', game_dir.name))} · {setup['name']} · {ref[:12]}",
        "css": {
            "color": "#ffffffcc",
            "font-size": "18px",
            "font-weight": "800",
            "text-align": "center",
        },
    }

    for counter in setup.get("counters", []):
        state[counter["id"]] = counter_widget(counter)

    placed_by_deck_card = {}
    for placement in setup.get("placements", []):
        key = (placement["deck_id"], placement["card_id"])
        placed_by_deck_card[key] = placed_by_deck_card.get(key, 0) + placement.get("quantity", 1)

    z = 10

    def add_card(instance_id: str, card_id: str, zone_id: str, face: str, copy_index: int):
        nonlocal z
        if zone_id not in zones_by_id:
            raise ValueError(f"card '{instance_id}' references missing zone '{zone_id}'")
        printing = printing_by_card[card_id]
        state[instance_id] = {
            "type": "card",
            "id": instance_id,
            "deck": "forge-card-model",
            "cardType": printing["id"],
            "parent": zone_id,
            "x": 8 + (copy_index % 5) * 0.01,
            "y": 8 + (copy_index % 7) * 0.01,
            "z": z,
            "activeFace": 1 if face == "up" else 0,
            "forgeCardID": card_id,
            "forgePrintingID": printing["id"],
        }
        z += 1

    for placement in setup.get("placements", []):
        for copy in range(placement.get("quantity", 1)):
            suffix = f"-{copy + 1}" if placement.get("quantity", 1) > 1 else ""
            add_card(f"{placement['id']}{suffix}", placement["card_id"], placement["zone_id"], placement.get("face", "up"), copy)

    for stack in setup.get("stacks", []):
        deck = decks_by_id[stack["deck_id"]]
        copies = []
        for card_id, quantity in deck.get("cards", {}).items():
            remaining = quantity - placed_by_deck_card.get((deck["id"], card_id), 0)
            if remaining < 0:
                raise ValueError(f"setup removes more '{card_id}' cards than deck '{deck['id']}' contains")
            copies.extend(card_id for _ in range(remaining))
        if stack.get("shuffle"):
            seed = hashlib.sha256(f"{game.get('id')}:{setup['id']}:{stack['id']}:{ref}".encode()).digest()
            random.Random(seed).shuffle(copies)
        occurrence = {}
        for copy_index, card_id in enumerate(copies):
            occurrence[card_id] = occurrence.get(card_id, 0) + 1
            add_card(
                f"{stack['id']}-{card_id}-{occurrence[card_id]}",
                card_id,
                stack["zone_id"],
                stack.get("face", "down"),
                copy_index,
            )

    return state


def main():
    parser = argparse.ArgumentParser(description="Forge setup -> VirtualTabletop.io state + .vtt package")
    parser.add_argument("game_dir")
    parser.add_argument("--setup", help="setup id, filename stem, or path (default: first setup)")
    parser.add_argument("--face-base-url", help="immutable URL containing <printing-id>.png and _back.png")
    parser.add_argument("--bundle-faces-dir", help="render directory to embed in the .vtt while JSON keeps --face-base-url URLs")
    parser.add_argument("--out-dir", help="output directory (default: <game>/exports/vtt)")
    parser.add_argument("--json-name", default="table.json")
    parser.add_argument("--package-name", default="table.vtt")
    parser.add_argument("--ref", default="working-tree", help="Forge commit/ref recorded in generated metadata")
    args = parser.parse_args()

    game_dir = Path(args.game_dir).resolve()
    out_dir = Path(args.out_dir).resolve() if args.out_dir else game_dir / "exports" / "vtt"
    out_dir.mkdir(parents=True, exist_ok=True)
    setup = choose_setup(game_dir, args.setup)

    faces_dir = out_dir / "faces"
    if not args.face_base_url:
        faces_dir.mkdir(parents=True, exist_ok=True)
        render = subprocess.run(
            ["node", str(ROOT / "tools" / "render_cards.mjs"), str(game_dir), str(faces_dir)],
            text=True,
        )
        if render.returncode:
            raise SystemExit(render.returncode)

    resolver = FaceResolver(args.face_base_url, faces_dir)
    state = build_state(game_dir, setup, resolver, args.ref)
    json_path = out_dir / args.json_name
    package_path = out_dir / args.package_name
    encoded = json.dumps(state, indent=2, ensure_ascii=False) + "\n"
    json_path.write_text(encoded)
    package_state, package_assets = state, resolver.assets
    if args.bundle_faces_dir:
        package_resolver = FaceResolver(None, Path(args.bundle_faces_dir).resolve())
        package_state = build_state(game_dir, setup, package_resolver, args.ref)
        package_assets = package_resolver.assets
    package_encoded = json.dumps(package_state, indent=2, ensure_ascii=False) + "\n"
    write_deterministic_zip(package_path,
                            [("0.json", package_encoded.encode("utf-8"))]
                            + [(f"assets/{name}", data) for name, data in package_assets.items()])

    card_count = sum(1 for widget in state.values() if isinstance(widget, dict) and widget.get("type") == "card")
    print(f"VTT state: {json_path}")
    print(f"VTT package: {package_path}")
    print(f"Setup: {setup['id']} · {card_count} cards · {len(setup.get('seats', []))} seats")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError) as error:
        print(f"export_vtt: {error}", file=sys.stderr)
        raise SystemExit(1)
