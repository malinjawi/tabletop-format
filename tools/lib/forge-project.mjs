import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import yaml from "js-yaml";
import { diffCards } from "./carddiff.mjs";
import { designEnginesMetadata, loadDesignEngines } from "./design-engines.mjs";
import { deterministicZip, readZip } from "./deterministic-zip.mjs";
import { csvToTable, tableToCsv } from "./interchange-table.mjs";
import { buildNandeckProject } from "./nandeck-layout.mjs";
import { buildPnpinkProject } from "./pnpink.mjs";
import { diffRows, mergeRows } from "./row-merge.mjs";
import { buildSquibProject } from "./squib.mjs";
import { buildSvgDesignProject } from "./svg-design.mjs";
import { SOURCE_ASSETS_MANIFEST, loadSourceAssets, sourceAssetMetadata } from "./source-assets.mjs";

export const FORGE_PROJECT_FORMAT = "forge-design-project";
export const FORGE_PROJECT_VERSION = 1;
export const FORGE_DATA_WORKING_COPY_PROFILE = "forge-tabular-working-copy";
export const FORGE_DATA_WORKING_COPY_VERSION = 2;
export { diffRows, mergeRows } from "./row-merge.mjs";

const MISSING = Symbol("missing");
const clone = value => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => a === MISSING || b === MISSING ? a === b : isDeepStrictEqual(a, b);
const sha256 = value => createHash("sha256").update(value).digest("hex");

function safeRel(path, label = "path") {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\"))
    throw new Error(`${label} must be a safe relative path: ${path}`);
  if (path.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error(`${label} must be a safe relative path: ${path}`);
  return path;
}

function gamePath(gameDir, rel, label = "file") {
  safeRel(rel, label);
  const root = resolve(gameDir), path = resolve(root, rel), relCheck = relative(root, path);
  if (relCheck === ".." || relCheck.startsWith(`..${sep}`) || isAbsolute(relCheck))
    throw new Error(`${label} escapes the game directory: ${rel}`);
  return path;
}

function walk(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "exports" || entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name), rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function collectAssetRefs(value, out = new Set()) {
  if (typeof value === "string" && value.startsWith("assets/") && !value.includes("..")) out.add(value);
  else if (Array.isArray(value)) for (const item of value) collectAssetRefs(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectAssetRefs(item, out);
  return out;
}

function parseDocument(path) {
  const ext = path.toLowerCase().split(".").pop();
  try {
    if (ext === "json") return JSON.parse(readFileSync(path, "utf8"));
    if (ext === "yaml" || ext === "yml") return yaml.load(readFileSync(path, "utf8"));
  } catch {}
  return null;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function addEntry(entries, path, value) {
  safeRel(path, "bundle entry");
  entries.set(path, Buffer.isBuffer(value) ? value : Buffer.from(value));
}

function writeEntries(outDir, entries) {
  for (const [rel, content] of entries) {
    const path = gamePath(outDir, rel, "bundle output");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function fileRecord(sourcePath, content, role) {
  return {
    source_path: sourcePath,
    project_path: `project/${sourcePath}`,
    role,
    sha256: sha256(content),
    size: content.length,
  };
}

function allowedSourcePath(path) {
  return path === "game.yaml"
    || PORTABLE_SOURCE_ROOTS.some(root => path.startsWith(`${root}/`));
}

// Keep the portable project broader than any one authoring tool. Cards and
// printings get friendly CSV tables below; the rest travel as ordinary,
// reviewable project files so a round trip cannot silently drop the game around
// the cards. Governance, rights declarations, community discussion, and build
// outputs are deliberately excluded from this design-editing boundary.
const PORTABLE_SOURCE_ROOTS = [
  "assets", "components", "decks", "design", "formats", "restrictions",
  "rules", "rulings", "sets", "setups", "templates",
];

function sourceRole(path) {
  if (path.startsWith("components/")) return "component-source";
  if (path.startsWith("setups/")) return "playable-setup";
  if (path.startsWith("decks/")) return "deck-source";
  if (path.startsWith("formats/") || path.startsWith("restrictions/")) return "organized-play-source";
  if (path.startsWith("sets/")) return "set-source";
  if (path.startsWith("rulings/")) return "ruling-source";
  if (path.startsWith("design/")) return "design-document";
  if (path.startsWith("rules/")) return "rulebook-source";
  if (path.startsWith("templates/")) return "design-source";
  if (path.startsWith("assets/")) return "design-asset";
  return "game-source";
}

/**
 * Build the small interchange package used by spreadsheet-first and hosted
 * component editors.  It deliberately uses the same manifest and analyzer as
 * a full Forge design project, so returning the package gets the exact same
 * three-way merge, validation, commit, fork, and PR behavior without carrying
 * layout sources or artwork through a tool that cannot preserve them.
 */
export function buildForgeDataWorkingCopy(gamePathValue, { sourceRef = null } = {}) {
  const gameDir = resolve(gamePathValue);
  const game = yaml.load(readFileSync(gamePath(gameDir, "game.yaml"), "utf8")) || {};
  const cards = JSON.parse(readFileSync(gamePath(gameDir, "components/cards.json"), "utf8"));
  const printings = JSON.parse(readFileSync(gamePath(gameDir, "components/printings.json"), "utf8"));
  const tokensPath = gamePath(gameDir, "components/tokens.json"), tokens = existsSync(tokensPath) ? JSON.parse(readFileSync(tokensPath, "utf8")) : [];
  const cardTable = tableToCsv(cards, "cards"), printingTable = tableToCsv(printings, "printings");
  const entries = new Map();
  const cardBytes = jsonBytes(cards), printingBytes = jsonBytes(printings), tokenBytes = jsonBytes(tokens);
  const files = [
    fileRecord("components/cards.json", cardBytes, "canonical-cards"),
    fileRecord("components/printings.json", printingBytes, "canonical-printings"),
    fileRecord("components/tokens.json", tokenBytes, "canonical-pieces"),
  ];
  addEntry(entries, "project/components/cards.json", cardBytes);
  addEntry(entries, "project/components/printings.json", printingBytes);
  addEntry(entries, "base/components/cards.json", cardBytes);
  addEntry(entries, "base/components/printings.json", printingBytes);
  addEntry(entries, "editable/cards.csv", cardTable.csv);
  addEntry(entries, "editable/printings.csv", printingTable.csv);
  const tables = {
    cards: { editable_path: "editable/cards.csv", base_path: "base/components/cards.json", project_path: "project/components/cards.json", id: "id", columns: cardTable.columns },
    printings: { editable_path: "editable/printings.csv", base_path: "base/components/printings.json", project_path: "project/components/printings.json", id: "id", columns: printingTable.columns },
  };
  const tokenTable=tableToCsv(tokens,"tokens");
  addEntry(entries,"project/components/tokens.json",tokenBytes);addEntry(entries,"base/components/tokens.json",tokenBytes);
  addEntry(entries,"editable/tokens.csv",tokenTable.csv);
  tables.tokens={editable_path:"editable/tokens.csv",base_path:"base/components/tokens.json",project_path:"project/components/tokens.json",id:"id",columns:tokenTable.columns};
  addEntry(entries, "README.md", `# Forge data working copy\n\nThis is a small, commit-pinned table handoff for Dextrous, Component Studio, Google Sheets, Excel, LibreOffice, or a custom script.\n\n1. Keep the permanent \`id\` column. It is how Forge follows a component through renames.\n2. Import a table under \`editable/\` into your editor. You may edit it directly or export the updated table from that editor.\n3. Replace that CSV in this package. Keep \`manifest.json\`, \`base/**\`, and \`project/**\` unchanged.\n4. Zip the package contents at the root and return it through Forge's Design workspace.\n5. Forge shows the semantic and rendered impact before it creates one commit or pull request.\n\n\`cards.csv\` is playable card content; \`printings.csv\` carries edition, quantity, art, artist, and flavor metadata. \`tokens.csv\` carries non-card pieces such as tokens and dials and is present even when it starts empty. Layouts remain in Forge or their declared design adapter; Dextrous and Component Studio project layouts are not falsely treated as portable files.\n`);
  const manifest = {
    format: FORGE_PROJECT_FORMAT,
    version: FORGE_PROJECT_VERSION,
    profile: FORGE_DATA_WORKING_COPY_PROFILE,
    profile_version: FORGE_DATA_WORKING_COPY_VERSION,
    game: { id: game.id || basename(gameDir), title: game.title || game.id || basename(gameDir), version: game.version || "" },
    source: { generated_at: "deterministic", with_art: false, hash: "", ...(sourceRef ? { ref: sourceRef } : {}) },
    adapters: [
      { id: "xlsx-workbook", format: "xlsx", version: 1 },
      { id: "dextrous-csv", format: "csv", version: 1 },
      { id: "component-studio-csv", format: "csv", version: 1 },
      { id: "spreadsheet-csv", format: "csv", version: 1 },
    ],
    tables,
    files,
  };
  manifest.source.hash = `sha256:${sha256(Buffer.from(files.map(file => `${file.source_path}:${file.sha256}`).join("\n")))}`;
  addEntry(entries, "manifest.json", jsonBytes(manifest));
  return { manifest, entries, archive: deterministicZip(entries) };
}

export function buildForgeProject(gamePathValue, { withArt = false, sourceRef = null } = {}) {
  const gameDir = resolve(gamePathValue);
  const gameYaml = readFileSync(gamePath(gameDir, "game.yaml"), "utf8");
  const game = yaml.load(gameYaml) || {};
  const cards = JSON.parse(readFileSync(gamePath(gameDir, "components/cards.json"), "utf8"));
  const printings = JSON.parse(readFileSync(gamePath(gameDir, "components/printings.json"), "utf8"));
  const tokensPath=gamePath(gameDir,"components/tokens.json"),tokens=existsSync(tokensPath)?JSON.parse(readFileSync(tokensPath,"utf8")):null;
  const cardTable = tableToCsv(cards, "cards"), printingTable = tableToCsv(printings, "printings");
  const entries = new Map(), files = [], projectAdded = new Set();

  const addProjectFile = (sourcePath, content, role) => {
    if (projectAdded.has(sourcePath)) return;
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    addEntry(entries, `project/${sourcePath}`, buffer);
    files.push(fileRecord(sourcePath, buffer, role));
    projectAdded.add(sourcePath);
  };
  addProjectFile("game.yaml", gameYaml, "game-metadata");
  addProjectFile("components/cards.json", jsonBytes(cards), "canonical-cards");
  addProjectFile("components/printings.json", jsonBytes(printings), "canonical-printings");
  addEntry(entries, "base/components/cards.json", jsonBytes(cards));
  addEntry(entries, "base/components/printings.json", jsonBytes(printings));
  addEntry(entries, "editable/cards.csv", cardTable.csv);
  addEntry(entries, "editable/printings.csv", printingTable.csv);
  let tokenTable=null;
  if(tokens){const tokenBytes=jsonBytes(tokens);tokenTable=tableToCsv(tokens,"tokens");addProjectFile("components/tokens.json",tokenBytes,"canonical-pieces");addEntry(entries,"base/components/tokens.json",tokenBytes);addEntry(entries,"editable/tokens.csv",tokenTable.csv);}

  const printingAssetRefs = collectAssetRefs(printings);
  const assetRefs = collectAssetRefs(game);
  for (const root of PORTABLE_SOURCE_ROOTS.filter(root => root !== "assets")) {
    for (const rel of walk(join(gameDir, root), root)) {
      if (rel === "components/cards.json" || rel === "components/printings.json" || rel === "components/tokens.json") continue;
      const content = readFileSync(gamePath(gameDir, rel));
      addProjectFile(rel, content, sourceRole(rel));
      const parsed = parseDocument(gamePath(gameDir, rel));
      if (parsed) collectAssetRefs(parsed, assetRefs);
      else if (rel.endsWith(".svg") || rel.endsWith(".css")) {
        const text = content.toString("utf8");
        for (const match of text.matchAll(/(?:href|src|url\()\s*["']?(assets\/[A-Za-z0-9_./ -]+)/g))
          if (!match[1].includes("..")) assetRefs.add(match[1].replace(/["')\s]+$/, ""));
      }
    }
  }
  const sourcePackages = loadSourceAssets(gameDir);
  const packageAssetRefs = new Set();
  if (sourcePackages) {
    addProjectFile(SOURCE_ASSETS_MANIFEST, readFileSync(gamePath(gameDir, SOURCE_ASSETS_MANIFEST)), "source-package-manifest");
    for (const pack of sourcePackages.packages) for (const record of [...pack.source_files, ...pack.previews]) {
      if (!record.exists) continue;
      if (record.path.startsWith("assets/")) packageAssetRefs.add(record.path);
      addProjectFile(record.path, readFileSync(gamePath(gameDir, record.path)),
        ["model-3d", "miniature"].includes(pack.kind) ? "3d-source" : "native-production-source");
    }
  }
  if (withArt) collectAssetRefs(printings, assetRefs);
  // Asset references are discovered from every portable structured source,
  // including tokens and setups. Card face art retains the existing opt-in
  // --with-art behavior.
  for (const rel of [...assetRefs].sort()) {
    if (!withArt && !packageAssetRefs.has(rel) && (printingAssetRefs.has(rel) || rel.startsWith("assets/source-faces/"))) continue;
    const path = gamePath(gameDir, rel, "asset");
    if (existsSync(path) && lstatSync(path).isFile()) addProjectFile(rel, readFileSync(path), withArt ? "referenced-asset" : "design-asset");
  }

  let engines = null;
  try { engines = designEnginesMetadata(loadDesignEngines(gameDir)); } catch {}
  const adapters = [];
  try {
    const nandeck = buildNandeckProject(gameDir, { assetPrefix: "../../project/", preferLocalArt: withArt });
    for (const [rel, content] of nandeck.entries) addEntry(entries, `adapters/nandeck/${rel}`, content);
    adapters.push({
      id: "nandeck",
      root: "adapters/nandeck",
      format: nandeck.manifest.format,
      version: nandeck.manifest.version,
      source_hash: nandeck.manifest.source_hash,
      families: nandeck.manifest.families.map(family => family.family),
    });
  } catch (error) {
    adapters.push({ id: "nandeck", unavailable: true, reason: error.message });
  }
  try {
    const svg = buildSvgDesignProject(gameDir);
    for (const [rel, content] of svg.entries) addEntry(entries, `adapters/svg/${rel}`, content);
    adapters.push({
      id: "svg",
      root: "adapters/svg",
      format: svg.manifest.format,
      version: svg.manifest.version,
      source_hash: svg.manifest.source_hash,
      families: svg.manifest.families.map(family => family.family),
    });
  } catch (error) {
    adapters.push({ id: "svg", unavailable: true, reason: error.message });
  }
  try {
    const pnpink = buildPnpinkProject(gameDir);
    for (const [rel, content] of pnpink.entries) addEntry(entries, `adapters/pnpink/${rel}`, content);
    adapters.push({
      id: "pnpink", root: "adapters/pnpink", format: pnpink.manifest.format,
      version: pnpink.manifest.version, source_hash: pnpink.manifest.source_hash,
      upstream: pnpink.manifest.upstream,
      families: pnpink.manifest.families.map(family => family.family),
    });
  } catch (error) {
    adapters.push({ id: "pnpink", unavailable: true, reason: error.message });
  }
  try {
    const squib = buildSquibProject(gameDir, { sourceRef: sourceRef || "working-tree" });
    for (const [rel, content] of squib.entries) addEntry(entries, `adapters/squib/${rel}`, content);
    adapters.push({
      id: "squib", root: "adapters/squib", format: squib.manifest.format,
      version: squib.manifest.version, source_hash: squib.manifest.source_hash,
      upstream: squib.manifest.tested_upstream,
      families: squib.manifest.families.map(family => family.id),
    });
  } catch (error) {
    adapters.push({ id: "squib", unavailable: true, reason: error.message });
  }
  const manifest = {
    format: FORGE_PROJECT_FORMAT,
    version: FORGE_PROJECT_VERSION,
    game: { id: game.id || basename(gameDir), title: game.title || game.id || basename(gameDir), version: game.version || "" },
    source: { generated_at: "deterministic", with_art: withArt, hash: "", ...(sourceRef ? { ref: sourceRef } : {}) },
    engines,
    source_packages: sourceAssetMetadata(sourcePackages),
    adapters,
    tables: {
      cards: { editable_path: "editable/cards.csv", base_path: "base/components/cards.json", project_path: "project/components/cards.json", id: "id", columns: cardTable.columns },
      printings: { editable_path: "editable/printings.csv", base_path: "base/components/printings.json", project_path: "project/components/printings.json", id: "id", columns: printingTable.columns },
      ...(tokenTable?{tokens:{editable_path:"editable/tokens.csv",base_path:"base/components/tokens.json",project_path:"project/components/tokens.json",id:"id",columns:tokenTable.columns}}:{}),
    },
    files: files.sort((a, b) => a.source_path.localeCompare(b.source_path)),
  };
  manifest.source.hash = `sha256:${sha256(Buffer.from(manifest.files.map(file => `${file.source_path}:${file.sha256}`).join("\n")))}`;
  addEntry(entries, "manifest.json", jsonBytes(manifest));
  return { manifest, entries, archive: deterministicZip(entries) };
}

export function exportForgeProject(gameDir, outDir, options = {}) {
  const built = buildForgeProject(gameDir, options), destination = resolve(outDir);
  writeEntries(destination, built.entries);
  const archivePath = join(destination, `${built.manifest.game.id}.forge-project.zip`);
  writeFileSync(archivePath, built.archive);
  return { ...built, outDir: destination, archivePath };
}

function entriesFromDirectory(dir) {
  return new Map(walk(dir).map(rel => [rel, readFileSync(gamePath(dir, rel, "bundle entry"))]));
}

export function loadForgeProject(input) {
  let entries;
  if (input instanceof Map) entries = new Map(input);
  else if (Buffer.isBuffer(input) || input instanceof Uint8Array) entries = readZip(input);
  else {
    const path = resolve(input);
    entries = lstatSync(path).isDirectory() ? entriesFromDirectory(path) : readZip(readFileSync(path));
  }
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new Error("Forge project is missing manifest.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.format !== FORGE_PROJECT_FORMAT || manifest.version !== FORGE_PROJECT_VERSION)
    throw new Error(`unsupported Forge project format: ${manifest.format} v${manifest.version}`);
  if (!manifest.game?.id || !manifest.tables?.cards || !manifest.tables?.printings || !Array.isArray(manifest.files))
    throw new Error("Forge project manifest is incomplete");
  for (const record of manifest.files) {
    const sourcePath = safeRel(record.source_path, "source_path");
    safeRel(record.project_path, "project_path");
    if (!allowedSourcePath(sourcePath)) throw new Error(`project cannot write '${sourcePath}'`);
    if (!/^([a-f0-9]{64})$/.test(record.sha256 || "")) throw new Error(`invalid baseline hash for '${sourcePath}'`);
  }
  return { manifest, entries };
}

function required(entries, path) {
  const value = entries.get(safeRel(path, "manifest path"));
  if (!value) throw new Error(`Forge project is missing ${path}`);
  return value;
}

function chooseTable(entries, table, kind) {
  const baseBytes = required(entries, table.base_path), rawBytes = required(entries, table.project_path);
  const csvBytes = required(entries, table.editable_path);
  const base = JSON.parse(baseBytes.toString("utf8")), raw = JSON.parse(rawBytes.toString("utf8"));
  const csv = csvToTable(csvBytes.toString("utf8"), table, kind, base);
  const rawChanged = !equal(base, raw), csvChanged = !equal(base, csv);
  if (rawChanged && csvChanged && !equal(raw, csv))
    return { base, proposed: null, conflict: { kind, id: "*", path: "source", base: "base", proposed: "both CSV and JSON changed differently", current: null } };
  return { base, proposed: rawChanged ? raw : csvChanged ? csv : base, conflict: null };
}

export function analyzeForgeProject(gamePathValue, bundle, { allowGameIdMismatch = false } = {}) {
  const gameDir = resolve(gamePathValue), { manifest, entries } = loadForgeProject(bundle);
  const currentGame = yaml.load(readFileSync(gamePath(gameDir, "game.yaml"), "utf8")) || {};
  if (!allowGameIdMismatch && manifest.game?.id && currentGame.id && manifest.game.id !== currentGame.id)
    throw new Error(`project belongs to '${manifest.game.id}', not '${currentGame.id}'`);
  const cardsChoice = chooseTable(entries, manifest.tables.cards, "cards");
  const printingsChoice = chooseTable(entries, manifest.tables.printings, "printings");
  const tokensChoice = manifest.tables.tokens ? chooseTable(entries,manifest.tables.tokens,"tokens") : null;
  const conflicts = [cardsChoice.conflict, printingsChoice.conflict,tokensChoice?.conflict].filter(Boolean);
  const currentCards = JSON.parse(readFileSync(gamePath(gameDir, "components/cards.json"), "utf8"));
  const currentPrintings = JSON.parse(readFileSync(gamePath(gameDir, "components/printings.json"), "utf8"));
  const currentTokensPath=gamePath(gameDir,"components/tokens.json"),currentTokens=existsSync(currentTokensPath)?JSON.parse(readFileSync(currentTokensPath,"utf8")):[];
  const cardMerge = cardsChoice.proposed ? mergeRows(cardsChoice.base, cardsChoice.proposed, currentCards, "cards") : { merged: currentCards, conflicts: [] };
  const printingMerge = printingsChoice.proposed ? mergeRows(printingsChoice.base, printingsChoice.proposed, currentPrintings, "printings") : { merged: currentPrintings, conflicts: [] };
  const tokenMerge = tokensChoice?.proposed ? mergeRows(tokensChoice.base,tokensChoice.proposed,currentTokens,"tokens") : {merged:currentTokens,conflicts:[]};
  conflicts.push(...cardMerge.conflicts, ...printingMerge.conflicts,...tokenMerge.conflicts);
  const files = [];
  if (!equal(currentCards, cardMerge.merged)) files.push({ path: "components/cards.json", content: jsonBytes(cardMerge.merged), kind: "cards" });
  if (!equal(currentPrintings, printingMerge.merged)) files.push({ path: "components/printings.json", content: jsonBytes(printingMerge.merged), kind: "printings" });
  if(tokensChoice&&!equal(currentTokens,tokenMerge.merged))files.push({path:"components/tokens.json",content:jsonBytes(tokenMerge.merged),kind:"tokens"});

  const knownProjectPaths = new Set();
  for (const record of manifest.files || []) {
    const sourcePath = safeRel(record.source_path, "source_path"), projectPath = safeRel(record.project_path, "project_path");
    knownProjectPaths.add(projectPath);
    if (["components/cards.json", "components/printings.json", "components/tokens.json"].includes(sourcePath)) continue;
    const incoming = entries.get(projectPath) ?? MISSING;
    const incomingChanged = incoming === MISSING || sha256(incoming) !== record.sha256;
    if (!incomingChanged) continue;
    const currentPath = gamePath(gameDir, sourcePath), current = existsSync(currentPath) ? readFileSync(currentPath) : MISSING;
    const currentAtBase = current !== MISSING && sha256(current) === record.sha256;
    if (incoming === MISSING) {
      if (current === MISSING) continue;
      if (!currentAtBase) conflicts.push({ kind: "file", id: sourcePath, path: "*", base: record.sha256, proposed: null, current: sha256(current) });
      else files.push({ path: sourcePath, content: null, kind: "removed-file" });
    } else if (current === MISSING) files.push({ path: sourcePath, content: incoming, kind: "added-file" });
    else if (currentAtBase || sha256(current) === sha256(incoming)) {
      if (sha256(current) !== sha256(incoming)) files.push({ path: sourcePath, content: incoming, kind: "changed-file" });
    } else conflicts.push({ kind: "file", id: sourcePath, path: "*", base: record.sha256, proposed: sha256(incoming), current: sha256(current) });
  }
  for (const [projectPath, incoming] of entries) {
    if (!projectPath.startsWith("project/") || knownProjectPaths.has(projectPath)) continue;
    const sourcePath = safeRel(projectPath.slice("project/".length), "new project file");
    if (!allowedSourcePath(sourcePath) || sourcePath === "game.yaml"
      || sourcePath === "components/cards.json" || sourcePath === "components/printings.json" || sourcePath === "components/tokens.json") continue;
    const currentPath = gamePath(gameDir, sourcePath), current = existsSync(currentPath) ? readFileSync(currentPath) : null;
    if (!current) files.push({ path: sourcePath, content: incoming, kind: "added-file" });
    else if (sha256(current) !== sha256(incoming)) conflicts.push({ kind: "file", id: sourcePath, path: "*", base: null, proposed: sha256(incoming), current: sha256(current) });
  }
  const cardChanges = diffRows(currentCards, cardMerge.merged, "cards");
  const printingChanges = diffRows(currentPrintings, printingMerge.merged, "printings");
  const tokenChanges = diffRows(currentTokens,tokenMerge.merged,"tokens");
  const previewCardIds = new Set([...cardChanges.changed, ...cardChanges.added]);
  const previewPrintingIds = new Set([...printingChanges.changed, ...printingChanges.added]);
  return {
    format: manifest.format,
    profile: manifest.profile || null,
    game: manifest.game,
    source_hash: manifest.source?.hash,
    changes: {
      cards: cardChanges,
      card_fields: diffCards(currentCards, cardMerge.merged),
      printings: printingChanges,
      tokens: tokenChanges,
      files: files.filter(file => !["cards", "printings", "tokens"].includes(file.kind)).map(file => ({ path: file.path, kind: file.kind })),
    },
    preview: {
      cards: cardMerge.merged.filter(card => previewCardIds.has(card.id)),
      printings: printingMerge.merged.filter(printing => previewPrintingIds.has(printing.id)),
      tokens: tokenMerge.merged.filter(token=>new Set([...tokenChanges.changed,...tokenChanges.added]).has(token.id)),
    },
    conflicts,
    files,
  };
}

export function writeForgeProjectChanges(gamePathValue, result, { allowDelete = false } = {}) {
  if (result.conflicts.length) throw new Error(`cannot write a project with ${result.conflicts.length} conflict(s)`);
  const removesRows = result.changes.cards.removed.length || result.changes.printings.removed.length || result.changes.tokens?.removed.length;
  if (!allowDelete && (removesRows || result.files.some(file => file.content === null)))
    throw new Error("project removes files or rows; re-run with explicit deletion permission");
  const gameDir = resolve(gamePathValue);
  for (const file of result.files) {
    const path = gamePath(gameDir, file.path, "write path");
    if (!allowedSourcePath(file.path)) throw new Error(`project cannot write '${file.path}'`);
    if (file.content === null) { rmSync(path, { force: true }); continue; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
}
