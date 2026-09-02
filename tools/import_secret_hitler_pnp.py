#!/usr/bin/env python3
"""Import the official Secret Hitler print-and-play production package.

This is deliberately a game-specific adapter around a universal Forge idea:
the publisher PDF remains the immutable print truth, while lossless crops make
its heterogeneous physical components usable in the card gallery and VTT
pipelines.  Crop geometry is pinned to the official 2015 PDF SHA-256 below.

Usage:
  python3 tools/import_secret_hitler_pnp.py PDF GAME_DIR
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image


SOURCE_URL = "https://www.secrethitler.com/assets/Secret_Hitler_Print_and_Play.pdf"
SOURCE_SHA256 = "b835c7b1365f19448649db99a78b043f30f12a1805b62bf3a4e883562edd6829"
LICENSE = "CC-BY-NC-SA-4.0"
DPI = 300


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def save_png(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "PNG", dpi=(DPI, DPI), optimize=True)


def standard_slot(page, column=0, row=0):
    """One exact 2.5x3.5in slot from the official four-by-two sheets."""
    left = 150 + column * 750
    top = 225 + row * 1050
    return page.crop((left, top, left + 750, top + 1050))


def build_board(page, page_number):
    """Join the two letter-page board halves at their matching A/B/C/D edge."""
    left = page.crop((142, 210, 1650, 2330)).rotate(-90, expand=True)
    right = page.crop((1647, 210, 3155, 2330)).rotate(90, expand=True)
    board = Image.new("L", (left.width + right.width, max(left.height, right.height)), 255)
    board.paste(left, (0, 0))
    board.paste(right, (left.width, 0))
    # The liberal halves are imposed opposite the three fascist boards.
    return board.rotate(180, expand=True) if page_number == 10 else board


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("game_dir", type=Path)
    args = parser.parse_args()

    pdf = args.pdf.resolve()
    game_dir = args.game_dir.resolve()
    if not pdf.is_file():
        raise SystemExit(f"source PDF not found: {pdf}")
    if sha256(pdf) != SOURCE_SHA256:
        raise SystemExit(
            "source PDF does not match the reviewed official package\n"
            f"expected {SOURCE_SHA256}\nactual   {sha256(pdf)}"
        )
    if not shutil.which("pdfimages"):
        raise SystemExit("Poppler pdfimages is required")

    root = game_dir / "assets" / "official-pnp"
    faces = root / "source-faces"
    placards = root / "placards"
    boards = root / "boards"
    for directory in (faces, placards, boards):
        directory.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="forge-secret-hitler-pnp-") as temp_name:
        prefix = Path(temp_name) / "page"
        subprocess.run(["pdfimages", "-j", str(pdf), str(prefix)], check=True)

        # Page 1 has two embedded images; from PDF page 2 onward the native
        # 3300x2550 image number equals the 1-based PDF page number.
        pages = {
            number: Image.open(prefix.parent / f"page-{number:03d}.jpg").convert("L")
            for number in range(2, 14)
        }
        for number, page in pages.items():
            if page.size != (3300, 2550):
                raise RuntimeError(f"PDF page {number}: expected 3300x2550, got {page.size}")

        face_specs = {
            "p_ballot_ja": (5, lambda page: standard_slot(page, 0, 0)),
            "p_ballot_nein": (6, lambda page: standard_slot(page, 0, 0)),
            "p_role_liberal": (7, lambda page: standard_slot(page, 0, 0)),
            "p_party_liberal": (8, lambda page: standard_slot(page, 0, 0)),
            "p_pile_discard": (8, lambda page: standard_slot(page, 1, 0)),
            "p_role_hitler": (8, lambda page: standard_slot(page, 2, 0)),
            "p_role_fascist": (8, lambda page: standard_slot(page, 3, 0)),
            "p_pile_draw": (8, lambda page: standard_slot(page, 1, 1)),
            "p_party_fascist": (9, lambda page: standard_slot(page, 0, 0)),
            "p_policy_liberal": (4, lambda page: page.crop((1250, 575, 1775, 1325))),
            "p_policy_fascist": (
                2,
                lambda page: page.crop((412, 225, 1162, 750)).rotate(-90, expand=True),
            ),
            # Gallery faces are the outward title panels. The complete folded
            # production pieces are preserved separately below and in the PDF.
            "p_placard_chancellor": (
                3,
                lambda page: page.crop((1079, 273, 1709, 2327)).rotate(-90, expand=True),
            ),
            "p_placard_president": (
                3,
                lambda page: page.crop((2325, 273, 2945, 2327)).rotate(-90, expand=True),
            ),
        }
        source_faces = {}
        for printing_id, (page_number, extract) in face_specs.items():
            target = faces / f"{printing_id}.png"
            image = extract(pages[page_number])
            save_png(image, target)
            source_faces[printing_id] = {
                "path": target.relative_to(game_dir).as_posix(),
                "pdf_page": page_number,
                "pixels": [image.width, image.height],
                "sha256": sha256(target),
            }

        full_placards = {
            "chancellor-flat.png": pages[3].crop((471, 273, 1709, 2327)).rotate(-90, expand=True),
            "president-flat.png": pages[3].crop((1707, 273, 2945, 2327)).rotate(90, expand=True),
        }
        for name, image in full_placards.items():
            save_png(image, placards / name)

        board_specs = {
            10: "liberal-board.png",
            11: "fascist-board-5-6.png",
            12: "fascist-board-7-8.png",
            13: "fascist-board-9-10.png",
        }
        board_assets = []
        for page_number, name in board_specs.items():
            target = boards / name
            image = build_board(pages[page_number], page_number)
            save_png(image, target)
            board_assets.append({
                "path": target.relative_to(game_dir).as_posix(),
                "pdf_page": page_number,
                "pixels": [image.width, image.height],
                "sha256": sha256(target),
            })

    pdf_target = root / "Secret_Hitler_Print_and_Play.pdf"
    shutil.copyfile(pdf, pdf_target)

    baseline = {}
    for rel in ("components/cards.json", "components/printings.json"):
        path = game_dir / rel
        if not path.is_file():
            raise SystemExit(f"missing canonical component data: {path}")
        baseline[rel] = sha256(path)

    manifest = {
        "schema_version": 1,
        "kind": "forge-official-pnp-package",
        "title": "Secret Hitler — official Print & Play",
        "source_url": SOURCE_URL,
        "source_sha256": SOURCE_SHA256,
        "license": LICENSE,
        "attribution": (
            "Secret Hitler by Mike Boxleiter, Tommy Maranges, Max Temkin, "
            "and Mackenzie Schubert; published by Goat, Wolf, & Cabbage."
        ),
        "print_pdf": {
            "path": pdf_target.relative_to(game_dir).as_posix(),
            "sha256": sha256(pdf_target),
            "pages": 13,
            "page_size": "US Letter landscape",
            "dpi": DPI,
        },
        "baseline_files": baseline,
        "geometry": {
            "standard_card_px": [750, 1050],
            "policy_tile_px": [525, 750],
            "source_page_px": [3300, 2550],
            "notes": "No resampling is used for gallery faces; the official PDF remains the print truth.",
        },
        "source_faces": source_faces,
        "production_assets": {
            "placards": [
                (placards / name).relative_to(game_dir).as_posix()
                for name in sorted(full_placards)
            ],
            "boards": board_assets,
        },
    }
    (root / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    )
    print(f"Imported {len(source_faces)} exact source faces, 2 placards, and 4 boards")
    print(f"Pinned official PDF -> {pdf_target}")
    print(f"Manifest -> {root / 'manifest.json'}")


if __name__ == "__main__":
    main()
