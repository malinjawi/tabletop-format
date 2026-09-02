#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { analyzeNandeckImport, parseNandeckScript } from "./lib/nandeck-layout.mjs";

const args = process.argv.slice(2), positional = args.filter(arg => !arg.startsWith("--"));
if (positional.length < 2) {
  console.error("usage: import-nandeck-layout.mjs <game-dir> <script.txt> [--write] [--report FILE]");
  console.error("       Forge-generated scripts use three-way merge metadata; dry-run is the default.");
  process.exit(2);
}
const after = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const gameDir = resolve(positional[0]), scriptPath = resolve(positional[1]), input = readFileSync(scriptPath);
let result;
try {
  result = analyzeNandeckImport(gameDir, input);
} catch (error) {
  // A third-party script is still useful as a candidate layout, but it cannot
  // overwrite a production source without Forge's traceable baseline.
  const parsed = parseNandeckScript(input);
  result = { ok: false, candidate_only: true, error: error.message, layout: parsed.layout, warnings: parsed.warnings, unsupported: parsed.unsupported };
}
const reportPath = after("--report");
if (reportPath) {
  const path = resolve(reportPath); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
}
if (args.includes("--write")) {
  if (result.candidate_only) throw new Error("third-party nanDECK scripts are candidate-only; review and map them before replacing a production design");
  if (result.conflicts.length) throw new Error(`cannot write ${result.conflicts.length} conflicted change(s)`);
  for (const file of result.files) writeFileSync(resolve(gameDir, file.path), file.content);
  result.written = result.files.map(file => file.path);
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.conflicts?.length ? 1 : 0);
