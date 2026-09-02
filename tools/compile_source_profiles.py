#!/usr/bin/env python3
"""Compile concise card-family field profiles into source-overlay regions.

Games own the geometry in ``templates/source-field-profiles.yaml``; Forge owns
this generic compiler.  The generated block is deterministic and can be
reviewed in git like any other production asset.

Usage: python3 tools/compile_source_profiles.py GAME_DIR
"""

import copy
import re
import sys
from pathlib import Path

import yaml


BEGIN = "# BEGIN GENERATED SOURCE FIELD PROFILES"
END = "# END GENERATED SOURCE FIELD PROFILES"


def fail(message):
    raise SystemExit(f"compile_source_profiles: {message}")


def main():
    if len(sys.argv) != 2:
        fail("usage: python3 tools/compile_source_profiles.py GAME_DIR")
    game_dir = Path(sys.argv[1]).resolve()
    profile_path = game_dir / "templates" / "source-field-profiles.yaml"
    overlay_path = game_dir / "templates" / "source-overlay.yaml"
    if not profile_path.is_file() or not overlay_path.is_file():
        fail("game needs templates/source-field-profiles.yaml and source-overlay.yaml")
    spec = yaml.safe_load(profile_path.read_text()) or {}
    generated_path = game_dir / "templates" / "source-field-profiles.generated.yaml"
    generated = yaml.safe_load(generated_path.read_text()) if generated_path.is_file() else {}
    width, height = spec.get("canonical_size_px") or []
    if not width or not height:
        fail("canonical_size_px must be [width, height]")
    styles = spec.get("styles") or {}
    regions = []
    ids = set()
    profiles = list(spec.get("profiles") or []) + list((generated or {}).get("profiles") or [])
    for profile in profiles:
        profile_id = profile.get("id")
        card_id = profile.get("card_id")
        card_type = profile.get("card_type")
        if not profile_id or not card_id or not card_type:
            fail("every profile needs id, card_id, and card_type")
        for field in profile.get("fields") or []:
            field_id = field.get("id")
            box = field.get("box_px")
            if not field_id or not isinstance(box, list) or len(box) != 4:
                fail(f"{profile_id}: every field needs id and box_px [l,t,r,b]")
            left, top, right, bottom = (float(value) for value in box)
            if not (0 <= left < right <= width and 0 <= top < bottom <= height):
                fail(f"{profile_id}.{field_id}: box_px is outside {width}x{height}")
            region_id = f"profile_{profile_id}_{field_id}"
            if region_id in ids:
                fail(f"duplicate generated region id {region_id}")
            ids.add(region_id)
            region = {
                "id": region_id,
                "src": field.get("src") or field_id,
                "match": {"id": card_id, "type": card_type},
                "x_pct": round(left / width * 100, 3),
                "y_pct": round(top / height * 100, 3),
                "w_pct": round((right - left) / width * 100, 3),
                "h_pct": round((bottom - top) / height * 100, 3),
            }
            strategies = [bool(field.get(key)) for key in ("samples", "patches", "style")]
            if sum(strategies) != 1:
                fail(f"{region_id}: declare exactly one of style, samples, or patches")
            if field.get("samples"):
                region["samples"] = {str(key): value for key, value in field["samples"].items()}
            elif field.get("patches"):
                region["patches"] = {str(key): value for key, value in field["patches"].items()}
            else:
                style_name = field.get("style")
                if style_name not in styles:
                    fail(f"{region_id}: unknown style '{style_name}'")
                render = copy.deepcopy(styles[style_name])
                if field.get("background_asset"):
                    render["background_asset"] = field["background_asset"]
                render.update(field.get("render") or {})
                region["render"] = render
            if field.get("source"):
                region["source"] = field["source"]
            for key in ("transform", "separator", "prefix", "suffix"):
                if key in field:
                    region[key] = field[key]
            regions.append(region)

    dumped = yaml.safe_dump(regions, sort_keys=False, allow_unicode=True, width=1000).rstrip()
    indented = "\n".join("  " + line for line in dumped.splitlines())
    block = f"{BEGIN}\n{indented}\n{END}\n\n"
    original = overlay_path.read_text()
    if BEGIN in original or END in original:
        pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n\n?", re.S)
        refreshed, count = pattern.subn(block, original)
        if count != 1:
            fail("generated profile markers are malformed")
    else:
        marker = re.search(r"(?m)^baselines:\s*$", original)
        if not marker:
            fail("source-overlay.yaml has no baselines: marker")
        refreshed = original[: marker.start()] + block + original[marker.start() :]
    overlay_path.write_text(refreshed)
    print(f"Compiled {len(regions)} source field region(s) from {len(profiles)} profile(s)")


if __name__ == "__main__":
    main()
