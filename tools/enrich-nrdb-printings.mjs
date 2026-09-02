#!/usr/bin/env node
/**
 * Add appearance-specific NRDB-family metadata to an existing Forge game.
 *
 * Usage: node tools/enrich-nrdb-printings.mjs GAME_DIR PACK_JSON [--cards] [--check]
 *
 * Cards remain the versioned rules objects. Illustrator and flavor are stored
 * on printings because a reprint may legitimately have different art/text.
 * The command does not fetch the network; callers choose and audit the data
 * file (or pass a /dev/fd process-substitution path).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const gameDir = args[0] && resolve(args[0]);
const dataPath = args[1];
const check = args.includes("--check");
const updateCards = args.includes("--cards");
if (!gameDir || !dataPath) {
  console.error("Usage: node tools/enrich-nrdb-printings.mjs GAME_DIR PACK_JSON [--cards] [--check]");
  process.exit(2);
}

const slug = value => String(value ?? "").toLowerCase().normalize("NFKD")
  .replace(/[^\x20-\x7e]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const plain = value => String(value ?? "").replace(/<\/?(?:strong|em|b|i|cite)>/gi, "")
  .replace(/<errata>.*?<\/errata>/gis, "").trim();
const rich = value => String(value ?? "")
  .replace(/<ul>\s*<li>/gi, "\n- ").replace(/<\/li>\s*<li>/gi, "\n- ").replace(/<\/li>\s*<\/ul>/gi, "")
  .replace(/<ol>\s*<li>/gi, "\n1. ").replace(/<\/li>\s*<li>/gi, "\n1. ").replace(/<\/li>\s*<\/ol>/gi, "")
  .replace(/<(?:strong|b)>/gi, "**").replace(/<\/(?:strong|b)>/gi, "**")
  .replace(/<(?:em|i)>/gi, "*").replace(/<\/(?:em|i)>/gi, "*")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/?cite>/gi, "")
  .replace(/<errata>.*?<\/errata>/gis, "").trim();

const printingsPath = join(gameDir, "components", "printings.json");
const cardsPath = join(gameDir, "components", "cards.json");
const printings = JSON.parse(readFileSync(printingsPath, "utf8"));
const cards = JSON.parse(readFileSync(cardsPath, "utf8"));
const source = JSON.parse(readFileSync(dataPath, "utf8"));
const byCard = new Map(source.map(card => [slug(card.stripped_title || card.title), card]));
const byCollector = new Map(source.map(card => [
  String(card.position ?? String(card.code ?? "").slice(-3)).padStart(3, "0"), card,
]));
let matched = 0, changed = 0;
for (const printing of printings) {
  const card = byCard.get(printing.card_id) || byCollector.get(String(printing.collector_number).padStart(3, "0"));
  if (!card) continue;
  matched++;
  const wanted = {};
  if (card.illustrator) wanted.artist = plain(card.illustrator);
  if (card.flavor) wanted.flavor_text = plain(card.flavor);
  for (const [key, value] of Object.entries(wanted)) {
    if (printing[key] !== value) { printing[key] = value; changed++; }
  }
}
if (matched !== printings.length) {
  console.error(`Matched ${matched}/${printings.length} printings; refusing a partial metadata import.`);
  process.exit(1);
}
if (updateCards) {
  for (const card of cards) {
    const sourceCard = byCard.get(card.id) || source.find(item =>
      String(item.position ?? String(item.code ?? "").slice(-3)).padStart(3, "0") ===
      String(printings.find(printing => printing.card_id === card.id)?.collector_number).padStart(3, "0")
    );
    if (sourceCard?.text != null) {
      const wanted = rich(sourceCard.text);
      if (card.text !== wanted) { card.text = wanted; changed++; }
    }
  }
}
if (check) {
  if (changed) { console.error(`${changed} printing metadata value(s) are stale.`); process.exit(1); }
  console.log(`NRDB printing metadata is current (${matched} printings).`);
} else {
  writeFileSync(printingsPath, JSON.stringify(printings, null, 2) + "\n");
  if (updateCards) writeFileSync(cardsPath, JSON.stringify(cards, null, 2) + "\n");
  console.log(`Enriched ${matched} printings (${changed} metadata value(s) changed).`);
}
