#!/usr/bin/env node
/** Strict-render every declared finite source patch state at least once.
 *
 * Each pass changes every finite field on every applicable card together, so
 * this exercises field combinations as well as individual patch assets without
 * producing one expensive render process per state.
 * Usage: node tools/source-overlay-finite-stress.mjs GAME_DIR [REPORT_JSON]
 */
import {
  copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const [gameArg, reportArg] = process.argv.slice(2);
if (!gameArg) {
  console.error("Usage: node tools/source-overlay-finite-stress.mjs GAME_DIR [REPORT_JSON]");
  process.exit(2);
}
const gameDir = resolve(gameArg), scratch = mkdtempSync(join(tmpdir(), "forge-source-finite-"));
const staged = join(scratch, basename(gameDir));
const get = (value, path) => String(path || "").split(".").filter(Boolean).reduce((item, key) => item == null ? undefined : item[key], value);
const set = (value, path, replacement) => {
  const keys = String(path).split(".").filter(Boolean); let owner = value;
  for (const key of keys.slice(0, -1)) owner = owner[key] ||= {};
  owner[keys.at(-1)] = replacement;
};
const matches = (card, match) => Object.entries(match || {}).every(([path, wanted]) => {
  const choices = Array.isArray(wanted) ? wanted : [wanted], actual = get(card, path);
  return choices.some(choice => JSON.stringify(choice ?? null) === JSON.stringify(actual ?? null));
});

try {
  mkdirSync(staged, { recursive: true });
  copyFileSync(join(gameDir, "game.yaml"), join(staged, "game.yaml"));
  cpSync(join(gameDir, "components"), join(staged, "components"), { recursive: true });
  cpSync(join(gameDir, "templates"), join(staged, "templates"), { recursive: true });
  symlinkSync(join(gameDir, "assets"), join(staged, "assets"), "dir");
  const originalCards = JSON.parse(readFileSync(join(gameDir, "components", "cards.json"), "utf8"));
  const printings = JSON.parse(readFileSync(join(gameDir, "components", "printings.json"), "utf8"));
  const overlay = yaml.load(readFileSync(join(gameDir, "templates", "source-overlay.yaml"), "utf8")) || {};
  const finiteStates = region => Object.keys(region.patches || region.samples || {});
  const finite = (overlay.regions || []).filter(region => finiteStates(region).length);
  const passes = Math.max(0, ...finite.map(region => finiteStates(region).length));
  const visited = new Set(), expected = new Set();
  for (const region of finite) for (const value of finiteStates(region)) expected.add(`${region.id}\u0000${value}`);
  let renderedFaces = 0;

  for (let pass = 0; pass < passes; pass++) {
    const cards = structuredClone(originalCards);
    for (const card of cards) {
      const claimed = new Set();
      for (const region of finite.filter(item => matches(card, item.match))) {
        if (claimed.has(region.src)) continue;
        claimed.add(region.src);
        const values = finiteStates(region), value = values[pass % values.length];
        const current = get(card, region.src), numeric = Number(value);
        set(card, region.src, typeof current === "number" && Number.isFinite(numeric) ? numeric : value);
        visited.add(`${region.id}\u0000${value}`);
      }
    }
    writeFileSync(join(staged, "components", "cards.json"), JSON.stringify(cards, null, 2) + "\n");
    const rendered = join(scratch, `rendered-${pass}`);
    const result = spawnSync(process.execPath, [resolve("tools/render_cards.mjs"), staged, rendered], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FMT_SOURCE_STRICT: "1" },
    });
    if (result.status !== 0) throw new Error(`finite pass ${pass + 1}/${passes}: ${result.stderr || result.stdout || "render failed"}`);
    for (const printing of printings) {
      if (!existsSync(join(rendered, `${printing.id}.png`))) throw new Error(`finite pass ${pass + 1}: missing ${printing.id}.png`);
      renderedFaces++;
    }
    rmSync(rendered, { recursive: true, force: true });
    console.log(`Finite source pass ${pass + 1}/${passes}: ${printings.length} strict faces`);
  }
  const missing = [...expected].filter(key => !visited.has(key)).map(key => {
    const [region, value] = key.split("\u0000"); return { region, value };
  });
  const report = { cards: originalCards.length, finite_regions: finite.length, finite_states: expected.size, passes, rendered_faces: renderedFaces, missing };
  if (reportArg) writeFileSync(resolve(reportArg), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  if (missing.length) process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
