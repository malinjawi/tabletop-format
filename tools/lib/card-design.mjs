import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import yaml from "js-yaml";

export const CARD_DESIGN_MANIFEST = "templates/card-design/manifest.yaml";

const clone = value => structuredClone(value);

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readYaml(path) {
  return yaml.load(readFileSync(path, "utf8")) || {};
}

function designFile(gameDir, rel, label) {
  if (typeof rel !== "string" || !rel.startsWith("templates/card-design/") || isAbsolute(rel))
    throw new Error(`${label} must be under templates/card-design/: ${rel}`);
  const root = resolve(gameDir), path = resolve(root, rel);
  if (!inside(resolve(root, "templates/card-design"), path))
    throw new Error(`${label} escapes templates/card-design/: ${rel}`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${rel}`);
  return path;
}

function dig(value, path) {
  for (const key of String(path || "").split(".").filter(Boolean)) {
    if (value == null || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

export function cardMatchesFamily(card, match = {}) {
  return Object.entries(match).every(([path, wanted]) => {
    const choices = Array.isArray(wanted) ? wanted : [wanted];
    return choices.some(value => Object.is(dig(card, path), value));
  });
}

function fragment(gameDir, rel, label) {
  const doc = readYaml(designFile(gameDir, rel, label));
  if (!Array.isArray(doc.regions)) throw new Error(`${label} needs a regions array: ${rel}`);
  return doc;
}

function orderedRegions(regionMap, order) {
  const rank = new Map((order || []).map((id, index) => [id, index]));
  return [...regionMap.values()].sort((a, b) =>
    (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    || String(a.id).localeCompare(String(b.id)));
}

/** Load and compile a composable card-design catalog. The source fragments stay
 * first-class Git assets; compiled layouts are runtime-only values consumed by
 * the existing renderer. Later family regions override same-id components. */
export function loadCardDesign(gameDir, {
  normalizeLayout = value => value,
  manifestPath = CARD_DESIGN_MANIFEST,
} = {}) {
  if (!existsSync(resolve(gameDir, manifestPath))) return null;
  const resolvedManifestPath = designFile(gameDir, manifestPath, "card design manifest");
  const manifest = readYaml(resolvedManifestPath);
  if (manifest.version !== 1) throw new Error(`unsupported card design manifest version: ${manifest.version}`);
  if (!Array.isArray(manifest.families) || !manifest.families.length)
    throw new Error("card design manifest needs at least one family");
  const system = readYaml(designFile(gameDir, manifest.system, "design system"));
  if (!system.card || !Array.isArray(system.fonts) || !system.palette)
    throw new Error("design system needs card, fonts, and palette");
  const componentDocs = new Map();
  for (const component of manifest.components || []) {
    if (componentDocs.has(component.id)) throw new Error(`duplicate card design component: ${component.id}`);
    componentDocs.set(component.id, fragment(gameDir, component.source, `component ${component.id}`));
  }
  const familyIds = new Set();
  const families = manifest.families.map(family => {
    if (familyIds.has(family.id)) throw new Error(`duplicate card design family: ${family.id}`);
    familyIds.add(family.id);
    const regionMap = new Map();
    const componentIds = [];
    for (const component of manifest.components || []) {
      const applies = component.applies_to === "*" || component.applies_to?.includes(family.id);
      if (!applies) continue;
      componentIds.push(component.id);
      const doc = componentDocs.get(component.id);
      for (const id of doc.remove_regions || []) regionMap.delete(id);
      for (const region of doc.regions) regionMap.set(region.id, clone(region));
    }
    const familyDoc = fragment(gameDir, family.source, `family ${family.id}`);
    for (const id of familyDoc.remove_regions || []) regionMap.delete(id);
    for (const region of familyDoc.regions) regionMap.set(region.id, clone(region));
    const layout = normalizeLayout({ ...clone(system), regions: orderedRegions(regionMap, manifest.region_order) });
    return { ...clone(family), components: componentIds, region_count: layout.regions.length, layout };
  });
  return {
    version: manifest.version,
    name: manifest.name || "Card design families",
    description: manifest.description || "",
    manifest_path: manifestPath,
    system_path: manifest.system,
    legacy_source: manifest.legacy_source || null,
    components: (manifest.components || []).map(component => ({
      ...clone(component), region_count: componentDocs.get(component.id).regions.length,
    })),
    families,
    region_order: clone(manifest.region_order || []),
  };
}

export function resolveCardDesign(catalog, card) {
  if (!catalog || !card) return null;
  return catalog.families.find(family => cardMatchesFamily(card, family.match)) || null;
}
