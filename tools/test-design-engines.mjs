#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadCardDesign } from "./lib/card-design.mjs";
import { loadDesignEngines } from "./lib/design-engines.mjs";
import { exportPnpinkProof } from "./export-pnpink.mjs";
import { analyzePnpinkCsv } from "./import-pnpink.mjs";

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
  assert.equal(registry.engines.find(engine => engine.type === "pnpink")?.status, "experimental");
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
    .replace("active: forge-native", "active: pnpink-proof");
  writeFileSync(join(legacyDir, "templates/card-design/engines.yaml"), unsafeRegistry);
  assert.throws(() => loadDesignEngines(legacyDir), /only forge-native can be active today/);

  const outA = join(scratch, "a"), outB = join(scratch, "b");
  const first = exportPnpinkProof(gameDir, outA);
  const second = exportPnpinkProof(gameDir, outB);
  assert.equal(first.source_hash, second.source_hash);
  const namesA = readdirSync(outA).sort(), namesB = readdirSync(outB).sort();
  assert.deepEqual(namesA, namesB);
  for (const name of namesA) assert.equal(hash(join(outA, name)), hash(join(outB, name)), `${name} is not deterministic`);
  assert.equal(readFileSync(join(outA, "netrunner-proof.pnp")).subarray(0, 2).toString(), "PK");

  const clean = analyzePnpinkCsv(gameDir, join(outA, "netrunner-proof.csv"));
  assert.deepEqual(clean.changes, [], "exported CSV should round-trip without content changes");
  const changedCsv = join(scratch, "changed.csv");
  writeFileSync(changedCsv, readFileSync(join(outA, "netrunner-proof.csv"), "utf8").replace("Buzzsaw", "Buzzsaw Mk II"));
  const changed = analyzePnpinkCsv(gameDir, changedCsv);
  assert.deepEqual(changed.changes, [{
    card_id: "buzzsaw",
    family: "program",
    fields: [{ path: "name", before: "Buzzsaw", after: "Buzzsaw Mk II" }],
  }]);
  const clearedCsv = join(scratch, "cleared.csv");
  writeFileSync(clearedCsv, "{{t=bbox_program}},program_forge_id,program_strength\n,buzzsaw,\n");
  const cleared = analyzePnpinkCsv(gameDir, clearedCsv);
  assert.deepEqual(cleared.changes, [{
    card_id: "buzzsaw",
    family: "program",
    fields: [{ path: "attributes.strength", before: 3, after: null, remove: true }],
  }]);

  console.log("design-engines: active output preserved; legacy fallback, deterministic PnPInk package, and CSV semantic diff verified");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
