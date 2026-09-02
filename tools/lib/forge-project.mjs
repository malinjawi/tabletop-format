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
import { SOURCE_ASSETS_MANIFEST, loadSourceAssets, sourceAssetMetadata } from "./source-assets.mjs";

export const FORGE_PROJECT_FORMAT = "forge-design-project";
export const FORGE_PROJECT_VERSION = 1;

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

export function buildForgeProject(gamePathValue, { withArt = false, sourceRef = null } = {}) {
  const gameDir = resolve(gamePathValue);
  const gameYaml = readFileSync(gamePath(gameDir, "game.yaml"), "utf8");
  const game = yaml.load(gameYaml) || {};
  const cards = JSON.parse(readFileSync(gamePath(gameDir, "components/cards.json"), "utf8"));
  const printings = JSON.parse(readFileSync(gamePath(gameDir, "components/printings.json"), "utf8"));
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

  const printingAssetRefs = collectAssetRefs(printings);
  const assetRefs = collectAssetRefs(game);
  for (const root of PORTABLE_SOURCE_ROOTS.filter(root => root !== "assets")) {
    for (const rel of walk(join(gameDir, root), root)) {
      if (rel === "components/cards.json" || rel === "components/printings.json") continue;
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

function get(value, path) {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return MISSING;
    value = value[key];
  }
  return value;
}

function leafPaths(...values) {
  const out = [];
  const visit = (candidates, prefix) => {
    const objects = candidates.map(value => value !== MISSING && value != null
      && typeof value === "object" && !Array.isArray(value));
    // A whole object appeared or disappeared. Treat that parent as the changed
    // leaf so the merge deletes/replaces it atomically instead of walking its
    // old children and leaving an invalid empty shell.
    if (prefix.length && objects.some(Boolean) && !objects.every(Boolean)) {
      out.push(prefix);
      return;
    }
    if (!objects.every(Boolean)) {
      if (prefix.length) out.push(prefix);
      return;
    }
    const keys = new Set(candidates.flatMap(value => Object.keys(value)));
    if (!keys.size && prefix.length) out.push(prefix);
    for (const key of keys) visit(candidates.map(value => Object.prototype.hasOwnProperty.call(value, key) ? value[key] : MISSING), [...prefix, key]);
  };
  visit(values, []);
  return out;
}

function set(value, path, next) {
  for (const key of path.slice(0, -1)) value = value[key] ||= {};
  if (next === MISSING) delete value[path.at(-1)]; else value[path.at(-1)] = clone(next);
}

export function mergeRows(baseRows, proposedRows, currentRows, kind) {
  const by = rows => new Map(rows.map(row => [row.id, row]));
  const base = by(baseRows), proposed = by(proposedRows), current = by(currentRows);
  const merged = currentRows.map(clone), mergedBy = by(merged), conflicts = [];
  const ids = new Set([...base.keys(), ...proposed.keys()]);
  for (const id of ids) {
    const b = base.get(id) ?? MISSING, p = proposed.get(id) ?? MISSING, c = current.get(id) ?? MISSING;
    if (equal(b, p)) continue;
    if (b === MISSING || p === MISSING) {
      if (equal(c, p)) continue;
      if (!equal(c, b)) { conflicts.push({ kind, id, path: "*", base: b === MISSING ? null : b, proposed: p === MISSING ? null : p, current: c === MISSING ? null : c }); continue; }
      if (p === MISSING) {
        const index = merged.findIndex(row => row.id === id); if (index >= 0) merged.splice(index, 1);
        mergedBy.delete(id);
      } else { const next = clone(p); merged.push(next); mergedBy.set(id, next); }
      continue;
    }
    const target = mergedBy.get(id);
    for (const path of leafPaths(b, p)) {
      const bv = get(b, path), pv = get(p, path);
      if (equal(bv, pv)) continue;
      const cv = get(c, path);
      if (equal(cv, pv)) continue;
      if (!equal(cv, bv)) {
        conflicts.push({ kind, id, path: path.join("."), base: bv === MISSING ? null : bv, proposed: pv === MISSING ? null : pv, current: cv === MISSING ? null : cv });
        continue;
      }
      set(target, path, pv);
    }
  }
  return { merged, conflicts };
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

export function diffRows(before, after, kind = "rows") {
  const b = new Map(before.map(row => [row.id, row])), a = new Map(after.map(row => [row.id, row]));
  const changed = [], added = [], removed = [];
  for (const [id, row] of b) {
    if (!a.has(id)) removed.push(id);
    else if (!equal(row, a.get(id))) changed.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) added.push(id);
  return { kind, changed, added, removed };
}

export function analyzeForgeProject(gamePathValue, bundle, { allowGameIdMismatch = false } = {}) {
  const gameDir = resolve(gamePathValue), { manifest, entries } = loadForgeProject(bundle);
  const currentGame = yaml.load(readFileSync(gamePath(gameDir, "game.yaml"), "utf8")) || {};
  if (!allowGameIdMismatch && manifest.game?.id && currentGame.id && manifest.game.id !== currentGame.id)
    throw new Error(`project belongs to '${manifest.game.id}', not '${currentGame.id}'`);
  const cardsChoice = chooseTable(entries, manifest.tables.cards, "cards");
  const printingsChoice = chooseTable(entries, manifest.tables.printings, "printings");
  const conflicts = [cardsChoice.conflict, printingsChoice.conflict].filter(Boolean);
  const currentCards = JSON.parse(readFileSync(gamePath(gameDir, "components/cards.json"), "utf8"));
  const currentPrintings = JSON.parse(readFileSync(gamePath(gameDir, "components/printings.json"), "utf8"));
  const cardMerge = cardsChoice.proposed ? mergeRows(cardsChoice.base, cardsChoice.proposed, currentCards, "cards") : { merged: currentCards, conflicts: [] };
  const printingMerge = printingsChoice.proposed ? mergeRows(printingsChoice.base, printingsChoice.proposed, currentPrintings, "printings") : { merged: currentPrintings, conflicts: [] };
  conflicts.push(...cardMerge.conflicts, ...printingMerge.conflicts);
  const files = [];
  if (!equal(currentCards, cardMerge.merged)) files.push({ path: "components/cards.json", content: jsonBytes(cardMerge.merged), kind: "cards" });
  if (!equal(currentPrintings, printingMerge.merged)) files.push({ path: "components/printings.json", content: jsonBytes(printingMerge.merged), kind: "printings" });

  const knownProjectPaths = new Set();
  for (const record of manifest.files || []) {
    const sourcePath = safeRel(record.source_path, "source_path"), projectPath = safeRel(record.project_path, "project_path");
    knownProjectPaths.add(projectPath);
    if (["components/cards.json", "components/printings.json"].includes(sourcePath)) continue;
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
      || sourcePath === "components/cards.json" || sourcePath === "components/printings.json") continue;
    const currentPath = gamePath(gameDir, sourcePath), current = existsSync(currentPath) ? readFileSync(currentPath) : null;
    if (!current) files.push({ path: sourcePath, content: incoming, kind: "added-file" });
    else if (sha256(current) !== sha256(incoming)) conflicts.push({ kind: "file", id: sourcePath, path: "*", base: null, proposed: sha256(incoming), current: sha256(current) });
  }
  return {
    format: manifest.format,
    game: manifest.game,
    source_hash: manifest.source?.hash,
    changes: {
      cards: diffRows(currentCards, cardMerge.merged, "cards"),
      card_fields: diffCards(currentCards, cardMerge.merged),
      printings: diffRows(currentPrintings, printingMerge.merged, "printings"),
      files: files.filter(file => !["cards", "printings"].includes(file.kind)).map(file => ({ path: file.path, kind: file.kind })),
    },
    conflicts,
    files,
  };
}

export function writeForgeProjectChanges(gamePathValue, result, { allowDelete = false } = {}) {
  if (result.conflicts.length) throw new Error(`cannot write a project with ${result.conflicts.length} conflict(s)`);
  const removesRows = result.changes.cards.removed.length || result.changes.printings.removed.length;
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
