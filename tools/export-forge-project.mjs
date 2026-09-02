#!/usr/bin/env node
import { resolve, basename, join } from "node:path";
import { exportForgeProject } from "./lib/forge-project.mjs";

const args = process.argv.slice(2);
const positional = args.filter(arg => !arg.startsWith("--"));
if (!positional[0]) {
  console.error("usage: export-forge-project.mjs <game-dir> [out-dir] [--with-art] [--source-ref REF]");
  process.exit(2);
}
const valueAfter = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const gameDir = resolve(positional[0]);
const outDir = resolve(positional[1] || join("tmp", "forge-project", basename(gameDir)));
const result = exportForgeProject(gameDir, outDir, {
  withArt: args.includes("--with-art"),
  sourceRef: valueAfter("--source-ref"),
});
console.log(JSON.stringify({
  ok: true,
  game: result.manifest.game,
  archive: result.archivePath,
  files: result.manifest.files.length,
  source_hash: result.manifest.source.hash,
}, null, 2));
