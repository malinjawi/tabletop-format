#!/usr/bin/env node
/** Regression proof for composable card families.
 * Verifies every real card resolves exactly once and that the visible regions
 * are byte-for-byte equivalent to the legacy monolithic layout. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

import yaml from "js-yaml";
import { cardMatchesFamily, loadCardDesign } from "./lib/card-design.mjs";

const gameDir = resolve(process.argv[2] || "examples/_fixtures/netrunner-sg");
const game = yaml.load(readFileSync(join(gameDir, "game.yaml"), "utf8"));
const cards = JSON.parse(readFileSync(join(gameDir, "components/cards.json"), "utf8"));
const catalog = loadCardDesign(gameDir);
assert(catalog, "card design manifest is missing");
const legacyPath = join(gameDir, catalog.legacy_source || "templates/layout.yaml");
const legacy = yaml.load(readFileSync(legacyPath, "utf8"));

function dig(card, path) {
  return String(path || "").replace(/^card\./, "").split(".").filter(Boolean)
    .reduce((value, key) => value == null ? undefined : value[key], card);
}
function visible(card, source) {
  if (!source) return true;
  const text = String(source).trim();
  const ors = text.split(/\s*\|\|\s*/); if (ors.length > 1) return ors.some(part => visible(card, part));
  const ands = text.split(/\s*&&\s*/); if (ands.length > 1) return ands.every(part => visible(card, part));
  const comparison = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(text);
  if (comparison) {
    const actual = String(dig(card, comparison[1].trim()) ?? "");
    const wanted = comparison[3].trim().replace(/^['"]|['"]$/g, "");
    return (actual === wanted) === (comparison[2] === "==");
  }
  const negated = text.startsWith("!"), path = negated ? text.slice(1).trim() : text;
  const value = dig(card, path), truthy = !(value == null || value === "" || value === false || (Array.isArray(value) && !value.length));
  return negated ? !truthy : truthy;
}

const counts = new Map(catalog.families.map(family => [family.id, 0]));
for (const card of cards) {
  const matches = catalog.families.filter(family => cardMatchesFamily(card, family.match));
  assert.equal(matches.length, 1, `${card.id} must resolve to exactly one family`);
  const family = matches[0]; counts.set(family.id, counts.get(family.id) + 1);
  const expected = legacy.regions.filter(region => visible(card, region.show_if));
  const actual = family.layout.regions.filter(region => visible(card, region.show_if));
  assert.deepEqual(actual, expected, `${card.id}/${family.id} changed its visible production layout`);
}
for (const family of catalog.families)
  assert(counts.get(family.id) > 0, `${family.id} has no real card exercising it`);

const motifFactions = [
  "anarch", "criminal", "shaper", "haas-bioroid", "jinteki", "nbn",
  "weyland-consortium", "neutral-corp", "neutral-runner",
];
for (const faction of motifFactions) {
  const motif = legacy.palette?.motifs?.[faction];
  assert.equal(typeof motif?.shell, "string", `${faction} needs a reusable shell motif`);
  assert.equal(typeof motif?.panel, "string", `${faction} needs a reusable panel motif`);
}
for (const family of catalog.families) {
  const regions = new Map(family.layout.regions.map(region => [region.id, region]));
  assert.equal(regions.get("shell_faction_motif")?.fill, "palette-shell-motif",
    `${family.id} must inherit the faction surface layer`);
  assert.equal(regions.get("shell_outer_keyline")?.stroke, "palette-dark",
    `${family.id} must inherit the outer material keyline`);
  assert.equal(regions.get("shell_inner_keyline")?.stroke, "palette-light",
    `${family.id} must inherit the inner material keyline`);
  assert.equal(regions.get("top_signal")?.fill, "palette-gradient",
    `${family.id} must use a dimensional top frame instead of a flat faction swatch`);
  assert.equal(regions.get("top_signal_faction_motif")?.fill, "palette-shell-motif",
    `${family.id} must carry its faction motif through the top frame`);
  assert.equal(regions.get("left_signal")?.fill, "palette-gradient",
    `${family.id} must use a dimensional left frame instead of a flat faction swatch`);
  assert.equal(regions.get("left_signal_faction_motif")?.fill, "palette-shell-motif",
    `${family.id} must carry its faction motif through the left frame`);
  const panelMotif = family.id === "ice" ? "ice_panel_faction_motif"
    : family.id.endsWith("identity") ? "identity_panel_faction_motif"
      : "standard_panel_faction_motif";
  assert.equal(regions.get(panelMotif)?.fill, "palette-panel-motif",
    `${family.id} must paint the faction motif inside its rules surface`);
}

for (const family of catalog.families.filter(family => !family.id.endsWith("identity") && family.id !== "ice")) {
  const regions = new Map(family.layout.regions.map(region => [region.id, region]));
  assert.equal(regions.get("footer")?.fill, "palette-gradient",
    `${family.id} must use a dimensional footer instead of a flat faction swatch`);
  assert.equal(regions.get("footer_faction_motif")?.fill, "palette-shell-motif",
    `${family.id} must carry its faction motif through the footer`);
  assert.equal(regions.get("footer_signal")?.fill, "palette-metallic",
    `${family.id} must retain the material seam above the footer`);

  const side = ["agenda", "asset", "operation", "upgrade"].includes(family.id) ? "corp" : "runner";
  const influence = regions.get(`${side}_influence`);
  const influenceRail = regions.get(`${side}_influence_rail`);
  assert.equal(influenceRail?.type, "rect", `${family.id} must use a physical influence rail`);
  assert.equal(influence?.type, "pips", `${family.id} influence must remain a semantic pips component`);
  assert.equal(influence?.count, 5, `${family.id} influence must expose the five printed sockets`);
  assert.equal(influence?.filled_src, "card.attributes.influence", `${family.id} influence count must remain data driven`);
  assert.equal(influence?.fill_from, "end", `${family.id} influence must fill from the bottom of its vertical rail`);
  assert.equal(influence?.shape, "circle", `${family.id} influence sockets must be renderer-native circles, not font glyphs`);
  assert(Number(influence?.pip_d_mm) >= 1.7, `${family.id} influence sockets must remain legible at print scale`);
  assert(!regions.has(`${side}_track`), `${family.id} must not regress to misaligned overlapping glyph tracks`);
}

const iceFrameRegions = new Map(catalog.families.find(family => family.id === "ice")?.layout.regions.map(region => [region.id, region]));
assert.equal(iceFrameRegions.get("ice_info_rail")?.fill, "palette-gradient",
  "ice must use a dimensional information rail instead of a flat faction swatch");
assert.equal(iceFrameRegions.get("ice_info_rail_faction_motif")?.fill, "palette-shell-motif",
  "ice must carry its faction motif through the information rail");

const runnerCreditDial = game.symbols?.find(symbol => symbol.key === "runner_credit_dial");
assert.equal(runnerCreditDial?.asset, "assets/layout-symbols/forge-runner-credit-dial.svg",
  "the runner cost instrument must be a version-controlled design asset");
assert(existsSync(join(gameDir, runnerCreditDial.asset)), "the runner cost instrument asset must resolve");
for (const familyId of ["event", "hardware", "operation", "program", "resource"]) {
  const family = catalog.families.find(candidate => candidate.id === familyId);
  const regions = new Map(family?.layout.regions.map(region => [region.id, region]));
  const hardware = regions.get("credit_dial_hardware");
  const number = regions.get("credit_dial_number");
  assert.equal(hardware?.type, "richtext", `${familyId} must use the shared vector cost hardware`);
  assert.equal(hardware?.text, "[runner_credit_dial]", `${familyId} must bind the runner cost asset`);
  assert.equal(hardware?.icon_only, true, `${familyId} cost hardware must fill its measured icon aperture`);
  assert.equal(number?.src, "card.attributes.cost", `${familyId} cost must remain data driven`);
  assert(family.layout.regions.indexOf(hardware) < family.layout.regions.indexOf(number),
    `${familyId} cost number must paint above the reusable hardware`);
  assert(!family.layout.regions.some(region => /^credit_tick_/.test(region.id)),
    `${familyId} must not regress to hand-positioned smile-shaped cost ticks`);
}

const programFamily = catalog.families.find(family => family.id === "program");
assert(programFamily, "program family is missing");
const programRegions = new Map(programFamily.layout.regions.map(region => [region.id, region]));
const strengthFace = programRegions.get("program_strength_face");
const programArtist = programRegions.get("program_footer_artist");
assert(strengthFace && programArtist, "program strength and footer credit regions must exist");
assert(
  Number(programArtist.x) >= Number(strengthFace.x) + Number(strengthFace.d) + 0.5,
  "program illustration credit must clear the strength instrument",
);

const runnerType = programRegions.get("standard_type");
const corpFamily = catalog.families.find(family => family.id === "agenda");
const corpType = corpFamily?.layout.regions.find(region => region.id === "corp_standard_type");
const corpIdentityFamily = catalog.families.find(family => family.id === "corp-identity");
const corpIdentityRegions = new Map(corpIdentityFamily?.layout.regions.map(region => [region.id, region]));
const identityFamily = catalog.families.find(family => family.id === "runner-identity");
const identityType = identityFamily?.layout.regions.find(region => region.id === "identity_type");
const identityRegions = new Map(identityFamily?.layout.regions.map(region => [region.id, region]));
const subtypeFont = programFamily.layout.fonts.find(font => font.id === "subtype");
for (const region of [runnerType, corpType, identityType]) {
  assert(region, "every production family needs its calibrated primary type label");
  assert.equal(region.font, "tech", `${region.id} must use the NSG primary-type face`);
  assert.equal(region.horizontal_scale, 0.78, `${region.id} must retain its calibrated horizontal scale`);
  assert(Number(region.size_pt) >= 7, `${region.id} must retain print-scale cap height`);
}
assert(Number(runnerType.x) < Number(corpType.x), "Runner and Corp type lines use different frame insets");
assert.equal(subtypeFont?.family, "Forge Lato", "mixed-case subtypes must use the NSG-era subtype face");
assert.equal(programRegions.get("program_subtypes")?.separator, " - ", "subtype lists must use the printed NSG separator");

const linkShadow = identityRegions.get("runner_link_shadow");
const linkFace = identityRegions.get("runner_link_face");
const linkNumber = identityRegions.get("runner_link_number");
const linkIcon = identityRegions.get("runner_link_icon");
for (const region of [linkShadow, linkFace]) {
  assert.equal(region?.type, "rect", "Runner base link must use the printed angular identity instrument");
  assert.match(region?.clip_path || "", /^polygon\(/, `${region?.id || "base-link plate"} must stay beveled`);
}
assert.equal(linkNumber?.type, "text", "Runner base-link value must not regress to a circular badge");
assert.equal(linkNumber?.src, "card.attributes.base_link", "Runner base-link value must remain data driven");
assert.equal(linkIcon?.text, "[link]", "Runner identity must retain the official link glyph");
assert(Number(linkIcon.x) > Number(linkNumber.x), "link glyph belongs above and to the right of the value");
assert(Number(linkIcon.x) + Number(linkIcon.w) <= Number(linkFace.x) + Number(linkFace.w), "link glyph must fit inside the instrument");
assert(Number(linkNumber.y) + Number(linkNumber.h) <= Number(linkFace.y) + Number(linkFace.h), "base-link number must fit inside the instrument");

const identityArt = identityRegions.get("identity_art_runner");
assert.deepEqual(identityArt?.source_crop, [0, 148, 744, 528], "Runner identity art must retain the complete official source aperture at print scale");
assert.equal(Number(identityArt?.x), 0, "Runner identity art must reach the left trim edge");
assert.equal(Number(identityArt?.w), 63, "Runner identity art must reach the right trim edge");
assert.equal(Number(identityArt.source_crop[0]), 0, "Runner identity art crop must include the source left edge");
assert.equal(Number(identityArt.source_crop[2]), Number(identityArt.source_size[0]), "Runner identity art crop must include the source right edge");
const artCropRatio = identityArt.source_crop[2] / identityArt.source_crop[3];
const artBoxRatio = Number(identityArt.w) / Number(identityArt.h);
assert(Math.abs(artCropRatio - artBoxRatio) < 0.002, "Runner identity art crop must preserve the full-width source composition without distortion");

const memoryEdge = identityRegions.get("runner_memory_edge");
const memoryFace = identityRegions.get("runner_memory_face");
const memoryValue = identityRegions.get("runner_memory");
assert.equal(memoryFace?.type, "rect", "Runner memory must have its own dark inner face");
assert(!String(memoryEdge?.fill).includes("palette"), "Runner memory bezel must stay neutral silver, not faction colored");
assert(!String(memoryFace?.fill).includes("palette"), "Runner memory face must stay neutral charcoal, not faction colored");
assert.equal(memoryValue?.color, "#ffffff", "Runner memory value must remain white on the dark face");
assert(Number(memoryEdge.w) < Number(linkFace.w), "memory instrument must remain compact beneath the link instrument");

const corpDeckShadow = corpIdentityRegions.get("corp_identity_stats_shadow");
const corpDeckBezel = corpIdentityRegions.get("corp_identity_deck_bezel");
const corpDeckFace = corpIdentityRegions.get("corp_identity_deck_face");
const corpDeckValue = corpIdentityRegions.get("corp_identity_deck");
const corpDeckAccentNe = corpIdentityRegions.get("corp_identity_deck_accent_ne");
const corpDeckAccentSw = corpIdentityRegions.get("corp_identity_deck_accent_sw");
const corpInfluenceShadow = corpIdentityRegions.get("corp_identity_influence_shadow");
const corpInfluenceBezel = corpIdentityRegions.get("corp_identity_influence_bezel");
const corpInfluenceFace = corpIdentityRegions.get("corp_identity_influence_face");
const corpInfluenceValue = corpIdentityRegions.get("corp_identity_influence");
const corpInfluenceAccentNw = corpIdentityRegions.get("corp_identity_influence_accent_nw");
const corpInfluenceAccentSe = corpIdentityRegions.get("corp_identity_influence_accent_se");
const corpIdentityArt = corpIdentityRegions.get("identity_art_corp");
const corpIdentityArtist = corpIdentityRegions.get("corp_identity_artist");
const corpIdentitySetIcon = corpIdentityRegions.get("corp_identity_set_icon");
const corpIdentityCollector = corpIdentityRegions.get("corp_identity_collector");
for (const region of [corpDeckShadow, corpDeckAccentNe, corpDeckAccentSw, corpDeckBezel, corpDeckFace,
  corpInfluenceShadow, corpInfluenceAccentNw, corpInfluenceAccentSe, corpInfluenceBezel, corpInfluenceFace])
  assert.equal(region?.type, "badge", `${region?.id || "Corp identity stat layer"} must remain circular`);
assert(!String(corpDeckBezel.bg).includes("palette"), "Corp deck bezel must stay neutral metallic");
assert(!String(corpDeckFace.bg).includes("palette"), "Corp deck face must stay neutral silver");
assert(!String(corpInfluenceFace.bg).includes("palette"), "Corp influence face must stay neutral charcoal");
for (const accent of [corpDeckAccentNe, corpDeckAccentSw, corpInfluenceAccentNw, corpInfluenceAccentSe]) {
  assert.equal(accent?.bg, "palette", `${accent?.id || "Corp identity accent"} must follow the faction colour`);
  assert.match(String(accent?.clip_path), /^polygon\(/, `${accent?.id || "Corp identity accent"} must be a segmented bracket`);
}
assert.equal(corpDeckValue?.horizontal_scale, 0.86, "Corp deck digits must fit the measured source box");
assert.equal(corpInfluenceValue?.horizontal_scale, 0.86, "Corp influence digits must fit the measured source box");
const deckCenter = Number(corpDeckShadow.x) + Number(corpDeckShadow.d) / 2;
const influenceCenter = Number(corpInfluenceShadow.x) + Number(corpInfluenceShadow.d) / 2;
assert(Math.abs(deckCenter + influenceCenter - 63) < 0.01, "Corp identity stats must mirror across the 63mm card");
assert(Number(corpDeckShadow.y) < Number(corpIdentityRegions.get("identity_panel").y),
  "Corp identity stats must project above the rules panel into the art aperture");
assert(Number(corpDeckShadow.y) + Number(corpDeckShadow.d) / 2 < Number(corpIdentityRegions.get("identity_type").y) + Number(corpIdentityRegions.get("identity_type").h) / 2,
  "Corp identity stat centres must sit above the identity type line, matching NSG shoulder placement");
assert.equal(corpIdentityArt?.credit, undefined, "Corp identity art must not carry an overlay credit beneath the influence dial");
assert.equal(corpIdentityArtist?.src, "printing.artist", "Corp identity illustrator credit must remain data driven");
assert.equal(corpIdentityArtist?.prefix, "ILLUS. ", "Corp identity illustrator credit must use the printed label");
assert(Number(corpIdentityArtist.x) < Number(corpIdentitySetIcon.x), "Corp identity illustrator belongs at the lower left");
assert.equal(corpIdentitySetIcon?.text, "[set_system_gateway]", "Corp identity footer must retain the set mark");
assert(Number(corpIdentitySetIcon.x) < Number(corpIdentityCollector.x), "Corp identity set mark must precede its collector number at lower right");
assert.equal(corpIdentityCollector?.transform, "strip-leading-zeros", "Corp identity collector numbers must match NSG's unpadded display");
assert(Number(corpIdentityCollector.x) + Number(corpIdentityCollector.w) <= Number(corpIdentityRegions.get("identity_panel").x) + Number(corpIdentityRegions.get("identity_panel").w),
  "Corp identity collector number must stay inside the rules panel");
assert.equal(identityRegions.get("identity_art_runner")?.credit, "printing.artist", "Runner identity keeps its source-family art credit");
assert.match(identityRegions.get("identity_set_icon")?.show_if || "", /side == runner/, "Runner identity keeps its centered set mark");

console.log(`card-design: ${cards.length} cards resolved across ${catalog.families.length} families; visible output matches ${catalog.legacy_source}`);
