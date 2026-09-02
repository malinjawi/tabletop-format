#!/usr/bin/env python3
"""Extract one lossless, dimension-pinned card face from a 3x3 PnP PDF.

Unlike ``import_pnp_pdf.py`` this command is intended for source-reconstruction
and visual-regression work.  It never adds another lossy encode after Poppler
renders the official PDF page, and it records the exact page, slot, and crop
axes beside the PNG.

Usage:
  python3 tools/extract_pnp_face.py PDF GAME_DIR CARD_OR_PRINTING_ID
      [--first-page 2] [--dpi 300] [--size 744x1030] [--output FILE]
  python3 tools/extract_pnp_face.py PDF GAME_DIR --all
      [--first-page 2] [--dpi 300] [--size 744x1030]
      [--update-printings]
"""

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

from import_pnp_pdf import collector_key, grid_lines


def centered_crop(image, size):
    """Crop only grid-rounding pixels; never resample a production face."""
    width, height = size
    if image.width < width or image.height < height:
        raise ValueError(
            f"source slot {image.width}x{image.height} is smaller than requested "
            f"{width}x{height}; refusing to upscale"
        )
    left = (image.width - width) // 2
    top = (image.height - height) // 2
    return image.crop((left, top, left + width, top + height)), (left, top)


def parse_size(value):
    try:
        width, height = (int(part) for part in value.lower().split("x", 1))
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("size must look like 744x1030")
    if width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("size dimensions must be positive")
    return width, height


def save_face(page, xs, ys, printing, page_number, row, col, output, size, dpi, pdf):
    source_box = (xs[col], ys[row], xs[col + 1], ys[row + 1])
    face = page.crop(source_box)
    normalization_crop = (0, 0)
    if size:
        face, normalization_crop = centered_crop(face, size)
    output.parent.mkdir(parents=True, exist_ok=True)
    face.save(output, "PNG", dpi=(dpi, dpi), optimize=True)
    provenance = {
        "schema_version": 1,
        "kind": "forge-pnp-face-extraction",
        "printing_id": printing["id"],
        "card_id": printing["card_id"],
        "source_pdf": str(pdf),
        "pdf_page": page_number,
        "slot": {"row": row, "column": col},
        "page_size_px": [page.width, page.height],
        "grid_axes_px": {"x": xs, "y": ys},
        "source_box_px": list(source_box),
        "normalization_crop_px": list(normalization_crop),
        "output_size_px": [face.width, face.height],
        "dpi": dpi,
        "encoding": "lossless-png",
    }
    output.with_suffix(output.suffix + ".json").write_text(
        json.dumps(provenance, indent=2) + "\n"
    )
    return face


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("game_dir", type=Path)
    parser.add_argument("card_or_printing_id", nargs="?")
    parser.add_argument("--all", action="store_true",
                        help="extract every printing in collector order")
    parser.add_argument("--first-page", type=int, default=2)
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--size", type=parse_size, default=None)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--update-printings",
        action="store_true",
        help=(
            "after a successful --all extraction, point every printing at its "
            "lossless source-faces PNG"
        ),
    )
    args = parser.parse_args()

    pdf = args.pdf.resolve()
    game_dir = args.game_dir.resolve()
    printings_path = game_dir / "components" / "printings.json"
    if not pdf.is_file():
        raise SystemExit(f"PnP PDF not found: {pdf}")
    if not printings_path.is_file():
        raise SystemExit(f"game has no components/printings.json: {game_dir}")
    if not shutil.which("pdftoppm"):
        raise SystemExit("pdftoppm (Poppler) is required")
    if args.all and args.card_or_printing_id:
        raise SystemExit("choose one card/printing id or --all, not both")
    if not args.all and not args.card_or_printing_id:
        raise SystemExit("a card/printing id is required unless --all is used")
    if args.all and args.output:
        raise SystemExit("--output names one file and cannot be combined with --all")
    if args.update_printings and not args.all:
        raise SystemExit("--update-printings requires --all")

    ordered = sorted(json.loads(printings_path.read_text()), key=collector_key)
    if args.all:
        first = args.first_page
        last = first + (len(ordered) - 1) // 9
        out_dir = game_dir / "assets" / "source-faces"
        extracted = 0
        with tempfile.TemporaryDirectory(prefix="forge-pnp-faces-") as temp:
            prefix = Path(temp) / "page"
            subprocess.run(
                [
                    "pdftoppm", "-f", str(first), "-l", str(last),
                    "-png", "-r", str(args.dpi), str(pdf), str(prefix),
                ],
                check=True,
            )
            pages = sorted(Path(temp).glob("page-*.png"))
            expected_pages = last - first + 1
            if len(pages) != expected_pages:
                raise RuntimeError(f"expected {expected_pages} rendered pages, found {len(pages)}")
            for page_offset, page_path in enumerate(pages):
                page_number = first + page_offset
                page = Image.open(page_path).convert("RGB")
                xs, ys = grid_lines(page)
                for slot in range(9):
                    if extracted >= len(ordered):
                        break
                    row, col = divmod(slot, 3)
                    printing = ordered[extracted]
                    output = out_dir / f"{printing['id']}.png"
                    save_face(
                        page, xs, ys, printing, page_number, row, col,
                        output, args.size, args.dpi, pdf,
                    )
                    extracted += 1
        print(
            f"Extracted {extracted} lossless faces from PDF pages {first}-{last} "
            f"-> {out_dir}"
        )
        if args.update_printings:
            printings = json.loads(printings_path.read_text())
            for printing in printings:
                printing["scan"] = f"assets/source-faces/{printing['id']}.png"
                provenance = printing.setdefault("scan_provenance", {})
                provenance["source"] = provenance.get("source") or "publisher"
                provenance["notes"] = (
                    "Lossless native-pixel crop from the declared PnP PDF; see "
                    f"{printing['scan']}.json for page, slot, and crop axes."
                )
            printings_path.write_text(json.dumps(printings, indent=2) + "\n")
            print(f"Updated {len(printings)} printing scan path(s) -> assets/source-faces/*.png")
        return

    matches = [
        (index, printing)
        for index, printing in enumerate(ordered)
        if args.card_or_printing_id in (printing.get("id"), printing.get("card_id"))
    ]
    if len(matches) != 1:
        raise SystemExit(
            f"expected one card/printing named '{args.card_or_printing_id}', found {len(matches)}"
        )
    index, printing = matches[0]
    page_number = args.first_page + index // 9
    slot = index % 9
    row, col = divmod(slot, 3)

    output = args.output
    if output is None:
        output = game_dir / "assets" / "source-faces" / f"{printing['id']}.png"
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="forge-pnp-face-") as temp:
        prefix = Path(temp) / "page"
        subprocess.run(
            [
                "pdftoppm", "-f", str(page_number), "-l", str(page_number),
                "-png", "-singlefile", "-r", str(args.dpi), str(pdf), str(prefix),
            ],
            check=True,
        )
        page = Image.open(prefix.with_suffix(".png")).convert("RGB")
        xs, ys = grid_lines(page)
        face = save_face(
            page, xs, ys, printing, page_number, row, col,
            output, args.size, args.dpi, pdf,
        )
    print(
        f"Extracted {printing['id']} from PDF page {page_number}, "
        f"slot {row + 1},{col + 1} -> {output} ({face.width}x{face.height})"
    )


if __name__ == "__main__":
    main()
