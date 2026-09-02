#!/usr/bin/env node
/** Regression proof for composable card families.
 * Verifies every real card resolves exactly once and that the visible regions
 * are byte-for-byte equivalent to the legacy monolithic layout. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

import yaml from "js-yaml";
import { cardMatchesFamily, loadCardDesign } from "./lib/card-design.mjs";

const gameDir = resolve(process.argv[2] || "examples/_fixtures/netrunner-sg");
const cards = JSON.parse(readFileSync(join(gameDir, "components/cards.json"), "utf8"));
const catalog = loadCardDesign(gameDir);
assert(catalog, "card design manifest is missing");
const legacyPath = join(gameDir, catalog.legacy_source || "templates/layout.yaml");
const legacy = yaml.load(readFileSync(legacyPath, "utf8"));

function dig(card, path) {
  return String(path || "").replace(/^card\./, "").split(".").filter(Boolean)
    .reduce((value, key) => value == null ? undefined : value[key], card);
}
function visible(card, source) {
  if (!source) return true;
  const text = String(source).trim();
  const ors = text.split(/\s*\|\|\s*/); if (ors.length > 1) return ors.some(part => visible(card, part));
  const ands = text.split(/\s*&&\s*/); if (ands.length > 1) return ands.every(part => visible(card, part));
  const comparison = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(text);
  if (comparison) {
    const actual = String(dig(card, comparison[1].trim()) ?? "");
    const wanted = comparison[3].trim().replace(/^['"]|['"]$/g, "");
    return (actual === wanted) === (comparison[2] === "==");
  }
  const negated = text.startsWith("!"), path = negated ? text.slice(1).trim() : text;
  const value = dig(card, path), truthy = !(value == null || value === "" || value === false || (Array.isArray(value) && !value.length));
  return negated ? !truthy : truthy;
}

const counts = new Map(catalog.families.map(family => [family.id, 0]));
for (const card of cards) {
  const matches = catalog.families.filter(family => cardMatchesFamily(card, family.match));
  assert.equal(matches.length, 1, `${card.id} must resolve to exactly one family`);
  const family = matches[0]; counts.set(family.id, counts.get(family.id) + 1);
  const expected = legacy.regions.filter(region => visible(card, region.show_if));
  const actual = family.layout.regions.filter(region => visible(card, region.show_if));
  assert.deepEqual(actual, expected, `${card.id}/${family.id} changed its visible production layout`);
}
for (const family of catalog.families)
  assert(counts.get(family.id) > 0, `${family.id} has no real card exercising it`);

console.log(`card-design: ${cards.length} cards resolved across ${catalog.families.length} families; visible output matches ${catalog.legacy_source}`);
