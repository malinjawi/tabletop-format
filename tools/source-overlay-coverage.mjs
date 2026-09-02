#!/usr/bin/env node
/** Audit source-backed production coverage against the current game data.
 * Usage: node tools/source-overlay-coverage.mjs GAME_DIR [OUTPUT_JSON]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

const [gameArg, outputArg] = process.argv.slice(2);
if (!gameArg) { console.error("Usage: node tools/source-overlay-coverage.mjs GAME_DIR [OUTPUT_JSON]"); process.exit(2); }
const gameDir = resolve(gameArg);
const cards = JSON.parse(readFileSync(join(gameDir, "components", "cards.json"), "utf8"));
const printings = JSON.parse(readFileSync(join(gameDir, "components", "printings.json"), "utf8"));
const overlay = yaml.load(readFileSync(join(gameDir, "templates", "source-overlay.yaml"), "utf8"));
const printingByCard = new Map(printings.map(printing => [printing.card_id, printing]));
const get = (object, path) => String(path ?? "").split(".").filter(Boolean)
  .reduce((value, key) => value == null ? undefined : value[key], object);
const del = (object, path) => {
  const keys = String(path ?? "").split(".").filter(Boolean); let parent = object;
  for (let i = 0; i < keys.length - 1; i++) parent = parent?.[keys[i]];
  if (parent && keys.length) delete parent[keys.at(-1)];
};
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => {
  const text = JSON.stringify(stable(value)); let valueHash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    valueHash ^= text.charCodeAt(index); valueHash = Math.imul(valueHash, 0x01000193) >>> 0;
  }
  return `fnv1a:${valueHash.toString(16).padStart(8, "0")}`;
};
const matches = (card, match) => Object.entries(match ?? {}).every(([path, wanted]) => {
  const choices = Array.isArray(wanted) ? wanted : [wanted], actual = get(card, path);
  return choices.some(choice => JSON.stringify(choice ?? null) === JSON.stringify(actual ?? null));
});
const regionKey = region => (region.source ?? "card") === "printing" ? `printing.${region.src}` : region.src;
const cardSignature = (card, regions) => {
  const copy = structuredClone(card);
  for (const path of overlay.nonvisual_card_fields ?? []) del(copy, path);
  for (const region of regions) if ((region.source ?? "card") === "card") del(copy, region.src);
  return hash(copy);
};
const printingSignature = (printing, regions) => {
  const copy = {
    set_id: printing?.set_id ?? null, collector_number: printing?.collector_number ?? null,
    artist: printing?.artist ?? null, flavor_text: printing?.flavor_text ?? null,
    variant: printing?.variant ?? null,
  };
  for (const region of regions) if ((region.source ?? "card") === "printing") del(copy, region.src);
  return hash(copy);
};

const rows = cards.map(card => {
  const printing = printingByCard.get(card.id) ?? {}, baseline = overlay.baselines?.[card.id];
  const regions = (overlay.regions ?? []).filter(region => matches(card, region.match));
  const cardMismatch = !baseline || cardSignature(card, regions) !== baseline.signature;
  const printingMismatch = !baseline || printingSignature(printing, regions) !== baseline.printing_signature;
  const changes = regions.filter(region => {
    const owner = (region.source ?? "card") === "printing" ? printing : card;
    return JSON.stringify(get(owner, region.src) ?? null) !== JSON.stringify(baseline?.values?.[regionKey(region)] ?? null);
  });
  const unavailable = changes.filter(region => !region.render &&
    !region.patches?.[String(get((region.source ?? "card") === "printing" ? printing : card, region.src))] &&
    !region.samples?.[String(get((region.source ?? "card") === "printing" ? printing : card, region.src))]);
  const state = cardMismatch || printingMismatch || unavailable.length ? "fallback" : changes.length ? "overlay" : "exact";
  const mutated = { ...structuredClone(card), type: `${card.type}_changed` };
  const mutatedRegions = (overlay.regions ?? []).filter(region => matches(mutated, region.match));
  const structuralGuard = cardSignature(mutated, mutatedRegions) !== baseline?.signature;
  return {
    card_id: card.id, type: card.type, state,
    mapped_fields: [...new Set(regions.map(regionKey))],
    changed_fields: changes.map(regionKey),
    reasons: [cardMismatch && "unmapped card data differs from source", printingMismatch && "unmapped printing data differs from source", unavailable.length && "finite patch value unavailable"].filter(Boolean),
    structural_guard: structuralGuard,
  };
});
const types = [...new Set(cards.map(card => card.type))].sort().map(type => {
  const typed = rows.filter(row => row.type === type);
  return {
    type, cards: typed.length, profiled_cards: typed.filter(row => row.mapped_fields.length).length,
    exact: typed.filter(row => row.state === "exact").length,
    overlay: typed.filter(row => row.state === "overlay").length,
    fallback: typed.filter(row => row.state === "fallback").length,
    representative: typed.find(row => row.mapped_fields.length)?.card_id ?? null,
    mapped_fields: [...new Set(typed.flatMap(row => row.mapped_fields))].sort(),
  };
});
const report = {
  schema_version: 1, source_ref: overlay.source_ref ?? null,
  summary: {
    cards: rows.length, exact: rows.filter(row => row.state === "exact").length,
    overlay: rows.filter(row => row.state === "overlay").length,
    fallback: rows.filter(row => row.state === "fallback").length,
    structural_guards: rows.filter(row => row.structural_guard).length,
    structural_types_profiled: types.filter(type => type.representative).length,
    structural_types_total: types.length,
  },
  types, cards: rows,
};
const output = JSON.stringify(report, null, 2) + "\n";
if (outputArg) { writeFileSync(resolve(outputArg), output); console.log(`Wrote source overlay coverage -> ${resolve(outputArg)}`); }
console.log(JSON.stringify(report.summary));
for (const type of types) console.log(`${type.type.padEnd(10)} ${type.exact} exact / ${type.overlay} overlay / ${type.fallback} fallback · ${type.representative ?? "no profile"}`);
if (report.summary.structural_types_profiled !== report.summary.structural_types_total || report.summary.structural_guards !== rows.length) process.exitCode = 1;
