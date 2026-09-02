#!/usr/bin/env python3
"""Build a printer-facing package from Forge's canonical card renderer.

The package contains:
  - 300 DPI sRGB PNG fronts with the declared bleed on every side
  - a quantity manifest (one image per unique printing, copies kept as data)
  - A4 and US Letter duplex PDFs with vector crop marks
  - a one-card-per-page RGB press PDF with Media/Trim/Bleed boxes

Usage:
  python3 tools/export_print_ready.py <game-dir> [--output-dir DIR] [--ref REF]
"""

import argparse
import csv
import hashlib
import io
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml
from deterministic_archive import write_deterministic_zip
from PIL import Image
from reportlab.lib.colors import HexColor, black
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from design_engines import load_design_engines


TOOLS = Path(__file__).resolve().parent
DEFAULT_DPI = 300
DEFAULT_TRIM_MM = (63.5, 88.9)
DEFAULT_BLEED_MM = 3.175


def load_yaml(path):
    return yaml.safe_load(path.read_text()) if path.exists() else {}


def print_contract(game_dir):
    """Resolve the active physical card contract, preferring card families."""
    templates = game_dir / "templates"
    design_engines = load_design_engines(game_dir)
    card_design = design_engines.get("card_design") if design_engines else None
    candidates = [
        card_design["families"][0]["layout"] if card_design and card_design.get("families") else {},
        load_yaml(templates / "layout.yaml"),
        json.loads((templates / "production.json").read_text())
        if (templates / "production.json").exists() else {},
        load_yaml(templates / "source-overlay.yaml"),
    ]
    card = next(((doc or {}).get("card") for doc in candidates
                 if (doc or {}).get("card")), {})
    return {
        "w_mm": float(card.get("w_mm") or DEFAULT_TRIM_MM[0]),
        "h_mm": float(card.get("h_mm") or DEFAULT_TRIM_MM[1]),
        "bleed_mm": float(card.get("bleed_mm") or DEFAULT_BLEED_MM),
    }


def content_ref(game_dir):
    """Fingerprint the source tree when no immutable ref is supplied."""
    digest = hashlib.sha256()
    for path in sorted(p for p in game_dir.rglob("*") if p.is_file()
                       and ".git" not in p.parts and "exports" not in p.parts):
        digest.update(path.relative_to(game_dir).as_posix().encode())
        digest.update(path.read_bytes())
    return f"working-{digest.hexdigest()[:12]}"


def px(mm_value, dpi):
    return round(mm_value / 25.4 * dpi)


def stamp_pngs(folder, dpi):
    for path in sorted(folder.glob("*.png")):
        with Image.open(path) as image:
            image.convert("RGB").save(path, "PNG", dpi=(dpi, dpi), optimize=True)


def jpeg_cache(paths, folder, dpi, quality=95):
    folder.mkdir(parents=True, exist_ok=True)
    out = {}
    for path in paths:
        target = folder / f"{path.stem}.jpg"
        with Image.open(path) as image:
            image.convert("RGB").save(
                target, "JPEG", quality=quality, subsampling=0,
                optimize=True, dpi=(dpi, dpi),
            )
        out[path.name] = target
    return out


def slots_for(printings, faces):
    slots = []
    for printing in printings:
        face = faces / f"{printing['id']}.png"
        if not face.exists():
            raise FileNotFoundError(f"missing rendered face: {face.name}")
        slots.extend([face] * max(1, int(printing.get("quantity", 1))))
    return slots


def trim_for(printing, contract):
    size = printing.get("physical_size_mm") or {}
    return (
        float(size.get("width") or contract["w_mm"]),
        float(size.get("height") or contract["h_mm"]),
    )


def size_label(trim):
    def number(value):
        return f"{value:g}".replace(".", "p")
    return f"{number(trim[0])}x{number(trim[1])}mm"


def resized_png(source, target, size, dpi):
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        image.convert("RGB").resize(size, Image.Resampling.LANCZOS).save(
            target, "PNG", dpi=(dpi, dpi), optimize=True,
        )


def add_edge_bleed(source, target, bleed_px, dpi):
    """Extend edge pixels into a deterministic safety bleed.

    Renderer-native bleed remains preferred. This fallback is required for
    licensed flat source faces whose production template declares trim but has
    no editable artwork outside it.
    """
    with Image.open(source) as opened:
        image = opened.convert("RGB")
    if bleed_px <= 0:
        image.save(target, "PNG", dpi=(dpi, dpi), optimize=True)
        return
    width, height = image.size
    result = Image.new("RGB", (width + 2 * bleed_px, height + 2 * bleed_px))
    result.paste(image, (bleed_px, bleed_px))
    result.paste(image.crop((0, 0, width, 1)).resize((width, bleed_px)),
                 (bleed_px, 0))
    result.paste(image.crop((0, height - 1, width, height)).resize((width, bleed_px)),
                 (bleed_px, bleed_px + height))
    result.paste(image.crop((0, 0, 1, height)).resize((bleed_px, height)),
                 (0, bleed_px))
    result.paste(image.crop((width - 1, 0, width, height)).resize((bleed_px, height)),
                 (bleed_px + width, bleed_px))
    corners = [
        ((0, 0, 1, 1), (0, 0)),
        ((width - 1, 0, width, 1), (bleed_px + width, 0)),
        ((0, height - 1, 1, height), (0, bleed_px + height)),
        ((width - 1, height - 1, width, height),
         (bleed_px + width, bleed_px + height)),
    ]
    for crop, position in corners:
        result.paste(image.crop(crop).resize((bleed_px, bleed_px)), position)
    target.parent.mkdir(parents=True, exist_ok=True)
    result.save(target, "PNG", dpi=(dpi, dpi), optimize=True)


def extract_trim(source, target, expected_trim, bleed_px, dpi):
    """Materialize trim from a renderer-native bleed face."""
    with Image.open(source) as opened:
        image = opened.convert("RGB")
    expected_bleed = (expected_trim[0] + 2 * bleed_px,
                      expected_trim[1] + 2 * bleed_px)
    if image.size == expected_trim:
        image.save(target, "PNG", dpi=(dpi, dpi), optimize=True)
        add_edge_bleed(target, source, bleed_px, dpi)
        return
    if image.size != expected_bleed:
        raise ValueError(
            f"{source.name}: renderer produced {image.size}; expected trim "
            f"{expected_trim} or bleed {expected_bleed}"
        )
    image.crop((bleed_px, bleed_px,
                bleed_px + expected_trim[0],
                bleed_px + expected_trim[1])).save(
        target, "PNG", dpi=(dpi, dpi), optimize=True,
    )


def jpeg_copy(source, target, dpi, size=None, quality=95):
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        image = image.convert("RGB")
        if size and image.size != size:
            image = image.resize(size, Image.Resampling.LANCZOS)
        image.save(target, "JPEG", quality=quality, subsampling=0,
                   optimize=True, dpi=(dpi, dpi))
    return target


def crop_marks(pdf, page_w, page_h, cols, rows, card_w, card_h, ox, oy):
    mark = 2.6 * mm
    gap = 0.8 * mm
    grid_w, grid_h = cols * card_w, rows * card_h
    pdf.saveState()
    pdf.setStrokeColor(black)
    pdf.setLineWidth(0.25)
    for col in range(cols + 1):
        x = ox + col * card_w
        pdf.line(x, oy - gap, x, oy - gap - mark)
        pdf.line(x, oy + grid_h + gap, x, oy + grid_h + gap + mark)
    for row in range(rows + 1):
        y = oy + row * card_h
        pdf.line(ox - gap, y, ox - gap - mark, y)
        pdf.line(ox + grid_w + gap, y, ox + grid_w + gap + mark, y)
    pdf.restoreState()


def page_notice(pdf, page_w, page_h, page_number, total_pairs, private_notice):
    pdf.saveState()
    pdf.setFillColor(HexColor("#4d5359"))
    pdf.setFont("Helvetica", 6.5)
    top = "ACTUAL SIZE / 100% - DUPLEX: FLIP ON LONG EDGE - ODD PAGES ONLY FOR OPAQUE SLEEVES"
    pdf.drawCentredString(page_w / 2, page_h - 4.6 * mm, top)
    bottom = f"Forge print build - sheet {page_number} of {total_pairs}"
    if private_notice:
        bottom += " - PRIVATE MODIFIED PROXY"
    pdf.drawCentredString(page_w / 2, 3.1 * mm, bottom)
    pdf.restoreState()


def print_at_home_pdf(output, page_size, slots, trim_jpegs, back_jpeg,
                      trim_w_mm, trim_h_mm, title, ref, private_notice):
    page_w, page_h = page_size
    card_w, card_h = trim_w_mm * mm, trim_h_mm * mm
    if card_w > page_w - 12 * mm or card_h > page_h - 12 * mm:
        raise ValueError(
            f"{trim_w_mm:g} x {trim_h_mm:g} mm component does not fit this paper size"
        )
    cols = max(1, math.floor((page_w - 12 * mm) / card_w))
    # US Letter is 279.4 mm tall. A true poker card is 88.9 mm, so three rows
    # consume 266.7 mm and leave 12.7 mm for both margins. Reserving 14 mm made
    # an otherwise valid 3x3 actual-size sheet fail by 1.3 mm.
    rows = max(1, math.floor((page_h - 12 * mm) / card_h))
    grid_w, grid_h = cols * card_w, rows * card_h
    ox, oy = (page_w - grid_w) / 2, (page_h - grid_h) / 2
    capacity = cols * rows
    chunks = [slots[i:i + capacity] for i in range(0, len(slots), capacity)]
    image_cache = {}

    def image(path):
        key = str(path)
        if key not in image_cache:
            image_cache[key] = ImageReader(key)
        return image_cache[key]

    pdf = canvas.Canvas(str(output), pagesize=page_size, pageCompression=1, invariant=1)
    pdf.setTitle(f"{title} - print at home")
    pdf.setAuthor("Forge")
    pdf.setSubject(f"Exact version {ref}; {trim_w_mm:g} x {trim_h_mm:g} mm trim")
    for page_index, chunk in enumerate(chunks, 1):
        # Front: reading order, top-left to bottom-right.
        page_notice(pdf, page_w, page_h, page_index, len(chunks), private_notice)
        crop_marks(pdf, page_w, page_h, cols, rows, card_w, card_h, ox, oy)
        for index, face in enumerate(chunk):
            row, col = divmod(index, cols)
            x = ox + col * card_w
            y = oy + (rows - row - 1) * card_h
            pdf.drawImage(image(trim_jpegs[face.name]), x, y, card_w, card_h,
                          preserveAspectRatio=False, mask=None)
        pdf.showPage()

        # Back: mirror columns so long-edge duplex registration matches fronts.
        page_notice(pdf, page_w, page_h, page_index, len(chunks), private_notice)
        crop_marks(pdf, page_w, page_h, cols, rows, card_w, card_h, ox, oy)
        for index, _face in enumerate(chunk):
            row, col = divmod(index, cols)
            x = ox + (cols - col - 1) * card_w
            y = oy + (rows - row - 1) * card_h
            pdf.drawImage(image(back_jpeg), x, y, card_w, card_h,
                          preserveAspectRatio=False, mask=None)
        pdf.showPage()
    pdf.save()


def press_pdf(output, bleed_paths, bleed_jpegs, trim_w_mm, trim_h_mm,
              bleed_mm, title, ref):
    """One face per page, with explicit trim and bleed boxes plus crop marks."""
    image_w = (trim_w_mm + 2 * bleed_mm) * mm
    image_h = (trim_h_mm + 2 * bleed_mm) * mm
    margin = 3.5 * mm
    page_w, page_h = image_w + 2 * margin, image_h + 2 * margin
    trim_x = margin + bleed_mm * mm
    trim_y = margin + bleed_mm * mm
    trim_w, trim_h = trim_w_mm * mm, trim_h_mm * mm
    pdf = canvas.Canvas(str(output), pagesize=(page_w, page_h), pageCompression=1, invariant=1)
    pdf.setTitle(f"{title} - press faces (sRGB)")
    pdf.setAuthor("Forge")
    pdf.setSubject(f"Exact version {ref}; 300 DPI sRGB; {bleed_mm:g} mm bleed")
    pdf.setCropBox((0, 0, page_w, page_h))
    pdf.setBleedBox((margin, margin, margin + image_w, margin + image_h))
    pdf.setTrimBox((trim_x, trim_y, trim_x + trim_w, trim_y + trim_h))
    cache = {}

    def image(path):
        key = str(path)
        if key not in cache:
            cache[key] = ImageReader(key)
        return cache[key]

    for path in bleed_paths:
        pdf.drawImage(image(bleed_jpegs[path.name]), margin, margin, image_w, image_h,
                      preserveAspectRatio=False, mask=None)
        # Crop marks live entirely outside the bleed box.
        pdf.saveState()
        pdf.setStrokeColor(black)
        pdf.setLineWidth(0.25)
        gap, length = 0.45 * mm, 2.55 * mm
        for x in (trim_x, trim_x + trim_w):
            pdf.line(x, margin - gap, x, margin - gap - length)
            pdf.line(x, margin + image_h + gap, x, margin + image_h + gap + length)
        for y in (trim_y, trim_y + trim_h):
            pdf.line(margin - gap, y, margin - gap - length, y)
            pdf.line(margin + image_w + gap, y, margin + image_w + gap + length, y)
        pdf.restoreState()
        pdf.showPage()
    pdf.save()


def write_quantities(path, printings, cards):
    names = {card["id"]: card.get("name", card["id"]) for card in cards}
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["printing_id", "card_id", "name", "quantity", "front_file"])
        for printing in printings:
            writer.writerow([
                printing["id"], printing["card_id"], names.get(printing["card_id"], ""),
                max(1, int(printing.get("quantity", 1))),
                f"fronts-bleed/{printing['id']}.png",
            ])


def private_notice(game_dir):
    for path in (game_dir / "templates" / "production.json",
                 game_dir / "templates" / "source-overlay.yaml"):
        if not path.exists():
            continue
        doc = json.loads(path.read_text()) if path.suffix == ".json" else load_yaml(path)
        if doc.get("private_only"):
            return doc.get("notice") or "Check source permissions before sharing altered faces."
    return ""


def zip_package(zip_path, package_root, files):
    write_deterministic_zip(zip_path, [(arcname, path) for path, arcname in files])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--ref", help="immutable Forge commit/tag represented by this build")
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    args = parser.parse_args()
    if args.dpi != 300:
        parser.error("print-ready packages currently require --dpi 300")

    game_dir = args.game_dir.resolve()
    game = load_yaml(game_dir / "game.yaml")
    cards = json.loads((game_dir / "components" / "cards.json").read_text())
    printings = json.loads((game_dir / "components" / "printings.json").read_text())
    contract = print_contract(game_dir)
    slug = game.get("id") or game_dir.name
    title = game.get("title") or slug
    ref = args.ref or content_ref(game_dir)
    notice = private_notice(game_dir)
    out = (args.output_dir or game_dir / "exports" / "print-ready").resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    with tempfile.TemporaryDirectory(prefix="forge-print-") as scratch_name:
        scratch = Path(scratch_name)
        trim = scratch / "trim"
        bleed = out / "fronts-bleed"
        subprocess.run([
            shutil.which("node") or "node", str(TOOLS / "render_cards.mjs"),
            str(game_dir), str(bleed), "--bleed",
        ], check=True)
        bleed_px = px(contract["bleed_mm"], args.dpi)
        for printing in printings:
            trim_path = trim / f"{printing['id']}.png"
            bleed_path = bleed / f"{printing['id']}.png"
            trim_mm = trim_for(printing, contract)
            expected_trim = (px(trim_mm[0], args.dpi), px(trim_mm[1], args.dpi))
            trim_path.parent.mkdir(parents=True, exist_ok=True)
            extract_trim(bleed_path, trim_path, expected_trim, bleed_px, args.dpi)
        base_trim_px = (px(contract["w_mm"], args.dpi),
                        px(contract["h_mm"], args.dpi))
        extract_trim(bleed / "_back.png", trim / "_back.png",
                     base_trim_px, bleed_px, args.dpi)
        stamp_pngs(trim, args.dpi)
        stamp_pngs(bleed, args.dpi)

        for printing in printings:
            trim_mm = trim_for(printing, contract)
            expected_trim = (px(trim_mm[0], args.dpi), px(trim_mm[1], args.dpi))
            expected_bleed = (expected_trim[0] + 2 * bleed_px,
                              expected_trim[1] + 2 * bleed_px)
            for folder, expected in ((trim, expected_trim), (bleed, expected_bleed)):
                path = folder / f"{printing['id']}.png"
                with Image.open(path) as image:
                    if image.size != expected:
                        raise ValueError(
                            f"{path.name}: expected {folder.name} {expected} for "
                            f"{trim_mm[0]:g} x {trim_mm[1]:g} mm, got {image.size}"
                        )

        grouped = {}
        for printing in printings:
            grouped.setdefault(trim_for(printing, contract), []).append(printing)
        trim_jpegs = jpeg_cache(sorted(trim.glob("*.png")), scratch / "trim-jpeg", args.dpi)
        bleed_jpegs = jpeg_cache(sorted(bleed.glob("*.png")), scratch / "bleed-jpeg", args.dpi)
        base_trim = (contract["w_mm"], contract["h_mm"])
        group_outputs = []
        backs_bleed = out / "backs-bleed"
        for trim_mm, group_printings in grouped.items():
            label = size_label(trim_mm)
            suffix = "" if trim_mm == base_trim else f"-{label}"
            expected_trim = (px(trim_mm[0], args.dpi), px(trim_mm[1], args.dpi))
            expected_bleed = (expected_trim[0] + 2 * bleed_px,
                              expected_trim[1] + 2 * bleed_px)
            back_trim = jpeg_copy(
                trim / "_back.png", scratch / "backs-trim" / f"{label}.jpg",
                args.dpi, expected_trim,
            )
            back_bleed = backs_bleed / f"{label}-back.png"
            back_trim_png = scratch / "backs-trim-png" / f"{label}.png"
            resized_png(trim / "_back.png", back_trim_png, expected_trim, args.dpi)
            add_edge_bleed(back_trim_png, back_bleed, bleed_px, args.dpi)
            back_bleed_jpeg = jpeg_copy(
                back_bleed, scratch / "backs-bleed-jpeg" / f"{label}.jpg", args.dpi,
            )
            slots = slots_for(group_printings, trim)
            a4_pdf = out / f"{slug}-print-at-home-a4{suffix}.pdf"
            letter_pdf = out / f"{slug}-print-at-home-letter{suffix}.pdf"
            press = out / f"{slug}-press-rgb{suffix}.pdf"
            print_at_home_pdf(
                a4_pdf, A4, slots, trim_jpegs, back_trim,
                trim_mm[0], trim_mm[1], title, ref, notice,
            )
            print_at_home_pdf(
                letter_pdf, LETTER, slots, trim_jpegs, back_trim,
                trim_mm[0], trim_mm[1], title, ref, notice,
            )
            press_faces = [bleed / f"{p['id']}.png" for p in group_printings] + [back_bleed]
            group_bleed_jpegs = dict(bleed_jpegs)
            group_bleed_jpegs[back_bleed.name] = back_bleed_jpeg
            press_pdf(
                press, press_faces, group_bleed_jpegs, trim_mm[0], trim_mm[1],
                contract["bleed_mm"], title, ref,
            )
            group_outputs.append({
                "trim_mm": [trim_mm[0], trim_mm[1]],
                "unique_fronts": len(group_printings),
                "physical_cards": sum(max(1, int(p.get("quantity", 1)))
                                      for p in group_printings),
                "a4_pdf": a4_pdf.name,
                "letter_pdf": letter_pdf.name,
                "press_pdf": press.name,
                "back_file": f"backs/{back_bleed.name}",
            })

    quantities = out / "quantities.csv"
    write_quantities(quantities, printings, cards)
    manifest = {
        "format": "forge-print-ready-v1",
        "game_id": slug,
        "title": title,
        "exact_ref": ref,
        "dpi": args.dpi,
        "color_space": "sRGB",
        "trim_mm": [contract["w_mm"], contract["h_mm"]],
        "physical_sizes": group_outputs,
        "bleed_mm_each_side": contract["bleed_mm"],
        "bleed_pixels": px(contract["bleed_mm"], args.dpi),
        "unique_fronts": len(printings),
        "physical_cards": sum(max(1, int(p.get("quantity", 1))) for p in printings),
        "duplex": "portrait, flip on long edge; back columns are mirrored",
        "press_pdf": "one PDF per physical size; each has one unique front per page plus a fitted back; use quantities.csv",
        "private_notice": notice or None,
    }
    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    readme = out / "README.txt"
    readme.write_text(
        f"{title} - Forge print build\n"
        f"Exact version: {ref}\n\n"
        "HOME PRINTING\n"
        "- Open the A4 or US Letter PDF matching both your paper and component size.\n"
        "- Print at Actual Size / 100%; disable Fit, Shrink, and Scale.\n"
        "- For duplex, flip on the long edge. Forge has mirrored the back columns.\n"
        "- For the most reliable prototype, print odd pages only and use opaque sleeves.\n\n"
        "PRINT SERVICE\n"
        "- fronts-bleed/ contains 300 DPI sRGB PNGs at each component's declared size.\n"
        "- Each press PDF covers one trim size and has explicit TrimBox/BleedBox metadata.\n"
        "- quantities.csv tells the printer how many copies of each unique face to make.\n"
        "- Confirm RGB acceptance, corner radius, stock, and black handling with the printer.\n\n"
        "RIGHTS\n"
        f"- {notice or 'Follow the game license and every credited asset license before distribution.'}\n"
    )

    zip_path = out / f"{slug}-print-ready.zip"
    package_files = [
        (readme, "README.txt"), (manifest_path, "manifest.json"),
        (quantities, "quantities.csv"),
    ]
    for path in sorted(out.glob("*.pdf")):
        package_files.append((path, f"pdf/{path.name}"))
    for path in sorted((out / "fronts-bleed").glob("*.png")):
        if path.name != "_back.png":
            package_files.append((path, f"fronts-bleed/{path.name}"))
    for path in sorted((out / "backs-bleed").glob("*.png")):
        package_files.append((path, f"backs/{path.name}"))
    zip_package(zip_path, out, package_files)
    print(json.dumps({
        "package": str(zip_path),
        "physical_sizes": group_outputs,
        "manifest": manifest,
    }, indent=2))


if __name__ == "__main__":
    main()
