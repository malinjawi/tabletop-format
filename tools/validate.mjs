#!/usr/bin/env node
/**
 * validate.mjs — reference validator for the format (v0.1)
 * Usage: node tools/validate.mjs <game-directory>
 *
 * Two passes:
 *   1. Schema validation (ajv, draft 2020-12) per document
 *   2. Referential integrity + typed-attribute checks across documents
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import yaml from "js-yaml";
import { CARD_DESIGN_MANIFEST, cardMatchesFamily } from "./lib/card-design.mjs";
import { DESIGN_ENGINES_MANIFEST, loadDesignEngines } from "./lib/design-engines.mjs";
import { RULEBOOK_PIPELINE_MANIFEST, loadRulebookPipeline } from "./lib/rulebook-pipeline.mjs";
import { RULEBOOK_PUBLICATIONS_MANIFEST, loadRulebookPublication } from "./lib/rulebook-publication.mjs";
import { SOURCE_ASSETS_MANIFEST, loadSourceAssets } from "./lib/source-assets.mjs";
import { ART_LIBRARY_MANIFEST, parseArtLibrary } from "./lib/art-library.mjs";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const PRINT_TARGETS = new Map(JSON.parse(readFileSync(join(SCHEMA_DIR, "..", "production", "print-targets.json"), "utf8"))
  .targets.map(target => [target.id, target]));
const gameDir = process.argv[2];
if (!gameDir) { console.error("Usage: node tools/validate.mjs <game-directory>"); process.exit(2); }

// The format intentionally permits scalar unions in free-form card attributes
// (string/number/boolean/null). Newer Ajv releases require this explicit flag
// even in JSON Schema 2020-12 strict mode.
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
for (const f of readdirSync(SCHEMA_DIR).filter(f => f.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")));
}
const validator = (name) => ajv.getSchema(`https://spec.example.dev/schemas/${name}.schema.json`)
  || ajv.getSchema(`https://forge.games/schemas/${name}.schema.json`);

const load = (rel) => {
  const p = join(gameDir, rel);
  if (!existsSync(p)) return undefined;
  const raw = readFileSync(p, "utf8");
  return rel.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
};
const loadDirOrFile = (dir, exts = [".yaml", ".yml", ".json"]) => {
  const p = join(gameDir, dir);
  if (!existsSync(p)) return [];
  return readdirSync(p)
    .filter(f => exts.some(e => f.endsWith(e)))
    .flatMap(f => {
      const doc = load(join(dir, f));
      return Array.isArray(doc) ? doc : [doc];
    });
};

let errors = 0, warnings = 0;
const err = (m) => { errors++; console.error(`  ERROR  ${m}`); };
const warn = (m) => { warnings++; console.warn(`  warn   ${m}`); };
const checkSchema = (name, doc, label) => {
  const v = validator(name);
  if (!v(doc)) for (const e of v.errors) err(`${label}: ${e.instancePath || "/"} ${e.message}`);
};

console.log(`Validating ${gameDir}\n`);

// ---- Pass 1: schemas ----
const game = load("game.yaml");
if (!game) { err("game.yaml missing"); process.exit(1); }
checkSchema("game", game, "game.yaml");

const cards = load("components/cards.json") ?? [];
cards.forEach((c, i) => checkSchema("card", c, `cards[${i}] (${c?.id ?? "?"})`));

const printings = load("components/printings.json") ?? [];
printings.forEach((p, i) => checkSchema("printing", p, `printings[${i}] (${p?.id ?? "?"})`));

const sets = loadDirOrFile("sets");
sets.forEach((s, i) => checkSchema("set", s, `sets[${i}] (${s?.id ?? "?"})`));

const formats = loadDirOrFile("formats");
formats.forEach((f, i) => checkSchema("format", f, `formats[${i}] (${f?.id ?? "?"})`));

const restrictions = loadDirOrFile("restrictions");
restrictions.forEach((r, i) => checkSchema("restriction", r, `restrictions[${i}] (${r?.id ?? "?"})`));

const rulings = load("rulings/rulings.json") ?? [];
rulings.forEach((r, i) => checkSchema("ruling", r, `rulings[${i}]`));

const decks = loadDirOrFile("decks");
decks.forEach((d, i) => checkSchema("deck", d, `decks[${i}] (${d?.id ?? "?"})`));

const setups = loadDirOrFile("setups");
setups.forEach((s, i) => checkSchema("setup", s, `setups[${i}] (${s?.id ?? "?"})`));

const tokens = load("components/tokens.json") ?? [];
tokens.forEach((t, i) => checkSchema("token", t, `tokens[${i}] (${t?.id ?? "?"})`));
const componentDesign = load("templates/component-design.json");
if (componentDesign != null) checkSchema("component-design", componentDesign, "templates/component-design.json");

const playtests = loadDirOrFile("playtests");
playtests.forEach((s, i) => checkSchema("playtest", s, `playtests[${i}] (${s?.id ?? "?"})`));

const community = load("community.yaml");
if (community != null) checkSchema("community", community, "community.yaml");
const layout = load("templates/layout.yaml");
if (layout != null) checkSchema("layout", layout, "templates/layout.yaml");
const printProfile = load("templates/print.yaml");
if (printProfile != null) checkSchema("print-profile", printProfile, "templates/print.yaml");
const cardDesignManifest = load(CARD_DESIGN_MANIFEST);
const designEnginesManifest = load(DESIGN_ENGINES_MANIFEST);
let cardDesign = null;
let designEngines = null;
const pnpinkAdapters = [];
if (designEnginesManifest != null)
  checkSchema("design-engines", designEnginesManifest, DESIGN_ENGINES_MANIFEST);
if (cardDesignManifest != null) {
  checkSchema("card-design", cardDesignManifest, CARD_DESIGN_MANIFEST);
}
if (cardDesignManifest != null || designEnginesManifest != null) {
  try {
    designEngines = loadDesignEngines(gameDir);
    cardDesign = designEngines?.card_design || null;
    for (const component of cardDesign.components)
      checkSchema("layout-fragment", load(component.source), component.source);
    for (const family of cardDesign.families) {
      checkSchema("layout-fragment", load(family.source), family.source);
      checkSchema("layout", family.layout, `compiled family ${family.id}`);
    }
    for (const engine of designEngines.engines.filter(candidate => candidate.type === "pnpink")) {
      const adapter = load(engine.source);
      checkSchema("pnpink-adapter", adapter, engine.source);
      pnpinkAdapters.push({ engine, adapter });
    }
  } catch (cause) { err(`${DESIGN_ENGINES_MANIFEST}: ${cause.message}`); }
}
const sourceOverlay = load("templates/source-overlay.yaml");
if (sourceOverlay != null) checkSchema("source-overlay", sourceOverlay, "templates/source-overlay.yaml");
const production = load("templates/production.json");
if (production != null) checkSchema("production", production, "templates/production.json");
const affinityBinding = load("templates/affinity/forge-affinity.json");
if (affinityBinding != null) checkSchema("affinity-binding", affinityBinding, "templates/affinity/forge-affinity.json");
const designBrief = load("design/brief.json");
if (designBrief != null) checkSchema("design-brief", designBrief, "design/brief.json");
const prototype = load("design/prototype.json");
if (prototype != null) checkSchema("prototype", prototype, "design/prototype.json");
const rulebookPipelineManifest = load(RULEBOOK_PIPELINE_MANIFEST);
let rulebookPipeline = null;
if (rulebookPipelineManifest != null) {
  checkSchema("rulebook-pipeline", rulebookPipelineManifest, RULEBOOK_PIPELINE_MANIFEST);
  try { rulebookPipeline = loadRulebookPipeline(gameDir); }
  catch (cause) { err(`${RULEBOOK_PIPELINE_MANIFEST}: ${cause.message}`); }
}
const rulebookPublicationsManifest = load(RULEBOOK_PUBLICATIONS_MANIFEST);
let rulebookPublication = null;
if (rulebookPublicationsManifest != null) {
  checkSchema("rulebook-publications", rulebookPublicationsManifest, RULEBOOK_PUBLICATIONS_MANIFEST);
  try {
    rulebookPublication = loadRulebookPublication(gameDir);
    checkSchema("rulebook-publication", rulebookPublication.document, rulebookPublication.source_path);
  } catch (cause) { err(`${RULEBOOK_PUBLICATIONS_MANIFEST}: ${cause.message}`); }
}
const rightsManifest = load("forge/rights.json");
if (rightsManifest != null) checkSchema("rights", rightsManifest, "forge/rights.json");
const sourceAssetsManifest = load(SOURCE_ASSETS_MANIFEST);
let sourceAssets = null;
if (sourceAssetsManifest != null) {
  checkSchema("source-assets", sourceAssetsManifest, SOURCE_ASSETS_MANIFEST);
  try { sourceAssets = loadSourceAssets(gameDir); }
  catch (cause) { err(`${SOURCE_ASSETS_MANIFEST}: ${cause.message}`); }
}
const artLibraryManifest = load(ART_LIBRARY_MANIFEST);
let artLibrary = null;
if (artLibraryManifest != null) {
  checkSchema("art-library", artLibraryManifest, ART_LIBRARY_MANIFEST);
  try { artLibrary = parseArtLibrary(Buffer.from(JSON.stringify(artLibraryManifest))); }
  catch (cause) { err(cause.message); }
}

// ---- Pass 2: referential integrity ----
const dupes = (arr, label) => {
  const seen = new Set();
  for (const x of arr) {
    if (seen.has(x.id)) err(`duplicate ${label} id '${x.id}'`);
    seen.add(x.id);
  }
};
dupes(cards, "card"); dupes(printings, "printing"); dupes(sets, "set");
dupes(formats, "format"); dupes(restrictions, "restriction"); dupes(setups, "setup"); dupes(tokens, "piece");

const validateLayoutTypography = (candidate, label) => {
  if (!candidate) return;
  const styles = candidate.text_styles || {}, styleIds = new Set(Object.keys(styles));
  const fontIds = new Set((candidate.fonts || []).map(font => font.id));
  for (const [id, style] of Object.entries(styles)) {
    for (const key of ["font", "secondary_font"])
      if (style[key] && !fontIds.has(style[key])) err(`${label}: text style '${id}' references missing font '${style[key]}'`);
  }
  const regions = [...(candidate.regions || []), ...(candidate.back?.regions || [])];
  for (const region of regions) {
    if (region.text_style && !styleIds.has(region.text_style))
      err(`${label}: region '${region.id}' references missing text style '${region.text_style}'`);
    if (region.text_style && !["text", "richtext", "body", "badge", "pips"].includes(region.type))
      err(`${label}: region '${region.id}' cannot apply text style '${region.text_style}' to ${region.type}`);
    if (region.font && !fontIds.has(region.font)) err(`${label}: region '${region.id}' references missing font '${region.font}'`);
    if (region.secondary_font && !fontIds.has(region.secondary_font)) err(`${label}: region '${region.id}' references missing font '${region.secondary_font}'`);
  }
};
validateLayoutTypography(layout, "templates/layout.yaml");

for (const piece of tokens.filter(candidate => candidate.kind === "dial")) {
  const start = Number(piece.attributes?.start_value ?? 0), max = Number(piece.attributes?.max_value ?? 10);
  const step = Number(piece.attributes?.step ?? 1), intervals = (max - start) / step;
  const count = Math.round(intervals) + 1;
  if (![start, max, step].every(Number.isFinite) || step <= 0 || max < start || count < 2)
    err(`piece '${piece.id}' dial scale needs a finite start, a larger maximum, and a positive step`);
  else if (Math.abs(intervals - Math.round(intervals)) > 1e-7)
    err(`piece '${piece.id}' dial maximum must land exactly on its step interval`);
  else if (count > 36)
    err(`piece '${piece.id}' dial scale has ${count} positions; Forge supports at most 36 legible positions`);
}

if (componentDesign) {
  dupes(componentDesign.families || [], "component design family");
  const playerCount = componentDesign.production?.player_count;
  if (playerCount != null && game.players?.min != null && playerCount < game.players.min)
    err(`component production player_count ${playerCount} is below the game's minimum of ${game.players.min}`);
  if (playerCount != null && game.players?.max != null && playerCount > game.players.max)
    err(`component production player_count ${playerCount} is above the game's maximum of ${game.players.max}`);
  const familyIds = new Set((componentDesign.families || []).map(family => family.id));
  for (const token of tokens) {
    if (token.template_id && !familyIds.has(token.template_id))
      err(`piece '${token.id}' references missing component design family '${token.template_id}'`);
    if (token.back?.template_id && !familyIds.has(token.back.template_id))
      err(`piece '${token.id}' back references missing component design family '${token.back.template_id}'`);
    if (token.back) {
      const familyFor = templateId => (componentDesign.families || []).find(family => family.id === templateId)
        || (componentDesign.families || []).find(family => family.match?.template_ids?.includes(templateId))
        || (componentDesign.families || []).find(family => (family.match?.kinds || []).includes(token.kind))
        || (componentDesign.families || []).find(family => family.id === "generic-piece") || componentDesign.families?.[0];
      const front = familyFor(token.template_id), back = familyFor(token.back.template_id || token.template_id);
      const frontSize = [token.size_mm?.width || front?.size_mm?.width, token.size_mm?.height || front?.size_mm?.height];
      const backSize = [token.size_mm?.width || back?.size_mm?.width, token.size_mm?.height || back?.size_mm?.height];
      if (frontSize[0] !== backSize[0] || frontSize[1] !== backSize[1])
        err(`piece '${token.id}' front/back families must resolve to the same finished size`);
    }
    const family = (componentDesign.families || []).find(candidate => candidate.id === token.template_id)
      || (componentDesign.families || []).find(candidate => candidate.match?.template_ids?.includes(token.template_id))
      || (componentDesign.families || []).find(candidate => (candidate.match?.kinds || []).includes(token.kind))
      || (componentDesign.families || []).find(candidate => candidate.id === "generic-piece") || componentDesign.families?.[0];
    if (family) {
      const width = Number(token.size_mm?.width || family.size_mm?.width), height = Number(token.size_mm?.height || family.size_mm?.height);
      const safe = Number(componentDesign.production?.safe_mm || 0);
      if (safe * 2 >= width || safe * 2 >= height)
        err(`piece '${token.id}' safe inset ${safe} mm leaves no usable content area inside ${width} × ${height} mm`);
      const unsafe = (family.regions || []).filter(region => region.type !== "image").filter(region => {
        const left = width * region.x / 100, top = height * region.y / 100;
        const right = width - width * (region.x + region.w) / 100, bottom = height - height * (region.y + region.h) / 100;
        return Math.min(left, top, right, bottom) + 1e-7 < safe;
      });
      if (unsafe.length) warn(`piece '${token.id}': ${unsafe.map(region => region.id).join(", ")} region${unsafe.length === 1 ? " is" : "s are"} outside the ${safe} mm safe inset`);
    }
  }
}

const cardIds = new Set(cards.map(c => c.id));
const printingById = new Map(printings.map(printing => [printing.id, printing]));
for (const id of printProfile?.selection?.card_ids || [])
  if (!cardIds.has(id)) err(`templates/print.yaml selects missing card '${id}'`);
const exactPrintingQuantities = printProfile?.selection?.printing_quantities || {};
if (Object.keys(exactPrintingQuantities).length) {
  const representedCards = new Set();
  for (const id of Object.keys(exactPrintingQuantities)) {
    const printing = printingById.get(id);
    if (!printing) err(`templates/print.yaml selects missing printing '${id}'`);
    else representedCards.add(printing.card_id);
  }
  const selectedCards = new Set(printProfile.selection.card_ids || []);
  const mismatch = [...new Set([...representedCards, ...selectedCards])]
    .filter(id => representedCards.has(id) !== selectedCards.has(id));
  if (mismatch.length) err(`templates/print.yaml exact printing quantities do not match card_ids: ${mismatch.join(", ")}`);
}
const printTarget = PRINT_TARGETS.get(printProfile?.press?.target || "generic-srgb");
if (printProfile?.press?.target && !printTarget) err(`templates/print.yaml selects unknown print target '${printProfile.press.target}'`);
const printDieline = printProfile?.press?.dieline;
if (printDieline?.enabled) {
  const declared = cardDesign?.families?.[0]?.layout?.card || layout?.card || production?.card || sourceOverlay?.card || {};
  const bleed = Number(declared.bleed_mm ?? 3.175);
  if (Number(printDieline.offset_mm) > bleed)
    err(`spot dieline offset ${printDieline.offset_mm} mm exceeds the card system's ${bleed} mm bleed`);
}
if (printTarget?.requirements?.trim_mm) {
  const expected = printTarget.requirements.trim_mm, fallback = layout?.card || production?.card || sourceOverlay?.card || null;
  const selectedCardIds = new Set(printProfile?.selection?.card_ids || []);
  const selectedPrintingIds = new Set(Object.keys(exactPrintingQuantities));
  const targetPrintings = selectedPrintingIds.size ? printings.filter(printing => selectedPrintingIds.has(printing.id))
    : selectedCardIds.size ? printings.filter(printing => selectedCardIds.has(printing.card_id)) : printings;
  for (const printing of targetPrintings) {
    const card = cards.find(candidate => candidate.id === printing.card_id);
    const family = cardDesign?.families?.find(candidate => card && cardMatchesFamily(card, candidate.match || {}));
    const declared = printing.physical_size_mm || family?.layout?.card || fallback;
    const actual = [Number(declared?.width || declared?.w_mm), Number(declared?.height || declared?.h_mm)];
    if (!actual.every(Number.isFinite)) err(`print target '${printTarget.id}' cannot resolve the trim size for '${printing.id}'`);
    else if (actual.some((value, index) => Math.abs(value - expected[index]) > .01))
      err(`print target '${printTarget.id}' requires ${expected[0]} × ${expected[1]} mm trim; '${printing.id}' resolves to ${actual[0]} × ${actual[1]} mm`);
  }
}
if (designEngines) {
  const active = designEngines.engines.find(engine => engine.id === designEngines.active);
  if (active?.status !== "active") err(`${DESIGN_ENGINES_MANIFEST}: selected engine '${designEngines.active}' must have status active`);
  const activeStatuses = designEngines.engines.filter(engine => engine.status === "active");
  if (activeStatuses.length !== 1) err(`${DESIGN_ENGINES_MANIFEST}: exactly one engine must have status active`);
}
if (rulebookPipeline) {
  for (const rel of rulebookPipeline.overlay_files) {
    const allowed = rel.endsWith("/config.yaml")
      || rel.includes("/data/input/") || rel.includes("/data/changelogs/")
      || rel.includes("/data/images/") || rel.includes("/data/templates/");
    if (!allowed) err(`${RULEBOOK_PIPELINE_MANIFEST}: unsupported native overlay '${rel}'`);
  }
}
if (rulebookPublication) {
  const document = rulebookPublication.document;
  const setupIds = new Set(setups.map(setup => setup.id));
  const usedCards = new Set(document.dependencies?.cards || []);
  const usedAssets = new Set(document.dependencies?.assets || []);
  for (const page of document.pages || []) for (const block of page.blocks || []) {
    if (block.card_id) usedCards.add(block.card_id);
    for (const id of block.card_ids || []) usedCards.add(id);
    for (const placement of block.placements || []) if (placement.card_id) usedCards.add(placement.card_id);
    if (block.asset) usedAssets.add(block.asset);
  }
  for (const id of usedCards)
    if (!cardIds.has(id)) err(`${rulebookPublication.source_path}: card '${id}' not found`);
  for (const id of document.dependencies?.setups || [])
    if (!setupIds.has(id)) err(`${rulebookPublication.source_path}: setup '${id}' not found`);
  for (const asset of [...usedAssets, ...(document.dependencies?.fonts || [])])
    if (!existsSync(join(gameDir, asset))) err(`${rulebookPublication.source_path}: linked file '${asset}' not found`);
}
if (sourceAssets) {
  for (const pack of sourceAssets.packages)
    for (const issue of pack.issues) err(`${SOURCE_ASSETS_MANIFEST} package '${pack.id}': ${issue}`);
}
if (cardDesign) {
  const familyIds = new Set(cardDesign.families.map(family => family.id));
  for (const component of cardDesign.components) if (component.applies_to !== "*")
    for (const familyId of component.applies_to || [])
      if (!familyIds.has(familyId)) err(`${CARD_DESIGN_MANIFEST}: component '${component.id}' references unknown family '${familyId}'`);
  const order = new Set(cardDesign.region_order || []);
  for (const family of cardDesign.families) {
    validateLayoutTypography(family.layout, `compiled family '${family.id}'`);
    const ids = family.layout.regions.map(region => region.id);
    if (ids.length !== new Set(ids).size) err(`compiled family '${family.id}' has duplicate region ids`);
    for (const id of ids) if (!order.has(id)) err(`compiled family '${family.id}' region '${id}' is absent from region_order`);
    for (const specimen of family.specimens || [])
      if (!cardIds.has(specimen)) err(`card design family '${family.id}' references missing specimen '${specimen}'`);
  }
  for (const card of cards) {
    const matched = cardDesign.families.filter(family => cardMatchesFamily(card, family.match)).map(family => family.id);
    if (matched.length !== 1) err(`card design must match '${card.id}' exactly once; matched ${matched.length ? matched.join(", ") : "none"}`);
  }
}
for (const { engine, adapter } of pnpinkAdapters) {
  const declared = new Set(engine.families || []);
  const adapted = new Set((adapter.families || []).map(family => family.id));
  if (declared.size !== adapted.size || [...declared].some(id => !adapted.has(id)))
    err(`${engine.source}: family list must match engine '${engine.id}'`);
  const designRoot = resolve(gameDir, "templates/card-design");
  const templatePath = resolve(gameDir, adapter.template || "");
  const templateRel = relative(designRoot, templatePath);
  if (isAbsolute(adapter.template || "") || templateRel === ".." || templateRel.startsWith(`..${sep}`) || isAbsolute(templateRel)) {
    err(`${engine.source}: template escapes templates/card-design/: ${adapter.template}`);
    continue;
  }
  if (!existsSync(templatePath)) {
    err(`${engine.source}: template does not exist: ${adapter.template}`);
    continue;
  }
  const svg = readFileSync(templatePath, "utf8");
  const ids = new Set([...svg.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
  for (const family of adapter.families || []) {
    if (!cardIds.has(family.specimen)) err(`${engine.source}: missing specimen '${family.specimen}'`);
    if (!ids.has(family.bbox)) err(`${adapter.template}: missing bbox id '${family.bbox}'`);
    for (const target of Object.values(family.fields || {}))
      if (!ids.has(target)) err(`${adapter.template}: missing field id '${target}'`);
  }
}
const sourceGet = (obj, path) => String(path ?? "").split(".").filter(Boolean)
  .reduce((value, key) => value == null ? undefined : value[key], obj);
const sourceDelete = (obj, path) => {
  const keys = String(path ?? "").split(".").filter(Boolean); let parent = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!parent || typeof parent !== "object") return;
    parent = parent[keys[i]];
  }
  if (parent && typeof parent === "object") delete parent[keys.at(-1)];
};
const sourceStable = value => {
  if (Array.isArray(value)) return value.map(sourceStable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, sourceStable(value[key])]),
  );
  return value;
};
const sourceMatches = (card, match) => Object.entries(match ?? {}).every(([path, wanted]) => {
  const got = sourceGet(card, path), choices = Array.isArray(wanted) ? wanted : [wanted];
  return choices.some(choice => JSON.stringify(choice ?? null) === JSON.stringify(got ?? null));
});
const sourceSignature = (card, regions, nonvisualFields = []) => {
  const copy = structuredClone(card);
  for (const path of nonvisualFields) sourceDelete(copy, path);
  for (const region of regions)
    if ((region.source ?? "card") === "card") sourceDelete(copy, region.src);
  return sourceHash(copy);
};
const sourceHash = value => {
  const text = JSON.stringify(sourceStable(value)); let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
};
const sourcePrintingSignature = (printing, regions) => {
  const copy = {
    set_id: printing?.set_id ?? null,
    collector_number: printing?.collector_number ?? null,
    artist: printing?.artist ?? null,
    flavor_text: printing?.flavor_text ?? null,
    variant: printing?.variant ?? null,
  };
  for (const region of regions)
    if ((region.source ?? "card") === "printing") sourceDelete(copy, region.src);
  return sourceHash(copy);
};
const setIds = new Set(sets.map(s => s.id));
const restrictionIds = new Set(restrictions.map(r => r.id));

for (const p of printings) {
  if (!cardIds.has(p.card_id)) err(`printing '${p.id}': card_id '${p.card_id}' not found in cards.json`);
  if (!setIds.has(p.set_id)) err(`printing '${p.id}': set_id '${p.set_id}' not found in sets`);
}
for (const f of formats) {
  for (const s of f.card_pool) if (!setIds.has(s)) err(`format '${f.id}': card_pool set '${s}' not found`);
  if (f.active_restriction_id && !restrictionIds.has(f.active_restriction_id))
    err(`format '${f.id}': active_restriction_id '${f.active_restriction_id}' not found`);
}
for (const r of restrictions) {
  for (const c of [...(r.banned ?? []), ...(r.restricted ?? [])])
    if (!cardIds.has(c)) err(`restriction '${r.id}': card '${c}' not found`);
}
for (const [i, r] of rulings.entries()) {
  if (!cardIds.has(r.card_id)) err(`ruling[${i}]: card '${r.card_id}' not found`);
}
const formatIds = new Set(formats.map(f => f.id));
for (const d of decks) {
  for (const cid of Object.keys(d.cards ?? {}))
    if (!cardIds.has(cid)) err(`deck '${d.id}': card '${cid}' not found`);
  if (d.format_id && !formatIds.has(d.format_id)) err(`deck '${d.id}': format '${d.format_id}' not found`);
  if (d.printings) {
    const represented = new Map();
    for (const [pid, quantity] of Object.entries(d.printings)) {
      const printing = printingById.get(pid);
      if (!printing) { err(`deck '${d.id}': printing '${pid}' not found`); continue; }
      represented.set(printing.card_id, (represented.get(printing.card_id) ?? 0) + quantity);
    }
    for (const cid of new Set([...Object.keys(d.cards ?? {}), ...represented.keys()]))
      if ((d.cards?.[cid] ?? 0) !== (represented.get(cid) ?? 0))
        err(`deck '${d.id}': printing counts for '${cid}' do not equal its card count`);
  }
}

// Typed attributes vs game.yaml attribute_definitions
const defs = new Map((game.attribute_definitions ?? []).map(d => [d.key, d]));
for (const c of cards) {
  for (const [k, v] of Object.entries(c.attributes ?? {})) {
    const d = defs.get(k);
    if (!d) { warn(`card '${c.id}': attribute '${k}' not declared in game.yaml`); continue; }
    const t = d.type === "integer" ? Number.isInteger(v) : typeof v === d.type;
    if (!t) err(`card '${c.id}': attribute '${k}' should be ${d.type}, got ${typeof v} (${JSON.stringify(v)})`);
    else if (d.choices?.length && !d.choices.some(choice => JSON.stringify(choice) === JSON.stringify(v)))
      err(`card '${c.id}': attribute '${k}' must be one of ${JSON.stringify(d.choices)}, got ${JSON.stringify(v)}`);
  }
  for (const d of defs.values())
    if (d.required && !(d.key in (c.attributes ?? {}))) err(`card '${c.id}': missing required attribute '${d.key}'`);
}

// Symbol tags in card text must be declared
const declaredSymbols = new Set((game.symbols ?? []).map(s => s.key));
for (const c of cards) {
  for (const m of (c.text ?? "").matchAll(/\[([a-z0-9_]+)\]/g))
    if (!declaredSymbols.has(m[1])) warn(`card '${c.id}': text uses undeclared symbol [${m[1]}]`);
}
dupes(tokens, "token");
for (const t of tokens) {
  if (t.symbol && !declaredSymbols.has(t.symbol)) err(`token '${t.id}': symbol '${t.symbol}' not declared in game.yaml`);
  if (t.back?.symbol && !declaredSymbols.has(t.back.symbol)) err(`token '${t.id}' back: symbol '${t.back.symbol}' not declared in game.yaml`);
  if (t.art && !existsSync(join(gameDir, t.art))) warn(`token '${t.id}': art asset '${t.art}' not found`);
  if (t.back?.art && !existsSync(join(gameDir, t.back.art))) warn(`token '${t.id}' back: art asset '${t.back.art}' not found`);
}
// asset paths must resolve (SPEC §7: no dangling references)
for (const s of game.symbols ?? [])
  if (s.asset && !existsSync(join(gameDir, s.asset))) warn(`symbol '${s.key}': asset '${s.asset}' not found`);
for (const p of printings)
  for (const key of ["art", "back", "scan"])
    if (p[key] && !existsSync(join(gameDir, p[key]))) warn(`printing '${p.id}': ${key} asset '${p[key]}' not found`);
const cardBackArt = new Set([layout?.back?.art,
  ...(cardDesign?.families || []).map(family => family.layout?.back?.art)].filter(Boolean));
for (const asset of cardBackArt)
  if (!existsSync(join(gameDir, asset))) warn(`shared card back: art asset '${asset}' not found`);
if (artLibrary) {
  const seen = new Set();
  for (const record of artLibrary.assets) {
    if (seen.has(record.path)) err(`${ART_LIBRARY_MANIFEST}: duplicate artwork path '${record.path}'`);
    seen.add(record.path);
    if (record.path.includes("..") || record.path.includes("//")) err(`${ART_LIBRARY_MANIFEST}: unsafe artwork path '${record.path}'`);
    if (!existsSync(join(gameDir, record.path))) err(`${ART_LIBRARY_MANIFEST}: artwork '${record.path}' does not exist`);
    if (!/\.(?:png|jpe?g|webp|svg)$/i.test(record.path)) err(`${ART_LIBRARY_MANIFEST}: '${record.path}' is not a supported image`);
  }
}
if (sourceOverlay) {
  let pinnedSource = null;
  if (sourceOverlay.baseline_data) {
    const pinnedPath = join(gameDir, sourceOverlay.baseline_data);
    if (!existsSync(pinnedPath)) err(`source overlay baseline data '${sourceOverlay.baseline_data}' not found`);
    else {
      pinnedSource = JSON.parse(readFileSync(pinnedPath, "utf8"));
      if (sourceOverlay.source_ref && pinnedSource.source_ref !== sourceOverlay.source_ref)
        err(`source overlay source_ref does not match '${sourceOverlay.baseline_data}'`);
    }
  }
  const printingCards = new Set(printings.filter(p => p.scan).map(p => p.card_id));
  for (const cid of Object.keys(sourceOverlay.baselines ?? {}))
    if (!cardIds.has(cid)) err(`source overlay baseline '${cid}': card not found`);
  for (const cid of printingCards)
    if (!(cid in (sourceOverlay.baselines ?? {}))) err(`source overlay: scan-backed card '${cid}' has no immutable baseline`);
  for (const region of sourceOverlay.regions ?? []) {
    const exactStrategies = [region.samples, region.patches].filter(Boolean).length;
    if (exactStrategies > 1 || !(exactStrategies || region.render))
      err(`source overlay region '${region.id}': declare samples or patches, optionally with render fallback, or render alone`);
  }
  for (const region of sourceOverlay.regions ?? [])
    for (const [value, cid] of Object.entries(region.samples ?? {})) {
      if (!cardIds.has(cid)) err(`source overlay region '${region.id}' sample '${value}': card '${cid}' not found`);
      if (!printingCards.has(cid)) err(`source overlay region '${region.id}' sample '${value}': card '${cid}' has no source scan`);
    }
  for (const region of sourceOverlay.regions ?? [])
    for (const [value, asset] of Object.entries(region.patches ?? {}))
      if (!/^(?:data:|https?:|file:)/i.test(asset) && !existsSync(join(gameDir, asset)))
        err(`source overlay region '${region.id}' patch '${value}': asset '${asset}' not found`);
  for (const region of sourceOverlay.regions ?? []) {
    for (const [label, asset] of [["font", region.render?.font_asset], ["background", region.render?.background_asset]]) {
      if (asset && !/^(?:data:|https?:|file:)/i.test(asset) && !existsSync(join(gameDir, asset)))
        err(`source overlay region '${region.id}' ${label} asset '${asset}' not found`);
    }
  }
  for (const card of cards) {
    const baseline = sourceOverlay.baselines?.[card.id];
    if (!baseline) continue;
    const printing = printings.find(item => item.card_id === card.id) ?? {};
    const baselineCard = pinnedSource?.cards?.[card.id] ?? card;
    const baselinePrinting = pinnedSource?.printings?.[printing.id] ?? printing;
    const regions = (sourceOverlay.regions ?? []).filter(region => sourceMatches(baselineCard, region.match));
    const signature = sourceSignature(baselineCard, regions, sourceOverlay.nonvisual_card_fields ?? []);
    if (signature !== baseline.signature)
      err(`source overlay baseline '${card.id}': signature is stale (expected ${signature})`);
    const printingSignature = sourcePrintingSignature(baselinePrinting, regions);
    if (printingSignature !== baseline.printing_signature)
      err(`source overlay baseline '${card.id}': printing signature is stale (expected ${printingSignature})`);
    for (const region of regions) {
      const printingSource = (region.source ?? "card") === "printing";
      const key = printingSource ? `printing.${region.src}` : region.src;
      if (!(key in (baseline.values ?? {}))) {
        err(`source overlay baseline '${card.id}': value '${key}' is missing`);
        continue;
      }
      // A mapped value is allowed to diverge from the immutable baseline:
      // that is the edit the overlay exists to render. When a pinned semantic
      // snapshot is present, compare baseline metadata to that snapshot rather
      // than to the mutable working card.
      if (pinnedSource) {
        const expected = sourceGet(printingSource ? baselinePrinting : baselineCard, region.src) ?? null;
        const actual = baseline.values?.[key] ?? null;
        if (JSON.stringify(expected) !== JSON.stringify(actual))
          err(`source overlay baseline '${card.id}': value '${key}' is stale`);
      }
    }
  }
}
if (production) {
  const templateIds = new Set();
  for (const template of production.templates ?? []) {
    if (templateIds.has(template.id)) err(`production template '${template.id}': duplicate id`);
    templateIds.add(template.id);
    if (!existsSync(join(gameDir, template.template))) err(`production template '${template.id}': SVG '${template.template}' not found`);
    for (const resource of template.resources ?? [])
      if (!existsSync(join(gameDir, resource))) err(`production template '${template.id}': resource '${resource}' not found`);
    const layers = new Set();
    for (const binding of template.bindings ?? []) {
      const layer = binding.layer.toLowerCase();
      if (layers.has(layer)) err(`production template '${template.id}': duplicate layer '${binding.layer}'`);
      layers.add(layer);
    }
    for (const [cid, baseline] of Object.entries(template.baselines ?? {})) {
      const card = cards.find(item => item.id === cid);
      if (!card) { err(`production template '${template.id}': baseline card '${cid}' not found`); continue; }
      if (!sourceMatches(card, template.match)) err(`production template '${template.id}': baseline card '${cid}' does not match its template selector`);
      const bindings = (template.bindings ?? []).filter(binding => (binding.source ?? "card") === "card");
      const signature = sourceSignature(card, bindings.map(binding => ({ src: binding.field })));
      if (signature !== baseline.signature)
        err(`production template '${template.id}' baseline '${cid}': signature is stale (expected ${signature})`);
      for (const binding of bindings) {
        const expected = sourceGet(card, binding.field) ?? null;
        const actual = baseline.values?.[binding.field] ?? null;
        if (JSON.stringify(expected) !== JSON.stringify(actual))
          err(`production template '${template.id}' baseline '${cid}': value '${binding.field}' is stale`);
      }
    }
  }
}
const deckIds = new Set(decks.map(d => d.id));
const deckById = new Map(decks.map(d => [d.id, d]));
for (const s of setups) {
  const seatIds = new Set(), zoneIds = new Set(), itemIds = new Set();
  for (const seat of s.seats ?? []) {
    if (seatIds.has(seat.id)) err(`setup '${s.id}': duplicate seat id '${seat.id}'`);
    seatIds.add(seat.id);
  }
  for (const zone of s.zones ?? []) {
    if (zoneIds.has(zone.id)) err(`setup '${s.id}': duplicate zone id '${zone.id}'`);
    zoneIds.add(zone.id);
    if (zone.seat_id && !seatIds.has(zone.seat_id))
      err(`setup '${s.id}': zone '${zone.id}' references unknown seat '${zone.seat_id}'`);
    if (zone.visibility === "seat" && !zone.seat_id)
      err(`setup '${s.id}': private zone '${zone.id}' needs seat_id`);
  }
  const stackedDecks = new Set();
  for (const stack of s.stacks ?? []) {
    if (itemIds.has(stack.id)) err(`setup '${s.id}': duplicate setup item id '${stack.id}'`);
    itemIds.add(stack.id);
    if (!deckIds.has(stack.deck_id)) err(`setup '${s.id}': stack '${stack.id}' references unknown deck '${stack.deck_id}'`);
    if (!zoneIds.has(stack.zone_id)) err(`setup '${s.id}': stack '${stack.id}' references unknown zone '${stack.zone_id}'`);
    if (stackedDecks.has(stack.deck_id)) err(`setup '${s.id}': deck '${stack.deck_id}' is used by more than one stack`);
    stackedDecks.add(stack.deck_id);
  }
  const placedCounts = new Map();
  for (const placement of s.placements ?? []) {
    if (itemIds.has(placement.id)) err(`setup '${s.id}': duplicate setup item id '${placement.id}'`);
    itemIds.add(placement.id);
    const deck = deckById.get(placement.deck_id);
    if (!deck) err(`setup '${s.id}': placement '${placement.id}' references unknown deck '${placement.deck_id}'`);
    if (!cardIds.has(placement.card_id)) err(`setup '${s.id}': placement '${placement.id}' references unknown card '${placement.card_id}'`);
    if (!zoneIds.has(placement.zone_id)) err(`setup '${s.id}': placement '${placement.id}' references unknown zone '${placement.zone_id}'`);
    const key = `${placement.deck_id}\0${placement.card_id}`;
    placedCounts.set(key, (placedCounts.get(key) ?? 0) + (placement.quantity ?? 1));
    if (deck && !(placement.card_id in (deck.cards ?? {})))
      err(`setup '${s.id}': placement '${placement.id}' card '${placement.card_id}' is not in deck '${placement.deck_id}'`);
  }
  for (const [key, count] of placedCounts) {
    const [did, cid] = key.split("\0"), available = deckById.get(did)?.cards?.[cid] ?? 0;
    if (count > available) err(`setup '${s.id}': places ${count}x '${cid}' from deck '${did}', but it only contains ${available}`);
  }
  const placedPieceCounts = new Map(), pieceById = new Map(tokens.map(piece => [piece.id, piece]));
  for (const placement of s.pieces ?? []) {
    if (itemIds.has(placement.id)) err(`setup '${s.id}': duplicate setup item id '${placement.id}'`);
    itemIds.add(placement.id);
    const piece = pieceById.get(placement.component_id);
    if (!piece) err(`setup '${s.id}': piece placement '${placement.id}' references unknown component '${placement.component_id}'`);
    if (placement.zone_id && !zoneIds.has(placement.zone_id))
      err(`setup '${s.id}': piece placement '${placement.id}' references unknown zone '${placement.zone_id}'`);
    if (placement.seat_id && !seatIds.has(placement.seat_id))
      err(`setup '${s.id}': piece placement '${placement.id}' references unknown seat '${placement.seat_id}'`);
    if (placement.position.x < 0 || placement.position.x > s.board.width || placement.position.y < 0 || placement.position.y > s.board.height)
      err(`setup '${s.id}': piece placement '${placement.id}' is outside the board`);
    if (placement.face === "back" && piece && !piece.back)
      err(`setup '${s.id}': piece placement '${placement.id}' requests a back face that '${piece.id}' does not declare`);
    placedPieceCounts.set(placement.component_id, (placedPieceCounts.get(placement.component_id) ?? 0) + (placement.quantity ?? 1));
  }
  for (const [id, count] of placedPieceCounts) {
    const piece = pieceById.get(id); if (!piece) continue;
    const players = componentDesign?.production?.player_count;
    const available = (piece.quantity ?? 1) * (piece.per_player && players ? players : 1);
    if (count > available) err(`setup '${s.id}': places ${count}x component '${id}', but the production kit contains ${available}`);
  }
  for (const counter of s.counters ?? []) {
    if (itemIds.has(counter.id)) err(`setup '${s.id}': duplicate setup item id '${counter.id}'`);
    itemIds.add(counter.id);
    if (counter.seat_id && !seatIds.has(counter.seat_id))
      err(`setup '${s.id}': counter '${counter.id}' references unknown seat '${counter.seat_id}'`);
    if (counter.minimum != null && counter.initial < counter.minimum)
      err(`setup '${s.id}': counter '${counter.id}' starts below its minimum`);
    if (counter.maximum != null && counter.initial > counter.maximum)
      err(`setup '${s.id}': counter '${counter.id}' starts above its maximum`);
  }
}
for (const s of playtests) {
  for (const n of s.card_notes ?? [])
    if (!cardIds.has(n.card_id)) warn(`playtest '${s.id}': card_note '${n.card_id}' is not in the current snapshot; verify it against pinned version '${s.version_ref}'`);
  for (const d of s.decisions ?? [])
    if (d.card_id && !cardIds.has(d.card_id)) warn(`playtest '${s.id}': decision card '${d.card_id}' is not in the current snapshot; verify it against pinned version '${s.version_ref}'`);
  for (const p of s.players ?? [])
    if (p.deck_id && !deckIds.has(p.deck_id)) warn(`playtest '${s.id}': player deck '${p.deck_id}' not found in decks/`);
}

// Set size vs actual printings
for (const s of sets) {
  if (s.size != null) {
    const actual = printings.filter(p => p.set_id === s.id).length;
    if (actual !== s.size) warn(`set '${s.id}': declares size ${s.size}, has ${actual} printings`);
  }
}

console.log(`\n${cards.length} cards, ${printings.length} printings, ${sets.length} sets, ${formats.length} formats, ${restrictions.length} restrictions, ${rulings.length} rulings, ${setups.length} setups`);
if (errors) { console.error(`\nFAIL — ${errors} error(s), ${warnings} warning(s)`); process.exit(1); }
console.log(`\nOK — 0 errors, ${warnings} warning(s)`);
