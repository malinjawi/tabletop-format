#!/usr/bin/env node
/** Generate one bounded, fully mapped edit for every source-backed card.
 * Usage: node tools/generate_source_stress_cases.mjs GAME_DIR OUTPUT_JSON
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

const [gameArg, outputArg] = process.argv.slice(2);
if (!gameArg || !outputArg) {
  console.error("Usage: node tools/generate_source_stress_cases.mjs GAME_DIR OUTPUT_JSON");
  process.exit(2);
}
const gameDir = resolve(gameArg);
const cards = JSON.parse(readFileSync(join(gameDir, "components", "cards.json"), "utf8"));
const printings = JSON.parse(readFileSync(join(gameDir, "components", "printings.json"), "utf8"));
const overlay = yaml.load(readFileSync(join(gameDir, "templates", "source-overlay.yaml"), "utf8"));
const game = yaml.load(readFileSync(join(gameDir, "game.yaml"), "utf8")) || {};
const attributeTypes = new Map((game.attribute_definitions || []).map(definition => [definition.key, definition.type]));

const get = (value, path) => String(path || "").split(".").filter(Boolean).reduce((item, key) => item == null ? undefined : item[key], value);
const set = (value, path, replacement) => {
  const keys = String(path).split(".").filter(Boolean); let owner = value;
  for (const key of keys.slice(0, -1)) owner = owner[key] ||= {};
  owner[keys.at(-1)] = replacement;
};
const matches = (card, match) => Object.entries(match || {}).every(([path, wanted]) => {
  const choices = Array.isArray(wanted) ? wanted : [wanted], actual = get(card, path);
  return choices.some(choice => JSON.stringify(choice ?? null) === JSON.stringify(actual ?? null));
});
const mutateText = value => {
  const text = String(value || "");
  if (!text) return "Test.";
  if (/\d/.test(text)) return text.replace(/\d/, digit => digit === "9" ? "8" : String(Number(digit) + 1));
  if (/[.!?]/.test(text)) return text.replace(/[.!?]/, mark => mark === "." ? "!" : ".");
  return text + ".";
};

const printingByCard = new Map(printings.map(printing => [printing.card_id, printing]));
const cases = cards.map(card => {
  const printing = printingByCard.get(card.id), regions = (overlay.regions || []).filter(region => matches(card, region.match));
  const cardPatch = {}, printingPatch = {}, seen = new Set();
  for (const region of regions) {
    const key = `${region.source || "card"}:${region.src}`;
    if (seen.has(key) || region.src === "type") continue;
    seen.add(key);
    const owner = (region.source || "card") === "printing" ? printing : card;
    const patch = (region.source || "card") === "printing" ? printingPatch : cardPatch;
    const current = get(owner, region.src);
    let next;
    if (current == null) {
      const attribute = region.src.startsWith("attributes.") ? region.src.slice("attributes.".length) : "";
      const type = attributeTypes.get(attribute);
      if (region.patches) next = Object.keys(region.patches)[0];
      else if (type === "integer" || type === "number") next = 1;
      else continue;
    } else if (region.patches) {
      const values = Object.keys(region.patches);
      if (typeof current === "number") {
        const numeric = values.map(Number).filter(Number.isFinite);
        next = numeric.includes(current + 1) ? String(current + 1)
          : numeric.includes(current - 1) ? String(current - 1)
          : values.find(value => String(current) !== value);
      } else next = values.find(value => String(current) !== value);
    }
    else if (region.src === "name") next = String(current || "Card") + " X";
    else if (region.src === "subtypes") next = [...(Array.isArray(current) ? current : []), "Test"];
    else if (typeof current === "number") next = current + 1;
    else next = mutateText(current);
    if (next !== undefined) set(patch, region.src, region.patches && typeof current === "number" ? Number(next) : next);
  }
  return { card_id: card.id, card: cardPatch, printing: printingPatch };
});
writeFileSync(resolve(outputArg), JSON.stringify(cases, null, 2) + "\n");
console.log(`Wrote ${cases.length} exhaustive source-overlay stress cases -> ${resolve(outputArg)}`);
