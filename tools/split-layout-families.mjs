#!/usr/bin/env node
/**
 * Convert a monolithic templates/layout.yaml into composable, Git-reviewable
 * card-design sources without changing its rendered output.
 *
 * Usage: node tools/split-layout-families.mjs <game-directory>
 *
 * layout.yaml is retained as a documented legacy snapshot. The runtime prefers
 * templates/card-design/manifest.yaml once it exists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import yaml from "js-yaml";

const gameDir = resolve(process.argv[2] || "");
if (!process.argv[2] || !existsSync(join(gameDir, "game.yaml"))) {
  console.error("Usage: node tools/split-layout-families.mjs <game-directory>");
  process.exit(2);
}
const layoutPath = join(gameDir, "templates", "layout.yaml");
if (!existsSync(layoutPath)) throw new Error(`${basename(gameDir)} has no templates/layout.yaml`);

const load = path => yaml.load(readFileSync(path, "utf8")) || {};
const dump = value => yaml.dump(value, {
  noRefs: true, lineWidth: 240, sortKeys: false, quotingType: '"', forceQuotes: false,
});
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const title = value => String(value).split(/[-_]/).map(part => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ");

const game = load(join(gameDir, "game.yaml"));
const cards = JSON.parse(readFileSync(join(gameDir, "components", "cards.json"), "utf8"));
const layout = load(layoutPath);
const types = [...new Set(cards.map(card => card.type).filter(Boolean))].sort();
const sidesByType = new Map(types.map(type => [type, [...new Set(cards.filter(card => card.type === type)
  .map(card => card.attributes?.side).filter(Boolean))].sort()]));

const families = [];
for (const type of types) {
  const sides = sidesByType.get(type);
  if (sides.length > 1) {
    for (const side of sides) families.push({
      id: `${side}-${type}`, label: `${title(side)} ${title(type)}`,
      match: { type, "attributes.side": side }, type, side,
    });
  } else families.push({ id: slug(type), label: title(type), match: { type }, type, side: sides[0] || null });
}

function dig(card, path) {
  let value = card;
  for (const key of String(path).replace(/^card\./, "").split("."))
    value = value && typeof value === "object" ? value[key] : undefined;
  return value;
}
function condition(card, source) {
  if (!source) return true;
  const text = String(source).trim();
  const ors = text.split(/\s*\|\|\s*/); if (ors.length > 1) return ors.some(part => condition(card, part));
  const ands = text.split(/\s*&&\s*/); if (ands.length > 1) return ands.every(part => condition(card, part));
  const comparison = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(text);
  if (comparison) {
    const actual = String(dig(card, comparison[1].trim()) ?? "");
    const wanted = comparison[3].trim().replace(/^['"]|['"]$/g, "");
    return (actual === wanted) === (comparison[2] === "==");
  }
  const negated = text.startsWith("!"), path = negated ? text.slice(1).trim() : text;
  const value = dig(card, path), truthy = !(value == null || value === "" || value === false || (Array.isArray(value) && !value.length));
  return negated ? !truthy : truthy;
}
function archetypes(family, conditionText) {
  const keys = [...String(conditionText || "").matchAll(/(?:card\.)?attributes\.([a-z0-9_]+)/gi)].map(match => match[1]);
  const full = Object.fromEntries(keys.map(key => [key, "__present__"]));
  if (family.side) full.side = family.side;
  const equalityCases = [...String(conditionText || "").matchAll(/(?:card\.)?attributes\.([a-z0-9_]+)\s*==\s*["']?([a-z0-9_-]+)["']?/gi)]
    .map(match => ({ type: family.type, attributes: { ...full, [match[1]]: match[2], ...(family.side ? { side: family.side } : {}) } }));
  return [
    { type: family.type, attributes: { ...full, unique: true } },
    { type: family.type, attributes: { ...full, unique: false } },
    { type: family.type, attributes: family.side ? { side: family.side } : {} },
    ...equalityCases,
  ];
}
function regionFamilies(region) {
  const matched = families.filter(family => archetypes(family, region.show_if).some(card => condition(card, region.show_if)))
    .map(family => family.id).sort();
  return matched.length ? matched : families.map(family => family.id).sort();
}

const groups = new Map();
for (const region of layout.regions || []) {
  const ids = regionFamilies(region);
  const key = ids.join("|");
  if (!groups.has(key)) groups.set(key, { familyIds: ids, regions: [] });
  groups.get(key).regions.push(region);
}

const outDir = join(gameDir, "templates", "card-design");
mkdirSync(join(outDir, "components"), { recursive: true });
mkdirSync(join(outDir, "families"), { recursive: true });

const components = [];
const exclusive = new Map(families.map(family => [family.id, []]));
let sharedIndex = 0;
for (const group of groups.values()) {
  if (group.familyIds.length === 1) {
    exclusive.get(group.familyIds[0]).push(...group.regions);
    continue;
  }
  const all = group.familyIds.length === families.length;
  const id = all ? "foundation" : `shared-${++sharedIndex}`;
  const label = all ? "Shared foundation" : `Shared by ${group.familyIds.map(title).join(", ")}`;
  const source = `templates/card-design/components/${id}.yaml`;
  components.push({ id, label, description: `${group.regions.length} ordered region${group.regions.length === 1 ? "" : "s"} reused by ${all ? "every card family" : group.familyIds.join(", ")}.`, source, applies_to: all ? "*" : group.familyIds });
  writeFileSync(join(gameDir, source), dump({ name: label, description: components.at(-1).description, regions: group.regions }));
}

const manifestFamilies = families.map(family => {
  const familyCards = cards.filter(card => Object.entries(family.match).every(([path, wanted]) => {
    const actual = path.split(".").reduce((value, key) => value?.[key], card);
    return actual === wanted;
  }));
  const specimens = [...familyCards].sort((a, b) => String(b.text || "").length - String(a.text || "").length)
    .slice(0, 3).map(card => card.id);
  const source = `templates/card-design/families/${family.id}.yaml`;
  const description = `Production layout specific to ${family.label.toLowerCase()} cards. Shared frame and typography live in reusable components.`;
  writeFileSync(join(gameDir, source), dump({ name: `${family.label} template`, description, regions: exclusive.get(family.id) }));
  return { id: family.id, label: family.label, description, match: family.match, source, specimens };
});

const system = { card: layout.card, fonts: layout.fonts || [], ...(layout.palette ? { palette: layout.palette } : {}),
  ...(layout.text_styles ? { text_styles: layout.text_styles } : {}), ...(layout.back ? { back: layout.back } : {}) };
writeFileSync(join(outDir, "system.yaml"), dump(system));
const manifest = {
  version: 1,
  name: `${game.title || basename(gameDir)} card design system`,
  description: "Each card resolves to one family template plus shared components. Every source is independently reviewable in Git; releases pin the complete manifest at one commit.",
  system: "templates/card-design/system.yaml",
  legacy_source: "templates/layout.yaml",
  components,
  families: manifestFamilies,
  region_order: (layout.regions || []).map(region => region.id),
};
writeFileSync(join(outDir, "manifest.yaml"), dump(manifest));
writeFileSync(join(outDir, "README.md"), `# ${game.title || basename(gameDir)} card design\n\n` +
`This directory is the editable production source for the game's cards. Forge resolves each card through \`manifest.yaml\`:\n\n` +
`1. \`system.yaml\` supplies physical dimensions, fonts, and palette tokens.\n` +
`2. \`components/\` supplies reusable frame regions shared across families.\n` +
`3. \`families/\` supplies the regions unique to one card family.\n` +
`4. \`region_order\` preserves deterministic paint order across the composed files.\n\n` +
`The original \`../layout.yaml\` remains as a migration snapshot. Once this manifest exists, Forge renders the composed family sources.\n`);

console.log(`Created ${manifestFamilies.length} card families and ${components.length} shared components in ${outDir}`);
