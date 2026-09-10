#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadCardDesign } from "./lib/card-design.mjs";
import { deterministicZip, readZip } from "./lib/deterministic-zip.mjs";
import { loadDesignEngines } from "./lib/design-engines.mjs";
import { exportPnpinkProof } from "./export-pnpink.mjs";
import { analyzePnpinkImport } from "./lib/pnpink.mjs";

const gameDir = resolve(process.argv[2] || "examples/_fixtures/netrunner-sg");
const scratch = mkdtempSync(join(tmpdir(), "forge-design-engines-"));

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

try {
  const native = loadCardDesign(gameDir);
  const registry = loadDesignEngines(gameDir);
  assert.equal(registry.active, "forge-native");
  assert.equal(registry.inferred, false);
  assert.equal(registry.engines.filter(engine => engine.status === "active").length, 1);
  const pnpinkEngine = registry.engines.find(engine => engine.type === "pnpink");
  assert.equal(pnpinkEngine?.status, "beta");
  assert.equal(pnpinkEngine?.families.length, native.families.length);
  assert.deepEqual(registry.card_design, native, "adapter seam changed the active Forge catalog");

  const legacyDir = join(scratch, "legacy");
  mkdirSync(join(legacyDir, "templates"), { recursive: true });
  cpSync(join(gameDir, "templates/card-design"), join(legacyDir, "templates/card-design"), { recursive: true });
  rmSync(join(legacyDir, "templates/card-design/engines.yaml"));
  const inferred = loadDesignEngines(legacyDir);
  assert.equal(inferred.inferred, true);
  assert.equal(inferred.active, "forge-native");
  assert.deepEqual(inferred.card_design, native, "legacy inference changed the Forge catalog");
  const unsafeRegistry = readFileSync(join(gameDir, "templates/card-design/engines.yaml"), "utf8")
    .replace("active: forge-native", "active: pnpink-working-copy");
  writeFileSync(join(legacyDir, "templates/card-design/engines.yaml"), unsafeRegistry);
  assert.throws(() => loadDesignEngines(legacyDir), /only forge-native can be active today/);

  const outA = join(scratch, "a"), outB = join(scratch, "b");
  const first = exportPnpinkProof(gameDir, outA);
  const second = exportPnpinkProof(gameDir, outB);
  assert.equal(first.source_hash, second.source_hash);
  assert.equal(hash(first.archive), hash(second.archive), "PnPInk suite ZIP is not deterministic");
  const suite = readZip(readFileSync(first.archive));
  const suiteManifest = JSON.parse(suite.get("manifest.json"));
  assert.equal(suiteManifest.upstream.tested_tag, "v0.57");
  assert.equal(suiteManifest.families.length, native.families.length);
  const programPath = suiteManifest.families.find(family => family.family === "program").project;
  const program = readZip(suite.get(programPath)), programManifest = JSON.parse(program.get("manifest.json"));
  assert.equal(programManifest.format, "pnp");

  const clean = analyzePnpinkImport(gameDir, suite.get(programPath));
  assert.deepEqual(clean.changes, [], "exported CSV should round-trip without content changes");
  const withoutAuxiliaryProvenance = new Map(program);
  withoutAuxiliaryProvenance.delete("forge-source.json");
  assert.deepEqual(analyzePnpinkImport(gameDir, deterministicZip(withoutAuxiliaryProvenance)).changes, [],
    "embedded CSV baseline should survive a PnPInk repack that drops auxiliary files");
  const csvName = programManifest.csv, changedCsv = Buffer.from(program.get(csvName).toString("utf8").replace("Buzzsaw", "Buzzsaw Mk II"));
  const changed = analyzePnpinkImport(gameDir, changedCsv);
  assert.deepEqual(changed.changes, [{
    card_id: "buzzsaw",
    family: "program",
    fields: [{ path: "name", before: "Buzzsaw", after: "Buzzsaw Mk II" }],
  }]);
  const clearedCsv = Buffer.from(program.get(csvName).toString("utf8").replace(",4,1,3,1,anarch", ",4,1,,1,anarch"));
  const cleared = analyzePnpinkImport(gameDir, clearedCsv);
  assert.deepEqual(cleared.changes, [{
    card_id: "buzzsaw",
    family: "program",
    fields: [{ path: "attributes.strength", before: 3, after: null, remove: true }],
  }]);

  const editedPackage = new Map(program);
  editedPackage.set(programManifest.svg, Buffer.from(program.get(programManifest.svg).toString("utf8").replace("Program name", "Program title")));
  const template = analyzePnpinkImport(gameDir, deterministicZip(editedPackage));
  assert.equal(template.template_change.path, "templates/card-design/experiments/pnpink/netrunner-proof.svg");
  assert(template.files.some(file => file.path.endsWith("netrunner-proof.svg")), "returned SVG template should be a versioned change");

  console.log("design-engines: active output preserved; full-family deterministic PnPInk suite, data diff, and SVG source return verified");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
