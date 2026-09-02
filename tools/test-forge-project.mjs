#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  analyzeForgeProject, buildForgeProject, exportForgeProject, loadForgeProject, mergeRows, writeForgeProjectChanges,
} from "./lib/forge-project.mjs";
import { tableToCsv } from "./lib/interchange-table.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname), examples = join(ROOT, "examples");
const temp = mkdtempSync(join(tmpdir(), "forge-project-test-"));
const hash = value => createHash("sha256").update(value).digest("hex");

function gameDirs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    try { readFileSync(join(child, "game.yaml")); out.push(child); } catch { out.push(...gameDirs(child)); }
  }
  return out.sort();
}

try {
  const games = gameDirs(examples);
  assert(games.length >= 10, "expected the full bundled game matrix");
  for (const gameDir of games) {
    const first = buildForgeProject(gameDir), second = buildForgeProject(gameDir);
    assert.equal(hash(first.archive), hash(second.archive), `${gameDir}: archive must be byte deterministic`);
    const analysis = analyzeForgeProject(gameDir, first.archive);
    assert.equal(analysis.conflicts.length, 0, `${gameDir}: clean export conflicts`);
    assert.equal(analysis.files.length, 0, `${gameDir}: clean export changes source`);
  }

  const ember = join(examples, "ember"), built = buildForgeProject(ember);
  const portablePaths = new Set(built.manifest.files.map(file => file.source_path));
  for (const expected of [
    "components/tokens.json", "decks/burn-rush.json", "design/notes.md",
    "formats/standard.yaml", "restrictions/standard-2026-07.yaml",
    "rulings/rulings.json", "sets/sets.yaml",
  ]) assert(portablePaths.has(expected), `portable project should retain ${expected}`);
  assert(!portablePaths.has("forge/rights.json"), "design round trip must not make rights metadata editable");
  assert(!portablePaths.has("community.yaml"), "design round trip must not make governance metadata editable");

  const tokenEntries = new Map(loadForgeProject(built.archive).entries);
  const tokenRecord = built.manifest.files.find(file => file.source_path === "components/tokens.json");
  const tokens = JSON.parse(tokenEntries.get(tokenRecord.project_path));
  tokens[0].description = "Portable component edit";
  tokenEntries.set(tokenRecord.project_path, Buffer.from(`${JSON.stringify(tokens, null, 2)}\n`));
  const tokenChange = analyzeForgeProject(ember, tokenEntries);
  assert(tokenChange.changes.files.some(file => file.path === "components/tokens.json" && file.kind === "changed-file"));

  const secretHitler = buildForgeProject(join(examples, "secret-hitler"));
  assert(secretHitler.manifest.files.some(file => file.source_path === "setups/standard-table.yaml"),
    "portable project should retain playable table setups");
  const changedEntries = new Map(loadForgeProject(built.archive).entries);
  const csvPath = built.manifest.tables.cards.editable_path;
  changedEntries.set(csvPath, Buffer.from(changedEntries.get(csvPath).toString().replace(",Kindling,", ",Kindling Revised,")));
  const changed = analyzeForgeProject(ember, changedEntries);
  assert.deepEqual(changed.changes.cards.changed, ["kindling"]);
  assert(changed.changes.card_fields.some(item => item.card === "kindling" && item.field === "name"));

  const concurrent = join(temp, "ember-concurrent");
  cpSync(ember, concurrent, { recursive: true });
  const currentCards = JSON.parse(readFileSync(join(concurrent, "components/cards.json"), "utf8"));
  currentCards.find(card => card.id === "kindling").attributes.cost = 7;
  writeFileSync(join(concurrent, "components/cards.json"), `${JSON.stringify(currentCards, null, 2)}\n`);
  const merged = analyzeForgeProject(concurrent, changedEntries);
  assert.equal(merged.conflicts.length, 0, "different fields on one card should merge");
  const mergedCards = JSON.parse(merged.files.find(file => file.path === "components/cards.json").content);
  assert.equal(mergedCards.find(card => card.id === "kindling").name, "Kindling Revised");
  assert.equal(mergedCards.find(card => card.id === "kindling").attributes.cost, 7);

  currentCards.find(card => card.id === "kindling").name = "Current Kindling";
  writeFileSync(join(concurrent, "components/cards.json"), `${JSON.stringify(currentCards, null, 2)}\n`);
  const conflict = analyzeForgeProject(concurrent, changedEntries);
  assert(conflict.conflicts.some(item => item.kind === "cards" && item.id === "kindling" && item.path === "name"));

  const removedEntries = new Map(loadForgeProject(built.archive).entries);
  const baseCards = JSON.parse(removedEntries.get(built.manifest.tables.cards.base_path));
  removedEntries.set(csvPath, Buffer.from(tableToCsv(baseCards.slice(1), "cards").csv));
  const removed = analyzeForgeProject(ember, removedEntries);
  assert.deepEqual(removed.changes.cards.removed, [baseCards[0].id]);
  assert.throws(() => writeForgeProjectChanges(ember, removed), /explicit deletion permission/);

  const objectRemoval = mergeRows(
    [{ id: "printing", scan: "face.png", scan_provenance: { source: "human", creator: "Artist" } }],
    [{ id: "printing" }],
    [{ id: "printing", scan: "face.png", scan_provenance: { source: "human", creator: "Artist" } }],
    "printings",
  );
  assert.equal(objectRemoval.conflicts.length, 0, "removing an unchanged object should not conflict");
  assert.deepEqual(objectRemoval.merged, [{ id: "printing" }], "whole-object removal must not leave an empty object");

  const netrunner = join(examples, "_fixtures", "netrunner-sg"), design = buildForgeProject(netrunner);
  const designEntries = new Map(loadForgeProject(design.archive).entries);
  const designFile = design.manifest.files.find(file => file.source_path.startsWith("templates/") && file.source_path.endsWith(".yaml"));
  assert(designFile, "Netrunner project should contain editable design source");
  designEntries.set(designFile.project_path, Buffer.concat([designEntries.get(designFile.project_path), Buffer.from("\n# round-trip test\n")]));
  const designChange = analyzeForgeProject(netrunner, designEntries);
  assert(designChange.changes.files.some(file => file.path === designFile.source_path && file.kind === "changed-file"));
  const rulebookFile = design.manifest.files.find(file => file.source_path.endsWith("12_forge_community_appendix.yaml"));
  assert(rulebookFile, "Netrunner project should contain native rulebook source");
  designEntries.set(rulebookFile.project_path, Buffer.concat([designEntries.get(rulebookFile.project_path), Buffer.from("\n# native rulebook round-trip test\n")]));
  const rulebookChange = analyzeForgeProject(netrunner, designEntries);
  assert(rulebookChange.changes.files.some(file => file.path === rulebookFile.source_path && file.kind === "changed-file"));

  const output = exportForgeProject(ember, join(temp, "extracted"));
  assert.equal(analyzeForgeProject(ember, output.outDir).files.length, 0, "extracted directory imports too");
  console.log(`forge-project: ${games.length} game shapes, deterministic ZIP, CSV/JSON round trip, field merge/conflict, deletion guard, design-file import, and native rulebook round trip verified`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
