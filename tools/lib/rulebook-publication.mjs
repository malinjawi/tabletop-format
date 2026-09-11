import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

import { deterministicZip } from "./deterministic-zip.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VENV_PYTHON = process.platform === "win32" ? join(ROOT, ".venv", "Scripts", "python.exe") : join(ROOT, ".venv", "bin", "python");
const PYTHON = process.env.FORGE_PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
export const RULEBOOK_PUBLICATIONS_MANIFEST = "rules/publications/manifest.json";
export const RULEBOOK_PUBLICATIONS_VERSION = 1;

const sha256 = value => createHash("sha256").update(value).digest("hex");
const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function safeRel(value, label = "path") {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\"))
    throw new Error(`${label} must be a safe relative path: ${value}`);
  if (value.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error(`${label} must be a safe relative path: ${value}`);
  return value;
}

function inside(root, rel, label = "path") {
  safeRel(rel, label);
  const base = resolve(root), path = resolve(base, rel), check = relative(base, path);
  if (check === ".." || check.startsWith(`..${sep}`) || isAbsolute(check))
    throw new Error(`${label} escapes its root: ${rel}`);
  return path;
}

function walk(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name), rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function validateRegistry(registry) {
  if (!registry || registry.version !== RULEBOOK_PUBLICATIONS_VERSION || !Array.isArray(registry.publications) || !registry.publications.length)
    throw new Error(`${RULEBOOK_PUBLICATIONS_MANIFEST} is incomplete`);
  const ids = new Set();
  for (const publication of registry.publications) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(publication.id || ""))
      throw new Error(`invalid publication id '${publication.id}'`);
    if (ids.has(publication.id)) throw new Error(`duplicate publication id '${publication.id}'`);
    ids.add(publication.id);
    if (!publication.source?.startsWith("rules/publications/") || !publication.source.endsWith(".json"))
      throw new Error(`publication '${publication.id}' source must be JSON under rules/publications/`);
    if (!Array.isArray(publication.editors) || !publication.editors.length)
      throw new Error(`publication '${publication.id}' must declare at least one editor`);
    if (!Array.isArray(publication.outputs) || !publication.outputs.length)
      throw new Error(`publication '${publication.id}' must declare outputs`);
  }
  if (!ids.has(registry.active)) throw new Error(`active publication '${registry.active}' does not exist`);
  if (registry.publications.filter(item => item.status === "active").length !== 1)
    throw new Error("exactly one rulebook publication must have status active");
  const active = registry.publications.find(item => item.id === registry.active);
  if (active.status !== "active") throw new Error(`active publication '${registry.active}' must have status active`);
  return active;
}

function validateDocument(document, active) {
  if (!document || document.version !== 1 || document.id !== active.id || !Array.isArray(document.pages) || !document.pages.length)
    throw new Error(`publication source '${active.source}' is incomplete or does not match '${active.id}'`);
  const pageIds = new Set(), blockIds = new Set();
  for (const page of document.pages) {
    if (pageIds.has(page.id)) throw new Error(`duplicate publication page id '${page.id}'`);
    pageIds.add(page.id);
    for (const block of page.blocks || []) {
      if (blockIds.has(block.id)) throw new Error(`duplicate publication block id '${block.id}'`);
      blockIds.add(block.id);
      for (const key of ["x", "y", "w", "h"])
        if (!Number.isFinite(block[key])) throw new Error(`block '${block.id}' has no numeric ${key}`);
      if (block.x + block.w > 100.001 || block.y + block.h > 100.001)
        throw new Error(`block '${block.id}' leaves the trim page`);
    }
  }
  return document;
}

export function loadRulebookPublication(gamePath) {
  const gameDir = resolve(gamePath), manifestPath = join(gameDir, RULEBOOK_PUBLICATIONS_MANIFEST);
  if (!existsSync(manifestPath)) return null;
  const registry = JSON.parse(readFileSync(manifestPath, "utf8"));
  const active = validateRegistry(registry);
  const sourcePath = inside(gameDir, active.source, "publication source");
  if (!existsSync(sourcePath)) throw new Error(`publication source does not exist: ${active.source}`);
  const document = validateDocument(JSON.parse(readFileSync(sourcePath, "utf8")), active);
  const publicationRoot = dirname(sourcePath);
  const sourceFiles = walk(publicationRoot).map(rel => `${relative(gameDir, publicationRoot).split(sep).join("/")}/${rel}`);
  return {
    manifest_path: RULEBOOK_PUBLICATIONS_MANIFEST,
    source_path: active.source,
    registry,
    active,
    document,
    source_files: [RULEBOOK_PUBLICATIONS_MANIFEST, ...sourceFiles].filter((value, index, all) => all.indexOf(value) === index),
  };
}

export function rulebookPublicationMetadata(loaded, { includeDocument = false } = {}) {
  if (!loaded) return null;
  return {
    version: loaded.registry.version,
    active: loaded.registry.active,
    manifest_path: loaded.manifest_path,
    source_path: loaded.source_path,
    publication: loaded.active,
    source_files: loaded.source_files,
    ...(includeDocument ? { document: loaded.document } : {}),
  };
}

function getBlockCardIds(document) {
  const ids = new Set(document.dependencies?.cards || []);
  for (const page of document.pages) for (const block of page.blocks || []) {
    if (block.card_id) ids.add(block.card_id);
    for (const id of block.card_ids || []) ids.add(id);
    for (const placement of block.placements || []) if (placement.card_id) ids.add(placement.card_id);
  }
  return [...ids].sort();
}

function getBlockAssets(document) {
  const assets = new Set(document.dependencies?.assets || []);
  for (const page of document.pages) for (const block of page.blocks || []) if (block.asset) assets.add(block.asset);
  return [...assets].sort();
}

function cardFaceData(gameDir, document, tempRoot) {
  const cards = JSON.parse(readFileSync(join(gameDir, "components/cards.json"), "utf8"));
  const printings = JSON.parse(readFileSync(join(gameDir, "components/printings.json"), "utf8"));
  const byCard = new Map(cards.map(card => [card.id, card]));
  const firstPrinting = new Map();
  for (const printing of printings) if (!firstPrinting.has(printing.card_id)) firstPrinting.set(printing.card_id, printing);
  const wanted = getBlockCardIds(document), missingIds = wanted.filter(id => !byCard.has(id));
  if (missingIds.length) throw new Error(`publication references missing cards: ${missingIds.join(", ")}`);
  const renderDir = join(tempRoot, "faces");
  const needsRender = wanted.some(id => {
    const printing = firstPrinting.get(id);
    return !printing || !existsSync(join(gameDir, "exports", "faces", `${printing.id}.png`));
  });
  if (needsRender) execFileSync(process.execPath, [join(ROOT, "tools", "render_cards.mjs"), gameDir, renderDir], { stdio: "pipe" });
  const faces = {};
  for (const id of wanted) {
    const printing = firstPrinting.get(id);
    if (!printing) throw new Error(`publication card '${id}' has no printing`);
    const repoFace = join(gameDir, "exports", "faces", `${printing.id}.png`);
    const renderedFace = join(renderDir, `${printing.id}.png`);
    const path = existsSync(repoFace) ? repoFace : renderedFace;
    if (!existsSync(path)) throw new Error(`could not render publication card '${id}'`);
    faces[id] = `data:image/png;base64,${readFileSync(path).toString("base64")}`;
  }
  const backs = [join(gameDir, "exports", "faces", "_back.png"), join(renderDir, "_back.png")];
  const backPath = backs.find(existsSync);
  if (!backPath) throw new Error("publication scene uses card backs but no _back.png could be found or rendered");
  return { faces, back: `data:image/png;base64,${readFileSync(backPath).toString("base64")}`, byCard };
}

function assetData(gameDir, document) {
  const out = {};
  for (const asset of getBlockAssets(document)) {
    const path = inside(gameDir, asset, "publication asset");
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`publication asset does not exist: ${asset}`);
    const ext = asset.toLowerCase().split(".").pop();
    const mime = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] || "application/octet-stream";
    out[asset] = `data:${mime};base64,${readFileSync(path).toString("base64")}`;
  }
  return out;
}

function styleVars(style = {}) {
  const out = [];
  if (style.align) out.push(`text-align:${style.align}`);
  if (style.valign) out.push(`justify-content:${{ top: "flex-start", middle: "center", bottom: "flex-end" }[style.valign]}`);
  if (style.color) out.push(`color:${style.color}`);
  if (style.background) out.push(`background:${style.background}`);
  if (style.border) out.push(`border-color:${style.border}`);
  if (style.font_size_pt) out.push(`font-size:${style.font_size_pt}pt`);
  if (style.columns) out.push(`--columns:${style.columns}`);
  if (style.padding_mm != null) out.push(`padding:${style.padding_mm}mm`);
  if (style.radius_mm != null) out.push(`border-radius:${style.radius_mm}mm`);
  if (style.opacity != null) out.push(`opacity:${style.opacity}`);
  if (style.uppercase) out.push("text-transform:uppercase");
  return out.join(";");
}

const paragraphs = content => esc(content || "").split(/\n\s*\n/).map(value => `<p>${value.replaceAll("\n", "<br>")}</p>`).join("");

function renderHeading(block) {
  return `${block.kicker ? `<div class="pub-kicker">${esc(block.kicker)}</div>` : ""}<h1>${esc(block.content || block.heading || "")}</h1>`;
}

function renderSteps(block) {
  return `${block.heading ? `<h3>${esc(block.heading)}</h3>` : ""}<ol class="pub-step-list">${(block.items || []).map(item => `<li>${esc(item)}</li>`).join("")}</ol>`;
}

function renderComponentList(block) {
  return `${block.heading ? `<h3>${esc(block.heading)}</h3>` : ""}<ul class="pub-component-list">${(block.items || []).map(item => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function renderCard(block, media, byCard) {
  const face = media.faces[block.card_id], card = byCard.get(block.card_id);
  return `<div class="pub-card-wrap"><img class="pub-card" src="${face}" alt="${esc(card?.name || block.card_id)}">${block.caption ? `<div class="pub-caption">${esc(block.caption)}</div>` : ""}</div>`;
}

function renderCardGrid(block, media, byCard) {
  return `<div class="pub-card-grid">${(block.card_ids || []).map(id => `<img class="pub-card" src="${media.faces[id]}" alt="${esc(byCard.get(id)?.name || id)}">`).join("")}</div>${block.caption ? `<div class="pub-caption">${esc(block.caption)}</div>` : ""}`;
}

function renderScene(block, media, byCard) {
  const placements = (block.placements || []).map(item => {
    const style = `left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%;transform:rotate(${item.rotate || 0}deg);z-index:${item.z || 1}`;
    if (item.kind === "card" || item.kind === "card-back") {
      const src = item.kind === "card" ? media.faces[item.card_id] : media.back;
      const alt = item.kind === "card" ? byCard.get(item.card_id)?.name || item.card_id : item.label || "card back";
      return `<div class="pub-scene-item pub-scene-card" style="${style}"><img src="${src}" alt="${esc(alt)}">${item.label ? `<span>${esc(item.label)}</span>` : ""}</div>`;
    }
    if (item.kind === "token") return `<div class="pub-scene-item pub-token" style="${style};background:${esc(item.tone || "#E05D32")}">${esc(item.label || "")}</div>`;
    return `<div class="pub-scene-item pub-scene-label" style="${style};background:${esc(item.tone || "#26364A")}">${esc(item.label || "")}</div>`;
  }).join("");
  const arrows = (block.arrows || []).map((arrow, index) => `<g><line x1="${arrow.x1}" y1="${arrow.y1}" x2="${arrow.x2}" y2="${arrow.y2}" stroke="${esc(arrow.tone || "#E05D32")}" marker-end="url(#pub-arrow)"/><text x="${(arrow.x1 + arrow.x2) / 2}" y="${(arrow.y1 + arrow.y2) / 2 - 1.5}" fill="${esc(arrow.tone || "#E05D32")}">${esc(arrow.label || String(index + 1))}</text></g>`).join("");
  return `<div class="pub-scene"><svg class="pub-scene-arrows" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="pub-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="#D8E0E8"/></marker></defs>${arrows}</svg>${placements}</div>${block.caption ? `<div class="pub-caption">${esc(block.caption)}</div>` : ""}`;
}

function renderBlock(block, media, byCard, assets) {
  const position = `left:${block.x}%;top:${block.y}%;width:${block.w}%;height:${block.h}%`;
  let body = "";
  if (block.type === "heading") body = renderHeading(block);
  else if (block.type === "text") body = paragraphs(block.content);
  else if (["callout", "rule-reference"].includes(block.type)) body = `${block.heading ? `<h3>${esc(block.heading)}</h3>` : ""}${paragraphs(block.content)}`;
  else if (block.type === "steps") body = renderSteps(block);
  else if (block.type === "component-list") body = renderComponentList(block);
  else if (block.type === "card") body = renderCard(block, media, byCard);
  else if (block.type === "card-grid") body = renderCardGrid(block, media, byCard);
  else if (block.type === "scene") body = renderScene(block, media, byCard);
  else if (block.type === "image") body = `<img class="pub-figure" src="${assets[block.asset]}" alt="${esc(block.caption || block.id)}">${block.caption ? `<div class="pub-caption">${esc(block.caption)}</div>` : ""}`;
  else body = paragraphs(block.content);
  return `<section class="pub-block pub-block-${esc(block.type)}" data-block-id="${esc(block.id)}" style="${position};${styleVars(block.style)}">${body}</section>`;
}

function pageBackground(page, theme) {
  const bg = page.background || { type: "paper" };
  if (bg.type === "dark") return "background:linear-gradient(145deg,#111722,#26364A)";
  if (bg.type === "corp") return `background:linear-gradient(145deg,${theme.corp || "#23506F"},#102433)`;
  if (bg.type === "runner") return `background:linear-gradient(145deg,${theme.runner || "#6F3B73"},#25162A)`;
  if (bg.type === "split") return `background:linear-gradient(180deg,${theme.corp || "#23506F"} 0 49.5%,${theme.runner || "#6F3B73"} 50.5% 100%)`;
  if (bg.type === "gradient") return `background:linear-gradient(145deg,${bg.from || theme.corp},${bg.to || theme.runner})`;
  return `background:${theme.paper}`;
}

export function renderRulebookPublicationHtml(document, media, assets = {}) {
  const format = document.format, theme = document.theme, bleed = format.bleed_mm || 0;
  const mediaW = format.width_mm + bleed * 2, mediaH = format.height_mm + bleed * 2;
  const pages = document.pages.map((page, index) => `<article class="pub-page" data-page-id="${esc(page.id)}" style="${pageBackground(page, theme)}"><div class="pub-trim"><div class="pub-edge" style="background:${esc(page.accent || theme.accent)}"></div>${page.section ? `<header class="pub-running">${esc(page.section)} <span>${esc(document.title)}</span></header>` : ""}${(page.blocks || []).map(block => renderBlock(block, media, media.byCard, assets)).join("")}${page.show_page_number === false || theme.page_number_style === "none" ? "" : `<div class="pub-page-number ${esc(theme.page_number_style || "plain")}">${index + 1}</div>`}</div></article>`).join("");
  return `<!doctype html><html lang="${esc(document.language || "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(document.title)} — ${esc(document.subtitle || "Rulebook")}</title><style>
@page{size:${mediaW}mm ${mediaH}mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#1a1e26;color:${theme.ink};font-family:${theme.body_font};-webkit-print-color-adjust:exact;print-color-adjust:exact}.pub-page{position:relative;width:${mediaW}mm;height:${mediaH}mm;overflow:hidden;break-after:page;page-break-after:always}.pub-page:last-child{break-after:auto;page-break-after:auto}.pub-trim{position:absolute;left:${bleed}mm;top:${bleed}mm;width:${format.width_mm}mm;height:${format.height_mm}mm;overflow:hidden}.pub-edge{position:absolute;left:0;top:0;width:2.2mm;height:100%;opacity:.95}.pub-running{position:absolute;left:4%;right:4%;top:2.1%;height:3%;font:700 6.8pt ${theme.display_font};letter-spacing:.14em;text-transform:uppercase;opacity:.7;display:flex;justify-content:space-between;z-index:80}.pub-block{position:absolute;display:flex;flex-direction:column;overflow:hidden;line-height:1.36;border:0 solid currentColor}.pub-block h1,.pub-block h3,.pub-block p{margin:0}.pub-block h1{font-family:${theme.display_font};font-weight:800;line-height:.94;letter-spacing:-.015em}.pub-block h3{font:800 9.5pt ${theme.display_font};letter-spacing:.08em;text-transform:uppercase;margin-bottom:2.3mm}.pub-block p{margin:0 0 2.2mm}.pub-block-text{display:block;column-count:var(--columns,1);column-gap:5mm}.pub-kicker{font:800 7.3pt ${theme.display_font};letter-spacing:.18em;text-transform:uppercase;color:${theme.accent};margin-bottom:2mm}.pub-block-callout,.pub-block-rule-reference,.pub-block-steps,.pub-block-component-list,.pub-block-card-grid,.pub-block-card,.pub-block-scene{border-width:.35mm}.pub-step-list,.pub-component-list{margin:0;padding:0;list-style:none;column-count:var(--columns,1);column-gap:5mm}.pub-step-list{counter-reset:steps}.pub-step-list li{position:relative;break-inside:avoid;padding:0 0 3mm 8mm;min-height:7mm}.pub-step-list li:before{counter-increment:steps;content:counter(steps);position:absolute;left:0;top:-.5mm;width:5.5mm;height:5.5mm;border-radius:50%;background:${theme.accent};color:#fff;display:grid;place-items:center;font:800 7pt ${theme.display_font}}.pub-component-list li{break-inside:avoid;padding:0 0 2.5mm 4mm;border-left:1.2mm solid ${theme.accent};margin-bottom:2mm}.pub-card-wrap{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2mm}.pub-card,.pub-scene-card img{display:block;max-width:100%;max-height:100%;object-fit:contain;filter:drop-shadow(0 1.5mm 2.2mm rgba(0,0,0,.3))}.pub-card-grid{display:flex;gap:3mm;width:100%;height:calc(100% - 8mm);align-items:center;justify-content:center}.pub-card-grid .pub-card{min-width:0}.pub-caption{font-size:6.8pt;line-height:1.25;text-align:center;color:${theme.muted};margin-top:1.5mm}.pub-scene{position:relative;width:100%;height:calc(100% - 7mm);overflow:hidden}.pub-scene-item{position:absolute;display:flex;align-items:center;justify-content:center}.pub-scene-card{flex-direction:column;gap:1mm}.pub-scene-card img{width:100%;height:100%;object-fit:contain}.pub-scene-card span{position:absolute;left:50%;bottom:-3.5mm;transform:translateX(-50%) rotate(0);white-space:nowrap;color:#fff;background:#111b;padding:.5mm 1.2mm;border-radius:1mm;font:800 5.5pt ${theme.display_font};letter-spacing:.06em}.pub-scene-label,.pub-token{color:#fff;border:1px solid #ffffff66;border-radius:50%;font:800 8pt ${theme.display_font};letter-spacing:.05em;text-align:center;padding:1mm}.pub-scene-arrows{position:absolute;inset:0;width:100%;height:100%;z-index:4;overflow:visible}.pub-scene-arrows line{stroke-width:1.3;vector-effect:non-scaling-stroke;stroke-dasharray:4 2}.pub-scene-arrows text{font:800 4px ${theme.display_font};text-anchor:middle;paint-order:stroke;stroke:#111b;stroke-width:1px;letter-spacing:.06em}.pub-figure{width:100%;height:calc(100% - 7mm);object-fit:contain}.pub-block-footer{justify-content:flex-end;font-family:${theme.display_font};letter-spacing:.08em}.pub-page-number{position:absolute;right:4%;bottom:3%;z-index:90;font:800 8pt ${theme.display_font};display:grid;place-items:center}.pub-page-number.square{width:7mm;height:7mm;color:#fff;background:${theme.accent}}.pub-page-number.circle{width:7mm;height:7mm;color:#fff;background:${theme.accent};border-radius:50%}
@media screen{body{padding:16px}.pub-page{margin:0 auto 18px;box-shadow:0 12px 40px #0008}.pub-trim{outline:1px solid #ffffff22}}@media print{body{background:transparent}.pub-page{margin:0;box-shadow:none}}
</style></head><body><main class="publication">${pages}</main></body></html>`;
}

function outputRecord(path, id, format, label) {
  const bytes = readFileSync(path);
  return { id, label, format, file: basename(path), size: bytes.length, sha256: sha256(bytes) };
}

function sourceBundle(gameDir, loaded, dependencies) {
  const entries = new Map();
  for (const rel of loaded.source_files) {
    const path = inside(gameDir, rel, "publication source package file");
    if (existsSync(path) && statSync(path).isFile()) entries.set(rel, readFileSync(path));
  }
  entries.set("dependencies.json", Buffer.from(`${JSON.stringify(dependencies, null, 2)}\n`));
  entries.set("README.txt", Buffer.from(`Forge rulebook publication source\n\nPublication: ${loaded.active.label}\nDocument: ${loaded.source_path}\nEditor-neutral format: percentage geometry + linked game objects\n\nThe final PDF and HTML are derived outputs. Native Affinity, InDesign, or Scribus packages may be added beside the portable document and registered in manifest.json.\n`));
  return deterministicZip(entries);
}

function chromeExecutable() {
  const configured = process.env.CHROME_PATH || process.env.FORGE_CHROME || process.env.FMT_CHROME_BIN;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`Configured Chrome/Chromium executable does not exist: ${configured}`);
    return configured;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Chrome or Chromium is required to build the designed rulebook PDF; set CHROME_PATH");
  return found;
}

async function renderPdf(htmlPath, rawPdfPath, document) {
  const browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    await page.pdf({ path: rawPdfPath, printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
    return await page.evaluate(() => [...document.querySelectorAll(".pub-block")].flatMap(block => {
      const overflowX = block.scrollWidth - block.clientWidth, overflowY = block.scrollHeight - block.clientHeight;
      return overflowX > 2 || overflowY > 2 ? [{ block: block.dataset.blockId, overflow_x_px: overflowX, overflow_y_px: overflowY }] : [];
    }));
  } finally { await browser.close(); }
}

export async function buildRulebookPublication(gamePath, outPath, { buildPdf = true } = {}) {
  const gameDir = resolve(gamePath), outDir = resolve(outPath), loaded = loadRulebookPublication(gameDir);
  if (!loaded) throw new Error(`game has no ${RULEBOOK_PUBLICATIONS_MANIFEST}`);
  mkdirSync(outDir, { recursive: true });
  const tempRoot = mkdtempSync(join(tmpdir(), "forge-publication-"));
  try {
    const media = cardFaceData(gameDir, loaded.document, tempRoot), assets = assetData(gameDir, loaded.document);
    media.byCard = media.byCard;
    const html = renderRulebookPublicationHtml(loaded.document, media, assets);
    const slug = loaded.document.id;
    const htmlPath = join(outDir, `${slug}-web.html`), pdfPath = join(outDir, `${slug}-print.pdf`);
    const preflightPath = join(outDir, "publication-preflight.json"), sourcePath = join(outDir, `${slug}-source.zip`);
    writeFileSync(htmlPath, html);
    let overflow = [];
    if (buildPdf) {
      const rawPdf = join(tempRoot, "raw.pdf");
      overflow = await renderPdf(htmlPath, rawPdf, loaded.document);
      execFileSync(PYTHON, [join(ROOT, "tools", "set_pdf_boxes.py"), rawPdf, pdfPath,
        "--trim-width-mm", String(loaded.document.format.width_mm), "--trim-height-mm", String(loaded.document.format.height_mm),
        "--bleed-mm", String(loaded.document.format.bleed_mm || 0)], { stdio: "pipe" });
    }
    const dependencies = {
      cards: getBlockCardIds(loaded.document),
      setups: [...new Set(loaded.document.dependencies?.setups || [])].sort(),
      assets: getBlockAssets(loaded.document),
      fonts: [...new Set(loaded.document.dependencies?.fonts || [])].sort(),
    };
    const declaredCards = new Set(loaded.document.dependencies?.cards || []);
    const linkedCards = new Set(getBlockCardIds({ ...loaded.document, dependencies: { ...loaded.document.dependencies, cards: [] } }));
    const warnings = [
      ...[...linkedCards].filter(id => !declaredCards.has(id)).map(id => `card '${id}' is used but absent from dependencies.cards`),
      ...overflow.map(item => `block '${item.block}' overflows by ${Math.max(item.overflow_x_px, 0)}px × ${Math.max(item.overflow_y_px, 0)}px`),
    ];
    const preflight = {
      ok: warnings.length === 0,
      publication: loaded.active.id,
      page_count: loaded.document.pages.length,
      trim_mm: [loaded.document.format.width_mm, loaded.document.format.height_mm],
      bleed_mm: loaded.document.format.bleed_mm || 0,
      dependencies,
      warnings,
      checked: ["page geometry", "card references", "linked assets", "browser text overflow", "PDF trim and bleed boxes"],
    };
    writeFileSync(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`);
    writeFileSync(sourcePath, sourceBundle(gameDir, loaded, dependencies));
    const outputs = [
      ...(buildPdf ? [outputRecord(pdfPath, "print", "pdf", "Print-ready booklet")] : []),
      outputRecord(htmlPath, "web", "html", "Web publication"),
      outputRecord(preflightPath, "preflight", "json", "Production preflight"),
      outputRecord(sourcePath, "source", "zip", "Portable source package"),
    ];
    const build = {
      version: 1,
      publication: loaded.active.id,
      source: loaded.source_path,
      page_count: loaded.document.pages.length,
      trim_mm: preflight.trim_mm,
      bleed_mm: preflight.bleed_mm,
      preflight: { ok: preflight.ok, warnings: preflight.warnings },
      outputs,
    };
    writeFileSync(join(outDir, "publication-build.json"), `${JSON.stringify(build, null, 2)}\n`);
    return build;
  } finally { rmSync(tempRoot, { recursive: true, force: true }); }
}
