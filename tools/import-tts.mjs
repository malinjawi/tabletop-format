#!/usr/bin/env node
/**
 * import-tts.mjs — Tabletop Simulator deck save → format game project (v0.1).
 * ZERO dependencies.
 *
 * Usage: node tools/import-tts.mjs <tts-save.json> <output-dir> [--title "Game"]
 *
 * INTEROP: this reads a TTS DeckCustom save — which is exactly what Tabletop
 * Simulator, Screentop, and **Dextrous** emit when you export a deck. It's the
 * inverse of tools/export_tts.py, so a game round-trips: export → import keeps
 * every card's name, rules text, quantity, and (from our GMNotes) art credit.
 * A deck authored in another tool becomes a versioned, forkable game here.
 *
 *   ObjectStates[deck].ContainedObjects[i]  → one card (Nickname, Description, GMNotes)
 *   ObjectStates[deck].DeckIDs              → quantities (repeats per CardID)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const savePath = args[0], outDir = args[1];
if (!outDir) { console.error("Usage: node tools/import-tts.mjs <tts-save.json> <output-dir> [--title T]"); process.exit(2); }
const tIdx = args.indexOf("--title");

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const kebab = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const save = JSON.parse(readFileSync(savePath, "utf8"));
const title = tIdx > -1 ? args[tIdx + 1] : (save.SaveName || save.GameMode || basename(outDir));

// find the first deck-like object that actually carries cards
const objs = save.ObjectStates || [];
const deck = objs.find(o => Array.isArray(o.ContainedObjects) && o.ContainedObjects.length)
          || objs.find(o => /Deck/i.test(o.Name || ""));
if (!deck || !Array.isArray(deck.ContainedObjects) || !deck.ContainedObjects.length) {
  console.error("No DeckCustom with ContainedObjects found — is this a TTS deck save?"); process.exit(1);
}

// quantity = how many times a CardID appears in DeckIDs (falls back to object count)
const deckIds = Array.isArray(deck.DeckIDs) ? deck.DeckIDs : [];
const qtyOf = (cid) => deckIds.filter(x => x === cid).length;

// dedge ContainedObjects by CardID (our exporter repeats them; standard decks don't)
const byCard = new Map();
deck.ContainedObjects.forEach((o, i) => {
  const key = o.CardID ?? `nick:${o.Nickname ?? i}`;
  if (!byCard.has(key)) byCard.set(key, o);
});

const creditFromGM = (gm) => {                       // "Credit: X · License: Y" → "X"
  if (!gm) return "";
  const part = String(gm).split("·").map(s => s.trim()).find(s => /^credit:/i.test(s));
  return part ? part.replace(/^credit:\s*/i, "").trim() : "";
};

const cards = [], printings = [], seen = new Set();
let order = 0;
for (const [key, o] of byCard) {
  const name = (o.Nickname || `Card ${++order}`).trim();
  let id = slug(name) || `card_${++order}`;
  if (seen.has(id)) { let n = 2; while (seen.has(`${id}_${n}`)) n++; id = `${id}_${n}`; }
  seen.add(id);
  const card = { id, name, type: "card" };
  if (o.Description) card.text = o.Description;
  cards.push(card);

  const printing = { id: `p_${id}_core`, card_id: id, set_id: "core", template_id: "standard_face",
    collector_number: String(printings.length + 1).padStart(3, "0") };
  const qty = typeof o.CardID === "number" ? qtyOf(o.CardID) : 0;
  printing.quantity = qty > 0 ? qty : 1;
  const credit = creditFromGM(o.GMNotes);
  if (credit) printing.artist = credit;              // credit follows the work back in
  printings.push(printing);
}

// --- scaffold a validator-passing game (mirrors import-csv) ---
for (const d of ["components", "sets", "formats", "restrictions", "rulings", "rules", "assets", "templates"])
  mkdirSync(join(outDir, d), { recursive: true });

writeFileSync(join(outDir, "game.yaml"), [
  `format_version: "0.1.0"`,
  `id: ${kebab(title)}`,
  `title: ${JSON.stringify(title)}`,
  `version: "0.1.0"`,
  `license: CC-BY-4.0  # <-- imported default; CHOOSE your license deliberately`,
  `default_provenance:`,
  `  source: human`,
].join("\n") + "\n");
writeFileSync(join(outDir, "components/cards.json"), JSON.stringify(cards, null, 2) + "\n");
writeFileSync(join(outDir, "components/printings.json"), JSON.stringify(printings, null, 2) + "\n");
writeFileSync(join(outDir, "sets/sets.yaml"), `- id: core\n  name: "Core"\n  size: ${printings.length}\n`);
writeFileSync(join(outDir, "formats/standard.yaml"), `id: standard\nname: Standard\ncard_pool:\n  - core\n`);
writeFileSync(join(outDir, "rulings/rulings.json"), "[]\n");
writeFileSync(join(outDir, "rules/rules.md"), `# ${title}\n\n_Imported from a Tabletop Simulator deck — rules go here._\n`);

const totalQty = printings.reduce((s, p) => s + (p.quantity || 1), 0);
console.log(`Imported ${cards.length} unique cards (${totalQty}-card deck) from TTS save → ${outDir}`);
console.log(`  source: "${title}"  ·  credit carried from GMNotes where present`);
console.log(`\nNext: validate with  node tools/validate.mjs ${outDir}`);
