#!/usr/bin/env node
/** Dry-run or write one returned PnPInk family working copy. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzePnpinkImport } from "./lib/pnpink.mjs";

export function analyzePnpinkCsv(gamePath, csvPath) {
  return analyzePnpinkImport(gamePath, readFileSync(resolve(csvPath)));
}

export function writePnpinkChanges(result, gamePath) {
  for (const file of result.files) {
    const path = resolve(gamePath, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2), write = args.includes("--write"), positional = args.filter(arg => arg !== "--write");
  if (positional.length < 2) {
    console.error("Usage: node tools/import-pnpink.mjs <game-dir> <family.pnp|family.csv> [--write]");
    process.exit(2);
  }
  const result = analyzePnpinkImport(positional[0], readFileSync(resolve(positional[1])));
  console.log(JSON.stringify({
    family: result.family, source_hash: result.source_hash, stale: result.stale,
    upstream: result.upstream, changes: result.changes, template_change: result.template_change,
    conflicts: result.conflicts, warnings: result.warnings,
  }, null, 2));
  if (write && result.conflicts.length) {
    console.error("Conflicts prevent writing; export a fresh working copy."); process.exit(1);
  }
  if (write && result.files.length) {
    writePnpinkChanges(result, positional[0]);
    console.log(`Updated ${result.files.map(file => file.path).join(", ")}; review and commit through Forge.`);
  } else if (!write && result.files.length) {
    console.log("Dry run only. Re-run with --write to update the working tree; no Git commit will be created.");
  }
}
