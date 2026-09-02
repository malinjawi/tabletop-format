#!/usr/bin/env node
/** Pin the semantic data version literally represented by a flattened PnP PDF.
 *
 * Usage:
 *   node tools/pin-nrdb-source-baseline.mjs GAME_DIR PACK_JSON --source-ref SHA
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

const args = process.argv.slice(2), gameDir = args[0] && resolve(args[0]), dataPath = args[1];
const refIndex = args.indexOf("--source-ref"), sourceRef = refIndex >= 0 ? args[refIndex + 1] : "";
if (!gameDir || !dataPath || !sourceRef) {
  console.error("Usage: node tools/pin-nrdb-source-baseline.mjs GAME_DIR PACK_JSON --source-ref SHA");
  process.exit(2);
}

const slug = value => String(value ?? "").toLowerCase().normalize("NFKD")
  .replace(/[^\x20-\x7e]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const rich = value => String(value ?? "")
  .replace(/<ul>\s*<li>/gi, "\n- ").replace(/<\/li>\s*<li>/gi, "\n- ").replace(/<\/li>\s*<\/ul>/gi, "")
  .replace(/<ol>\s*<li>/gi, "\n1. ").replace(/<\/li>\s*<li>/gi, "\n1. ").replace(/<\/li>\s*<\/ol>/gi, "")
  .replace(/<(?:strong|b)>/gi, "**").replace(/<\/(?:strong|b)>/gi, "**")
  .replace(/<(?:em|i)>/gi, "*").replace(/<\/(?:em|i)>/gi, "*")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/?cite>/gi, "")
  .replace(/<errata>.*?<\/errata>/gis, "").trim();
const plain = value => String(value ?? "").replace(/<[^>]+>/g, "").trim();
const attrFields = {
  side_code: ["side", "string"], faction_code: ["faction", "string"],
  cost: ["cost", "integer"], faction_cost: ["influence", "integer"],
  strength: ["strength", "integer"], advancement_cost: ["advancement_cost", "integer"],
  agenda_points: ["agenda_points", "integer"], trash_cost: ["trash_cost", "integer"],
  memory_cost: ["memory_cost", "integer"], base_link: ["base_link", "integer"],
  influence_limit: ["influence_limit", "integer"], minimum_deck_size: ["minimum_deck_size", "integer"],
  uniqueness: ["unique", "boolean"],
};

const currentCards = JSON.parse(readFileSync(join(gameDir, "components", "cards.json"), "utf8"));
const printings = JSON.parse(readFileSync(join(gameDir, "components", "printings.json"), "utf8"));
const source = JSON.parse(readFileSync(dataPath, "utf8"));
const byId = new Map(source.map(card => [slug(card.stripped_title || card.title), card]));
const byCollector = new Map(source.map(card => [
  String(card.position ?? String(card.code ?? "").slice(-3)).padStart(3, "0"), card,
]));
const cards = {}, pinnedPrintings = {};
for (const current of currentCards) {
  const printing = printings.find(item => item.card_id === current.id);
  const raw = byId.get(current.id) || byCollector.get(String(printing?.collector_number).padStart(3, "0"));
  if (!raw || !printing) throw new Error(`historical source card '${current.id}' is missing`);
  const card = structuredClone(current);
  card.name = raw.title;
  card.type = raw.type_code;
  if (raw.keywords) card.subtypes = raw.keywords.split(" - ").map(value => value.trim()).filter(Boolean);
  else delete card.subtypes;
  if (raw.text) card.text = rich(raw.text).replace(/\[([a-z0-9-]+)\]/g, (_, key) => `[${key.replace(/-/g, "_")}]`);
  else delete card.text;
  const attributes = { ...(card.attributes ?? {}) };
  for (const [sourceKey, [targetKey, type]] of Object.entries(attrFields)) {
    if (raw[sourceKey] == null) delete attributes[targetKey];
    else attributes[targetKey] = type === "integer" ? Number(raw[sourceKey]) : raw[sourceKey];
  }
  if (Object.keys(attributes).length) card.attributes = attributes;
  else delete card.attributes;
  if (raw.deck_limit != null) card.deck_limit = raw.deck_limit;
  else delete card.deck_limit;
  cards[current.id] = card;
  pinnedPrintings[printing.id] = {
    set_id: printing.set_id,
    collector_number: printing.collector_number ?? null,
    artist: raw.illustrator ? plain(raw.illustrator) : null,
    flavor_text: raw.flavor ? rich(raw.flavor) : null,
    variant: printing.variant ?? null,
  };
}
const overridesPath = join(gameDir, "templates", "source-baseline-overrides.yaml");
if (existsSync(overridesPath)) {
  const overrides = yaml.load(readFileSync(overridesPath, "utf8")) || {};
  for (const [cardId, patch] of Object.entries(overrides.cards || {})) {
    if (!cards[cardId]) throw new Error(`source baseline override references unknown card '${cardId}'`);
    cards[cardId] = { ...cards[cardId], ...patch };
  }
  for (const [printingId, patch] of Object.entries(overrides.printings || {})) {
    if (!pinnedPrintings[printingId]) throw new Error(`source baseline override references unknown printing '${printingId}'`);
    pinnedPrintings[printingId] = { ...pinnedPrintings[printingId], ...patch };
  }
}
const output = {
  schema_version: 1,
  source_ref: sourceRef,
  source_format: "Null-Signal-Games/netrunner-cards-json pack/sg.json",
  cards,
  printings: pinnedPrintings,
};
const outputPath = join(gameDir, "templates", "source-baseline-data.json");
writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(`Pinned ${Object.keys(cards).length} source card(s) at ${sourceRef} -> ${outputPath}`);
