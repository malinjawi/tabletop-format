import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const COMPONENT_SVG_FORMAT = "forge-component-family";
export const COMPONENT_SVG_VERSION = 1;
export const MAX_COMPONENT_SVG_BYTES = 5 * 1024 * 1024;

const round = value => Math.round(Number(value) * 1000) / 1000;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const xml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const unb64 = value => JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
const clone = value => structuredClone(value);
const equal = (a, b) => isDeepStrictEqual(a, b);
const safeName = value => String(value || "family").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "family";

function attrs(source) {
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
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 2000 || (positive && parsed <= 0))
    throw new Error(`invalid component SVG ${label}: ${value}`);
  return round(parsed);
}

function flatColor(value) {
  const text = String(value || "").trim();
  if (text === "none" || text === "transparent") return text;
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(text)) return `#${[...text.slice(1)].map(char => char.repeat(2)).join("")}`.toUpperCase();
  const rgb = text.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb && rgb.slice(1).every(item => Number(item) <= 255))
    return `#${rgb.slice(1).map(item => Number(item).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  return null;
}

function sameField(path, left, right) {
  if (["style.fill", "style.border"].includes(path)) return flatColor(left) === flatColor(right);
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) <= .01;
  return equal(left, right);
}

function transformBox(box, transform, warnings, id) {
  if (!transform) return box;
  const translate = transform.match(/^translate\(\s*([-+\d.eE]+)(?:[ ,]+([-+\d.eE]+))?\s*\)$/);
  const matrix = transform.match(/^matrix\(\s*([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)\s*\)$/);
  let a = 1, d = 1, e = 0, f = 0;
  if (translate) { e = bounded(translate[1], `${id} translate x`); f = bounded(translate[2] || 0, `${id} translate y`); }
  else if (matrix) {
    const values = matrix.slice(1).map(Number); [a, , , d, e, f] = values;
    if (!values.every(Number.isFinite) || a <= 0 || d <= 0 || Math.abs(values[1]) > .000001 || Math.abs(values[2]) > .000001)
      throw new Error(`${id} uses rotation, skew, or an invalid transform; flatten it to an axis-aligned box before returning the SVG`);
  } else throw new Error(`${id} uses an unsupported transform; apply or flatten it before returning the SVG`);
  warnings.push(`${id}: flattened an editor transform into canonical percentage geometry`);
  return { x: round(box.x * a + e), y: round(box.y * d + f), w: round(box.w * a), h: round(box.h * d) };
}

function boundary(family, width, height) {
  const style = family.style || {}, common = `data-forge-component-family="${xml(family.id)}" fill="${xml(style.fill)}" stroke="${xml(style.border)}" stroke-width="${round(style.border_mm || 0)}"`;
  if (family.shape === "circle") return `<ellipse ${common} cx="${round(width / 2)}" cy="${round(height / 2)}" rx="${round(width / 2)}" ry="${round(height / 2)}"/>`;
  if (family.shape === "hexagon") return `<polygon ${common} points="${round(width * .25)},0 ${round(width * .75)},0 ${width},${round(height / 2)} ${round(width * .75)},${height} ${round(width * .25)},${height} 0,${round(height / 2)}"/>`;
  return `<rect ${common} x="0" y="0" width="${width}" height="${height}" rx="${family.shape === "rounded-rectangle" ? round(style.radius_mm || Math.min(width, height) * .08) : 0}"/>`;
}

export function componentFamilyToSvg(family, piece = null, { sourceRef = "HEAD", sourceHash = null } = {}) {
  const width = Number(family.size_mm.width), height = Number(family.size_mm.height);
  const meta = { format: COMPONENT_SVG_FORMAT, version: COMPONENT_SVG_VERSION, family: family.id,
    source_ref: sourceRef, source_hash: sourceHash, unit: "MM", baseline: clone(family) };
  const regions = (family.regions || []).map(region => {
    const x = round(width * region.x / 100), y = round(height * region.y / 100);
    const w = round(width * region.w / 100), h = round(height * region.h / 100);
    const colors = { image: ["#E2D6F6", "#7652A8"], symbol: ["#FFF0BF", "#9A6700"], text: ["#D8F0E1", "#28764A"] }[region.type] || ["#E5E7EB", "#4B5563"];
    return { box: `<rect data-forge-component-region="${xml(region.id)}" inkscape:label="${xml(`${region.id} · ${region.type} · ${region.source}`)}" x="${x}" y="${y}" width="${w}" height="${h}" fill="${colors[0]}" fill-opacity="0.72" stroke="${colors[1]}" stroke-width="0.25"/>`,
      label: `<text x="${round(x + .8)}" y="${round(y + Math.min(h - .6, 3))}" font-family="sans-serif" font-size="2.1" fill="#17212B">${xml(`${region.id} · ${region.source}`)}</text>` };
  });
  const specimen = piece ? `${piece.id} · ${piece.name}` : "no matching piece";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" data-forge-format="${COMPONENT_SVG_FORMAT}" data-forge-version="${COMPONENT_SVG_VERSION}">
  <metadata id="forge-component-metadata">${b64(meta)}</metadata>
  <g inkscape:groupmode="layer" inkscape:label="Family appearance" id="forge-component-appearance">
    ${boundary(family, width, height)}
  </g>
  <g inkscape:groupmode="layer" inkscape:label="Editable content regions" id="forge-component-regions">
    ${regions.map(region => region.box).join("\n    ")}
  </g>
  <g inkscape:groupmode="layer" inkscape:label="Locked reference labels" id="forge-component-labels" pointer-events="none">
    ${regions.map(region => region.label).join("\n    ")}
    <text x="${round(width / 2)}" y="${round(height - 1)}" text-anchor="middle" font-family="sans-serif" font-size="1.7" fill="#111827" opacity=".62">Forge specimen: ${xml(specimen)}</text>
  </g>
</svg>\n`;
}

export function buildComponentSvgProject(design, pieces = [], { sourceRef = "HEAD" } = {}) {
  const sourceHash = hash(design), entries = new Map(), families = [];
  for (const family of design.families || []) {
    const piece = pieces.find(item => item.template_id === family.id)
      || pieces.find(item => (family.match?.kinds || []).includes(item.kind)) || null;
    const file = `family-templates/${safeName(family.id)}.svg`;
    entries.set(file, Buffer.from(componentFamilyToSvg(family, piece, { sourceRef, sourceHash })));
    families.push({ id: family.id, label: family.label, file, shape: family.shape,
      size_mm: family.size_mm, regions: family.regions?.length || 0, specimen: piece?.id || null });
  }
  const manifest = { format: COMPONENT_SVG_FORMAT, version: COMPONENT_SVG_VERSION, source_ref: sourceRef,
    source_hash: sourceHash, source_file: "templates/component-design.json", unit: "MM", families,
    round_trip: {
      supported: ["move and resize declared region boxes", "flat family fill and border colors", "family border width", "rounded-family corner radius"],
      preserved: ["field bindings", "region types", "typography", "alignment", "symbols", "piece data", "artwork paths", "production settings"],
      rejected: ["arbitrary SVG objects", "scripts and external links", "rotation and skew", "deleting canonical regions", "changing physical family size outside Forge"],
    },
    limitations: [
      "Only Forge-generated family SVGs with intact metadata can round-trip into the active renderer.",
      "SVG is a bounded editor working copy, not a lossless bridge for proprietary native effects.",
      "Always inspect Forge's visual dry run before creating the commit or pull request.",
    ] };
  entries.set("family-templates/manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  entries.set("family-templates/README.md", Buffer.from(`# Forge component-family SVG working copies\n\nOpen a family SVG in Inkscape, Affinity Designer, Illustrator, or another SVG editor. Move or resize the named region boxes, or change the family boundary's flat fill and stroke. Return one SVG through Forge Piece Studio for a field-level dry run.\n\nKeep the embedded \`forge-component-metadata\`. Forge rejects active content, external links, arbitrary object mapping, rotation, skew, and silent region deletion. Physical size, bindings, typography, symbols, piece rows, and production settings remain canonical in Forge.\n`));
  return { entries, manifest };
}

export function parseComponentSvg(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (bytes.length > MAX_COMPONENT_SVG_BYTES) throw new Error("component SVG is larger than 5 MB");
  const source = bytes.toString("utf8");
  if (source.includes("\0")) throw new Error("component SVG contains NUL bytes");
  if (/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|\son[a-z]+\s*=/i.test(source)) throw new Error("component SVG contains active or unsafe XML content");
  if (/\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|file:|data:text\/html|javascript:)/i.test(source)) throw new Error("component SVG contains an external or active link");
  const metadata = source.match(/<metadata\b[^>]*\bid=["']forge-component-metadata["'][^>]*>([^<]+)<\/metadata>/i);
  if (!metadata) throw new Error("SVG is missing Forge component metadata; add it as a source asset instead of replacing a family silently");
  let meta; try { meta = unb64(metadata[1].trim()); } catch { throw new Error("SVG has invalid Forge component metadata"); }
  if (meta.format !== COMPONENT_SVG_FORMAT || meta.version !== COMPONENT_SVG_VERSION || !meta.baseline?.id)
    throw new Error(`unsupported Forge component SVG: ${meta.format || "unknown"} v${meta.version || "unknown"}`);
  const width = bounded(meta.baseline.size_mm?.width, "family width", { positive: true });
  const height = bounded(meta.baseline.size_mm?.height, "family height", { positive: true });
  const warnings = [], proposed = clone(meta.baseline);
  const boundaryMatch = source.match(/<(rect|ellipse|polygon)\b([^>]*\bdata-forge-component-family\s*=\s*(?:"[^"]+"|'[^']+')[^>]*)\/?\s*>/i);
  if (!boundaryMatch) throw new Error("SVG is missing its Forge component family boundary");
  const boundaryAttrs = attrs(boundaryMatch[2]);
  if (boundaryAttrs["data-forge-component-family"] !== meta.family) throw new Error("SVG family boundary does not match its metadata");
  if (boundaryAttrs.transform) throw new Error("component family boundary transforms are not supported; change physical size or shape in Forge");
  const fill = flatColor(boundaryAttrs.fill), stroke = flatColor(boundaryAttrs.stroke);
  if (fill == null || stroke == null) throw new Error("family fill and stroke must remain flat colors for round-trip");
  proposed.style.fill = fill; proposed.style.border = stroke;
  if (boundaryAttrs["stroke-width"] !== undefined) proposed.style.border_mm = bounded(boundaryAttrs["stroke-width"], "family border width");
  if (meta.baseline.shape === "rounded-rectangle" && meta.baseline.style?.radius_mm !== undefined && boundaryAttrs.rx !== undefined)
    proposed.style.radius_mm = bounded(boundaryAttrs.rx, "family corner radius");
  const seen = new Set();
  const pattern = /<rect\b([^>]*\bdata-forge-component-region\s*=\s*(?:"[^"]+"|'[^']+')[^>]*)\/?\s*>/gi;
  for (const match of source.matchAll(pattern)) {
    const element = attrs(match[1]), id = element["data-forge-component-region"];
    if (!id || seen.has(id)) throw new Error(`component SVG has a missing or duplicate region id: ${id || "unknown"}`);
    seen.add(id);
    const region = proposed.regions.find(item => item.id === id);
    if (!region) throw new Error(`component SVG region '${id}' is not declared by its Forge baseline`);
    const box = transformBox({ x: bounded(element.x, `${id} x`), y: bounded(element.y, `${id} y`),
      w: bounded(element.width, `${id} width`, { positive: true }), h: bounded(element.height, `${id} height`, { positive: true }) }, element.transform, warnings, id);
    const normalized = { x: round(box.x / width * 100), y: round(box.y / height * 100),
      w: round(box.w / width * 100), h: round(box.h / height * 100) };
    if (normalized.x < 0 || normalized.y < 0 || normalized.w <= 0 || normalized.h <= 0
      || normalized.x + normalized.w > 100.001 || normalized.y + normalized.h > 100.001)
      throw new Error(`component region '${id}' extends beyond the finished family boundary`);
    Object.assign(region, normalized);
  }
  for (const region of proposed.regions || []) if (!seen.has(region.id))
    warnings.push(`${region.id}: editable region is missing; deletion is ignored and the canonical region is preserved`);
  for (const element of source.matchAll(/<(rect|ellipse|polygon|circle|path|image|use|line|polyline)\b([^>]*)>/gi)) {
    const elementAttrs = attrs(element[2]);
    if (elementAttrs["data-forge-component-family"] || elementAttrs["data-forge-component-region"]) continue;
    throw new Error(`component SVG contains an unmapped ${element[1].toLowerCase()} object; add artwork through Forge or keep this as a separate source asset`);
  }
  return { meta, proposed, warnings, objects: seen.size };
}

function valueAt(family, path) {
  if (path.startsWith("regions.")) {
    const [, id, key] = path.split("."); return family.regions?.find(region => region.id === id)?.[key];
  }
  return path.split(".").reduce((value, key) => value?.[key], family);
}

function setAt(family, path, value) {
  if (path.startsWith("regions.")) {
    const [, id, key] = path.split("."), region = family.regions.find(item => item.id === id); region[key] = value; return;
  }
  const keys = path.split("."); let target = family;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = value;
}

export function analyzeComponentSvgImport(currentDesign, input, { sourceExists = true } = {}) {
  const parsed = parseComponentSvg(input), baseline = parsed.meta.baseline;
  const currentFamily = currentDesign.families?.find(family => family.id === parsed.meta.family);
  if (!currentFamily) throw new Error(`component SVG targets unknown family '${parsed.meta.family}'`);
  const proposedFamily = parsed.proposed, candidate = clone(currentDesign), candidateFamily = candidate.families.find(family => family.id === parsed.meta.family);
  const paths = ["style.fill", "style.border", "style.border_mm", ...(baseline.shape === "rounded-rectangle" ? ["style.radius_mm"] : []),
    ...(baseline.regions || []).flatMap(region => ["x", "y", "w", "h"].map(key => `regions.${region.id}.${key}`))];
  const changes = [], conflicts = [];
  for (const path of paths) {
    const base = valueAt(baseline, path), current = valueAt(currentFamily, path), proposed = valueAt(proposedFamily, path);
    if (sameField(path, base, proposed)) continue;
    if (!sameField(path, current, base) && !sameField(path, current, proposed)) conflicts.push({ family: baseline.id, path, base, current, proposed });
    else if (!sameField(path, current, proposed)) {
      setAt(candidateFamily, path, proposed); changes.push({ family: baseline.id, path, before: current, after: proposed,
        source_file: "templates/component-design.json" });
    }
  }
  const currentHash = hash(currentDesign), stale = parsed.meta.source_hash !== currentHash;
  const files = changes.length && !conflicts.length ? [{ path: "templates/component-design.json", content: JSON.stringify(candidate, null, 2) + "\n" }] : [];
  return { family: baseline.id, source_hash: parsed.meta.source_hash, current_source_hash: currentHash, stale,
    changes, conflicts, warnings: parsed.warnings, objects: parsed.objects, candidate, files, source_exists: sourceExists };
}
