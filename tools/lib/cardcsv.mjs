// cardcsv.mjs — CSV (a designer's spreadsheet) → cards, using the SAME column
// conventions as tools/import-csv.mjs. Shared by the Sheets sync connector.
// Zero dependencies.
export function parseCSV(text) {
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

const CARD_COLUMNS = new Set(["name", "type", "subtypes", "keywords", "text", "deck_limit"]);
const PRINTING_COLUMNS = new Set(["printing_id", "set", "collector_number", "quantity", "artist", "flavor_text"]);
const CORE = new Set(["id", ...CARD_COLUMNS, ...PRINTING_COLUMNS]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const infer = (vals) => {
  const n = vals.filter(v => v !== "");
  if (!n.length) return "string";
  if (n.every(v => /^-?\d+$/.test(v))) return "integer";
  if (n.every(v => /^-?\d+(\.\d+)?$/.test(v))) return "number";
  if (n.every(v => /^(true|false)$/i.test(v))) return "boolean";
  return "string";
};
const cast = (v, t) => t === "integer" ? parseInt(v, 10) : t === "number" ? parseFloat(v)
  : t === "boolean" ? /^true$/i.test(v) : v;

/** CSV text → parsed cards plus enough column metadata for safe Sheet sync.
 *  `identitySafe` means every non-empty row has an explicit, unique `id`.
 *  Name-derived ids remain supported for one-off CSV imports, but a connected
 *  Sheet should surface the warning because renaming a row then looks like a
 *  delete + add instead of a stable card edit. */
export function csvToCards(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { cards: [], cardRows: [], warnings: ["the sheet is empty"], attrCols: [], headers: [],
    managedCardFields: [], managedPrintingFields: [], identitySafe: false };
  const headers = rows[0].map(h => h.trim().toLowerCase());
  if (!headers.includes("name")) return { cards: [], cardRows: [], warnings: ["no 'name' column — the sheet needs at least a name column"], attrCols: [], headers,
    managedCardFields: [], managedPrintingFields: [], identitySafe: false };
  const recs = rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  const attrCols = headers.filter(h => h && !CORE.has(h));
  const types = Object.fromEntries(attrCols.map(c => [c, infer(recs.map(r => r[c] ?? ""))]));
  const cards = [], cardRows = [], warnings = [], seen = new Set();
  let identitySafe = headers.includes("id");
  recs.forEach((r, i) => {
    if (!r.name) { warnings.push(`row ${i + 2}: no name — skipped`); return; }
    if (!r.id) identitySafe = false;
    let id = r.id ? slug(r.id) : slug(r.name);
    if (seen.has(id)) { identitySafe = false; warnings.push(`row ${i + 2}: duplicate id '${id}' — suffixed`); let n = 2; while (seen.has(`${id}_${n}`)) n++; id = `${id}_${n}`; }
    seen.add(id);
    const card = { id, name: r.name, type: r.type || "card" };
    if (r.subtypes) card.subtypes = r.subtypes.split(";").map(s => s.trim()).filter(Boolean);
    if (r.text) card.text = r.text;
    if (r.keywords) card.keywords = r.keywords.split(";").map(s => s.trim()).filter(Boolean);
    const attrs = {};
    for (const c of attrCols) if (r[c] !== "" && r[c] != null) attrs[c] = cast(r[c], types[c]);
    if (Object.keys(attrs).length) card.attributes = attrs;
    if (r.deck_limit) card.deck_limit = parseInt(r.deck_limit, 10);
    cards.push(card);
    cardRows.push(r);
  });
  if (!identitySafe && cards.length)
    warnings.push("Add a unique, permanent 'id' column before renaming cards; name-derived ids cannot track renames safely.");
  const managedCardFields = headers.filter(h => CARD_COLUMNS.has(h))
    .concat(attrCols.map(h => `attributes.${h}`));
  const managedPrintingFields = headers.filter(h => PRINTING_COLUMNS.has(h));
  return { cards, warnings, attrCols, rows: recs, cardRows, headers, managedCardFields,
    managedPrintingFields, identitySafe };
}

/** Merge sheet rows into printings, PRESERVING art/provenance on printings that
 *  already exist. A card with no printing is invisible in every export, so every
 *  card must end up with one. Printings whose card vanished are dropped. */
export function mergePrintings(existing, cards, rows) {
  const byCard = new Map();
  for (const p of existing || []) if (!byCard.has(p.card_id)) byCard.set(p.card_id, p);
  const out = [];
  cards.forEach((c, i) => {
    const r = (rows || [])[i] || {};
    const setId = slug(r.set || "core");
    const prev = byCard.get(c.id);
    const p = prev ? { ...prev } : {
      id: `p_${c.id}_${setId}`, card_id: c.id, set_id: setId, template_id: "standard_face",
    };
    if (r.collector_number) p.collector_number = r.collector_number;
    else if (!p.collector_number) p.collector_number = String(out.length + 1).padStart(3, "0");
    if (r.quantity) p.quantity = parseInt(r.quantity, 10);
    if (r.artist) p.artist = r.artist;
    if (r.flavor_text) p.flavor_text = r.flavor_text;
    out.push(p);
  });
  return out;
}

/** Paste any Google Sheets link; get the CSV export URL. Other URLs pass through. */
export function normalizeSheetUrl(url) {
  const m = String(url).match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return url;
  const gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1] || "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}
