#!/usr/bin/env python3
"""export_pnp.py - print-and-play PDF exporter, format v0.1.
Usage: python3 tools/export_pnp.py <game-dir>
Reads rendered faces (run render_cards.py first), lays out a 3x3 grid per
US Letter page at 300dpi with crop marks, honors printing quantities,
appends a card-back page. Output: exports/<game-id>-pnp.pdf
"""
import json, sys
from pathlib import Path

import yaml
from PIL import Image, ImageDraw

DPI = 300
PAGE_W, PAGE_H = int(8.5 * DPI), int(11 * DPI)   # 2550x3300
CARD_W, CARD_H = 750, 1050
COLS, ROWS = 3, 3
GRID_W, GRID_H = COLS * CARD_W, ROWS * CARD_H
OX, OY = (PAGE_W - GRID_W) // 2, (PAGE_H - GRID_H) // 2
MARK = 40  # crop mark length

def crop_marks(d):
    for i in range(COLS + 1):
        x = OX + i * CARD_W
        d.line([x, OY - MARK, x, OY - 8], fill="black", width=3)
        d.line([x, OY + GRID_H + 8, x, OY + GRID_H + MARK], fill="black", width=3)
    for j in range(ROWS + 1):
        y = OY + j * CARD_H
        d.line([OX - MARK, y, OX - 8, y], fill="black", width=3)
        d.line([OX + GRID_W + 8, y, OX + GRID_W + MARK, y], fill="black", width=3)

def main():
    game_dir = Path(sys.argv[1])
    faces = game_dir / "exports" / "faces"
    game = yaml.safe_load((game_dir / "game.yaml").read_text())
    printings = json.loads((game_dir / "components/printings.json").read_text())

    # physical deck: one slot per copy
    slots = []
    for p in printings:
        slots += [faces / f"{p['id']}.png"] * p.get("quantity", 1)

    pages = []
    for start in range(0, len(slots), COLS * ROWS):
        page = Image.new("RGB", (PAGE_W, PAGE_H), "white")
        d = ImageDraw.Draw(page)
        crop_marks(d)
        for k, face in enumerate(slots[start:start + COLS * ROWS]):
            r, c = divmod(k, COLS)
            page.paste(Image.open(face), (OX + c * CARD_W, OY + r * CARD_H))
        pages.append(page)

    # back page (print duplex or separately)
    back = Image.open(faces / "_back.png")
    page = Image.new("RGB", (PAGE_W, PAGE_H), "white")
    d = ImageDraw.Draw(page); crop_marks(d)
    for k in range(COLS * ROWS):
        r, c = divmod(k, COLS)
        page.paste(back, (OX + c * CARD_W, OY + r * CARD_H))
    pages.append(page)

    out = game_dir / "exports" / f"{game['id']}-pnp.pdf"
    # Palette mode -> lossless Flate in PIL's PDF writer (also avoids JPEG dependency).
    pages = [pg.convert("P", palette=Image.ADAPTIVE, colors=256) for pg in pages]
    pages[0].save(out, save_all=True, append_images=pages[1:], resolution=DPI)
    print(f"PnP PDF: {len(slots)} cards on {len(pages)-1} page(s) + 1 back page -> {out}")

if __name__ == "__main__":
    main()
