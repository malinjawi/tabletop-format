#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { buildNandeckProject } from "./lib/nandeck-layout.mjs";

const args = process.argv.slice(2), gameDir = args.find(arg => !arg.startsWith("--"));
if (!gameDir) {
  console.error("usage: export-nandeck.mjs <game-dir> [--output-dir DIR]");
  process.exit(2);
}
const after = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const root = resolve(gameDir), outDir = resolve(after("--output-dir") || join(root, "exports", "nandeck"));
const built = buildNandeckProject(root, { assetPrefix: "../../", preferLocalArt: true });
mkdirSync(outDir, { recursive: true });
for (const [rel, content] of built.entries) writeFileSync(join(outDir, rel), content);
console.log(JSON.stringify({
  ok: true,
  game: built.manifest.game,
  output: outDir,
  families: built.manifest.families.map(family => ({ id: family.family, script: family.script, cards: family.cards, warnings: family.warnings.length })),
}, null, 2));
