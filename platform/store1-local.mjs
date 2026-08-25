// @ts-check
/**
 * store1-local.mjs — Store 1 backend: LOCAL GIT (dev/beta driver).
 *
 * This is the extraction of every git/FS touch server.mjs used to make
 * directly. The same surface is implemented by store1-forgejo.mjs against a
 * real forge — the fork-litmus boundary (DATA-ARCHITECTURE DA-1/DA-2) as an
 * actual interface. Routes may only talk to a store; nothing above this line
 * of abstraction runs `git` or assumes games live on the local disk.
 *
 * Surface (both backends):
 *   list()                        → slugs
 *   has(slug)                     → boolean
 *   dir(slug)                     → readable CURRENT tree (python tools eat this)
 *   treeRoot()                    → parent dir containing all game trees (hub builder)
 *   version(slug)                 → change token for one game (cache invalidation)
 *   catalogVersion()              → change token across all games
 *   readFile(slug, rel)           → Buffer | null
 *   readMeta(slug)                → { title, license, cardCount } (index fodder, DA-3)
 *   writeFiles(slug, files, message, author) → { sha }   // atomic multi-file commit
 *   createGame(slug, srcTree, message, author) → { sha } // import a validated tree
 *   fork(src, dest, transformYaml, message, author, ref?) → { sha }
 *   history(slug, rel, n)         → [{ full, sha, author, date, subject }]
 *   fileAt(slug, ref, rel)        → Buffer | null        // file content at a commit
 *   headSha(slug)                 → short sha
 *   materialize(slug, ref)        → { dir, cleanup }     // exact tree at ref (Store 3 feed)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync,
         mkdirSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { uploadAsset, downloadAsset } from "../tools/lib/lfs.mjs";

/** @param {{root: string, gamesDir: string, lfsUrl?: string|null}} cfg */
export function createLocalStore({ root, gamesDir, lfsUrl = null }) {
  const git = (a, opts = {}) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8", ...opts }).trimEnd();
  const QUIET = { stdio: ["pipe", "pipe", "ignore"] };
  // Discovery scans DIRECT children of gamesDir, plus ONE nested level under
  // FIXTURES_DIR (examples/_fixtures/<slug>/game.yaml) — the ported real-game test
  // fixtures (Netrunner SG, Hearthstone, Hearts). Slugs are always the basename.
  // `abs`/`rel` are the ONE shared path helper every method below routes through
  // (has/readFile/writeFiles/history/fileAt/materialize/...), so patching them here
  // is enough to make fixture games work everywhere, not just in list().
  const FIXTURES_DIR = "_fixtures";
  const hasGameYaml = (dir) => existsSync(join(dir, "game.yaml"));
  /** slug -> absolute directory. Direct child wins; falls back to _fixtures/<slug>;
   *  falls back to the (nonexistent) direct-child path otherwise, so creating a
   *  brand-new game (createGame/fork) still lands as a normal top-level game. */
  const abs = (slug) => {
    const top = join(gamesDir, slug);
    if (hasGameYaml(top)) return top;
    const fixture = join(gamesDir, FIXTURES_DIR, slug);
    if (hasGameYaml(fixture)) return fixture;
    return top;
  };
  const rel = (slug) => abs(slug).replace(root + "/", "");
  const okSlug = (s) => /^[a-z0-9][a-z0-9-]*$/.test(s);

  const store = {
    kind: "local",

    list() {
      const top = readdirSync(gamesDir).filter(d => hasGameYaml(join(gamesDir, d)));
      const fixturesDir = join(gamesDir, FIXTURES_DIR);
      const nested = existsSync(fixturesDir)
        ? readdirSync(fixturesDir).filter(d => hasGameYaml(join(fixturesDir, d)))
        : [];
      return [...top, ...nested]; // slugs = basename either way
    },
    has(slug) { return okSlug(slug) && store.list().includes(slug); },
    dir(slug) { return store.has(slug) ? abs(slug) : null; },
    treeRoot() { return gamesDir; },

    version(slug) {
      return String(Math.max(...["game.yaml", "components/cards.json"].map(f => {
        const p = join(abs(slug), f); return existsSync(p) ? statSync(p).mtimeMs : 0; })));
    },
    catalogVersion() {
      return String(Math.max(0, ...store.list().flatMap(s =>
        ["game.yaml", "components/cards.json", "community.yaml"].map(f => {
          const p = join(abs(s), f); return existsSync(p) ? statSync(p).mtimeMs : 0; }))));
    },

    readFile(slug, relPath) {
      const p = join(abs(slug), relPath);
      return existsSync(p) ? readFileSync(p) : null;
    },
    readMeta(slug) {
      const gy = store.readFile(slug, "game.yaml")?.toString() ?? "";
      let cardCount = null;
      try { cardCount = JSON.parse(store.readFile(slug, "components/cards.json").toString()).length; } catch {}
      return { title: (gy.match(/^title:\s*"?([^"\n]+)"?/m) ?? [])[1] ?? slug,
               license: (gy.match(/^license:\s*(\S+)/m) ?? [])[1] ?? null,
               cardCount };
    },

    /** files: [{path, content:Buffer|string}] — one atomic commit, authored as the user. */
    writeFiles(slug, files, message, author) {
      for (const f of files) {
        const dest = join(abs(slug), f.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.content);
      }
      git(["add", "--", ...files.map(f => join(abs(slug), f.path))]);
      git(["commit", "-m", message, "--author", author]);
      return { sha: git(["rev-parse", "--short", "HEAD"]) };
    },

    /** Import an already-validated tree as a new hosted game. */
    createGame(slug, srcTree, message, author) {
      cpSync(srcTree, abs(slug), { recursive: true });
      git(["add", "--", abs(slug)]);
      git(["commit", "-m", message, "--author", author]);
      return { sha: git(["rev-parse", "--short", "HEAD"]) };
    },

    /** Copy-fork an exact source ref with a game.yaml transform (id rewrite +
     *  SPEC §9 attribution). Resolving HEAD before this call makes the fork
     *  immune to a source commit landing between the user's click and copy. */
    fork(src, dest, transformYaml, message, author, ref = "HEAD") {
      const { dir, cleanup } = store.materialize(src, ref);
      try {
        cpSync(dir, abs(dest), { recursive: true,
          filter: (p) => !p.includes("/exports") && !p.split("/").pop().startsWith(".") });
        const yaml = readFileSync(join(abs(dest), "game.yaml"), "utf8");
        writeFileSync(join(abs(dest), "game.yaml"), transformYaml(yaml));
        git(["add", "--", abs(dest)]);
        git(["commit", "-m", message, "--author", author]);
        return { sha: git(["rev-parse", "--short", "HEAD"]) };
      } finally { cleanup(); }
    },

    history(slug, relPath, n = 20) {
      const p = `${rel(slug)}/${relPath}`;
      const log = git(["log", `-${n}`, "--format=%H|%h|%an|%as|%s", "--", p], QUIET);
      return (log ? log.split("\n") : []).map(line => {
        const [full, sha, author, date, subject] = line.split("|");
        return { full, sha, author, date, subject };
      });
    },
    fileAt(slug, ref, relPath) {
      try { return Buffer.from(git(["show", `${ref}:${rel(slug)}/${relPath}`], QUIET)); }
      catch { return null; }
    },
    // Each game is conceptually its own repository even though the local beta
    // driver stores several game directories in one checkout. Key versions to
    // the latest commit that touched THIS game so an unrelated game's commit
    // cannot invalidate exports or make Sheet sync report false local drift.
    headSha(slug) {
      return git(["log", "-1", "--format=%h", "--", rel(slug)], QUIET)
        || git(["rev-parse", "--short", "HEAD"]);
    },

    /** SPEC §7 write path: LFS batch upload + pointer committed (or portable inline). */
    async putAsset(slug, relPath, buf, author) {
      let mode = "portable", oid = null, content = buf;
      if (lfsUrl) {
        const up = await uploadAsset(lfsUrl, relPath, buf);
        content = up.pointer; mode = "lfs"; oid = up.oid;
      }
      const { sha } = store.writeFiles(slug, [{ path: relPath, content }],
        `assets: add ${relPath}${mode === "lfs" ? " (LFS)" : ""}`, author);
      return { mode, oid, sha };
    },
    /** Read an asset, materializing LFS pointers back into bytes. */
    async getAsset(slug, relPath) {
      let buf = store.readFile(slug, relPath);
      if (!buf) return null;
      if (buf.slice(0, 60).toString().startsWith("version https://git-lfs")) {
        if (!lfsUrl) throw new Error("pointer file but no LFS endpoint configured");
        buf = await downloadAsset(lfsUrl, buf.toString());
      }
      return buf;
    },

    materialize(slug, ref) {
      const tmp = mkdtempSync(join(tmpdir(), "at-sha-"));
      execFileSync("bash", ["-c",
        `git archive ${ref === "HEAD" ? "HEAD" : ref} -- ${JSON.stringify(rel(slug))} | tar -x -C ${JSON.stringify(tmp)}`],
        { cwd: root });
      return { dir: join(tmp, rel(slug)), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
    },
  };
  return store;
}
