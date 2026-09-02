#!/usr/bin/env node
import { resolve } from "node:path";
import { buildRulebookPublication } from "./lib/rulebook-publication.mjs";

const [gamePath, outPath] = process.argv.slice(2);
if (!gamePath || !outPath) {
  console.error("Usage: node tools/build-rulebook-publication.mjs <game-dir> <output-dir>");
  process.exit(2);
}

try {
  const build = await buildRulebookPublication(resolve(gamePath), resolve(outPath));
  console.log(JSON.stringify(build, null, 2));
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
