// sheetsync.mjs — safe, field-level promotion from a Sheet working copy.
//
// A connected Sheet is one authoring surface, not permission to overwrite the
// repository. The last candidate commit is the merge base; Forge HEAD is
// the local side; the freshly fetched Sheet is the remote side. Only
// non-conflicting changes are merged. Conflicts are returned as data and must
// never be committed silently.
import { createHash } from "node:crypto";

const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const fingerprintCsv = (text) => createHash("sha256").update(text).digest("hex");

const getPath = (obj, path) => path.split(".").reduce((v, k) => v == null ? undefined : v[k], obj);
const putPath = (obj, path, value) => {
  const bits = path.split("."); let at = obj;
  for (const bit of bits.slice(0, -1)) at = at[bit] ??= {};
  const key = bits.at(-1);
  if (value === undefined) {
    delete at[key];
    // Avoid leaving attributes:{} behind when the last Sheet-managed value is cleared.
    for (let i = bits.length - 1; i > 0; i--) {
      const parent = getPath(obj, bits.slice(0, i - 1).join(".")) ?? obj;
      const childKey = bits[i - 1];
      if (plain(parent[childKey]) && !Object.keys(parent[childKey]).length) delete parent[childKey];
    }
  } else at[key] = clone(value);
};

/** Construct the Sheet's card branch from the previous candidate base. Columns not
 * present in the Sheet are deliberately preserved: connecting a minimal Sheet
 * must not erase Forge-only metadata. Card membership remains Sheet-managed. */
export function sheetCardsFromBase(baseCards, parsed) {
  const base = new Map((baseCards || []).map(c => [c.id, c]));
  return parsed.cards.map(incoming => {
    const prior = base.get(incoming.id);
    if (!prior) return clone(incoming);
    const card = clone(prior);
    for (const field of parsed.managedCardFields || []) putPath(card, field, getPath(incoming, field));
    card.id = incoming.id;
    return card;
  });
}

const printingField = (column) => column === "set" ? "set_id" : column;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Apply printing columns to a branch based on the previous candidate commit.
 * Extra printings, art, scans and provenance survive because the Sheet only
 * owns the columns it actually contains. Removing a card removes its printings. */
export function sheetPrintingsFromBase(basePrintings, remoteCards, parsed) {
  const liveCards = new Set(remoteCards.map(c => c.id));
  const byCard = new Map();
  for (const p of basePrintings || []) {
    if (!liveCards.has(p.card_id)) continue;
    if (!byCard.has(p.card_id)) byCard.set(p.card_id, []);
    byCard.get(p.card_id).push(clone(p));
  }
  const out = [];
  remoteCards.forEach((card, i) => {
    const row = (parsed.cardRows || parsed.rows || [])[i] || {};
    const candidates = byCard.get(card.id) || [];
    const requestedId = row.printing_id ? slug(row.printing_id) : null;
    let primary = requestedId ? candidates.find(p => p.id === requestedId) : candidates[0];
    if (!primary) {
      const setId = slug(row.set || "core") || "core";
      primary = { id: requestedId || `p_${card.id}_${setId}`, card_id: card.id,
        set_id: setId, template_id: "standard_face" };
      candidates.unshift(primary);
    }
    for (const col of parsed.managedPrintingFields || []) {
      if (col === "printing_id") continue; // identity selects a printing; it is not mutable data
      const field = printingField(col);
      let value = row[col] || undefined;
      if (col === "set") value = slug(row.set || "core") || "core";
      if (col === "quantity" && value !== undefined) value = parseInt(value, 10);
      putPath(primary, field, value);
    }
    if (!primary.collector_number)
      primary.collector_number = String(i + 1).padStart(3, "0");
    out.push(...candidates);
  });
  return out;
}

const visible = (v) => v === undefined ? null : clone(v);
function mergeValue(base, forge, sheet, path, context, conflicts) {
  if (eq(forge, sheet)) return clone(forge);
  if (eq(forge, base)) return clone(sheet);
  if (eq(sheet, base)) return clone(forge);

  // Independent edits to different keys of a card/attributes object can merge.
  if ((plain(base) || base === undefined) && plain(forge) && plain(sheet)) {
    const merged = {};
    const b = plain(base) ? base : {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(forge), ...Object.keys(sheet)])) {
      const value = mergeValue(b[key], forge[key], sheet[key], path ? `${path}.${key}` : key, context, conflicts);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }

  conflicts.push({ ...context, field: path || "(record)", base: visible(base),
    forge: visible(forge), sheet: visible(sheet), base_missing: base === undefined,
    forge_missing: forge === undefined, sheet_missing: sheet === undefined });
  return clone(forge); // safe preview value; apply is blocked whenever conflicts exist
}

function mergeRecords(baseArr, forgeArr, sheetArr, entity, cardNames) {
  const map = (arr) => new Map((arr || []).map(v => [v.id, v]));
  const B = map(baseArr), F = map(forgeArr), S = map(sheetArr);
  const order = [...new Set([...(sheetArr || []).map(v => v.id), ...(forgeArr || []).map(v => v.id),
    ...(baseArr || []).map(v => v.id)])];
  const merged = [], conflicts = [];
  for (const id of order) {
    const sample = F.get(id) || S.get(id) || B.get(id) || {};
    const cardId = entity === "card" ? id : sample.card_id;
    const value = mergeValue(B.get(id), F.get(id), S.get(id), "",
      { entity, id, card_id: cardId, name: cardNames.get(cardId) || cardId || id }, conflicts);
    if (value !== undefined) merged.push(value);
  }
  return { merged, conflicts };
}

/** Merge the complete card + printing state. */
export function mergeSheetState({ baseCards, forgeCards, sheetCards, basePrintings,
  forgePrintings, sheetPrintings }) {
  const names = new Map([...baseCards, ...forgeCards, ...sheetCards].map(c => [c.id, c.name]));
  const cards = mergeRecords(baseCards, forgeCards, sheetCards, "card", names);
  const printings = mergeRecords(basePrintings, forgePrintings, sheetPrintings, "printing", names);
  return { cards: cards.merged, printings: printings.merged,
    conflicts: [...cards.conflicts, ...printings.conflicts] };
}
