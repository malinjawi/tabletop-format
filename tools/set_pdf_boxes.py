#!/usr/bin/env python3
"""Apply production MediaBox, BleedBox, TrimBox and CropBox values to a PDF."""

import argparse
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject


MM_TO_PT = 72.0 / 25.4


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--trim-width-mm", type=float, required=True)
    parser.add_argument("--trim-height-mm", type=float, required=True)
    parser.add_argument("--bleed-mm", type=float, default=0)
    args = parser.parse_args()

    reader = PdfReader(args.input)
    writer = PdfWriter()
    bleed = args.bleed_mm * MM_TO_PT
    trim_w = args.trim_width_mm * MM_TO_PT
    trim_h = args.trim_height_mm * MM_TO_PT
    media = RectangleObject([0, 0, trim_w + 2 * bleed, trim_h + 2 * bleed])
    trim = RectangleObject([bleed, bleed, bleed + trim_w, bleed + trim_h])
    for page in reader.pages:
        page.mediabox = media
        page.bleedbox = media
        page.trimbox = trim
        page.cropbox = media
        writer.add_page(page)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as stream:
        writer.write(stream)


if __name__ == "__main__":
    main()
