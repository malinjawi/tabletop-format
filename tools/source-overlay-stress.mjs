#!/usr/bin/env node
/** Render a multi-card source-overlay stress matrix from declarative edits.
 *
 * Usage: node tools/source-overlay-stress.mjs GAME_DIR CASES_JSON OUT_DIR
 */
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const [gameArg, casesArg, outArg] = process.argv.slice(2);
if (!gameArg || !casesArg || !outArg) {
  console.error("Usage: node tools/source-overlay-stress.mjs GAME_DIR CASES_JSON OUT_DIR");
  process.exit(2);
}
const gameDir = resolve(gameArg), casesPath = resolve(casesArg), outDir = resolve(outArg);
const scratch = mkdtempSync(join(tmpdir(), "forge-source-stress-"));
const staged = join(scratch, basename(gameDir));

const merge = (target, patch) => {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = merge({ ...(target[key] ?? {}) }, value);
    } else target[key] = value;
  }
  return target;
};

try {
  mkdirSync(staged, { recursive: true });
  copyFileSync(join(gameDir, "game.yaml"), join(staged, "game.yaml"));
  cpSync(join(gameDir, "components"), join(staged, "components"), { recursive: true });
  cpSync(join(gameDir, "templates"), join(staged, "templates"), { recursive: true });
  symlinkSync(join(gameDir, "assets"), join(staged, "assets"), "dir");

  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  const cardsPath = join(staged, "components", "cards.json");
  const printingsPath = join(staged, "components", "printings.json");
  const cards = JSON.parse(readFileSync(cardsPath, "utf8"));
  const printings = JSON.parse(readFileSync(printingsPath, "utf8"));
  for (const test of cases) {
    const card = cards.find(item => item.id === test.card_id);
    const printing = printings.find(item => item.card_id === test.card_id);
    if (!card || !printing) throw new Error(`stress case card '${test.card_id}' is missing`);
    merge(card, test.card);
    merge(printing, test.printing);
  }
  writeFileSync(cardsPath, JSON.stringify(cards, null, 2) + "\n");
  writeFileSync(printingsPath, JSON.stringify(printings, null, 2) + "\n");

  const rendered = join(scratch, "rendered");
  const result = spawnSync(process.execPath, [
    resolve("tools/render_cards.mjs"), staged, rendered,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FMT_SOURCE_STRICT: "1" } });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "render failed");

  mkdirSync(outDir, { recursive: true });
  const report = [];
  for (const test of cases) {
    const printing = printings.find(item => item.card_id === test.card_id);
    const file = `${printing.id}.png`;
    const source = join(rendered, file), destination = join(outDir, file);
    if (!existsSync(source)) throw new Error(`renderer did not produce ${file}`);
    copyFileSync(source, destination);
    report.push({ card_id: test.card_id, printing_id: printing.id, output: file });
  }
  writeFileSync(join(outDir, "stress-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Rendered ${report.length} modified structural profiles -> ${outDir}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
