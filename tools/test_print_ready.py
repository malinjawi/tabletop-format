#!/usr/bin/env python3
"""Regression checks for print-ready image fitting."""

import tempfile
import hashlib
import os
import json
from pathlib import Path

from PIL import Image, ImageDraw
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.units import mm
from jsonschema import Draft202012Validator

from export_print_ready import (
    corner_crop_marks,
    inspect_pdf,
    load_print_profile,
    load_print_targets,
    mark_side_enabled,
    build_named_target_handoff,
    cmyk_jpeg_cache,
    inspect_icc_profile,
    inspect_pdfx1a_candidate,
    press_pdf,
    print_at_home_pdf,
    calibration_pdf,
    home_page_size,
    sleeve_profile_spec,
    sleeve_fitted_png,
    write_pdfx1a_candidate,
)


class RecordingPdf:
    """Small canvas double for checking crop-mark geometry."""

    def __init__(self):
        self.lines = []

    def saveState(self):
        pass

    def restoreState(self):
        pass

    def setStrokeColor(self, _color):
        pass

    def setLineWidth(self, _width):
        pass

    def setLineCap(self, _cap):
        pass

    def line(self, x1, y1, x2, y2):
        self.lines.append((x1, y1, x2, y2))


def synthetic_card(size=(100, 140)):
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (0, 0, size[0] - 1, size[1] - 1), radius=12,
        fill="#4f7564", outline="#05080b", width=3,
    )
    # A footer/side rail that reaches beneath the rounded edge cap, like a
    # production card frame.  The extension must continue this color without
    # leaving the original rounded outline stranded inside the insert.
    footer = Image.new("RGB", size, "#4f7564")
    mask = Image.new("L", size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(
        (0, 0, size[0] - 1, size[1] - 1), radius=12, fill=255,
    )
    footer_mask = Image.new("L", size, 0)
    footer_mask.paste(mask.crop((0, 82, size[0], size[1])), (0, 82))
    image.paste(footer, mask=footer_mask)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (0, 0, size[0] - 1, size[1] - 1), radius=12,
        outline="#05080b", width=3,
    )
    return image


def assert_vertical_extension(folder):
    source = folder / "vertical-source.png"
    target = folder / "vertical-target.png"
    synthetic_card().save(source)
    sleeve_fitted_png(source, target, (100, 160), 300, fit="extend")
    with Image.open(target) as result:
        result = result.convert("RGB")
        # Meaningful content retains contain-mode placement.
        assert result.getpixel((50, 70)) == synthetic_card().getpixel((50, 60))
        # The footer continues across the inserted height.  The rounded black
        # trim line is only at the new physical edge, never at the old edge.
        for y in range(120, 130):
            assert result.getpixel((50, y)) == (79, 117, 100)
        assert result.getpixel((50, 149)) != (5, 8, 11)
        assert result.getpixel((50, 159)) == (5, 8, 11)


def assert_horizontal_extension(folder):
    source = folder / "horizontal-source.png"
    target = folder / "horizontal-target.png"
    synthetic_card().rotate(90, expand=True).save(source)
    sleeve_fitted_png(source, target, (160, 100), 300, fit="extend")
    with Image.open(target) as result:
        result = result.convert("RGB")
        for x in range(120, 130):
            assert result.getpixel((x, 50)) == (79, 117, 100)
        assert result.getpixel((149, 50)) != (5, 8, 11)
        assert result.getpixel((159, 50)) == (5, 8, 11)


def assert_square_painted_edge(folder):
    source = folder / "square-source.png"
    target = folder / "square-target.png"
    image = Image.new("RGB", (100, 140), "#305070")
    ImageDraw.Draw(image).rectangle((0, 118, 99, 139), fill="#d3a124")
    image.save(source)
    sleeve_fitted_png(
        source, target, (100, 160), 300, fit="extend",
        rounded_trim=False,
    )
    with Image.open(target) as result:
        result = result.convert("RGB")
        assert result.getpixel((50, 0)) == (48, 80, 112)
        assert result.getpixel((50, 159)) == (211, 161, 36)
        assert result.getpixel((50, 149)) == (211, 161, 36)


def assert_native_bleed_preferred(folder):
    source = folder / "bleed-trim.png"
    bleed = folder / "bleed-source.png"
    target = folder / "bleed-target.png"
    synthetic_card().save(source)
    canvas = Image.new("RGB", (120, 160), "#c020d0")
    canvas.paste(synthetic_card(), (10, 10))
    canvas.save(bleed)
    sleeve_fitted_png(
        source, target, (100, 150), 300, fit="extend",
        bleed_source=bleed, rounded_trim=True,
    )
    with Image.open(target) as result:
        result = result.convert("RGB")
        assert result.getpixel((50, 0)) == (192, 32, 208)
        assert result.getpixel((50, 149)) == (192, 32, 208)


def assert_crop_marks_stay_outside_trim():
    pdf = RecordingPdf()
    x, y, card_w, card_h, gutter = 20, 30, 59, 86, 3
    corner_crop_marks(pdf, [(x, y)], card_w, card_h, gutter)

    assert len(pdf.lines) == 8
    for x1, y1, x2, y2 in pdf.lines:
        # Every tick is horizontal or vertical and ends before reaching the
        # painted card rectangle.  The trim edge is communicated by alignment,
        # never by a rule that could remain on the finished card.
        assert x1 == x2 or y1 == y2
        midpoint = ((x1 + x2) / 2, (y1 + y2) / 2)
        assert not (x <= midpoint[0] <= x + card_w and
                    y <= midpoint[1] <= y + card_h)

    horizontal = [line for line in pdf.lines if line[1] == line[3]]
    vertical = [line for line in pdf.lines if line[0] == line[2]]
    assert {line[1] for line in horizontal} == {y, y + card_h}
    assert {line[0] for line in vertical} == {x, x + card_w}


def assert_crop_mark_side_selection():
    assert mark_side_enabled("both", "fronts")
    assert mark_side_enabled("both", "backs")
    assert mark_side_enabled("fronts", "fronts")
    assert not mark_side_enabled("fronts", "backs")
    assert mark_side_enabled("backs", "backs")
    assert not mark_side_enabled("backs", "fronts")


def assert_front_only_marks_in_duplex_pdf(folder):
    front, back = folder / "mark-front.jpg", folder / "mark-back.jpg"
    Image.new("RGB", (697, 1016), "#d7462f").save(front, "JPEG", dpi=(300, 300))
    Image.new("RGB", (697, 1016), "#263b63").save(back, "JPEG", dpi=(300, 300))
    output = folder / "front-marks-only.pdf"
    print_at_home_pdf(
        output, A4, [front], {front.name: front}, back,
        59, 86, "Selective mark proof", "test-ref", "",
        gutter_mm=4, crop_style="corners", crop_mark_sides="fronts",
    )
    pages = PdfReader(output).pages
    assert len(pages) == 2
    # Page notices use 100% K fill (`k`); crop marks uniquely use a 100% K
    # stroke (`K`). This checks the real serialized PDF, not merely the selector.
    assert b"0 0 0 1 K" in pages[0].get_contents().get_data()
    assert b"0 0 0 1 K" not in pages[1].get_contents().get_data()


def assert_front_only_marks_in_press_pdf(folder):
    front, back = folder / "press-front.jpg", folder / "press-back.jpg"
    Image.new("RGB", (773, 1092), "#d7462f").save(front, "JPEG", dpi=(300, 300))
    Image.new("RGB", (773, 1092), "#263b63").save(back, "JPEG", dpi=(300, 300))
    output = folder / "press-front-marks-only.pdf"
    press_pdf(
        output, [front, back], {front.name: front, back.name: back},
        59, 86, 3.25, "Selective press proof", "test-ref",
        crop_mark_sides="fronts", back_path=back,
    )
    pages = PdfReader(output).pages
    assert len(pages) == 2
    assert b"0 0 0 1 K" in pages[0].get_contents().get_data()
    assert b"0 0 0 1 K" not in pages[1].get_contents().get_data()


def assert_pdfx_candidate_contract(folder):
    face = folder / "press-cmyk.jpg"
    Image.new("CMYK", (773, 1092), (0, 120, 220, 15)).save(face, "JPEG", dpi=(300, 300))
    base = folder / "press-cmyk-base.pdf"
    output = folder / "press-cmyk-pdfx1a.pdf"
    dieline = {"enabled": True, "shape": "component-trim", "spot_name": "CutContour",
               "alternate_cmyk": [0, 100, 0, 0], "stroke_width_pt": 0.25,
               "offset_mm": 0, "overprint": True, "sides": "fronts"}
    press_pdf(base, [face], {face.name: face}, 59, 86, 3.25,
              "CMYK proof", "test-ref", color_label="CMYK",
              dieline=dieline, radius_mm=3)
    profile = bytearray(132)
    profile[0:4] = len(profile).to_bytes(4, "big")
    profile[8] = 4
    profile[12:16] = b"prtr"
    profile[16:20] = b"CMYK"
    profile[20:24] = b"Lab "
    profile[36:40] = b"acsp"
    profile_info = {"bytes": bytes(profile), "sha256": hashlib.sha256(profile).hexdigest(), "name": "Synthetic test output"}
    config = {"output_condition_identifier": "TEST-CMYK", "output_condition": "Synthetic contract test",
              "registry_name": "https://registry.color.org/", "include_back": False,
              "dieline": dieline}
    write_pdfx1a_candidate(base, output, profile_info, config)
    check = inspect_pdfx1a_candidate(output, profile_info["sha256"], config)
    assert check["status"] == "pass", check["blockers"]
    assert check["pdf_x_identification"] == "PDF/X-1a:2003"
    assert check["independent_validation"] is False
    assert check["images"] and all(image["color_space"] == "/DeviceCMYK" for image in check["images"])
    assert check["spot_dielines"] == [{"page": 1, "side": "fronts", "expected": True,
                                        "present": True, "separation": True,
                                        "full_tint": True, "stroke_overprint": True}]
    assert inspect_pdfx1a_candidate(output, "0" * 64)["status"] == "fail"


def assert_real_icc_conversion_when_supplied(folder):
    configured = os.environ.get("FORGE_TEST_CMYK_ICC")
    if not configured:
        return
    profile = inspect_icc_profile(Path(configured))
    face = folder / "rgb-for-cmyk.png"
    Image.new("RGB", (120, 160), "#d7462f").save(face, "PNG", dpi=(300, 300))
    converted, checks = cmyk_jpeg_cache([face], folder / "converted", 300, profile,
                                        "relative-colorimetric", 400)
    with Image.open(converted[face.name]) as image:
        assert image.mode == "CMYK" and not image.info.get("icc_profile")
    assert checks[0]["pixels_checked"] == 120 * 160 and checks[0]["max_total_ink_percent"] > 0


def assert_versioned_profile_and_embedded_pdf_font(folder):
    game = folder / "game"
    (game / "templates").mkdir(parents=True)
    default = load_print_profile(game)
    assert default["preset"] == "balanced-duplex"
    assert default["selection"]["card_ids"] == []
    assert default["press"]["target"] == "generic-srgb"
    assert default["home"]["crop_mark_sides"] == "both"
    assert default["press"]["crop_mark_sides"] == "both"
    (game / "templates" / "print.yaml").write_text(
        "schema_version: 1\n"
        "preset: opaque-sleeves\n"
        "selection: { card_ids: [strike] }\n"
        "home: { fronts_only: true, gutter_mm: 3, crop_marks: corners, crop_mark_sides: fronts, sleeve_profile: japanese-62x89, sleeve_fit: extend }\n"
        "press: { include_back: false, crop_marks: none, crop_mark_sides: fronts, color_space: sRGB, pdf_standard: none }\n"
    )
    configured = load_print_profile(game)
    assert configured["selection"]["card_ids"] == ["strike"]
    assert configured["home"]["sleeve_fit"] == "extend"
    assert configured["home"]["crop_mark_sides"] == "fronts"

    face = folder / "font-proof.jpg"
    Image.new("RGB", (750, 1050), "white").save(face, "JPEG")
    output = folder / "font-proof.pdf"
    print_at_home_pdf(
        output, A4, [face], {face.name: face}, face,
        63.5, 88.9, "Font proof", "test-ref", "",
        fronts_only=True,
    )
    proof = inspect_pdf(output)
    assert proof["pages"] == 1
    assert any(font["embedded"] for font in proof["fonts"])


def assert_named_tgc_handoff(folder):
    trim, bleed, output = folder / "target-trim", folder / "target-bleed", folder / "target-out"
    trim.mkdir(); bleed.mkdir(); output.mkdir()
    for name, color in (("p_alpha.png", "#c02040"), ("_back.png", "#203050")):
        Image.new("RGB", (750, 1050), color).save(trim / name, "PNG", dpi=(300, 300))
        Image.new("RGB", (798, 1098), color).save(bleed / name, "PNG", dpi=(300, 300))
    target = load_print_targets()["the-game-crafter-poker"]
    result = build_named_target_handoff(
        target, output, trim, bleed,
        [{"id": "p_alpha", "card_id": "alpha", "quantity": 2}],
        {"w_mm": 63.5, "h_mm": 88.9}, True, 300,
    )
    assert result["status"] == "pass" and result["handoff"] == "files-only"
    assert result["publishing"] is False and result["fronts"] == 1
    assert result["normalization"] == ["edge-extension-from-trim"]
    assert all(check["pass"] and check["pixels"] == [825, 1125] and check["mode"] == "RGB"
               for check in result["checks"])
    try:
        build_named_target_handoff(
            target, output, trim, bleed,
            [{"id": "p_alpha", "card_id": "alpha", "physical_size_mm": {"width": 59, "height": 86}}],
            {"w_mm": 63.5, "h_mm": 88.9}, True, 300,
        )
        raise AssertionError("incompatible trim should not be presented as TGC-ready")
    except ValueError as error:
        assert "requires 63.5 x 88.9 mm trim" in str(error)


def assert_custom_home_geometry(folder):
    front = folder / "geometry-front.jpg"
    Image.new("RGB", (660, 909), "#487664").save(front)
    def matrices(page):
        current, result = None, []
        for operands, operator in page.get_contents().operations:
            if operator == b"cm":
                current = [float(value) for value in operands]
            if operator == b"Do":
                result.append(current)
        return result
    for paper in (A4, LETTER):
        landscape = home_page_size(paper, "landscape")
        output = folder / "custom-grid.pdf"
        print_at_home_pdf(output, landscape, [front] * 9, {front.name: front}, front,
                          66, 90.892, "Exact insert", "test-ref", "", fronts_only=True)
        reader = PdfReader(output)
        assert len(reader.pages) == 2
        assert str(reader.trailer["/Root"]["/ViewerPreferences"]["/PrintScaling"]) == "/None"
        boxes = matrices(reader.pages[0])
        assert len(boxes) == 8
        assert all(abs(box[0] / mm - 66) < 1e-5 and abs(box[3] / mm - 90.892) < 1e-5 for box in boxes)
        assert abs(boxes[0][4] + boxes[0][0] - boxes[1][4]) < .001, "shared vertical cuts have no gaps"
        assert abs(boxes[4][5] + boxes[4][3] - boxes[0][5]) < .001, "shared horizontal cuts have no gaps"
        assert len(matrices(reader.pages[1])) == 1, "partial last sheet preserves exact quantity"
    for orientation in ("portrait", "landscape"):
        size = home_page_size(A4, orientation)
        output = folder / "duplex-geometry.pdf"
        print_at_home_pdf(output, size, [front] * 3, {front.name: front}, front,
                          66, 90.892, "Duplex", "test-ref", "")
        pages = PdfReader(output).pages
        assert len(pages) == 2
        for face, back in zip(matrices(pages[0]), matrices(pages[1])):
            if orientation == "portrait":
                assert abs(face[4] + back[4] + face[0] - size[0]) < .001
                assert abs(face[5] - back[5]) < .001
            else:
                assert abs(face[5] + back[5] + face[3] - size[1]) < .001
                assert abs(face[4] - back[4]) < .001
    proof = folder / "calibration.pdf"
    calibration_pdf(proof, home_page_size(A4, "landscape"), (66, 90.892), "Proof", "test-ref")
    page = PdfReader(proof).pages[0]
    lengths = []
    start = None
    for operands, operator in page.get_contents().operations:
        if operator == b"m": start = [float(value) for value in operands]
        if operator == b"l" and start:
            end = [float(value) for value in operands]
            lengths.append(((end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2) ** .5 / mm)
    assert sum(abs(length - 50) < 1e-4 for length in lengths) == 2
    assert "66 x 90.892 mm" in page.extract_text()


def assert_custom_home_validation():
    schema = json.loads((Path(__file__).resolve().parents[1] / "schemas/print-profile.schema.json").read_text())
    from export_print_ready import DEFAULT_PRINT_PROFILE
    profile = json.loads(json.dumps(DEFAULT_PRINT_PROFILE))
    validator = Draft202012Validator(schema)
    assert validator.is_valid(profile)
    profile["home"].update(sleeve_profile="custom", orientation="landscape", insert_mm={"w_mm": 66, "h_mm": 90.892})
    assert validator.is_valid(profile)
    assert sleeve_profile_spec("custom", profile["home"])["insert_mm"] == (66, 90.892)
    for dimensions in ({"w_mm": 0, "h_mm": 90}, {"w_mm": 66}, {"w_mm": 66, "h_mm": 210}):
        profile["home"]["insert_mm"] = dimensions
        assert not validator.is_valid(profile)
        try:
            sleeve_profile_spec("custom", profile["home"])
            raise AssertionError("invalid custom dimensions were accepted")
        except ValueError:
            pass
    profile["home"]["insert_mm"] = {"w_mm": 66, "h_mm": 90}
    profile["home"]["sleeve_profile"] = "none"
    assert not validator.is_valid(profile), "inactive dimensions must not masquerade as the active cut size"


def main():
    with tempfile.TemporaryDirectory(prefix="forge-print-ready-") as temp:
        folder = Path(temp)
        assert_vertical_extension(folder)
        assert_horizontal_extension(folder)
        assert_square_painted_edge(folder)
        assert_native_bleed_preferred(folder)
        assert_crop_marks_stay_outside_trim()
        assert_crop_mark_side_selection()
        assert_front_only_marks_in_duplex_pdf(folder)
        assert_front_only_marks_in_press_pdf(folder)
        assert_pdfx_candidate_contract(folder)
        assert_real_icc_conversion_when_supplied(folder)
        assert_versioned_profile_and_embedded_pdf_font(folder)
        assert_named_tgc_handoff(folder)
        assert_custom_home_geometry(folder)
        assert_custom_home_validation()
    print("print-ready profile, named TGC handoff, embedded font, edge extension, and face-selective crop marks: ok")


if __name__ == "__main__":
    main()
