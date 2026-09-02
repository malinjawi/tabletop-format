import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import yaml from "js-yaml";
import { parseDocument } from "yaml";

import { CARD_DESIGN_MANIFEST, cardMatchesFamily, loadCardDesign } from "./card-design.mjs";

export const NANDECK_FORMAT = "forge-nandeck-layout";
export const NANDECK_VERSION = 1;

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTIVES = 10_000;
const SUPPORTED_REGION_FIELDS = [
  "type", "x", "y", "w", "h", "d", "shape", "src", "text", "font", "size_pt",
  "min_size_pt", "align", "valign", "color", "bg", "autoshrink", "no_wrap",
  "fill", "stroke", "stroke_w_mm", "radius_mm", "fit", "opacity", "show_if",
  "glyph", "count", "max", "direction", "gap_mm",
];
const FIELD_TO_SOURCE = {
  id: "card.id",
  name: "card.name",
  type: "card.type",
  subtypes: "card.subtypes",
  keywords: "card.keywords",
  text: "card.text",
  set: "printing.set_id",
  collector_number: "printing.collector_number",
  variant: "printing.variant",
  artist: "printing.artist",
  art: "printing.art",
};
const SOURCE_TO_FIELD = new Map(Object.entries(FIELD_TO_SOURCE).map(([field, source]) => [source, field]));
for (const source of ["printing.art_url", "printing.art_data", "printing.scan_data", "printing.image", "printing.scan"])
  SOURCE_TO_FIELD.set(source, "art");

const clone = value => structuredClone(value);
const round = value => Math.round(value * 1000) / 1000;
const equal = (a, b) => isDeepStrictEqual(a, b);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const slugify = value => String(value || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "game";
const safeName = value => slugify(value).slice(0, 80);

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

function documentAt(gameDir, rel) {
  return yaml.load(readFileSync(safeDesignPath(gameDir, rel), "utf8")) || {};
}

function csvCell(value) {
  let text;
  if (value == null) text = "";
  else if (Array.isArray(value)) text = value.join(";");
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvText(rows, columns) {
  return `${columns.map(csvCell).join(",")}\n${rows.map(row => columns.map(key => csvCell(row[key])).join(",")).join("\n")}\n`;
}

function sourceField(source, fallbackSources = []) {
  const candidates = [source, ...fallbackSources].filter(Boolean);
  for (const candidate of candidates) {
    if (SOURCE_TO_FIELD.has(candidate)) return SOURCE_TO_FIELD.get(candidate);
    const attribute = String(candidate).match(/^card\.attributes\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (attribute) return attribute[1];
  }
  return null;
}

function sourceContent(region, warnings) {
  if (region.text !== undefined) {
    const text = String(region.text);
    if (text.includes("[") || text.includes("]"))
      warnings.push(`${region.id}: literal [symbol] markup is preserved as readable text; nanDECK icon binding needs a game-specific ICON adapter`);
    return quoteNandeck(text.replace(/\[/g, "(").replace(/\]/g, ")"));
  }
  if (region.src?.includes("{")) {
    let failed = false;
    const converted = region.src.replace(/\{([^}]+)\}/g, (_, path) => {
      const field = sourceField(path.trim());
      if (!field) { failed = true; return `{${path}}`; }
      return `[${field}]`;
    });
    if (!failed) return quoteNandeck(`${region.prefix || ""}${converted}${region.suffix || ""}`);
  }
  const field = sourceField(region.src, region.fallback_srcs);
  if (!field) {
    warnings.push(`${region.id}: '${region.src || "literal"}' has no nanDECK column mapping`);
    return quoteNandeck(`[unmapped: ${region.src || region.id}]`);
  }
  let content = `[${field}]`;
  if (region.prefix) content = `${region.prefix}${content}`;
  if (region.suffix) content = `${content}${region.suffix}`;
  if (region.transform && !["join"].includes(region.transform))
    warnings.push(`${region.id}: '${region.transform}' transform remains Forge-only`);
  return quoteNandeck(content);
}

function quoteNandeck(value) {
  return `"${String(value ?? "").replace(/"/g, "\\34\\")}"`;
}

function nanColor(value, fallback, warnings, id) {
  if (typeof value === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)) return value.toUpperCase();
  const paletteField = { palette: "_palette", "palette-dark": "_palette_dark", "palette-deep": "_palette_deep",
    "palette-light": "_palette_light", "palette-soft": "_palette_soft", "palette-gradient": "_palette_gradient" }[value];
  if (paletteField) return `[${paletteField}]`;
  if (value === "none" || value === "transparent") return "EMPTY";
  const linear = typeof value === "string" ? value.match(/^linear-gradient\(([-\d.]+)deg,(.*)\)$/i) : null;
  if (linear) {
    const colors = [...linear[2].matchAll(/#[0-9a-f]{6}/ig)].map(match => match[0].toUpperCase());
    if (colors.length >= 2) return `${colors[0]}${colors.at(-1)}@${round(Number(linear[1]) || 0)}`;
  }
  const embedded = typeof value === "string" ? value.match(/#[0-9a-f]{6}/i)?.[0] : null;
  if (embedded) {
    warnings.push(`${id}: nanDECK cannot reproduce '${value}' exactly; using ${embedded}`);
    return embedded.toUpperCase();
  }
  if (value) warnings.push(`${id}: dynamic/CSS color '${value}' remains Forge-only; using ${fallback}`);
  return fallback;
}

function fontFor(layout, region) {
  return (layout.fonts || []).find(font => font.id === region.font) || { id: region.font || "default", family: "Arial", weight: 400, style: "normal" };
}

function fontDirective(layout, region, warnings) {
  const font = fontFor(layout, region), flags = [];
  if ((font.weight || 400) >= 600) flags.push("B");
  if (font.style === "italic") flags.push("I");
  if (region.autoshrink) flags.push("F");
  flags.push("T");
  const color = nanColor(region.color, "#000000", warnings, region.id);
  return `FONT=${quoteNandeck(font.family || "Arial")},${round(region.size_pt || 8)},${flags.join("")},${color}`;
}

function n(value) { return Number.isFinite(Number(value)) ? String(round(Number(value))) : "0"; }

function conditionValue(value) {
  const text = String(value).trim().replace(/^['"]|['"]$/g, "");
  return /^[A-Za-z0-9_.-]+$/.test(text) ? text : quoteNandeck(text);
}

function conditionField(path) {
  const clean = String(path).trim().replace(/^card\./, "");
  if (FIELD_TO_SOURCE[clean]) return `[${clean}]`;
  if (clean === "printing.set_id") return "[set]";
  if (clean === "printing.collector_number") return "[collector_number]";
  if (clean === "printing.artist") return "[artist]";
  const attribute = clean.match(/^(?:attributes\.)?([A-Za-z_][A-Za-z0-9_]*)$/);
  return attribute ? `[${attribute[1]}]` : null;
}

/** Translate Forge's deliberately small show_if language to nanDECK IF syntax. */
export function showIfToNandeck(expression) {
  if (!expression) return null;
  const pieces = String(expression).split(/(\&\&|\|\|)/).map(piece => piece.trim()).filter(Boolean);
  const out = [];
  for (const piece of pieces) {
    if (piece === "&&") { out.push("_AND_"); continue; }
    if (piece === "||") { out.push("_OR_"); continue; }
    const comparison = piece.match(/^!?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(==|!=)\s*(.+)$/);
    if (comparison) {
      const field = conditionField(comparison[1]); if (!field) return null;
      const negate = /^!/.test(piece), op = comparison[2] === "==" ? "=" : "<>";
      const test = `(${field}${op}${conditionValue(comparison[3])})`;
      out.push(negate ? `_NOT_ ${test}` : test); continue;
    }
    const truthy = piece.match(/^(!)?\s*([A-Za-z_][A-Za-z0-9_.]*)$/);
    if (!truthy) return null;
    const field = conditionField(truthy[2]); if (!field) return null;
    out.push(`(${field}${truthy[1] ? "=" : "<>"}${quoteNandeck("")})`);
  }
  return out.join(" ");
}

function baselineOf(region) {
  return Object.fromEntries(SUPPORTED_REGION_FIELDS.filter(key => region[key] !== undefined).map(key => [key, clone(region[key])]));
}
const pipsField = id => `_forge_${slugify(id).replace(/-/g, "_")}_pips`;

function metaLine(meta) { return `; FORGE_REGION ${JSON.stringify(meta)}`; }

function withCondition(lines, condition, directive, warnings, id) {
  if (!condition) { lines.push(directive); return; }
  const translated = showIfToNandeck(condition);
  if (!translated) {
    warnings.push(`${id}: condition '${condition}' is not editable in nanDECK; the Forge import preserves it`);
    lines.push(directive); return;
  }
  lines.push(`IF=${translated}`, directive, "ENDIF");
}

function originMeta(region, origin, part = "main") {
  return {
    id: region.id,
    part,
    source_type: region.type,
    source_file: origin || null,
    baseline: baselineOf(region),
  };
}

/** Convert one compiled Forge family layout to a safe, traceable nanDECK script. */
export function layoutToNandeck(layout, {
  link = "cards.csv", family = "default", sourceHash = null, origins = {}, systemFile = "templates/layout.yaml",
} = {}) {
  const warnings = [], unsupported = [], lines = [
    "; nanDECK source generated by Forge. Edit it, then import it through Forge for review.",
    "; Canonical card data stays in Git; this file is an editor adapter, not a second database.",
    "UNIT=MM",
    `; FORGE_META ${JSON.stringify({ format: NANDECK_FORMAT, version: NANDECK_VERSION, family, source_hash: sourceHash, system_file: systemFile, baseline_card: clone(layout.card || {}), baseline_fonts: clone(layout.fonts || []) })}`,
    `LINK=${quoteNandeck(link)}`,
    `CARDSIZE=${n(layout.card?.w_mm || 63)},${n(layout.card?.h_mm || 88)}`,
    "",
  ];
  for (const region of layout.regions || []) {
    const origin = origins[region.id] || systemFile;
    const condition = region.show_if;
    if (["text", "richtext", "body"].includes(region.type)) {
      lines.push(metaLine(originMeta(region, origin)));
      lines.push(fontDirective(layout, region, warnings));
      const vertical = region.type === "richtext" || region.type === "body" || !region.no_wrap
        ? ({ top: "wwtop", middle: "wwcenter", bottom: "wwbottom" }[region.valign] || "wordwrap")
        : ({ top: "top", middle: "center", bottom: "bottom" }[region.valign] || "center");
      const directive = `TEXT=,${sourceContent(region, warnings)},${n(region.x)},${n(region.y)},${n(region.w)},${n(region.h)},${region.align || "left"},${vertical}`;
      withCondition(lines, condition, directive, warnings, region.id);
      if (region.type === "body" && region.secondary_src)
        warnings.push(`${region.id}: secondary flowing text '${region.secondary_src}' remains Forge-only in this adapter version`);
      lines.push("");
      continue;
    }
    if (["image", "background"].includes(region.type)) {
      lines.push(metaLine(originMeta(region, origin)));
      const content = sourceContent(region, warnings), flags = region.fit === "contain" ? "PNA" : "CNA";
      const directive = `IMAGE=,${content},${n(region.x)},${n(region.y)},${n(region.w)},${n(region.h)},0,${flags}`;
      withCondition(lines, condition, directive, warnings, region.id); lines.push(""); continue;
    }
    if (region.type === "rect") {
      lines.push(metaLine(originMeta(region, origin)));
      const stroke = nanColor(region.stroke || region.fill, "#000000", warnings, region.id);
      const fill = nanColor(region.fill, stroke, warnings, region.id);
      const directive = `RECTANGLE=,${n(region.x)},${n(region.y)},${n(region.w)},${n(region.h)},${stroke},${fill},${n(region.stroke_w_mm || 0.1)}`;
      withCondition(lines, condition, directive, warnings, region.id); lines.push(""); continue;
    }
    if (region.type === "badge") {
      const d = region.d || Math.min(region.w || 0, region.h || 0), stroke = nanColor(region.color, "#000000", warnings, region.id);
      const fill = nanColor(region.bg, "#FFFFFF", warnings, region.id);
      lines.push(metaLine(originMeta(region, origin, "shape")));
      withCondition(lines, condition, `ELLIPSE=,${n(region.x)},${n(region.y)},${n(d)},${n(d)},${stroke},${fill},0.1`, warnings, region.id);
      if (region.src || region.text !== "") {
        lines.push(metaLine(originMeta(region, origin, "text")), fontDirective(layout, region, warnings));
        withCondition(lines, condition, `TEXT=,${sourceContent(region, warnings)},${n(region.x)},${n(region.y)},${n(d)},${n(d)},center,center`, warnings, region.id);
      }
      lines.push(""); continue;
    }
    if (region.type === "pips") {
      lines.push(metaLine(originMeta(region, origin)), fontDirective(layout, { ...region, size_pt: region.size_pt || 6, color: region.color || "#000000" }, warnings));
      const vertical = region.direction === "column" ? "wordwrap" : "center";
      withCondition(lines, condition, `TEXT=,"[${pipsField(region.id)}]",${n(region.x)},${n(region.y)},${n(region.w)},${n(region.h)},center,${vertical}`, warnings, region.id);
      lines.push(""); continue;
    }
    unsupported.push({ id: region.id, type: region.type, reason: "no lossless nanDECK directive mapping" });
    warnings.push(`${region.id}: ${region.type} remains Forge-only`);
  }
  const uniqueWarnings = [...new Set(warnings)];
  lines.push("; Import notes", ...uniqueWarnings.map(item => `; WARN ${item}`));
  // Record both truths: the canonical Forge baseline and the intentionally
  // lossy value nanDECK actually sees. A no-op export/import must never turn a
  // CSS gradient into its fallback color or an art fallback into a new src.
  const draft = `${lines.join("\n")}\n`;
  const projected = new Map(parseNandeckScript(draft).layout.regions.map(region => [region.id, baselineOf(region)]));
  const enriched = draft.split("\n").map(line => {
    if (!line.startsWith("; FORGE_REGION ")) return line;
    try {
      const meta = JSON.parse(line.slice(15));
      return meta.id && projected.has(meta.id) ? metaLine({ ...meta, adapter_baseline: projected.get(meta.id) }) : line;
    } catch { return line; }
  }).join("\n");
  return { script: enriched, report: { family, regions: layout.regions?.length || 0, exported: (layout.regions?.length || 0) - unsupported.length, unsupported, warnings: uniqueWarnings } };
}

function designOrigins(gameDir, catalog, manifest) {
  const componentDocs = new Map((manifest.components || []).map(component => [component.id, documentAt(gameDir, component.source)]));
  return Object.fromEntries(catalog.families.map(family => {
    const origins = {};
    for (const component of manifest.components || []) {
      if (!(component.applies_to === "*" || component.applies_to?.includes(family.id))) continue;
      const doc = componentDocs.get(component.id);
      for (const id of doc.remove_regions || []) delete origins[id];
      for (const region of doc.regions || []) origins[region.id] = component.source;
    }
    const familySource = manifest.families.find(item => item.id === family.id)?.source;
    const familyDoc = documentAt(gameDir, familySource);
    for (const id of familyDoc.remove_regions || []) delete origins[id];
    for (const region of familyDoc.regions || []) origins[region.id] = familySource;
    return [family.id, origins];
  }));
}

function sourceHashFor(gameDir, files) {
  const payload = [...new Set(files)].sort().map(rel => `${rel}:${sha256(readFileSync(safeDesignPath(gameDir, rel)))}`).join("\n");
  return `sha256:${sha256(payload)}`;
}

export function currentNandeckSources(gameDirValue) {
  const gameDir = resolve(gameDirValue), manifestPath = safeDesignPath(gameDir, CARD_DESIGN_MANIFEST);
  if (existsSync(manifestPath)) {
    const manifest = documentAt(gameDir, CARD_DESIGN_MANIFEST), catalog = loadCardDesign(gameDir);
    const files = [CARD_DESIGN_MANIFEST, manifest.system,
      ...(manifest.components || []).map(item => item.source), ...(manifest.families || []).map(item => item.source)];
    const origins = designOrigins(gameDir, catalog, manifest);
    return {
      sourceHash: sourceHashFor(gameDir, files), systemFile: manifest.system, files,
      families: catalog.families.map(family => ({ ...family, origins: origins[family.id] })),
    };
  }
  const rel = "templates/layout.yaml", path = safeDesignPath(gameDir, rel);
  if (!existsSync(path)) {
    const layout = {
      card: { w_mm: 63, h_mm: 88, bleed_mm: 3 },
      fonts: [{ id: "title", family: "Arial", weight: 700, style: "normal" }, { id: "body", family: "Arial", weight: 400, style: "normal" }],
      regions: [
        { id: "title", type: "text", src: "card.name", x: 3, y: 3, w: 45, h: 8, font: "title", size_pt: 9, align: "left", valign: "middle", color: "#000000" },
        { id: "type", type: "text", src: "card.type", x: 3, y: 12, w: 57, h: 6, font: "body", size_pt: 7, align: "left", valign: "middle", color: "#606060" },
        { id: "rules", type: "richtext", src: "card.text", x: 4, y: 22, w: 55, h: 52, font: "body", size_pt: 8, align: "left", valign: "top", color: "#000000", autoshrink: true },
        { id: "collector", type: "text", src: "{printing.set_id} {printing.collector_number}", x: 3, y: 80, w: 57, h: 5, font: "body", size_pt: 6, align: "right", valign: "middle", color: "#909090" },
      ],
    };
    return { sourceHash: `sha256:${sha256("forge-generated-default-layout-v1")}`, systemFile: null, files: [], generated: true,
      families: [{ id: "default", label: "Default", match: {}, layout, origins: {} }] };
  }
  return { sourceHash: sourceHashFor(gameDir, [rel]), systemFile: rel, files: [rel], families: [{ id: "default", label: "Default", match: {}, layout: documentAt(gameDir, rel), origins: Object.fromEntries((documentAt(gameDir, rel).regions || []).map(region => [region.id, rel])) }] };
}

function hexRgb(value) {
  const match = String(value || "").match(/^#([0-9a-f]{6})$/i); if (!match) return null;
  return [0, 2, 4].map(index => parseInt(match[1].slice(index, index + 2), 16));
}
function mixHex(a, b, aShare) {
  const left = hexRgb(a), right = hexRgb(b); if (!left || !right) return a || b || "#444444";
  const rgb = left.map((value, index) => Math.round(value * aShare + right[index] * (1 - aShare)));
  return `#${rgb.map(value => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
function dig(value, path) {
  for (const key of String(path || "").replace(/^card\./, "").split(".").filter(Boolean)) value = value?.[key];
  return value;
}
function paletteColumns(layout, card) {
  const palette = layout?.palette; if (!palette) return {};
  const key = dig(card, palette.by), base = palette.map?.[key] || palette.default || "#444444";
  const dark = mixHex(base, "#071018", 0.54), deep = mixHex(base, "#071018", 0.30);
  return {
    _palette: base, _palette_dark: dark, _palette_deep: deep,
    _palette_light: mixHex(base, "#F7F8F5", 0.22), _palette_soft: mixHex(base, "#F7F8F5", 0.10),
    _palette_gradient: `${base}${deep}@145`,
  };
}

function physicalRows(cards, printings, family, assetPrefix, preferLocalArt) {
  const byId = new Map(cards.map(card => [card.id, card]));
  const rows = [];
  for (const printing of printings) {
    const card = byId.get(printing.card_id); if (!card || !cardMatchesFamily(card, family.match || {})) continue;
    const artValue = preferLocalArt
      ? (printing.art || printing.scan || printing.image || printing.art_url || printing.art_data || printing.scan_data || "")
      : (printing.image || printing.art_url || printing.art || printing.scan || printing.art_data || printing.scan_data || "");
    const art = typeof artValue === "string" && artValue.startsWith("assets/") ? `${assetPrefix}${artValue}` : artValue;
    const row = {
      id: card.id, name: card.name, type: card.type || "", subtypes: card.subtypes || [], keywords: card.keywords || [], text: card.text || "",
      set: printing.set_id || "", collector_number: printing.collector_number || "", variant: printing.variant || "",
      artist: printing.artist || printing.provenance?.creator || "", art, _family: family.id,
      ...(card.attributes || {}), ...paletteColumns(family.layout, card),
    };
    for (const region of family.layout.regions || []) {
      if (region.type !== "pips") continue;
      const context = { card, printing }, raw = region.count ?? dig(context, region.src), count = Math.max(0, Math.min(Number(region.max) || 20, Number(raw) || 0));
      row[pipsField(region.id)] = Array.from({ length: count }, () => region.glyph || "●").join(region.direction === "column" ? "\n" : " ");
    }
    for (let count = Math.max(1, Number(printing.quantity) || 1); count > 0; count--) rows.push(row);
  }
  return rows;
}

/** Build deterministic, family-aware nanDECK adapter files without running nanDECK. */
export function buildNandeckProject(gameDirValue, { assetPrefix = "../../project/", preferLocalArt = false } = {}) {
  const gameDir = resolve(gameDirValue), game = documentAt(gameDir, "game.yaml");
  const cards = JSON.parse(readFileSync(safeDesignPath(gameDir, "components/cards.json"), "utf8"));
  const printings = JSON.parse(readFileSync(safeDesignPath(gameDir, "components/printings.json"), "utf8"));
  const sources = currentNandeckSources(gameDir), entries = new Map(), reports = [];
  const rootName = safeName(game.id || basename(gameDir));
  for (const family of sources.families) {
    const name = sources.families.length === 1 ? rootName : `${rootName}-${safeName(family.id)}`;
    const rows = physicalRows(cards, printings, family, assetPrefix, preferLocalArt);
    const attrKeys = [...new Set(rows.flatMap(row => Object.keys(row).filter(key => !["id", "name", "type", "subtypes", "keywords", "text", "set", "collector_number", "variant", "artist", "art", "_family"].includes(key))))].sort();
    const columns = ["id", "name", "type", "subtypes", "keywords", "text", ...attrKeys, "set", "collector_number", "variant", "artist", "art", "_family"];
    entries.set(`${name}.csv`, Buffer.from(csvText(rows, columns)));
    const converted = layoutToNandeck(family.layout, { link: `${name}.csv`, family: family.id, sourceHash: sources.sourceHash, origins: family.origins, systemFile: sources.systemFile });
    entries.set(`${name}.txt`, Buffer.from(converted.script));
    reports.push({ ...converted.report, script: `${name}.txt`, data: `${name}.csv`, cards: rows.length });
  }
  const manifest = {
    format: NANDECK_FORMAT, version: NANDECK_VERSION,
    game: { id: game.id || basename(gameDir), title: game.title || game.id || basename(gameDir) },
    source_hash: sources.sourceHash, unit: "MM", families: reports,
    limitations: [
      "Forge remains canonical; import an edited script to create a reviewed source change.",
      "CSS gradients, clip paths, symbol composition, flowing secondary text, and unsupported region types remain Forge-only and are listed per family.",
      "Opening and rendering the scripts requires a separately installed nanDECK application.",
    ],
  };
  entries.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  entries.set("README.md", Buffer.from(`# ${manifest.game.title} — nanDECK adapter\n\nOpen a family \`.txt\` file in nanDECK. Each script links its adjacent CSV and declares \`UNIT=MM\`. Keep the \`; FORGE_*\` comments: they carry the three-way merge baseline used when the edited script returns to Forge.\n\nForge remains the source of truth. Generated PDFs and PNGs are outputs, not inputs. See \`manifest.json\` for explicit fidelity warnings.\n`));
  return { manifest, entries };
}

function splitArgs(value) {
  const out = []; let current = "", quoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { out.push(current.trim()); current = ""; continue; }
    current += char;
  }
  out.push(current.trim());
  return out.map(item => item.replace(/\\34\\/g, '"'));
}

function parseColor(value, fallback = "#000000") {
  const text = String(value || "").trim();
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(text)) return text.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toUpperCase()}`;
  return fallback;
}

function coord(value, axis, card, unit, line, warnings) {
  const text = String(value || "").trim();
  if (/%$/.test(text)) {
    const number = Number(text.slice(0, -1));
    if (Number.isFinite(number)) return round((axis === "x" || axis === "w" ? card.w_mm : card.h_mm) * number / 100);
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) { warnings.push(`line ${line}: expression '${text}' is not imported as geometry`); return null; }
  return round(Number(text) * unit);
}

function bindingContent(content, knownAttributes, warnings, line) {
  const exact = String(content).match(/^\[([A-Za-z_][A-Za-z0-9_]*)\]$/);
  if (exact) {
    const field = exact[1];
    if (FIELD_TO_SOURCE[field]) return { src: FIELD_TO_SOURCE[field] };
    if (!knownAttributes.has(field) && !field.startsWith("_forge_")) warnings.push(`line ${line}: treating unknown column '${field}' as card.attributes.${field}; confirm the binding`);
    return { src: `card.attributes.${field}` };
  }
  let sawBinding = false;
  const template = String(content).replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, (_, field) => {
    sawBinding = true;
    const source = FIELD_TO_SOURCE[field] || `card.attributes.${field}`;
    if (!FIELD_TO_SOURCE[field] && !knownAttributes.has(field) && !field.startsWith("_forge_")) warnings.push(`line ${line}: treating unknown column '${field}' as ${source}; confirm the binding`);
    return `{${source}}`;
  });
  return sawBinding ? { src: template } : { text: String(content) };
}

function idFor(prefix, count) { return `${prefix}_${String(count).padStart(3, "0")}`; }

/** Parse a bounded, declarative subset of nanDECK. It never opens LINK targets or executes expressions. */
export function parseNandeckScript(input, { knownAttributes = [] } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (bytes.length > MAX_SCRIPT_BYTES) throw new Error("nanDECK script is larger than 2 MB");
  const script = bytes.toString("utf8");
  if (script.includes("\0")) throw new Error("nanDECK script contains NUL bytes");
  const warnings = [], unsupported = [], links = [], attributes = new Set(knownAttributes);
  let unit = 10, unitName = "CM", card = { w_mm: 60, h_mm: 90, bleed_mm: 0 }, font = { family: "Arial", size: 8, style: "T", color: "#000000" };
  let forgeMeta = null, pendingMeta = null, directiveCount = 0, generated = 0;
  const regions = [], byId = new Map(), bindings = new Map(), fontDefs = new Map();
  const add = (region, line, kind) => {
    const meta = pendingMeta; pendingMeta = null;
    const id = meta?.id || idFor(kind, ++generated), sourceType = meta?.source_type;
    if (sourceType) region.type = sourceType;
    region.id = id;
    if (meta?.baseline?.show_if && region.show_if === undefined) region.show_if = meta.baseline.show_if;
    const current = byId.get(id);
    if (current) Object.assign(current, region);
    else { byId.set(id, region); regions.push(region); }
    if (meta) {
      const existing = bindings.get(id) || { ...meta, lines: [] };
      existing.lines.push(line); bindings.set(id, existing);
    }
  };
  for (const [zeroIndex, raw] of script.split(/\r?\n/).entries()) {
    const line = zeroIndex + 1, trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("; FORGE_META ")) {
      try { forgeMeta = JSON.parse(trimmed.slice(13)); } catch { warnings.push(`line ${line}: invalid FORGE_META JSON`); }
      continue;
    }
    if (trimmed.startsWith("; FORGE_REGION ")) {
      try { pendingMeta = JSON.parse(trimmed.slice(15)); } catch { warnings.push(`line ${line}: invalid FORGE_REGION JSON`); }
      continue;
    }
    if (trimmed.startsWith(";")) continue;
    if (["ELSE", "ENDIF"].includes(trimmed.toUpperCase())) continue;
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) { unsupported.push({ line, directive: trimmed.split(/\s+/)[0], reason: "not a declarative assignment" }); continue; }
    if (++directiveCount > MAX_DIRECTIVES) throw new Error(`nanDECK script has more than ${MAX_DIRECTIVES} directives`);
    const directive = match[1].toUpperCase(), args = splitArgs(match[2]);
    if (directive === "UNIT") {
      const next = args[0]?.toUpperCase();
      if ({ MM: 1, CM: 10, INCH: 25.4 }[next]) { unitName = next; unit = { MM: 1, CM: 10, INCH: 25.4 }[next]; }
      else warnings.push(`line ${line}: unknown UNIT '${args[0]}'`);
      continue;
    }
    if (directive === "CARDSIZE") {
      const w = coord(args[0], "w", card, unit, line, warnings), h = coord(args[1], "h", card, unit, line, warnings);
      if (w > 0 && h > 0) card = { ...card, w_mm: w, h_mm: h };
      continue;
    }
    if (directive === "LINK") { links.push(args[0]); continue; }
    if (directive === "FONT") {
      font = { family: args[0] || "Arial", size: Number(args[1]) || 8, style: String(args[2] || ""), color: parseColor(args[3]), background: args[4] };
      continue;
    }
    if (["IF", "ELSEIF", "ELSE", "ENDIF"].includes(directive)) continue;
    const box = start => {
      const x = coord(args[start], "x", card, unit, line, warnings), y = coord(args[start + 1], "y", card, unit, line, warnings);
      const w = coord(args[start + 2], "w", card, unit, line, warnings), h = coord(args[start + 3], "h", card, unit, line, warnings);
      return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null;
    };
    if (directive === "TEXT") {
      const geometry = box(2); if (!geometry) { pendingMeta = null; continue; }
      const vertical = String(args[7] || "center").toLowerCase(), wrapped = ["wordwrap", "wwtop", "wwcenter", "wwbottom", "charwrap"].includes(vertical);
      const style = String(font.style || "").toUpperCase(), fontId = slugify(`${font.family}-${style.includes("B") ? 700 : 400}-${style.includes("I") ? "italic" : "normal"}`).replace(/-/g, "_").slice(0, 32);
      fontDefs.set(fontId, { id: fontId, family: font.family || "Arial", weight: style.includes("B") ? 700 : 400, style: style.includes("I") ? "italic" : "normal" });
      /** @type {any} A parsed external adapter can become either a text region or a circular badge. */
      const region = {
        type: wrapped ? "richtext" : "text", ...geometry, ...bindingContent(args[1], attributes, warnings, line),
        font: fontId, size_pt: font.size, align: ["left", "center", "right"].includes(String(args[6]).toLowerCase()) ? String(args[6]).toLowerCase() : "center",
        valign: ({ top: "top", wwtop: "top", center: "middle", wwcenter: "middle", wordwrap: "top", bottom: "bottom", wwbottom: "bottom" })[vertical] || "middle",
        color: font.color, ...(style.includes("F") ? { autoshrink: true, min_size_pt: Math.max(4, round(font.size - 4)) } : {}), ...(wrapped ? {} : { no_wrap: true }),
      };
      if (pendingMeta?.source_type === "badge") { delete region.w; delete region.h; region.d = round(Math.min(geometry.w, geometry.h)); region.shape = "circle"; }
      add(region, line, "text"); continue;
    }
    if (directive === "IMAGE") {
      const geometry = box(2); if (!geometry) { pendingMeta = null; continue; }
      const flags = String(args[7] || "").toUpperCase();
      add({ type: pendingMeta?.source_type === "background" ? "background" : "image", ...geometry, ...bindingContent(args[1], attributes, warnings, line), fit: flags.includes("P") ? "contain" : "cover" }, line, "image"); continue;
    }
    if (directive === "RECTANGLE") {
      const geometry = box(1); if (!geometry) { pendingMeta = null; continue; }
      const fill = String(args[6] || args[5] || "").toUpperCase() === "EMPTY" ? "none" : parseColor(args[6] || args[5]);
      const thickness = coord(args[7] || "0.1", "w", card, unit, line, warnings);
      add({ type: "rect", ...geometry, stroke: parseColor(args[5]), fill, stroke_w_mm: thickness ?? 0.1 }, line, "rect"); continue;
    }
    if (["ELLIPSE", "CIRCLE"].includes(directive)) {
      const geometry = box(1); if (!geometry) { pendingMeta = null; continue; }
      if (Math.abs(geometry.w - geometry.h) > 0.1) warnings.push(`line ${line}: Forge badge approximates a ${geometry.w}x${geometry.h}mm ellipse as a circle`);
      const fill = String(args[6] || args[5] || "").toUpperCase() === "EMPTY" ? "transparent" : parseColor(args[6] || args[5]);
      add({ type: "badge", x: geometry.x, y: geometry.y, d: round(Math.min(geometry.w, geometry.h)), shape: "circle", bg: fill, color: parseColor(args[5]) }, line, "badge"); continue;
    }
    unsupported.push({ line, directive, reason: "outside Forge's safe layout subset" });
    pendingMeta = null;
  }
  return { layout: { card, ...(fontDefs.size ? { fonts: [...fontDefs.values()] } : {}), regions }, forgeMeta, links, unit: unitName, bindings: Object.fromEntries(bindings), warnings, unsupported };
}

function findFamily(sources, id) { return sources.families.find(family => family.id === id); }

function regionNode(document, id) {
  const sequence = document.get("regions", true);
  if (!sequence?.items) return null;
  return sequence.items.find(item => String(item.get?.("id")) === id) || null;
}

function valueAt(region, key) { return Object.prototype.hasOwnProperty.call(region || {}, key) ? region[key] : undefined; }

/** Three-way merge an edited Forge-generated nanDECK script back into YAML sources. */
export function analyzeNandeckImport(gameDirValue, input) {
  const gameDir = resolve(gameDirValue), cards = JSON.parse(readFileSync(safeDesignPath(gameDir, "components/cards.json"), "utf8"));
  const knownAttributes = [...new Set(cards.flatMap(card => Object.keys(card.attributes || {})))];
  const parsed = parseNandeckScript(input, { knownAttributes });
  if (parsed.forgeMeta?.format !== NANDECK_FORMAT || parsed.forgeMeta?.version !== NANDECK_VERSION)
    throw new Error("script is not a Forge-generated nanDECK layout; import it as a new candidate before replacing a production design");
  const sources = currentNandeckSources(gameDir), family = findFamily(sources, parsed.forgeMeta.family);
  if (!family) throw new Error(`nanDECK script targets unknown family '${parsed.forgeMeta.family}'`);
  const conflicts = [], changes = [], docs = new Map(), dirty = new Set();
  const documentFor = rel => {
    if (!docs.has(rel)) {
      const path = safeDesignPath(gameDir, rel), raw = readFileSync(path, "utf8"), document = parseDocument(raw, { keepSourceTokens: true });
      if (document.errors.length) throw new Error(`cannot parse ${rel}: ${document.errors[0].message}`);
      docs.set(rel, { raw, document });
    }
    return docs.get(rel).document;
  };
  // A changed FONT directive becomes either an existing compatible Forge font
  // id or a new named font in the versioned system file. It never writes an
  // opaque nanDECK-generated id into a region without declaring that font.
  const systemFile = parsed.forgeMeta.system_file || sources.systemFile;
  const currentFonts = family.layout.fonts || [], parsedFonts = new Map((parsed.layout.fonts || []).map(item => [item.id, item]));
  const newFonts = new Map();
  for (const proposedRegion of parsed.layout.regions) {
    const binding = parsed.bindings[proposedRegion.id], adapterFont = binding?.adapter_baseline?.font;
    if (!binding?.baseline?.font || !proposedRegion.font || proposedRegion.font === adapterFont) continue;
    const definition = parsedFonts.get(proposedRegion.font); if (!definition) continue;
    const compatible = [...currentFonts, ...newFonts.values()].find(item => item.family === definition.family && (item.weight || 400) === definition.weight && (item.style || "normal") === definition.style);
    if (compatible) { proposedRegion.font = compatible.id; continue; }
    let id = `nandeck_${slugify(definition.family).replace(/-/g, "_")}`.slice(0, 32), suffix = 2;
    while ([...currentFonts, ...newFonts.values()].some(item => item.id === id)) id = `${id.slice(0, 28)}_${suffix++}`;
    const next = { id, family: definition.family, weight: definition.weight, style: definition.style };
    newFonts.set(id, next); proposedRegion.font = id;
  }
  if (newFonts.size) {
    if (!systemFile) throw new Error("cannot add a font until this game has a versioned layout source");
    const doc = documentFor(systemFile), fontsNode = doc.get("fonts", true);
    if (!fontsNode?.add) throw new Error(`${systemFile} has no editable fonts list`);
    for (const fontValue of newFonts.values()) {
      fontsNode.add(fontValue); changes.push({ id: `font:${fontValue.id}`, path: "font", before: null, after: fontValue, source_file: systemFile });
    }
    dirty.add(systemFile);
    parsed.warnings.push("Imported nanDECK font families have no versioned font asset yet; add one before calling the design production-reproducible.");
  }
  for (const proposedRegion of parsed.layout.regions) {
    const binding = parsed.bindings[proposedRegion.id];
    if (!binding?.source_file || !binding.baseline) continue;
    const origin = family.origins[proposedRegion.id];
    if (origin !== binding.source_file) {
      conflicts.push({ id: proposedRegion.id, path: "source_file", base: binding.source_file, proposed: binding.source_file, current: origin || null });
      continue;
    }
    const currentRegion = family.layout.regions.find(region => region.id === proposedRegion.id);
    if (!currentRegion) { conflicts.push({ id: proposedRegion.id, path: "*", base: "region", proposed: "edited", current: null }); continue; }
    const node = regionNode(documentFor(binding.source_file), proposedRegion.id);
    if (!node) { conflicts.push({ id: proposedRegion.id, path: "source", base: binding.source_file, proposed: "edited", current: "region missing" }); continue; }
    for (const key of SUPPORTED_REGION_FIELDS) {
      if (key === "type" || key === "show_if") continue;
      const baseline = valueAt(binding.baseline, key), adapterBaseline = valueAt(binding.adapter_baseline || binding.baseline, key), proposed = valueAt(proposedRegion, key);
      if (proposed === undefined || equal(adapterBaseline, proposed)) continue;
      const current = valueAt(currentRegion, key);
      if (equal(current, proposed)) continue;
      if (!equal(current, baseline)) { conflicts.push({ id: proposedRegion.id, path: key, base: baseline ?? null, proposed: proposed ?? null, current: current ?? null }); continue; }
      node.set(key, clone(proposed));
      dirty.add(binding.source_file);
      changes.push({ id: proposedRegion.id, path: key, before: baseline ?? null, after: proposed ?? null, source_file: binding.source_file });
    }
  }
  const baselineCard = parsed.forgeMeta.baseline_card || {}, proposedCard = parsed.layout.card || {};
  if (!systemFile) throw new Error("this game uses Forge's generated fallback layout; import the script as a candidate and choose a versioned design before writing");
  if (systemFile !== sources.systemFile) conflicts.push({ id: "card", path: "system_file", base: systemFile, proposed: systemFile, current: sources.systemFile });
  else {
    const currentCard = family.layout.card || {}, doc = documentFor(systemFile), cardNode = doc.get("card", true);
    for (const key of ["w_mm", "h_mm"]) {
      if (proposedCard[key] === undefined || equal(proposedCard[key], baselineCard[key])) continue;
      if (!equal(currentCard[key], baselineCard[key]) && !equal(currentCard[key], proposedCard[key])) {
        conflicts.push({ id: "card", path: key, base: baselineCard[key], proposed: proposedCard[key], current: currentCard[key] }); continue;
      }
      cardNode.set(key, proposedCard[key]);
      dirty.add(systemFile);
      changes.push({ id: "card", path: key, before: baselineCard[key], after: proposedCard[key], source_file: systemFile });
    }
  }
  const files = [];
  for (const [path, entry] of docs) {
    if (!dirty.has(path)) continue;
    const content = String(entry.document);
    if (content !== entry.raw) files.push({ path, content });
  }
  const affectedFamilies = sources.families.filter(candidate => changes.some(change => {
    if (change.id === "card") return change.source_file === sources.systemFile;
    if (String(change.id).startsWith("font:")) return candidate.id === family.id;
    return candidate.origins?.[change.id] === change.source_file;
  })).map(candidate => candidate.id);
  return {
    ok: conflicts.length === 0,
    family: family.id,
    source_hash: parsed.forgeMeta.source_hash || null,
    current_source_hash: sources.sourceHash,
    stale: parsed.forgeMeta.source_hash !== sources.sourceHash,
    changes, files, conflicts, affected_families: affectedFamilies,
    warnings: parsed.warnings,
    unsupported: parsed.unsupported,
  };
}
