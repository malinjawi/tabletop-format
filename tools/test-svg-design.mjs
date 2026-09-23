#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { analyzeSvgDesignImport, buildSvgDesignProject, inspectSvgCandidate, parseSvgDesign } from "./lib/svg-design.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = resolve(process.argv[2] || join(root, "examples", "_fixtures", "netrunner-sg"));
const built = buildSvgDesignProject(fixture);
assert.equal(built.manifest.unit, "MM");
assert.equal(built.manifest.families.length, 11);
assert.deepEqual([...buildSvgDesignProject(fixture).entries], [...built.entries]);
assert(built.entries.has("netrunner-sg-program.svg"));
assert(built.entries.has("netrunner-sg-corp-identity.svg"));
assert.match(built.entries.get("README.md").toString(), /Inkscape, Affinity Designer, Illustrator/);

const program = built.entries.get("netrunner-sg-program.svg").toString();
const parsed = parseSvgDesign(program);
assert.equal(parsed.meta.family, "program");
assert(parsed.objects > 20);
const noop = analyzeSvgDesignImport(fixture, program);
assert.equal(noop.ok, true);
assert.deepEqual(noop.changes, []);
assert.deepEqual(noop.files, []);

const replaceRegionAttr = (svg, id, attr, value) => {
  const pattern = new RegExp(`(<(?:rect|circle)\\b[^>]*data-forge-region="${id}"[^>]*\\b${attr}=")[^"]*(")`);
  const next = svg.replace(pattern, `$1${value}$2`);
  assert.notEqual(next, svg, `${attr} must exist on ${id}`);
  return next;
};
const encoded = value => Buffer.from(JSON.stringify(value)).toString("base64url");
let styled = replaceRegionAttr(program, "program_name", "data-forge-group", "title-lockup");
styled = replaceRegionAttr(styled, "program_name", "data-forge-border", encoded({ color: "#112233", width_mm: 0.4, style: "solid" }));
styled = replaceRegionAttr(styled, "program_name", "data-forge-shadow", encoded({ x_mm: 0, y_mm: 0.75, blur_mm: 1.5, spread_mm: 0, color: "#000000", opacity: 0.3, inset: false }));
const styledProposal = analyzeSvgDesignImport(fixture, styled);
assert.equal(styledProposal.ok, true);
assert.deepEqual(styledProposal.changes.map(change => change.path), ["group", "border", "shadow_spec"]);
assert.match(styledProposal.files[0].content, /group: title-lockup/);
assert.match(styledProposal.files[0].content, /border:/);
assert.match(styledProposal.files[0].content, /shadow_spec:/);

let typed = program.replace(/(data-forge-text-styles=")[^"]*(")/, `$1${encoded({ card_title: { font: "title", size_pt: 11.5, color: "#123456", uppercase: true } })}$2`);
typed = replaceRegionAttr(typed, "program_name", "data-forge-text-style", "card_title");
const typedProposal = analyzeSvgDesignImport(fixture, typed);
assert.equal(typedProposal.ok, true);
assert.deepEqual(typedProposal.changes.map(change => [change.id, change.path]), [["$text_styles", "text_styles"], ["program_name", "text_style"]]);
assert.deepEqual(typedProposal.affected_families, built.manifest.families.map(family => family.family));
assert.match(typedProposal.files.find(file => file.path.endsWith("system.yaml")).content, /text_styles:\n  card_title:/);
assert.match(typedProposal.files.find(file => file.path.endsWith("program.yaml")).content, /text_style: card_title/);

const backSpec = { text: "NETRUNNER", bg: "#172335", color: "#F7F3E8", border_color: "#F7F3E8", border_mm: 0.8,
  regions: [
    { id: "back_field", type: "rect", x: 0, y: 0, w: 63, h: 87.21, fill: "#172335" },
    { id: "back_title", type: "text", src: "g.layout.back.text", x: 7, y: 35, w: 49, h: 17, font: "title", size_pt: 20, align: "center", valign: "middle", color: "#F7F3E8" },
  ] };
const backed = program.replace(/(data-forge-back=")[^"]*(")/, `$1${encoded(backSpec)}$2`);
const backProposal = analyzeSvgDesignImport(fixture, backed);
assert.equal(backProposal.ok, true);
assert.deepEqual(backProposal.changes.map(change => [change.id, change.path]), [["$back", "back"]]);
assert.deepEqual(backProposal.affected_families, built.manifest.families.map(family => family.family));
assert.match(backProposal.files.find(file => file.path.endsWith("system.yaml")).content, /back:\n  text: NETRUNNER/);

const colorBound = program.replace('data-forge-region="program_name"', `data-forge-region="program_name" data-forge-colors="${encoded({ color: "palette" })}"`);
assert.deepEqual(analyzeSvgDesignImport(fixture, colorBound).changes.map(change=>[change.id,change.path,change.after]), [["program_name","color","palette"]]);
assert.throws(()=>parseSvgDesign(program.replace('data-forge-region="program_name"', `data-forge-region="program_name" data-forge-colors="${encoded({ color: "url(https://example.invalid)" })}"`)),/invalid Forge color bindings/);

const recoloredPalette = { ...parsed.palette, map: { ...parsed.palette.map, anarch: "#112233" } };
const recolored = program.replace(/(data-forge-palette=")[^"]*(")/, `$1${encoded(recoloredPalette)}$2`);
const colorProposal = analyzeSvgDesignImport(fixture, recolored);
assert.equal(colorProposal.ok, true);
assert.deepEqual(colorProposal.changes.map(change => change.id), ["$palette"]);
assert.deepEqual(colorProposal.affected_families, built.manifest.families.map(family => family.family));
assert.deepEqual(colorProposal.changes[0].after.motifs, parsed.palette.motifs, "Color edits preserve authored motifs");
assert.deepEqual(analyzeSvgDesignImport(fixture, program).files, [], "Review leaves source untouched");
for (const invalid of [null, [], { by: "type", map: [] }, { by: "type", map: { spell: {} } }, { by: "type", map: {}, surprise: true }]) {
  assert.throws(() => parseSvgDesign(program.replace(/(data-forge-palette=")[^"]*(")/, `$1${encoded(invalid)}$2`)), /invalid Forge palette/);
}
const oldMeta = { ...parsed.meta }; delete oldMeta.palette;
const oldSvg = program.replace(/ data-forge-palette="[^"]*"/, "").replace(/(<metadata id="forge-design-metadata">)[^<]+/, `$1${encoded(oldMeta)}`);
assert.deepEqual(analyzeSvgDesignImport(fixture, oldSvg).files, [], "Older version-1 SVGs preserve palette rules");

const edited = program.replace('data-forge-region="program_name"', 'data-forge-region="program_name" transform="translate(0.5,0)"');
assert.notEqual(edited, program);
const proposed = analyzeSvgDesignImport(fixture, edited);
assert.equal(proposed.ok, true);
assert.deepEqual(proposed.changes.map(change => [change.id, change.path, change.before, change.after]), [["program_name", "x", 17.9, 18.4]]);
assert.deepEqual(proposed.files.map(file => file.path), ["templates/card-design/families/program.yaml"]);
assert.deepEqual(proposed.affected_families, ["program"]);
assert.match(proposed.warnings.join("\n"), /flattened an editor transform/);

const event = built.entries.get("netrunner-sg-event.svg").toString();
const sharedEdited = event.replace('data-forge-region="credit_dial_shadow"', 'data-forge-region="credit_dial_shadow" transform="translate(0.5,0)"');
const shared = analyzeSvgDesignImport(fixture, sharedEdited);
assert.deepEqual(shared.changes.map(change => [change.id, change.path]), [["credit_dial_shadow", "x"]]);
assert.deepEqual(shared.affected_families, ["event", "hardware", "operation", "program", "resource"]);

const scratch = mkdtempSync(join(tmpdir(), "forge-svg-conflict-"));
for (const rel of ["game.yaml", "components", "templates"]) cpSync(join(fixture, rel), join(scratch, rel), { recursive: true });
const programFamily = join(scratch, "templates", "card-design", "families", "program.yaml");
writeFileSync(programFamily, readFileSync(programFamily, "utf8").replace('x: 17.9\n    "y": 3.42', 'x: 18.1\n    "y": 3.42'));
const conflicted = analyzeSvgDesignImport(scratch, edited);
assert.equal(conflicted.ok, false);
assert.deepEqual(conflicted.conflicts.map(conflict => [conflict.id, conflict.path]), [["program_name", "x"]]);

assert.throws(() => parseSvgDesign(program.replace("<svg ", '<svg onload="alert(1)" ')), /unsafe/);
assert.throws(() => parseSvgDesign(program.replace("<svg ", '<svg><script>alert(1)<\/script><svg ')), /unsafe/);
assert.throws(() => parseSvgDesign(program.replace('data-forge-region="program_name"', 'data-forge-region="program_name" transform="rotate(20)"')), /unsupported transform/);
const arbitrary = inspectSvgCandidate('<svg xmlns="http://www.w3.org/2000/svg" width="63mm" height="88mm" viewBox="0 0 63 88"><rect x="0" y="0" width="63" height="88"/></svg>');
assert.equal(arbitrary.objects, 1);
assert.deepEqual(arbitrary.view_box, [0, 0, 63, 88]);

const systemPath = join(scratch, "templates/card-design/system.yaml");
const systemSource = readFileSync(systemPath, "utf8");
writeFileSync(systemPath, colorProposal.files.find(file => file.path.endsWith("system.yaml")).content);
assert.deepEqual(analyzeSvgDesignImport(scratch, recolored).files, [], "Applying identical color rules is idempotent");
assert.deepEqual(analyzeSvgDesignImport(scratch, oldSvg).files, [], "Old exports cannot reset newly saved colors");
const divergent = program.replace(/(data-forge-palette=")[^"]*(")/, `$1${encoded({ ...recoloredPalette, default: "#abcdef" })}$2`);
assert.deepEqual(analyzeSvgDesignImport(scratch, divergent).conflicts.map(conflict => conflict.id), ["$palette"]);
writeFileSync(systemPath, systemSource);

rmSync(scratch, { recursive: true });
console.log("SVG family adapter: 11 families + deterministic export + no-op/edit/group/effect/text-style/shared/conflict merge + bounded parsing passed");
