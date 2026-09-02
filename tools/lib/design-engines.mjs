import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import yaml from "js-yaml";
import { CARD_DESIGN_MANIFEST, loadCardDesign } from "./card-design.mjs";

export const DESIGN_ENGINES_MANIFEST = "templates/card-design/engines.yaml";

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function engineFile(gameDir, rel, label) {
  if (typeof rel !== "string" || !rel.startsWith("templates/card-design/") || isAbsolute(rel))
    throw new Error(`${label} must be under templates/card-design/: ${rel}`);
  const designRoot = resolve(gameDir, "templates/card-design");
  const path = resolve(gameDir, rel);
  if (!inside(designRoot, path)) throw new Error(`${label} escapes templates/card-design/: ${rel}`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${rel}`);
  return path;
}

function readYaml(path) {
  return yaml.load(readFileSync(path, "utf8")) || {};
}

function publicEngine(engine) {
  return {
    id: engine.id,
    type: engine.type,
    label: engine.label,
    description: engine.description || "",
    source: engine.source,
    status: engine.status || "experimental",
    families: structuredClone(engine.families || []),
  };
}

/**
 * Resolve the renderer selected by a game's version-controlled engine registry.
 *
 * Existing games need no migration: a card-design manifest without engines.yaml
 * is exposed as an inferred forge-native engine. Non-native engines can live in
 * Git and be reviewed without affecting runtime output until explicitly selected.
 */
export function loadDesignEngines(gameDir, { normalizeLayout = value => value } = {}) {
  const registryPath = resolve(gameDir, DESIGN_ENGINES_MANIFEST);
  if (!existsSync(registryPath)) {
    const legacyPath = resolve(gameDir, CARD_DESIGN_MANIFEST);
    if (!existsSync(legacyPath)) return null;
    const cardDesign = loadCardDesign(gameDir, { normalizeLayout });
    return {
      version: 1,
      manifest_path: null,
      inferred: true,
      active: "forge-native",
      engines: [{
        id: "forge-native",
        type: "forge-native",
        label: "Forge native",
        description: "Inferred from the existing composable YAML card design.",
        source: CARD_DESIGN_MANIFEST,
        status: "active",
        families: cardDesign.families.map(family => family.id),
      }],
      card_design: cardDesign,
    };
  }

  const registry = readYaml(registryPath);
  if (registry.version !== 1) throw new Error(`unsupported design engines manifest version: ${registry.version}`);
  if (!Array.isArray(registry.engines) || !registry.engines.length)
    throw new Error("design engines manifest needs at least one engine");
  const seen = new Set();
  const engines = registry.engines.map(engine => {
    if (seen.has(engine.id)) throw new Error(`duplicate design engine: ${engine.id}`);
    seen.add(engine.id);
    engineFile(gameDir, engine.source, `design engine ${engine.id}`);
    return publicEngine(engine);
  });
  const active = engines.find(engine => engine.id === registry.active);
  if (!active) throw new Error(`active design engine does not exist: ${registry.active}`);
  if (active.type !== "forge-native")
    throw new Error(`design engine '${active.id}' is ${active.status}; only forge-native can be active today`);
  const cardDesign = loadCardDesign(gameDir, {
    normalizeLayout,
    manifestPath: active.source,
  });
  return {
    version: registry.version,
    manifest_path: DESIGN_ENGINES_MANIFEST,
    inferred: false,
    active: active.id,
    engines,
    card_design: cardDesign,
  };
}

export function designEnginesMetadata(registry) {
  if (!registry) return null;
  const { card_design: ignored, ...metadata } = registry;
  return structuredClone(metadata);
}
