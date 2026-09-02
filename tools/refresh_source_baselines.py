#!/usr/bin/env python3
"""Refresh immutable source-overlay baselines from canonical game data.

The command is renderer-neutral and works for any game using
``templates/source-overlay.yaml``.  It updates only the generated ``baselines``
tail, preserving the human-reviewed region declarations and their comments.

Usage:
  python3 tools/refresh_source_baselines.py GAME_DIR
  python3 tools/refresh_source_baselines.py GAME_DIR --check
"""

import argparse
import json
import re
from pathlib import Path

import yaml


def source_get(obj, path):
    value = obj
    for key in str(path or "").split("."):
        if not key:
            continue
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def source_delete(obj, path):
    keys = [key for key in str(path or "").split(".") if key]
    parent = obj
    for key in keys[:-1]:
        if not isinstance(parent, dict):
            return
        parent = parent.get(key)
    if isinstance(parent, dict) and keys:
        parent.pop(keys[-1], None)


def source_matches(card, match):
    for path, wanted in (match or {}).items():
        choices = wanted if isinstance(wanted, list) else [wanted]
        if source_get(card, path) not in choices:
            return False
    return True


def hash_value(value):
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    hash_ = 0x811C9DC5
    for character in text:
        hash_ ^= ord(character)
        hash_ = (hash_ * 0x01000193) & 0xFFFFFFFF
    return f"fnv1a:{hash_:08x}"


def signature(card, regions, nonvisual_fields=None):
    copy = json.loads(json.dumps(card))
    for path in nonvisual_fields or []:
        source_delete(copy, path)
    for region in regions:
        if region.get("source", "card") == "card":
            source_delete(copy, region["src"])
    return hash_value(copy)


def printing_signature(printing, regions):
    copy = {
        "set_id": printing.get("set_id"),
        "collector_number": printing.get("collector_number"),
        "artist": printing.get("artist"),
        "flavor_text": printing.get("flavor_text"),
        "variant": printing.get("variant"),
    }
    for region in regions:
        if region.get("source", "card") == "printing":
            source_delete(copy, region["src"])
    return hash_value(copy)


def baseline_block(cards, printings, regions, pinned=None, nonvisual_fields=None):
    first_printing = {}
    for printing in printings:
        first_printing.setdefault(printing["card_id"], printing)
    lines = ["baselines:"]
    count = 0
    for card in cards:
        printing = first_printing.get(card["id"])
        if not printing or not printing.get("scan"):
            continue
        matched = [region for region in regions if source_matches(card, region.get("match"))]
        baseline_card = (pinned or {}).get("cards", {}).get(card["id"], card)
        baseline_printing = (pinned or {}).get("printings", {}).get(printing["id"], printing)
        values = {}
        for region in matched:
            printing_source = region.get("source", "card") == "printing"
            key = f"printing.{region['src']}" if printing_source else region["src"]
            values[key] = source_get(baseline_printing if printing_source else baseline_card, region["src"])
        values_text = json.dumps(values, ensure_ascii=False, separators=(", ", ": "))
        lines.append(
            f"  {json.dumps(card['id'], ensure_ascii=False)}: "
            f"{{ signature: {json.dumps(signature(baseline_card, matched, nonvisual_fields))}, "
            f"printing_signature: {json.dumps(printing_signature(baseline_printing, matched))}, "
            f"values: {values_text} }}"
        )
        count += 1
    return "\n".join(lines) + "\n", count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_dir", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    game_dir = args.game_dir.resolve()
    overlay_path = game_dir / "templates" / "source-overlay.yaml"
    cards_path = game_dir / "components" / "cards.json"
    printings_path = game_dir / "components" / "printings.json"
    for path in (overlay_path, cards_path, printings_path):
        if not path.is_file():
            raise SystemExit(f"refresh_source_baselines: missing {path}")

    original = overlay_path.read_text()
    overlay = yaml.safe_load(original) or {}
    pinned = None
    if overlay.get("baseline_data"):
        baseline_path = game_dir / overlay["baseline_data"]
        if not baseline_path.is_file():
            raise SystemExit(f"refresh_source_baselines: missing pinned data {baseline_path}")
        pinned = json.loads(baseline_path.read_text())
        if overlay.get("source_ref") and pinned.get("source_ref") != overlay["source_ref"]:
            raise SystemExit("refresh_source_baselines: source_ref does not match pinned baseline data")
    block, count = baseline_block(
        json.loads(cards_path.read_text()),
        json.loads(printings_path.read_text()),
        overlay.get("regions") or [],
        pinned,
        overlay.get("nonvisual_card_fields") or [],
    )
    marker = re.search(r"(?m)^baselines:\s*$", original)
    if not marker:
        raise SystemExit("refresh_source_baselines: source-overlay.yaml has no baselines: marker")
    refreshed = original[: marker.start()] + block
    if args.check:
        if refreshed != original:
            raise SystemExit("source overlay baselines are stale; run refresh_source_baselines.py")
        print(f"Source overlay baselines are current ({count} scan-backed cards)")
        return
    overlay_path.write_text(refreshed)
    print(f"Refreshed {count} immutable source-overlay baseline(s) in {overlay_path}")


if __name__ == "__main__":
    main()
