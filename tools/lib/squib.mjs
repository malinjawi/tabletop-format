import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import jsYaml from "js-yaml";
import { parseDocument } from "yaml";

import { cardMatchesFamily } from "./card-design.mjs";
import { readZip } from "./deterministic-zip.mjs";
import { csvToTable, tableToCsv } from "./interchange-table.mjs";
import { currentNandeckSources } from "./nandeck-layout.mjs";
import { diffRows, mergeRows } from "./row-merge.mjs";

export const SQUIB_FORMAT = "forge-squib-working-copy";
export const SQUIB_VERSION = 1;
export const SQUIB_TESTED_VERSION = "0.19.0";
export const MAX_SQUIB_BYTES = 32 * 1024 * 1024;
const SQUIB_LOCK_PATH = resolve(import.meta.dirname, "..", "..", "integrations", "squib", "Gemfile.lock");

const MAX_FAMILIES = 128;
const MAX_REGIONS = 1_000;
const MAX_YAML_BYTES = 2 * 1024 * 1024;
const EDITABLE_FIELDS = ["x", "y", "w", "h", "d", "fill", "stroke", "stroke_w_mm", "radius_mm", "color", "bg"];
const TEXT_TYPES = new Set(["text", "richtext", "body"]);
const clone = value => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => isDeepStrictEqual(a, b);
const round = value => Math.round(Number(value) * 1000) / 1000;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const safeName = value => String(value || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "game";

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeDesignPath(gameDir, rel, label = "design source") {
  if (typeof rel !== "string" || isAbsolute(rel) || rel.includes("\\") || rel.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error(`${label} is not a safe relative path: ${rel}`);
  const root = resolve(gameDir), path = resolve(root, rel);
  if (!inside(root, path)) throw new Error(`${label} escapes the game: ${rel}`);
  return path;
}

function required(entries, path) {
  const value = entries.get(path);
  if (!value) throw new Error(`Squib working copy is missing ${path}`);
  return value;
}

function json(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

function staticColor(value) {
  const text = String(value || "").trim();
  if (text === "none" || text === "transparent") return text;
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(text)) return text.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(text)) return `#${[...text.slice(1)].map(char => char.repeat(2)).join("")}`.toUpperCase();
  return null;
}

function styledRegion(layout, region) {
  const style = region?.text_style && layout?.text_styles?.[region.text_style];
  return style && typeof style === "object" ? { ...region, ...style, id: region.id, type: region.type, text_style: region.text_style } : region;
}

function mm(value, fallback = 0) {
  const number = Number(value);
  return `${round(Number.isFinite(number) ? number : fallback)}mm`;
}

function number(value, fallback = undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round(parsed) : fallback;
}

function squibColor(value, fallback, warnings, id) {
  const color = staticColor(value);
  if (color != null) return color;
  if (value) warnings.push(`${id}: dynamic Forge color '${value}' is shown with ${fallback} in Squib; the dynamic value remains canonical in Forge`);
  return fallback;
}

const renderColumn = region => `_forge_region_${String(region.id).replace(/[^A-Za-z0-9_]+/g, "_")}`;
const squibRenderableText = region => TEXT_TYPES.has(region.type) && !region.icon_only;

function sourceValue(card, printing, region) {
  if (region.text !== undefined) return String(region.text);
  const dig = path => {
    let value = path.startsWith("printing.") ? printing : card;
    const clean = path.replace(/^(?:card|printing)\./, "");
    for (const key of clean.split(".").filter(Boolean)) value = value?.[key];
    return value;
  };
  let value;
  if (String(region.src || "").includes("{")) value = String(region.src).replace(/\{([^}]+)\}/g, (_, path) => dig(path.trim()) ?? "");
  else {
    value = dig(String(region.src || ""));
    if (value == null) for (const fallback of region.fallback_srcs || []) { value = dig(String(fallback)); if (value != null) break; }
  }
  if (region.map && typeof region.map === "object" && Object.hasOwn(region.map, String(value ?? ""))) value = region.map[String(value ?? "")];
  if (region.transform === "before-colon") value = String(value ?? "").split(":", 1)[0].trim();
  else if (region.transform === "after-colon") value = String(value ?? "").includes(":") ? String(value).slice(String(value).indexOf(":") + 1).trim() : "";
  else if (region.transform === "uppercase") value = String(value ?? "").toUpperCase();
  else if (region.transform === "lowercase") value = String(value ?? "").toLowerCase();
  else if (region.transform === "strip-leading-zeros") value = String(value ?? "").replace(/^0+(?=\d)/, "");
  else if (region.transform === "join" && Array.isArray(value)) value = value.join(region.separator || ", ");
  if (Array.isArray(value)) value = value.join(region.separator || ", ");
  return `${region.prefix || ""}${value ?? ""}${region.suffix || ""}`;
}

function squibRegion(layout, sourceRegion, warnings) {
  const region = styledRegion(layout, sourceRegion), width = region.w ?? region.d ?? 1, height = region.h ?? region.d ?? 1;
  const entry = { x: mm(region.x), y: mm(region.y), width: mm(width), height: mm(height) };
  if (TEXT_TYPES.has(region.type)) {
    const font = (layout.fonts || []).find(item => item.id === region.font);
    entry.font = font?.family || "Sans";
    entry.font_size = number(region.size_pt, 8);
    entry.color = squibColor(region.color, "#111111", warnings, region.id);
    entry.align = ["left", "center", "right"].includes(region.align) ? region.align : "left";
    entry.valign = ({ top: "top", middle: "middle", bottom: "bottom" })[region.valign] || "top";
    if (region.autoshrink) entry.ellipsize = "autoscale";
  } else if (region.type === "rect") {
    entry.fill_color = squibColor(region.fill, "#E7EBEE", warnings, region.id);
    entry.stroke_color = squibColor(region.stroke, "#27323A", warnings, region.id);
    entry.stroke_width = mm(region.stroke_w_mm, 0.2);
    if (region.radius_mm != null) entry.radius = mm(region.radius_mm);
  } else if (region.type === "badge") {
    entry.fill_color = squibColor(region.bg, "#E7EBEE", warnings, region.id);
    entry.stroke_color = squibColor(region.color, "#27323A", warnings, region.id);
    entry.stroke_width = mm(region.stroke_w_mm, 0.2);
  }
  return entry;
}

function baselineOf(region) {
  return Object.fromEntries(EDITABLE_FIELDS.filter(key => region[key] !== undefined).map(key => [key, clone(region[key])]));
}

function forgeFromSquib(entry, type) {
  const readMm = (key, fallback) => {
    if (entry[key] == null) return fallback;
    const text = String(entry[key]).trim(), match = text.match(/^(-?\d+(?:\.\d+)?)\s*(?:mm)?$/i);
    if (!match) throw new Error(`${key} must be a literal millimetre value, not '${text}'`);
    return round(Number(match[1]));
  };
  const out = { x: readMm("x", 0), y: readMm("y", 0) };
  const width = readMm("width", 1), height = readMm("height", 1);
  if (type === "badge") out.d = round(Math.min(width, height));
  else { out.w = width; out.h = height; }
  if (type === "rect") {
    const fill = staticColor(entry.fill_color); if (fill != null) out.fill = fill;
    const stroke = staticColor(entry.stroke_color); if (stroke != null) out.stroke = stroke;
    if (entry.stroke_width != null) out.stroke_w_mm = readMm("stroke_width", 0.2);
    if (entry.radius != null) out.radius_mm = readMm("radius", 0);
  } else if (type === "badge") {
    const bg = staticColor(entry.fill_color); if (bg != null) out.bg = bg;
    const color = staticColor(entry.stroke_color); if (color != null) out.color = color;
    if (entry.stroke_width != null) out.stroke_w_mm = readMm("stroke_width", 0.2);
  } else if (TEXT_TYPES.has(type)) {
    const color = staticColor(entry.color); if (color != null) out.color = color;
  }
  if (out.w != null && out.w <= 0 || out.h != null && out.h <= 0 || out.d != null && out.d <= 0)
    throw new Error("region dimensions must be greater than zero");
  return out;
}

function dataRows(cards, printings, family) {
  const firstPrinting = new Map();
  for (const printing of printings) if (!firstPrinting.has(printing.card_id)) firstPrinting.set(printing.card_id, printing);
  return cards.filter(card => cardMatchesFamily(card, family.match || {})).map(card => {
    const printing = firstPrinting.get(card.id) || {};
    const row = { ...card };
    for (const [key, value] of Object.entries(card.attributes || {})) row[`attributes.${key}`] = value;
    delete row.attributes;
    for (const key of ["set_id", "collector_number", "variant", "artist", "art", "flavor_text"])
      row[`printing.${key}`] = printing[key] ?? "";
    for (const region of family.layout.regions || []) if (squibRenderableText(region) && region.text === undefined)
      row[renderColumn(region)] = sourceValue(card, printing, styledRegion(family.layout, region));
    return row;
  });
}

function visibleFor(card, expression) {
  if (!expression) return true;
  const dig = path => {
    let value = card;
    for (const key of String(path).replace(/^card\./, "").split(".")) value = value?.[key];
    return value;
  };
  const atom = raw => {
    const comparison = raw.trim().match(/^(!)?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(==|!=)\s*['"]?([^'"]*)['"]?$/);
    if (comparison) {
      const result = String(dig(comparison[2]) ?? "") === comparison[4];
      return (comparison[3] === "!=" ? !result : result) !== !!comparison[1];
    }
    const truthy = raw.trim().match(/^(!)?\s*([A-Za-z_][A-Za-z0-9_.]*)$/);
    if (!truthy) return true;
    return !!dig(truthy[2]) !== !!truthy[1];
  };
  return String(expression).split("||").some(group => group.split("&&").every(atom));
}

function rubyString(value) { return JSON.stringify(String(value)); }

function rubyForFamily(family, cards) {
  const lines = [
    "# Generated by Forge. Forge never executes returned Ruby files.",
    `# Tested contract: Squib ${SQUIB_TESTED_VERSION}. See forge-source.json for fidelity boundaries.`,
    "ENV['BUNDLE_GEMFILE'] ||= File.expand_path('../../Gemfile', __dir__)",
    "require 'bundler/setup'",
    "require 'squib'",
    "",
    "root = File.expand_path(__dir__)",
    "data = Squib.csv file: File.join(root, 'render.csv')",
    `Squib::Deck.new(cards: data['id'].size, width: ${rubyString(mm(family.layout.card?.w_mm, 63))}, height: ${rubyString(mm(family.layout.card?.h_mm, 88))}, layout: File.join(root, 'layout.yml')) do`,
    "  background color: 'white'",
  ];
  for (const sourceRegion of family.layout.regions || []) {
    const region = styledRegion(family.layout, sourceRegion), range = cards.map((card, index) => visibleFor(card, region.show_if) ? index : null).filter(index => index != null);
    if (!range.length) continue;
    const rangeRuby = `[${range.join(", ")}]`;
    if (squibRenderableText(region)) {
      const text = region.text !== undefined ? rubyString(region.text) : `data[${rubyString(renderColumn(region))}]`;
      lines.push(`  text str: ${text}, layout: ${rubyString(region.id)}, range: ${rangeRuby}`);
    } else if (region.type === "rect") lines.push(`  rect layout: ${rubyString(region.id)}, range: ${rangeRuby}`);
    else if (region.type === "badge") lines.push(`  ellipse layout: ${rubyString(region.id)}, range: ${rangeRuby}`);
    else if (["image", "background"].includes(region.type))
      lines.push(`  rect layout: ${rubyString(region.id)}, fill_color: '#D9DEE3', stroke_color: '#9AA6AF', range: ${rangeRuby} # image placeholder; Forge keeps art rights and fit canonical`);
  }
  lines.push("  save_png dir: File.join(root, 'output')", "  save_pdf dir: File.join(root, 'output'), file: 'cards.pdf'", "end", "");
  return lines.join("\n");
}

function yamlText(value) {
  return jsYaml.dump(value, { noRefs: true, sortKeys: false, lineWidth: 120, quotingType: '"' });
}

/** Build a deterministic, runnable Squib working copy without executing Ruby. */
export function buildSquibProject(gameDirValue, { sourceRef = "working-tree" } = {}) {
  const gameDir = resolve(gameDirValue), game = jsYaml.load(readFileSync(safeDesignPath(gameDir, "game.yaml"), "utf8")) || {};
  const cards = JSON.parse(readFileSync(safeDesignPath(gameDir, "components/cards.json"), "utf8"));
  const printings = JSON.parse(readFileSync(safeDesignPath(gameDir, "components/printings.json"), "utf8"));
  const sources = currentNandeckSources(gameDir), entries = new Map(), reports = [];
  for (const family of sources.families) {
    const dir = `families/${safeName(family.id)}`, familyCards = cards.filter(card => cardMatchesFamily(card, family.match || {}));
    const canonical = tableToCsv(familyCards, "cards"), render = tableToCsv(dataRows(cards, printings, family), "cards");
    const warnings = [], layout = {}, bindings = [];
    for (const sourceRegion of family.layout.regions || []) {
      const entry = squibRegion(family.layout, sourceRegion, warnings);
      layout[sourceRegion.id] = entry;
      bindings.push({ id: sourceRegion.id, type: sourceRegion.type, source_file: family.origins?.[sourceRegion.id] || sources.systemFile,
        baseline: baselineOf(sourceRegion), adapter_baseline: forgeFromSquib(entry, sourceRegion.type), text_style: sourceRegion.text_style || null });
      if (TEXT_TYPES.has(sourceRegion.type) && sourceRegion.icon_only)
        warnings.push(`${sourceRegion.id}: Forge symbol-font icon is not rasterized by the generated Squib starter and remains Forge-only`);
      if (![...TEXT_TYPES, "rect", "badge", "image", "background"].includes(sourceRegion.type))
        warnings.push(`${sourceRegion.id}: '${sourceRegion.type}' is not rendered by the generated Squib starter and remains Forge-only`);
      if (sourceRegion.show_if) warnings.push(`${sourceRegion.id}: visibility is precomputed into Ruby ranges; edit the condition in Forge`);
      if (sourceRegion.text_style) warnings.push(`${sourceRegion.id}: shared text style '${sourceRegion.text_style}' is display-only in Squib and stays linked in Forge`);
    }
    const meta = { format: SQUIB_FORMAT, version: SQUIB_VERSION, family: family.id, source_ref: sourceRef, source_hash: sources.sourceHash,
      system_file: sources.systemFile, card: clone(family.layout.card || {}), card_ids: familyCards.map(card => card.id),
      cards: { columns: canonical.columns, sha256: sha256(Buffer.from(canonical.csv)) }, bindings };
    entries.set(`${dir}/cards.csv`, Buffer.from(canonical.csv));
    entries.set(`${dir}/base-cards.json`, Buffer.from(`${JSON.stringify(familyCards, null, 2)}\n`));
    entries.set(`${dir}/render.csv`, Buffer.from(render.csv));
    entries.set(`${dir}/layout.yml`, Buffer.from(yamlText(layout)));
    entries.set(`${dir}/forge-source.json`, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
    entries.set(`${dir}/deck.rb`, Buffer.from(rubyForFamily(family, familyCards)));
    reports.push({ id: family.id, label: family.label || family.id, dir, cards: familyCards.length,
      regions: family.layout.regions?.length || 0, warnings: [...new Set(warnings)] });
  }
  entries.set("Gemfile", Buffer.from(`source "https://rubygems.org"\ngem "squib", "${SQUIB_TESTED_VERSION}"\n`));
  entries.set("Gemfile.lock", readFileSync(SQUIB_LOCK_PATH));
  const manifest = { format: SQUIB_FORMAT, version: SQUIB_VERSION,
    game: { id: game.id || basename(gameDir), title: game.title || game.id || basename(gameDir) },
    source: { ref: sourceRef }, source_hash: sources.sourceHash, tested_upstream: `Squib ${SQUIB_TESTED_VERSION}`, families: reports,
    fidelity: { level: "declared-subset", canonical: ["card data", "region source identity", "three-way merge baseline"],
      editable: ["card fields", "region geometry", "flat colors", "stroke width", "corner radius"],
      preserved_in_forge: ["art rights", "image fit", "palettes", "gradients", "motifs", "conditions", "shared typography", "rich text", "symbols", "effects"] },
    security: { forge_executes_ruby: false, returned_files_parsed: ["manifest.json", "families/*/forge-source.json", "families/*/cards.csv", "families/*/layout.yml"] } };
  entries.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  entries.set("README.md", Buffer.from(`# ${manifest.game.title} — Squib working copy\n\nThis package is a version-pinned bridge to [Squib](https://squib.rocks), not a second source of truth.\n\n1. Install Ruby and Bundler, then run \`bundle install\`.\n2. Edit a family's \`cards.csv\` and declarative \`layout.yml\`. Keep permanent card IDs and \`forge-source.json\`.\n3. Preview with \`bundle exec ruby families/<family>/deck.rb\`. Outputs stay inside that family's \`output/\` folder.\n4. Zip the package contents at the root and return it in Forge. Forge shows semantic and rendered impact before one commit or pull request.\n\nForge never runs returned Ruby. Changes to \`deck.rb\`, generated \`render.csv\`, output files, or undeclared files are ignored. Dynamic Forge features listed in \`manifest.json\` remain canonical and are preserved.\n`));
  return { manifest, entries };
}

function regionNode(document, id) {
  const sequence = document.get("regions", true);
  return sequence?.items?.find(item => String(item.get?.("id")) === id) || null;
}

function parseLayout(bytes, label) {
  if (bytes.length > MAX_YAML_BYTES) throw new Error(`${label} is larger than 2 MB`);
  const value = jsYaml.load(bytes.toString("utf8"), { json: true });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must contain a mapping of named regions`);
  let nodes = 0;
  const inspect = (item, depth = 0) => {
    if (++nodes > 5_000) throw new Error(`${label} is too structurally complex`);
    if (depth > 8) throw new Error(`${label} is nested too deeply`);
    if (typeof item === "string" && item.length > 20_000) throw new Error(`${label} contains an oversized scalar`);
    if (Array.isArray(item)) for (const child of item) inspect(child, depth + 1);
    else if (item && typeof item === "object") for (const child of Object.values(item)) inspect(child, depth + 1);
  };
  inspect(value);
  if (Object.keys(value).length > MAX_REGIONS) throw new Error(`${label} has more than ${MAX_REGIONS} regions`);
  for (const [id, entry] of Object.entries(value))
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label} region '${id}' must be a mapping`);
  return value;
}

export function inspectSquibArchive(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length > MAX_SQUIB_BYTES) throw new Error("Squib working copy is larger than 32 MB");
  const entries = readZip(buffer), manifest = json(required(entries, "manifest.json"), "manifest.json");
  if (manifest.format !== SQUIB_FORMAT || manifest.version !== SQUIB_VERSION)
    throw new Error("archive is not a Forge-generated Squib working copy");
  if (!Array.isArray(manifest.families) || manifest.families.length > MAX_FAMILIES) throw new Error("Squib manifest has an invalid family list");
  if (!/^[0-9a-f]{7,64}$/i.test(manifest.source?.ref || "")) throw new Error("Squib working copy has no immutable Git baseline");
  return { entries, manifest };
}

/** Inspect only the bounded declarative subset of a returned Squib ZIP. */
export function analyzeSquibImport(gameDirValue, input, { allowGameIdMismatch = false, baselineGameDir = null } = {}) {
  const { entries, manifest } = inspectSquibArchive(input);
  const gameDir = resolve(gameDirValue), game = jsYaml.load(readFileSync(safeDesignPath(gameDir, "game.yaml"), "utf8")) || {};
  if (!allowGameIdMismatch && manifest.game?.id && game.id && manifest.game.id !== game.id) throw new Error(`working copy belongs to '${manifest.game.id}', not '${game.id}'`);
  const baselineDir = resolve(baselineGameDir || gameDir), expected = buildSquibProject(baselineDir, { sourceRef: manifest.source.ref });
  if (manifest.game?.id !== expected.manifest.game.id || manifest.source_hash !== expected.manifest.source_hash
    || manifest.tested_upstream !== expected.manifest.tested_upstream)
    throw new Error("Squib manifest does not match its immutable Git baseline");
  const familyIdentity = value => value.map(item => ({ id: item.id, dir: item.dir }));
  if (!equal(familyIdentity(manifest.families), familyIdentity(expected.manifest.families)))
    throw new Error("Squib family manifest does not match its immutable Git baseline");
  for (const family of expected.manifest.families) for (const name of ["forge-source.json", "base-cards.json"]) {
    const path = `${family.dir}/${name}`;
    if (!required(entries, path).equals(required(expected.entries, path)))
      throw new Error(`${path} was changed; Forge recovered the trusted baseline from Git and refused it`);
  }
  const currentCards = JSON.parse(readFileSync(safeDesignPath(gameDir, "components/cards.json"), "utf8"));
  const sources = currentNandeckSources(gameDir), familyById = new Map(sources.families.map(family => [family.id, family]));
  let mergedCards = currentCards.map(clone);
  const conflicts = [], warnings = [], layoutChanges = [], docs = new Map(), dirty = new Set(), seenCards = new Map(), layoutProposals = new Map();
  const documentFor = rel => {
    if (!docs.has(rel)) {
      const raw = readFileSync(safeDesignPath(gameDir, rel), "utf8"), document = parseDocument(raw, { keepSourceTokens: true });
      if (document.errors.length) throw new Error(`cannot parse ${rel}: ${document.errors[0].message}`);
      docs.set(rel, { raw, document });
    }
    return docs.get(rel).document;
  };
  for (const record of manifest.families) {
    const dir = String(record.dir || "");
    if (!/^families\/[a-z0-9][a-z0-9-]{0,79}$/.test(dir)) throw new Error(`unsafe Squib family directory '${dir}'`);
    const meta = json(required(entries, `${dir}/forge-source.json`), `${dir}/forge-source.json`), family = familyById.get(meta.family);
    if (meta.format !== SQUIB_FORMAT || meta.version !== SQUIB_VERSION || !family) throw new Error(`${dir} has invalid or unknown Forge family metadata`);
    if (!Array.isArray(meta.bindings) || meta.bindings.length > MAX_REGIONS) throw new Error(`${dir} has invalid region bindings`);
    const baseCards = json(required(entries, `${dir}/base-cards.json`), `${dir}/base-cards.json`), cardIds = new Set(meta.card_ids || []);
    if (!Array.isArray(baseCards) || baseCards.some(card => !cardIds.has(card.id))) throw new Error(`${dir} card baseline is invalid`);
    let proposedCards;
    try { proposedCards = csvToTable(required(entries, `${dir}/cards.csv`).toString("utf8"), { columns: meta.cards?.columns || [] }, "cards", baseCards); }
    catch (error) { throw new Error(`${dir}/cards.csv: ${error.message}`); }
    if (proposedCards.some(card => !cardIds.has(card.id))) throw new Error(`${dir}/cards.csv cannot add cards; add a printing through Forge's canonical data workflow`);
    for (const card of proposedCards) {
      const previous = seenCards.get(card.id);
      if (previous && !equal(previous, card)) conflicts.push({ kind: "cards", id: card.id, path: "*", base: "same card in multiple families", proposed: card, current: previous });
      seenCards.set(card.id, card);
    }
    const merged = mergeRows(baseCards, proposedCards, mergedCards, "cards");
    mergedCards = merged.merged; conflicts.push(...merged.conflicts);
    const layout = parseLayout(required(entries, `${dir}/layout.yml`), `${dir}/layout.yml`), bindings = new Map(meta.bindings.map(binding => [binding.id, binding]));
    for (const [id, binding] of bindings) {
      const proposedEntry = layout[id];
      if (!proposedEntry) { warnings.push(`${meta.family}/${id}: missing layout entry was preserved, not deleted`); continue; }
      if (!binding.source_file || !binding.baseline || !binding.adapter_baseline) continue;
      const origin = family.origins?.[id];
      if (origin !== binding.source_file) { conflicts.push({ kind: "layout", id, path: "source_file", base: binding.source_file, proposed: binding.source_file, current: origin || null }); continue; }
      const currentRegion = family.layout.regions.find(region => region.id === id);
      if (!currentRegion) { conflicts.push({ kind: "layout", id, path: "*", base: "region", proposed: "edited", current: null }); continue; }
      let proposed;
      try { proposed = forgeFromSquib(proposedEntry, binding.type); }
      catch (error) { throw new Error(`${dir}/layout.yml region '${id}': ${error.message}`); }
      const node = regionNode(documentFor(binding.source_file), id);
      if (!node) { conflicts.push({ kind: "layout", id, path: "source", base: binding.source_file, proposed: "edited", current: "region missing" }); continue; }
      for (const key of EDITABLE_FIELDS) {
        const adapterBase = binding.adapter_baseline[key], next = proposed[key];
        if (next === undefined || equal(adapterBase, next)) continue;
        if (binding.text_style && key === "color") { warnings.push(`${meta.family}/${id}: ignored color because shared text style '${binding.text_style}' remains linked in Forge`); continue; }
        const base = binding.baseline[key], current = currentRegion[key];
        if (equal(current, next)) continue;
        const proposalKey = `${binding.source_file}\0${id}\0${key}`, earlier = layoutProposals.get(proposalKey);
        if (earlier !== undefined) {
          if (!equal(earlier, next)) conflicts.push({ kind: "layout", id, path: key, base: base ?? null, proposed: next ?? null, current: earlier,
            reason: "different Squib family files proposed different values for the same shared Forge region" });
          continue;
        }
        layoutProposals.set(proposalKey, clone(next));
        if (!equal(current, base)) { conflicts.push({ kind: "layout", id, path: key, base: base ?? null, proposed: next ?? null, current: current ?? null }); continue; }
        node.set(key, clone(next)); dirty.add(binding.source_file);
        layoutChanges.push({ family: meta.family, id, path: key, before: base ?? null, after: next ?? null, source_file: binding.source_file });
      }
    }
    for (const id of Object.keys(layout)) if (!bindings.has(id)) warnings.push(`${meta.family}/${id}: undeclared Squib layout entry was ignored`);
  }
  const files = [];
  const cardChanges = diffRows(currentCards, mergedCards, "cards");
  if (!equal(currentCards, mergedCards)) files.push({ path: "components/cards.json", content: Buffer.from(`${JSON.stringify(mergedCards, null, 2)}\n`), kind: "cards" });
  for (const [path, entry] of docs) if (dirty.has(path)) {
    const content = String(entry.document);
    if (content !== entry.raw) files.push({ path, content, kind: "layout" });
  }
  const changedIds = new Set([...cardChanges.changed, ...cardChanges.added]);
  const affectedFamilies = sources.families.filter(candidate => layoutChanges.some(change =>
    change.source_file === sources.systemFile || candidate.origins?.[change.id] === change.source_file)).map(candidate => candidate.id);
  return { ok: conflicts.length === 0, source_hash: manifest.source_hash || null, current_source_hash: sources.sourceHash,
    stale: manifest.source_hash !== sources.sourceHash, source_ref: manifest.source.ref, upstream: manifest.tested_upstream || null,
    changes: { cards: cardChanges, layout: layoutChanges }, affected_families: affectedFamilies,
    preview: { cards: mergedCards.filter(card => changedIds.has(card.id)) },
    files, conflicts, warnings: [...new Set(warnings)], ignored: ["deck.rb", "render.csv", "output/**", "undeclared files"] };
}
