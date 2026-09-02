"""Composable card-design loader shared by the hub builder and validators."""
from copy import deepcopy
from pathlib import Path

import yaml


MANIFEST = "templates/card-design/manifest.yaml"


def _inside(parent, child):
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _load(path):
    return yaml.safe_load(Path(path).read_text()) or {}


def _design_file(game_dir, rel, label):
    root = Path(game_dir).resolve()
    if not isinstance(rel, str) or not rel.startswith("templates/card-design/"):
        raise ValueError(f"{label} must be under templates/card-design/: {rel}")
    path = (root / rel).resolve()
    if not _inside(root / "templates/card-design", path):
        raise ValueError(f"{label} escapes templates/card-design/: {rel}")
    if not path.is_file():
        raise ValueError(f"{label} does not exist: {rel}")
    return path


def _fragment(game_dir, rel, label):
    doc = _load(_design_file(game_dir, rel, label))
    if not isinstance(doc.get("regions"), list):
        raise ValueError(f"{label} needs a regions array: {rel}")
    return doc


def source_get(value, path):
    for key in str(path or "").split("."):
        if not key:
            continue
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def card_matches_family(card, match):
    for path, wanted in (match or {}).items():
        choices = wanted if isinstance(wanted, list) else [wanted]
        if source_get(card, path) not in choices:
            return False
    return True


def load_card_design(game_dir, normalize_layout=lambda value: value, manifest_path=MANIFEST):
    game_dir = Path(game_dir).resolve()
    if not (game_dir / manifest_path).exists():
        return None
    resolved_manifest_path = _design_file(game_dir, manifest_path, "card design manifest")
    manifest = _load(resolved_manifest_path)
    if manifest.get("version") != 1:
        raise ValueError(f"unsupported card design manifest version: {manifest.get('version')}")
    if not manifest.get("families"):
        raise ValueError("card design manifest needs at least one family")
    system = _load(_design_file(game_dir, manifest.get("system"), "design system"))
    if not system.get("card") or not isinstance(system.get("fonts"), list) or not system.get("palette"):
        raise ValueError("design system needs card, fonts, and palette")
    component_docs = {}
    for component in manifest.get("components") or []:
        if component["id"] in component_docs:
            raise ValueError(f"duplicate card design component: {component['id']}")
        component_docs[component["id"]] = _fragment(game_dir, component["source"], f"component {component['id']}")
    rank = {region_id: index for index, region_id in enumerate(manifest.get("region_order") or [])}
    families, seen = [], set()
    for family in manifest["families"]:
        if family["id"] in seen:
            raise ValueError(f"duplicate card design family: {family['id']}")
        seen.add(family["id"])
        region_map, component_ids = {}, []
        for component in manifest.get("components") or []:
            applies = component.get("applies_to")
            if applies != "*" and family["id"] not in (applies or []):
                continue
            component_ids.append(component["id"])
            doc = component_docs[component["id"]]
            for region_id in doc.get("remove_regions") or []:
                region_map.pop(region_id, None)
            for region in doc["regions"]:
                region_map[region["id"]] = deepcopy(region)
        family_doc = _fragment(game_dir, family["source"], f"family {family['id']}")
        for region_id in family_doc.get("remove_regions") or []:
            region_map.pop(region_id, None)
        for region in family_doc["regions"]:
            region_map[region["id"]] = deepcopy(region)
        regions = sorted(region_map.values(), key=lambda region: (rank.get(region["id"], 10**9), region["id"]))
        layout = normalize_layout({**deepcopy(system), "regions": regions})
        families.append({**deepcopy(family), "components": component_ids,
                         "region_count": len(regions), "layout": layout})
    return {
        "version": manifest["version"],
        "name": manifest.get("name") or "Card design families",
        "description": manifest.get("description") or "",
        "manifest_path": manifest_path,
        "system_path": manifest["system"],
        "legacy_source": manifest.get("legacy_source"),
        "components": [{**deepcopy(component), "region_count": len(component_docs[component["id"]]["regions"])}
                       for component in manifest.get("components") or []],
        "families": families,
        "region_order": deepcopy(manifest.get("region_order") or []),
    }


def resolve_card_design(catalog, card):
    if not catalog or not card:
        return None
    return next((family for family in catalog["families"]
                 if card_matches_family(card, family.get("match"))), None)
