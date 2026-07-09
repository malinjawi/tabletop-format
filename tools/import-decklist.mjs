#!/usr/bin/env node
/**
 * import-decklist.mjs — plaintext decklist → deck.json. ZERO dependencies.
 * Usage: node tools/import-decklist.mjs <game-dir> <decklist.txt> [--name "Deck Name"] [--format <id>]
 *
 * Parses the de facto interchange standard: "qty name" one per line
 * ("3 Kindling", "3x Kindling", "Kindling x3" all accepted; blank lines
 * and # comments ignored). Names matched case-insensitively against
 * components/cards.json. Output: decks/<slug>.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const gameDir = args[0], listPath = args[1];
if (!listPath) { console.error("Usage: node tools/import-decklist.mjs <game-dir> <decklist.txt> [--name N] [--format F]"); process.exit(2); }
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const name = opt("--name", basename(listPath).replace(/\.[^.]+$/, ""));
const formatId = opt("--format", undefined);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const cards = JSON.parse(readFileSync(join(gameDir, "components/cards.json"), "utf8"));
const byName = new Map(cards.map(c => [c.name.toLowerCase(), c.id]));

const deckCards = {}; const problems = [];
for (const raw of readFileSync(listPath, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#") || line.startsWith("//")) continue;
  let m = line.match(/^(\d+)\s*x?\s+(.+)$/i) || line.match(/^(.+?)\s+x\s*(\d+)$/i);
  let qty, cardName;
  if (m && /^\d+$/.test(m[1])) { qty = parseInt(m[1], 10); cardName = m[2]; }
  else if (m) { qty = parseInt(m[2], 10); cardName = m[1]; }
  else { qty = 1; cardName = line; }
  const id = byName.get(cardName.trim().toLowerCase());
  if (!id) { problems.push(`no card named '${cardName.trim()}'`); continue; }
  deckCards[id] = (deckCards[id] ?? 0) + qty;
}

if (problems.length) { for (const p of problems) console.error(`  ERROR  ${p}`); process.exit(1); }

const deck = { id: slug(name), name, ...(formatId ? { format_id: formatId } : {}), cards: deckCards };
mkdirSync(join(gameDir, "decks"), { recursive: true });
const out = join(gameDir, "decks", `${deck.id}.json`);
writeFileSync(out, JSON.stringify(deck, null, 2) + "\n");
console.log(`Deck '${name}': ${Object.values(deckCards).reduce((a, b) => a + b, 0)} cards, ${Object.keys(deckCards).length} unique → ${out}`);
