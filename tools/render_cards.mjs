#!/usr/bin/env node
/**
 * render_cards.mjs — canonical card-face rasterizer.
 *
 * Usage: node tools/render_cards.mjs <game-dir> [out-dir] [--bleed]
 *
 * The hub, editor, print sheet, and PR diff render cards with layoutCard()
 * from tools/hub_template.html. This command deliberately extracts and runs
 * that exact source in headless Chromium, then screenshots each printing at
 * 300dpi. PnP, TTC, TTS, releases, and the derived cache all consume these
 * PNGs, so there is no second implementation of layout.yaml to drift.
 *
 * Set FMT_CHROME_BIN when Chrome/Chromium is not in a common location.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

import yaml from "js-yaml";
import { chromium } from "playwright-core";
import { designEnginesMetadata, loadDesignEngines } from "./lib/design-engines.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLS, "..");
const DPI = 300;
const DEFAULT_W_MM = 63.5;
const DEFAULT_H_MM = 88.9;

function usage(message) {
  if (message) console.error(`render_cards: ${message}`);
  console.error("Usage: node tools/render_cards.mjs <game-dir> [out-dir] [--bleed]");
  process.exit(2);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readYaml(path) {
  return yaml.load(readFileSync(path, "utf8")) || {};
}

function commandPath(name) {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function findChrome() {
  const candidates = [
    process.env.FMT_CHROME_BIN,
    commandPath("chromium"),
    commandPath("chromium-browser"),
    commandPath("google-chrome"),
    commandPath("google-chrome-stable"),
    commandPath("chrome"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (found) return found;
  throw new Error(
    "Chrome/Chromium was not found. Install Chrome or set FMT_CHROME_BIN to its executable.",
  );
}

function rendererSource() {
  const template = readFileSync(join(TOOLS, "hub_template.html"), "utf8");
  const startMarker = "/* ================= SHARED CLIENT CARD RENDERER";
  const endMarker = "/* ================= PRINT SHEET";
  const start = template.indexOf(startMarker);
  const end = template.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error("could not locate the shared card renderer in tools/hub_template.html");
  }
  return template.slice(start, end);
}

function localAssetUrl(gameDir, value) {
  if (typeof value !== "string" || !value || /^(?:data:|https?:|file:)/i.test(value)) return value;
  const path = isAbsolute(value) ? value : resolve(gameDir, value);
  return existsSync(path) ? pathToFileURL(path).href : value;
}

function normalizePrinting(gameDir, printing) {
  const out = structuredClone(printing);
  for (const key of ["art", "art_url", "background", "background_url", "image", "back", "scan"]) {
    if (key in out) out[key] = localAssetUrl(gameDir, out[key]);
  }
  if (out.art) out.art_data = out.art;
  if (out.scan) out.scan_data = out.scan;
  return out;
}

function normalizeLayout(gameDir, layout) {
  if (!layout) return null;
  const out = structuredClone(layout);
  for (const font of out.fonts || []) {
    const local = font.local_asset && existsSync(resolve(gameDir, font.local_asset))
      ? font.local_asset
      : null;
    const selected = local || font.asset;
    if (selected) font.asset_data = localAssetUrl(gameDir, selected);
  }
  return out;
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function productionFile(gameDir, value, label) {
  if (typeof value !== "string" || !value || isAbsolute(value)) throw new Error(`${label} must be a relative path`);
  const path = resolve(gameDir, value);
  if (!within(gameDir, path)) throw new Error(`${label} escapes the game directory: ${value}`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${value}`);
  return path;
}

function productionDataUri(path) {
  const mime = ({
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".svg": "image/svg+xml", ".webp": "image/webp", ".ttf": "font/ttf",
    ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
  })[extname(path).toLowerCase()] || "application/octet-stream";
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

function loadProduction(gameDir) {
  const path = join(gameDir, "templates", "production.json");
  if (!existsSync(path)) return null;
  const production = readJson(path);
  for (const template of production.templates || []) {
    const templatePath = productionFile(gameDir, template.template, "production template");
    let source = readFileSync(templatePath, "utf8");
    for (const resource of template.resources || []) {
      const resourcePath = productionFile(gameDir, resource, "production resource");
      const reference = relative(dirname(templatePath), resourcePath).split(sep).join("/");
      const url = productionDataUri(resourcePath);
      source = source.replaceAll(`"${reference}"`, `"${url}"`).replaceAll(`'${reference}'`, `'${url}'`);
    }
    template.template_svg = source;
  }
  return production;
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

function googleFontsHref(game) {
  const grouped = new Map();
  for (const font of game.layout?.fonts || []) {
    if (!font?.family || font.asset_data || font.asset) continue;
    if (!grouped.has(font.family)) grouped.set(font.family, new Set());
    grouped.get(font.family).add(font.weight || 400);
  }
  if (!grouped.size) return "";
  const query = [...grouped].map(([family, weights]) =>
    `family=${encodeURIComponent(family).replaceAll("%20", "+")}:wght@${[...weights].sort().join(";")}`
  ).join("&");
  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
}

function renderDocument({ game, cards, printings, widthPx, heightPx,
  trimWidthPx, trimHeightPx, bleedPx, source }) {
  const data = safeJson({ game, cards, printings });
  const fontHref = googleFontsHref(game);
  const bleed = bleedPx > 0;
  return `<!doctype html>
<html><head><meta charset="utf-8">${fontHref ? `<link rel="stylesheet" href="${fontHref}">` : ""}<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;overflow:hidden}
#render-root{position:relative;width:${widthPx}px;height:${heightPx}px;overflow:hidden;background:#fff;--bleed-px:${bleedPx}px;--trim-width-px:${trimWidthPx}px;--trim-height-px:${trimHeightPx}px}
#render-root>.cf-card{width:100%!important;height:100%!important;min-height:100%!important;box-shadow:none!important}
.render-bleed{position:relative;width:100%;height:100%;overflow:hidden}
.render-bleed>.cf-card{position:absolute!important;left:var(--bleed-px)!important;top:var(--bleed-px)!important;width:var(--trim-width-px)!important;height:var(--trim-height-px)!important;min-height:var(--trim-height-px)!important;border-radius:0!important;box-shadow:none!important;z-index:2}
.render-bleed>.cf-card [data-lay-region="shell"],.render-bleed>.cf-card [data-lay-region="shell_mesh"],.render-bleed>.cf-card [data-lay-region="shell_scanlines"]{border-radius:0!important}
.render-bleed-field{position:absolute;inset:0;z-index:1;pointer-events:none;background:repeating-linear-gradient(60deg,transparent 0 4.4mm,rgba(255,255,255,.11) 4.45mm 4.7mm),repeating-linear-gradient(0deg,rgba(255,255,255,.06) 0 .12mm,transparent .12mm .7mm)}
.render-back{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--back-fg,#8c2f1b);color:var(--back-bg,#f6e3d3);font:800 72px/1.05 system-ui,sans-serif;text-align:center;padding:8%;overflow:hidden}
.render-back:after{content:"";position:absolute;inset:3.8%;border:8px solid currentColor;border-radius:3.5%;opacity:.9}
</style></head><body><div id="render-root"></div><script>
const DATA=${data};
const esc = s => (s??"").toString().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
${source}
const g=DATA.game;
const root=document.getElementById("render-root");
function settle(promise, ms){return Promise.race([promise,new Promise(resolve=>setTimeout(resolve,ms))]);}
async function settleAssets(){
  const styles=[...document.querySelectorAll('link[rel="stylesheet"]')].map(link=>link.sheet?Promise.resolve():new Promise(resolve=>{link.addEventListener("load",resolve,{once:true});link.addEventListener("error",resolve,{once:true});}));
  await settle(Promise.all(styles),5000);
  if(document.fonts && document.fonts.load) await settle(Promise.all(((g.layout&&g.layout.fonts)||[]).map(font=>document.fonts.load((font.weight||400)+' 12px "'+font.family+'"'))),5000);
  if(document.fonts && document.fonts.ready) await settle(document.fonts.ready,3000);
  const pending=[...root.querySelectorAll("img")].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{
    img.addEventListener("load",resolve,{once:true});img.addEventListener("error",resolve,{once:true});
  }));
  await settle(Promise.all(pending),5000);
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
}
window.renderPrinting=async function(index,geometry){
  const p=DATA.printings[index], c=DATA.cards.find(card=>card.id===p.card_id);
  if(!c) throw new Error("printing "+p.id+" references missing card "+p.card_id);
  const trimWidth=geometry?.trimWidthPx||${trimWidthPx},trimHeight=geometry?.trimHeightPx||${trimHeightPx},bleed=geometry?.bleedPx??${bleedPx};
  root.style.width=(geometry?.widthPx||${widthPx})+'px';root.style.height=(geometry?.heightPx||${heightPx})+'px';
  root.style.setProperty('--bleed-px',bleed+'px');root.style.setProperty('--trim-width-px',trimWidth+'px');root.style.setProperty('--trim-height-px',trimHeight+'px');
  const markup=layoutCard(g,c,p,{w:trimWidth});
  if(${bleed}){
    const ctx={g,card:c,printing:p,attributes:c.attributes||{}};
    const bg=layColor(g,ctx,(g.layout&&g.layout.card&&g.layout.card.bg)||"palette-deep","#333b42");
    root.innerHTML='<div class="render-bleed" style="background:'+esc(bg)+'"><div class="render-bleed-field"></div>'+markup+'</div>';
  }else root.innerHTML=markup;
  await settleAssets();
  const overflow=[...root.querySelectorAll("[data-lay-region]")].filter(el=>!el.classList.contains("lay-rect")&&!el.classList.contains("lay-image")&&(el.scrollWidth>el.clientWidth+1||el.scrollHeight>el.clientHeight+1)).map(el=>({region:el.dataset.layRegion,text:el.textContent.trim().slice(0,80),client:[el.clientWidth,el.clientHeight],scroll:[el.scrollWidth,el.scrollHeight]}));
  const face=root.firstElementChild;
  const mode=face?.classList.contains("source-card")?"source":face?.classList.contains("production-card")?"production":"layout";
  return {id:p.id,width:root.offsetWidth,height:root.offsetHeight,mode,source_status:face?.dataset?.sourceStatus||null,overflow,debug:[...root.querySelectorAll(".lay-region")].slice(0,12).map(el=>({id:el.textContent.trim().slice(0,40),style:el.getAttribute("style"),color:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor}))};
};
window.renderBack=async function(geometry){
  root.style.width=(geometry?.widthPx||${widthPx})+'px';root.style.height=(geometry?.heightPx||${heightPx})+'px';
  root.style.setProperty('--bleed-px',(geometry?.bleedPx??${bleedPx})+'px');root.style.setProperty('--trim-width-px',(geometry?.trimWidthPx||${trimWidthPx})+'px');root.style.setProperty('--trim-height-px',(geometry?.trimHeightPx||${trimHeightPx})+'px');
  const colors=Object.values(g.type_colors||{});const col=colors[0]||{fg:"#8c2f1b",bg:"#f6e3d3"};
  const back='<div class="render-back" style="--back-fg:'+esc(col.fg||"#8c2f1b")+';--back-bg:'+esc(col.bg||"#f6e3d3")+'">'+esc(g.title||g.id||"?")+'</div>';
  root.innerHTML=${bleed}?'<div class="render-bleed" style="background:'+esc(col.fg||"#8c2f1b")+'"><div class="render-bleed-field"></div>'+back+'</div>':back;
  await settleAssets();
};
</script></body></html>`;
}

async function main() {
  const argv = process.argv.slice(2);
  const bleedMode = argv.includes("--bleed");
  const args = argv.filter(arg => arg !== "--bleed");
  if (!args.length || args.includes("-h") || args.includes("--help")) usage();
  const gameDir = resolve(args[0]);
  const outDir = resolve(args[1] || join(gameDir, "exports", "faces"));
  for (const required of ["game.yaml", "components/cards.json", "components/printings.json"]) {
    if (!existsSync(join(gameDir, required))) usage(`${basename(gameDir)} is missing ${required}`);
  }

  const gameDoc = readYaml(join(gameDir, "game.yaml"));
  const layoutPath = join(gameDir, "templates", "layout.yaml");
  let layout = existsSync(layoutPath) ? normalizeLayout(gameDir, readYaml(layoutPath)) : null;
  const designEngines = loadDesignEngines(gameDir, { normalizeLayout: value => normalizeLayout(gameDir, value) });
  const cardDesign = designEngines?.card_design || null;
  if (!layout && cardDesign?.families?.length) layout = cardDesign.families[0].layout;
  const sourceOverlayPath = join(gameDir, "templates", "source-overlay.yaml");
  const sourceOverlay = existsSync(sourceOverlayPath) ? readYaml(sourceOverlayPath) : null;
  const production = loadProduction(gameDir);
  for (const region of sourceOverlay?.regions || [])
    for (const [value, asset] of Object.entries(region.patches || {}))
      region.patches[value] = localAssetUrl(gameDir, asset);
  for (const region of sourceOverlay?.regions || [])
    for (const assetKey of ["font_asset", "background_asset"])
      if (region.render?.[assetKey])
        region.render[assetKey] = localAssetUrl(gameDir, region.render[assetKey]);
  const cards = readJson(join(gameDir, "components", "cards.json"));
  const printings = readJson(join(gameDir, "components", "printings.json"))
    .map(printing => normalizePrinting(gameDir, printing));
  const physicalCard = (production?.enabled !== false && production?.card)
    || (sourceOverlay?.enabled !== false && sourceOverlay?.card)
    || layout?.card || production?.card || sourceOverlay?.card || {};
  const widthMm = Number(physicalCard.w_mm) || DEFAULT_W_MM;
  const heightMm = Number(physicalCard.h_mm) || DEFAULT_H_MM;
  const bleedMm = bleedMode ? Math.max(0, Number(physicalCard.bleed_mm) || 0) : 0;
  const trimWidthPx = Math.round(widthMm / 25.4 * DPI);
  const trimHeightPx = Math.round(heightMm / 25.4 * DPI);
  const bleedPx = Math.round(bleedMm / 25.4 * DPI);
  const widthPx = trimWidthPx + 2 * bleedPx;
  const heightPx = trimHeightPx + 2 * bleedPx;
  const game = {
    ...gameDoc,
    slug: gameDoc.id || basename(gameDir),
    layout,
    card_design: cardDesign,
    design_engines: designEnginesMetadata(designEngines),
    source_overlay: sourceOverlay,
    production,
    schema: gameDoc.attribute_definitions || [],
    type_colors: gameDoc.type_colors || {},
    faction_colors: gameDoc.faction_colors || {},
    symbols: (gameDoc.symbols || []).map(symbol => ({
      ...symbol,
      ...(symbol.asset ? { asset: localAssetUrl(gameDir, symbol.asset) } : {}),
    })),
    printings,
    scans: Object.fromEntries(printings.filter(p => p.scan).map(p => [p.card_id, p.scan])),
  };

  mkdirSync(outDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "forge-render-"));
  const docPath = join(scratch, "cards.html");
  writeFileSync(docPath, renderDocument({
    game, cards, printings, widthPx, heightPx, trimWidthPx, trimHeightPx,
    bleedPx, source: rendererSource(),
  }));

  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--allow-file-access-from-files", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: widthPx, height: heightPx },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", error => console.error(`render_cards page: ${error.message}`));
    await page.goto(pathToFileURL(docPath).href, { waitUntil: "load", timeout: 120_000 });
    const root = page.locator("#render-root");
    const overflow = [];
    const nonSource = [];
    const geometryFor = printing => {
      const size = printing.physical_size_mm || {};
      const printingWidthMm = Number(size.width) || widthMm;
      const printingHeightMm = Number(size.height) || heightMm;
      const printingTrimWidthPx = Math.round(printingWidthMm / 25.4 * DPI);
      const printingTrimHeightPx = Math.round(printingHeightMm / 25.4 * DPI);
      return {
        trimWidthPx: printingTrimWidthPx,
        trimHeightPx: printingTrimHeightPx,
        bleedPx,
        widthPx: printingTrimWidthPx + 2 * bleedPx,
        heightPx: printingTrimHeightPx + 2 * bleedPx,
      };
    };
    for (let i = 0; i < printings.length; i += 1) {
      const geometry = geometryFor(printings[i]);
      await page.setViewportSize({ width: geometry.widthPx, height: geometry.heightPx });
      const result = await page.evaluate(({ index, geometry }) => window.renderPrinting(index, geometry), { index: i, geometry });
      if (process.env.FMT_RENDER_DEBUG && i === 0) console.error(JSON.stringify(result.debug, null, 2));
      if (result.overflow.length) overflow.push({ printing: printings[i].id, regions: result.overflow });
      if (sourceOverlay?.enabled !== false && result.mode !== "source") nonSource.push({ printing: printings[i].id, mode: result.mode });
      await root.screenshot({
        path: join(outDir, `${printings[i].id}.png`),
        animations: "disabled",
        omitBackground: false,
      });
    }
    const backGeometry = geometryFor({});
    await page.setViewportSize({ width: backGeometry.widthPx, height: backGeometry.heightPx });
    await page.evaluate(geometry => window.renderBack(geometry), backGeometry);
    await root.screenshot({
      path: join(outDir, "_back.png"), animations: "disabled", omitBackground: false,
    });
    if (overflow.length) {
      console.warn(`render_cards: ${overflow.length} printing(s) contain clipped layout regions`);
      for (const item of overflow.slice(0, 20)) {
        console.warn(`  ${item.printing}: ${item.regions.map(region => region.region).join(", ")}`);
        if (process.env.FMT_RENDER_OVERFLOW_DETAILS === "1") {
          for (const region of item.regions) console.warn(`    ${region.region}: client ${region.client.join("x")} / scroll ${region.scroll.join("x")} — ${region.text}`);
        }
      }
      if (overflow.length > 20) console.warn(`  ...and ${overflow.length - 20} more`);
      if (process.env.FMT_RENDER_STRICT === "1") throw new Error("layout overflow check failed");
    }
    if (nonSource.length) {
      console.warn(`render_cards: ${nonSource.length} printing(s) fell back from the source-backed renderer`);
      for (const item of nonSource.slice(0, 20)) console.warn(`  ${item.printing}: ${item.mode}`);
      if (nonSource.length > 20) console.warn(`  ...and ${nonSource.length - 20} more`);
      if (process.env.FMT_SOURCE_STRICT === "1") throw new Error("source-backed renderer coverage check failed");
    }
  } finally {
    await browser.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`Rendered ${printings.length} faces + back with layoutCard() at ${widthPx}x${heightPx}px${bleedMode ? ` (${bleedMm}mm bleed)` : ""} -> ${outDir}`);
}

main().catch(error => {
  console.error(`render_cards: ${error.message}`);
  process.exit(1);
});
