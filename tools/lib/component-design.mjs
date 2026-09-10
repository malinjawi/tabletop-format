import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import yaml from "js-yaml";
import { buildComponentSvgProject } from "./component-svg.mjs";
import { auditRights, RIGHTS_MANIFEST } from "../../platform/rights.mjs";

export const COMPONENT_DESIGN_PATH = "templates/component-design.json";
export const COMPONENT_EXPORT_PROFILE = "forge-component-production";
export const COMPONENT_EXPORT_VERSION = 6;

const PAGE = { A4: { width: 210, height: 297 }, Letter: { width: 215.9, height: 279.4 } };
const esc = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const round = value => Math.round(Number(value) * 1000) / 1000;
const deep = (value, path) => String(path || "").split(".").reduce((current, key) => current?.[key], value);
const mime = path => ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" }[extname(path).toLowerCase()] || "application/octet-stream");

export function defaultComponentDesign() {
  return {
    version: 1,
    production: { large_piece_overlap_mm: 8, bleed_mm: 2, safe_mm: 1.5,
      sheet: { page: "A4", margin_mm: 10, gap_mm: 3 } },
    families: [
      { id: "round-token", label: "Round token", match: { kinds: ["token", "counter", "marker"] }, shape: "circle",
        size_mm: { width: 20, height: 20 }, style: { fill: "#25334a", border: "#f0b44d", border_mm: 1.2,
          text: "#ffffff", font_family: "Arial", font_size_pt: 7.5 },
        regions: [{ id: "symbol", type: "symbol", source: "symbol", x: 25, y: 14, w: 50, h: 42, align: "center", font_size_pt: 11 },
          { id: "name", type: "text", source: "name", x: 12, y: 61, w: 76, h: 19, align: "center", uppercase: true, font_size_pt: 5.5 }] },
      { id: "square-tile", label: "Square tile", match: { kinds: ["tile"] }, shape: "rounded-rectangle",
        size_mm: { width: 50, height: 50 }, style: { fill: "#e8e0cf", border: "#38352f", border_mm: 1,
          text: "#24211d", font_family: "Arial", font_size_pt: 10, radius_mm: 3 },
        regions: [{ id: "art", type: "image", source: "art", x: 8, y: 8, w: 84, h: 66, align: "center" },
          { id: "name", type: "text", source: "name", x: 8, y: 78, w: 84, h: 13, align: "center", uppercase: true, font_size_pt: 7 }] },
      { id: "round-dial", label: "Round dial", match: { kinds: ["dial"] }, shape: "circle",
        size_mm: { width: 38, height: 38 }, style: { fill: "#642c32", border: "#e9c46a", border_mm: 1.5,
          text: "#ffffff", font_family: "Arial", font_size_pt: 9 },
        regions: [{ id: "name", type: "text", source: "name", x: 14, y: 22, w: 72, h: 19, align: "center", uppercase: true, font_size_pt: 7 },
          { id: "value", type: "text", source: "attributes.max_value", x: 28, y: 49, w: 44, h: 26, align: "center", font_size_pt: 12 }] },
      { id: "generic-piece", label: "Generic piece", match: { kinds: ["board", "standee", "die", "meeple", "tracker", "player-aid", "other"] }, shape: "rounded-rectangle",
        size_mm: { width: 40, height: 40 }, style: { fill: "#eef1f5", border: "#4b5563", border_mm: 1,
          text: "#1f2937", font_family: "Arial", font_size_pt: 8, radius_mm: 2 },
        regions: [{ id: "art", type: "image", source: "art", x: 8, y: 8, w: 84, h: 64, align: "center" },
          { id: "name", type: "text", source: "name", x: 8, y: 77, w: 84, h: 14, align: "center", uppercase: true, font_size_pt: 6.5 }] }
    ]
  };
}

export function loadComponentDesign(gameDir) {
  const path = join(gameDir, COMPONENT_DESIGN_PATH);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : defaultComponentDesign();
}

export function componentFamily(design, piece) {
  const families = design?.families || [];
  return families.find(family => family.id === piece.template_id)
    || families.find(family => family.match?.template_ids?.includes(piece.template_id))
    || families.find(family => (family.match?.kinds || []).includes(piece.kind))
    || families.find(family => family.id === "generic-piece") || families[0];
}

export function componentFace(piece, side = "front") {
  if (side !== "back" || !piece.back) return piece;
  const face = { ...piece, ...piece.back,
    template_id: piece.back.template_id || piece.template_id,
    attributes: { ...(piece.attributes || {}), ...(piece.back.attributes || {}) } };
  delete face.back;
  return face;
}

export function componentQuantity(piece, design) {
  const declared = Math.max(1, Number(piece?.quantity) || 1);
  const players = Number(design?.production?.player_count);
  return piece?.per_player && Number.isInteger(players) && players > 0 ? declared * players : declared;
}

function safeAsset(gameDir, rel) {
  if (!rel || typeof rel !== "string" || rel.startsWith("/") || rel.includes("..")) return null;
  const base = resolve(gameDir), path = resolve(gameDir, rel);
  if (!path.startsWith(base + "/") || !existsSync(path)) return null;
  return `data:${mime(path)};base64,${readFileSync(path).toString("base64")}`;
}

function gameSymbols(gameDir) {
  const path = join(gameDir, "game.yaml");
  if (!existsSync(path)) return [];
  return yaml.load(readFileSync(path, "utf8"))?.symbols || [];
}

function shapeMarkup(shape, x, y, width, height, attrs = "") {
  if (shape === "circle") return `<ellipse cx="${round(x + width / 2)}" cy="${round(y + height / 2)}" rx="${round(width / 2)}" ry="${round(height / 2)}" ${attrs}/>`;
  if (shape === "hexagon") {
    const points = [[x + width * .25, y], [x + width * .75, y], [x + width, y + height / 2], [x + width * .75, y + height], [x + width * .25, y + height], [x, y + height / 2]];
    return `<polygon points="${points.map(point => point.map(round).join(",")).join(" ")}" ${attrs}/>`;
  }
  const radius = shape === "rounded-rectangle" ? Math.min(width, height) * .08 : 0;
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="${round(radius)}" ${attrs}/>`;
}

export function componentDialValues(piece) {
  if (piece?.kind !== "dial") return [];
  const start = Number(piece.attributes?.start_value ?? 0), max = Number(piece.attributes?.max_value ?? 10);
  const step = Number(piece.attributes?.step ?? 1);
  if (![start, max, step].every(Number.isFinite) || step <= 0 || max < start) return [];
  const intervals = (max - start) / step;
  if (Math.abs(intervals - Math.round(intervals)) > 1e-7) return [];
  const count = Math.round(intervals) + 1;
  if (count < 2 || count > 36) return [];
  return Array.from({ length: count }, (_, index) => round(start + index * step));
}

function componentMechanicMarkup(piece, originX, originY, width, height, style) {
  const smallest = Math.min(width, height), cx = originX + width / 2, cy = originY + height / 2;
  if (piece.kind === "counter") {
    const value = piece.attributes?.start_value;
    return value == null ? "" : `<text data-forge-counter-value="start" x="${round(cx)}" y="${round(cy + smallest * .11)}" text-anchor="middle" fill="${esc(style.text)}" font-family="${esc(style.font_family)},sans-serif" font-size="${round(smallest * .34)}mm" font-weight="750">${esc(value)}</text>`;
  }
  const values = componentDialValues(piece); if (!values.length) return "";
  const radius = smallest * .39, tickInner = smallest * .43, tickOuter = smallest * .48;
  const scale = values.map((value, index) => {
    const angle = (-135 + index * 270 / (values.length - 1)) * Math.PI / 180;
    const x1 = cx + Math.cos(angle) * tickInner, y1 = cy + Math.sin(angle) * tickInner;
    const x2 = cx + Math.cos(angle) * tickOuter, y2 = cy + Math.sin(angle) * tickOuter;
    const tx = cx + Math.cos(angle) * radius, ty = cy + Math.sin(angle) * radius + smallest * .027;
    return `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}"/><text x="${round(tx)}" y="${round(ty)}">${esc(value)}</text>`;
  }).join("");
  return `<g data-forge-dial-scale="${esc(values.join(","))}" stroke="${esc(style.text)}" stroke-width="${round(Math.max(.22, smallest * .009))}" fill="${esc(style.text)}" font-family="${esc(style.font_family)},sans-serif" font-size="${round(Math.max(1.8, smallest * .065))}mm" font-weight="700" text-anchor="middle">${scale}<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(smallest * .055)}" fill="none" stroke-width="${round(Math.max(.3, smallest * .012))}" data-forge-hardware-guide="center-hole"/><path d="M ${round(cx - smallest * .075)} ${round(cy)} H ${round(cx + smallest * .075)} M ${round(cx)} ${round(cy - smallest * .075)} V ${round(cy + smallest * .075)}" fill="none" opacity=".65"/></g>`;
}

function pieceMarkup(gameDir, piece, family, originX = 0, originY = 0, { guides = true, bleed = 0,
  symbols = gameSymbols(gameDir), side = "front", instance = "0" } = {}) {
  const width = piece.size_mm?.width || family.size_mm.width, height = piece.size_mm?.height || family.size_mm.height;
  const style = family.style, align = { left: "start", center: "middle", right: "end" };
  const id = `${String(piece.id).replace(/[^A-Za-z0-9_-]/g, "_")}_${side}_${String(instance).replace(/[^A-Za-z0-9_-]/g, "_")}`;
  let body = `<g data-forge-piece="${esc(piece.id)}" data-forge-family="${esc(family.id)}" data-forge-side="${esc(side)}">`;
  if (bleed > 0) body += shapeMarkup(family.shape, originX - bleed, originY - bleed, width + bleed * 2, height + bleed * 2,
    `fill="${esc(style.fill)}" stroke="none" data-forge-area="bleed"`);
  body += shapeMarkup(family.shape, originX, originY, width, height,
    `fill="${esc(style.fill)}" stroke="${esc(style.border)}" stroke-width="${round(style.border_mm)}"`);
  body += componentMechanicMarkup(piece, originX, originY, width, height, style);
  for (const region of family.regions || []) {
    const x = originX + width * region.x / 100, y = originY + height * region.y / 100;
    const w = width * region.w / 100, h = height * region.h / 100, value = deep(piece, region.source);
    if (piece.kind === "counter" && region.type === "symbol" && (value == null || value === "")) continue;
    if (piece.kind === "dial" && region.source === "attributes.max_value") continue;
    if (region.type === "image") {
      const uri = safeAsset(gameDir, value);
      if (uri) {
        const clip = `clip_${id}_${region.id}`;
        body += `<defs><clipPath id="${clip}"><rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${round(Math.min(w, h) * .05)}"/></clipPath></defs>`;
        body += `<image href="${uri}" x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>`;
      }
      continue;
    }
    const symbol = region.type === "symbol" ? symbols.find(candidate => candidate.key === value) : null;
    const symbolAsset = symbol?.asset ? safeAsset(gameDir, symbol.asset) : null;
    if (symbolAsset) {
      body += `<image href="${symbolAsset}" x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" preserveAspectRatio="xMidYMid meet"/>`;
      continue;
    }
    const text = value == null || value === "" ? (region.type === "symbol" ? "◆" : "") : String(symbol?.glyph || value);
    const shown = region.uppercase ? text.toUpperCase() : text, anchor = align[region.align || "center"];
    const tx = anchor === "start" ? x : anchor === "end" ? x + w : x + w / 2;
    body += `<text x="${round(tx)}" y="${round(y + h * .72)}" text-anchor="${anchor}" fill="${esc(style.text)}" font-family="${esc(style.font_family)},sans-serif" font-size="${round((region.font_size_pt || style.font_size_pt) * .352778)}mm" font-weight="${region.type === "symbol" ? 700 : 600}">${esc(shown)}</text>`;
  }
  if (guides) body += shapeMarkup(family.shape, originX, originY, width, height,
    `fill="none" stroke="#d23f57" stroke-width="0.18" stroke-dasharray="1.2 0.8" data-forge-guide="trim"`);
  return body + "</g>";
}

export function renderComponentSvg(gameDir, piece, design = loadComponentDesign(gameDir), {
  guides = true, side = "front", bleed: bleedOverride = null,
} = {}) {
  const face = componentFace(piece, side), family = componentFamily(design, face);
  if (!family) throw new Error(`no component design family for '${piece.id}'`);
  const width = face.size_mm?.width || family.size_mm.width, height = face.size_mm?.height || family.size_mm.height;
  const bleed = bleedOverride == null ? (design.production?.bleed_mm || 0) : Math.max(0, Number(bleedOverride) || 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width + bleed * 2)}mm" height="${round(height + bleed * 2)}mm" viewBox="0 0 ${round(width + bleed * 2)} ${round(height + bleed * 2)}" data-forge-profile="${COMPONENT_EXPORT_PROFILE}" data-forge-piece="${esc(piece.id)}" data-forge-side="${side}">${pieceMarkup(gameDir, face, family, bleed, bleed, { guides, bleed, side })}</svg>\n`;
}

function sheetPages(gameDir, pieces, design) {
  const sheet = design.production.sheet, page = PAGE[sheet.page] || PAGE.A4;
  const margin = sheet.margin_mm, gap = sheet.gap_mm, bleed = design.production.bleed_mm || 0;
  const instances = pieces.flatMap(piece => Array.from({ length: componentQuantity(piece, design) }, (_, copy) => ({ piece, copy })));
  const pages = [], excluded = []; let current = [], x = margin, y = margin, rowHeight = 0;
  for (const instance of instances) {
    const family = componentFamily(design, instance.piece); if (!family) continue;
    const width = (instance.piece.size_mm?.width || family.size_mm.width) + bleed * 2;
    const height = (instance.piece.size_mm?.height || family.size_mm.height) + bleed * 2;
    if (width > page.width - margin * 2 || height > page.height - margin * 2) { excluded.push(instance.piece.id); continue; }
    if (x + width > page.width - margin && x > margin) { x = margin; y += rowHeight + gap; rowHeight = 0; }
    if (y + height > page.height - margin && current.length) { pages.push(current); current = []; x = margin; y = margin; rowHeight = 0; }
    current.push({ ...instance, family, x: x + bleed, y: y + bleed });
    x += width + gap; rowHeight = Math.max(rowHeight, height);
  }
  if (current.length) pages.push(current);
  return { page, pages, excluded: [...new Set(excluded)] };
}

function largePiecePages(gameDir, pieces, design, excluded, symbols) {
  const sheet = design.production.sheet, page = PAGE[sheet.page] || PAGE.A4;
  const margin = sheet.margin_mm, printableWidth = page.width - margin * 2, printableHeight = page.height - margin * 2;
  const bleed = design.production.bleed_mm || 0;
  const overlap = Math.min(Number(design.production.large_piece_overlap_mm ?? 8), printableWidth - .1, printableHeight - .1);
  const stepX = printableWidth - overlap, stepY = printableHeight - overlap;
  const output = [];
  for (const piece of pieces.filter(candidate => excluded.includes(candidate.id))) {
    for (let copy = 0; copy < componentQuantity(piece, design); copy++) for (const side of piece.back ? ["front", "back"] : ["front"]) {
      const face = componentFace(piece, side), family = componentFamily(design, face);
      const finishedWidth = face.size_mm?.width || family.size_mm.width, finishedHeight = face.size_mm?.height || family.size_mm.height;
      const totalWidth = finishedWidth + bleed * 2, totalHeight = finishedHeight + bleed * 2;
      const columns = Math.max(1, Math.ceil(Math.max(0, totalWidth - printableWidth) / stepX) + 1);
      const rows = Math.max(1, Math.ceil(Math.max(0, totalHeight - printableHeight) / stepY) + 1);
      const files = [];
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        const offsetX = column * stepX, offsetY = row * stepY;
        const coverageWidth = Math.min(printableWidth, totalWidth - offsetX), coverageHeight = Math.min(printableHeight, totalHeight - offsetY);
        const file = `large-pieces/${piece.id}-${String(copy + 1).padStart(2, "0")}-${side}-r${row + 1}c${column + 1}-${sheet.page.toLowerCase()}.svg`;
        const clip = `large_${String(piece.id).replace(/[^A-Za-z0-9_-]/g, "_")}_${copy}_${side}_${row}_${column}`;
        const marks = [[margin, margin], [margin + coverageWidth, margin], [margin, margin + coverageHeight], [margin + coverageWidth, margin + coverageHeight]]
          .map(([x, y]) => `<path d="M ${round(x - 2)} ${round(y)} H ${round(x + 2)} M ${round(x)} ${round(y - 2)} V ${round(y + 2)}" stroke="#111" stroke-width="0.2" fill="none"/>`).join("");
        const content = `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${page.width} ${page.height}" data-forge-profile="${COMPONENT_EXPORT_PROFILE}" data-forge-large-piece="${esc(piece.id)}" data-forge-side="${side}" data-forge-row="${row + 1}" data-forge-column="${column + 1}" data-forge-overlap-mm="${round(overlap)}"><rect width="100%" height="100%" fill="#fff"/><text x="${margin}" y="${round(Math.max(3, margin - 3))}" font-family="Arial,sans-serif" font-size="2.5mm" fill="#111">${esc(piece.name)} · copy ${copy + 1} · ${side.toUpperCase()} · row ${row + 1}/${rows}, column ${column + 1}/${columns} · overlap ${round(overlap)} mm · PRINT 100%</text><defs><clipPath id="${clip}"><rect x="${margin}" y="${margin}" width="${round(coverageWidth)}" height="${round(coverageHeight)}"/></clipPath></defs><g clip-path="url(#${clip})">${pieceMarkup(gameDir, face, family, margin - offsetX + bleed, margin - offsetY + bleed, { guides: true, bleed, symbols, side, instance: `${copy}_${row}_${column}` })}</g>${marks}</svg>\n`;
        files.push({ file, content: Buffer.from(content), row: row + 1, column: column + 1,
          offset_mm: { x: round(offsetX), y: round(offsetY) }, coverage_mm: { width: round(coverageWidth), height: round(coverageHeight) } });
      }
      output.push({ id: piece.id, copy: copy + 1, side, finished_size_mm: { width: finishedWidth, height: finishedHeight },
        bleed_mm: bleed, overlap_mm: round(overlap), rows, columns, files });
    }
  }
  return output;
}

function loadComponentSetups(gameDir) {
  const root = join(gameDir, "setups");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(name => /\.(?:json|ya?ml)$/i.test(name)).sort().map(name => {
    const path = `setups/${name}`, source = readFileSync(join(root, name), "utf8");
    return { path, document: name.toLowerCase().endsWith(".json") ? JSON.parse(source) : yaml.load(source) };
  });
}

function renderSetupMap(setupEntry, pieces, design) {
  const setup = setupEntry.document, selected = PAGE[design.production.sheet.page] || PAGE.A4;
  const page = { width: Math.max(selected.width, selected.height), height: Math.min(selected.width, selected.height) };
  const margin = 12, header = 14, footer = 10, board = setup.board || { width: 1600, height: 1000 };
  const scale = Math.min((page.width - margin * 2) / board.width, (page.height - margin * 2 - header - footer) / board.height);
  const mapWidth = board.width * scale, mapHeight = board.height * scale;
  const ox = (page.width - mapWidth) / 2, oy = margin + header + (page.height - margin * 2 - header - footer - mapHeight) / 2;
  const pieceById = new Map(pieces.map(piece => [piece.id, piece]));
  const zones = (setup.zones || []).map(zone => `<g data-forge-zone="${esc(zone.id)}"><rect x="${round(ox + zone.position.x * scale)}" y="${round(oy + zone.position.y * scale)}" width="${round(zone.size.width * scale)}" height="${round(zone.size.height * scale)}" rx="2" fill="${esc(zone.color || "#ffffff")}" fill-opacity="0.055" stroke="#ffffff" stroke-opacity="0.32" stroke-width="0.35" stroke-dasharray="2 1"/><text x="${round(ox + zone.position.x * scale + 2)}" y="${round(oy + zone.position.y * scale + 4)}" font-family="Arial,sans-serif" font-size="2.4mm" fill="#ffffff" fill-opacity="0.65">${esc(zone.name)}</text></g>`).join("");
  const seats = (setup.seats || []).map(seat => `<g data-forge-seat="${esc(seat.id)}"><circle cx="${round(ox + seat.position.x * scale)}" cy="${round(oy + seat.position.y * scale)}" r="3" fill="${esc(seat.color || "#64748b")}" stroke="#fff" stroke-width="0.35"/><text x="${round(ox + seat.position.x * scale + 4)}" y="${round(oy + seat.position.y * scale + 1)}" font-family="Arial,sans-serif" font-size="2.7mm" font-weight="700" fill="#ffffff">${esc(seat.name)}</text></g>`).join("");
  const placements = (setup.pieces || []).map(placement => {
    const piece = pieceById.get(placement.component_id); if (!piece) return "";
    const face = componentFace(piece, placement.face || "front"), family = componentFamily(design, face);
    const physicalWidth = face.size_mm?.width || family.size_mm.width, physicalHeight = face.size_mm?.height || family.size_mm.height;
    const factor = Math.min(1, 22 / Math.max(physicalWidth, physicalHeight));
    const width = Math.max(7, physicalWidth * factor), height = Math.max(7, physicalHeight * factor);
    const x = ox + placement.position.x * scale, y = oy + placement.position.y * scale, style = family.style || {};
    const label = `${piece.name}${(placement.quantity || 1) > 1 ? ` ×${placement.quantity}` : ""}`;
    return `<g data-forge-component-placement="${esc(placement.id)}" data-forge-component="${esc(piece.id)}" transform="translate(${round(x)} ${round(y)}) rotate(${round(placement.rotation || 0)})">${shapeMarkup(family.shape, -width / 2, -height / 2, width, height, `fill="${esc(style.fill || "#334155")}" stroke="${esc(style.border || "#f8fafc")}" stroke-width="0.6"`)}<text x="0" y="${round(height / 2 + 4)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="2.5mm" font-weight="700" fill="#ffffff" paint-order="stroke" stroke="#111827" stroke-width="0.6">${esc(label)}</text></g>`;
  }).join("");
  const content = `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${page.width} ${page.height}" data-forge-profile="${COMPONENT_EXPORT_PROFILE}" data-forge-setup="${esc(setup.id)}"><rect width="100%" height="100%" fill="#ffffff"/><text x="${margin}" y="10" font-family="Arial,sans-serif" font-size="5mm" font-weight="700" fill="#111827">${esc(setup.name)} · component setup map</text><text x="${page.width - margin}" y="10" text-anchor="end" font-family="Arial,sans-serif" font-size="2.6mm" fill="#475569">PRINT 100% · ${esc(setupEntry.path)}</text><rect x="${round(ox)}" y="${round(oy)}" width="${round(mapWidth)}" height="${round(mapHeight)}" rx="3" fill="${esc(board.background || "#17211f")}" stroke="#111827" stroke-width="0.6"/>${zones}${seats}${placements}<text x="${margin}" y="${page.height - 5}" font-family="Arial,sans-serif" font-size="2.5mm" fill="#475569">Versioned authoring map. Card stacks remain in the setup document; non-card components shown here are not auto-staged by the VTT adapter.</text></svg>\n`;
  return { file: `setup-maps/${setup.id}.svg`, content: Buffer.from(content), setup_id: setup.id,
    source: setupEntry.path, placements: (setup.pieces || []).map(placement => ({ id: placement.id,
      component_id: placement.component_id, quantity: placement.quantity || 1, position: placement.position,
      rotation: placement.rotation || 0, face: placement.face || "front", ...(placement.zone_id ? { zone_id: placement.zone_id } : {}),
      ...(placement.seat_id ? { seat_id: placement.seat_id } : {}) })) };
}

function componentArtwork(piece) {
  return [{ face: "front", path: piece.art }, { face: "back", path: piece.back?.art },
    ...(piece.faces || []).map((face, index) => ({ face: `die-${index + 1}`, path: face.art }))]
    .filter(item => typeof item.path === "string" && item.path);
}

export function buildComponentProduction(gameDir, { sourceRef = "HEAD" } = {}) {
  const piecesPath = join(gameDir, "components/tokens.json");
  const pieces = existsSync(piecesPath) ? JSON.parse(readFileSync(piecesPath, "utf8")) : [];
  if (!pieces.length) throw new Error("game has no components/tokens.json pieces to manufacture");
  const design = loadComponentDesign(gameDir), symbols = gameSymbols(gameDir), bleed = design.production?.bleed_mm || 0;
  const rightsAudit = auditRights(gameDir, { sourceSha: sourceRef }), rightsByPath = new Map(rightsAudit.files.map(file => [file.path, file]));
  const artPaths = [...new Set(pieces.flatMap(componentArtwork).map(item => item.path))].sort();
  for (const path of artPaths) if (!existsSync(join(gameDir, path))) throw new Error(`component art asset '${path}' does not exist`);
  const playerCount = Number.isInteger(design.production?.player_count) ? design.production.player_count : null;
  const hasPerPlayer = pieces.some(piece => piece.per_player);
  const entries = new Map(), rendered = [];
  const familyKit = buildComponentSvgProject(design, pieces, { sourceRef });
  for (const [name, bytes] of familyKit.entries) entries.set(name, bytes);
  for (const piece of pieces) {
    const file = `faces/${piece.id}.svg`, svg = renderComponentSvg(gameDir, piece, design);
    entries.set(file, Buffer.from(svg));
    let backFile = null, backSha = null, backFamily = null;
    if (piece.back) {
      const frontFamily = componentFamily(design, piece), backFace = componentFace(piece, "back"), reverseFamily = componentFamily(design, backFace);
      const frontSize = [piece.size_mm?.width || frontFamily.size_mm.width, piece.size_mm?.height || frontFamily.size_mm.height];
      const backSize = [backFace.size_mm?.width || reverseFamily.size_mm.width, backFace.size_mm?.height || reverseFamily.size_mm.height];
      if (frontSize[0] !== backSize[0] || frontSize[1] !== backSize[1])
        throw new Error(`piece '${piece.id}' front/back families must have the same finished size`);
      backFile = `faces/${piece.id}-back.svg`;
      const backSvg = renderComponentSvg(gameDir, piece, design, { side: "back" });
      entries.set(backFile, Buffer.from(backSvg)); backSha = createHash("sha256").update(backSvg).digest("hex"); backFamily = reverseFamily.id;
    }
    const artwork = componentArtwork(piece).map(item => ({ ...item,
      sha256: createHash("sha256").update(readFileSync(join(gameDir, item.path))).digest("hex"),
      rights: rightsByPath.has(item.path) ? { license: rightsByPath.get(item.path).license,
        status: rightsByPath.get(item.path).status, copyright: rightsByPath.get(item.path).copyright,
        redistribution: rightsByPath.get(item.path).redistribution,
        ...(rightsByPath.get(item.path).source ? { source: rightsByPath.get(item.path).source } : {}) } : null }));
    rendered.push({ id: piece.id, kind: piece.kind, family: componentFamily(design, piece)?.id,
      quantity: piece.quantity || 1, declared_quantity: piece.quantity || 1, resolved_quantity: componentQuantity(piece, design),
      per_player: !!piece.per_player, ...(piece.per_player && playerCount ? { player_count: playerCount } : {}),
      sides: piece.back ? 2 : 1, file, artwork,
      sha256: createHash("sha256").update(svg).digest("hex"), ...(backFile ? { back_file: backFile, back_family: backFamily, back_sha256: backSha } : {}) });
  }
  const { page, pages, excluded } = sheetPages(gameDir, pieces, design), sheetFiles = [], backSheetFiles = [];
  pages.forEach((items, index) => {
    const file = `cut-sheets/${String(index + 1).padStart(2, "0")}-${design.production.sheet.page.toLowerCase()}.svg`;
    const labels = items.map(item => `<text x="${round(item.x)}" y="${round(item.y - 1)}" font-family="Arial,sans-serif" font-size="2.2mm" fill="#4b5563">${esc(item.piece.name)} · ${item.copy + 1}</text>`).join("");
    const content = `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${page.width} ${page.height}" data-forge-profile="${COMPONENT_EXPORT_PROFILE}" data-forge-page="${index + 1}" data-forge-side="front"><rect width="100%" height="100%" fill="#fff"/>${labels}${items.map(item => pieceMarkup(gameDir, item.piece, item.family, item.x, item.y, { guides: true, bleed, symbols, side: "front", instance: item.copy })).join("")}</svg>\n`;
    entries.set(file, Buffer.from(content)); sheetFiles.push(file);
    const backed = items.filter(item => item.piece.back);
    if (backed.length) {
      const backFile = `cut-sheets/${String(index + 1).padStart(2, "0")}-${design.production.sheet.page.toLowerCase()}-back.svg`;
      const backLabels = backed.map(item => { const width = item.piece.size_mm?.width || item.family.size_mm.width;
        return `<text x="${round(page.width - item.x - width)}" y="${round(item.y - 1)}" font-family="Arial,sans-serif" font-size="2.2mm" fill="#4b5563">BACK · ${esc(item.piece.back.name || item.piece.name)} · ${item.copy + 1}</text>`; }).join("");
      const backs = backed.map(item => { const face = componentFace(item.piece, "back"), family = componentFamily(design, face);
        const width = face.size_mm?.width || family.size_mm.width, mirroredX = page.width - item.x - width;
        return pieceMarkup(gameDir, face, family, mirroredX, item.y, { guides: true, bleed, symbols, side: "back", instance: item.copy }); }).join("");
      const backContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${page.width} ${page.height}" data-forge-profile="${COMPONENT_EXPORT_PROFILE}" data-forge-page="${index + 1}" data-forge-side="back" data-forge-duplex="long-edge-mirrored"><rect width="100%" height="100%" fill="#fff"/>${backLabels}${backs}</svg>\n`;
      entries.set(backFile, Buffer.from(backContent)); backSheetFiles.push(backFile);
    }
  });
  const largePieceTiles = largePiecePages(gameDir, pieces, design, excluded, symbols);
  for (const tiled of largePieceTiles) for (const tile of tiled.files) entries.set(tile.file, tile.content);
  const largePieceFiles = largePieceTiles.flatMap(tiled => tiled.files.map(tile => tile.file));
  const setupEntries = loadComponentSetups(gameDir), setupMaps = setupEntries.map(setup => renderSetupMap(setup, pieces, design));
  for (const map of setupMaps) entries.set(map.file, map.content);
  const manifest = { profile: COMPONENT_EXPORT_PROFILE, version: COMPONENT_EXPORT_VERSION, source_ref: sourceRef,
    source_files: ["components/tokens.json", ...(existsSync(join(gameDir, COMPONENT_DESIGN_PATH)) ? [COMPONENT_DESIGN_PATH] : []),
      ...setupEntries.map(setup => setup.path), ...artPaths, ...(existsSync(join(gameDir, RIGHTS_MANIFEST)) ? [RIGHTS_MANIFEST] : [])],
    production: design.production, pieces: rendered, family_templates: familyKit.manifest.families,
    family_round_trip: familyKit.manifest.round_trip, cut_sheets: sheetFiles, back_cut_sheets: backSheetFiles,
    setup_maps: setupMaps.map(({ content, ...map }) => map),
    artwork_rights: { manifest: existsSync(join(gameDir, RIGHTS_MANIFEST)) ? RIGHTS_MANIFEST : null,
      publishable_project: rightsAudit.publishable, dependencies: artPaths.map(path => rightsByPath.get(path) || { path, status: "unknown" }) },
    large_piece_tiles: largePieceTiles.map(tiled => ({ ...tiled, files: tiled.files.map(({ content, ...file }) => file) })),
    duplex: { mode: "long-edge-mirrored", print_scale: "100%", alignment_note: "Print each back sheet behind the same-numbered front sheet using long-edge duplex; verify one page before the full run." },
    quantity_resolution: { status: hasPerPlayer && !playerCount ? "unresolved" : "resolved",
      player_count: playerCount, rule: "Pieces marked per_player are multiplied by the versioned production.player_count." },
    excluded_from_standard_cut_sheets: excluded, excluded_from_cut_sheets: [],
    totals: { piece_types: pieces.length,
      declared_physical_pieces: pieces.reduce((sum, piece) => sum + (piece.quantity || 1), 0),
      physical_pieces: pieces.reduce((sum, piece) => sum + componentQuantity(piece, design), 0),
      printed_faces: pieces.reduce((sum, piece) => sum + componentQuantity(piece, design) * (piece.back ? 2 : 1), 0),
      front_pages: sheetFiles.length, back_pages: backSheetFiles.length, large_piece_pages: largePieceFiles.length,
      setup_maps: setupMaps.length, pages: sheetFiles.length + backSheetFiles.length + largePieceFiles.length + setupMaps.length },
    boundaries: ["SVG is the editable interchange surface for this milestone.", "Back sheets mirror front placement for long-edge duplex printing; printer feed variance still requires a one-page alignment proof.",
      ...(hasPerPlayer && !playerCount ? ["Per-player quantities remain declared-only because this version has no production.player_count."] : []),
      "Large pieces are poster-tiled with a declared overlap and assembly marks; Forge does not compensate for printer scaling or non-printable margins.",
      "Setup maps freeze authored non-card placement for review and release; the VTT adapter does not yet auto-stage these components."] };
  entries.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  entries.set("README.md", Buffer.from(`# Forge component production\n\nExact source: \`${sourceRef}\`\n\n- Individual editable SVG faces are in \`faces/\`; two-sided pieces include a named \`-back.svg\`.\n- Home-print front and long-edge-mirrored back sheets with explicit trim lines are in \`cut-sheets/\`. Print at 100% and verify one duplex page before the full run.\n- Oversize boards and other large pieces are poster-tiled in \`large-pieces/\` with ${design.production.large_piece_overlap_mm ?? 8} mm overlap, assembly crosses, row/column labels, and exact source offsets.\n- Per-player quantities are resolved from the versioned \`production.player_count\`${playerCount ? ` (${playerCount} players for this kit)` : "; this version has no selection, so declared quantities are preserved"}.\n- Bounded, round-trippable layout working copies are in \`family-templates/\`.\n- Version-pinned table placement maps are in \`setup-maps/\`. They are authoring and release proofs; the current VTT adapter does not auto-stage non-card components.\n- Component artwork is embedded in rendered faces; \`manifest.json\` pins each source path, hash, license, credit, rights status, and redistribution rule.\n- \`manifest.json\` also records declared and resolved quantities, family bindings, setup sources, duplex alignment, and production limits.\n- Change component data through Forge or the traced \`tokens.csv\` workflow. Change reusable appearance in Forge Piece Studio or return one of its family SVGs for visual review.\n`));
  return { entries, manifest };
}
