#!/usr/bin/env node
/** Export one committed Forge game snapshot as a deterministic PnPInk proof.
 *
 * The CSV is derived output, never an alternate source of truth. The adapter
 * currently supports experimental packages only; it cannot activate PnPInk as
 * Forge's production renderer.
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { deterministicZip } from "./lib/deterministic-zip.mjs";
import { loadDesignEngines } from "./lib/design-engines.mjs";
import { buildForgeProject } from "./lib/forge-project.mjs";

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function gameFile(gameDir, rel, label) {
  if (typeof rel !== "string" || isAbsolute(rel)) throw new Error(`${label} must be a relative path`);
  const path = resolve(gameDir, rel);
  if (!inside(gameDir, path)) throw new Error(`${label} escapes the game directory: ${rel}`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${rel}`);
  return path;
}

function dig(value, path) {
  for (const key of String(path).split(".")) {
    if (value == null || typeof value !== "object") return "";
    value = value[key];
  }
  return value ?? "";
}

function csvCell(value) {
  if (Array.isArray(value)) value = value.join(" · ");
  if (typeof value === "boolean") value = value ? "true" : "false";
  const text = String(value ?? "").replaceAll("\r\n", "\n");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvForFamilies(adapter, cards) {
  const byId = new Map(cards.map(card => [card.id, card]));
  const rows = [];
  for (const family of adapter.families) {
    const card = byId.get(family.specimen);
    if (!card) throw new Error(`PnPInk family '${family.id}' references missing specimen '${family.specimen}'`);
    const fields = Object.entries(family.fields);
    rows.push([`{{t=${family.bbox}}}`, ...fields.map(([, target]) => target)]);
    rows.push(["{A4}.L{g=3}", ...fields.map(([source]) => dig(card, source))]);
  }
  return `${rows.map(row => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function exportPnpinkProof(gamePath, outputPath) {
  const gameDir = resolve(gamePath);
  const outDir = resolve(outputPath);
  const forgeProject = buildForgeProject(gameDir);
  const registry = loadDesignEngines(gameDir);
  const engine = registry?.engines.find(candidate => candidate.type === "pnpink");
  if (!engine) throw new Error("game has no PnPInk engine adapter");
  if (engine.status !== "experimental") throw new Error(`PnPInk adapter must remain experimental, got ${engine.status}`);
  const adapterPath = gameFile(gameDir, engine.source, "PnPInk adapter");
  const adapter = yaml.load(readFileSync(adapterPath, "utf8")) || {};
  if (adapter.version !== 1 || adapter.kind !== "pnpink") throw new Error("unsupported PnPInk adapter manifest");
  const templatePath = gameFile(gameDir, adapter.template, "PnPInk template");
  if (!inside(resolve(gameDir, "templates/card-design"), templatePath))
    throw new Error("PnPInk template must remain under templates/card-design/");
  const cardsPath = gameFile(gameDir, "components/cards.json", "cards");
  const cards = JSON.parse(readFileSync(cardsPath, "utf8"));
  const csv = csvForFamilies(adapter, cards);
  const svg = readFileSync(templatePath);
  const pnpManifest = `${JSON.stringify({
    format: "pnp",
    version: 1,
    svg: "netrunner-proof.svg",
    run_deckmaker_on_import: true,
    csv: "netrunner-proof.csv",
    assets_dir: "assets",
  }, null, 2)}\n`;
  const sourceHash = forgeProject.manifest.source.hash;
  const provenance = `${JSON.stringify({
    format: "forge-pnpink-adapter",
    version: 1,
    game: basename(gameDir),
    engine: engine.id,
    status: engine.status,
    source_hash: sourceHash,
    families: adapter.families.map(family => ({ id: family.id, specimen: family.specimen })),
  }, null, 2)}\n`;
  const entries = [
    ["forge-source.json", provenance],
    ["manifest.json", pnpManifest],
    ["netrunner-proof.csv", csv],
    ["netrunner-proof.svg", svg],
  ];
  mkdirSync(outDir, { recursive: true });
  copyFileSync(templatePath, join(outDir, "netrunner-proof.svg"));
  writeFileSync(join(outDir, "netrunner-proof.csv"), csv);
  writeFileSync(join(outDir, "manifest.json"), pnpManifest);
  writeFileSync(join(outDir, "forge-source.json"), provenance);
  writeFileSync(join(outDir, "netrunner-proof.pnp"), deterministicZip(entries));
  return {
    engine: engine.id,
    families: adapter.families.map(family => family.id),
    source_hash: sourceHash,
    output: outDir,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const gameDir = process.argv[2];
  if (!gameDir) {
    console.error("Usage: node tools/export-pnpink.mjs <game-dir> [output-dir]");
    process.exit(2);
  }
  const outDir = process.argv[3] || join(gameDir, "tmp", "pnpink-proof");
  const result = exportPnpinkProof(gameDir, outDir);
  console.log(`PnPInk proof: ${result.families.join(", ")} -> ${result.output}`);
  console.log(result.source_hash);
}
