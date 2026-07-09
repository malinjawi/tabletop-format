#!/usr/bin/env node
/**
 * git-diff-cards.mjs — git external diff driver for cards.json.
 * Git invokes external diff commands with 7 args:
 *   path old-file old-hex old-mode new-file new-hex new-mode
 * We hand old/new to the semantic differ so `git diff` speaks designer.
 *
 * Setup (once per clone):
 *   git config diff.cards.command "node tools/git-diff-cards.mjs"
 * (.gitattributes already maps cards.json to this driver.)
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [path, oldFile, , , newFile] = process.argv.slice(2);
console.log(`=== semantic card diff: ${path} ===`);
const devnull = process.platform === "win32" ? "NUL" : "/dev/null";
spawnSync(process.execPath,
  [join(dirname(fileURLToPath(import.meta.url)), "diff.mjs"),
   oldFile === devnull ? newFile : oldFile,   // handle add/delete edge cases
   newFile === devnull ? oldFile : newFile],
  { stdio: "inherit" });
process.exit(0); // external diff drivers must exit 0
