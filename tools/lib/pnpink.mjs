import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import yaml from "js-yaml";

import { cardMatchesFamily } from "./card-design.mjs";
import { deterministicZip, readZip } from "./deterministic-zip.mjs";
import { loadDesignEngines } from "./design-engines.mjs";
import { currentNandeckSources } from "./nandeck-layout.mjs";

export const PNPINK_WORKING_COPY_FORMAT = "forge-pnpink-working-copy";
export const PNPINK_WORKING_COPY_VERSION = 1;
export const PNPINK_SUITE_FORMAT = "forge-pnpink-suite";
export const PNPINK_SUITE_VERSION = 1;
export const MAX_PNPINK_BYTES = 32 * 1024 * 1024;

const clone = value => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => isDeepStrictEqual(a, b);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const safeName = value => String(value || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "game";
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const unb64 = value => JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRel(path, label = "path") {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\")
      || path.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error(`${label} must be a safe relative path: ${path}`);
  return path;
}

function gameFile(gameDir, rel, label = "file") {
  safeRel(rel, label);
  const path = resolve(gameDir, rel);
  if (!inside(gameDir, path)) throw new Error(`${label} escapes the game directory: ${rel}`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${rel}`);
  return path;
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

function csvCell(value) {
  if (Array.isArray(value)) value = value.join(" · ");
  if (typeof value === "boolean") value = value ? "true" : "false";
  const text = String(value ?? "").replaceAll("\r\n", "\n");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvText(rows) {
  return `${rows.map(row => row.map(csvCell).join(",")).join("\n")}\n`;
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

function loadAdapter(gameDir) {
  const registry = loadDesignEngines(gameDir);
  const engine = registry?.engines.find(candidate => candidate.type === "pnpink");
  if (!engine) throw new Error("game has no PnPInk adapter");
  const adapterPath = gameFile(gameDir, engine.source, "PnPInk adapter");
  const adapter = yaml.load(readFileSync(adapterPath, "utf8")) || {};
  if (adapter.version !== 1 || adapter.kind !== "pnpink") throw new Error("unsupported PnPInk adapter manifest");
  if (!adapter.upstream?.tested_tag || !/^v\d+\.\d+(?:\.\d+)?$/.test(adapter.upstream.tested_tag))
    throw new Error("PnPInk adapter must pin upstream.tested_tag");
  const templatePath = gameFile(gameDir, adapter.template, "PnPInk template");
  if (!inside(resolve(gameDir, "templates/card-design"), templatePath))
    throw new Error("PnPInk template must remain under templates/card-design/");
  if (!Array.isArray(adapter.families) || !adapter.families.length) throw new Error("PnPInk adapter needs families");
  for (const family of adapter.families) {
    if (!family.id || !family.bbox || !family.fields?.id) throw new Error(`invalid PnPInk family '${family.id || "unknown"}'`);
    const targets = Object.values(family.fields);
    if (new Set(targets).size !== targets.length) throw new Error(`PnPInk family '${family.id}' has duplicate SVG targets`);
  }
  return { registry, engine, adapter, adapterPath, templatePath };
}

function familyRows(cards, family, sourceFamily) {
  const selected = cards.filter(card => cardMatchesFamily(card, sourceFamily.match || {}));
  if (!selected.length) throw new Error(`PnPInk family '${family.id}' matches no cards`);
  return selected;
}

function sourceHash(cardsBytes, templateBytes, adapterBytes, designHash) {
  return `sha256:${sha256(Buffer.concat([
    Buffer.from(String(designHash || "")), Buffer.from("\0"), cardsBytes, Buffer.from("\0"), templateBytes,
    Buffer.from("\0"), adapterBytes,
  ]))}`;
}

function csvForFamily(family, cards, meta) {
  const fields = Object.entries(family.fields);
  const rows = [
    [`# FORGE_META ${b64(meta)}`],
    [`{{t=${family.bbox}}}{A4}.L{s=poker g=3}.M{}`, ...fields.map(([, target]) => target)],
    ...cards.map(card => ["1", ...fields.map(([source]) => dig(card, source))]),
  ];
  return csvText(rows);
}

function pnpManifest(svg, csv) {
  return {
    format: "pnp", version: 1, svg, csv, assets_dir: "assets", run_deckmaker_on_import: true,
  };
}

/** Build one deterministic PnPInk working copy per declared card family. */
export function buildPnpinkProject(gameDirValue) {
  const gameDir = resolve(gameDirValue), game = yaml.load(readFileSync(gameFile(gameDir, "game.yaml"), "utf8")) || {};
  const cardsPath = gameFile(gameDir, "components/cards.json", "cards"), cardsBytes = readFileSync(cardsPath);
  const cards = JSON.parse(cardsBytes.toString("utf8")), sources = currentNandeckSources(gameDir);
  const { engine, adapter, adapterPath, templatePath } = loadAdapter(gameDir);
  const adapterBytes = readFileSync(adapterPath), templateBytes = readFileSync(templatePath);
  const hash = sourceHash(cardsBytes, templateBytes, adapterBytes, sources.sourceHash);
  const root = safeName(game.id || basename(gameDir)), entries = new Map(), familyReports = [];
  for (const family of adapter.families) {
    const sourceFamily = sources.families.find(candidate => candidate.id === family.id);
    if (!sourceFamily) throw new Error(`PnPInk adapter references unknown Forge family '${family.id}'`);
    const selected = familyRows(cards, family, sourceFamily), name = `${root}-${safeName(family.id)}`;
    const baseline = Object.fromEntries(selected.map(card => [card.id,
      Object.fromEntries(Object.keys(family.fields).map(path => [path, clone(dig(card, path))]))]));
    const provenance = {
      format: PNPINK_WORKING_COPY_FORMAT, version: PNPINK_WORKING_COPY_VERSION,
      game: game.id || basename(gameDir), family: family.id, engine: engine.id,
      source_hash: hash, upstream: clone(adapter.upstream), fields: clone(family.fields), baseline,
      template: { source_path: adapter.template, sha256: `sha256:${sha256(templateBytes)}` },
    };
    const csvName = `${name}.csv`, svgName = `${name}.svg`, csv = csvForFamily(family, selected, provenance);
    const packageEntries = new Map([
      ["manifest.json", jsonBytes(pnpManifest(svgName, csvName))],
      ["forge-source.json", jsonBytes(provenance)],
      [csvName, Buffer.from(csv)], [svgName, templateBytes],
    ]);
    const prefix = `families/${safeName(family.id)}`;
    entries.set(`${prefix}/${name}.pnp`, deterministicZip(packageEntries));
    entries.set(`${prefix}/${csvName}`, Buffer.from(csv));
    entries.set(`${prefix}/${svgName}`, templateBytes);
    entries.set(`${prefix}/forge-source.json`, jsonBytes(provenance));
    familyReports.push({ family: family.id, label: sourceFamily.label || family.id, cards: selected.length,
      project: `${prefix}/${name}.pnp`, csv: `${prefix}/${csvName}`, svg: `${prefix}/${svgName}` });
  }
  const manifest = {
    format: PNPINK_SUITE_FORMAT, version: PNPINK_SUITE_VERSION,
    game: { id: game.id || basename(gameDir), title: game.title || game.id || basename(gameDir) },
    source_hash: hash, upstream: clone(adapter.upstream), families: familyReports,
    round_trip: {
      data: "field-level three-way merge from returned family .pnp or CSV",
      template: "byte-level three-way merge from returned family .pnp",
      review: "Forge dry-run, validation, then direct commit or fork and pull request",
    },
    limitations: [
      "The PnPInk template is a versioned external production source; the active Forge renderer remains unchanged until explicitly promoted.",
      "Return one family .pnp at a time. Returning the suite ZIP is intentionally rejected so unrelated families cannot be changed accidentally.",
      "Generated PnPInk PDFs and images are artifacts, not canonical inputs.",
    ],
  };
  entries.set("manifest.json", jsonBytes(manifest));
  entries.set("README.md", Buffer.from(`# ${manifest.game.title} — PnPInk / Inkscape working copies

Each folder contains one portable \`.pnp\` project plus its editable SVG and CSV. Install the pinned PnPInk release shown in \`manifest.json\`, open the family project in Inkscape, and regenerate the deck there.

Return one edited family \`.pnp\` to Forge. Forge compares card fields and the SVG template with the exported baseline, shows a dry run, validates the candidate game, and creates one commit or pull request. You may return the CSV alone for data-only work; template changes require the \`.pnp\` package.

Forge remains canonical. The external SVG is a versioned production source and does not silently replace the active renderer.
`));
  return { manifest, entries };
}

function coerce(raw, before, declaredType) {
  if (raw === "" && ["integer", "number", "boolean"].includes(declaredType)) return undefined;
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

function loadReturned(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > MAX_PNPINK_BYTES) throw new Error("PnPInk working copy is larger than 32 MB");
  if (bytes.subarray(0, 2).toString() !== "PK") return { csv: bytes.toString("utf8"), svg: null, package: false };
  const entries = readZip(bytes), manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new Error("PnPInk package has no manifest.json");
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new Error("PnPInk package manifest is invalid JSON"); }
  if (manifest.format === PNPINK_SUITE_FORMAT)
    throw new Error("Return one family .pnp from the suite, not the complete PnPInk suite ZIP");
  if (manifest.format !== "pnp" || manifest.version !== 1) throw new Error("unsupported PnPInk package manifest");
  safeRel(manifest.csv, "PnPInk CSV"); safeRel(manifest.svg, "PnPInk SVG");
  const csv = entries.get(manifest.csv), svg = entries.get(manifest.svg), provenance = entries.get("forge-source.json");
  if (!csv || !svg) throw new Error("PnPInk package must contain the CSV and SVG named by manifest.json");
  return { csv: csv.toString("utf8"), svg, provenance: provenance?.toString("utf8") || null, package: true };
}

function metadataFromCsv(csv) {
  const first = parseCsv(csv).find(row => String(row[0] || "").startsWith("# FORGE_META "));
  if (!first) throw new Error("PnPInk CSV is missing its Forge working-copy baseline");
  try { return unb64(String(first[0]).slice(13).trim()); } catch { throw new Error("PnPInk CSV has invalid Forge metadata"); }
}

/** Analyze one returned PnPInk family package without writing the game tree. */
export function analyzePnpinkImport(gameDirValue, input) {
  const gameDir = resolve(gameDirValue), returned = loadReturned(input), csvMeta = metadataFromCsv(returned.csv);
  let meta = csvMeta;
  if (returned.provenance) {
    let packaged;
    try { packaged = JSON.parse(returned.provenance); } catch { throw new Error("PnPInk forge-source.json is invalid JSON"); }
    if (!equal(packaged, csvMeta)) throw new Error("PnPInk CSV metadata does not match forge-source.json");
    meta = packaged;
  }
  if (meta.format !== PNPINK_WORKING_COPY_FORMAT || meta.version !== PNPINK_WORKING_COPY_VERSION)
    throw new Error(`unsupported Forge PnPInk working copy: ${meta.format} v${meta.version}`);
  const { adapter, adapterPath, templatePath } = loadAdapter(gameDir);
  const game = yaml.load(readFileSync(gameFile(gameDir, "game.yaml"), "utf8")) || {};
  const gameId = game.id || basename(gameDir);
  if (meta.game !== gameId) throw new Error(`PnPInk working copy belongs to '${meta.game}', not '${gameId}'`);
  const family = adapter.families.find(candidate => candidate.id === meta.family);
  if (!family) throw new Error(`PnPInk working copy targets unknown family '${meta.family}'`);
  if (!equal(family.fields, meta.fields)) throw new Error("PnPInk field mapping changed; export a fresh working copy");
  const cardsPath = gameFile(gameDir, "components/cards.json", "cards"), cardsBytes = readFileSync(cardsPath);
  const cards = JSON.parse(cardsBytes.toString("utf8")), nextCards = clone(cards), byId = new Map(cards.map(card => [card.id, card]));
  const nextById = new Map(nextCards.map(card => [card.id, card]));
  const attributeTypes = new Map((game.attribute_definitions || []).map(definition => [definition.key, definition.type]));
  const targetToSource = new Map(Object.entries(family.fields).map(([source, target]) => [target, source]));
  const rows = parseCsv(returned.csv), changes = [], conflicts = [], seen = new Set();
  let headers = null;
  for (const row of rows) {
    if (String(row[0] || "").startsWith("#")) continue;
    const marker = /^\{\{t=([^}]+)}}/.exec(String(row[0] || "").trim());
    if (marker) {
      if (marker[1] !== family.bbox) throw new Error(`CSV targets '${marker[1]}', expected '${family.bbox}'`);
      headers = row.slice(1); continue;
    }
    if (!headers) continue;
    const values = {};
    headers.forEach((header, index) => {
      const source = targetToSource.get(header);
      if (source) values[source] = row[index + 1] ?? "";
    });
    const cardId = values.id;
    if (!cardId) throw new Error("PnPInk row has no stable Forge card id");
    if (seen.has(cardId)) throw new Error(`PnPInk CSV contains duplicate card '${cardId}'`);
    seen.add(cardId);
    const current = byId.get(cardId), proposedCard = nextById.get(cardId), baseline = meta.baseline?.[cardId];
    if (!current || !proposedCard || !baseline) throw new Error(`PnPInk CSV references unknown or unbaselined card '${cardId}'`);
    const fields = [];
    for (const [path, raw] of Object.entries(values)) {
      if (path === "id") continue;
      const before = baseline[path], now = dig(current, path);
      if (before === undefined && raw === "") continue;
      const declaredType = path.startsWith("attributes.") ? attributeTypes.get(path.slice("attributes.".length)) : null;
      const after = coerce(raw, before, declaredType);
      if (equal(after, before)) continue;
      if (!equal(now, before) && !equal(now, after)) {
        conflicts.push({ card_id: cardId, family: family.id, path, base: before ?? null, proposed: after ?? null, current: now ?? null });
        continue;
      }
      if (equal(now, after)) continue;
      if (after === undefined) remove(proposedCard, path); else assign(proposedCard, path, clone(after));
      fields.push({ path, before: now ?? null, after: after ?? null, ...(after === undefined ? { remove: true } : {}) });
    }
    if (fields.length) changes.push({ card_id: cardId, family: family.id, fields });
  }
  if (!headers) throw new Error("PnPInk CSV has no family marker/header row");

  const sources = currentNandeckSources(gameDir), templateBytes = readFileSync(templatePath), adapterBytes = readFileSync(adapterPath);
  const currentHash = sourceHash(cardsBytes, templateBytes, adapterBytes, sources.sourceHash), files = [], warnings = [];
  const expectedTemplateHash = String(meta.template?.sha256 || "");
  let templateChange = null;
  if (returned.svg) {
    const proposedHash = `sha256:${sha256(returned.svg)}`, currentTemplateHash = `sha256:${sha256(templateBytes)}`;
    if (proposedHash !== expectedTemplateHash && proposedHash !== currentTemplateHash) {
      templateChange = { path: meta.template?.source_path, before: expectedTemplateHash, after: proposedHash, current: currentTemplateHash };
      if (meta.template?.source_path !== adapter.template || currentTemplateHash !== expectedTemplateHash)
        conflicts.push({ family: family.id, path: "template", base: expectedTemplateHash, proposed: proposedHash, current: currentTemplateHash });
      else {
        files.push({ path: adapter.template, content: returned.svg });
        warnings.push("The returned SVG changes the versioned PnPInk production template; the active Forge renderer remains unchanged.");
      }
    }
  }
  if (changes.length && !conflicts.some(conflict => conflict.card_id))
    files.unshift({ path: "components/cards.json", content: `${JSON.stringify(nextCards, null, 2)}\n` });
  return {
    ok: conflicts.length === 0, family: family.id, source_hash: meta.source_hash || null,
    current_source_hash: currentHash, stale: meta.source_hash !== currentHash,
    changes, conflicts, files, warnings, template_change: templateChange,
    upstream: clone(meta.upstream), package: returned.package,
  };
}
