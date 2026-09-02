"""Renderer adapter registry for version-controlled card design sources."""
from copy import deepcopy
from pathlib import Path

import yaml

from card_design import MANIFEST as CARD_DESIGN_MANIFEST, load_card_design


MANIFEST = "templates/card-design/engines.yaml"


def _load(path):
    return yaml.safe_load(Path(path).read_text()) or {}


def _inside(parent, child):
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _engine_file(game_dir, rel, label):
    game_dir = Path(game_dir).resolve()
    if not isinstance(rel, str) or not rel.startswith("templates/card-design/"):
        raise ValueError(f"{label} must be under templates/card-design/: {rel}")
    path = (game_dir / rel).resolve()
    if not _inside(game_dir / "templates/card-design", path):
        raise ValueError(f"{label} escapes templates/card-design/: {rel}")
    if not path.is_file():
        raise ValueError(f"{label} does not exist: {rel}")
    return path


def _public_engine(engine):
    return {
        "id": engine["id"],
        "type": engine["type"],
        "label": engine["label"],
        "description": engine.get("description") or "",
        "source": engine["source"],
        "status": engine.get("status") or "experimental",
        "families": deepcopy(engine.get("families") or []),
    }


def load_design_engines(game_dir, normalize_layout=lambda value: value):
    game_dir = Path(game_dir).resolve()
    registry_path = game_dir / MANIFEST
    if not registry_path.exists():
        if not (game_dir / CARD_DESIGN_MANIFEST).exists():
            return None
        card_design = load_card_design(game_dir, normalize_layout)
        return {
            "version": 1,
            "manifest_path": None,
            "inferred": True,
            "active": "forge-native",
            "engines": [{
                "id": "forge-native",
                "type": "forge-native",
                "label": "Forge native",
                "description": "Inferred from the existing composable YAML card design.",
                "source": CARD_DESIGN_MANIFEST,
                "status": "active",
                "families": [family["id"] for family in card_design["families"]],
            }],
            "card_design": card_design,
        }

    registry = _load(registry_path)
    if registry.get("version") != 1:
        raise ValueError(f"unsupported design engines manifest version: {registry.get('version')}")
    if not registry.get("engines"):
        raise ValueError("design engines manifest needs at least one engine")
    engines, seen = [], set()
    for engine in registry["engines"]:
        if engine["id"] in seen:
            raise ValueError(f"duplicate design engine: {engine['id']}")
        seen.add(engine["id"])
        _engine_file(game_dir, engine["source"], f"design engine {engine['id']}")
        engines.append(_public_engine(engine))
    active = next((engine for engine in engines if engine["id"] == registry.get("active")), None)
    if not active:
        raise ValueError(f"active design engine does not exist: {registry.get('active')}")
    if active["type"] != "forge-native":
        raise ValueError(f"design engine '{active['id']}' is {active['status']}; only forge-native can be active today")
    card_design = load_card_design(game_dir, normalize_layout, active["source"])
    return {
        "version": registry["version"],
        "manifest_path": MANIFEST,
        "inferred": False,
        "active": active["id"],
        "engines": engines,
        "card_design": card_design,
    }


def design_engines_metadata(registry):
    if not registry:
        return None
    return {key: deepcopy(value) for key, value in registry.items() if key != "card_design"}
