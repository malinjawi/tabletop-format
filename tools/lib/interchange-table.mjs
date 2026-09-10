import { parseCSV } from "./cardcsv.mjs";

const CARD_ORDER = ["id", "name", "type", "subtypes", "text", "keywords", "deck_limit", "orientation", "tags", "notes"];
const PRINTING_ORDER = ["id", "card_id", "set_id", "collector_number", "quantity", "artist", "flavor_text", "art", "art_crop", "image", "scan", "art_url", "background_url", "back", "template_id", "variant", "provenance", "scan_provenance"];
const TOKEN_ORDER = ["id", "name", "kind", "template_id", "quantity", "per_player", "description", "symbol", "art", "back", "size_mm", "faces", "parent", "notes"];

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function flatten(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (key === "attributes" && item && typeof item === "object" && !Array.isArray(item)) {
      for (const [attribute, attributeValue] of Object.entries(item)) out[`attributes.${attribute}`] = attributeValue;
    } else out[key] = item;
  }
  return out;
}

function cellType(values) {
  const present = values.filter(value => value !== undefined);
  if (!present.length) return "string";
  if (present.every(value => typeof value === "number" && Number.isInteger(value))) return "integer";
  if (present.every(value => typeof value === "number")) return "number";
  if (present.every(value => typeof value === "boolean")) return "boolean";
  if (present.every(value => typeof value === "string")) return "string";
  return "json";
}

function orderedColumns(rows, kind) {
  const flattened = rows.map(flatten), names = new Set(flattened.flatMap(row => Object.keys(row)));
  const preferred = kind === "cards" ? CARD_ORDER : kind === "printings" ? PRINTING_ORDER : TOKEN_ORDER;
  // Empty projects still need an immediately usable schema: a blank worksheet
  // with no `id` header cannot accept its first component or round-trip safely.
  if (!rows.length) return preferred.map(path => ({ path, type: "string" }));
  const ordered = preferred.filter(name => names.delete(name));
  const attributes = [...names].filter(name => name.startsWith("attributes.")).sort();
  for (const name of attributes) names.delete(name);
  return [...ordered, ...attributes, ...[...names].sort()].map(path => ({
    path,
    type: cellType(flattened.map(row => row[path])),
  }));
}

function encode(value, type) {
  if (value === undefined) return "";
  if (type === "json") return JSON.stringify(value);
  if (type === "boolean") return value ? "true" : "false";
  return String(value);
}

function quote(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function tableToCsv(rows, kind) {
  const columns = orderedColumns(rows, kind), flat = rows.map(flatten);
  const csvRows = [columns.map(column => column.path)];
  for (const row of flat) csvRows.push(columns.map(column => encode(row[column.path], column.type)));
  return {
    columns,
    csv: `${csvRows.map(row => row.map(quote).join(",")).join("\n")}\n`,
  };
}

function inferType(values) {
  const nonempty = values.filter(value => value !== "");
  if (nonempty.length && nonempty.every(value => /^-?\d+$/.test(value))) return "integer";
  if (nonempty.length && nonempty.every(value => /^-?(?:\d+\.?\d*|\.\d+)$/.test(value))) return "number";
  if (nonempty.length && nonempty.every(value => /^(?:true|false)$/i.test(value))) return "boolean";
  return "string";
}

function decode(raw, type, path) {
  if (raw === "") return undefined;
  if (type === "integer") {
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new Error(`${path}: expected integer, got '${raw}'`);
    return value;
  }
  if (type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${path}: expected number, got '${raw}'`);
    return value;
  }
  if (type === "boolean") {
    if (!/^(?:true|false)$/i.test(raw)) throw new Error(`${path}: expected true or false, got '${raw}'`);
    return raw.toLowerCase() === "true";
  }
  if (type === "json") {
    try { return JSON.parse(raw); }
    catch { throw new Error(`${path}: expected JSON array/object`); }
  }
  return raw;
}

function assign(row, path, value) {
  if (value === undefined) return;
  if (path.startsWith("attributes.")) {
    row.attributes ||= {};
    row.attributes[path.slice("attributes.".length)] = value;
  } else row[path] = value;
}

export function csvToTable(text, table, kind, baseRows = []) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const headers = rows[0].map(value => value.trim());
  if (!headers.includes("id")) throw new Error(`${kind}.csv needs a stable id column`);
  if (new Set(headers).size !== headers.length) throw new Error(`${kind}.csv has duplicate columns`);
  const declared = new Map((table.columns || []).map(column => [column.path, column.type]));
  const unknown = headers.filter(header => !declared.has(header));
  for (const header of unknown)
    if (!/^attributes\.[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(header))
      throw new Error(`${kind}.csv has unsupported new column '${header}'; new fields must be attributes.<key>`);
  const records = rows.slice(1).filter(row => row.some(value => value !== ""));
  const inferred = new Map(unknown.map(header => {
    const index = headers.indexOf(header);
    return [header, inferType(records.map(row => row[index] ?? ""))];
  }));
  const baseById = new Map(baseRows.map(row => [row.id, flatten(row)]));
  const idIndex = headers.indexOf("id");
  const seen = new Set(), out = [];
  for (let rowIndex = 0; rowIndex < records.length; rowIndex++) {
    const values = records[rowIndex], row = {}, base = baseById.get(values[idIndex]) || {};
    headers.forEach((path, columnIndex) => {
      const raw = values[columnIndex] ?? "";
      const value = raw === "" && base[path] === "" ? ""
        : decode(raw, declared.get(path) || inferred.get(path), `${kind} row ${rowIndex + 2} ${path}`);
      assign(row, path, value);
    });
    if (!row.id) throw new Error(`${kind} row ${rowIndex + 2} has no id`);
    if (seen.has(row.id)) throw new Error(`${kind}.csv has duplicate id '${row.id}'`);
    seen.add(row.id);
    if (row.attributes && !Object.keys(row.attributes).length) delete row.attributes;
    out.push(row);
  }
  return out;
}

export function tableColumns(rows, kind) {
  return orderedColumns(rows, kind);
}
