#!/usr/bin/env python3
"""Focused contract test for exact-version TTS card + component staging."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def digest(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    with tempfile.TemporaryDirectory(prefix="forge-tts-test-") as temporary:
        game_dir = Path(temporary) / "ember"
        shutil.copytree(ROOT / "examples" / "ember", game_dir,
                        ignore=shutil.ignore_patterns("exports"))
        setup_dir = game_dir / "setups"
        setup_dir.mkdir()
        setup = {
            "schema_version": 1, "id": "staged-components", "name": "Staged components",
            "board": {"width": 1600, "height": 1000, "background": "#17211f"},
            "seats": [{"id": "player-one", "name": "Player one", "position": {"x": 720, "y": 900}}],
            "zones": [{"id": "draw", "name": "Draw", "kind": "draw", "position": {"x": 100, "y": 100},
                       "size": {"width": 120, "height": 180}, "layout": "stack", "card_face": "down"}],
            "stacks": [{"id": "main-stack", "name": "Burn Rush", "deck_id": "burn-rush",
                        "zone_id": "draw", "face": "down", "shuffle": True}],
            "pieces": [
                {"id": "starting-spark", "component_id": "spark_token", "quantity": 2,
                 "position": {"x": 400, "y": 500}, "rotation": 15},
                {"id": "spent-ash", "component_id": "ash_token", "quantity": 1,
                 "position": {"x": 600, "y": 500}, "face": "back"},
            ],
            "counters": [{"id": "score", "name": "Score", "initial": 0,
                          "position": {"x": 800, "y": 500}}],
        }
        (setup_dir / "staged-components.yaml").write_text(yaml.safe_dump(setup, sort_keys=False))
        command = [str(ROOT / ".venv" / "bin" / "python"), str(ROOT / "tools" / "export_tts.py"),
                   str(game_dir), "--ref", "abc123", "--face-url", "https://forge.invalid/sheet.png",
                   "--back-url", "https://forge.invalid/back.png",
                   "--component-base-url", "https://forge.invalid/tts-components"]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr or result.stdout
        out = game_dir / "exports" / "tts"
        save_path, manifest_path = out / "ember.json", out / "tts-manifest.json"
        save, manifest = json.loads(save_path.read_text()), json.loads(manifest_path.read_text())

        stacks = [item for item in save["ObjectStates"] if item["Name"] == "DeckCustom"]
        components = [item for item in save["ObjectStates"] if "forge-component" in item.get("Tags", [])]
        assert len(stacks) == 1 and len(stacks[0]["DeckIDs"]) == 14
        assert len(components) == 28
        assert {item["Name"] for item in components} == {"Custom_Token"}
        counters = [item for item in save["ObjectStates"] if item["Name"] == "Counter"]
        assert len(counters) == 1 and counters[0]["Counter"] == {"value": 0}
        assert counters[0]["ColorDiffuse"] == {"r": 1.0, "g": 1.0, "b": 1.0}
        assert len(save["SnapPoints"]) == 4
        assert manifest["source_ref"] == "abc123"
        assert manifest["setup"] == {"id": "staged-components", "source": "setups/staged-components.yaml"}
        assert manifest["objects"] == {"card_stacks": 1, "components": 28, "setup_counters": 1, "snap_points": 4}
        assert len(manifest["component_placements"]) == 2
        assert manifest["rights"]["publishable_project"] is True
        assert any("native interactive TTS Counter" in item for item in manifest["boundaries"])

        spark = [item for item in components if item["Nickname"] == "Spark"]
        ash = [item for item in components if item["Nickname"] == "Ash"]
        assert len(spark) == 20 and len(ash) == 6
        assert spark[0]["Transform"]["posX"] == -10.0 and spark[0]["Transform"]["rotY"] == 15
        assert ash[0]["Transform"]["rotZ"] == 180
        assert spark[0]["CustomImage"]["ImageURL"].startswith("https://forge.invalid/tts-components/")
        assert '"forge_ref": "abc123"' in spark[0]["GMNotes"]

        asset_manifest = json.loads((out / "components" / "component-assets.json").read_text())
        assert asset_manifest["source_ref"] == "abc123"
        assert all(asset["width_px"] <= 4096 and asset["height_px"] <= 4096
                   for component in asset_manifest["components"] for asset in component["assets"])
        for component in asset_manifest["components"]:
            for asset in component["assets"]:
                image = Image.open(out / "components" / asset["file"])
                assert image.mode == "RGBA" and image.getpixel((0, 0))[3] == 0

        first_hashes = {path.relative_to(out).as_posix(): digest(path)
                        for path in out.rglob("*") if path.is_file()}
        again = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        assert again.returncode == 0, again.stderr or again.stdout
        second_hashes = {path.relative_to(out).as_posix(): digest(path)
                         for path in out.rglob("*") if path.is_file()}
        assert first_hashes == second_hashes, "same source/ref did not reproduce byte-identical TTS output"

    print("TTS component/setup export: staged, rights-aware, 4096-safe, deterministic")


if __name__ == "__main__":
    main()
