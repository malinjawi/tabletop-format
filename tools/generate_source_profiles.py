#!/usr/bin/env python3
"""Expand reviewed source-face families into per-card production profiles.

The family file owns frame geometry and numeric donor pools.  This tool keeps
the output card-specific: every generated background and numeric patch is made
against that card's own immutable face, and the compiled overlay still matches
one exact card id.  Tesseract is used only to locate the boundary between rules
and flavor text; deterministic wrapping estimates are the fallback.

Usage: python3 tools/generate_source_profiles.py GAME_DIR
"""

import json
import re
import shutil
import subprocess
import sys
import textwrap
import math
from collections import defaultdict
from pathlib import Path

import yaml


def fail(message):
    raise SystemExit(f"generate_source_profiles: {message}")


def get(value, path):
    for key in str(path or "").split("."):
        if key:
            value = value.get(key) if isinstance(value, dict) else None
    return value


def matches(card, wanted):
    return all(get(card, path) in (value if isinstance(value, list) else [value]) for path, value in (wanted or {}).items())


def words(value):
    value = re.sub(r"\[[^]]+\]", " symbol ", str(value or ""))
    value = re.sub(r"[*_`]+", "", value).lower()
    return re.findall(r"[a-z0-9]+", value)


STOP_WORDS = {"a", "an", "and", "as", "at", "be", "but", "by", "for", "from", "i", "if", "in", "is", "it", "of", "on", "or", "s", "the", "this", "to", "was", "when", "with", "you", "your"}


def estimated_lines(value, width):
    plain = re.sub(r"\[[^]]+\]", "x", re.sub(r"[*_`]+", "", str(value or "")))
    return max(1, sum(max(1, len(textwrap.wrap(part, width=max(8, int(width))))) for part in plain.splitlines() or [""]))


def ocr_lines(path, body):
    binary = shutil.which("tesseract")
    if not binary:
        return []
    try:
        result = subprocess.run(
            [binary, str(path), "stdout", "--psm", "6", "tsv"],
            check=True, capture_output=True, text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    left, top, right, bottom = body["box_px"]
    grouped = defaultdict(list)
    bounds = {}
    rows = result.stdout.splitlines()[1:]
    for row in rows:
        parts = row.split("\t")
        if len(parts) < 12 or not parts[11].strip():
            continue
        try:
            block, paragraph, line = (int(parts[index]) for index in (2, 3, 4))
            x, y, width, height = (int(parts[index]) for index in (6, 7, 8, 9))
        except ValueError:
            continue
        if y + height < top or y > bottom or x + width < left or x > right:
            continue
        key = (block, paragraph, line)
        grouped[key].append(parts[11].strip())
        if key not in bounds:
            bounds[key] = [x, y, x + width, y + height]
        else:
            bounds[key] = [min(bounds[key][0], x), min(bounds[key][1], y), max(bounds[key][2], x + width), max(bounds[key][3], y + height)]
    output = []
    for key, tokens in grouped.items():
        box = bounds[key]
        output.append({"text": " ".join(tokens), "tokens": set(words(" ".join(tokens))), "top": box[1], "bottom": box[3]})
    return sorted(output, key=lambda item: (item["top"], item["bottom"]))


def body_boxes(source_card, source_printing, family, scan_path):
    body = family["body"]
    left, top, right, bottom = body["box_px"]
    rules = source_card.get("text") or ""
    flavor = source_printing.get("flavor_text") or ""
    rule_tokens, flavor_tokens = set(words(rules)), set(words(flavor))
    distinctive_flavor = {token for token in flavor_tokens - rule_tokens if len(token) >= 3 and token not in STOP_WORDS}
    lines = ocr_lines(scan_path, body)
    flavor_hits = []
    if flavor:
        for line in lines:
            score = len(line["tokens"] & distinctive_flavor) * 4 + len({token for token in line["tokens"] & flavor_tokens if token not in STOP_WORDS})
            rule_score = len(line["tokens"] & rule_tokens)
            if score >= 2 and score > rule_score:
                flavor_hits.append((line, score))
    if flavor_hits:
        flavor_top = min(item[0]["top"] for item in flavor_hits)
    else:
        line_count = estimated_lines(rules, body.get("wrap_chars", 42))
        flavor_top = top + line_count * int(body.get("line_height_px", 38)) + int(body.get("gap_px", 16))
    flavor_top = max(top + int(body.get("min_rules_height_px", 42)), min(bottom - 28, flavor_top))

    rule_hits = [line for line in lines if line["tokens"] & rule_tokens and line["top"] < flavor_top]
    rule_top = max(top, min((line["top"] for line in rule_hits), default=top) - 8)
    if flavor:
        rule_bottom = max(rule_top + 28, flavor_top - 7)
        flavor_box = [left, max(rule_bottom + 3, flavor_top - 7), right, bottom]
    else:
        last_rule = max((line["bottom"] for line in rule_hits), default=top + estimated_lines(rules, body.get("wrap_chars", 42)) * int(body.get("line_height_px", 38)))
        rule_bottom = min(bottom, max(rule_top + 40, last_rule + 8))
        flavor_start = min(bottom - 28, rule_bottom + int(body.get("gap_px", 16)))
        flavor_box = [left, flavor_start, right, bottom]
    return [left, rule_top, right, rule_bottom], flavor_box


def background_item(card_id, field_id, box, field, scan):
    config = field.get("background") or {}
    result = {
        "id": f"generated_{card_id}_{field_id}_background",
        "source": scan,
        "crop_px": box,
        "method": config.get("method", "inpaint_dark"),
        "output": f"assets/source-patches/{card_id}/{field_id}-background.png",
    }
    for key in ("threshold", "dilate_px", "radius_px", "mask_rects_px", "sample_x_px", "sample_y_px", "sample_px"):
        if key in config:
            result[key] = config[key]
    return result


def main():
    if len(sys.argv) != 2:
        fail("usage: python3 tools/generate_source_profiles.py GAME_DIR")
    game_dir = Path(sys.argv[1]).resolve()
    template_dir = game_dir / "templates"
    config_path = template_dir / "source-profile-families.yaml"
    if not config_path.is_file():
        fail(f"missing {config_path}")
    config = yaml.safe_load(config_path.read_text()) or {}
    cards = json.loads((game_dir / "components" / "cards.json").read_text())
    printings = json.loads((game_dir / "components" / "printings.json").read_text())
    baseline = json.loads((template_dir / "source-baseline-data.json").read_text())
    printing_by_card = {printing["card_id"]: printing for printing in printings}
    source_cards = baseline.get("cards") or {}
    source_printings = baseline.get("printings") or {}
    donor_sets = config.get("donor_sets") or {}
    profiles, backgrounds, patch_sets, pip_patch_sets = [], [], [], []
    seen = set()

    for family in config.get("families") or []:
        skipped = set(family.get("skip_cards") or [])
        targets = [card for card in cards if card["id"] not in skipped and matches(card, family.get("match"))]
        for card in targets:
            if card["id"] in seen:
                fail(f"card {card['id']} matches multiple source profile families")
            seen.add(card["id"])
            printing = printing_by_card[card["id"]]
            scan = printing.get("scan")
            if not scan:
                fail(f"{card['id']} has no source scan")
            source_card = source_cards.get(card["id"], card)
            source_printing = source_printings.get(printing["id"], printing)
            profile = {"id": card["id"], "card_id": card["id"], "card_type": card["type"], "fields": []}

            for field in family.get("fields") or []:
                item = {key: value for key, value in field.items() if key not in ("background",)}
                # A name redraw must not erase a printed uniqueness diamond.
                # The immutable face remains exact when unchanged; on a name
                # edit the baseline marker is reconstructed as part of the
                # same bounded title rectangle. Toggling uniqueness itself is
                # still a frame-defining edit unless a game maps it explicitly.
                if (
                    item.get("id") == "title"
                    and item.get("src") == "name"
                    and get(source_card, "attributes.unique") is True
                    and "prefix" not in item
                ):
                    item["prefix"] = "◆ "
                box = item["box_px"]
                if item.get("style"):
                    asset = f"assets/source-patches/{card['id']}/{item['id']}-background.png"
                    item["background_asset"] = asset
                    backgrounds.append(background_item(card["id"], item["id"], box, field, scan))
                profile["fields"].append(item)

            if family.get("body"):
                rules_box, flavor_box = body_boxes(source_card, source_printing, family, game_dir / scan)
                body_config = family["body"]
                for field_id, src, source, style, box in (
                    ("rules", "text", None, body_config.get("rules_style", "rules"), rules_box),
                    ("flavor", "flavor_text", "printing", body_config.get("flavor_style", "flavor"), flavor_box),
                ):
                    render = {"max_lines": max(1, math.ceil((box[3] - box[1]) / max(20, body_config.get("line_height_px", 38))) + 1)}
                    item = {"id": field_id, "src": src, "box_px": box, "style": style, "background_asset": f"assets/source-patches/{card['id']}/{field_id}-background.png", "render": render}
                    if source:
                        item["source"] = source
                    profile["fields"].append(item)
                    background_field = {"background": body_config.get("background") or {"method": "inpaint_dark", "threshold": 180}}
                    backgrounds.append(background_item(card["id"], field_id, box, background_field, scan))

            for numeric in family.get("numeric_fields") or []:
                donor_name = numeric.get("donor_set")
                donor = donor_sets.get(donor_name)
                if not donor:
                    fail(f"{family['id']}.{numeric['id']}: unknown donor_set {donor_name}")
                output_pattern = f"assets/source-patches/{card['id']}/{numeric['id']}-{{value}}.png"
                item = {"id": numeric["id"], "src": numeric.get("src", numeric["id"]), "box_px": numeric.get("box_px") or donor["crop_px"], "patches": {str(value): output_pattern.format(value=value) for value in donor["donors"]}}
                profile["fields"].append(item)
                patch_sets.append({
                    "id": f"generated_{card['id']}_{numeric['id']}", "target_card": card["id"],
                    "field": item["src"], "crop_px": item["box_px"], "donors": donor["donors"],
                    "mask": donor["mask"], "output_pattern": output_pattern,
                })
            profiles.append(profile)

    # Pip tracks are finite visual fields just like numeric badges, but their
    # geometry is a sequence of on/off positions rather than one printed
    # numeral.  Keep this generic: a game declares the track, the source field,
    # and inspected empty/filled donor faces.  The patch builder then derives a
    # transparent, card-specific patch for every allowed count.
    for track_id, track in (config.get("pip_tracks") or {}).items():
        field = track.get("field")
        crop = track.get("crop_px")
        centers = track.get("centers_px") or []
        values = track.get("values") or list(range(len(centers) + 1))
        if not field or not isinstance(crop, list) or len(crop) != 4 or not centers:
            fail(f"pip_tracks.{track_id} needs field, crop_px, and centers_px")
        for card in cards:
            if not matches(card, track.get("match")) or get(card, field) is None:
                continue
            output_pattern = f"assets/source-patches/{card['id']}/{track_id}-{{value}}.png"
            profiles.append({
                "id": f"{card['id']}_{track_id}",
                "card_id": card["id"],
                "card_type": card["type"],
                "fields": [{
                    "id": track_id,
                    "src": field,
                    "box_px": crop,
                    "patches": {str(value): output_pattern.format(value=value) for value in values},
                }],
            })
            pip_patch_sets.append({
                "id": f"generated_{card['id']}_{track_id}",
                "target_card": card["id"],
                "field": field,
                "baseline_value": get(source_cards.get(card["id"], card), field),
                "crop_px": crop,
                "centers_px": centers,
                "values": values,
                "empty_donor": track.get("empty_donor"),
                "filled_donor": track.get("filled_donor"),
                "filled_donor_value": track.get("filled_donor_value"),
                "radius_px": track.get("radius_px", 14),
                "threshold": track.get("threshold", 10),
                "dilate_px": track.get("dilate_px", 1),
                "feather_px": track.get("feather_px", 0.45),
                "output_pattern": output_pattern,
            })

    missing = sorted(card["id"] for card in cards if card["id"] not in seen and card["id"] not in set(config.get("externally_profiled_cards") or []))
    if missing:
        fail("cards have no generated or external profile: " + ", ".join(missing))

    outputs = {
        "source-field-profiles.generated.yaml": {"schema_version": 1, "profiles": profiles},
        "source-background-sources.generated.yaml": {"schema_version": 1, "canonical_size_px": config.get("canonical_size_px", [744, 1030]), "backgrounds": backgrounds},
        "source-patch-sources.generated.yaml": {
            "schema_version": 1,
            "canonical_size_px": config.get("canonical_size_px", [744, 1030]),
            "patch_sets": patch_sets,
            "pip_patch_sets": pip_patch_sets,
        },
    }
    for name, document in outputs.items():
        path = template_dir / name
        path.write_text(yaml.safe_dump(document, sort_keys=False, allow_unicode=True, width=1000))
        print(f"Wrote {path.relative_to(game_dir)}")
    print(
        f"Generated {len(profiles)} card profiles, {len(backgrounds)} clean regions, "
        f"{len(patch_sets)} numeric patch sets, and {len(pip_patch_sets)} pip patch sets"
    )


if __name__ == "__main__":
    main()
