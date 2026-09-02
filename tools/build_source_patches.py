#!/usr/bin/env python3
"""Build deterministic card-specific patches from immutable source scans.

The source PnP PDF is flattened, so Forge cannot edit its text or shapes as
layers. A patch manifest may identify a donor face with the exact printed value
and a mask covering one complete UI badge on one target card. This command
normalizes both to the target render size, crops at integer pixels, and writes a
transparent PNG. The browser only scales that finished patch with the card; it
never repositions a whole donor scan through fractional CSS coordinates.

Usage: python3 tools/build_source_patches.py <game-dir>
"""
import json, sys
from pathlib import Path

import yaml
from PIL import Image, ImageChops, ImageDraw, ImageFilter


def fail(message):
    raise SystemExit(f"build_source_patches: {message}")


def normalized_face(path, size):
    face = Image.open(path).convert("RGBA")
    return face if face.size == size else face.resize(size, Image.Resampling.LANCZOS)


def build_pip_patch_set(group, scans, size, game_dir):
    """Build finite on/off track patches from inspected source pixels.

    Empty and filled donors provide the actual printed socket pixels.  Each
    target remains card-specific: only pixels that differ from that target's
    immutable face are kept, inside a feathered circular guard at every slot.
    """
    target_id = group.get("target_card")
    empty_id, filled_id = group.get("empty_donor"), group.get("filled_donor")
    target_path, empty_path, filled_path = scans.get(target_id), scans.get(empty_id), scans.get(filled_id)
    if not target_path or not empty_path or not filled_path:
        fail(f"pip patch set '{group.get('id')}': target and empty/filled donor scans must exist")
    crop = tuple(int(value) for value in group.get("crop_px") or [])
    centers = [tuple(int(value) for value in center) for center in (group.get("centers_px") or [])]
    if len(crop) != 4 or not centers:
        fail(f"pip patch set '{group.get('id')}': invalid crop_px or centers_px")
    if crop[0] < 0 or crop[1] < 0 or crop[2] > size[0] or crop[3] > size[1]:
        fail(f"pip patch set '{group.get('id')}': crop is outside {size[0]}x{size[1]}")
    if any(not (crop[0] <= x < crop[2] and crop[1] <= y < crop[3]) for x, y in centers):
        fail(f"pip patch set '{group.get('id')}': every center must stay inside crop_px")

    target = normalized_face(target_path, size)
    empty = normalized_face(empty_path, size)
    filled = normalized_face(filled_path, size)
    baseline = int(group.get("baseline_value") or 0)
    filled_count = int(group.get("filled_donor_value") or 0)
    if filled_count < 1 or filled_count > len(centers):
        fail(f"pip patch set '{group.get('id')}': filled_donor_value must identify at least one filled slot")
    radius = int(group.get("radius_px", 14))
    threshold = int(group.get("threshold", 10))
    dilation = int(group.get("dilate_px", 1))
    feather = float(group.get("feather_px", 0.45))
    first_filled = len(centers) - filled_count
    built = 0

    for value in group.get("values") or range(len(centers) + 1):
        wanted = int(value)
        if wanted < 0 or wanted > len(centers):
            fail(f"pip patch set '{group.get('id')}': value {wanted} is outside track capacity")
        patch = Image.new("RGBA", (crop[2] - crop[0], crop[3] - crop[1]), (0, 0, 0, 0))
        for index, (target_x, target_y) in enumerate(centers):
            was_filled = index >= len(centers) - baseline
            wants_filled = index >= len(centers) - wanted
            if was_filled == wants_filled:
                continue
            donor = filled if wants_filled else empty
            sample_index = index
            if wants_filled and sample_index < first_filled:
                sample_index = first_filled
            sample_x, sample_y = centers[sample_index]
            donor_box = (sample_x - radius, sample_y - radius, sample_x + radius + 1, sample_y + radius + 1)
            target_box = (target_x - radius, target_y - radius, target_x + radius + 1, target_y + radius + 1)
            desired = donor.crop(donor_box)
            current = target.crop(target_box)
            diff = ImageChops.difference(current.convert("RGB"), desired.convert("RGB")).convert("L")
            mask = diff.point(lambda channel: 255 if channel >= threshold else 0)
            if dilation:
                mask = mask.filter(ImageFilter.MaxFilter(dilation * 2 + 1))
            guard = Image.new("L", desired.size, 0)
            ImageDraw.Draw(guard).ellipse((0, 0, desired.width - 1, desired.height - 1), fill=255)
            mask = ImageChops.multiply(mask, guard)
            if feather:
                mask = mask.filter(ImageFilter.GaussianBlur(feather))
            desired.putalpha(mask)
            patch.alpha_composite(desired, (target_x - radius - crop[0], target_y - radius - crop[1]))
        output = game_dir / group["output_pattern"].format(value=wanted)
        output.parent.mkdir(parents=True, exist_ok=True)
        patch.save(output, "PNG", optimize=True)
        built += 1
    return built


def main():
    if len(sys.argv) != 2:
        fail("usage: python3 tools/build_source_patches.py <game-dir>")
    game_dir = Path(sys.argv[1]).resolve()
    manifest_path = game_dir / "templates" / "source-patch-sources.yaml"
    if not manifest_path.exists():
        fail(f"missing {manifest_path}")
    manifest = yaml.safe_load(manifest_path.read_text()) or {}
    generated_path = game_dir / "templates" / "source-patch-sources.generated.yaml"
    generated = yaml.safe_load(generated_path.read_text()) if generated_path.is_file() else {}
    width, height = manifest.get("canonical_size_px") or [744, 1030]
    printings = json.loads((game_dir / "components" / "printings.json").read_text())
    scans = {p["card_id"]: game_dir / p["scan"] for p in printings if p.get("scan")}

    specs = list(manifest.get("patches") or []) + list((generated or {}).get("patches") or [])
    groups = list(manifest.get("patch_sets") or []) + list((generated or {}).get("patch_sets") or [])
    for group in groups:
        for value, donor_card in (group.get("donors") or {}).items():
            specs.append({
                "id": f"{group['id']}_{value}",
                "target_card": group["target_card"],
                "field": group["field"],
                "value": value,
                "donor_card": donor_card,
                "crop_px": group["crop_px"],
                "mask": group["mask"],
                "output": group["output_pattern"].format(value=value),
            })

    built = 0
    for spec in specs:
        donor_id, target_id, output = spec["donor_card"], spec["target_card"], game_dir / spec["output"]
        donor_path = scans.get(donor_id)
        target_path = scans.get(target_id)
        if not donor_path or not donor_path.exists():
            fail(f"patch '{spec['id']}': donor scan '{donor_id}' not found")
        if not target_path or not target_path.exists():
            fail(f"patch '{spec['id']}': target scan '{target_id}' not found")
        donor = normalized_face(donor_path, (width, height))
        target = normalized_face(target_path, (width, height))

        crop = tuple(spec["crop_px"])
        if len(crop) != 4 or crop[0] < 0 or crop[1] < 0 or crop[2] > width or crop[3] > height:
            fail(f"patch '{spec['id']}': crop is outside {width}x{height}")
        patch = donor.crop(crop)

        mask_spec = spec["mask"]
        if mask_spec["type"] == "difference":
            # The donor and target use the same printed badge. Keep only pixels
            # that differ inside the tightly declared crop: the old glyph,
            # the new glyph, and their native shadows. This preserves the
            # target's own frame texture and avoids rectangular donor seams.
            diff = ImageChops.difference(target.convert("RGB"), donor.convert("RGB")).convert("L")
            threshold = int(mask_spec.get("threshold", 10))
            mask = diff.point(lambda value: 255 if value >= threshold else 0)
            dilation = int(mask_spec.get("dilation_px", 0))
            if dilation:
                mask = mask.filter(ImageFilter.MaxFilter(dilation * 2 + 1))
            guard = Image.new("L", (width, height), 0)
            difference_box = tuple(mask_spec.get("box_px") or crop)
            if len(difference_box) != 4 or difference_box[0] < crop[0] or difference_box[1] < crop[1] or difference_box[2] > crop[2] or difference_box[3] > crop[3]:
                fail(f"patch '{spec['id']}': difference mask box must stay inside crop_px")
            ImageDraw.Draw(guard).rectangle(difference_box, fill=255)
            mask = ImageChops.multiply(mask, guard)
        else:
            mask = Image.new("L", (width, height), 0)
            draw = ImageDraw.Draw(mask)
        if mask_spec["type"] == "ellipse":
            draw.ellipse(tuple(mask_spec["box_px"]), fill=255)
        elif mask_spec["type"] == "polygon":
            draw.polygon([tuple(point) for point in mask_spec["points_px"]], fill=255)
        elif mask_spec["type"] != "difference":
            fail(f"patch '{spec['id']}': unknown mask type '{mask_spec['type']}'")
        feather = float(mask_spec.get("feather_px", 0))
        if feather:
            mask = mask.filter(ImageFilter.GaussianBlur(feather))
        patch.putalpha(mask.crop(crop))
        output.parent.mkdir(parents=True, exist_ok=True)
        patch.save(output, "PNG", optimize=True)
        print(f"{spec['id']}: {donor_id} {crop} -> {output.relative_to(game_dir)}")
        built += 1
    pip_groups = list(manifest.get("pip_patch_sets") or []) + list((generated or {}).get("pip_patch_sets") or [])
    for group in pip_groups:
        built += build_pip_patch_set(group, scans, (width, height), game_dir)
        print(f"{group['id']}: built {len(group.get('values') or [])} finite pip states")
    print(f"Built {built} card-specific source patch(es) at {width}x{height}px geometry")


if __name__ == "__main__":
    main()
