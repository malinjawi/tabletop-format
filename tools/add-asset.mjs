#!/usr/bin/env node
/**
 * add-asset.mjs — add an asset to a game the SPEC §7 way. ZERO dependencies.
 * Usage: node tools/add-asset.mjs <game-dir> <file> [--as assets/path.png]
 *                                 [--lfs-url URL] [--commit]
 *
 * With --lfs-url (platform mode): blob → LFS batch upload → the 3-line POINTER
 * file is written into assets/ (never the binary). With --commit, the pointer is
 * committed via the porcelain — pointer + any staged JSON in one atomic commit,
 * exactly the landmine-workaround sequence the platform will run against Forgejo.
 * Without --lfs-url (portable mode): plain file copy (small repos, SPEC amendment).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { uploadAsset } from "./lib/lfs.mjs";
import { assertAssetAllowed } from "./lib/limits.mjs";

const args = process.argv.slice(2);
const [gameDir, file] = args;
if (!file) { console.error("Usage: add-asset <game-dir> <file> [--as p] [--lfs-url URL] [--commit]"); process.exit(2); }
const opt = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : undefined; };
const rel = opt("--as") ?? join("assets", basename(file));
if (!rel.startsWith("assets/")) { console.error("assets must live under assets/ (SPEC §7)"); process.exit(2); }
const lfsUrl = opt("--lfs-url");

const buf = readFileSync(file);
assertAssetAllowed(rel, buf.length);
const dest = join(resolve(gameDir), rel);
mkdirSync(dirname(dest), { recursive: true });

if (lfsUrl) {
  const { oid, size, pointer } = await uploadAsset(lfsUrl, rel, buf);
  writeFileSync(dest, pointer);
  console.log(`LFS: uploaded ${size} bytes as ${oid.slice(0, 12)}… → pointer at ${rel}`);
  if (args.includes("--commit")) {
    execFileSync(process.execPath,
      [join(dirname(new URL(import.meta.url).pathname), "fmt-git.mjs"),
       "save", gameDir, "-m", `assets: add ${rel} (LFS)`], { stdio: "inherit" });
  }
} else {
  writeFileSync(dest, buf);
  console.log(`portable mode: copied ${buf.length} bytes → ${rel} (plain blob; LFS activates at hosting)`);
}
