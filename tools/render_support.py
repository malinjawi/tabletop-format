"""Shared helpers for exporters that consume canonical card-face PNGs."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import yaml

from design_engines import load_design_engines


TOOLS = Path(__file__).resolve().parent
DEFAULT_CARD_MM = (63.5, 88.9)


def card_size_mm(game_dir):
    """Return production/source-overlay/layout trim size, or poker defaults."""
    templates = Path(game_dir) / "templates"
    production_path = templates / "production.json"
    source_path = templates / "source-overlay.yaml"
    layout_path = templates / "layout.yaml"
    design_engines = load_design_engines(game_dir)
    card_design = design_engines.get("card_design") if design_engines else None
    if card_design and card_design.get("families"):
        doc = card_design["families"][0]["layout"]
    elif production_path.exists():
        doc = json.loads(production_path.read_text())
    else:
        path = source_path if source_path.exists() else layout_path
        doc = yaml.safe_load(path.read_text()) if path.exists() else {}
    card = (doc or {}).get("card") or {}
    return (float(card.get("w_mm") or DEFAULT_CARD_MM[0]),
            float(card.get("h_mm") or DEFAULT_CARD_MM[1]))


def render_faces(game_dir, out_dir=None):
    """Regenerate faces with the same layoutCard() implementation as the hub."""
    node = os.environ.get("FMT_NODE_BIN") or shutil.which("node")
    if not node:
        raise SystemExit("export: Node.js was not found; set FMT_NODE_BIN")
    args = [node, str(TOOLS / "render_cards.mjs"), str(Path(game_dir).resolve())]
    if out_dir is not None:
        args.append(str(Path(out_dir).resolve()))
    subprocess.run(args, check=True)
