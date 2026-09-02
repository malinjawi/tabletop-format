#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildRulebookPipeline, loadRulebookPipeline, rulebookPipelineMetadata } from "./lib/rulebook-pipeline.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const game = join(root, "examples", "_fixtures", "netrunner-sg");
const out = mkdtempSync(join(tmpdir(), "forge-rulebook-test-"));
try {
  const loaded = loadRulebookPipeline(game), metadata = rulebookPipelineMetadata(loaded);
  assert.equal(metadata.pipeline.type, "nsg-rules-yaml");
  assert.match(metadata.pipeline.source.ref, /^[a-f0-9]{40}$/);
  assert(metadata.overlay_files.some(file => file.endsWith("12_forge_community_appendix.yaml")));
  const { build } = buildRulebookPipeline(game, out, { allowNetwork: false, buildPdf: false });
  assert.equal(build.source.ref, metadata.pipeline.source.ref);
  assert.deepEqual(build.extra_chapters, ["12_forge_community_appendix"]);
  assert(build.outputs.some(output => output.id === "web"));
  assert(build.outputs.some(output => output.id === "structured"));
  assert(build.outputs.some(output => output.id === "native-source"));
  assert.match(readFileSync(join(out, "rules.html"), "utf8"), /Forge Community Edition/);
  assert.match(readFileSync(join(out, "rules.json"), "utf8"), /rule_forge_exact_version/);
  const receipt = JSON.parse(readFileSync(join(out, "rulebook-build.json"), "utf8"));
  assert.equal(receipt.deterministic_input, build.deterministic_input);
  console.log("rulebook-pipeline: pinned source, native overlay chapter, web/JSON/LaTeX/source outputs, and build receipt verified");
} finally {
  rmSync(out, { recursive: true, force: true });
}
