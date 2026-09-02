#!/usr/bin/env node
/**
 * import-csv.mjs — designer spreadsheet → format (v0.1). ZERO dependencies.
 * Usage: node tools/import-csv.mjs <cards.csv> <output-dir> [--title "Game Title"] [--license SPDX]
 *
 * Column conventions (case-insensitive):
 *   Core: id, name, type, subtypes, keywords (';'-separated), text,
 *         deck_limit, set, collector_number, quantity, artist, flavor_text
 *   Any OTHER column becomes a typed game attribute (int/number/bool inferred).
 * Missing id → slug of name. Missing set → 'core'.
 * Scaffolds a complete, validator-passing game directory.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const csvPath = args[0], outDir = args[1];
if (!outDir) { console.error("Usage: node tools/import-csv.mjs <cards.csv> <output-dir> [--title T]"); process.exit(2); }
const tIdx = args.indexOf("--title");
const title = tIdx > -1 ? args[tIdx + 1] : basename(outDir);
const lIdx = args.indexOf("--license");
const license = lIdx > -1 ? args[lIdx + 1] : "CC-BY-4.0";

// --- tiny CSV parser (quotes, embedded commas/newlines) ---
function parseCSV(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(c => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some(c => c !== "")) rows.push(row); }
  return rows;
}

const CORE = new Set(["id","name","type","subtypes","keywords","text","deck_limit","set","collector_number","quantity","artist","flavor_text"]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const kebab = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); // game ids are kebab-case
const infer = (vals) => {
  const nonEmpty = vals.filter(v => v !== "");
  if (nonEmpty.every(v => /^-?\d+$/.test(v))) return "integer";
  if (nonEmpty.every(v => /^-?\d+(\.\d+)?$/.test(v))) return "number";
  if (nonEmpty.every(v => /^(true|false)$/i.test(v))) return "boolean";
  return "string";
};
const cast = (v, t) => t === "integer" ? parseInt(v, 10) : t === "number" ? parseFloat(v) : t === "boolean" ? /^true$/i.test(v) : v;

const rows = parseCSV(readFileSync(csvPath, "utf8"));
const headers = rows[0].map(h => h.trim().toLowerCase());
const records = rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));

// attribute columns + type inference
const attrCols = headers.filter(h => !CORE.has(h));
const attrTypes = Object.fromEntries(attrCols.map(c => [c, infer(records.map(r => r[c] ?? ""))]));

const cards = [], printings = [], setIds = new Set(), warnings = [];
const seen = new Set();
records.forEach((r, i) => {
  if (!r.name) { warnings.push(`row ${i + 2}: no name — skipped`); return; }
  let id = r.id ? slug(r.id) : slug(r.name);
  if (seen.has(id)) { warnings.push(`row ${i + 2}: duplicate id '${id}' — suffixed`); let n = 2; while (seen.has(`${id}_${n}`)) n++; id = `${id}_${n}`; }
  seen.add(id);
  const setId = slug(r.set || "core"); setIds.add(setId);

  const card = { id, name: r.name, type: r.type || "card" };
  if (r.subtypes) card.subtypes = r.subtypes.split(";").map(s => s.trim()).filter(Boolean);
  if (r.text) card.text = r.text;
  if (r.keywords) card.keywords = r.keywords.split(";").map(s => s.trim()).filter(Boolean);
  const attrs = {};
  for (const c of attrCols) if (r[c] !== "" && r[c] != null) attrs[c] = cast(r[c], attrTypes[c]);
  if (Object.keys(attrs).length) card.attributes = attrs;
  if (r.deck_limit) card.deck_limit = parseInt(r.deck_limit, 10);
  cards.push(card);

  const printing = { id: `p_${id}_${setId}`, card_id: id, set_id: setId, template_id: "standard_face" };
  if (r.collector_number) printing.collector_number = r.collector_number;
  else printing.collector_number = String(printings.filter(p => p.set_id === setId).length + 1).padStart(3, "0");
  if (r.quantity) printing.quantity = parseInt(r.quantity, 10);
  if (r.artist) printing.artist = r.artist;
  if (r.flavor_text) printing.flavor_text = r.flavor_text;
  printings.push(printing);
});

// --- scaffold ---
for (const d of ["components", "sets", "formats", "restrictions", "rulings", "rules", "assets", "templates"])
  mkdirSync(join(outDir, d), { recursive: true });

const gameYaml = [
  `format_version: "0.1.0"`,
  `id: ${kebab(title)}`,
  `title: ${JSON.stringify(title)}`,
  `version: "0.1.0"`,
  `license: ${JSON.stringify(license)}`,
  `default_provenance:`,
  `  source: human`,
  ...(attrCols.length ? [`attribute_definitions:`] : []),
  ...attrCols.flatMap(c => [`  - key: ${c}`, `    name: ${JSON.stringify(c[0].toUpperCase() + c.slice(1))}`, `    type: ${attrTypes[c]}`]),
].join("\n") + "\n";
writeFileSync(join(outDir, "game.yaml"), gameYaml);

writeFileSync(join(outDir, "components/cards.json"), JSON.stringify(cards, null, 2) + "\n");
writeFileSync(join(outDir, "components/printings.json"), JSON.stringify(printings, null, 2) + "\n");
writeFileSync(join(outDir, "sets/sets.yaml"),
  [...setIds].map(s => `- id: ${s}\n  name: ${JSON.stringify(s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()))}\n  size: ${printings.filter(p => p.set_id === s).length}`).join("\n") + "\n");
writeFileSync(join(outDir, "formats/standard.yaml"),
  `id: standard\nname: Standard\ncard_pool:\n${[...setIds].map(s => `  - ${s}`).join("\n")}\n`);
writeFileSync(join(outDir, "rulings/rulings.json"), "[]\n");
writeFileSync(join(outDir, "rules/rules.md"), `# ${title}\n\n_Rules go here — this file diffs like code._\n`);

console.log(`Imported ${cards.length} cards, ${printings.length} printings, ${setIds.size} set(s) → ${outDir}`);
if (attrCols.length) console.log(`Inferred attributes: ${attrCols.map(c => `${c}:${attrTypes[c]}`).join(", ")}`);
for (const w of warnings) console.warn(`  warn  ${w}`);
console.log(`\nNext: validate with  node tools/validate.mjs ${outDir}`);
