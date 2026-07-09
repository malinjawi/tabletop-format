#!/usr/bin/env node
/**
 * diff.mjs — semantic card diff (the wow moment, v0.1)
 * Usage: node tools/diff.mjs <old-cards.json> <new-cards.json>
 *
 * Matches cards by STABLE ID (never position), then reports
 * field-level changes as typed change records — the data structure
 * the platform will later render as visual before/after cards.
 */
import { readFileSync } from "node:fs";

const [oldPath, newPath] = process.argv.slice(2);
if (!newPath) { console.error("Usage: node tools/diff.mjs <old-cards.json> <new-cards.json>"); process.exit(2); }

const oldCards = new Map(JSON.parse(readFileSync(oldPath, "utf8")).map(c => [c.id, c]));
const newCards = new Map(JSON.parse(readFileSync(newPath, "utf8")).map(c => [c.id, c]));

const changes = [];
const flatten = (c) => ({
  name: c.name, type: c.type,
  subtypes: (c.subtypes ?? []).join(", "),
  text: c.text ?? "", keywords: (c.keywords ?? []).join(", "),
  deck_limit: c.deck_limit,
  ...Object.fromEntries(Object.entries(c.attributes ?? {}).map(([k, v]) => [`attributes.${k}`, v])),
});

for (const [id, oc] of oldCards) {
  const nc = newCards.get(id);
  if (!nc) { changes.push({ kind: "removed", card: id, name: oc.name }); continue; }
  const of = flatten(oc), nf = flatten(nc);
  for (const k of new Set([...Object.keys(of), ...Object.keys(nf)])) {
    if (JSON.stringify(of[k]) !== JSON.stringify(nf[k]))
      changes.push({ kind: "changed", card: id, name: nc.name, field: k, from: of[k], to: nf[k] });
  }
}
for (const [id, nc] of newCards)
  if (!oldCards.has(id)) changes.push({ kind: "added", card: id, name: nc.name });

if (changes.length === 0) { console.log("No changes."); process.exit(0); }

let current = null;
for (const ch of changes) {
  if (ch.card !== current) { console.log(`\n${ch.name}  (${ch.card})`); current = ch.card; }
  if (ch.kind === "added") console.log("  + added");
  else if (ch.kind === "removed") console.log("  - removed");
  else console.log(`  ~ ${ch.field}: ${JSON.stringify(ch.from)} → ${JSON.stringify(ch.to)}`);
}
const counts = changes.reduce((a, c) => (a[c.kind] = (a[c.kind] ?? 0) + 1, a), {});
console.log(`\n${counts.changed ?? 0} change(s), ${counts.added ?? 0} added, ${counts.removed ?? 0} removed`);
