#!/usr/bin/env python3
"""Contract test for the native Tabletop Playground package adapter."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import yaml
from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "examples" / "ember"


SETUP = {
    "schema_version": 1, "id": "adapter-proof", "name": "Adapter proof",
    "board": {"width": 1200, "height": 800, "background": "#17211f"},
    "seats": [{"id": "one", "name": "Player one", "position": {"x": 500, "y": 20}}],
    "zones": [{"id": "draw", "name": "Draw", "kind": "draw",
               "position": {"x": 500, "y": 300}, "size": {"width": 120, "height": 180}}],
    "stacks": [{"id": "deck", "deck_id": "burn-rush", "zone_id": "draw",
                "face": "down", "shuffle": True}],
    "pieces": [{"id": "spark", "component_id": "spark_token", "quantity": 2,
                "position": {"x": 200, "y": 300}}],
    "counters": [{"id": "flame", "name": "Flame", "initial": 5, "minimum": 0,
                  "maximum": 9, "position": {"x": 800, "y": 300}, "color": "#8c2f1b"}],
    "instructions": ["Draw five cards."],
}


class TabletopPlaygroundExportTest(unittest.TestCase):
    def export(self, game: Path, output: Path):
        subprocess.run([
            sys.executable, str(ROOT / "tools" / "export_ttpg.py"),
            str(game), "--ref", "0123456789abcdef", "--output-dir", str(output),
        ], cwd=ROOT, check=True, capture_output=True, text=True)

    def test_package_is_deterministic_schema_shaped_and_staged(self):
        with tempfile.TemporaryDirectory(prefix="forge-ttpg-test-") as tmp:
            root = Path(tmp)
            game = root / "ember"
            shutil.copytree(FIXTURE, game, ignore=shutil.ignore_patterns("exports"))
            (game / "setups").mkdir()
            (game / "setups" / "adapter-proof.yaml").write_text(yaml.safe_dump(SETUP, sort_keys=False))
            out_a, out_b = root / "a", root / "b"
            self.export(game, out_a); self.export(game, out_b)

            zip_a = out_a / "ember-ttpg-v1.zip"
            zip_b = out_b / "ember-ttpg-v1.zip"
            self.assertEqual(hashlib.sha256(zip_a.read_bytes()).hexdigest(),
                             hashlib.sha256(zip_b.read_bytes()).hexdigest())
            with zipfile.ZipFile(zip_a) as archive:
                names = archive.namelist()
                self.assertIn("Ember/Manifest.json", names)
                self.assertNotIn("Ember/manifest.json", names)
                self.assertIn("Ember/States/Ember.vts", names)
                self.assertIn("Ember/forge-ttpg-receipt.json", names)
                self.assertIn("Ember/Thumbnail.jpg", names)
                self.assertTrue(any(name.startswith("Ember/Textures/cards/front-") for name in names))
                self.assertTrue(any(name.startswith("Ember/Textures/components/") for name in names))
                self.assertTrue(all(item.date_time == (1980, 1, 1, 0, 0, 0) for item in archive.infolist()))

            package = out_a / "Ember"
            manifest = json.loads((package / "Manifest.json").read_text())
            self.assertRegex(manifest["GUID"], r"^[A-F0-9]{32}$")
            self.assertNotIn("ModID", manifest)
            receipt = json.loads((out_a / "ttpg-manifest.json").read_text())
            self.assertEqual(receipt["source_ref"], "0123456789abcdef")
            self.assertEqual(receipt["setup"]["id"], "adapter-proof")
            self.assertEqual(receipt["adapter"]["object_template_schema_commit"],
                             "6ec22130a465096b3ae0808e746a9634fd92f0ca")
            self.assertEqual(receipt["archive"]["sha256"], hashlib.sha256(zip_a.read_bytes()).hexdigest())

            template_paths = [path for path in package.glob("*.json")
                              if path.name not in ("Manifest.json", "forge-ttpg-receipt.json")]
            self.assertEqual(len(template_paths), receipt["outputs"]["templates"])
            required = {"Type", "GUID", "Name", "Metadata", "CollisionType", "SurfaceType",
                        "Models", "Tags", "FrontTexture", "BackIndex", "HiddenIndex", "Indices",
                        "CardNames", "CardMetadata", "CardTags"}
            for path in template_paths:
                template = json.loads(path.read_text())
                self.assertTrue(required.issubset(template), path.name)
                self.assertEqual(template["Type"], "Card")
                self.assertRegex(template["GUID"], r"^[A-F0-9]{32}$")
                self.assertTrue((package / "Textures" / template["FrontTexture"]).is_file())
                if template.get("BackTexture"):
                    self.assertTrue((package / "Textures" / template["BackTexture"]).is_file())
                self.assertEqual(set(template["CardNames"]), {str(index) for index in template["Indices"]})

            for atlas in receipt["outputs"]["card_atlases"]:
                with Image.open(package / atlas["file"]) as image:
                    self.assertLessEqual(max(image.size), 4096)
                    self.assertEqual(image.size, (atlas["width"], atlas["height"]))

            state = json.loads((package / "States" / "Ember.vts").read_text())
            self.assertEqual(state["saveStateVersion"], "1.1")
            self.assertEqual(state["requiredPackages"], [{"name": "Ember", "guid": manifest["GUID"]}])
            self.assertEqual(len(state["playerSlotNames"]), 20)
            self.assertEqual(len(state["customPlayerColors"]), 20)
            self.assertEqual(len({item["uniqueId"] for item in state["objects"]}), len(state["objects"]))
            deck = next(item for item in state["objects"] if item["objectName"] == "Burn Rush")
            self.assertEqual(len(deck["stackSerialization"]) + 1, 14)
            self.assertEqual(deck["transform"]["rotation"]["w"], 0)
            self.assertTrue(any("component:spark_token" in item["objectTags"] for item in state["objects"]))
            self.assertTrue(any("counter:flame" in item["objectTags"] for item in state["objects"]))


if __name__ == "__main__":
    unittest.main()
