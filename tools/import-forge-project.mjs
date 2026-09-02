#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeForgeProject, writeForgeProjectChanges } from "./lib/forge-project.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2), positional = args.filter(arg => !arg.startsWith("--"));
if (!positional[0] || !positional[1]) {
  console.error("usage: import-forge-project.mjs <game-dir> <project-dir-or-zip> [--write] [--allow-delete] [--json]");
  process.exit(2);
}
const gameDir = resolve(positional[0]), bundle = resolve(positional[1]);
const allowDelete = args.includes("--allow-delete"), write = args.includes("--write");
const result = analyzeForgeProject(gameDir, bundle);
const summary = {
  ok: result.conflicts.length === 0,
  mode: write ? "write" : "dry-run",
  game: result.game,
  source_hash: result.source_hash,
  changes: result.changes,
  changed_files: result.files.map(file => ({ path: file.path, operation: file.content === null ? "delete" : "write" })),
  conflicts: result.conflicts,
};

if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
else {
  const c = result.changes.cards, p = result.changes.printings;
  console.log(`${write ? "Import" : "Dry run"}: ${result.game.title || result.game.id}`);
  console.log(`cards +${c.added.length} ~${c.changed.length} -${c.removed.length}; printings +${p.added.length} ~${p.changed.length} -${p.removed.length}; design files ${result.changes.files.length}`);
  for (const file of result.changes.files) console.log(`  ${file.kind}: ${file.path}`);
  for (const conflict of result.conflicts) console.error(`  CONFLICT ${conflict.kind}:${conflict.id}:${conflict.path}`);
}
if (result.conflicts.length) process.exit(1);
if (!write) process.exit(0);

const tempRoot = mkdtempSync(join(tmpdir(), "forge-project-import-"));
const candidate = join(tempRoot, basename(gameDir));
try {
  cpSync(gameDir, candidate, { recursive: true, filter: source => !source.split(/[\\/]/).includes("exports") });
  writeForgeProjectChanges(candidate, result, { allowDelete });
  const validation = spawnSync(process.execPath, [join(ROOT, "tools", "validate.mjs"), candidate], { encoding: "utf8" });
  if (validation.status !== 0) {
    process.stderr.write(validation.stdout || "");
    process.stderr.write(validation.stderr || "");
    console.error("Import refused: the candidate game does not validate. Nothing was written.");
    process.exitCode = 1;
  } else {
    writeForgeProjectChanges(gameDir, result, { allowDelete });
    console.log(`Applied ${result.files.length} file change(s). Review them, then commit with fmt save.`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
