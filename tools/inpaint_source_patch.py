#!/usr/bin/env python3
"""Create a deterministic text-free background patch from a source face.

This is intentionally small and renderer-neutral: it removes bright or dark
lettering inside one declared rectangle and fills those pixels from the nearest
known neighbours. The source face stays immutable; the generated patch becomes
a reviewable game asset used only when its mapped text field changes.

Usage:
  python tools/inpaint_source_patch.py INPUT OUTPUT --rect-pct X,Y,W,H [--mask light|dark]
"""
import argparse
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter


def parse_rect(value):
    parts = [float(part) for part in value.split(",")]
    if len(parts) != 4 or any(part < 0 for part in parts) or parts[0] + parts[2] > 100 or parts[1] + parts[3] > 100:
        raise argparse.ArgumentTypeError("rect must be X,Y,W,H percentages within the image")
    return parts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--rect-pct", required=True, type=parse_rect)
    parser.add_argument("--mask", choices=("light", "dark"), default="light")
    parser.add_argument("--threshold", type=int, default=232)
    parser.add_argument("--dilate", type=int, default=5)
    args = parser.parse_args()

    source = Image.open(args.input).convert("RGB")
    x, y, width, height = args.rect_pct
    box = (
        round(source.width * x / 100),
        round(source.height * y / 100),
        round(source.width * (x + width) / 100),
        round(source.height * (y + height) / 100),
    )
    patch = source.crop(box)
    gray = patch.convert("L")
    if args.mask == "light":
        mask = gray.point(lambda value: 255 if value >= args.threshold else 0)
    else:
        mask = gray.point(lambda value: 255 if value <= args.threshold else 0)
    size = max(3, int(args.dilate) | 1)
    mask = mask.filter(ImageFilter.MaxFilter(size))

    pixels = patch.load()
    masked = mask.load()
    known = [[masked[col, row] == 0 for col in range(patch.width)] for row in range(patch.height)]
    queue = deque()
    queued = set()
    for row in range(patch.height):
        for col in range(patch.width):
            if known[row][col]:
                continue
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                nx, ny = col + dx, row + dy
                if 0 <= nx < patch.width and 0 <= ny < patch.height and known[ny][nx]:
                    queue.append((col, row)); queued.add((col, row)); break

    while queue:
        col, row = queue.popleft()
        neighbours = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nx, ny = col + dx, row + dy
                if 0 <= nx < patch.width and 0 <= ny < patch.height and known[ny][nx]:
                    neighbours.append(pixels[nx, ny])
        if not neighbours:
            continue
        pixels[col, row] = tuple(round(sum(value[channel] for value in neighbours) / len(neighbours)) for channel in range(3))
        known[row][col] = True
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nx, ny = col + dx, row + dy
            if 0 <= nx < patch.width and 0 <= ny < patch.height and not known[ny][nx] and (nx, ny) not in queued:
                queue.append((nx, ny)); queued.add((nx, ny))

    softened = patch.filter(ImageFilter.GaussianBlur(1.15))
    patch = Image.composite(softened, patch, mask)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    patch.save(args.output, format="PNG", optimize=True)
    print(f"Source patch: {box} -> {args.output} ({patch.width}x{patch.height})")


if __name__ == "__main__":
    main()
