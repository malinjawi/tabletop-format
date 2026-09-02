#!/usr/bin/env node
/**
 * new-game.mjs — scaffold an idea-first Forge project with no card assumption.
 *
 * Usage:
 *   node tools/new-game.mjs <output-dir> --title "Game" --license proprietary \
 *     --brief design-brief.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const outDir = args[0];
const arg = (name, fallback = "") => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : fallback;
};
if (!outDir) {
  console.error("Usage: node tools/new-game.mjs <output-dir> --title T --license L --brief FILE");
  process.exit(2);
}

const title = arg("--title", basename(outDir)).trim();
const license = arg("--license", "proprietary").trim();
const briefPath = arg("--brief");
if (!title) throw new Error("title is required");
if (!briefPath) throw new Error("--brief is required");
const brief = JSON.parse(readFileSync(briefPath, "utf8"));
const kebab = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

for (const d of ["components", "sets", "formats", "restrictions", "rulings", "rules", "design", "assets", "templates"])
  mkdirSync(join(outDir, d), { recursive: true });

const yamlString = (value) => JSON.stringify(String(value));
const description = brief.spark.length > 240 ? `${brief.spark.slice(0, 237)}...` : brief.spark;
const gameYaml = [
  `format_version: "0.1.0"`,
  `id: ${kebab(title)}`,
  `title: ${yamlString(title)}`,
  `description: ${yamlString(description)}`,
  `version: "0.1.0"`,
  `license: ${yamlString(license)}`,
  `default_provenance:`,
  `  source: human`,
].join("\n") + "\n";

writeFileSync(join(outDir, "game.yaml"), gameYaml);
writeFileSync(join(outDir, "design", "brief.json"), JSON.stringify(brief, null, 2) + "\n");
writeFileSync(join(outDir, "components", "cards.json"), "[]\n");
writeFileSync(join(outDir, "components", "printings.json"), "[]\n");
writeFileSync(join(outDir, "sets", "sets.yaml"), "[]\n");
writeFileSync(join(outDir, "rulings", "rulings.json"), "[]\n");

const intent = brief.design_intent || {};
const mvp = brief.mvp || {};
writeFileSync(join(outDir, "rules", "rules.md"), `# ${title}\n\n` +
  `_This is an early playable draft. Keep only the rules needed to test the MVP._\n\n` +
  `## Intended experience\n\n${intent.player_experience || "_Describe how players should feel._"}\n\n` +
  `## First playable slice\n\n${mvp.playable_slice || "_Describe the smallest test._"}\n\n` +
  `## Rules\n\n1. Add only enough setup and procedure to run the first test.\n` +
  `2. Put it on a table quickly.\n` +
  `3. Record what happened; revise after the test.\n`);

console.log(`Created idea-first game '${title}' → ${outDir}`);
