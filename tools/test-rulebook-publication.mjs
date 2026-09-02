#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  buildRulebookPublication, loadRulebookPublication, renderRulebookPublicationHtml,
} from "./lib/rulebook-publication.mjs";

const game = resolve(process.argv[2] || "examples/_fixtures/netrunner-sg");
const first = mkdtempSync(join(tmpdir(), "forge-publication-test-a-"));
const second = mkdtempSync(join(tmpdir(), "forge-publication-test-b-"));

try {
  const loaded = loadRulebookPublication(game);
  assert(loaded, "publication registry should load");
  assert.equal(loaded.active.id, "learn-to-play");
  assert.equal(loaded.document.pages.length, 8);
  assert(loaded.document.pages.some(page => page.blocks.some(block => block.type === "scene")));
  assert(loaded.document.pages.some(page => page.blocks.some(block => block.type === "card-grid")));
  assert(loaded.active.editors.some(editor => editor.type === "forge-layout"));
  assert(loaded.active.editors.some(editor => editor.type === "html-css"));

  const media = { faces: Object.fromEntries((loaded.document.dependencies.cards || []).map(id => [id, "data:image/png;base64,AA=="])), back: "data:image/png;base64,AA==", byCard: new Map() };
  const preview = renderRulebookPublicationHtml(loaded.document, media, {});
  assert(preview.includes("@page"));
  assert(preview.includes("pub-scene"));
  assert(preview.includes("Quick reference"));

  const buildA = await buildRulebookPublication(game, first, { buildPdf: false });
  const buildB = await buildRulebookPublication(game, second, { buildPdf: false });
  assert.equal(buildA.page_count, 8);
  assert.equal(buildA.outputs.length, 3);
  assert(buildA.outputs.some(output => output.id === "web"));
  assert(buildA.outputs.some(output => output.id === "source"));
  assert(existsSync(join(first, "publication-build.json")));
  assert.equal(
    readFileSync(join(first, "learn-to-play-source.zip")).toString("hex"),
    readFileSync(join(second, "learn-to-play-source.zip")).toString("hex"),
    "portable source package must be deterministic",
  );
  console.log("rulebook publication: registry, semantic links, page composition, web build, and deterministic source package OK");
} finally {
  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
}
