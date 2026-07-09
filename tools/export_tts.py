#!/usr/bin/env python3
"""export_tts.py - Tabletop Simulator exporter, format v0.1.
Usage: python3 tools/export_tts.py <game-dir> [--face-url URL] [--back-url URL]
Builds the sprite sheet (TTS limits: max 10x7 grid, <=4096px) and the save
JSON (DeckCustom, CardID = deckIndex*100 + sheetPosition), honoring quantities.
Asset URLs default to file:// paths for local testing; the platform will
substitute permanent hosted URLs (dead links are how TTS mods rot).
Output: exports/tts/
"""
import json, sys
from pathlib import Path

import yaml
from PIL import Image

MAX_COLS, MAX_SHEET = 10, 4096

def main():
    args = sys.argv[1:]
    game_dir = Path(args[0])
    def opt(name, default):
        return args[args.index(name) + 1] if name in args else default

    game = yaml.safe_load((game_dir / "game.yaml").read_text())
    cards = {c["id"]: c for c in json.loads((game_dir / "components/cards.json").read_text())}
    printings = json.loads((game_dir / "components/printings.json").read_text())
    faces_dir = game_dir / "exports" / "faces"
    out_dir = game_dir / "exports" / "tts"
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- sprite sheet: one slot per UNIQUE printing ----
    n = len(printings)
    cols = min(MAX_COLS, n)
    rows = -(-n // cols)
    if rows > 7: raise SystemExit("More than 70 printings: split into multiple CustomDecks (not yet implemented).")
    cw, ch = 750, 1050
    scale = min(1.0, MAX_SHEET / (cols * cw), MAX_SHEET / (rows * ch))
    cw, ch = int(cw * scale), int(ch * scale)
    sheet = Image.new("RGB", (cols * cw, rows * ch), "white")
    for i, p in enumerate(printings):
        img = Image.open(faces_dir / f"{p['id']}.png")
        if scale < 1.0: img = img.resize((cw, ch), Image.LANCZOS)
        sheet.paste(img, ((i % cols) * cw, (i // cols) * ch))
    sheet_path = out_dir / "sheet.png"
    sheet.save(sheet_path)

    back_src = faces_dir / "_back.png"
    back_path = out_dir / "back.png"
    Image.open(back_src).save(back_path)

    face_url = opt("--face-url", sheet_path.resolve().as_uri())
    back_url = opt("--back-url", back_path.resolve().as_uri())

    # ---- save JSON ----
    deck_ids, contained = [], []
    for i, p in enumerate(printings):
        card_id = 100 + i  # deckIndex 1, sheet position i
        c = cards[p["card_id"]]
        for _ in range(p.get("quantity", 1)):
            deck_ids.append(card_id)
            contained.append({
                "Name": "Card", "CardID": card_id,
                "Nickname": c["name"],
                "Description": c.get("text", ""),
                "Transform": {"posX": 0, "posY": 1, "posZ": 0, "rotX": 0, "rotY": 180, "rotZ": 180,
                               "scaleX": 1, "scaleY": 1, "scaleZ": 1},
            })
    save = {
        "SaveName": game.get("title", game["id"]),
        "GameMode": game.get("title", game["id"]),
        "VersionNumber": f"v{game.get('version', '0.1.0')}",
        "ObjectStates": [{
            "Name": "DeckCustom",
            "Nickname": f"{game.get('title')} deck",
            "Transform": {"posX": 0, "posY": 1, "posZ": 0, "rotX": 0, "rotY": 180, "rotZ": 180,
                           "scaleX": 1, "scaleY": 1, "scaleZ": 1},
            "DeckIDs": deck_ids,
            "CustomDeck": {"1": {
                "FaceURL": face_url, "BackURL": back_url,
                "NumWidth": cols, "NumHeight": rows,
                "BackIsHidden": True, "UniqueBack": False,
            }},
            "ContainedObjects": contained,
        }],
    }
    out = out_dir / f"{game['id']}.json"
    out.write_text(json.dumps(save, indent=2))
    print(f"TTS export: {len(printings)} unique faces on {cols}x{rows} sheet, "
          f"{len(deck_ids)}-card deck -> {out}")
    print(f"  sheet: {sheet_path}  ({sheet.width}x{sheet.height}px)")
    print("  NOTE: URLs are local file:// for testing; platform substitutes hosted URLs.")

if __name__ == "__main__":
    main()
