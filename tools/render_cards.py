#!/usr/bin/env python3
"""render_cards.py - reference card renderer (Pillow), format v0.1.
Usage: python3 tools/render_cards.py <game-dir> [out-dir]
Renders every printing to a 750x1050px (2.5x3.5in @300dpi, trim size) PNG,
plus a card back. This is the REFERENCE renderer - the platform's canonical
renderer is HTML/CSS via Chromium (Block D); outputs here define the baseline.
"""
import json, re, sys
from pathlib import Path

import yaml
from PIL import Image, ImageDraw, ImageFont

W, H = 750, 1050  # 2.5x3.5in @ 300dpi
M = 45            # inner margin
def _font_dir():
    """Env override -> fonts shipped in-repo (tools/fonts/) -> Linux system dir.
    Bundling DejaVu makes renders byte-stable on macOS/Linux/CI (tools/fonts/LICENSE)."""
    import os
    for c in (os.environ.get("FMT_FONT_DIR"),
              str(Path(__file__).resolve().parent / "fonts"),
              "/usr/share/fonts/truetype/dejavu"):
        if c and Path(c, "DejaVuSans.ttf").exists():
            return c
    sys.exit("render_cards: DejaVu fonts not found; set FMT_FONT_DIR")

FONT_DIR = _font_dir()
F = {
    "name": ImageFont.truetype(f"{FONT_DIR}/DejaVuSans-Bold.ttf", 52),
    "type": ImageFont.truetype(f"{FONT_DIR}/DejaVuSans.ttf", 34),
    "text": ImageFont.truetype(f"{FONT_DIR}/DejaVuSans.ttf", 38),
    "flavor": ImageFont.truetype(f"{FONT_DIR}/DejaVuSerif-Italic.ttf" if Path(f"{FONT_DIR}/DejaVuSerif-Italic.ttf").exists() else f"{FONT_DIR}/DejaVuSans-Oblique.ttf", 32),
    "badge": ImageFont.truetype(f"{FONT_DIR}/DejaVuSans-Bold.ttf", 64),
    "small": ImageFont.truetype(f"{FONT_DIR}/DejaVuSans.ttf", 26),
    "back": ImageFont.truetype(f"{FONT_DIR}/DejaVuSans-Bold.ttf", 88),
}
PALETTE = [  # type color assigned deterministically
    ("#8c2f1b", "#f6e3d3"), ("#1b4f8c", "#dbe9f6"), ("#3a6b28", "#e2f0d9"),
    ("#6b28５a".replace("５","5"), "#f0d9ea"), ("#7a5a1b", "#f4ead2"), ("#37474f", "#e0e7ea"),
]
SYMBOLS = {  # extendable via game.yaml assets later
    "spark": "✦", "ash": "▲", "cargo": "■",
    "credit": "¤", "mu": "μ", "click": "◇", "link": "⚑",
}

def wrap(draw, text, font, width):
    lines = []
    for para in text.split("\n"):
        cur = ""
        for word in para.split(" "):
            trial = (cur + " " + word).strip()
            if draw.textlength(trial, font=font) <= width: cur = trial
            else: lines.append(cur); cur = word
        lines.append(cur)
    return lines

def render_card(card, printing, game, colors):
    fg, bg = colors
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([8, 8, W - 8, H - 8], radius=36, outline=fg, width=10)

    # name bar
    d.rounded_rectangle([M, M, W - M, M + 96], radius=20, fill=fg)
    d.text((M + 110, M + 48), card["name"], font=F["name"], fill="white", anchor="lm")
    # cost circle
    cost = (card.get("attributes") or {}).get("cost")
    if cost is not None:
        d.ellipse([M + 8, M + 8, M + 88, M + 88], fill="white", outline=fg, width=6)
        d.text((M + 48, M + 49), str(cost), font=F["badge"], fill=fg, anchor="mm")
    # type line
    tline = card["type"].capitalize() + ("  •  " + ", ".join(card.get("subtypes", [])) if card.get("subtypes") else "")
    d.text((M, M + 120), tline, font=F["type"], fill=fg)
    # art box: real art when the printing declares it and the file is a real image
    # (LFS pointer files fall back to placeholder — production materializes assets first)
    art_top, art_bot = M + 170, M + 470
    art_img = None
    art_rel = printing.get("art")
    if art_rel:
        p = GAME_DIR / art_rel
        if p.exists() and p.stat().st_size > 200:  # pointers are ~130 bytes
            try:
                from PIL import ImageOps
                art_img = ImageOps.fit(Image.open(p).convert("RGB"),
                                       (W - 2 * M, art_bot - art_top), Image.LANCZOS)
            except Exception:
                art_img = None
    if art_img is not None:
        img.paste(art_img, (M, art_top))
        d.rectangle([M, art_top, W - M, art_bot], outline=fg, width=4)
    else:
        d.rectangle([M, art_top, W - M, art_bot], outline=fg, width=4)
        for x in range(M, W - M, 28):
            d.line([x, art_bot, min(x + (art_bot - art_top), W - M), art_top], fill=fg, width=1)
    # rules text
    text = card.get("text", "")
    for key, glyph in SYMBOLS.items():
        text = text.replace(f"[{key}]", glyph)
    text = re.sub(r"\[([a-z0-9_]+)\]", lambda m: m.group(1).upper(), text)
    y = art_bot + 30
    for line in wrap(d, text, F["text"], W - 2 * M):
        d.text((M, y), line, font=F["text"], fill="#1a1a1a"); y += 50
    # keywords
    if card.get("keywords"):
        d.text((M, y + 8), " ✦ ".join(k.upper() for k in card["keywords"]), font=F["small"], fill=fg); y += 44
    # flavor
    if printing.get("flavor_text"):
        for line in wrap(d, printing["flavor_text"], F["flavor"], W - 2 * M):
            d.text((M, y + 10), line, font=F["flavor"], fill="#555"); y += 42
    # power badge
    power = (card.get("attributes") or {}).get("power")
    if power is not None:
        d.ellipse([W - M - 96, H - M - 96, W - M, H - M], fill=fg)
        d.text((W - M - 48, H - M - 47), str(power), font=F["badge"], fill="white", anchor="mm")
    # footer
    footer = f"{printing.get('set_id','')} {printing.get('collector_number','')}".strip()
    if printing.get("variant"): footer += f" • {printing['variant']}"
    d.text((M, H - M - 20), footer, font=F["small"], fill="#666")
    d.text((W - M, H - M - 20), game.get("title", ""), font=F["small"], fill="#666", anchor="ra")
    return img

def render_back(game, colors):
    fg, bg = colors
    img = Image.new("RGB", (W, H), fg)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([30, 30, W - 30, H - 30], radius=36, outline=bg, width=8)
    d.text((W / 2, H / 2), game.get("title", "?"), font=F["back"], fill=bg, anchor="mm")
    return img

GAME_DIR = None  # set by main(); used by render_card for art resolution

def main():
    global GAME_DIR
    game_dir = Path(sys.argv[1])
    GAME_DIR = game_dir
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else game_dir / "exports" / "faces"
    out_dir.mkdir(parents=True, exist_ok=True)
    game = yaml.safe_load((game_dir / "game.yaml").read_text())
    cards = {c["id"]: c for c in json.loads((game_dir / "components/cards.json").read_text())}
    printings = json.loads((game_dir / "components/printings.json").read_text())
    # Colors & glyphs are DESIGN DATA (game.yaml), not tool code; palette is only a fallback.
    types = sorted({c["type"] for c in cards.values()})
    colors = {t: PALETTE[i % len(PALETTE)] for i, t in enumerate(types)}
    for t, cc in (game.get("type_colors") or {}).items():
        colors[t] = (cc["fg"], cc["bg"])
    for s in game.get("symbols") or []:
        if s.get("glyph"):
            SYMBOLS[s["key"]] = s["glyph"]

    for p in printings:
        c = cards[p["card_id"]]
        render_card(c, p, game, colors[c["type"]]).save(out_dir / f"{p['id']}.png")
    render_back(game, PALETTE[0]).save(out_dir / "_back.png")
    print(f"Rendered {len(printings)} faces + back -> {out_dir}")

if __name__ == "__main__":
    main()
