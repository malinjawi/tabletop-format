import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import yaml from "js-yaml";
import { Ajv } from "ajv";
import { parseDocument } from "yaml";

import { cardMatchesFamily } from "./card-design.mjs";
import { currentNandeckSources } from "./nandeck-layout.mjs";

export const SVG_DESIGN_FORMAT = "forge-svg-family";
export const SVG_DESIGN_VERSION = 1;
export const MAX_SVG_DESIGN_BYTES = 5 * 1024 * 1024;

const paletteSchema = JSON.parse(readFileSync(new URL("../../schemas/layout.schema.json", import.meta.url), "utf8")).properties.palette;
const validPalette = new Ajv({ allErrors: true }).compile(paletteSchema);

const EDITABLE_FIELDS = ["x", "y", "w", "h", "d", "fill", "stroke", "stroke_w_mm", "radius_mm", "opacity", "color", "bg", "group", "text_style", "border", "shadow_spec", "src", "text"];
const clone = value => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => isDeepStrictEqual(a, b);
const round = value => Math.round(Number(value) * 1000) / 1000;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const safeName = value => String(value || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "game";
const xml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const unb64 = value => JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));

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

function staticColor(value) {
  const text = String(value || "").trim();
  if (text === "none" || text === "transparent") return text;
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(text)) return `#${[...text.slice(1)].map(char => char.repeat(2)).join("")}`.toUpperCase();
  return null;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round(parsed) : fallback;
}

function dig(value, path) {
  let next = value;
  for (const key of String(path || "").split(".").filter(Boolean)) next = next?.[key];
  return next;
}

function sourceValue(card, printing, region) {
  if (region.text != null) return String(region.text);
  const context = { card, printing, attributes: card?.attributes || {} };
  const resolveSource = source => {
    const raw = String(source || "").trim();
    if (raw.startsWith("card.")) return dig(card, raw.slice(5));
    if (raw.startsWith("printing.")) return dig(printing, raw.slice(9));
    return dig(context, raw);
  };
  let value;
  if (String(region.src || "").includes("{")) value = String(region.src).replace(/\{([^}]+)\}/g, (_, path) => resolveSource(path.trim()) ?? "");
  else value = resolveSource(region.src);
  if (Array.isArray(value)) value = value.join(region.separator || ", ");
  return `${region.prefix || ""}${value ?? ""}${region.suffix || ""}`;
}

function familySpecimen(cards, printings, family) {
  const preferred = new Set(family.specimens || []);
  const card = cards.find(candidate => preferred.has(candidate.id) && cardMatchesFamily(candidate, family.match || {}))
    || cards.find(candidate => cardMatchesFamily(candidate, family.match || {})) || null;
  return { card, printing: card ? printings.find(item => item.card_id === card.id) || null : null };
}

function adapterBaseline(region) {
  const out = {};
  for (const key of ["x", "y", "w", "h", "d", "stroke_w_mm", "radius_mm", "opacity"])
    if (region[key] !== undefined && Number.isFinite(Number(region[key]))) out[key] = number(region[key]);
  for (const key of ["fill", "stroke", "color", "bg"]) {
    const color = staticColor(region[key]); if (color != null) out[key] = color;
  }
  out.group = region.group || "";
  out.text_style = region.text_style || "";
  out.border = region.border ? clone(region.border) : null;
  out.shadow_spec = region.shadow_spec ? clone(region.shadow_spec) : null;
  if (["text","richtext","body","badge","pips"].includes(region.type)) { out.src = region.src ?? ""; out.text = region.text ?? ""; }
  return out;
}

function colorFor(region, key, fallback) {
  return staticColor(region[key]) || fallback;
}

function regionElement(region, sourceFile, card, printing) {
  const baseline = Object.fromEntries(EDITABLE_FIELDS.filter(key => region[key] !== undefined).map(key => [key, clone(region[key])]));
  const adapter = adapterBaseline(region), common = [
    `id="forge-region-${xml(region.id)}"`, `data-forge-region="${xml(region.id)}"`,
    `data-forge-source="${xml(sourceFile || "")}"`, `data-forge-baseline="${b64({ baseline, adapter_baseline: adapter, type: region.type })}"`,
    `data-forge-group="${xml(adapter.group)}"`, `data-forge-text-style="${xml(adapter.text_style)}"`, `data-forge-border="${b64(adapter.border)}"`, `data-forge-shadow="${b64(adapter.shadow_spec)}"`,
    `inkscape:label="${xml(`${region.id} · ${region.type} · ${region.src || region.text || "visual"}`)}"`,
  ].join(" ");
  const opacity = adapter.opacity ?? (region.type === "rect" ? 0.92 : 0.18);
  const title = `<title>${xml(`${region.id} — ${region.type} — ${region.src || "visual"} — ${sourceFile || "generated"}`)}</title>`;
  if (region.type === "badge") {
    const d = number(region.d ?? Math.min(region.w || 0, region.h || 0), 1), x = number(region.x), y = number(region.y);
    return `<circle ${common} cx="${number(x + d / 2)}" cy="${number(y + d / 2)}" r="${number(d / 2)}" fill="${xml(colorFor(region, "bg", "#DDE5EA"))}" stroke="${xml(colorFor(region, "color", "#27323A"))}" stroke-width="${number(region.stroke_w_mm, 0.25)}" opacity="${opacity}">${title}</circle>`;
  }
  const x = number(region.x), y = number(region.y), w = number(region.w ?? region.d, 1), h = number(region.h ?? region.d, 1);
  let fill = "#7CC9FF", stroke = "#1675A7";
  if (region.type === "rect") { fill = colorFor(region, "fill", "#DDE5EA"); stroke = colorFor(region, "stroke", "#27323A"); }
  else if (["text", "richtext", "body"].includes(region.type)) { fill = colorFor(region, "color", "#4C9F70"); stroke = colorFor(region, "color", "#28764A"); }
  else if (["image", "background"].includes(region.type)) { fill = "#A992D4"; stroke = "#5F3E98"; }
  const radius = number(region.radius_mm, 0), width = number(region.stroke_w_mm, 0.2);
  return `<rect ${common} x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="${xml(fill)}" fill-opacity="${region.type === "rect" ? 1 : 0.2}" stroke="${xml(stroke)}" stroke-width="${width}" opacity="${opacity}">${title}</rect>`;
}

function labelElement(region, card, printing) {
  const x = number(region.x ?? 0), y = number(region.y ?? 0), h = number(region.h ?? region.d ?? 3, 3);
  const text = sourceValue(card, printing, region) || region.id;
  const concise = String(text).replace(/\s+/g, " ").slice(0, 68);
  return `<text x="${number(x + 0.7)}" y="${number(y + Math.max(2.2, Math.min(h - 0.5, 3.2)))}" font-family="sans-serif" font-size="2.2" fill="#101820" opacity="0.86">${xml(concise)}</text>`;
}

/**
 * Produce one standards-based, millimetre-native SVG template for a Forge family.
 * @param {any} layout
 * @param {{family?:string,sourceHash?:string,origins?:Record<string,string>,systemFile?:string|null,specimen?:{card?:any,printing?:any}}} options
 */
export function layoutToSvg(layout, options = {}) {
  const { family, sourceHash, origins = {}, systemFile = null, specimen = {} } = options;
  const card = layout.card || {}, w = number(card.w_mm, 63), h = number(card.h_mm, 88);
  const regions = layout.regions || [], meta = {
    format: SVG_DESIGN_FORMAT, version: SVG_DESIGN_VERSION, family, source_hash: sourceHash,
    system_file: systemFile, card: { w_mm: w, h_mm: h },
    specimen: { card_id: specimen.card?.id || null, printing_id: specimen.printing?.id || null },
    palette: clone(layout.palette || {}),
    text_styles: clone(layout.text_styles || {}),
    back: clone(layout.back || {}),
    regions: Object.fromEntries(regions.map(region => [region.id, {
      source_file: origins[region.id] || systemFile, type: region.type,
      baseline: Object.fromEntries(EDITABLE_FIELDS.filter(key => region[key] !== undefined).map(key => [key, clone(region[key])])),
      adapter_baseline: adapterBaseline(region),
    }])),
  };
  const objects = regions.map(region => regionElement(region, origins[region.id] || systemFile, specimen.card, specimen.printing)).join("\n    ");
  const labels = regions.map(region => labelElement(region, specimen.card, specimen.printing)).join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" data-forge-format="${SVG_DESIGN_FORMAT}" data-forge-version="${SVG_DESIGN_VERSION}" data-forge-text-styles="${b64(layout.text_styles || {})}" data-forge-back="${b64(layout.back || {})}" ${layout.palette ? `data-forge-palette="${b64(layout.palette)}"` : ""}>
  <metadata id="forge-design-metadata">${b64(meta)}</metadata>
  <rect id="forge-card-boundary" x="0" y="0" width="${w}" height="${h}" fill="#F5F7F8" stroke="#18242D" stroke-width="0.35"/>
  <g inkscape:groupmode="layer" inkscape:label="Forge editable regions" id="forge-editable-regions">
    ${objects}
  </g>
  <g inkscape:groupmode="layer" inkscape:label="Forge labels (locked reference)" id="forge-reference-labels" pointer-events="none">
    ${labels}
  </g>
</svg>
`;
}

/** Build a deterministic family kit for Inkscape, Affinity Designer, Illustrator, or any SVG editor. */
export function buildSvgDesignProject(gameDirValue) {
  const gameDir = resolve(gameDirValue), game = documentAt(gameDir, "game.yaml");
  const cards = JSON.parse(readFileSync(safeDesignPath(gameDir, "components/cards.json"), "utf8"));
  const printings = JSON.parse(readFileSync(safeDesignPath(gameDir, "components/printings.json"), "utf8"));
  const sources = currentNandeckSources(gameDir), entries = new Map(), reports = [], rootName = safeName(game.id || basename(gameDir));
  for (const family of sources.families) {
    const name = sources.families.length === 1 ? rootName : `${rootName}-${safeName(family.id)}`;
    const specimen = familySpecimen(cards, printings, family);
    const content = layoutToSvg(family.layout, { family: family.id, sourceHash: sources.sourceHash,
      origins: family.origins, systemFile: sources.systemFile, specimen });
    entries.set(`${name}.svg`, Buffer.from(content));
    reports.push({ family: family.id, label: family.label || family.id, file: `${name}.svg`, regions: family.layout.regions?.length || 0,
      specimen: specimen.card?.id || null });
  }
  const manifest = {
    format: SVG_DESIGN_FORMAT, version: SVG_DESIGN_VERSION,
    game: { id: game.id || basename(gameDir), title: game.title || game.id || basename(gameDir) },
    source_hash: sources.sourceHash, unit: "MM", families: reports,
    round_trip: {
      supported: ["move/resize front-region boxes", "badge position/diameter", "flat shape fill/stroke", "stroke width", "corner radius", "opacity", "Forge named-group metadata", "Forge structured border/shadow metadata", "project-level Forge card-back metadata"],
      preserved: ["bindings", "conditions", "dynamic palette colors", "gradients", "fonts", "rich text", "symbols", "legacy CSS effects", "declarative card-back layers"],
      rejected: ["scripts", "event handlers", "external links", "rotated or skewed editable regions"],
    },
    limitations: [
      "Forge remains canonical. The SVG is an editor working copy with a content-addressed three-way merge baseline.",
      "This adapter edits declared region geometry and simple visual properties; it does not claim arbitrary SVG-to-Forge conversion.",
      "The shared back is preserved and three-way merged as project metadata; this family SVG does not expose its back layers as editor objects.",
      "Use the returned Forge dry run to inspect every affected family before committing or opening a pull request.",
    ],
  };
  entries.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  entries.set("README.md", Buffer.from(`# ${manifest.game.title} — SVG family editor kit

Open one family SVG in Inkscape, Affinity Designer, Illustrator, Figma, or another SVG editor. Move or resize a region object, then return that single SVG on the Forge Design page. Keep the embedded \`forge-design-metadata\`: it carries the source ownership and three-way merge baseline.

The document uses millimetres and the real card trim size. The **Forge editable regions** layer contains one named object per canonical region. The reference-label layer is informational and is not imported. Forge shows an exact before/after render, validates the game, and only then creates a commit or pull request.

See \`manifest.json\` for the deliberately bounded round-trip surface. Native editor files can still travel byte-for-byte inside a full \`.forge-project.zip\`; the SVG adapter is the shared, reviewable interchange layer.
`));
  return { manifest, entries };
}

function attributes(source) {
  const out = {};
  for (const match of source.matchAll(/([:\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[match[1]] = match[3] ?? match[4] ?? "";
  if (out.style) for (const declaration of out.style.split(";")) {
    const index = declaration.indexOf(":"); if (index < 1) continue;
    const key = declaration.slice(0, index).trim(), value = declaration.slice(index + 1).trim();
    if (key && out[key] === undefined) out[key] = value;
  }
  return out;
}

function bounded(value, label, { positive = false } = {}) {
  const parsed = Number(String(value).replace(/mm$/i, ""));
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 1000 || (positive && parsed <= 0)) throw new Error(`invalid SVG ${label}: ${value}`);
  return round(parsed);
}

function transformBox(box, transform, warnings, id) {
  if (!transform) return Object.fromEntries(Object.entries(box).map(([key, value]) => [key, round(value)]));
  let a = 1, d = 1, e = 0, f = 0;
  const translate = transform.match(/^translate\(\s*([-+\d.eE]+)(?:[ ,]+([-+\d.eE]+))?\s*\)$/);
  const matrix = transform.match(/^matrix\(\s*([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)\s*\)$/);
  if (translate) { e = bounded(translate[1], `${id} translate x`); f = bounded(translate[2] || 0, `${id} translate y`); }
  else if (matrix) {
    [, a, , , d, e, f] = matrix.map(Number);
    if (![a, d, e, f].every(Number.isFinite) || a <= 0 || d <= 0 || Math.abs(a) > 20 || Math.abs(d) > 20
      || Math.abs(Number(matrix[2])) > 0.000001 || Math.abs(Number(matrix[3])) > 0.000001)
      throw new Error(`${id} uses a rotated, skewed, or invalid transform; Forge can only import move and axis-aligned resize`);
  } else throw new Error(`${id} uses an unsupported transform; apply/flatten it in the SVG editor before returning the file`);
  warnings.push(`${id}: flattened an editor transform into canonical millimetre geometry`);
  return { x: round(box.x * a + e), y: round(box.y * d + f), w: round(box.w * a), h: round(box.h * d) };
}

function parsedColor(value) {
  if (value == null) return null;
  const color = staticColor(value);
  if (color != null) return color;
  const rgb = String(value).match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb && rgb.slice(1).every(item => Number(item) <= 255)) return `#${rgb.slice(1).map(item => Number(item).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  return null;
}

function parsedGroup(value, id) {
  const group = String(value || "");
  if (group && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(group)) throw new Error(`${id} has an invalid Forge group id`);
  return group;
}

function parsedTextStyles(value) {
  let parsed;
  try { parsed = unb64(value); } catch { throw new Error("SVG has invalid Forge text-style metadata"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SVG has invalid Forge text-style metadata");
  for (const [id, style] of Object.entries(parsed)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !style || typeof style !== "object" || Array.isArray(style))
      throw new Error(`SVG has invalid Forge text style '${id}'`);
  }
  return clone(parsed);
}

function parsedContentBindings(value, binding) {
  let parsed; try { parsed=unb64(value); } catch { throw new Error("Invalid Forge field connection"); }
  if (!parsed || typeof parsed!=="object" || Array.isArray(parsed) || !["text","richtext","body","badge","pips"].includes(binding.type) || binding.adapter_baseline?.src === undefined)
    throw new Error("Invalid Forge field connection");
  for (const [key,next] of Object.entries(parsed)) {
    if (!["src","text"].includes(key) || (next!==null && typeof next!=="string")) throw new Error("Invalid Forge field connection");
    if (key==="src" && next!==null && !/^(?:card\.(?:name|type|text|subtypes|keywords|deck_limit|attributes\.[a-z0-9_]{1,32})|printing\.(?:flavor_text|artist|collector_number))$/.test(next)) throw new Error("Invalid Forge field connection");
    if (key==="text" && next?.length>5000) throw new Error("Static text is longer than 5000 characters");
  }
  return parsed;
}

function parsedColorBindings(value) {
  let parsed;
  try { parsed = unb64(value); } catch { throw new Error("SVG has invalid Forge color bindings"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SVG has invalid Forge color bindings");
  for (const [key, color] of Object.entries(parsed)) {
    if (!["fill", "stroke", "color", "bg"].includes(key) || !(color === null || typeof color === "string" && (parsedColor(color) !== null || /^palette(?:-(?:dark|deep|light|soft|paper|metallic|gradient|shell-motif|panel-motif))?$/.test(color))))
      throw new Error("SVG has invalid Forge color bindings");
  }
  return parsed;
}

function parsedPalette(value) {
  let parsed;
  try { parsed = unb64(value); } catch { throw new Error("SVG has invalid Forge palette metadata"); }
  if (!validPalette(parsed)) throw new Error("SVG has invalid Forge palette metadata");
  return clone(parsed);
}

function parsedBack(value) {
  let parsed;
  try { parsed = unb64(value); } catch { throw new Error("SVG has invalid Forge card-back metadata"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SVG has invalid Forge card-back metadata");
  if (parsed.regions !== undefined && (!Array.isArray(parsed.regions) || !parsed.regions.length))
    throw new Error("SVG card-back regions must be a non-empty array");
  return clone(parsed);
}

function parsedEffectMetadata(value, id, kind) {
  let parsed;
  try { parsed = unb64(value); } catch { throw new Error(`${id} has invalid Forge ${kind} metadata`); }
  if (parsed == null) return null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${id} has invalid Forge ${kind} metadata`);
  if (kind === "border") {
    if (!/^#[0-9a-f]{6}$/i.test(String(parsed.color || "")) || !Number.isFinite(Number(parsed.width_mm))
      || Number(parsed.width_mm) < 0 || Number(parsed.width_mm) > 5 || !["solid", "dashed", "dotted", "double"].includes(parsed.style))
      throw new Error(`${id} has invalid Forge border metadata`);
    return { color: String(parsed.color).toUpperCase(), width_mm: round(parsed.width_mm), style: parsed.style };
  }
  const numeric = ["x_mm", "y_mm", "blur_mm", "spread_mm", "opacity"];
  if (!/^#[0-9a-f]{6}$/i.test(String(parsed.color || "")) || numeric.some(key => !Number.isFinite(Number(parsed[key])))
    || Number(parsed.x_mm) < -20 || Number(parsed.x_mm) > 20 || Number(parsed.y_mm) < -20 || Number(parsed.y_mm) > 20
    || Number(parsed.blur_mm) < 0 || Number(parsed.blur_mm) > 20 || Number(parsed.spread_mm) < -10 || Number(parsed.spread_mm) > 20
    || Number(parsed.opacity) < 0 || Number(parsed.opacity) > 1)
    throw new Error(`${id} has invalid Forge shadow metadata`);
  return { x_mm: round(parsed.x_mm), y_mm: round(parsed.y_mm), blur_mm: round(parsed.blur_mm), spread_mm: round(parsed.spread_mm),
    color: String(parsed.color).toUpperCase(), opacity: round(parsed.opacity), inset: !!parsed.inset };
}

/** Parse only Forge-generated declarative SVG objects. Nothing is rendered or executed. */
export function parseSvgDesign(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (bytes.length > MAX_SVG_DESIGN_BYTES) throw new Error("SVG design is larger than 5 MB");
  const source = bytes.toString("utf8");
  if (source.includes("\0")) throw new Error("SVG design contains NUL bytes");
  if (/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|\son[a-z]+\s*=/i.test(source)) throw new Error("SVG design contains active or unsafe XML content");
  if (/\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|file:|data:text\/html|javascript:)/i.test(source)) throw new Error("SVG design contains an external or active link");
  const metadataMatch = source.match(/<metadata\b[^>]*\bid=["']forge-design-metadata["'][^>]*>([^<]+)<\/metadata>/i);
  if (!metadataMatch) throw new Error("SVG is missing Forge design metadata; import it as a source asset or map it as a new family first");
  let meta;
  try { meta = unb64(metadataMatch[1].trim()); } catch { throw new Error("SVG has invalid Forge design metadata"); }
  if (meta.format !== SVG_DESIGN_FORMAT || meta.version !== SVG_DESIGN_VERSION) throw new Error(`unsupported Forge SVG format: ${meta.format} v${meta.version}`);
  const rootMatch = source.match(/<svg\b([^>]*)>/i), rootAttrs = rootMatch ? attributes(rootMatch[1]) : {};
  const textStyles = rootAttrs["data-forge-text-styles"] !== undefined ? parsedTextStyles(rootAttrs["data-forge-text-styles"]) : clone(meta.text_styles || {});
  const palette = rootAttrs["data-forge-palette"] !== undefined ? parsedPalette(rootAttrs["data-forge-palette"]) : clone(meta.palette || {});
  const back = rootAttrs["data-forge-back"] !== undefined ? parsedBack(rootAttrs["data-forge-back"]) : clone(meta.back || {});
  const warnings = [], unsupported = [], regions = new Map();
  const elementPattern = /<(rect|circle)\b([^>]*\bdata-forge-region\s*=\s*(?:"[^"]+"|'[^']+')[^>]*)\/?\s*>/gi;
  for (const match of source.matchAll(elementPattern)) {
    const tag = match[1].toLowerCase(), attrs = attributes(match[2]), id = attrs["data-forge-region"];
    if (!id || regions.has(id)) throw new Error(`SVG has a missing or duplicate Forge region id: ${id || "unknown"}`);
    const binding = meta.regions?.[id]; if (!binding) throw new Error(`SVG region '${id}' is not declared by its Forge metadata`);
    const proposed = clone(binding.baseline || {}), adapter = binding.adapter_baseline || {};
    if (attrs["data-forge-group"] !== undefined && adapter.group !== undefined) proposed.group = parsedGroup(attrs["data-forge-group"], id);
    if (attrs["data-forge-text-style"] !== undefined && adapter.text_style !== undefined) proposed.text_style = parsedGroup(attrs["data-forge-text-style"], `${id} text style`);
    if (attrs["data-forge-border"] !== undefined && adapter.border !== undefined) proposed.border = parsedEffectMetadata(attrs["data-forge-border"], id, "border");
    if (attrs["data-forge-shadow"] !== undefined && adapter.shadow_spec !== undefined) proposed.shadow_spec = parsedEffectMetadata(attrs["data-forge-shadow"], id, "shadow");
    if (tag === "circle" && binding.type === "badge") {
      const cx = bounded(attrs.cx, `${id} cx`), cy = bounded(attrs.cy, `${id} cy`), r = bounded(attrs.r, `${id} radius`, { positive: true });
      const box = transformBox({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, attrs.transform, warnings, id);
      proposed.x = box.x; proposed.y = box.y; proposed.d = round(Math.min(box.w, box.h));
      const bg = parsedColor(attrs.fill), color = parsedColor(attrs.stroke);
      if (bg != null && adapter.bg !== undefined) proposed.bg = bg;
      if (color != null && adapter.color !== undefined) proposed.color = color;
    } else if (tag === "rect") {
      const box = transformBox({ x: bounded(attrs.x, `${id} x`), y: bounded(attrs.y, `${id} y`),
        w: bounded(attrs.width, `${id} width`, { positive: true }), h: bounded(attrs.height, `${id} height`, { positive: true }) }, attrs.transform, warnings, id);
      proposed.x = box.x; proposed.y = box.y; if (binding.baseline?.w !== undefined) proposed.w = box.w; if (binding.baseline?.h !== undefined) proposed.h = box.h;
      const fill = parsedColor(attrs.fill), stroke = parsedColor(attrs.stroke);
      if (binding.type === "rect") {
        if (fill != null && adapter.fill !== undefined) proposed.fill = fill;
        if (stroke != null && adapter.stroke !== undefined) proposed.stroke = stroke;
      } else if (["text", "richtext", "body"].includes(binding.type) && fill != null && adapter.color !== undefined) proposed.color = fill;
      if (attrs.rx !== undefined && adapter.radius_mm !== undefined) proposed.radius_mm = bounded(attrs.rx, `${id} corner radius`);
    } else unsupported.push({ id, type: tag, reason: `expected ${binding.type === "badge" ? "circle" : "rect"}` });
    if (attrs["stroke-width"] !== undefined && adapter.stroke_w_mm !== undefined) proposed.stroke_w_mm = bounded(attrs["stroke-width"], `${id} stroke width`);
    if (attrs.opacity !== undefined && adapter.opacity !== undefined) proposed.opacity = bounded(attrs.opacity, `${id} opacity`);
    const colorBindings = attrs["data-forge-colors"] === undefined ? {} : parsedColorBindings(attrs["data-forge-colors"]);
    const contentBindings = attrs["data-forge-content"] === undefined ? {} : parsedContentBindings(attrs["data-forge-content"], binding);
    Object.assign(proposed, colorBindings, contentBindings);
    regions.set(id, { id, proposed, binding, colorBindings, contentBindings });
  }
  for (const id of Object.keys(meta.regions || {})) if (!regions.has(id)) warnings.push(`${id}: editable object is missing; deletion is ignored and the canonical region is preserved`);
  return { meta, palette, text_styles: textStyles, back, regions, warnings, unsupported, objects: regions.size };
}

function regionNode(document, id) {
  const sequence = document.get("regions", true);
  if (!sequence?.items) return null;
  return sequence.items.find(item => String(item.get?.("id")) === id) || null;
}

/** Three-way merge an edited Forge SVG family working copy into canonical YAML. */
export function analyzeSvgDesignImport(gameDirValue, input) {
  const gameDir = resolve(gameDirValue), parsed = parseSvgDesign(input), sources = currentNandeckSources(gameDir);
  const family = sources.families.find(candidate => candidate.id === parsed.meta.family);
  if (!family) throw new Error(`SVG targets unknown family '${parsed.meta.family}'`);
  const conflicts = [], changes = [], docs = new Map(), dirty = new Set();
  const documentFor = rel => {
    if (!docs.has(rel)) {
      const path = safeDesignPath(gameDir, rel), raw = readFileSync(path, "utf8"), document = parseDocument(raw, { keepSourceTokens: true });
      if (document.errors.length) throw new Error(`cannot parse ${rel}: ${document.errors[0].message}`);
      docs.set(rel, { raw, document });
    }
    return docs.get(rel).document;
  };
  const baselineStyles = parsed.meta.text_styles || {}, nextStyles = parsed.text_styles || {}, currentStyles = family.layout.text_styles || {};
  if (!equal(nextStyles, baselineStyles)) {
    const systemFile = parsed.meta.system_file;
    if (!systemFile || systemFile !== sources.systemFile) conflicts.push({ id: "$text_styles", path: "source_file", base: systemFile || null, proposed: systemFile || null, current: sources.systemFile || null });
    else if (!equal(currentStyles, baselineStyles)) conflicts.push({ id: "$text_styles", path: "text_styles", base: baselineStyles, proposed: nextStyles, current: currentStyles });
    else {
      const document = documentFor(systemFile);
      if (Object.keys(nextStyles).length) document.set("text_styles", clone(nextStyles)); else document.delete("text_styles");
      dirty.add(systemFile);
      changes.push({ id: "$text_styles", path: "text_styles", before: baselineStyles, after: nextStyles, source_file: systemFile });
    }
  }
  const baselineBack = parsed.meta.back || {}, nextBack = parsed.back || {}, currentBack = family.layout.back || {};
  if (!equal(nextBack, baselineBack)) {
    const systemFile = parsed.meta.system_file;
    if (!systemFile || systemFile !== sources.systemFile) conflicts.push({ id: "$back", path: "source_file", base: systemFile || null, proposed: systemFile || null, current: sources.systemFile || null });
    else if (!equal(currentBack, baselineBack)) conflicts.push({ id: "$back", path: "back", base: baselineBack, proposed: nextBack, current: currentBack });
    else {
      const document = documentFor(systemFile);
      if (Object.keys(nextBack).length) document.set("back", clone(nextBack)); else document.delete("back");
      dirty.add(systemFile);
      changes.push({ id: "$back", path: "back", before: baselineBack, after: nextBack, source_file: systemFile });
    }
  }
  const baselinePalette = parsed.meta.palette || {}, nextPalette = parsed.palette || {}, currentPalette = family.layout.palette || {};
  if (!equal(nextPalette, baselinePalette) && !equal(nextPalette, currentPalette)) {
    const systemFile = parsed.meta.system_file;
    if (!systemFile || systemFile !== sources.systemFile) conflicts.push({ id: "$palette", path: "source_file", base: systemFile || null, proposed: systemFile || null, current: sources.systemFile || null });
    else if (!equal(currentPalette, baselinePalette)) conflicts.push({ id: "$palette", path: "palette", base: baselinePalette, proposed: nextPalette, current: currentPalette });
    else {
      documentFor(systemFile).set("palette", clone(nextPalette));
      dirty.add(systemFile);
      changes.push({ id: "$palette", path: "palette", before: baselinePalette, after: nextPalette, source_file: systemFile });
    }
  }
  for (const { id, proposed, binding, colorBindings, contentBindings } of parsed.regions.values()) {
    if (contentBindings.src?.startsWith("card.attributes.")) {
      const key=contentBindings.src.slice(16), definitions=documentAt(gameDir,"game.yaml").attribute_definitions||[];
      if (!definitions.some(def=>def.key===key)) throw new Error(`Field connection names an undeclared field: ${key}`);
    }
    if (!binding?.source_file || !binding.baseline) continue;
    const origin = family.origins?.[id];
    if (origin !== binding.source_file) { conflicts.push({ id, path: "source_file", base: binding.source_file, proposed: binding.source_file, current: origin || null }); continue; }
    const current = family.layout.regions.find(region => region.id === id);
    if (!current) { conflicts.push({ id, path: "*", base: "region", proposed: "edited", current: null }); continue; }
    const node = regionNode(documentFor(binding.source_file), id);
    if (!node) { conflicts.push({ id, path: "source", base: binding.source_file, proposed: "edited", current: "region missing" }); continue; }
    for (const key of EDITABLE_FIELDS) {
      const baseline = binding.baseline[key], adapter = binding.adapter_baseline?.[key], next = proposed[key];
      if (next === undefined || (adapter === undefined && !Object.hasOwn(colorBindings, key)) || equal(adapter, next) || equal(baseline, next)) continue;
      const now = current[key];
      if (equal(now, next) || (now === undefined && next === null)) continue;
      if (!equal(now, baseline)) { conflicts.push({ id, path: key, base: baseline ?? null, proposed: next ?? null, current: now ?? null }); continue; }
      if ((["group", "text_style"].includes(key) && next === "") || (["border", "shadow_spec", "fill", "stroke", "color", "bg", "src", "text"].includes(key) && next === null)) node.delete(key);
      else node.set(key, clone(next));
      dirty.add(binding.source_file);
      changes.push({ id, path: key, before: baseline ?? null, after: next ?? null, source_file: binding.source_file });
    }
  }
  const files = [];
  for (const [path, entry] of docs) if (dirty.has(path)) {
    const content = String(entry.document); if (content !== entry.raw) files.push({ path, content });
  }
  const systemChanged = changes.some(change => change.id === "$text_styles" || change.id === "$back" || change.id === "$palette");
  const affectedFamilies = systemChanged ? sources.families.map(candidate => candidate.id)
    : sources.families.filter(candidate => changes.some(change => candidate.origins?.[change.id] === change.source_file)).map(candidate => candidate.id);
  return {
    ok: conflicts.length === 0, family: family.id, source_hash: parsed.meta.source_hash || null,
    current_source_hash: sources.sourceHash, stale: parsed.meta.source_hash !== sources.sourceHash,
    changes, files, conflicts, affected_families: affectedFamilies, warnings: parsed.warnings,
    unsupported: parsed.unsupported, objects: parsed.objects,
  };
}

/** Read-only summary for an arbitrary SVG that cannot safely update an existing family yet. */
export function inspectSvgCandidate(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (bytes.length > MAX_SVG_DESIGN_BYTES) throw new Error("SVG design is larger than 5 MB");
  const source = bytes.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|\son[a-z]+\s*=/i.test(source)) throw new Error("SVG design contains active or unsafe XML content");
  const root = source.match(/<svg\b([^>]*)>/i); if (!root) throw new Error("file is not an SVG document");
  const attrs = attributes(root[1]), viewBox = String(attrs.viewBox || "").trim().split(/[ ,]+/).map(Number);
  return { width: attrs.width || null, height: attrs.height || null,
    view_box: viewBox.length === 4 && viewBox.every(Number.isFinite) ? viewBox : null,
    objects: [...source.matchAll(/<(?:rect|circle|ellipse|path|text|image|g)\b/gi)].length,
    forge_regions: [...source.matchAll(/\bdata-forge-region\s*=/gi)].length,
    sha256: `sha256:${sha256(bytes)}` };
}
