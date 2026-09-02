#!/usr/bin/env python3
"""export_tts.py - Tabletop Simulator exporter, format v0.2.
Usage: python3 tools/export_tts.py <game-dir> [--face-url URL] [--back-url URL]

Builds one or more sprite sheets (TTS limits: max 10x7 grid, <=4096px each)
and the save JSON (DeckCustom, CardID = deckIndex*100 + sheetPosition),
honoring quantities. Sets over 70 unique printings are split across multiple
CustomDeck entries automatically. For hosted multi-sheet exports, put
``{sheet}`` in --face-url; it is replaced with the 1-based sheet number.

Provenance: like the TTC exporter, credit follows the work onto the 3D table.
Each card's GMNotes carries its credit + license; any non-default art credit is
also summarized in the save-level Note (shown in TTS's on-screen Notes panel),
so attribution is visible in-game, not just buried in metadata.

Asset URLs default to file:// paths for local testing; the platform substitutes
permanent hosted URLs (dead links are how TTS mods rot).
Output: exports/tts/
"""
import json, sys
from pathlib import Path

import yaml
from PIL import Image
from render_support import render_faces

MAX_COLS, MAX_ROWS, MAX_SHEET = 10, 7, 4096
MAX_FACES_PER_SHEET = MAX_COLS * MAX_ROWS
XF = {"posX": 0, "posY": 1, "posZ": 0, "rotX": 0, "rotY": 180, "rotZ": 180,
      "scaleX": 1, "scaleY": 1, "scaleZ": 1}


def main():
    args = sys.argv[1:]
    game_dir = Path(args[0])
    def opt(name, default):
        return args[args.index(name) + 1] if name in args else default

    game = yaml.safe_load((game_dir / "game.yaml").read_text())
    cards = {c["id"]: c for c in json.loads((game_dir / "components/cards.json").read_text())}
    printings = json.loads((game_dir / "components/printings.json").read_text())
    faces_dir = game_dir / "exports" / "faces"
    render_faces(game_dir)
    out_dir = game_dir / "exports" / "tts"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale_sheet in out_dir.glob("sheet*.png"):
        stale_sheet.unlink()

    game_license = game.get("license", "")
    authors = ", ".join(a.get("name", "") for a in (game.get("authors") or [])) or ""
    default_creator = (game.get("default_provenance") or {}).get("creator", "")

    if not printings:
        raise SystemExit("No printings to export.")

    # ---- sprite sheets: one slot per UNIQUE printing, max 70 per sheet ----
    with Image.open(faces_dir / f"{printings[0]['id']}.png") as first_face:
        source_w, source_h = first_face.size
    batches = [printings[i:i + MAX_FACES_PER_SHEET]
               for i in range(0, len(printings), MAX_FACES_PER_SHEET)]
    sheets = []
    for sheet_no, batch in enumerate(batches, 1):
        cols = min(MAX_COLS, len(batch))
        rows = -(-len(batch) // cols)
        scale = min(1.0, MAX_SHEET / (cols * source_w), MAX_SHEET / (rows * source_h))
        cw, ch = int(source_w * scale), int(source_h * scale)
        sheet = Image.new("RGB", (cols * cw, rows * ch), "white")
        for slot, p in enumerate(batch):
            img = Image.open(faces_dir / f"{p['id']}.png")
            if img.size != (cw, ch):
                img = img.resize((cw, ch), Image.LANCZOS)
            sheet.paste(img, ((slot % cols) * cw, (slot // cols) * ch))
        filename = "sheet.png" if len(batches) == 1 else f"sheet-{sheet_no}.png"
        sheet_path = out_dir / filename
        sheet.save(sheet_path)
        sheets.append({"path": sheet_path, "cols": cols, "rows": rows,
                       "width": sheet.width, "height": sheet.height})

    back_src = faces_dir / "_back.png"
    back_path = out_dir / "back.png"
    Image.open(back_src).save(back_path)

    face_url_arg = opt("--face-url", "")
    if len(sheets) > 1 and face_url_arg and "{sheet}" not in face_url_arg:
        raise SystemExit("Multi-sheet TTS export requires {sheet} in --face-url.")
    for sheet_no, info in enumerate(sheets, 1):
        info["url"] = (face_url_arg.replace("{sheet}", str(sheet_no))
                       if face_url_arg else info["path"].resolve().as_uri())
    back_url = opt("--back-url", back_path.resolve().as_uri())

    # ---- save JSON (deck + per-card objects, honoring quantities) ----
    deck_ids, contained, credits = [], [], []
    for i, p in enumerate(printings):
        deck_index = i // MAX_FACES_PER_SHEET + 1
        sheet_position = i % MAX_FACES_PER_SHEET
        card_id = deck_index * 100 + sheet_position
        c = cards.get(p["card_id"], {})
        name = c.get("name", p["card_id"])
        if p.get("variant"):
            name = f"{name} ({p['variant']})"        # keep reprints distinguishable
        prov = p.get("provenance") or {}
        creator = p.get("artist") or prov.get("creator") or default_creator
        lic = prov.get("license") or game_license
        source = prov.get("source") or ""
        gm = []
        if creator: gm.append(f"Credit: {creator}")
        if lic:     gm.append(f"License: {lic}")
        if source:  gm.append(f"Source: {source}")
        gmnotes = " · ".join(gm)                      # every card carries provenance
        if creator and creator != default_creator:    # surface non-default credit in-game
            credits.append(f"  {name}: {creator}")
        for _ in range(int(p.get("quantity", 1))):
            deck_ids.append(card_id)
            contained.append({
                "Name": "Card", "CardID": card_id,
                "Nickname": name,
                "Description": c.get("text", ""),
                "GMNotes": gmnotes,
                "Tags": [game["id"]],
                "Transform": dict(XF),
            })

    by = " · ".join(x for x in [f"By {authors}" if authors else "",
                                f"License: {game_license}" if game_license else ""] if x)
    note_lines = [f"{game.get('title', game['id'])} — tabletop-format export"]
    if by: note_lines.append(by)
    if credits:
        note_lines += ["", "Art credits (credit follows the work):", *credits]
    note = "\n".join(note_lines)

    custom_decks = {
        str(sheet_no): {
            "FaceURL": info["url"], "BackURL": back_url,
            "NumWidth": info["cols"], "NumHeight": info["rows"],
            "BackIsHidden": True, "UniqueBack": False,
        }
        for sheet_no, info in enumerate(sheets, 1)
    }

    save = {
        "SaveName": game.get("title", game["id"]),
        "GameMode": game.get("title", game["id"]),
        "VersionNumber": f"v{game.get('version', '0.1.0')}",
        "Note": note,
        "ObjectStates": [{
            "Name": "DeckCustom",
            "Nickname": f"{game.get('title')} deck",
            "Description": by,
            "Transform": dict(XF),
            "DeckIDs": deck_ids,
            "CustomDeck": custom_decks,
            "ContainedObjects": contained,
        }],
    }
    out = out_dir / f"{game['id']}.json"
    out.write_text(json.dumps(save, indent=2))
    print(f"TTS export: {len(printings)} unique faces on {len(sheets)} sheet(s), "
          f"{len(deck_ids)}-card deck -> {out}")
    for info in sheets:
        print(f"  sheet: {info['path']}  ({info['cols']}x{info['rows']}, "
              f"{info['width']}x{info['height']}px)")
    if credits:
        print(f"  provenance: {len(credits)} non-default art credit(s) carried into GMNotes + Note")
    if not face_url_arg and "--back-url" not in args:
        print("  NOTE: URLs are local file:// paths; pass --face-url/--back-url for a shareable mod.")


if __name__ == "__main__":
    main()
