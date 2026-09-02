#!/usr/bin/env node
/** Audit the editor-to-production contract for every card in a source game.
 * Usage: node tools/source-overlay-field-audit.mjs GAME_DIR [OUTPUT_JSON]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

const [gameArg, outputArg] = process.argv.slice(2);
if (!gameArg) {
  console.error("Usage: node tools/source-overlay-field-audit.mjs GAME_DIR [OUTPUT_JSON]");
  process.exit(2);
}
const gameDir = resolve(gameArg);
const cards = JSON.parse(readFileSync(join(gameDir, "components", "cards.json"), "utf8"));
const overlay = yaml.load(readFileSync(join(gameDir, "templates", "source-overlay.yaml"), "utf8")) || {};
const get = (value, path) => String(path || "").split(".").filter(Boolean).reduce((item, key) => item == null ? undefined : item[key], value);
const matches = (card, match) => Object.entries(match || {}).every(([path, wanted]) => {
  const choices = Array.isArray(wanted) ? wanted : [wanted], actual = get(card, path);
  return choices.some(choice => JSON.stringify(choice ?? null) === JSON.stringify(actual ?? null));
});
const nonvisual = new Set(overlay.nonvisual_card_fields || []);
const frame = new Set(overlay.frame_defining_card_fields || []);
const totals = { source_backed: 0, nonvisual: 0, frame_defining: 0, unclassified: 0 };
const fields = new Map(), failures = [];

for (const card of cards) {
  const mapped = new Set((overlay.regions || [])
    .filter(region => (region.source || "card") === "card" && matches(card, region.match))
    .map(region => region.src));
  const paths = ["name", "type", "subtypes", "text", "deck_limit", "keywords",
    ...Object.keys(card.attributes || {}).map(key => `attributes.${key}`)];
  for (const path of paths) {
    const classification = frame.has(path) ? "frame_defining"
      : mapped.has(path) ? "source_backed"
      : nonvisual.has(path) ? "nonvisual"
      : "unclassified";
    totals[classification]++;
    const row = fields.get(path) || { path, source_backed: 0, nonvisual: 0, frame_defining: 0, unclassified: 0 };
    row[classification]++;
    fields.set(path, row);
    if (classification === "unclassified") failures.push(`${card.id}: ${path}`);
  }
}

for (const path of nonvisual) {
  if (frame.has(path)) failures.push(`configuration overlap: ${path} is both nonvisual and frame-defining`);
}
const report = {
  cards: cards.length,
  field_instances: Object.values(totals).reduce((sum, count) => sum + count, 0),
  totals,
  fields: [...fields.values()].sort((a, b) => a.path.localeCompare(b.path)),
  failures,
};
if (outputArg) {
  const output = resolve(outputArg);
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote source field audit -> ${output}`);
}
console.log(JSON.stringify({ cards: report.cards, field_instances: report.field_instances, ...totals }));
for (const row of report.fields) {
  console.log(`${row.path.padEnd(30)} source ${String(row.source_backed).padStart(2)} · metadata ${String(row.nonvisual).padStart(2)} · frame ${String(row.frame_defining).padStart(2)} · missing ${String(row.unclassified).padStart(2)}`);
}
if (failures.length) {
  console.error(`Unclassified editor field(s):\n${failures.map(item => `- ${item}`).join("\n")}`);
  process.exit(1);
}
