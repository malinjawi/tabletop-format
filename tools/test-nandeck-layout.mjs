#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { analyzeNandeckImport, buildNandeckProject, parseNandeckScript } from "./lib/nandeck-layout.mjs";

const root = resolve(import.meta.dirname, ".."), fixture = join(root, "examples", "_fixtures", "netrunner-sg");

const parsedCm = parseNandeckScript(`CARDSIZE=6,9\nFONT=Arial,10,T,#000000\nTEXT=,"[name]",10%,1,80%,2,left,wordwrap\n`);
assert.deepEqual(parsedCm.layout.card, { w_mm: 60, h_mm: 90, bleed_mm: 0 });
assert.equal(parsedCm.layout.regions[0].x, 6);
assert.equal(parsedCm.layout.regions[0].w, 48);
assert.equal(parsedCm.layout.regions[0].y, 10);
assert.equal(parsedCm.layout.regions[0].src, "card.name");

const built = buildNandeckProject(fixture);
assert.equal(built.manifest.unit, "MM");
assert.equal(built.manifest.families.length, 11);
assert.ok(built.entries.get("netrunner-sg-program.txt").toString().includes("UNIT=MM"));
assert.ok(built.entries.get("netrunner-sg-program.txt").toString().includes("FORGE_REGION"));
assert.deepEqual([...buildNandeckProject(fixture).entries], [...built.entries]);

const program = built.entries.get("netrunner-sg-program.txt").toString();
const noop = analyzeNandeckImport(fixture, program);
assert.equal(noop.ok, true);
assert.deepEqual(noop.changes, []);
assert.deepEqual(noop.files, []);

const edited = program.replace('TEXT=,"[name]",17.9,3.42,41,4.15', 'TEXT=,"[name]",18.4,3.42,41,4.15');
assert.notEqual(edited, program);
const proposed = analyzeNandeckImport(fixture, edited);
assert.equal(proposed.ok, true);
assert.deepEqual(proposed.changes.map(change => [change.id, change.path, change.before, change.after]), [["program_name", "x", 17.9, 18.4]]);
assert.deepEqual(proposed.files.map(file => file.path), ["templates/card-design/families/program.yaml"]);
assert.deepEqual(proposed.affected_families, ["program"]);

const event = built.entries.get("netrunner-sg-event.txt").toString();
const sharedEdited = event.replace('TEXT=,"[cost]",4.15,4,8.75,6.8', 'TEXT=,"[cost]",5.15,4,8.75,6.8');
const sharedProposed = analyzeNandeckImport(fixture, sharedEdited);
assert.deepEqual(sharedProposed.affected_families, ["event", "hardware", "operation", "program", "resource"]);

const scratch = mkdtempSync(join(tmpdir(), "forge-nandeck-test-"));
for (const rel of ["game.yaml", "components", "templates"]) {
  const source = join(fixture, rel), destination = join(scratch, rel);
  mkdirSync(join(destination, ".."), { recursive: true }); cpSync(source, destination, { recursive: true });
}
const programFamily = join(scratch, "templates", "card-design", "families", "program.yaml");
writeFileSync(programFamily, readFileSync(programFamily, "utf8").replace('x: 17.9\n    "y": 3.42', 'x: 18.1\n    "y": 3.42'));
const conflicted = analyzeNandeckImport(scratch, edited);
assert.equal(conflicted.ok, false);
assert.deepEqual(conflicted.conflicts.map(conflict => [conflict.id, conflict.path]), [["program_name", "x"]]);

const applyScratch = mkdtempSync(join(tmpdir(), "forge-nandeck-apply-"));
for (const rel of ["game.yaml", "components", "templates", "sets", "formats", "restrictions", "decks", "setups", "assets"]) {
  cpSync(join(fixture, rel), join(applyScratch, rel), { recursive: true,
    filter: source => !source.includes("/assets/source-faces/") && !source.endsWith("/assets/source-faces") });
}
mkdirSync(join(applyScratch, "assets", "source-faces"), { recursive: true });
cpSync(join(fixture, "assets", "source-faces", "p_offworld_office_sg.png"), join(applyScratch, "assets", "source-faces", "p_offworld_office_sg.png"));
for (const file of proposed.files) writeFileSync(join(applyScratch, file.path), file.content);
execFileSync(process.execPath, [join(root, "tools", "validate.mjs"), applyScratch], { stdio: "pipe" });

const hostile = parseNandeckScript('UNIT=INCH\nLINK="../../secret.csv"\nFOLDER="/tmp"\nCARDSIZE=2.5,3.5\n');
assert.deepEqual(hostile.links, ["../../secret.csv"]); // recorded, never opened
assert.equal(hostile.layout.card.w_mm, 63.5);
assert.deepEqual(hostile.unsupported.map(item => item.directive), ["FOLDER"]);

rmSync(scratch, { recursive: true });
rmSync(applyScratch, { recursive: true });

console.log("nanDECK adapter: units + 11 families + deterministic export + no-op/edit/conflict merge + validation + safe parsing passed");
