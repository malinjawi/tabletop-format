#!/usr/bin/env node
/**
 * diff.mjs — semantic card diff CLI (Block C). ZERO dependencies.
 * Usage: node tools/diff.mjs <old-cards.json> <new-cards.json>
 * Engine lives in lib/carddiff.mjs (shared with the git driver and porcelain).
 */
import { readFileSync } from "node:fs";
import { diffCards, formatChanges } from "./lib/carddiff.mjs";

const [oldPath, newPath] = process.argv.slice(2);
if (!newPath) { console.error("Usage: node tools/diff.mjs <old-cards.json> <new-cards.json>"); process.exit(2); }

const changes = diffCards(
  JSON.parse(readFileSync(oldPath, "utf8")),
  JSON.parse(readFileSync(newPath, "utf8")),
);
console.log(formatChanges(changes));
if (changes.length) {
  const counts = changes.reduce((a, c) => (a[c.kind] = (a[c.kind] ?? 0) + 1, a), {});
  console.log(`\n${counts.changed ?? 0} change(s), ${counts.added ?? 0} added, ${counts.removed ?? 0} removed`);
}
