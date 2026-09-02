#!/usr/bin/env node
/** Read a PnPInk CSV back into a Forge change proposal.
 *
 * Default behavior is read-only and prints a semantic diff. --write updates
 * components/cards.json but never commits; Forge's normal commit/PR workflow
 * remains the authority boundary.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { loadDesignEngines } from "./lib/design-engines.mjs";

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function gameFile(gameDir, rel, label) {
  if (typeof rel !== "string" || isAbsolute(rel)) throw new Error(`${label} must be a relative path`);
  const path = resolve(gameDir, rel);
  if (!inside(gameDir, path)) throw new Error(`${label} escapes the game directory: ${rel}`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${rel}`);
  return path;
}

function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter(values => values.some(value => value !== ""));
}

function dig(value, path) {
  for (const key of String(path).split(".")) {
    if (value == null || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

function assign(value, path, next) {
  const keys = String(path).split(".");
  for (const key of keys.slice(0, -1)) value = value[key] ??= {};
  value[keys.at(-1)] = next;
}

function remove(value, path) {
  const keys = String(path).split(".");
  for (const key of keys.slice(0, -1)) {
    if (value == null || typeof value !== "object") return;
    value = value[key];
  }
  if (value && typeof value === "object") delete value[keys.at(-1)];
}

function coerce(raw, before, declaredType) {
  if (raw === "" && before !== undefined && ["integer", "number", "boolean"].includes(declaredType))
    return undefined;
  if (Array.isArray(before)) return raw ? raw.split(/\s*·\s*/).map(value => value.trim()).filter(Boolean) : [];
  if (typeof before === "number" || declaredType === "integer" || declaredType === "number") {
    const number = Number(raw);
    if (!Number.isFinite(number)) throw new Error(`expected a number, got '${raw}'`);
    if (declaredType === "integer" && !Number.isInteger(number)) throw new Error(`expected an integer, got '${raw}'`);
    return number;
  }
  if (typeof before === "boolean" || declaredType === "boolean") {
    if (!/^(?:true|false)$/i.test(raw)) throw new Error(`expected true or false, got '${raw}'`);
    return raw.toLowerCase() === "true";
  }
  return raw;
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function analyzePnpinkCsv(gamePath, csvPath) {
  const gameDir = resolve(gamePath);
  const registry = loadDesignEngines(gameDir);
  const engine = registry?.engines.find(candidate => candidate.type === "pnpink");
  if (!engine) throw new Error("game has no PnPInk engine adapter");
  const adapter = yaml.load(readFileSync(gameFile(gameDir, engine.source, "PnPInk adapter"), "utf8")) || {};
  const cardsPath = gameFile(gameDir, "components/cards.json", "cards");
  const cards = JSON.parse(readFileSync(cardsPath, "utf8"));
  const game = yaml.load(readFileSync(gameFile(gameDir, "game.yaml", "game"), "utf8")) || {};
  const attributeTypes = new Map((game.attribute_definitions || []).map(definition => [definition.key, definition.type]));
  const byId = new Map(cards.map(card => [card.id, card]));
  const byBbox = new Map(adapter.families.map(family => [family.bbox, family]));
  const rows = parseCsv(readFileSync(resolve(csvPath), "utf8"));
  const changes = [];
  let family = null, headers = [];
  for (const row of rows) {
    const marker = /^\{\{t=([^}]+)}}$/.exec(row[0].trim());
    if (marker) {
      family = byBbox.get(marker[1]);
      if (!family) throw new Error(`CSV references unknown PnPInk bbox '${marker[1]}'`);
      headers = row.slice(1);
      continue;
    }
    if (!family) continue;
    const targetToSource = new Map(Object.entries(family.fields).map(([source, target]) => [target, source]));
    const values = {};
    headers.forEach((header, index) => {
      const source = targetToSource.get(header);
      if (source) values[source] = row[index + 1] ?? "";
    });
    const cardId = values.id;
    const card = byId.get(cardId);
    if (!card) throw new Error(`CSV references unknown Forge card '${cardId}'`);
    const fields = [];
    for (const [path, raw] of Object.entries(values)) {
      if (!path || path === "id") continue;
      const before = dig(card, path);
      if (before === undefined && raw === "") continue;
      const declaredType = path.startsWith("attributes.") ? attributeTypes.get(path.slice("attributes.".length)) : null;
      const after = coerce(raw, before, declaredType);
      if (!equal(before, after)) fields.push({
        path,
        before: before ?? null,
        after: after ?? null,
        ...(after === undefined ? { remove: true } : {}),
      });
    }
    if (fields.length) changes.push({ card_id: cardId, family: family.id, fields });
  }
  return { engine: engine.id, cards_path: cardsPath, cards, changes };
}

export function writePnpinkChanges(result) {
  const byId = new Map(result.cards.map(card => [card.id, card]));
  for (const change of result.changes) {
    const card = byId.get(change.card_id);
    for (const field of change.fields)
      if (field.remove) remove(card, field.path); else assign(card, field.path, field.after);
  }
  writeFileSync(result.cards_path, `${JSON.stringify(result.cards, null, 2)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const positional = args.filter(arg => arg !== "--write");
  if (positional.length < 2) {
    console.error("Usage: node tools/import-pnpink.mjs <game-dir> <csv> [--write]");
    process.exit(2);
  }
  const result = analyzePnpinkCsv(positional[0], positional[1]);
  console.log(JSON.stringify({ engine: result.engine, changes: result.changes }, null, 2));
  if (write && result.changes.length) {
    writePnpinkChanges(result);
    console.log(`Updated ${result.cards_path}; review and commit through Forge.`);
  } else if (!write && result.changes.length) {
    console.log("Dry run only. Re-run with --write to update components/cards.json; no commit will be created.");
  }
}
