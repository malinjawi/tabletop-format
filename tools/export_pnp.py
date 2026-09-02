#!/usr/bin/env python3
"""export_pnp.py - print-and-play PDF exporter, format v0.1.
Usage: python3 tools/export_pnp.py <game-dir> [--card CARD_ID] [--output FILE]
Reads rendered faces (run render_cards.py first), lays out a 3x3 grid per
US Letter page at 300dpi with crop marks, honors printing quantities,
appends a card-back page. Output: exports/<game-id>-pnp.pdf
"""
import argparse, json, math
from pathlib import Path

import yaml
from PIL import Image, ImageDraw, ImageFont, ImageOps
from render_support import card_size_mm, render_faces

# Set from CLI in main(); module defaults keep helpers independently callable.
DPI = 300
S = DPI / 300
PAGE_W, PAGE_H = int(8.5 * DPI), int(11 * DPI)
MARK = max(16, int(0.13 * DPI))

def px(mm):
    return round(float(mm) / 25.4 * DPI)

def print_font(size_pt, bold=False):
    candidates = ([
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
    ] if bold else [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ])
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, max(8, round(size_pt / 72 * DPI)))
    try:
        return ImageFont.load_default(size=max(8, round(size_pt / 72 * DPI)))
    except TypeError:
        return ImageFont.load_default()

def centered_text(draw, box, text, font, fill, spacing=4):
    x, y, w, h = box
    lines = str(text).split("\n")
    boxes = [draw.textbbox((0, 0), line, font=font) for line in lines]
    heights = [b[3] - b[1] for b in boxes]
    total_h = sum(heights) + spacing * max(0, len(lines) - 1)
    cy = y + (h - total_h) / 2
    for line, bounds, line_h in zip(lines, boxes, heights):
        line_w = bounds[2] - bounds[0]
        draw.text((x + (w - line_w) / 2, cy), line, fill=fill, font=font)
        cy += line_h + spacing

def fit_image(image, width, height):
    return ImageOps.contain(image.convert("RGB"), (max(1, width), max(1, height)), Image.Resampling.LANCZOS)

def paste_image(page, image, x_mm, y_mm, w_mm, h_mm, rotate=0, cut=False):
    if rotate:
        image = image.rotate(float(rotate), expand=True, fillcolor="white")
    x, y, w, h = px(x_mm), px(y_mm), px(w_mm), px(h_mm)
    fitted = fit_image(image, w, h)
    left = x + (w - fitted.width) // 2
    top = y + (h - fitted.height) // 2
    page.paste(fitted, (left, top))
    if cut:
        ImageDraw.Draw(page).rectangle(
            [left, top, left + fitted.width - 1, top + fitted.height - 1],
            outline="#b7b7b7", width=max(1, round(DPI / 300)))

def expanded_printing_ids(items):
    expanded = []
    for item in items or []:
        if isinstance(item, str):
            expanded.append(item)
        else:
            expanded += [item["printing"]] * int(item.get("count", 1))
    return expanded

def place_grid(page, spec, printings, faces):
    ids = expanded_printing_ids(spec.get("items"))
    columns = int(spec.get("columns", 1))
    rows = int(spec.get("rows", max(1, math.ceil(len(ids) / columns))))
    x_mm, y_mm = float(spec.get("x_mm", 0)), float(spec.get("y_mm", 0))
    gap_x, gap_y = float(spec.get("gap_x_mm", 0)), float(spec.get("gap_y_mm", 0))
    rotate = float(spec.get("rotate", 0))
    fallback_w = float(spec.get("width_mm", 63.5))
    fallback_h = float(spec.get("height_mm", 88.9))
    for index, printing_id in enumerate(ids[:columns * rows]):
        printing = printings.get(printing_id)
        if not printing:
            raise RuntimeError(f"PnP layout names unknown printing '{printing_id}'")
        face = faces / f"{printing_id}.png"
        if not face.is_file():
            raise RuntimeError(f"PnP face was not rendered: {face}")
        size = printing.get("physical_size_mm") or {}
        source_w = float(size.get("width") or fallback_w)
        source_h = float(size.get("height") or fallback_h)
        item_w = float(spec.get("item_w_mm", source_h if rotate % 180 else source_w))
        item_h = float(spec.get("item_h_mm", source_w if rotate % 180 else source_h))
        if spec.get("order") == "column":
            column, row = divmod(index, rows)
        else:
            row, column = divmod(index, columns)
        paste_image(page, Image.open(face),
                    x_mm + column * (item_w + gap_x),
                    y_mm + row * (item_h + gap_y),
                    item_w, item_h, rotate=rotate, cut=spec.get("cut", True))

def place_asset(page, game_dir, spec):
    source = game_dir / spec["path"]
    if not source.is_file():
        raise RuntimeError(f"PnP layout asset is missing: {spec['path']}")
    image = Image.open(source).convert("RGB")
    parts = max(1, int(spec.get("split", 1)))
    axis = spec.get("split_axis", "x")
    slices = []
    for index in range(parts):
        if axis == "y":
            top, bottom = round(index * image.height / parts), round((index + 1) * image.height / parts)
            slices.append(image.crop((0, top, image.width, bottom)))
        else:
            left, right = round(index * image.width / parts), round((index + 1) * image.width / parts)
            slices.append(image.crop((left, 0, right, image.height)))
    columns = int(spec.get("columns", parts))
    item_w = float(spec["item_w_mm"])
    item_h = float(spec["item_h_mm"])
    gap_x = float(spec.get("gap_x_mm", 0))
    gap_y = float(spec.get("gap_y_mm", 0))
    for index, part in enumerate(slices):
        row, column = divmod(index, columns)
        paste_image(page, part,
                    float(spec.get("x_mm", 0)) + column * (item_w + gap_x),
                    float(spec.get("y_mm", 0)) + row * (item_h + gap_y),
                    item_w, item_h, rotate=float(spec.get("rotate", 0)), cut=spec.get("cut", False))

def platform_pnp_pages(game_dir, game, layout, printings, faces):
    """Compose a complete Forge PnP from versioned faces and production assets."""
    page_spec = layout.get("page") or {}
    page_w_mm = float(page_spec.get("width_mm", 279.4))
    page_h_mm = float(page_spec.get("height_mm", 215.9))
    page_size = (px(page_w_mm), px(page_h_mm))
    pages = []
    for page_number, spec in enumerate(layout.get("pages") or [], 1):
        page = Image.new("RGB", page_size, page_spec.get("background", "white"))
        kind = spec.get("kind", "grid")
        if kind == "cover":
            draw = ImageDraw.Draw(page)
            title = spec.get("title") or game.get("title") or game.get("id")
            subtitle = spec.get("subtitle") or "FORGE PRINT-AND-PLAY"
            centered_text(draw, (px(35), px(35), page_size[0] - px(70), px(95)),
                          str(title).upper().replace(" ", "\n", 1), print_font(52, True), "#303030", spacing=px(2))
            centered_text(draw, (px(35), px(135), page_size[0] - px(70), px(18)),
                          subtitle.upper(), print_font(14, True), "#454545")
            license_line = spec.get("footer") or f"Generated by Forge from versioned components - {game.get('license', 'license in repository')}"
            centered_text(draw, (px(20), page_size[1] - px(30), page_size[0] - px(40), px(10)),
                          license_line, print_font(7), "#666666")
        elif kind == "asset":
            for asset in spec.get("assets") or []:
                place_asset(page, game_dir, asset)
        else:
            groups = spec.get("groups") or [spec]
            for group in groups:
                place_grid(page, group, printings, faces)
            label = spec.get("cut_label")
            if label:
                ImageDraw.Draw(page).text((px(12), px(6)), label, fill="#333333", font=print_font(7, True))
        if page_spec.get("color_mode") == "grayscale":
            page = page.convert("L")
        pages.append(page)
    if not pages:
        raise RuntimeError("templates/pnp.yaml declares no pages")
    return pages

def crop_marks(d, cols, rows, card_w, card_h, ox, oy):
    grid_w, grid_h = cols * card_w, rows * card_h
    for i in range(cols + 1):
        x = ox + i * card_w
        d.line([x, oy - MARK, x, oy - 8], fill="black", width=3)
        d.line([x, oy + grid_h + 8, x, oy + grid_h + MARK], fill="black", width=3)
    for j in range(rows + 1):
        y = oy + j * card_h
        d.line([ox - MARK, y, ox - 8, y], fill="black", width=3)
        d.line([ox + grid_w + 8, y, ox + grid_w + MARK, y], fill="black", width=3)

def page_notice(d, text, oy):
    """Keep private-source warnings in the page margin, never on card art."""
    if not text:
        return
    size = max(10, round(8 / 72 * DPI))
    try:
        font = ImageFont.load_default(size=size)
    except TypeError:  # Pillow before load_default(size=...)
        font = ImageFont.load_default()
    label = f"PRIVATE MODIFIED PROXY - {text}"
    box = d.textbbox((0, 0), label, font=font)
    width, height = box[2] - box[0], box[3] - box[1]
    d.text(((PAGE_W - width) // 2, max(3, (oy - MARK - height) // 2)),
           label, fill="#555", font=font)

def main():
    global DPI, S, PAGE_W, PAGE_H, MARK
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_dir", type=Path)
    parser.add_argument("--dpi", type=int, default=300,
                        help="render resolution (default: 300)")
    parser.add_argument("--card", action="append", dest="card_ids", default=[],
                        help="export one copy of this card; repeat for multiple cards")
    parser.add_argument("--output", type=Path,
                        help="output PDF path (default: game exports/<id>-pnp.pdf)")
    parser.add_argument("--no-back", action="store_true",
                        help="omit the separate card-back page")
    args = parser.parse_args()
    if args.dpi < 72:
        parser.error("--dpi must be at least 72")
    DPI = args.dpi
    S = DPI / 300
    PAGE_W, PAGE_H = int(8.5 * DPI), int(11 * DPI)
    MARK = max(16, int(0.13 * DPI))
    game_dir = args.game_dir
    game = yaml.safe_load((game_dir / "game.yaml").read_text())
    out = args.output or (game_dir / "exports" / f"{game['id']}-pnp.pdf")
    faces = game_dir / "exports" / "faces"
    production_path = game_dir / "templates" / "production.json"
    production = json.loads(production_path.read_text()) if production_path.exists() else {}
    source_overlay_path = game_dir / "templates" / "source-overlay.yaml"
    source_overlay = yaml.safe_load(source_overlay_path.read_text()) if source_overlay_path.exists() else {}
    private_contract = production if production.get("private_only") else source_overlay
    private_notice = private_contract.get("notice") if private_contract.get("private_only") else ""
    printings = json.loads((game_dir / "components/printings.json").read_text())
    render_faces(game_dir)
    pnp_layout_path = game_dir / "templates" / "pnp.yaml"
    if pnp_layout_path.exists() and not args.card_ids:
        layout = yaml.safe_load(pnp_layout_path.read_text()) or {}
        pages = platform_pnp_pages(game_dir, game, layout,
                                   {printing["id"]: printing for printing in printings}, faces)
        out.parent.mkdir(parents=True, exist_ok=True)
        pages[0].save(out, "PDF", save_all=True, append_images=pages[1:],
                      resolution=DPI, quality=95, subsampling=0)
        print(f"PnP PDF: Forge-composed {len(pages)}-page platform edition from versioned faces/assets -> {out}")
        return
    card_w_mm, card_h_mm = card_size_mm(game_dir)
    card_w, card_h = round(card_w_mm / 25.4 * DPI), round(card_h_mm / 25.4 * DPI)
    usable_w, usable_h = PAGE_W - 2 * (MARK + 8), PAGE_H - 2 * (MARK + 8)
    cols = max(1, math.floor(usable_w / card_w))
    rows = max(1, math.floor(usable_h / card_h))
    grid_w, grid_h = cols * card_w, rows * card_h
    ox, oy = (PAGE_W - grid_w) // 2, (PAGE_H - grid_h) // 2

    # Whole-deck export honors quantities. An explicit --card selection is a
    # proofing sheet: one copy per requested semantic card, in request order.
    slots = []
    if args.card_ids:
        by_card = {p["card_id"]: p for p in printings}
        missing = [cid for cid in args.card_ids if cid not in by_card]
        if missing:
            parser.error("unknown --card id(s): " + ", ".join(missing))
        slots = [faces / f"{by_card[cid]['id']}.png" for cid in args.card_ids]
    else:
        for p in printings:
            slots += [faces / f"{p['id']}.png"] * p.get("quantity", 1)

    pages = []
    for start in range(0, len(slots), cols * rows):
        page = Image.new("RGB", (PAGE_W, PAGE_H), "white")
        d = ImageDraw.Draw(page)
        crop_marks(d, cols, rows, card_w, card_h, ox, oy)
        page_notice(d, private_notice, oy)
        for k, face in enumerate(slots[start:start + cols * rows]):
            r, c = divmod(k, cols)
            img = Image.open(face)
            if img.size != (card_w, card_h): img = img.resize((card_w, card_h), Image.LANCZOS)
            page.paste(img, (ox + c * card_w, oy + r * card_h))
        pages.append(page)

    # back page (print duplex or separately). A private NSG proof should use
    # opaque sleeves; --no-back intentionally avoids implying an official back.
    if not args.no_back:
        back = Image.open(faces / "_back.png")
        if back.size != (card_w, card_h): back = back.resize((card_w, card_h), Image.LANCZOS)
        page = Image.new("RGB", (PAGE_W, PAGE_H), "white")
        d = ImageDraw.Draw(page); crop_marks(d, cols, rows, card_w, card_h, ox, oy); page_notice(d, private_notice, oy)
        for k in range(cols * rows):
            r, c = divmod(k, cols)
            page.paste(back, (ox + c * card_w, oy + r * card_h))
        pages.append(page)

    out.parent.mkdir(parents=True, exist_ok=True)
    # The old palette/Flate path embedded every full blank page losslessly and
    # made small decks tens of megabytes. These faces already originate as
    # high-quality raster PnP assets; 4:4:4 JPEG at quality 95 preserves tiny
    # card text at 300 dpi while keeping the imposed PDF practical to share.
    pages[0].save(out, "PDF", save_all=True, append_images=pages[1:],
                  resolution=DPI, quality=95, subsampling=0)
    back_note = " + 1 back page" if not args.no_back else ""
    face_pages = len(pages) - (0 if args.no_back else 1)
    print(f"PnP PDF: {len(slots)} cards at {card_w_mm:g}x{card_h_mm:g}mm "
          f"on {face_pages} page(s) ({cols}x{rows}){back_note} -> {out}")

if __name__ == "__main__":
    main()
