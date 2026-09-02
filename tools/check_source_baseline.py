#!/usr/bin/env python3
"""Prove that pinned source data reproduces every immutable face unchanged.

Usage: python3 tools/check_source_baseline.py GAME_DIR [--corner-inset 12]
"""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml
from PIL import Image, ImageChops, ImageStat


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_dir", type=Path)
    parser.add_argument("--corner-inset", type=int, default=12)
    args = parser.parse_args()
    game_dir = args.game_dir.resolve()
    root = Path(__file__).resolve().parents[1]
    overlay = yaml.safe_load((game_dir / "templates" / "source-overlay.yaml").read_text())
    baseline_path = game_dir / overlay["baseline_data"]
    pinned = json.loads(baseline_path.read_text())
    cards = json.loads((game_dir / "components" / "cards.json").read_text())
    printings = json.loads((game_dir / "components" / "printings.json").read_text())

    with tempfile.TemporaryDirectory(prefix="forge-source-baseline-") as temp_name:
        temp = Path(temp_name)
        staged = temp / game_dir.name
        staged.mkdir()
        shutil.copy2(game_dir / "game.yaml", staged / "game.yaml")
        shutil.copytree(game_dir / "components", staged / "components")
        shutil.copytree(game_dir / "templates", staged / "templates")
        os.symlink(game_dir / "assets", staged / "assets", target_is_directory=True)
        staged_cards = [pinned["cards"].get(card["id"], card) for card in cards]
        for printing in printings:
            printing.update(pinned["printings"].get(printing["id"], {}))
        (staged / "components" / "cards.json").write_text(json.dumps(staged_cards, indent=2) + "\n")
        (staged / "components" / "printings.json").write_text(json.dumps(printings, indent=2) + "\n")
        rendered = temp / "rendered"
        render_result = subprocess.run(
            ["node", str(root / "tools" / "render_cards.mjs"), str(staged), str(rendered)],
            capture_output=True, text=True,
        )
        if render_result.returncode:
            details = "\n".join(
                part.strip()
                for part in (render_result.stdout, render_result.stderr)
                if part.strip()
            )
            raise SystemExit(f"source baseline render failed:\n{details}")

        failures = []
        full_mae = []
        inset = args.corner_inset
        for printing in printings:
            source = Image.open(game_dir / printing["scan"]).convert("RGB")
            result = Image.open(rendered / f"{printing['id']}.png").convert("RGB")
            difference = ImageChops.difference(source, result)
            interior = difference.crop((inset, inset, source.width - inset, source.height - inset))
            interior_mae = sum(ImageStat.Stat(interior).mean) / 3
            full_mae.append(sum(ImageStat.Stat(difference).mean) / 3)
            if interior_mae != 0:
                failures.append((printing["id"], interior_mae))
        if failures:
            raise SystemExit(f"source baseline mismatch: {failures[:5]}")
        print(
            f"Source baseline exact: {len(printings)}/{len(printings)} faces have "
            f"zero changed interior pixels at ref {pinned['source_ref']} "
            f"(max full-card MAE {max(full_mae):.4f}, rounded corners only)"
        )


if __name__ == "__main__":
    main()
