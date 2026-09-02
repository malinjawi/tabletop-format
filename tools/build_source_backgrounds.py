#!/usr/bin/env python3
"""Build deterministic clean field backgrounds from an immutable source face.

The manifest keeps every reconstructed rectangle auditable.  ``clone`` copies
an already blank rectangle at native pixels.  ``row_profile`` is for flat or
gradient panels such as title bars: every output row is filled from the median
colour of a declared clean sample span on that same source row.  Neither mode
inventively redraws the surrounding card frame.

Usage: python3 tools/build_source_backgrounds.py GAME_DIR
"""

import statistics
import sys
from pathlib import Path

import cv2
import numpy as np
import yaml
from PIL import Image


def fail(message):
    raise SystemExit(f"build_source_backgrounds: {message}")


def box(value, label):
    if not isinstance(value, list) or len(value) != 4:
        fail(f"{label} must be [left, top, right, bottom]")
    result = tuple(int(part) for part in value)
    if result[2] <= result[0] or result[3] <= result[1]:
        fail(f"{label} has no area")
    return result


def row_profile(source, crop_box, sample_x, ignore_dark=False):
    left, top, right, bottom = crop_box
    sample_left, sample_right = (int(value) for value in sample_x)
    if sample_left < 0 or sample_right > source.width or sample_right <= sample_left:
        fail("row_profile sample_x_px is outside the source face")
    output = Image.new("RGB", (right - left, bottom - top))
    pixels = output.load()
    source_pixels = source.load()
    for output_y, source_y in enumerate(range(top, bottom)):
        samples = [source_pixels[x, source_y] for x in range(sample_left, sample_right)]
        if ignore_dark and len(samples) > 8:
            samples = sorted(samples, key=lambda colour: 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2])
            samples = samples[len(samples) // 2 :]
        colour = tuple(round(statistics.median(channel)) for channel in zip(*samples))
        for x in range(output.width):
            pixels[x, output_y] = colour
    return output


def column_profile(source, crop_box, sample_y, ignore_dark=False):
    """Recover a vertical/rotated flat panel from clean pixels per column."""
    left, top, right, bottom = crop_box
    sample_top, sample_bottom = (int(value) for value in sample_y)
    if sample_top < 0 or sample_bottom > source.height or sample_bottom <= sample_top:
        fail("column_profile sample_y_px is outside the source face")
    output = Image.new("RGB", (right - left, bottom - top))
    pixels = output.load()
    source_pixels = source.load()
    for output_x, source_x in enumerate(range(left, right)):
        samples = [source_pixels[source_x, y] for y in range(sample_top, sample_bottom)]
        if ignore_dark and len(samples) > 8:
            samples = sorted(samples, key=lambda colour: 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2])
            samples = samples[len(samples) // 2 :]
        colour = tuple(round(statistics.median(channel)) for channel in zip(*samples))
        for y in range(output.height):
            pixels[output_x, y] = colour
    return output


def inpaint_pixels(source, crop_box, item, polarity):
    """Remove printed glyphs while retaining the local panel texture.

    This is deliberately constrained to the declared crop.  It is useful when
    a source PDF is flattened and there is no clean neighbouring rectangle to
    clone.  The manifest records the threshold/radius, so the recovery is
    deterministic and reviewable rather than a manual paint-over.
    """
    crop = np.array(source.crop(crop_box).convert("RGB"))
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    default_threshold = 105 if polarity == "dark" else 205
    threshold = int(item.get("threshold", default_threshold))
    if polarity == "dark":
        mask = np.where(gray <= threshold, 255, 0).astype(np.uint8)
    else:
        mask = np.where(gray >= threshold, 255, 0).astype(np.uint8)
    if item.get("mask_rects_px"):
        allowed = np.zeros_like(mask)
        left, top, _, _ = crop_box
        for index, raw in enumerate(item["mask_rects_px"]):
            ml, mt, mr, mb = box(raw, f"{item['id']} mask_rects_px[{index}]")
            ml, mr = ml - left, mr - left
            mt, mb = mt - top, mb - top
            cv2.rectangle(allowed, (ml, mt), (mr - 1, mb - 1), 255, thickness=-1)
        mask = cv2.bitwise_and(mask, allowed)
    dilate = int(item.get("dilate_px", 2))
    if dilate > 0:
        kernel = np.ones((dilate * 2 + 1, dilate * 2 + 1), np.uint8)
        mask = cv2.dilate(mask, kernel, iterations=1)
    radius = float(item.get("radius_px", 4))
    recovered = cv2.inpaint(cv2.cvtColor(crop, cv2.COLOR_RGB2BGR), mask, radius, cv2.INPAINT_TELEA)
    return Image.fromarray(cv2.cvtColor(recovered, cv2.COLOR_BGR2RGB))


def main():
    if len(sys.argv) != 2:
        fail("usage: python3 tools/build_source_backgrounds.py GAME_DIR")
    game_dir = Path(sys.argv[1]).resolve()
    manifest_path = game_dir / "templates" / "source-background-sources.yaml"
    if not manifest_path.is_file():
        fail(f"missing {manifest_path}")
    manifest = yaml.safe_load(manifest_path.read_text()) or {}
    generated_path = game_dir / "templates" / "source-background-sources.generated.yaml"
    generated = yaml.safe_load(generated_path.read_text()) if generated_path.is_file() else {}
    default_source = manifest.get("source")
    expected = tuple(manifest.get("canonical_size_px") or ())
    sources = {}

    def load_source(relative):
        if not relative:
            fail("background has no source and the manifest declares no default source")
        if relative not in sources:
            source_path = game_dir / relative
            if not source_path.is_file():
                fail(f"source face not found: {source_path}")
            source = Image.open(source_path).convert("RGB")
            wanted = expected or source.size
            if source.size != wanted:
                fail(
                    f"source face {relative} is {source.width}x{source.height}, "
                    f"expected {wanted[0]}x{wanted[1]}"
                )
            sources[relative] = source
        return sources[relative]

    built = 0
    items = list(manifest.get("backgrounds") or []) + list((generated or {}).get("backgrounds") or [])
    for item in items:
        source_name = item.get("source") or default_source
        source = load_source(source_name)
        crop_box = box(item.get("crop_px"), f"{item.get('id', 'background')} crop_px")
        method = item.get("method")
        if method == "clone":
            sample_box = box(item.get("sample_px"), f"{item['id']} sample_px")
            output = source.crop(sample_box)
            wanted = (crop_box[2] - crop_box[0], crop_box[3] - crop_box[1])
            if output.size != wanted:
                fail(f"{item['id']} clone is {output.size}, expected {wanted}; refusing to resample")
        elif method in ("row_profile", "row_profile_light"):
            output = row_profile(source, crop_box, item.get("sample_x_px") or [], method == "row_profile_light")
        elif method in ("column_profile", "column_profile_light"):
            output = column_profile(source, crop_box, item.get("sample_y_px") or [], method == "column_profile_light")
        elif method in ("inpaint_dark", "inpaint_light"):
            output = inpaint_pixels(source, crop_box, item, method.removeprefix("inpaint_"))
        else:
            fail(f"{item.get('id', 'background')}: unknown method '{method}'")
        destination = game_dir / item["output"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        output.save(destination, "PNG", optimize=True)
        print(f"{item['id']}: {method} {crop_box} -> {destination.relative_to(game_dir)}")
        built += 1
    print(f"Built {built} clean source-field background(s) from {len(sources)} source face(s)")


if __name__ == "__main__":
    main()
