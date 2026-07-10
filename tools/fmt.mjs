#!/usr/bin/env node
/**
 * fmt — unified CLI for the open game format (v0.1).
 * One entry point; subcommands map to the reference tools.
 *
 *   fmt validate <game-dir>                      schema + referential integrity
 *   fmt import csv <file.csv> <out-dir> [--title T]
 *   fmt import nrdb <nrdb-dir> <out-dir> [--title T]
 *   fmt diff <old-cards.json> <new-cards.json>   semantic card diff
 *   fmt render <game-dir>                        card faces @300dpi
 *   fmt export pnp <game-dir>                    print-and-play PDF
 *   fmt export tts <game-dir>                    TTS sprite sheet + save JSON
 *   fmt check-licenses <game-dir>                license/provenance publishing gate
 *
 * v0.1 note: render/export/check-licenses dispatch to the Python reference
 * implementations (python3 + Pillow + PyYAML). The canonical TS renderer
 * (headless Chromium, Block D) replaces them without changing this interface.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0], sub = argv[1];

const runNode = (script, args) =>
  spawnSync(process.execPath, [join(TOOLS, script), ...args], { stdio: "inherit" }).status ?? 1;
const runPy = (script, args) =>
  spawnSync("python3", [join(TOOLS, script), ...args], { stdio: "inherit" }).status ?? 1;

let status;
if (cmd === "validate") status = runNodeOrPy("validate.mjs", "validate.py", argv.slice(1));
else if (cmd === "import" && sub === "csv") status = runNode("import-csv.mjs", argv.slice(2));
else if (cmd === "import" && sub === "nrdb") status = runNode("import-nrdb.mjs", argv.slice(2));
else if (cmd === "diff") status = runNode("diff.mjs", argv.slice(1));
else if (cmd === "render") status = runPy("render_cards.py", argv.slice(1));
else if (cmd === "export" && sub === "pnp") status = runPy("export_pnp.py", argv.slice(2));
else if (cmd === "export" && sub === "tts") status = runPy("export_tts.py", argv.slice(2));
else if (cmd === "check-licenses") status = runPy("check_licenses.py", argv.slice(1));
else if (cmd === "stats") status = runPy("stats.py", argv.slice(1));
else if (cmd === "credits") status = runPy("credits.py", argv.slice(1));
else if (cmd === "import" && sub === "decklist") status = runNode("import-decklist.mjs", argv.slice(2));
else if (cmd === "check-deck") status = runPy("check_deck.py", argv.slice(1));
else if (["save", "history", "changelog", "fork", "release", "setup"].includes(cmd))
  status = runNode("fmt-git.mjs", argv);
else {
  console.log(`fmt — open game format CLI (v0.1)

  fmt validate <game-dir>
  fmt import csv <file.csv> <out-dir> [--title T]
  fmt import nrdb <nrdb-dir> <out-dir> [--title T]
  fmt diff <old-cards.json> <new-cards.json>
  fmt render <game-dir>
  fmt export pnp <game-dir>
  fmt export tts <game-dir>
  fmt check-licenses <game-dir>
  fmt import decklist <game-dir> <list.txt> [--name N] [--format F]
  fmt check-deck <game-dir> <deck.json> [--format F]
  fmt stats <game-dir> [--json]   cost curve, flagged cards, decision trail
  fmt credits <game-dir>          CREDITS.md from community.yaml + git + playtests

  git porcelain (your game is a repo):
  fmt save <game-dir> [-m msg]    commit — message auto-written from card changes
  fmt history <game-dir> [-n N]   log rendered as card changes
  fmt changelog <game-dir>        CHANGELOG.md from git history
  fmt fork <src.git> <dst.git>    server-side fork (Remix primitive)
  fmt release <game-dir> <x.y.z>  tag with card changes since last release
  fmt setup [dir]                 enable semantic git diff in this clone`);
  status = cmd ? 2 : 0;
}
process.exit(status);

// validate: prefer the Node implementation (ajv); fall back to the Python twin
// if node_modules is absent, so the CLI works in a bare checkout.
function runNodeOrPy(nodeScript, pyScript, args) {
  const probe = spawnSync(process.execPath, ["-e", "import('ajv').then(()=>process.exit(0),()=>process.exit(1))"],
    { cwd: TOOLS, stdio: "ignore" });
  return probe.status === 0 ? runNode(nodeScript, args) : runPy(pyScript, args);
}
