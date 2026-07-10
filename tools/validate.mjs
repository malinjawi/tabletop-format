#!/usr/bin/env node
/**
 * validate.mjs — reference validator for the format (v0.1)
 * Usage: node tools/validate.mjs <game-directory>
 *
 * Two passes:
 *   1. Schema validation (ajv, draft 2020-12) per document
 *   2. Referential integrity + typed-attribute checks across documents
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import yaml from "js-yaml";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const gameDir = process.argv[2];
if (!gameDir) { console.error("Usage: node tools/validate.mjs <game-directory>"); process.exit(2); }

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const f of readdirSync(SCHEMA_DIR).filter(f => f.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")));
}
const validator = (name) => ajv.getSchema(`https://spec.example.dev/schemas/${name}.schema.json`);

const load = (rel) => {
  const p = join(gameDir, rel);
  if (!existsSync(p)) return undefined;
  const raw = readFileSync(p, "utf8");
  return rel.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
};
const loadDirOrFile = (dir, exts = [".yaml", ".yml", ".json"]) => {
  const p = join(gameDir, dir);
  if (!existsSync(p)) return [];
  return readdirSync(p)
    .filter(f => exts.some(e => f.endsWith(e)))
    .flatMap(f => {
      const doc = load(join(dir, f));
      return Array.isArray(doc) ? doc : [doc];
    });
};

let errors = 0, warnings = 0;
const err = (m) => { errors++; console.error(`  ERROR  ${m}`); };
const warn = (m) => { warnings++; console.warn(`  warn   ${m}`); };
const checkSchema = (name, doc, label) => {
  const v = validator(name);
  if (!v(doc)) for (const e of v.errors) err(`${label}: ${e.instancePath || "/"} ${e.message}`);
};

console.log(`Validating ${gameDir}\n`);

// ---- Pass 1: schemas ----
const game = load("game.yaml");
if (!game) { err("game.yaml missing"); process.exit(1); }
checkSchema("game", game, "game.yaml");

const cards = load("components/cards.json") ?? [];
cards.forEach((c, i) => checkSchema("card", c, `cards[${i}] (${c?.id ?? "?"})`));

const printings = load("components/printings.json") ?? [];
printings.forEach((p, i) => checkSchema("printing", p, `printings[${i}] (${p?.id ?? "?"})`));

const sets = loadDirOrFile("sets");
sets.forEach((s, i) => checkSchema("set", s, `sets[${i}] (${s?.id ?? "?"})`));

const formats = loadDirOrFile("formats");
formats.forEach((f, i) => checkSchema("format", f, `formats[${i}] (${f?.id ?? "?"})`));

const restrictions = loadDirOrFile("restrictions");
restrictions.forEach((r, i) => checkSchema("restriction", r, `restrictions[${i}] (${r?.id ?? "?"})`));

const rulings = load("rulings/rulings.json") ?? [];
rulings.forEach((r, i) => checkSchema("ruling", r, `rulings[${i}]`));

const decks = loadDirOrFile("decks");
decks.forEach((d, i) => checkSchema("deck", d, `decks[${i}] (${d?.id ?? "?"})`));

const tokens = load("components/tokens.json") ?? [];
tokens.forEach((t, i) => checkSchema("token", t, `tokens[${i}] (${t?.id ?? "?"})`));

const playtests = loadDirOrFile("playtests");
playtests.forEach((s, i) => checkSchema("playtest", s, `playtests[${i}] (${s?.id ?? "?"})`));

// ---- Pass 2: referential integrity ----
const dupes = (arr, label) => {
  const seen = new Set();
  for (const x of arr) {
    if (seen.has(x.id)) err(`duplicate ${label} id '${x.id}'`);
    seen.add(x.id);
  }
};
dupes(cards, "card"); dupes(printings, "printing"); dupes(sets, "set");
dupes(formats, "format"); dupes(restrictions, "restriction");

const cardIds = new Set(cards.map(c => c.id));
const setIds = new Set(sets.map(s => s.id));
const restrictionIds = new Set(restrictions.map(r => r.id));

for (const p of printings) {
  if (!cardIds.has(p.card_id)) err(`printing '${p.id}': card_id '${p.card_id}' not found in cards.json`);
  if (!setIds.has(p.set_id)) err(`printing '${p.id}': set_id '${p.set_id}' not found in sets`);
}
for (const f of formats) {
  for (const s of f.card_pool) if (!setIds.has(s)) err(`format '${f.id}': card_pool set '${s}' not found`);
  if (f.active_restriction_id && !restrictionIds.has(f.active_restriction_id))
    err(`format '${f.id}': active_restriction_id '${f.active_restriction_id}' not found`);
}
for (const r of restrictions) {
  for (const c of [...(r.banned ?? []), ...(r.restricted ?? [])])
    if (!cardIds.has(c)) err(`restriction '${r.id}': card '${c}' not found`);
}
for (const [i, r] of rulings.entries()) {
  if (!cardIds.has(r.card_id)) err(`ruling[${i}]: card '${r.card_id}' not found`);
}
const formatIds = new Set(formats.map(f => f.id));
for (const d of decks) {
  for (const cid of Object.keys(d.cards ?? {}))
    if (!cardIds.has(cid)) err(`deck '${d.id}': card '${cid}' not found`);
  if (d.format_id && !formatIds.has(d.format_id)) err(`deck '${d.id}': format '${d.format_id}' not found`);
}

// Typed attributes vs game.yaml attribute_definitions
const defs = new Map((game.attribute_definitions ?? []).map(d => [d.key, d]));
for (const c of cards) {
  for (const [k, v] of Object.entries(c.attributes ?? {})) {
    const d = defs.get(k);
    if (!d) { warn(`card '${c.id}': attribute '${k}' not declared in game.yaml`); continue; }
    const t = d.type === "integer" ? Number.isInteger(v) : typeof v === d.type;
    if (!t) err(`card '${c.id}': attribute '${k}' should be ${d.type}, got ${typeof v} (${JSON.stringify(v)})`);
  }
  for (const d of defs.values())
    if (d.required && !(d.key in (c.attributes ?? {}))) err(`card '${c.id}': missing required attribute '${d.key}'`);
}

// Symbol tags in card text must be declared
const declaredSymbols = new Set((game.symbols ?? []).map(s => s.key));
for (const c of cards) {
  for (const m of (c.text ?? "").matchAll(/\[([a-z0-9_]+)\]/g))
    if (!declaredSymbols.has(m[1])) warn(`card '${c.id}': text uses undeclared symbol [${m[1]}]`);
}
dupes(tokens, "token");
for (const t of tokens)
  if (t.symbol && !declaredSymbols.has(t.symbol)) err(`token '${t.id}': symbol '${t.symbol}' not declared in game.yaml`);
const deckIds = new Set(decks.map(d => d.id));
for (const s of playtests) {
  for (const n of s.card_notes ?? [])
    if (!cardIds.has(n.card_id)) err(`playtest '${s.id}': card_note references unknown card '${n.card_id}'`);
  for (const d of s.decisions ?? [])
    if (d.card_id && !cardIds.has(d.card_id)) err(`playtest '${s.id}': decision references unknown card '${d.card_id}'`);
  for (const p of s.players ?? [])
    if (p.deck_id && !deckIds.has(p.deck_id)) warn(`playtest '${s.id}': player deck '${p.deck_id}' not found in decks/`);
}

// Set size vs actual printings
for (const s of sets) {
  if (s.size != null) {
    const actual = printings.filter(p => p.set_id === s.id).length;
    if (actual !== s.size) warn(`set '${s.id}': declares size ${s.size}, has ${actual} printings`);
  }
}

console.log(`\n${cards.length} cards, ${printings.length} printings, ${sets.length} sets, ${formats.length} formats, ${restrictions.length} restrictions, ${rulings.length} rulings`);
if (errors) { console.error(`\nFAIL — ${errors} error(s), ${warnings} warning(s)`); process.exit(1); }
console.log(`\nOK — 0 errors, ${warnings} warning(s)`);
