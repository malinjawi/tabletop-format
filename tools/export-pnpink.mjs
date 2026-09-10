#!/usr/bin/env node
/** Export a deterministic, version-pinned PnPInk/Inkscape working-copy suite. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deterministicZip } from "./lib/deterministic-zip.mjs";
import { buildPnpinkProject } from "./lib/pnpink.mjs";

export function exportPnpinkProof(gamePath, outputPath) {
  const outDir = resolve(outputPath), built = buildPnpinkProject(gamePath);
  mkdirSync(outDir, { recursive: true });
  for (const [rel, content] of built.entries) {
    const path = join(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const archivePath = join(outDir, `${built.manifest.game.id}-pnpink-v${built.manifest.version}.zip`);
  writeFileSync(archivePath, deterministicZip(built.entries));
  return {
    engine: "pnpink", families: built.manifest.families.map(family => family.family),
    source_hash: built.manifest.source_hash, upstream: built.manifest.upstream,
    output: outDir, archive: archivePath,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const gameDir = process.argv[2];
  if (!gameDir) {
    console.error("Usage: node tools/export-pnpink.mjs <game-dir> [output-dir]");
    process.exit(2);
  }
  const outDir = process.argv[3] || join(gameDir, "tmp", "pnpink");
  const result = exportPnpinkProof(gameDir, outDir);
  console.log(`PnPInk ${result.upstream.tested_tag}: ${result.families.join(", ")} -> ${result.archive}`);
  console.log(result.source_hash);
}
