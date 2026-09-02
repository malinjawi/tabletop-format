#!/usr/bin/env python3
"""Import a 3x3 print-and-play PDF as local source-face references.

Usage:
  python3 tools/import_pnp_pdf.py <pdf> <game-dir>
      [--first-page 2] [--dpi 300] [--source-url URL]

The PDF must contain crop marks around a regular 3x3 card grid. Pages are
rendered with Poppler, crop lines are detected from the white page margins,
and cards are mapped in row-major order to printings sorted by collector
number. The composed source faces remain distinct from editable card art.
"""
import argparse
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image


def groups(values):
    out = []
    for value in values:
        if not out or value > out[-1][-1] + 1:
            out.append([value])
        else:
            out[-1].append(value)
    return out


def grid_lines(image, cols=3, rows=3):
    """Detect the four vertical/horizontal crop-mark axes on a white page."""
    gray = image.convert("L")
    px = gray.load()
    width, height = gray.size

    top_h = max(80, round(height * 0.058))
    left_w = max(60, round(width * 0.05))
    x_counts = [sum(px[x, y] < 120 for y in range(top_h)) for x in range(width)]
    y_counts = [sum(px[x, y] < 120 for x in range(left_w)) for y in range(height)]
    x_groups = [g for g in groups(i for i, n in enumerate(x_counts) if n >= top_h * 0.14)
                if len(g) <= 5]
    y_groups = [g for g in groups(i for i, n in enumerate(y_counts) if n >= left_w * 0.14)
                if len(g) <= 5]
    xs = [round(sum(g) / len(g)) for g in x_groups]
    ys = [round(sum(g) / len(g)) for g in y_groups]
    if len(xs) != cols + 1 or len(ys) != rows + 1:
        raise RuntimeError(
            f"could not detect {cols + 1}x{rows + 1} crop axes "
            f"(found x={xs}, y={ys})"
        )
    return xs, ys


def collector_key(printing):
    value = str(printing.get("collector_number", ""))
    digits = "".join(ch for ch in value if ch.isdigit())
    return (int(digits) if digits else math.inf, value, printing["id"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("game_dir", type=Path)
    parser.add_argument("--first-page", type=int, default=2,
                        help="1-based first PDF page containing cards (default: 2)")
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--source-url", default="")
    parser.add_argument("--quality", type=int, default=92)
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

    printings = json.loads(printings_path.read_text())
    ordered = sorted(printings, key=collector_key)
    slots_per_page = 9
    page_count = math.ceil(len(ordered) / slots_per_page)
    last_page = args.first_page + page_count - 1
    out_dir = game_dir / "assets" / "pnp-scans"
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="forge-pnp-") as temp:
        prefix = Path(temp) / "page"
        subprocess.run([
            "pdftoppm", "-f", str(args.first_page), "-l", str(last_page),
            "-png", "-r", str(args.dpi), str(pdf), str(prefix),
        ], check=True)
        pages = sorted(Path(temp).glob("page-*.png"))
        if len(pages) != page_count:
            raise RuntimeError(f"expected {page_count} rendered pages, found {len(pages)}")

        imported = 0
        geometry = None
        for page_path in pages:
            page = Image.open(page_path).convert("RGB")
            xs, ys = grid_lines(page)
            current = (tuple(xs), tuple(ys))
            if geometry is None:
                geometry = current
            elif current != geometry:
                raise RuntimeError(f"crop geometry changed on {page_path.name}: {current}")
            for row in range(3):
                for col in range(3):
                    if imported >= len(ordered):
                        break
                    printing = ordered[imported]
                    face = page.crop((xs[col], ys[row], xs[col + 1], ys[row + 1]))
                    rel = Path("assets") / "pnp-scans" / f"{printing['id']}.webp"
                    face.save(game_dir / rel, "WEBP", quality=args.quality, method=6)
                    printing["scan"] = rel.as_posix()
                    printing["scan_provenance"] = {
                        "source": "human",
                        "creator": "Null Signal Games",
                        "license": "Official print-and-play; private proof of concept",
                        **({"source_url": args.source_url} if args.source_url else {}),
                        "notes": "Composed face cropped from the official PnP PDF; not editable card art.",
                    }
                    imported += 1

    printings_path.write_text(json.dumps(printings, indent=2, ensure_ascii=False) + "\n")
    source = out_dir / "SOURCE.md"
    source.write_text(
        "# Official print-and-play source faces\n\n"
        "Private Forge proof-of-concept reference images cropped from the official "
        "Null Signal Games print-and-play PDF. These are composed card faces, not "
        "editable art layers and not covered by the separate CC BY-ND visual-symbol "
        "pack. Do not publish or redistribute this directory without permission.\n\n"
        + (f"Source: {args.source_url}\n" if args.source_url else f"Source PDF: {pdf.name}\n")
    )
    print(f"Imported {imported} source faces at {args.dpi}dpi -> {out_dir}")
    print(f"Crop axes: x={list(geometry[0])}, y={list(geometry[1])}")


if __name__ == "__main__":
    main()
