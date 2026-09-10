#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import yaml from "js-yaml";

import { deterministicZip, readZip } from "./lib/deterministic-zip.mjs";
import { csvToTable, tableToCsv } from "./lib/interchange-table.mjs";
import { analyzeSquibImport, buildSquibProject, SQUIB_TESTED_VERSION } from "./lib/squib.mjs";

const root = resolve(import.meta.dirname, ".."), fixture = resolve(process.argv[2] || join(root, "examples", "_fixtures", "netrunner-sg"));
const sourceRef = "0123456", built = buildSquibProject(fixture, { sourceRef }), rebuilt = buildSquibProject(fixture, { sourceRef });
assert.deepEqual([...built.entries], [...rebuilt.entries], "Squib working copy must be deterministic");
assert.equal(built.manifest.tested_upstream, `Squib ${SQUIB_TESTED_VERSION}`);
assert.equal(built.manifest.source.ref, sourceRef);
assert.equal(built.manifest.security.forge_executes_ruby, false);
assert.equal(built.manifest.families.length, 11);
for (const path of ["Gemfile", "Gemfile.lock", "README.md", "manifest.json", "families/program/cards.csv", "families/program/base-cards.json",
  "families/program/render.csv", "families/program/layout.yml", "families/program/forge-source.json", "families/program/deck.rb"])
  assert(built.entries.has(path), `missing ${path}`);
assert.match(built.entries.get("Gemfile").toString(), new RegExp(`squib.*${SQUIB_TESTED_VERSION}`));
assert.match(built.entries.get("Gemfile.lock").toString(), /squib \(0\.19\.0\)/);
const programRuby = built.entries.get("families/program/deck.rb").toString();
assert.match(programRuby, /Squib::Deck/);
assert.doesNotMatch(programRuby, /standard_faction_glyph|footer_set_icon/, "Forge-only symbol-font icons must not become misleading text");
assert(built.manifest.families.find(family => family.id === "program").warnings.some(warning => /symbol-font icon/.test(warning)),
  "omitted Squib icon fidelity must be declared in the manifest");

const archive = deterministicZip(built.entries);
const noop = analyzeSquibImport(fixture, archive);
assert.equal(noop.ok, true);
assert.deepEqual(noop.changes.cards, { kind: "cards", changed: [], added: [], removed: [] });
assert.deepEqual(noop.changes.layout, []);
assert.deepEqual(noop.files, []);

const editedEntries = readZip(archive), meta = JSON.parse(editedEntries.get("families/program/forge-source.json"));
const baseCards = JSON.parse(editedEntries.get("families/program/base-cards.json"));
const cards = csvToTable(editedEntries.get("families/program/cards.csv").toString(), { columns: meta.cards.columns }, "cards", baseCards);
cards[0].name += " Squib";
editedEntries.set("families/program/cards.csv", Buffer.from(tableToCsv(cards, "cards").csv));
const layout = yaml.load(editedEntries.get("families/program/layout.yml").toString());
layout.program_name.x = "18.4mm";
editedEntries.set("families/program/layout.yml", Buffer.from(yaml.dump(layout, { noRefs: true, sortKeys: false })));
// This file is deliberately hostile. The analyzer must ignore it and create no
// side effects because returned Ruby is never an input to Forge.
const marker = join(tmpdir(), "forge-squib-must-not-exist");
rmSync(marker, { force: true });
editedEntries.set("families/program/deck.rb", Buffer.from(`File.write(${JSON.stringify(marker)}, 'unsafe')\n`));
const edited = analyzeSquibImport(fixture, deterministicZip(editedEntries));
assert.equal(existsSync(marker), false, "returned Ruby must never execute");
assert.equal(edited.ok, true, JSON.stringify(edited.conflicts));
assert.deepEqual(edited.changes.cards.changed, [cards[0].id]);
assert.deepEqual(edited.changes.layout.map(change => [change.id, change.path, change.before, change.after]), [["program_name", "x", 17.9, 18.4]]);
assert.deepEqual(edited.files.map(file => file.path).sort(), ["components/cards.json", "templates/card-design/families/program.yaml"]);
assert(edited.ignored.includes("deck.rb"));

const scratch = mkdtempSync(join(tmpdir(), "forge-squib-conflict-"));
for (const rel of ["game.yaml", "components", "templates"]) cpSync(join(fixture, rel), join(scratch, rel), { recursive: true });
const layoutPath = join(scratch, "templates", "card-design", "families", "program.yaml");
writeFileSync(layoutPath, readFileSync(layoutPath, "utf8").replace("x: 17.9", "x: 18.1"));
const conflict = analyzeSquibImport(scratch, deterministicZip(editedEntries), { baselineGameDir: fixture });
assert.equal(conflict.ok, false);
assert(conflict.conflicts.some(item => item.kind === "layout" && item.id === "program_name" && item.path === "x"));

const missing = readZip(archive);
const missingLayout = yaml.load(missing.get("families/program/layout.yml").toString());
delete missingLayout.program_name;
missing.set("families/program/layout.yml", Buffer.from(yaml.dump(missingLayout)));
const preserved = analyzeSquibImport(fixture, deterministicZip(missing));
assert.equal(preserved.files.length, 0);
assert(preserved.warnings.some(warning => /missing layout entry was preserved/.test(warning)));

const forgedBaseline = readZip(archive);
const forgedCards = JSON.parse(forgedBaseline.get("families/program/base-cards.json"));
forgedCards[0].name = "Forged baseline";
forgedBaseline.set("families/program/base-cards.json", Buffer.from(JSON.stringify(forgedCards)));
assert.throws(() => analyzeSquibImport(fixture, deterministicZip(forgedBaseline)), /trusted baseline from Git/);

const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
assert.throws(() => analyzeSquibImport(fixture, oversized), /larger than 32 MB/);

console.log("squib: deterministic runnable kit + bounded CSV/YAML no-op/edit/conflict/preservation/security checks pass");
