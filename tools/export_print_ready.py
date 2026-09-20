#!/usr/bin/env python3
"""Build a printer-facing package from Forge's canonical card renderer.

The package contains:
  - 300 DPI sRGB PNG fronts with the declared bleed on every side
  - a quantity manifest (one image per unique printing, copies kept as data)
  - A4 and US Letter duplex PDFs with vector crop marks
  - a one-card-per-page RGB press PDF with Media/Trim/Bleed boxes

Usage:
  python3 tools/export_print_ready.py <game-dir> [--output-dir DIR] [--ref REF]
"""

import argparse
import csv
import hashlib
import io
import json
import math
import fnmatch
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml
from deterministic_archive import write_deterministic_zip
from PIL import Image, ImageCms, ImageMath
from reportlab.lib.colors import CMYKColorSep, PCMYKColor, HexColor
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, TextStringObject

from design_engines import load_design_engines


TOOLS = Path(__file__).resolve().parent
DEFAULT_DPI = 300
DEFAULT_TRIM_MM = (63.5, 88.9)
DEFAULT_BLEED_MM = 3.175
PDF_FONT_NAME = "ForgeDejaVuSans"
PDF_FONT_PATH = TOOLS / "fonts" / "DejaVuSans.ttf"
PRINT_BLACK = PCMYKColor(0, 0, 0, 100)
PRINT_TARGETS_PATH = TOOLS.parent / "production" / "print-targets.json"
DEFAULT_PRINT_PROFILE = {
    "schema_version": 1,
    "preset": "balanced-duplex",
    "selection": {"card_ids": [], "printing_quantities": {}},
    "home": {
        "fronts_only": False,
        "gutter_mm": 0,
        "crop_marks": "grid",
        "crop_mark_sides": "both",
        "sleeve_profile": "none",
        "sleeve_fit": "contain",
        "orientation": "portrait",
    },
    "press": {
        "target": "generic-srgb",
        "include_back": True,
        "crop_marks": "outside-bleed",
        "crop_mark_sides": "both",
        "color_space": "sRGB",
        "pdf_standard": "none",
        "dieline": {"enabled": False},
    },
}
SLEEVE_PROFILES = {
    # 62 x 89 mm is the sleeve's outside size, not the printable insert size.
    # The conservative 59 x 86 mm insert matches the Japanese-size card
    # contract published by major sleeve manufacturers.
    "japanese-62x89": {
        "sleeve_mm": (62.0, 89.0),
        "insert_mm": (59.0, 86.0),
        "background": "#111111",
    },
}

pdfmetrics.registerFont(TTFont(PDF_FONT_NAME, str(PDF_FONT_PATH)))


def load_print_targets():
    registry = json.loads(PRINT_TARGETS_PATH.read_text())
    return {target["id"]: {**target, "checked_at": registry["checked_at"]}
            for target in registry["targets"]}


def load_yaml(path):
    return yaml.safe_load(path.read_text()) if path.exists() else {}


def load_print_profile(game_dir):
    """Load the versioned active print profile with backwards-safe defaults."""
    path = game_dir / "templates" / "print.yaml"
    source = load_yaml(path) if path.exists() else {}
    profile = json.loads(json.dumps(DEFAULT_PRINT_PROFILE))
    if source:
        profile.update({key: value for key, value in source.items()
                        if key not in {"selection", "home", "press"}})
        for section in ("selection", "home", "press"):
            profile[section].update(source.get(section) or {})
    home = profile["home"]
    if home["crop_marks"] == "grid" and float(home["gutter_mm"]) > 0:
        raise ValueError("grid crop marks require a zero gutter; use corner marks with a gutter")
    if home["crop_marks"] == "corners" and float(home["gutter_mm"]) <= 0:
        raise ValueError("corner crop marks require a positive gutter")
    if home["fronts_only"] and home["crop_marks"] != "none" and home["crop_mark_sides"] == "backs":
        raise ValueError("a fronts-only home PDF cannot put crop marks only on backs")
    if home["orientation"] not in {"portrait", "landscape"}:
        raise ValueError("home orientation must be portrait or landscape")
    if home["sleeve_profile"] not in {"none", "custom", *SLEEVE_PROFILES}:
        raise ValueError(f"unknown sleeve profile: {home['sleeve_profile']}")
    if home["sleeve_profile"] == "custom":
        sleeve_profile_spec("custom", home)
    press = profile["press"]
    press["dieline"] = {"enabled": False, **(press.get("dieline") or {})}
    if not press["include_back"] and press["crop_marks"] != "none" and press["crop_mark_sides"] == "backs":
        raise ValueError("a fronts-only press PDF cannot put crop marks only on backs")
    if not press["include_back"] and press["dieline"].get("enabled") and press["dieline"].get("sides") == "backs":
        raise ValueError("a fronts-only press PDF cannot put a spot dieline only on backs")
    return profile


def home_page_size(page_size, orientation="portrait"):
    return tuple(sorted(page_size, reverse=orientation == "landscape"))


def sleeve_profile_spec(name, home):
    if name != "custom":
        return SLEEVE_PROFILES[name]
    dimensions = home.get("insert_mm") or {}
    values = [dimensions.get("w_mm"), dimensions.get("h_mm")]
    limits = (267.4, 198) if home.get("orientation") == "landscape" else (198, 267.4)
    if any(isinstance(value, bool) or not isinstance(value, (int, float))
           or not math.isfinite(value) or not 20 <= value <= limit
           for value, limit in zip(values, limits)):
        raise ValueError("custom insert width and height must be at least 20 mm and fit A4 and Letter with 6 mm margins")
    return {"sleeve_mm": None, "insert_mm": tuple(values), "background": "#111111"}


def print_contract(game_dir):
    """Resolve the active physical card contract, preferring card families."""
    templates = game_dir / "templates"
    design_engines = load_design_engines(game_dir)
    card_design = design_engines.get("card_design") if design_engines else None
    candidates = [
        card_design["families"][0]["layout"] if card_design and card_design.get("families") else {},
        load_yaml(templates / "layout.yaml"),
        json.loads((templates / "production.json").read_text())
        if (templates / "production.json").exists() else {},
        load_yaml(templates / "source-overlay.yaml"),
    ]
    card = next(((doc or {}).get("card") for doc in candidates
                 if (doc or {}).get("card")), {})
    return {
        "w_mm": float(card.get("w_mm") or DEFAULT_TRIM_MM[0]),
        "h_mm": float(card.get("h_mm") or DEFAULT_TRIM_MM[1]),
        "bleed_mm": float(card.get("bleed_mm") or DEFAULT_BLEED_MM),
        "radius_mm": float(card.get("radius_mm") or 0),
    }


def content_ref(game_dir):
    """Fingerprint the source tree when no immutable ref is supplied."""
    digest = hashlib.sha256()
    for path in sorted(p for p in game_dir.rglob("*") if p.is_file()
                       and ".git" not in p.parts and "exports" not in p.parts):
        digest.update(path.relative_to(game_dir).as_posix().encode())
        digest.update(path.read_bytes())
    return f"working-{digest.hexdigest()[:12]}"


def px(mm_value, dpi):
    return round(mm_value / 25.4 * dpi)


def stamp_pngs(folder, dpi):
    for path in sorted(folder.glob("*.png")):
        with Image.open(path) as image:
            image.convert("RGB").save(path, "PNG", dpi=(dpi, dpi), optimize=True)


def jpeg_cache(paths, folder, dpi, quality=95):
    folder.mkdir(parents=True, exist_ok=True)
    out = {}
    for path in paths:
        target = folder / f"{path.stem}.jpg"
        with Image.open(path) as image:
            image.convert("RGB").save(
                target, "JPEG", quality=quality, subsampling=0,
                optimize=True, dpi=(dpi, dpi),
            )
        out[path.name] = target
    return out


def inspect_icc_profile(path):
    """Reject display profiles and malformed tag tables before LittleCMS sees them."""
    raw = path.read_bytes()
    if len(raw) < 132:
        raise ValueError("ICC profile is shorter than its required header and tag count")
    declared = int.from_bytes(raw[0:4], "big")
    if declared != len(raw):
        raise ValueError(f"ICC profile declares {declared} bytes but contains {len(raw)}")
    if raw[36:40] != b"acsp":
        raise ValueError("ICC profile signature is missing")
    device_class = raw[12:16].decode("ascii", "replace")
    color_space = raw[16:20].decode("ascii", "replace")
    pcs = raw[20:24].decode("ascii", "replace")
    if device_class != "prtr":
        raise ValueError(f"ICC profile must be a printer output profile, not '{device_class.strip()}'")
    if color_space != "CMYK":
        raise ValueError(f"ICC output profile must use CMYK data, not '{color_space.strip()}'")
    if pcs not in {"XYZ ", "Lab "}:
        raise ValueError(f"unsupported ICC profile connection space '{pcs.strip()}'")
    if raw[8] not in {2, 4}:
        raise ValueError(f"unsupported ICC major version {raw[8]}; use ICC v2 or v4")
    count = int.from_bytes(raw[128:132], "big")
    table_end = 132 + count * 12
    if count > 4096 or table_end > len(raw):
        raise ValueError("ICC tag table is outside the profile")
    for index in range(count):
        row = 132 + index * 12
        offset = int.from_bytes(raw[row + 4:row + 8], "big")
        size = int.from_bytes(raw[row + 8:row + 12], "big")
        if offset < table_end or size == 0 or offset + size > len(raw):
            raise ValueError(f"ICC tag {index + 1} points outside the profile")
    try:
        name = ImageCms.getProfileName(str(path)).strip()
    except Exception as error:
        raise ValueError(f"LittleCMS could not open ICC output profile: {error}") from error
    return {
        "path": path,
        "bytes": raw,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "name": name,
        "device_class": device_class,
        "color_space": color_space,
        "pcs": pcs.strip(),
        "version": raw[8],
    }


def resolve_asset_right(game_dir, path):
    """Resolve the same last-matching rights rule used by Forge's audit receipt."""
    manifest_path = game_dir / "forge" / "rights.json"
    if not manifest_path.exists():
        return {"status": "missing", "redistribution": "restricted", "license": "unknown"}
    manifest = json.loads(manifest_path.read_text())
    right = manifest.get("default") or {}
    for rule in manifest.get("files") or []:
        if any(fnmatch.fnmatchcase(path, pattern) for pattern in rule.get("paths") or []):
            right = rule
    return {key: right.get(key) for key in ("license", "status", "copyright", "redistribution", "source", "notes") if right.get(key) is not None}


def cmyk_jpeg_cache(paths, folder, dpi, profile_info, rendering_intent, max_ink):
    """Convert renderer RGB through the declared output profile and measure every pixel."""
    folder.mkdir(parents=True, exist_ok=True)
    source_profile = ImageCms.createProfile("sRGB")
    intent = {"perceptual": 0, "relative-colorimetric": 1}[rendering_intent]
    out, checks = {}, []
    for path in paths:
        target = folder / f"{path.stem}.jpg"
        with Image.open(path) as opened:
            converted = ImageCms.profileToProfile(
                opened.convert("RGB"), source_profile, str(profile_info["path"]),
                outputMode="CMYK", renderingIntent=intent,
            )
            c, m, y, k = converted.split()
            if hasattr(ImageMath, "lambda_eval"):
                ink = ImageMath.lambda_eval(lambda channels: channels["c"] + channels["m"] + channels["y"] + channels["k"],
                                            c=c, m=m, y=y, k=k)
            else:  # Pillow 9.x in the Debian production image
                ink = ImageMath.eval("convert(c, 'I') + convert(m, 'I') + convert(y, 'I') + convert(k, 'I')",
                                     c=c, m=m, y=y, k=k)
            measured = round(ink.getextrema()[1] * 100 / 255, 2)
            if measured > float(max_ink) + 0.5:
                raise ValueError(f"{path.name}: measured {measured:g}% total ink exceeds declared {max_ink:g}% limit")
            # The destination profile is embedded once as the PDF OutputIntent.
            # Repeating a multi-megabyte ICC APP2 payload in every JPEG made a
            # deck tens or hundreds of megabytes larger without changing color.
            converted.save(target, "JPEG", quality=95, subsampling=0, optimize=True,
                           dpi=(dpi, dpi))
            checks.append({"file": path.name, "mode": converted.mode,
                           "max_total_ink_percent": measured, "pixels_checked": converted.width * converted.height})
        out[path.name] = target
    return out, checks


def slots_for(printings, faces):
    slots = []
    for printing in printings:
        face = faces / f"{printing['id']}.png"
        if not face.exists():
            raise FileNotFoundError(f"missing rendered face: {face.name}")
        slots.extend([face] * max(1, int(printing.get("quantity", 1))))
    return slots


def trim_for(printing, contract):
    size = printing.get("physical_size_mm") or {}
    return (
        float(size.get("width") or contract["w_mm"]),
        float(size.get("height") or contract["h_mm"]),
    )


def size_label(trim):
    def number(value):
        return f"{value:g}".replace(".", "p")
    return f"{number(trim[0])}x{number(trim[1])}mm"


def resized_png(source, target, size, dpi):
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        image.convert("RGB").resize(size, Image.Resampling.LANCZOS).save(
            target, "PNG", dpi=(dpi, dpi), optimize=True,
        )


def _target_face(source_trim, source_bleed, target, target_px, dpi):
    """Write one exact vendor upload without inventing a conformance claim.

    Prefer the renderer's real bleed.  Older layouts sometimes declare less
    bleed than a named target requires; those faces receive a labelled edge
    extension from the complete trim instead of being silently stretched.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source_bleed) as image:
        image = image.convert("RGB")
        if image.width >= target_px[0] and image.height >= target_px[1]:
            left = (image.width - target_px[0]) // 2
            top = (image.height - target_px[1]) // 2
            image.crop((left, top, left + target_px[0], top + target_px[1])).save(
                target, "PNG", dpi=(dpi, dpi), optimize=True,
            )
            return "native-bleed-centered"
    with Image.open(source_trim) as image:
        image = image.convert("RGB")
        image = _extend_axis_with_edge_caps(image, target_px[1], "vertical", dpi)
        image = _extend_axis_with_edge_caps(image, target_px[0], "horizontal", dpi)
        if image.size != tuple(target_px):
            raise ValueError(f"could not normalize {source_trim.name} to {target_px[0]} x {target_px[1]} pixels")
        image.save(target, "PNG", dpi=(dpi, dpi), optimize=True)
    return "edge-extension-from-trim"


def build_named_target_handoff(target, out, trim, bleed, printings, contract, include_back, dpi):
    requirements = target["requirements"]
    expected_trim = tuple(float(value) for value in requirements["trim_mm"])
    incompatible = [
        {"printing": printing["id"], "trim_mm": list(trim_for(printing, contract))}
        for printing in printings
        if any(abs(actual - expected) > 0.01
               for actual, expected in zip(trim_for(printing, contract), expected_trim))
    ]
    if incompatible:
        details = ", ".join(f"{item['printing']} ({item['trim_mm'][0]:g} x {item['trim_mm'][1]:g} mm)"
                            for item in incompatible[:8])
        raise ValueError(
            f"{target['label']} requires {expected_trim[0]:g} x {expected_trim[1]:g} mm trim; "
            f"incompatible printings: {details}"
        )
    target_px = tuple(int(value) for value in requirements["upload_px"])
    root = out / "manufacturer" / target["id"]
    files = []
    strategies = set()
    for printing in printings:
        destination = root / "fronts" / f"{printing['id']}.png"
        strategies.add(_target_face(
            trim / f"{printing['id']}.png", bleed / f"{printing['id']}.png",
            destination, target_px, dpi,
        ))
        files.append(destination)
    back_path = None
    if include_back:
        back_path = root / "back.png"
        strategies.add(_target_face(trim / "_back.png", bleed / "_back.png", back_path, target_px, dpi))
        files.append(back_path)
    checks = []
    for path in files:
        with Image.open(path) as image:
            check = {
                "file": path.relative_to(out).as_posix(),
                "pixels": list(image.size),
                "mode": image.mode,
                "dpi": [round(value) for value in image.info.get("dpi", (0, 0))],
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        check["pass"] = (check["pixels"] == list(target_px) and check["mode"] == "RGB"
                         and all(abs(value - dpi) <= 1 for value in check["dpi"]))
        checks.append(check)
    if not all(check["pass"] for check in checks):
        raise ValueError(f"{target['label']} output failed exact pixel, RGB, or DPI verification")
    return {
        "id": target["id"],
        "label": target["label"],
        "status": "pass",
        "handoff": "files-only",
        "publishing": False,
        "requirements": requirements,
        "source_revision": target.get("checked_at"),
        "sources": target.get("sources", []),
        "normalization": sorted(strategies),
        "fronts": len(printings),
        "back": back_path.relative_to(out).as_posix() if back_path else None,
        "checks": checks,
    }


def _extend_axis_with_edge_caps(image, target_length, axis, dpi):
    """Extend a contained face while keeping its rounded trim edge external.

    Repeating the terminal row of a rounded card also repeats its outline and
    transparent/white corner pixels.  That produces a false footer below the
    real footer (or a vertical seam on a landscape design such as ICE).  Move
    the rounded edge cap to the new outside edge and repeat a row/column just
    inside that cap instead.  The face content is neither scaled nor cropped.
    """
    current_length = image.height if axis == "vertical" else image.width
    if current_length >= target_length:
        return image

    before = (target_length - current_length) // 2
    after = target_length - current_length - before
    # Move only the terminal trim stroke.  A deeper cap can cross footer text,
    # collector numbers, or ICE strength art and stretch those marks into the
    # inserted area.  About 0.8 mm clears a production outline while leaving
    # all semantic artwork in the unchanged body.
    cap = max(1, min(current_length // 4, round(dpi / 25.4 * 0.8)))
    if current_length <= cap * 2:
        cap = max(1, current_length // 4)

    if axis == "vertical":
        result = Image.new("RGB", (image.width, target_length))
        body_end = current_length - cap
        result.paste(image.crop((0, 0, image.width, cap)), (0, 0))
        if before:
            band = image.crop((0, cap, image.width, cap + 1)).resize(
                (image.width, before))
            result.paste(band, (0, cap))
        body_top = cap + before
        result.paste(image.crop((0, cap, image.width, body_end)),
                     (0, body_top))
        body_bottom = body_top + body_end - cap
        if after:
            band = image.crop((0, body_end - 1, image.width, body_end)).resize(
                (image.width, after))
            result.paste(band, (0, body_bottom))
        result.paste(image.crop((0, body_end, image.width, current_length)),
                     (0, target_length - cap))
        return result

    result = Image.new("RGB", (target_length, image.height))
    body_end = current_length - cap
    result.paste(image.crop((0, 0, cap, image.height)), (0, 0))
    if before:
        band = image.crop((cap, 0, cap + 1, image.height)).resize(
            (before, image.height))
        result.paste(band, (cap, 0))
    body_left = cap + before
    result.paste(image.crop((cap, 0, body_end, image.height)),
                 (body_left, 0))
    body_right = body_left + body_end - cap
    if after:
        band = image.crop((body_end - 1, 0, body_end, image.height)).resize(
            (after, image.height))
        result.paste(band, (body_right, 0))
    result.paste(image.crop((body_end, 0, current_length, image.height)),
                 (target_length - cap, 0))
    return result


def _extend_axis_from_painted_edge(image, target_length, axis):
    """Extend a square, fully painted trim by repeating its terminal pixels."""
    current_length = image.height if axis == "vertical" else image.width
    if current_length >= target_length:
        return image
    before = (target_length - current_length) // 2
    after = target_length - current_length - before
    if axis == "vertical":
        result = Image.new("RGB", (image.width, target_length))
        if before:
            result.paste(image.crop((0, 0, image.width, 1)).resize(
                (image.width, before)), (0, 0))
        result.paste(image, (0, before))
        if after:
            result.paste(image.crop((0, image.height - 1,
                                     image.width, image.height)).resize(
                (image.width, after)), (0, before + image.height))
        return result
    result = Image.new("RGB", (target_length, image.height))
    if before:
        result.paste(image.crop((0, 0, 1, image.height)).resize(
            (before, image.height)), (0, 0))
    result.paste(image, (before, 0))
    if after:
        result.paste(image.crop((image.width - 1, 0,
                                 image.width, image.height)).resize(
            (after, image.height)), (before + image.width, 0))
    return result


def sleeve_fitted_png(source, target, size, dpi, background="#111111",
                      fit="contain", bleed_source=None, rounded_trim=True):
    """Fit a face into a fixed sleeve insert without stretching.

    ``contain`` preserves the complete face and may letterbox. ``cover`` fills
    the insert and center-crops the overflow. ``extend`` preserves the complete
    face and fills the remaining margin by extending only its edge pixels.
    None of the modes stretch the card content.
    """
    if fit not in {"contain", "cover", "extend"}:
        raise ValueError(f"unsupported sleeve fit: {fit}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as opened:
        image = opened.convert("RGB")
    ratio_fn = max if fit == "cover" else min
    ratio = ratio_fn(size[0] / image.width, size[1] / image.height)
    fitted = (
        max(1, round(image.width * ratio)),
        max(1, round(image.height * ratio)),
    )
    image = image.resize(fitted, Image.Resampling.LANCZOS)
    if fit == "extend" and rounded_trim and bleed_source:
        bleed_source = Path(bleed_source)
        if bleed_source.exists():
            with Image.open(bleed_source) as opened:
                bleed = opened.convert("RGB")
            bleed_size = (
                max(1, round(bleed.width * ratio)),
                max(1, round(bleed.height * ratio)),
            )
            bleed = bleed.resize(bleed_size, Image.Resampling.LANCZOS)
            # Renderer-native bleed is centered around the trim face.  When it
            # covers the requested insert, crop that real design continuation
            # instead of fabricating a footer from a single edge row.
            if bleed.width >= size[0] and bleed.height >= size[1]:
                crop_left = (bleed.width - size[0]) // 2
                crop_top = (bleed.height - size[1]) // 2
                result = bleed.crop((
                    crop_left, crop_top,
                    crop_left + size[0], crop_top + size[1],
                ))
                result.save(target, "PNG", dpi=(dpi, dpi), optimize=True)
                return size
    if fit in {"contain", "extend"}:
        result = Image.new("RGB", size, background)
        left = (size[0] - fitted[0]) // 2
        top = (size[1] - fitted[1]) // 2
        result.paste(image, (left, top))
        if fit == "extend":
            # Painted square trims can repeat their actual terminal pixels.
            # Rounded trims use the cap fallback only when native bleed was
            # unavailable or too small for the requested insert.
            extend_axis = (_extend_axis_with_edge_caps if rounded_trim
                           else _extend_axis_from_painted_edge)
            if rounded_trim:
                image = extend_axis(image, size[0], "horizontal", dpi)
                image = extend_axis(image, size[1], "vertical", dpi)
            else:
                image = extend_axis(image, size[0], "horizontal")
                image = extend_axis(image, size[1], "vertical")
            result = image
            visible = size
        else:
            visible = fitted
    else:
        left = max(0, (fitted[0] - size[0]) // 2)
        top = max(0, (fitted[1] - size[1]) // 2)
        result = image.crop((left, top, left + size[0], top + size[1]))
        visible = size
    result.save(target, "PNG", dpi=(dpi, dpi), optimize=True)
    return visible


def contained_png(source, target, size, dpi, background="#111111"):
    """Backward-compatible complete-face sleeve fit."""
    return sleeve_fitted_png(source, target, size, dpi, background, "contain")


def add_edge_bleed(source, target, bleed_px, dpi):
    """Extend edge pixels into a deterministic safety bleed.

    Renderer-native bleed remains preferred. This fallback is required for
    licensed flat source faces whose production template declares trim but has
    no editable artwork outside it.
    """
    with Image.open(source) as opened:
        image = opened.convert("RGB")
    if bleed_px <= 0:
        image.save(target, "PNG", dpi=(dpi, dpi), optimize=True)
        return
    width, height = image.size
    result = Image.new("RGB", (width + 2 * bleed_px, height + 2 * bleed_px))
    result.paste(image, (bleed_px, bleed_px))
    result.paste(image.crop((0, 0, width, 1)).resize((width, bleed_px)),
                 (bleed_px, 0))
    result.paste(image.crop((0, height - 1, width, height)).resize((width, bleed_px)),
                 (bleed_px, bleed_px + height))
    result.paste(image.crop((0, 0, 1, height)).resize((bleed_px, height)),
                 (0, bleed_px))
    result.paste(image.crop((width - 1, 0, width, height)).resize((bleed_px, height)),
                 (bleed_px + width, bleed_px))
    corners = [
        ((0, 0, 1, 1), (0, 0)),
        ((width - 1, 0, width, 1), (bleed_px + width, 0)),
        ((0, height - 1, 1, height), (0, bleed_px + height)),
        ((width - 1, height - 1, width, height),
         (bleed_px + width, bleed_px + height)),
    ]
    for crop, position in corners:
        result.paste(image.crop(crop).resize((bleed_px, bleed_px)), position)
    target.parent.mkdir(parents=True, exist_ok=True)
    result.save(target, "PNG", dpi=(dpi, dpi), optimize=True)


def extract_trim(source, target, expected_trim, bleed_px, dpi):
    """Materialize trim from a renderer-native bleed face."""
    with Image.open(source) as opened:
        image = opened.convert("RGB")
    expected_bleed = (expected_trim[0] + 2 * bleed_px,
                      expected_trim[1] + 2 * bleed_px)
    if image.size == expected_trim:
        image.save(target, "PNG", dpi=(dpi, dpi), optimize=True)
        add_edge_bleed(target, source, bleed_px, dpi)
        return
    if image.size != expected_bleed:
        raise ValueError(
            f"{source.name}: renderer produced {image.size}; expected trim "
            f"{expected_trim} or bleed {expected_bleed}"
        )
    image.crop((bleed_px, bleed_px,
                bleed_px + expected_trim[0],
                bleed_px + expected_trim[1])).save(
        target, "PNG", dpi=(dpi, dpi), optimize=True,
    )


def jpeg_copy(source, target, dpi, size=None, quality=95):
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        image = image.convert("RGB")
        if size and image.size != size:
            image = image.resize(size, Image.Resampling.LANCZOS)
        image.save(target, "JPEG", quality=quality, subsampling=0,
                   optimize=True, dpi=(dpi, dpi))
    return target


def crop_marks(pdf, page_w, page_h, cols, rows, card_w, card_h, ox, oy):
    mark = 2.6 * mm
    gap = 0.8 * mm
    grid_w, grid_h = cols * card_w, rows * card_h
    pdf.saveState()
    pdf.setStrokeColor(PRINT_BLACK)
    pdf.setLineWidth(0.25)
    for col in range(cols + 1):
        x = ox + col * card_w
        pdf.line(x, oy - gap, x, oy - gap - mark)
        pdf.line(x, oy + grid_h + gap, x, oy + grid_h + gap + mark)
    for row in range(rows + 1):
        y = oy + row * card_h
        pdf.line(ox - gap, y, ox - gap - mark, y)
        pdf.line(ox + grid_w + gap, y, ox + grid_w + gap + mark, y)
    pdf.restoreState()


def corner_crop_marks(pdf, positions, card_w, card_h, gutter):
    """Mark every trim corner without painting a line onto the card.

    A full cut box disappears against dark edge-to-edge artwork and can leave
    an unwanted rule on an imperfectly cut insert.  These short marks live
    entirely in the white gutter and point to the exact trim intersections.
    Their length adapts to the available gutter so neighbouring cards' marks
    never touch.
    """
    half_gutter = gutter / 2
    gap = min(0.35 * mm, half_gutter * 0.25)
    centre_clearance = min(0.15 * mm, half_gutter * 0.1)
    mark = max(0, min(2.2 * mm, half_gutter - gap - centre_clearance))
    if mark <= 0:
        return

    pdf.saveState()
    pdf.setStrokeColor(PRINT_BLACK)
    pdf.setLineWidth(0.35)
    pdf.setLineCap(0)
    for x, y in positions:
        left, right = x, x + card_w
        bottom, top = y, y + card_h

        # Horizontal ticks point toward the left and right trim edges.
        for edge_y in (bottom, top):
            pdf.line(left - gap - mark, edge_y, left - gap, edge_y)
            pdf.line(right + gap, edge_y, right + gap + mark, edge_y)

        # Vertical ticks point toward the bottom and top trim edges.
        for edge_x in (left, right):
            pdf.line(edge_x, bottom - gap - mark, edge_x, bottom - gap)
            pdf.line(edge_x, top + gap, edge_x, top + gap + mark)
    pdf.restoreState()


def mark_side_enabled(selection, side):
    """Return whether crop marks belong on this exact face side."""
    return selection == "both" or selection == side


def page_notice(pdf, page_w, page_h, page_number, total_pairs, private_notice,
                size_notice=None):
    pdf.saveState()
    pdf.setFillColor(PRINT_BLACK)
    pdf.setFont(PDF_FONT_NAME, 6.5)
    top = size_notice or (
        "ACTUAL SIZE / 100% - DUPLEX: FLIP ON LONG EDGE - "
        "ODD PAGES ONLY FOR OPAQUE SLEEVES"
    )
    pdf.drawCentredString(page_w / 2, page_h - 4.6 * mm, top)
    bottom = f"Forge print build - sheet {page_number} of {total_pairs}"
    if private_notice:
        bottom += " - PRIVATE MODIFIED PROXY"
    pdf.drawCentredString(page_w / 2, 3.1 * mm, bottom)
    pdf.restoreState()


def calibration_pdf(output, page_size, trim_mm, title, ref):
    """A separate scale/fit proof, never an extra card or duplex back page."""
    pdf = canvas.Canvas(str(output), pagesize=page_size, pageCompression=1, invariant=1)
    pdf.setTitle(f"{title} - printer calibration")
    pdf.setAuthor("Forge")
    pdf.setSubject(f"Exact version {ref}; calibration only")
    pdf.setViewerPreference("PrintScaling", "None")
    width, height = page_size
    pdf.setFillColor(PRINT_BLACK)
    pdf.setStrokeColor(PRINT_BLACK)
    pdf.setFont(PDF_FONT_NAME, 16)
    pdf.drawString(18 * mm, height - 20 * mm, "Check your print size")
    pdf.setFont(PDF_FONT_NAME, 9)
    lines = ["Match the printer paper to this PDF. Select Actual size / 100%.",
             "Turn off Fit, Shrink and borderless expansion. Print this page first.",
             "Measure both 50 mm rulers before cutting or printing the full deck."]
    for index, line in enumerate(lines):
        pdf.drawString(18 * mm, height - (29 + index * 6) * mm, line)
    card_w, card_h = [value * mm for value in trim_mm]
    if card_w <= width - 70 * mm and card_h <= height - 110 * mm:
        x, y = (width - card_w) / 2, 57 * mm
        pdf.setLineWidth(.25)
        pdf.rect(x, y, card_w, card_h)
        pdf.setFont(PDF_FONT_NAME, 9)
        pdf.drawCentredString(width / 2, y + card_h + 5 * mm, f"Cut size: {trim_mm[0]:g} x {trim_mm[1]:g} mm")
        pdf.drawCentredString(width / 2, y - 6 * mm, "Cut on the line, then test with your sleeve.")
    else:
        pdf.drawCentredString(width / 2, height / 2, f"Card cut size: {trim_mm[0]:g} x {trim_mm[1]:g} mm")
        pdf.drawCentredString(width / 2, height / 2 - 6 * mm, "Use the card sheet to test fit after checking the rulers.")
    # Horizontal and vertical rulers catch independent scaling in both axes.
    pdf.setLineWidth(.5)
    for vertical, x, y in [(False, 25 * mm, 26 * mm), (True, width - 25 * mm, 23 * mm)]:
        length = 50 * mm
        pdf.line(x, y, x if vertical else x + length, y + length if vertical else y)
        for step in range(11):
            pos, tick = step * 5 * mm, (2 if step % 2 == 0 else 1) * mm
            if vertical:
                pdf.line(x - tick, y + pos, x + tick, y + pos)
            else:
                pdf.line(x + pos, y - tick, x + pos, y + tick)
        if vertical:
            pdf.saveState(); pdf.translate(x - 5 * mm, y + length / 2); pdf.rotate(90)
            pdf.drawCentredString(0, 0, "50 mm"); pdf.restoreState()
        else:
            pdf.drawCentredString(x + length / 2, y + 5 * mm, "50 mm")
    pdf.setFont(PDF_FONT_NAME, 7)
    pdf.drawString(18 * mm, 14 * mm, "Sleeve outer dimensions are not the card insert size. Fit also depends on paper and cutting.")
    pdf.drawString(18 * mm, 9 * mm, f"Calibration only - source {ref[:16]}")
    pdf.showPage(); pdf.save()


def print_at_home_pdf(output, page_size, slots, trim_jpegs, back_jpeg,
                      trim_w_mm, trim_h_mm, title, ref, private_notice,
                      size_notice=None, gutter_mm=0, fronts_only=False,
                      crop_style="grid", crop_mark_sides="both"):
    if size_notice is None and fronts_only:
        size_notice = "ACTUAL SIZE / 100% - FRONTS ONLY - USE OPAQUE SLEEVES OR A DECLARED BACKING"
    page_w, page_h = page_size
    card_w, card_h = trim_w_mm * mm, trim_h_mm * mm
    gutter = gutter_mm * mm
    if card_w > page_w - 12 * mm or card_h > page_h - 12 * mm:
        raise ValueError(
            f"{trim_w_mm:g} x {trim_h_mm:g} mm component does not fit this paper size"
        )
    cols = max(1, math.floor((page_w - 12 * mm + gutter) /
                             (card_w + gutter)))
    # US Letter is 279.4 mm tall. A true poker card is 88.9 mm, so three rows
    # consume 266.7 mm and leave 12.7 mm for both margins. Reserving 14 mm made
    # an otherwise valid 3x3 actual-size sheet fail by 1.3 mm.
    rows = max(1, math.floor((page_h - 12 * mm + gutter) /
                             (card_h + gutter)))
    grid_w = cols * card_w + (cols - 1) * gutter
    grid_h = rows * card_h + (rows - 1) * gutter
    ox, oy = (page_w - grid_w) / 2, (page_h - grid_h) / 2
    capacity = cols * rows
    chunks = [slots[i:i + capacity] for i in range(0, len(slots), capacity)]
    image_cache = {}

    def image(path):
        key = str(path)
        if key not in image_cache:
            image_cache[key] = ImageReader(key)
        return image_cache[key]

    pdf = canvas.Canvas(str(output), pagesize=page_size, pageCompression=1, invariant=1)
    pdf.setTitle(f"{title} - print at home")
    pdf.setAuthor("Forge")
    pdf.setSubject(f"Exact version {ref}; {trim_w_mm:g} x {trim_h_mm:g} mm trim")
    pdf.setViewerPreference("PrintScaling", "None")
    for page_index, chunk in enumerate(chunks, 1):
        # Front: reading order, top-left to bottom-right.
        page_notice(pdf, page_w, page_h, page_index, len(chunks), private_notice,
                    size_notice)
        if crop_style == "grid" and mark_side_enabled(crop_mark_sides, "fronts"):
            crop_marks(pdf, page_w, page_h, cols, rows, card_w, card_h, ox, oy)
        positions = []
        for index, face in enumerate(chunk):
            row, col = divmod(index, cols)
            x = ox + col * (card_w + gutter)
            y = oy + (rows - row - 1) * (card_h + gutter)
            positions.append((x, y))
            pdf.drawImage(image(trim_jpegs[face.name]), x, y, card_w, card_h,
                          preserveAspectRatio=False, mask=None)
        if crop_style == "corners" and mark_side_enabled(crop_mark_sides, "fronts"):
            corner_crop_marks(pdf, positions, card_w, card_h, gutter)
        pdf.showPage()
        if fronts_only:
            continue

        # Long-edge duplex mirrors columns in portrait and rows in landscape.
        page_notice(pdf, page_w, page_h, page_index, len(chunks), private_notice,
                    size_notice)
        if crop_style == "grid" and mark_side_enabled(crop_mark_sides, "backs"):
            crop_marks(pdf, page_w, page_h, cols, rows, card_w, card_h, ox, oy)
        positions = []
        for index, _face in enumerate(chunk):
            row, col = divmod(index, cols)
            back_col = col if page_w > page_h else cols - col - 1
            back_row = rows - row - 1 if page_w > page_h else row
            x = ox + back_col * (card_w + gutter)
            y = oy + (rows - back_row - 1) * (card_h + gutter)
            positions.append((x, y))
            pdf.drawImage(image(back_jpeg), x, y, card_w, card_h,
                          preserveAspectRatio=False, mask=None)
        if crop_style == "corners" and mark_side_enabled(crop_mark_sides, "backs"):
            corner_crop_marks(pdf, positions, card_w, card_h, gutter)
        pdf.showPage()
    pdf.save()


def press_pdf(output, bleed_paths, bleed_jpegs, trim_w_mm, trim_h_mm,
              bleed_mm, title, ref, crop_style="outside-bleed",
              crop_mark_sides="both", back_path=None, color_label="sRGB",
              dieline=None, radius_mm=0):
    """One face per page, with explicit trim and bleed boxes plus crop marks."""
    image_w = (trim_w_mm + 2 * bleed_mm) * mm
    image_h = (trim_h_mm + 2 * bleed_mm) * mm
    margin = 3.5 * mm
    page_w, page_h = image_w + 2 * margin, image_h + 2 * margin
    trim_x = margin + bleed_mm * mm
    trim_y = margin + bleed_mm * mm
    trim_w, trim_h = trim_w_mm * mm, trim_h_mm * mm
    pdf = canvas.Canvas(str(output), pagesize=(page_w, page_h), pageCompression=1, invariant=1,
                        initialFontName=PDF_FONT_NAME)
    pdf.setTitle(f"{title} - press faces ({color_label})")
    pdf.setAuthor("Forge")
    pdf.setSubject(f"Exact version {ref}; 300 DPI {color_label}; {bleed_mm:g} mm bleed")
    pdf.setCropBox((0, 0, page_w, page_h))
    pdf.setBleedBox((margin, margin, margin + image_w, margin + image_h))
    pdf.setTrimBox((trim_x, trim_y, trim_x + trim_w, trim_y + trim_h))
    cache = {}

    def image(path):
        key = str(path)
        if key not in cache:
            cache[key] = ImageReader(key)
        return cache[key]

    for path in bleed_paths:
        pdf.drawImage(image(bleed_jpegs[path.name]), margin, margin, image_w, image_h,
                      preserveAspectRatio=False, mask=None)
        side = "backs" if back_path is not None and path == back_path else "fronts"
        if crop_style == "outside-bleed" and mark_side_enabled(crop_mark_sides, side):
            # Crop marks live entirely outside the bleed box.
            pdf.saveState()
            pdf.setStrokeColor(PRINT_BLACK)
            pdf.setLineWidth(0.25)
            gap, length = 0.45 * mm, 2.55 * mm
            for x in (trim_x, trim_x + trim_w):
                pdf.line(x, margin - gap, x, margin - gap - length)
                pdf.line(x, margin + image_h + gap, x, margin + image_h + gap + length)
            for y in (trim_y, trim_y + trim_h):
                pdf.line(margin - gap, y, margin - gap - length, y)
                pdf.line(margin + image_w + gap, y, margin + image_w + gap + length, y)
            pdf.restoreState()
        if dieline and dieline.get("enabled") and mark_side_enabled(dieline["sides"], side):
            # A finishing path is deliberately a named Separation color, not a
            # process-magenta drawing. The alternate CMYK only controls how the
            # named swatch previews when separation-aware software is absent.
            # The printer-visible contract requires an overprinting stroke so
            # the path cannot knock a white hairline out of the artwork.
            c, m, y, k = [float(value) for value in dieline["alternate_cmyk"]]
            offset = float(dieline["offset_mm"]) * mm
            line_x, line_y = trim_x - offset, trim_y - offset
            line_w, line_h = trim_w + 2 * offset, trim_h + 2 * offset
            radius = max(0, min((float(radius_mm) + float(dieline["offset_mm"])) * mm,
                                line_w / 2, line_h / 2))
            pdf.saveState()
            pdf.setStrokeOverprint(True)
            pdf.setStrokeColor(CMYKColorSep(
                c, m, y, k, spotName=dieline["spot_name"],
            ))
            pdf.setLineWidth(float(dieline["stroke_width_pt"]))
            pdf.setLineCap(1)
            pdf.setLineJoin(1)
            if radius > 0:
                pdf.roundRect(line_x, line_y, line_w, line_h, radius, stroke=1, fill=0)
            else:
                pdf.rect(line_x, line_y, line_w, line_h, stroke=1, fill=0)
            pdf.restoreState()
        pdf.showPage()
    pdf.save()


def _font_descriptor(font):
    font = font.get_object()
    if font.get("/FontDescriptor"):
        return font["/FontDescriptor"].get_object()
    descendants = font.get("/DescendantFonts") or []
    if descendants:
        descriptor = descendants[0].get_object().get("/FontDescriptor")
        return descriptor.get_object() if descriptor else None
    return None


def inspect_pdf(path, require_page_boxes=False):
    """Reopen a completed PDF and record structural production evidence."""
    reader = PdfReader(str(path))
    fonts = {}
    boxes_ok = True
    for page in reader.pages:
        if require_page_boxes:
            boxes_ok = boxes_ok and "/TrimBox" in page and "/BleedBox" in page
        resources = page.get("/Resources") or {}
        font_map = resources.get_object().get("/Font") if hasattr(resources, "get_object") else resources.get("/Font")
        if font_map:
            for _key, font_ref in font_map.get_object().items():
                font = font_ref.get_object()
                name = str(font.get("/BaseFont") or "unknown")
                descriptor = _font_descriptor(font_ref)
                embedded = bool(descriptor and any(key in descriptor for key in ("/FontFile", "/FontFile2", "/FontFile3")))
                fonts[name] = fonts.get(name, False) or embedded
    return {
        "file": path.name,
        "pages": len(reader.pages),
        "page_boxes": ("verified" if boxes_ok else "missing") if require_page_boxes else "not-required",
        "fonts": [{"name": name, "embedded": embedded,
                   "standard_14": name.lstrip("/") in {"Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique", "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Symbol", "ZapfDingbats"}}
                  for name, embedded in sorted(fonts.items())],
    }


def write_pdfx1a_candidate(source, output, profile_info, press_config):
    """Embed the exact CMYK output intent and PDF/X-1a self-identification.

    Forge validates the resulting object graph below, but deliberately calls
    this a candidate until the receiving printer or an independent prepress
    validator accepts the exact bytes.
    """
    writer = PdfWriter()
    writer.clone_document_from_reader(PdfReader(str(source)))
    try:
        current_header = writer.pdf_header
        writer.pdf_header = b"%PDF-1.4" if isinstance(current_header, bytes) else "%PDF-1.4"
    except AttributeError:
        writer._header = b"%PDF-1.4"
    profile = DecodedStreamObject()
    profile.set_data(profile_info["bytes"])
    profile[NameObject("/N")] = NumberObject(4)
    profile_ref = writer._add_object(profile)
    output_intent = DictionaryObject({
        NameObject("/Type"): NameObject("/OutputIntent"),
        NameObject("/S"): NameObject("/GTS_PDFX"),
        NameObject("/OutputConditionIdentifier"): TextStringObject(press_config["output_condition_identifier"]),
        NameObject("/OutputCondition"): TextStringObject(press_config["output_condition"]),
        NameObject("/RegistryName"): TextStringObject(press_config["registry_name"]),
        NameObject("/Info"): TextStringObject(profile_info["name"]),
        NameObject("/DestOutputProfile"): profile_ref,
    })
    root_object = getattr(writer, "root_object", writer._root_object)
    root_object[NameObject("/OutputIntents")] = ArrayObject([writer._add_object(output_intent)])
    writer.add_metadata({"/GTS_PDFXVersion": "PDF/X-1a:2003"})
    info = writer._info.get_object()
    info[NameObject("/Trapped")] = NameObject("/False")
    with output.open("wb") as stream:
        writer.write(stream)


def inspect_pdfx1a_candidate(path, expected_profile_sha, expected_config=None):
    """Structural/color/font gate for Forge's deliberately bounded PDF/X candidate."""
    reader = PdfReader(str(path))
    blockers, images, spot_dielines = [], [], []
    if reader.is_encrypted:
        blockers.append("document is encrypted")
    info = reader.metadata or {}
    if info.get("/GTS_PDFXVersion") != "PDF/X-1a:2003":
        blockers.append("PDF/X-1a:2003 self-identification is missing")
    if str(info.get("/Trapped")) not in {"/False", "False"}:
        blockers.append("Trapped metadata is not /False")
    root = reader.trailer["/Root"]
    for active_key in ("/OpenAction", "/AA", "/AcroForm"):
        if root.get(active_key):
            blockers.append(f"catalog contains forbidden active feature {active_key}")
    intents = root.get("/OutputIntents") or []
    if len(intents) != 1:
        blockers.append(f"expected one output intent, found {len(intents)}")
        embedded_sha = None
    else:
        intent = intents[0].get_object()
        if intent.get("/S") != "/GTS_PDFX":
            blockers.append("output intent subtype is not /GTS_PDFX")
        if expected_config:
            expected_values = {
                "/OutputConditionIdentifier": expected_config["output_condition_identifier"],
                "/OutputCondition": expected_config["output_condition"],
                "/RegistryName": expected_config["registry_name"],
            }
            for key, expected in expected_values.items():
                if str(intent.get(key) or "") != expected:
                    blockers.append(f"output intent {key} does not match the versioned print profile")
        stream = intent.get("/DestOutputProfile")
        if not stream:
            blockers.append("embedded destination output profile is missing")
            embedded_sha = None
        else:
            embedded_sha = hashlib.sha256(stream.get_object().get_data()).hexdigest()
            if embedded_sha != expected_profile_sha:
                blockers.append("embedded output profile does not match the versioned source asset")
    for page_number, page in enumerate(reader.pages, 1):
        if "/TrimBox" not in page or "/BleedBox" not in page:
            blockers.append(f"page {page_number} is missing TrimBox or BleedBox")
        else:
            media = [float(value) for value in page.mediabox]
            bleed = [float(value) for value in page.bleedbox]
            trim = [float(value) for value in page.trimbox]
            inside = lambda inner, outer: (inner[0] >= outer[0] and inner[1] >= outer[1]
                                           and inner[2] <= outer[2] and inner[3] <= outer[3])
            if not inside(trim, bleed) or not inside(bleed, media):
                blockers.append(f"page {page_number} TrimBox/BleedBox/MediaBox nesting is invalid")
        if page.get("/Annots"):
            blockers.append(f"page {page_number} contains annotations")
        contents = page.get_contents()
        content = contents.get_data() if contents is not None else b""
        if re.search(rb"(?:^|\s)(?:[-+]?\d*\.?\d+\s+){3}(?:rg|RG)(?:\s|$)", content):
            blockers.append(f"page {page_number} uses an RGB painting operator")
        resources = page.get("/Resources") or {}
        resources = resources.get_object() if hasattr(resources, "get_object") else resources
        fonts = resources.get("/Font") or {}
        fonts = fonts.get_object() if hasattr(fonts, "get_object") else fonts
        for name, ref in fonts.items():
            descriptor = _font_descriptor(ref)
            if not descriptor or not any(key in descriptor for key in ("/FontFile", "/FontFile2", "/FontFile3")):
                blockers.append(f"page {page_number} font {name} is not embedded")
        ext_states = resources.get("/ExtGState") or {}
        ext_states = ext_states.get_object() if hasattr(ext_states, "get_object") else ext_states
        for name, ref in ext_states.items():
            state = ref.get_object()
            if float(state.get("/ca", 1)) != 1 or float(state.get("/CA", 1)) != 1 or str(state.get("/BM", "/Normal")) != "/Normal":
                blockers.append(f"page {page_number} graphics state {name} uses transparency or blending")
        dieline = (expected_config or {}).get("dieline") or {"enabled": False}
        if dieline.get("enabled"):
            side = "backs" if expected_config.get("include_back") and page_number == len(reader.pages) else "fronts"
            expected_here = mark_side_enabled(dieline["sides"], side)
            color_spaces = resources.get("/ColorSpace") or {}
            color_spaces = color_spaces.get_object() if hasattr(color_spaces, "get_object") else color_spaces
            spot_key = NameObject(f"/{dieline['spot_name']}")
            separation_ref = color_spaces.get(spot_key)
            separation = separation_ref.get_object() if separation_ref else None
            name_ok = bool(separation and len(separation) >= 3
                           and str(separation[0]) == "/Separation"
                           and str(separation[1]) == f"/{dieline['spot_name']}"
                           and str(separation[2]) == "/DeviceCMYK")
            paint_token = f"/{dieline['spot_name']} CS 1 SCN".encode()
            paints = paint_token in content
            overprint_names = [str(name).encode() for name, ref in ext_states.items()
                               if bool(ref.get_object().get("/OP"))]
            overprints = any(name + b" gs" in content for name in overprint_names)
            present = bool(separation_ref or paints)
            if expected_here and not name_ok:
                blockers.append(f"page {page_number} is missing named /{dieline['spot_name']} Separation color space")
            if expected_here and not paints:
                blockers.append(f"page {page_number} does not paint the declared spot dieline at full tint")
            if expected_here and not overprints:
                blockers.append(f"page {page_number} spot dieline is not stroke-overprinting")
            if not expected_here and present:
                blockers.append(f"page {page_number} unexpectedly contains the spot dieline")
            spot_dielines.append({"page": page_number, "side": side, "expected": expected_here,
                                   "present": present, "separation": name_ok,
                                   "full_tint": paints, "stroke_overprint": overprints})
        xobjects = resources.get("/XObject") or {}
        xobjects = xobjects.get_object() if hasattr(xobjects, "get_object") else xobjects
        for name, ref in xobjects.items():
            obj = ref.get_object()
            if obj.get("/Subtype") != "/Image":
                continue
            color_space = str(obj.get("/ColorSpace"))
            images.append({"page": page_number, "name": str(name), "color_space": color_space,
                           "bits": int(obj.get("/BitsPerComponent") or 0), "soft_mask": "/SMask" in obj})
            if color_space not in {"/DeviceCMYK", "/DeviceGray"}:
                blockers.append(f"page {page_number} image {name} uses {color_space}, not CMYK/gray")
            if "/SMask" in obj:
                blockers.append(f"page {page_number} image {name} has a transparency soft mask")
    return {
        "status": "pass" if not blockers else "fail",
        "file": path.name,
        "pages": len(reader.pages),
        "pdf_version": getattr(reader, "pdf_header", "%PDF-unknown"),
        "pdf_x_identification": info.get("/GTS_PDFXVersion"),
        "output_intent": "GTS_PDFX" if not blockers or intents else None,
        "embedded_profile_sha256": embedded_sha,
        "images": images,
        "spot_dielines": spot_dielines,
        "blockers": blockers,
        "independent_validation": False,
        "boundary": "Structural Forge preflight passed; receiving-printer or independent prepress validation remains required.",
    }


def write_quantities(path, printings, cards):
    names = {card["id"]: card.get("name", card["id"]) for card in cards}
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["printing_id", "card_id", "name", "quantity", "front_file"])
        for printing in printings:
            writer.writerow([
                printing["id"], printing["card_id"], names.get(printing["card_id"], ""),
                max(1, int(printing.get("quantity", 1))),
                f"fronts-bleed/{printing['id']}.png",
            ])


def private_notice(game_dir):
    for path in (game_dir / "templates" / "production.json",
                 game_dir / "templates" / "source-overlay.yaml"):
        if not path.exists():
            continue
        doc = json.loads(path.read_text()) if path.suffix == ".json" else load_yaml(path)
        if doc.get("private_only"):
            return doc.get("notice") or "Check source permissions before sharing altered faces."
    return ""


def zip_package(zip_path, package_root, files):
    write_deterministic_zip(zip_path, [(arcname, path) for path, arcname in files])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--ref", help="immutable Forge commit/tag represented by this build")
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    parser.add_argument(
        "--sleeve-profile", choices=sorted(SLEEVE_PROFILES), action="append",
        default=None, help="also build a distortion-free home-print sleeve insert",
    )
    parser.add_argument(
        "--sleeve-gutter-mm", type=float, default=None,
        help="white space between optional sleeve inserts",
    )
    parser.add_argument(
        "--sleeve-fronts-only", action="store_true", default=None,
        help="omit backs from optional sleeve-profile PDFs",
    )
    parser.add_argument(
        "--sleeve-fit", choices=("contain", "cover", "extend"), default=None,
        help=("fit optional sleeve inserts without distortion: contain keeps "
              "the complete face; cover center-crops; extend fills margins "
              "from renderer bleed (with an edge fallback) while preserving "
              "all trim content"),
    )
    parser.add_argument(
        "--card", action="append", default=None,
        help="select one rules card ID (repeatable); overrides templates/print.yaml",
    )
    args = parser.parse_args()
    if args.dpi != 300:
        parser.error("print-ready packages currently require --dpi 300")

    game_dir = args.game_dir.resolve()
    checked = subprocess.run(
        [sys.executable, str(TOOLS / "validate.py"), str(game_dir)],
        capture_output=True, text=True,
    )
    if checked.returncode:
        details = "\n".join(part.strip() for part in (checked.stdout, checked.stderr) if part.strip())
        parser.error(f"game or print profile failed validation before export:\n{details}")
    game = load_yaml(game_dir / "game.yaml")
    cards = json.loads((game_dir / "components" / "cards.json").read_text())
    printings = json.loads((game_dir / "components" / "printings.json").read_text())
    profile = load_print_profile(game_dir)
    selected_ids = list(dict.fromkeys(args.card if args.card is not None
                                      else profile["selection"]["card_ids"]))
    exact_quantities = ({} if args.card is not None
                        else profile["selection"].get("printing_quantities") or {})
    known_ids = {card["id"] for card in cards}
    unknown_ids = sorted(set(selected_ids) - known_ids)
    if unknown_ids:
        parser.error(f"print profile selects unknown card IDs: {', '.join(unknown_ids)}")
    if exact_quantities:
        printing_by_id = {printing["id"]: printing for printing in printings}
        unknown_printings = sorted(set(exact_quantities) - set(printing_by_id))
        if unknown_printings:
            parser.error(f"print profile selects unknown printing IDs: {', '.join(unknown_printings)}")
        represented_ids = list(dict.fromkeys(printing_by_id[printing_id]["card_id"]
                                             for printing_id in exact_quantities))
        if set(represented_ids) != set(selected_ids):
            parser.error("exact printing quantities do not represent exactly the selected card IDs")
        selected = set(represented_ids)
        cards = [card for card in cards if card["id"] in selected]
        printings = [{**printing_by_id[printing_id], "quantity": int(quantity)}
                     for printing_id, quantity in exact_quantities.items()]
        selected_ids = represented_ids
    elif selected_ids:
        selected = set(selected_ids)
        cards = [card for card in cards if card["id"] in selected]
        printings = [printing for printing in printings
                     if printing["card_id"] in selected]
    if not printings:
        parser.error("print selection contains no physical printings")
    home = profile["home"]
    press_config = profile["press"]
    contract = print_contract(game_dir)
    print_targets = load_print_targets()
    target_id = press_config.get("target", "generic-srgb")
    if target_id not in print_targets:
        parser.error(f"unknown print target: {target_id}")
    target = print_targets[target_id]
    cmyk_requested = target_id == "custom-cmyk-pdfx1a"
    profile_info = None
    profile_right = None
    if cmyk_requested:
        profile_rel = str(press_config.get("icc_profile") or "")
        if not profile_rel.startswith("assets/") or ".." in Path(profile_rel).parts or Path(profile_rel).suffix.lower() not in {".icc", ".icm"}:
            parser.error("custom CMYK output requires a safe repository ICC path under assets/")
        profile_path = game_dir / profile_rel
        if not profile_path.is_file():
            parser.error(f"printer ICC profile is missing at exact ref: {profile_rel}")
        try:
            profile_info = inspect_icc_profile(profile_path)
        except ValueError as error:
            parser.error(str(error))
        profile_right = resolve_asset_right(game_dir, profile_rel)
        if profile_right.get("status") in {None, "unknown", "missing"}:
            parser.error(f"printer ICC profile rights are not documented: {profile_rel}")
        if profile_right.get("status") in {"licensed", "permission-only"} and not profile_right.get("source"):
            parser.error(f"printer ICC profile license or permission source is missing: {profile_rel}")
        if profile_right.get("redistribution") != "allowed":
            parser.error(f"printer ICC profile redistribution is '{profile_right.get('redistribution', 'restricted')}', so it cannot be embedded in a release PDF")
        dieline = press_config.get("dieline") or {"enabled": False}
        if dieline.get("enabled"):
            if dieline["spot_name"].lower() in {"all", "none"}:
                parser.error("spot dieline name cannot use the reserved PDF colorant names All or None")
            if not any(float(value) > 0 for value in dieline["alternate_cmyk"]):
                parser.error("spot dieline alternate CMYK preview cannot be invisible 0/0/0/0")
            if float(dieline["offset_mm"]) > float(contract["bleed_mm"]):
                parser.error("spot dieline outward offset cannot extend beyond the declared bleed")
    sleeve_profiles = (args.sleeve_profile if args.sleeve_profile is not None
                       else ([] if home["sleeve_profile"] == "none"
                             else [home["sleeve_profile"]]))
    sleeve_gutter_mm = (args.sleeve_gutter_mm if args.sleeve_gutter_mm is not None
                        else float(home["gutter_mm"]))
    sleeve_fronts_only = (args.sleeve_fronts_only if args.sleeve_fronts_only is not None
                          else bool(home["fronts_only"]))
    sleeve_fit = args.sleeve_fit or home["sleeve_fit"]
    if sleeve_gutter_mm < 0:
        parser.error("--sleeve-gutter-mm must be zero or greater")
    slug = game.get("id") or game_dir.name
    title = game.get("title") or slug
    ref = args.ref or content_ref(game_dir)
    notice = private_notice(game_dir)
    out = (args.output_dir or game_dir / "exports" / "print-ready").resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    production_target = None
    cmyk_face_checks = []
    pdfx_checks = []

    with tempfile.TemporaryDirectory(prefix="forge-print-") as scratch_name:
        scratch = Path(scratch_name)
        trim = scratch / "trim"
        bleed = out / "fronts-bleed"
        render_command = [
            shutil.which("node") or "node", str(TOOLS / "render_cards.mjs"),
            str(game_dir), str(bleed), "--bleed",
        ]
        for card_id in selected_ids:
            render_command.extend(["--card", card_id])
        subprocess.run(render_command, check=True)
        bleed_px = px(contract["bleed_mm"], args.dpi)
        for printing in printings:
            trim_path = trim / f"{printing['id']}.png"
            bleed_path = bleed / f"{printing['id']}.png"
            trim_mm = trim_for(printing, contract)
            expected_trim = (px(trim_mm[0], args.dpi), px(trim_mm[1], args.dpi))
            trim_path.parent.mkdir(parents=True, exist_ok=True)
            extract_trim(bleed_path, trim_path, expected_trim, bleed_px, args.dpi)
        base_trim_px = (px(contract["w_mm"], args.dpi),
                        px(contract["h_mm"], args.dpi))
        extract_trim(bleed / "_back.png", trim / "_back.png",
                     base_trim_px, bleed_px, args.dpi)
        stamp_pngs(trim, args.dpi)
        stamp_pngs(bleed, args.dpi)

        for printing in printings:
            trim_mm = trim_for(printing, contract)
            expected_trim = (px(trim_mm[0], args.dpi), px(trim_mm[1], args.dpi))
            expected_bleed = (expected_trim[0] + 2 * bleed_px,
                              expected_trim[1] + 2 * bleed_px)
            for folder, expected in ((trim, expected_trim), (bleed, expected_bleed)):
                path = folder / f"{printing['id']}.png"
                with Image.open(path) as image:
                    if image.size != expected:
                        raise ValueError(
                            f"{path.name}: expected {folder.name} {expected} for "
                            f"{trim_mm[0]:g} x {trim_mm[1]:g} mm, got {image.size}"
                        )

        grouped = {}
        for printing in printings:
            grouped.setdefault(trim_for(printing, contract), []).append(printing)
        trim_jpegs = jpeg_cache(sorted(trim.glob("*.png")), scratch / "trim-jpeg", args.dpi)
        bleed_jpegs = jpeg_cache(sorted(bleed.glob("*.png")), scratch / "bleed-jpeg", args.dpi)
        base_trim = (contract["w_mm"], contract["h_mm"])
        group_outputs = []
        sleeve_outputs = []
        backs_bleed = out / "backs-bleed"
        for trim_mm, group_printings in grouped.items():
            label = size_label(trim_mm)
            suffix = "" if trim_mm == base_trim else f"-{label}"
            expected_trim = (px(trim_mm[0], args.dpi), px(trim_mm[1], args.dpi))
            expected_bleed = (expected_trim[0] + 2 * bleed_px,
                              expected_trim[1] + 2 * bleed_px)
            back_trim = jpeg_copy(
                trim / "_back.png", scratch / "backs-trim" / f"{label}.jpg",
                args.dpi, expected_trim,
            )
            back_bleed = backs_bleed / f"{label}-back.png"
            back_trim_png = scratch / "backs-trim-png" / f"{label}.png"
            resized_png(trim / "_back.png", back_trim_png, expected_trim, args.dpi)
            add_edge_bleed(back_trim_png, back_bleed, bleed_px, args.dpi)
            back_bleed_jpeg = jpeg_copy(
                back_bleed, scratch / "backs-bleed-jpeg" / f"{label}.jpg", args.dpi,
            )
            slots = slots_for(group_printings, trim)
            a4_pdf = out / f"{slug}-print-at-home-a4{suffix}.pdf"
            letter_pdf = out / f"{slug}-print-at-home-letter{suffix}.pdf"
            press_path = out / f"{slug}-press-rgb{suffix}.pdf"
            cmyk_press_path = out / f"{slug}-press-cmyk-pdfx1a{suffix}.pdf" if cmyk_requested else None
            print_at_home_pdf(
                a4_pdf, home_page_size(A4, home["orientation"]), slots, trim_jpegs, back_trim,
                trim_mm[0], trim_mm[1], title, ref, notice,
                gutter_mm=float(home["gutter_mm"]),
                fronts_only=bool(home["fronts_only"]),
                crop_style=home["crop_marks"],
                crop_mark_sides=home["crop_mark_sides"],
            )
            print_at_home_pdf(
                letter_pdf, home_page_size(LETTER, home["orientation"]), slots, trim_jpegs, back_trim,
                trim_mm[0], trim_mm[1], title, ref, notice,
                gutter_mm=float(home["gutter_mm"]),
                fronts_only=bool(home["fronts_only"]),
                crop_style=home["crop_marks"],
                crop_mark_sides=home["crop_mark_sides"],
            )
            press_faces = [bleed / f"{p['id']}.png" for p in group_printings]
            if press_config["include_back"]:
                press_faces.append(back_bleed)
            group_bleed_jpegs = dict(bleed_jpegs)
            group_bleed_jpegs[back_bleed.name] = back_bleed_jpeg
            press_pdf(
                press_path, press_faces, group_bleed_jpegs, trim_mm[0], trim_mm[1],
                contract["bleed_mm"], title, ref, press_config["crop_marks"],
                press_config["crop_mark_sides"], back_bleed if press_config["include_back"] else None,
            )
            if cmyk_requested:
                cmyk_jpegs, face_checks = cmyk_jpeg_cache(
                    press_faces, scratch / "press-cmyk-jpeg" / label, args.dpi,
                    profile_info, press_config["rendering_intent"],
                    float(press_config["max_ink_coverage_percent"]),
                )
                cmyk_face_checks.extend(face_checks)
                base_candidate = scratch / f"{slug}-press-cmyk-base{suffix}.pdf"
                press_pdf(
                    base_candidate, press_faces, cmyk_jpegs, trim_mm[0], trim_mm[1],
                    contract["bleed_mm"], title, ref, press_config["crop_marks"],
                    press_config["crop_mark_sides"], back_bleed if press_config["include_back"] else None,
                    color_label="CMYK via versioned ICC output profile",
                    dieline=press_config.get("dieline"), radius_mm=contract["radius_mm"],
                )
                write_pdfx1a_candidate(base_candidate, cmyk_press_path, profile_info, press_config)
                candidate_check = inspect_pdfx1a_candidate(cmyk_press_path, profile_info["sha256"], press_config)
                if candidate_check["status"] != "pass":
                    raise ValueError(f"CMYK PDF/X candidate failed structural preflight: {candidate_check['blockers']}")
                candidate_check["file"] = cmyk_press_path.relative_to(out).as_posix()
                pdfx_checks.append(candidate_check)
            group_outputs.append({
                "trim_mm": [trim_mm[0], trim_mm[1]],
                "unique_fronts": len(group_printings),
                "physical_cards": sum(max(1, int(p.get("quantity", 1)))
                                      for p in group_printings),
                "a4_pdf": a4_pdf.name,
                "letter_pdf": letter_pdf.name,
                "press_pdf": press_path.name,
                **({"press_pdf_cmyk_pdfx1a_candidate": cmyk_press_path.name} if cmyk_press_path else {}),
                "back_file": f"backs/{back_bleed.name}",
            })

        if target_id == "the-game-crafter-poker":
            production_target = build_named_target_handoff(
                target, out, trim, bleed, printings, contract,
                bool(press_config["include_back"]), args.dpi,
            )
        elif cmyk_requested:
            production_target = {
                "id": target_id,
                "label": target["label"],
                "status": "structural-preflight-pass",
                "handoff": "files-only",
                "publishing": False,
                "requirements": target["requirements"],
                "source_revision": target.get("checked_at"),
                "sources": target.get("sources", []),
                "output_profile": {
                    "path": press_config["icc_profile"],
                    "sha256": profile_info["sha256"],
                    "name": profile_info["name"],
                    "device_class": profile_info["device_class"],
                    "color_space": profile_info["color_space"],
                    "pcs": profile_info["pcs"],
                    "rights": profile_right,
                },
                "independent_pdfx_validation": False,
                "printer_approval_required": True,
            }

        for profile_name in sleeve_profiles:
            sleeve_spec = sleeve_profile_spec(profile_name, home)
            insert_mm = sleeve_spec["insert_mm"]
            insert_px = (px(insert_mm[0], args.dpi),
                         px(insert_mm[1], args.dpi))
            profile_root = out / "sleeve-inserts" / profile_name
            profile_trim = profile_root / "fronts"
            rendered_sizes = {}
            for printing in printings:
                fitted = sleeve_fitted_png(
                    trim / f"{printing['id']}.png",
                    profile_trim / f"{printing['id']}.png",
                    insert_px, args.dpi, sleeve_spec["background"], sleeve_fit,
                    bleed_source=bleed / f"{printing['id']}.png",
                    rounded_trim=contract["radius_mm"] > 0,
                )
                rendered_sizes[printing["id"]] = [
                    fitted[0] / insert_px[0] * insert_mm[0],
                    fitted[1] / insert_px[1] * insert_mm[1],
                ]
            profile_back = profile_root / "back.png"
            sleeve_fitted_png(trim / "_back.png", profile_back, insert_px,
                              args.dpi, sleeve_spec["background"], sleeve_fit,
                              bleed_source=bleed / "_back.png",
                              rounded_trim=contract["radius_mm"] > 0)
            stamp_pngs(profile_trim, args.dpi)
            sleeve_jpegs = jpeg_cache(
                sorted(profile_trim.glob("*.png")),
                scratch / "sleeve-jpeg" / profile_name, args.dpi,
            )
            sleeve_back = jpeg_copy(
                profile_back,
                scratch / "sleeve-back-jpeg" / f"{profile_name}.jpg",
                args.dpi, insert_px,
            )
            sleeve_slots = slots_for(printings, profile_trim)
            a4_pdf = out / f"{slug}-print-at-home-a4-{profile_name}.pdf"
            letter_pdf = out / f"{slug}-print-at-home-letter-{profile_name}.pdf"
            size_notice = (
                f"ACTUAL SIZE / 100% - CUT TO {insert_mm[0]:g} x "
                f"{insert_mm[1]:g} MM"
                + (f" - FOR {sleeve_spec['sleeve_mm'][0]:g} x {sleeve_spec['sleeve_mm'][1]:g} MM SLEEVES"
                   if sleeve_spec["sleeve_mm"] else " - CUSTOM INSERT; TEST FIT FIRST")
            )
            if sleeve_fronts_only:
                size_notice += " - FRONTS ONLY"
            if sleeve_fit == "cover":
                size_notice += " - FULL HEIGHT / CENTER CROP"
            elif sleeve_fit == "extend":
                size_notice += " - FULL HEIGHT / COMPLETE FACE"
            print_at_home_pdf(
                a4_pdf, home_page_size(A4, home["orientation"]), sleeve_slots, sleeve_jpegs, sleeve_back,
                insert_mm[0], insert_mm[1], title, ref, notice, size_notice,
                sleeve_gutter_mm, sleeve_fronts_only,
                "corners" if sleeve_gutter_mm else home["crop_marks"],
                home["crop_mark_sides"],
            )
            print_at_home_pdf(
                letter_pdf, home_page_size(LETTER, home["orientation"]), sleeve_slots, sleeve_jpegs, sleeve_back,
                insert_mm[0], insert_mm[1], title, ref, notice, size_notice,
                sleeve_gutter_mm, sleeve_fronts_only,
                "corners" if sleeve_gutter_mm else home["crop_marks"],
                home["crop_mark_sides"],
            )
            unique_rendered = {
                tuple(round(value, 3) for value in size)
                for size in rendered_sizes.values()
            }
            sleeve_outputs.append({
                "profile": profile_name,
                "sleeve_outer_mm": list(sleeve_spec["sleeve_mm"]) if sleeve_spec["sleeve_mm"] else None,
                "insert_trim_mm": list(insert_mm),
                "rendered_face_mm": [list(size) for size in sorted(unique_rendered)],
                "fit": {
                    "contain": "contain (no crop, no distortion)",
                    "cover": "cover (center crop, no distortion)",
                    "extend": "contain + native-bleed/painted-edge extension (no trim crop or content distortion)",
                }[sleeve_fit],
                "background": sleeve_spec["background"],
                "gutter_mm": sleeve_gutter_mm,
                "fronts_only": sleeve_fronts_only,
                "a4_pdf": a4_pdf.name,
                "letter_pdf": letter_pdf.name,
            })

    # The direct home downloads follow the committed insert choice. Keep native
    # and optional insert variants in the full package, with explicit names.
    chosen_home = sleeve_outputs[0] if sleeve_outputs else group_outputs[0]
    selected_trim = chosen_home.get("insert_trim_mm", chosen_home.get("trim_mm"))
    calibration = {}
    for paper, size in (("a4", A4), ("letter", LETTER)):
        path = out / f"{slug}-calibration-{paper}.pdf"
        calibration_pdf(path, home_page_size(size, home["orientation"]), selected_trim, title, ref)
        calibration[paper] = path.name
    home_downloads = {"a4_pdf": chosen_home["a4_pdf"], "letter_pdf": chosen_home["letter_pdf"],
                      "trim_mm": selected_trim, "orientation": home["orientation"],
                      "calibration": calibration}

    quantities = out / "quantities.csv"
    write_quantities(quantities, printings, cards)
    pdf_checks = []
    for path in sorted(out.rglob("*.pdf")):
        check = inspect_pdf(path, "-press-" in path.name)
        check["file"] = path.relative_to(out).as_posix()
        pdf_checks.append(check)
    unembedded = [{"file": item["file"], "font": font["name"]}
                  for item in pdf_checks if "-print-at-home-" in item["file"]
                  for font in item["fonts"] if not font["embedded"] and not font["standard_14"]]
    missing_embedded = [item["file"] for item in pdf_checks
                        if "-print-at-home-" in item["file"]
                        and not any(font["embedded"] for font in item["fonts"])]
    missing_boxes = [item["file"] for item in pdf_checks
                     if "-press-" in item["file"] and item["page_boxes"] != "verified"]
    if unembedded:
        raise ValueError(f"home-print PDF contains unembedded fonts: {unembedded}")
    if missing_embedded:
        raise ValueError(f"home-print PDF has no embedded production font: {missing_embedded}")
    if missing_boxes:
        raise ValueError(f"press PDF is missing TrimBox/BleedBox: {missing_boxes}")
    preflight = {
        "format": "forge-print-preflight-v2",
        "status": "pass",
        "exact_ref": ref,
        "profile": profile,
        "selection": {
            "mode": "exact-printings" if exact_quantities else "selected" if selected_ids else "all",
            "card_ids": selected_ids,
            "printing_quantities": exact_quantities,
            "cards": len(cards),
            "printings": len(printings),
        },
        "raster_faces": {
            "dpi": args.dpi,
            "color_space": "sRGB",
            "bleed_mm_each_side": contract["bleed_mm"],
            "checked": len(printings) + 1,
        },
        "vector_black": "DeviceCMYK 0/0/0/1 (100% K) for notices and crop marks",
        "crop_marks": {
            "home": {"style": home["crop_marks"], "sides": home["crop_mark_sides"]},
            "press": {"style": press_config["crop_marks"], "sides": press_config["crop_mark_sides"]},
        },
        "spot_dieline": press_config.get("dieline", {"enabled": False}),
        "pdfs": pdf_checks,
        "press_boundary": ({
            "pdf_x": False,
            "pdf_x_candidate": True,
            "cmyk_faces": True,
            "icc_output_profile": {
                "path": press_config["icc_profile"], "sha256": profile_info["sha256"],
                "name": profile_info["name"], "rights": profile_right,
            },
            "rendering_intent": press_config["rendering_intent"],
            "declared_max_ink_coverage_percent": press_config["max_ink_coverage_percent"],
            "converted_faces": cmyk_face_checks,
            "pdf_x_structural_checks": pdfx_checks,
            "independent_validation": False,
            "reason": "Forge proved the exact output profile, CMYK image objects, page boxes, self-identification, output intent, font/transparency constraints, and measured total ink. The receiving printer must still approve the exact bytes; Forge does not claim independent PDF/X certification.",
        } if cmyk_requested else {
            "pdf_x": False,
            "pdf_x_candidate": False,
            "cmyk_faces": False,
            "reason": "No printer ICC profile is selected; generic press output is labelled sRGB only.",
        }),
        "production_target": production_target or {
            "id": target_id,
            "label": target["label"],
            "status": "unqualified",
            "handoff": "generic-files",
            "publishing": False,
            "source_revision": target.get("checked_at"),
            "sources": target.get("sources", []),
        },
    }
    preflight_path = out / "preflight.json"
    preflight_path.write_text(json.dumps(preflight, indent=2) + "\n")
    profile_path = out / "print-profile.yaml"
    profile_path.write_text(yaml.safe_dump(profile, sort_keys=False))
    manifest = {
        "format": "forge-print-ready-v3",
        "game_id": slug,
        "title": title,
        "exact_ref": ref,
        "dpi": args.dpi,
        "color_space": "sRGB + CMYK" if cmyk_requested else "sRGB",
        "print_profile": profile,
        "print_profile_source": profile_path.name,
        "home_downloads": home_downloads,
        "production_target": preflight["production_target"],
        "trim_mm": [contract["w_mm"], contract["h_mm"]],
        "physical_sizes": group_outputs,
        "sleeve_profiles": sleeve_outputs,
        "bleed_mm_each_side": contract["bleed_mm"],
        "bleed_pixels": px(contract["bleed_mm"], args.dpi),
        "unique_fronts": len(printings),
        "physical_cards": sum(max(1, int(p.get("quantity", 1))) for p in printings),
        "duplex": ("fronts only" if home["fronts_only"] else
                   f"{home['orientation']}, flip on long edge; back {'rows' if home['orientation'] == 'landscape' else 'columns'} are mirrored"),
        "press_pdf": ("one RGB PDF per physical size; one unique front per page"
                      + (" plus one fitted back page" if press_config["include_back"] else "")
                      + ("; plus a structurally preflighted CMYK PDF/X-1a:2003 candidate" if cmyk_requested else "")
                      + (f" with overprinting /{press_config['dieline']['spot_name']} trim paths" if cmyk_requested and press_config.get("dieline", {}).get("enabled") else "")
                      + "; use quantities.csv"),
        "private_notice": notice or None,
        "preflight": preflight_path.name,
    }
    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    readme = out / "README.txt"
    readme.write_text(
        f"{title} - Forge print build\n"
        f"Exact version: {ref}\n\n"
        "HOME PRINTING\n"
        "- Open the A4 or US Letter PDF matching both your paper and component size.\n"
        "- Print at Actual Size / 100%; disable Fit, Shrink, and borderless expansion.\n"
        "- Print the matching calibration PDF first. Both rulers must measure 50 mm.\n"
        "- Sleeve outside dimensions are not the insert dimensions; test a single cut card.\n"
        + ("- This profile contains fronts only; use opaque sleeves or another declared backing.\n"
           if home["fronts_only"] else
           f"- For {home['orientation']} duplex, flip on the long edge. Forge mirrors the back {'rows' if home['orientation'] == 'landscape' else 'columns'}.\n")
        + (f"- Crop marks: {home['crop_marks']} on {home['crop_mark_sides']} pages.\n"
           if home["crop_marks"] != "none" else "- Crop marks are disabled.\n")
        + ("- Every home-PDF page is a front sheet.\n\n" if home["fronts_only"] else
           "- For the most reliable prototype, print odd pages only and use opaque sleeves.\n\n")
        + "SLEEVE PROFILES\n"
        + ("".join(
            f"- {item['profile']}: cut to {item['insert_trim_mm'][0]:g} x "
            f"{item['insert_trim_mm'][1]:g} mm"
            + (f" for {item['sleeve_outer_mm'][0]:g} x {item['sleeve_outer_mm'][1]:g} mm sleeves"
               if item['sleeve_outer_mm'] else " (custom insert; test fit first)")
            + f"; fit: {item['fit']}.\n"
            for item in sleeve_outputs
        ) or "- No optional sleeve profile was requested.\n")
        + "\n"
        + "PRINT SERVICE\n"
        "- fronts-bleed/ contains 300 DPI sRGB PNGs at each component's declared size.\n"
        "- Each press PDF covers one trim size and has explicit TrimBox/BleedBox metadata.\n"
        "- quantities.csv tells the printer how many copies of each unique face to make.\n"
        + ("- The CMYK PDF/X-1a:2003 candidate embeds the exact rights-tracked output profile named in print-profile.yaml.\n"
           + (f"- Its component trim path is a full-tint /{press_config['dieline']['spot_name']} Separation stroke with overprint enabled on {press_config['dieline']['sides']} pages.\n" if press_config.get("dieline", {}).get("enabled") else "")
           + "- Forge's structural preflight is not independent certification; send the exact PDF to the receiving printer for approval.\n"
           + "- Confirm the exact spot name, cut offset, corner radius, stock, and finishing with the printer.\n\n"
           if cmyk_requested else
           "- Confirm RGB acceptance, corner radius, stock, and black handling with the printer.\n\n")
        + (f"NAMED TARGET\n- {production_target['label']}: {production_target['fronts']} front files"
           + (" plus one shared back" if production_target.get("back") else "")
           + f" passed exact {production_target['requirements']['upload_px'][0]} x {production_target['requirements']['upload_px'][1]} px, RGB, and 300 DPI checks.\n"
           + "- This is a traced file handoff, not a native account integration. Recheck the linked vendor specification before ordering.\n\n"
           if production_target and target_id == "the-game-crafter-poker" else "")
        + (f"CMYK TARGET\n- {production_target['label']}: profile {production_target['output_profile']['name']} "
           f"({production_target['output_profile']['sha256']}) is embedded in every candidate.\n"
           "- Publishing is files-only; printer approval is required.\n\n"
           if production_target and cmyk_requested else "")
        + "PREFLIGHT\n"
        "- preflight.json records reopened PDF pages, embedded PDF fonts, page boxes, 100% K vector marks, color objects, profile hashes, and exact press boundaries.\n"
        + ("- This build includes a CMYK PDF/X-1a:2003 candidate with structural Forge checks; receiving-printer validation remains required.\n\n"
           if cmyk_requested else
           "- This build is sRGB. It is not labelled CMYK or PDF/X without a printer ICC profile.\n\n")
        + "RIGHTS\n"
        f"- {notice or 'Follow the game license and every credited asset license before distribution.'}\n"
    )

    zip_path = out / f"{slug}-print-ready.zip"
    package_files = [
        (readme, "README.txt"), (manifest_path, "manifest.json"),
        (preflight_path, "preflight.json"), (profile_path, "print-profile.yaml"),
        (quantities, "quantities.csv"),
    ]
    for path in sorted(out.glob("*.pdf")):
        package_files.append((path, f"pdf/{path.name}"))
    for path in sorted((out / "fronts-bleed").glob("*.png")):
        if path.name != "_back.png":
            package_files.append((path, f"fronts-bleed/{path.name}"))
    for path in sorted((out / "backs-bleed").glob("*.png")):
        package_files.append((path, f"backs/{path.name}"))
    manufacturer_root = out / "manufacturer"
    if manufacturer_root.exists():
        for path in sorted(candidate for candidate in manufacturer_root.rglob("*") if candidate.is_file()):
            package_files.append((path, path.relative_to(out).as_posix()))
    zip_package(zip_path, out, package_files)
    print(json.dumps({
        "package": str(zip_path),
        "physical_sizes": group_outputs,
        "manifest": manifest,
    }, indent=2))


if __name__ == "__main__":
    main()
