#!/usr/bin/env node
import { resolve } from "node:path";
import { buildRulebookPipeline } from "./lib/rulebook-pipeline.mjs";

const [gameArg, outArg, ...flags] = process.argv.slice(2);
if (!gameArg || !outArg) {
  console.error("Usage: node tools/build-rulebook-pipeline.mjs <game-dir> <out-dir> [--allow-network] [--no-pdf]");
  process.exit(2);
}

try {
  const result = buildRulebookPipeline(resolve(gameArg), resolve(outArg), {
    allowNetwork: flags.includes("--allow-network"),
    buildPdf: !flags.includes("--no-pdf"),
  });
  console.log(JSON.stringify(result.build, null, 2));
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
