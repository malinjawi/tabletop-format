import { createHash } from "node:crypto";
import { parseCSV, csvToCards } from "./cardcsv.mjs";

export const CSV_IMPORT_VERSION = 1;
export const CSV_CORE_TARGETS = [
  "id", "name", "type", "text", "subtypes", "keywords", "deck_limit",
  "set", "collector_number", "quantity", "artist", "flavor_text",
];

const CORE = new Set(CSV_CORE_TARGETS);
const DANGEROUS = new Set(["__proto__", "prototype", "constructor"]);
const SYNONYMS = new Map(Object.entries({
  card_id: "id", cardid: "id", card_key: "id", key: "id", uuid: "id",
  card_name: "name", card_title: "name", title: "name",
  card_type: "type", category: "type", kind: "type",
  rules: "text", rules_text: "text", rulestext: "text", effect: "text",
  ability: "text", ability_text: "text", description: "text",
  traits: "subtypes", trait: "subtypes", subtype: "subtypes",
  tags: "keywords", keyword: "keywords",
  max_copies: "deck_limit", copy_limit: "deck_limit", decklimit: "deck_limit",
  set_id: "set", pack: "set", expansion: "set",
  number: "collector_number", card_number: "collector_number", collector_no: "collector_number",
  copies: "quantity", count: "quantity", copy_count: "quantity",
  illustrator: "artist", illustration_credit: "artist", art_credit: "artist",
  flavor: "flavor_text", flavour: "flavor_text", flavour_text: "flavor_text",
}));

const statusError = (message, status = 422) => Object.assign(new Error(message), { status });
const clean = value => String(value ?? "").trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const validAttribute = key => /^[a-z][a-z0-9_]{0,63}$/.test(key)
  && !CORE.has(key) && !DANGEROUS.has(key);
const encodeCell = value => {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const encodeCSV = rows => rows.map(row => row.map(encodeCell).join(",")).join("\n") + "\n";

export function suggestCsvTarget(source) {
  const key = clean(source);
  if (!key) return "ignore";
  if (CORE.has(key)) return key;
  if (SYNONYMS.has(key)) return SYNONYMS.get(key);
  return validAttribute(key) ? `attributes.${key}` : "ignore";
}

function normalizeTarget(value) {
  const target = String(value ?? "").trim().toLowerCase();
  if (!target || target === "ignore") return "ignore";
  if (CORE.has(target)) return target;
  if (target.startsWith("attributes.") && validAttribute(target.slice(11))) return target;
  throw statusError(`unsupported CSV mapping target '${value}'`);
}

/**
 * Turn arbitrary designer CSV headers into Forge's canonical import contract.
 * The returned normalized CSV is the exact byte sequence consumed by the
 * importer; preview and commit therefore cannot disagree about column meaning.
 */
export function prepareCsvImport(text, requestedTargets = null) {
  text = String(text ?? "");
  if (Buffer.byteLength(text) > 900 * 1024) throw statusError("CSV is larger than the 900 KB controlled-beta limit", 413);
  const rows = parseCSV(text);
  if (!rows.length) throw statusError("CSV is empty");
  if (rows.length > 5001) throw statusError("CSV has more than 5,000 data rows");
  const sources = rows[0].map(value => String(value ?? "").trim());
  if (!sources.some(Boolean)) throw statusError("CSV header row is empty");
  if (requestedTargets != null && (!Array.isArray(requestedTargets) || requestedTargets.length !== sources.length))
    throw statusError(`CSV mapping needs exactly ${sources.length} column targets`);
  const targets = (requestedTargets ?? sources.map(suggestCsvTarget)).map(normalizeTarget);
  const used = new Map(), errors = [];
  targets.forEach((target, index) => {
    if (target === "ignore") return;
    if (used.has(target)) errors.push(`'${target}' is assigned to both '${sources[used.get(target)]}' and '${sources[index]}'`);
    else used.set(target, index);
  });
  if (!used.has("name")) errors.push("map one column to Card name");

  const selected = targets.map((target, index) => ({ target, index })).filter(item => item.target !== "ignore");
  const canonicalHeaders = selected.map(item => item.target.startsWith("attributes.") ? item.target.slice(11) : item.target);
  const normalizedRows = [canonicalHeaders, ...rows.slice(1).map(row => selected.map(item => row[item.index] ?? ""))];
  const normalizedCsv = encodeCSV(normalizedRows);
  let parsed = { cards: [], warnings: [], attrCols: [], identitySafe: false };
  if (!errors.length) {
    parsed = csvToCards(normalizedCsv);
    if (!parsed.cards.length) errors.push("no importable card rows were found");
  }
  const samples = sources.map((source, index) => rows.slice(1, 4).map(row => String(row[index] ?? "").trim()).filter(Boolean));
  const mapping = sources.map((source, index) => ({ index, source: source || `Column ${index + 1}`,
    suggested_target: suggestCsvTarget(source), target: targets[index], samples: samples[index] }));
  const warnings = [...new Set([
    ...parsed.warnings,
    ...mapping.filter(item => item.target === "ignore" && item.source).map(item => `Column '${item.source}' will be ignored.`),
  ])];
  return {
    format: "forge-csv-import-preview", version: CSV_IMPORT_VERSION,
    source_hash: createHash("sha256").update(text).digest("hex"),
    source_bytes: Buffer.byteLength(text), rows_total: Math.max(0, rows.length - 1),
    rows_importable: parsed.cards.length, mapping, attributes: parsed.attrCols,
    identity_safe: parsed.identitySafe, warnings, errors, can_import: errors.length === 0,
    cards: parsed.cards.slice(0, 3), normalized_csv: normalizedCsv,
    normalized_hash: createHash("sha256").update(normalizedCsv).digest("hex"),
  };
}

export function publicCsvPreview(preview) {
  const { normalized_csv: _private, ...safe } = preview;
  return safe;
}
