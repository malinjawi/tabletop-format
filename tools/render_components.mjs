#!/usr/bin/env node
/**
 * Canonical Forge component rasterizer for digital-table adapters.
 *
 * Usage: node tools/render_components.mjs <game-dir> <out-dir> [--dpi 300] [--ref <sha>]
 *
 * It renders the same versioned component families used by Piece Studio and
 * manufacturing exports, but without bleed or trim guides. PNGs are RGBA and
 * capped at 4096px per side to stay inside Tabletop Simulator's documented
 * custom-object texture boundary.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { chromium } from "playwright-core";
import {
  buildComponentProduction, componentFace, componentFamily, loadComponentDesign,
  renderComponentSvg,
} from "./lib/component-design.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_TEXTURE = 4096;
const DEFAULT_DPI = 300;

function usage(message) {
  if (message) console.error(`render_components: ${message}`);
  console.error("Usage: node tools/render_components.mjs <game-dir> <out-dir> [--dpi 300] [--ref <sha>]");
  process.exit(2);
}

function commandPath(name) {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

function findChrome() {
  const candidates = [
    process.env.FMT_CHROME_BIN,
    commandPath("chromium"), commandPath("chromium-browser"),
    commandPath("google-chrome"), commandPath("google-chrome-stable"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Chrome/Chromium was not found; install Chrome or set FMT_CHROME_BIN");
  return found;
}

function geometry(widthMm, heightMm, dpi) {
  const rawWidth = Math.max(1, Math.round(widthMm / 25.4 * dpi));
  const rawHeight = Math.max(1, Math.round(heightMm / 25.4 * dpi));
  const scale = Math.min(1, MAX_TEXTURE / rawWidth, MAX_TEXTURE / rawHeight);
  return {
    width: Math.max(1, Math.round(rawWidth * scale)),
    height: Math.max(1, Math.round(rawHeight * scale)),
    requested_dpi: dpi,
    effective_dpi: Math.round(dpi * scale * 100) / 100,
    capped: scale < 1,
  };
}

function parseArgs(argv) {
  const positional = [];
  let dpi = DEFAULT_DPI, ref = "working-tree";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dpi") dpi = Number(argv[++index]);
    else if (arg === "--ref") ref = argv[++index];
    else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 2 || !Number.isFinite(dpi) || dpi < 72 || dpi > 1200) usage();
  return { gameDir: resolve(positional[0]), outDir: resolve(positional[1]), dpi, ref };
}

async function main() {
  const { gameDir, outDir, dpi, ref } = parseArgs(process.argv.slice(2));
  const piecesPath = join(gameDir, "components", "tokens.json");
  if (!existsSync(piecesPath)) usage(`${basename(gameDir)} has no components/tokens.json`);
  const pieces = JSON.parse(readFileSync(piecesPath, "utf8"));
  if (!Array.isArray(pieces) || !pieces.length) usage(`${basename(gameDir)} has no component rows`);
  const design = loadComponentDesign(gameDir);
  const production = buildComponentProduction(gameDir, { sourceRef: ref }).manifest;
  const productionById = new Map(production.pieces.map(piece => [piece.id, piece]));
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir))
    if (name === "component-assets.json" || name.endsWith("-front.png") || name.endsWith("-back.png")) unlinkSync(join(outDir, name));

  const browser = await chromium.launch({
    executablePath: findChrome(), headless: true,
    args: ["--allow-file-access-from-files", "--disable-gpu"],
  });
  const assets = [];
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
    for (const piece of pieces) {
      const sides = piece.back ? ["front", "back"] : ["front"];
      const frontFamily = componentFamily(design, piece);
      for (const side of sides) {
        const face = componentFace(piece, side), family = componentFamily(design, face);
        const widthMm = Number(face.size_mm?.width || family.size_mm.width);
        const heightMm = Number(face.size_mm?.height || family.size_mm.height);
        const raster = geometry(widthMm, heightMm, dpi);
        const svg = renderComponentSvg(gameDir, piece, design, { guides: false, side, bleed: 0 });
        await page.setViewportSize({ width: raster.width, height: raster.height });
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:${raster.width}px;height:${raster.height}px;background:transparent;overflow:hidden}svg{display:block;width:${raster.width}px!important;height:${raster.height}px!important}</style>${svg}`, { waitUntil: "load" });
        await page.evaluate(async () => {
          if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))]);
          const images = [...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
            image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true });
          }));
          await Promise.all(images);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const filename = `${piece.id}-${side}.png`, path = join(outDir, filename);
        await page.locator("svg").screenshot({ path, omitBackground: true, animations: "disabled" });
        const bytes = readFileSync(path);
        assets.push({
          component_id: piece.id, side, file: filename,
          width_mm: widthMm, height_mm: heightMm,
          width_px: raster.width, height_px: raster.height,
          requested_dpi: raster.requested_dpi, effective_dpi: raster.effective_dpi,
          capped_to_4096: raster.capped, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
        });
      }
    }
  } finally { await browser.close(); }

  const components = pieces.map(piece => {
    const family = componentFamily(design, piece), produced = productionById.get(piece.id);
    const widthMm = Number(piece.size_mm?.width || family.size_mm.width);
    const heightMm = Number(piece.size_mm?.height || family.size_mm.height);
    return {
      id: piece.id, name: piece.name, kind: piece.kind, family: family.id, shape: family.shape,
      size_mm: { width: widthMm, height: heightMm },
      declared_quantity: produced.declared_quantity, resolved_quantity: produced.resolved_quantity,
      per_player: produced.per_player, description: piece.description || "", notes: piece.notes || "",
      attributes: piece.attributes || {}, faces: piece.faces || [], artwork: produced.artwork,
      assets: assets.filter(asset => asset.component_id === piece.id),
    };
  });
  const manifest = {
    format: "forge-digital-component-assets", version: 1, source_ref: ref,
    renderer: "forge-component-design", component_design_version: production.version,
    texture_policy: { color: "RGBA", maximum_side_px: MAX_TEXTURE, requested_dpi: dpi, bleed_mm: 0, trim_guides: false },
    components,
    rights: production.artwork_rights,
    boundaries: [
      "These PNGs are derived adapter assets; versioned component data, design families, artwork, and rights remain the source of truth.",
      "Digital textures omit manufacturing bleed and trim guides and are capped at 4096 pixels per side.",
    ],
  };
  writeFileSync(join(outDir, "component-assets.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Rendered ${assets.length} digital component face(s) from ${components.length} component type(s) -> ${outDir}`);
}

main().catch(error => { console.error(`render_components: ${error.message}`); process.exit(1); });
