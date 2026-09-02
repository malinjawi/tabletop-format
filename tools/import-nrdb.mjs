#!/usr/bin/env node
/**
 * import-nrdb.mjs — NRDB/Alsciende-family JSON → format (v0.1). ZERO dependencies.
 * Usage: node tools/import-nrdb.mjs <nrdb-dir> <output-dir> [--title "Game Title"]
 *
 * Reads the netrunner-cards-json v1 layout (the schema copied by ArkhamDB,
 * MarvelsDB, ThronesDB, ...): cycles.json + packs.json + pack/*.json.
 *
 * Two-tier mapping — the payoff of our card/printing split:
 *   NRDB card entries are PRINTINGS (one per pack appearance).
 *   We dedupe by stripped_title: same title in N packs = 1 card + N printings.
 * Field mapping: keywords " - " string → subtypes[]; <strong>/<em> HTML stripped;
 * [credit]-style symbol tags kept verbatim (they ARE our symbol convention);
 * side/faction/influence/strength/etc → typed attributes.
 *
 * NOTE: imported card TEXT/NAMES belong to their publisher/community —
 * imports are for the owning community's use; license field is set to
 * 'imported-see-source' to force a deliberate choice before publishing.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const srcDir = args[0], outDir = args[1];
if (!outDir) { console.error("Usage: node tools/import-nrdb.mjs <nrdb-dir> <output-dir> [--title T]"); process.exit(2); }
const tIdx = args.indexOf("--title");
const title = tIdx > -1 ? args[tIdx + 1] : basename(srcDir);

const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const kebab = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const stripHtml = (s) => s
  .replace(/<ul>\s*<li>/gi, "\n- ").replace(/<\/li>\s*<li>/gi, "\n- ").replace(/<\/li>\s*<\/ul>/gi, "")
  .replace(/<ol>\s*<li>/gi, "\n1. ").replace(/<\/li>\s*<li>/gi, "\n1. ").replace(/<\/li>\s*<\/ol>/gi, "")
  .replace(/<(?:strong|b)>/gi, "**").replace(/<\/(?:strong|b)>/gi, "**")
  .replace(/<(?:em|i)>/gi, "*").replace(/<\/(?:em|i)>/gi, "*")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/?cite>/gi, "")
  .replace(/<errata>.*?<\/errata>/gis, "").trim();

const cycles = JSON.parse(readFileSync(join(srcDir, "cycles.json"), "utf8"));
const packs = JSON.parse(readFileSync(join(srcDir, "packs.json"), "utf8"));
const packDir = join(srcDir, "pack");
const rawCards = readdirSync(packDir).filter(f => f.endsWith(".json"))
  .flatMap(f => JSON.parse(readFileSync(join(packDir, f), "utf8")));

// NRDB attribute fields → our typed attributes
const ATTR_FIELDS = {
  side_code: ["side", "string"], faction_code: ["faction", "string"],
  cost: ["cost", "integer"], faction_cost: ["influence", "integer"],
  strength: ["strength", "integer"], advancement_cost: ["advancement_cost", "integer"],
  agenda_points: ["agenda_points", "integer"], trash_cost: ["trash_cost", "integer"],
  memory_cost: ["memory", "integer"], base_link: ["base_link", "integer"],
  influence_limit: ["influence_limit", "integer"], minimum_deck_size: ["minimum_deck_size", "integer"],
  uniqueness: ["unique", "boolean"],
};

const cards = new Map();     // by stripped_title slug (rules identity)
const printings = [];
const usedAttrs = new Set(), usedSymbols = new Set();

for (const rc of rawCards) {
  const cardId = slug(rc.stripped_title || rc.title);
  if (!cards.has(cardId)) {
    const card = { id: cardId, name: rc.title, type: rc.type_code };
    if (rc.keywords) card.subtypes = rc.keywords.split(" - ").map(s => s.trim()).filter(Boolean);
    if (rc.text) card.text = stripHtml(rc.text);
    const attrs = {};
    for (const [src, [key, type]] of Object.entries(ATTR_FIELDS)) {
      if (rc[src] !== undefined && rc[src] !== null) {
        attrs[key] = type === "integer" ? Number(rc[src]) : rc[src];
        usedAttrs.add(`${key}:${type}`);
      }
    }
    if (Object.keys(attrs).length) card.attributes = attrs;
    if (rc.deck_limit != null) card.deck_limit = rc.deck_limit;
    cards.set(cardId, card);
    for (const m of (card.text ?? "").matchAll(/\[([a-z0-9_-]+)\]/g)) usedSymbols.add(m[1].replace(/-/g, "_"));
  }
  const p = {
    id: `p_${cardId}_${slug(rc.pack_code)}`,
    card_id: cardId, set_id: slug(rc.pack_code),
    collector_number: String(rc.position).padStart(3, "0"),
    quantity: rc.quantity ?? 1, template_id: "standard_face",
  };
  if (rc.illustrator) p.artist = rc.illustrator;
  if (rc.flavor) p.flavor_text = stripHtml(rc.flavor);
  printings.push(p);
}
// normalize symbol tags with hyphens (e.g. [recurring-credit]) → underscores in text
for (const c of cards.values())
  if (c.text) c.text = c.text.replace(/\[([a-z0-9-]+)\]/g, (_, k) => `[${k.replace(/-/g, "_")}]`);

// ---- scaffold ----
for (const d of ["components", "sets", "formats", "restrictions", "rulings", "rules", "assets", "templates"])
  mkdirSync(join(outDir, d), { recursive: true });

const usedPackCodes = new Set(printings.map(p => p.set_id));
const setsYaml = packs.filter(pk => usedPackCodes.has(slug(pk.code))).map(pk => {
  const lines = [`- id: ${slug(pk.code)}`, `  name: ${JSON.stringify(pk.name)}`];
  if (pk.cycle_code) lines.push(`  cycle_id: ${slug(pk.cycle_code)}`);
  if (pk.position) lines.push(`  position: ${pk.position}`);
  if (pk.date_release) lines.push(`  release_date: "${pk.date_release}"`);
  if (pk.size) lines.push(`  size: ${pk.size}`);
  return lines.join("\n");
}).join("\n") + "\n";
writeFileSync(join(outDir, "sets/sets.yaml"), setsYaml);

const attrDefs = [...usedAttrs].map(a => { const [k, t] = a.split(":"); return `  - key: ${k}\n    type: ${t}`; }).join("\n");
const symbols = [...usedSymbols].map(s => `  - key: ${s}\n    name: ${JSON.stringify(s)}`).join("\n");
writeFileSync(join(outDir, "game.yaml"), [
  `format_version: "0.1.0"`,
  `id: ${kebab(title)}`,
  `title: ${JSON.stringify(title)}`,
  `version: "0.1.0"`,
  `license: imported-see-source  # imported content: choose/confirm license before publishing`,
  `default_provenance:`, `  source: human`,
  ...(attrDefs ? ["attribute_definitions:", attrDefs] : []),
  ...(symbols ? ["symbols:", symbols] : []),
].join("\n") + "\n");

writeFileSync(join(outDir, "components/cards.json"), JSON.stringify([...cards.values()], null, 2) + "\n");
writeFileSync(join(outDir, "components/printings.json"), JSON.stringify(printings, null, 2) + "\n");
writeFileSync(join(outDir, "formats/all.yaml"),
  `id: all\nname: All Imported Sets\ncard_pool:\n${[...usedPackCodes].map(s => `  - ${s}`).join("\n")}\n`);
writeFileSync(join(outDir, "rulings/rulings.json"), "[]\n");
writeFileSync(join(outDir, "rules/rules.md"), `# ${title}\n\n_Imported from NRDB-family data. Rules text lives with the source community._\n`);

console.log(`Imported ${cards.size} cards, ${printings.length} printings, ${usedPackCodes.size} set(s) → ${outDir}`);
console.log(`Attributes: ${[...usedAttrs].join(", ") || "none"}`);
console.log(`Symbols: ${[...usedSymbols].join(", ") || "none"}`);
const reprints = printings.length - cards.size;
if (reprints > 0) console.log(`Two-tier dedupe: ${reprints} reprint printing(s) share rules identities.`);
