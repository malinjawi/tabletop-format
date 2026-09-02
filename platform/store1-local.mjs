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
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync,
         mkdirSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { join, dirname, isAbsolute, relative } from "node:path";
import { tmpdir } from "node:os";
import { uploadAsset, downloadAsset } from "../tools/lib/lfs.mjs";
import { PROJECT_META, parseProjectMeta } from "./project-ref.mjs";

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
  const rel = (slug) => relative(root, abs(slug)).replaceAll("\\", "/");
  const okSlug = (s) => /^[a-z0-9][a-z0-9-]*(?:~[a-z0-9][a-z0-9-]*)?$/.test(s);
  const treeMtime = (dir) => {
    let newest = 0;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "exports") continue;
      const path = join(dir, name), stat = statSync(path);
      newest = Math.max(newest, stat.mtimeMs, stat.isDirectory() ? treeMtime(path) : 0);
    }
    return newest;
  };
  const isPointer = (content) => Buffer.from(content).slice(0, 60).toString().startsWith("version https://git-lfs");
  const localLfsObject = (pointer) => {
    const oid = String(pointer).match(/^oid sha256:([0-9a-f]{64})$/mi)?.[1];
    if (!oid) throw new Error("invalid Git LFS pointer");
    const gitPath = git(["rev-parse", "--git-path", `lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`]);
    const objectPath = isAbsolute(gitPath) ? gitPath : join(root, gitPath);
    if (!existsSync(objectPath)) throw new Error(`Git LFS object ${oid} is unavailable locally`);
    const bytes = readFileSync(objectPath);
    if (createHash("sha256").update(bytes).digest("hex") !== oid)
      throw new Error(`Git LFS object ${oid} failed its SHA-256 check`);
    return bytes;
  };
  const cacheLocalLfsObject = (oid, bytes) => {
    if (createHash("sha256").update(bytes).digest("hex") !== oid)
      throw new Error(`refusing to cache Git LFS object ${oid}: SHA-256 mismatch`);
    const gitPath = git(["rev-parse", "--git-path", `lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`]);
    const objectPath = isAbsolute(gitPath) ? gitPath : join(root, gitPath);
    mkdirSync(dirname(objectPath), { recursive: true });
    if (!existsSync(objectPath)) writeFileSync(objectPath, bytes);
  };

  const store = {
    kind: "local",

    list() {
      const top = readdirSync(gamesDir).filter(d => hasGameYaml(join(gamesDir, d)));
      const fixturesDir = join(gamesDir, FIXTURES_DIR);
      const nested = existsSync(fixturesDir)
        ? readdirSync(fixturesDir).filter(d => hasGameYaml(join(fixturesDir, d)))
        : [];
      return [...top, ...nested.filter(slug => !top.includes(slug))]; // top-level hosted game wins
    },
    has(slug) { return okSlug(slug) && store.list().includes(slug); },
    dir(slug) { return store.has(slug) ? abs(slug) : null; },
    treeRoot() { return gamesDir; },

    version(slug) {
      return String(treeMtime(abs(slug)));
    },
    catalogVersion() {
      return String(Math.max(0, ...store.list().map(s => treeMtime(abs(s)))));
    },

    readFile(slug, relPath) {
      const p = join(abs(slug), relPath);
      return existsSync(p) ? readFileSync(p) : null;
    },
    readMeta(slug) {
      const gy = store.readFile(slug, "game.yaml")?.toString() ?? "";
      const project = parseProjectMeta(store.readFile(slug, PROJECT_META), slug);
      let cardCount = null;
      try { cardCount = JSON.parse(store.readFile(slug, "components/cards.json").toString()).length; } catch {}
      return { title: (gy.match(/^title:\s*"?([^"\n]+)"?/m) ?? [])[1] ?? slug,
               license: (gy.match(/^license:\s*(\S+)/m) ?? [])[1] ?? null,
               cardCount, projectId: project.project_id, namespace: project.namespace,
               repoSlug: project.slug, repoId: null };
    },

    projectKey(namespace, repoSlug) {
      for (const key of store.list()) {
        const project = parseProjectMeta(store.readFile(key, PROJECT_META), key);
        if (project.namespace === namespace && project.slug === repoSlug) return key;
      }
      return null;
    },

    /** files: [{path, content:Buffer|string}] — one atomic commit, authored as the user. */
    async writeFiles(slug, files, message, author) {
      for (const f of files) {
        const dest = join(abs(slug), f.path);
        if (f.content === null) { rmSync(dest, { force: true }); continue; }
        let content = f.content;
        if (lfsUrl && f.path.startsWith("assets/") && !isPointer(content)) {
          const bytes = Buffer.from(content);
          const up = await uploadAsset(lfsUrl, f.path, bytes);
          cacheLocalLfsObject(up.oid, bytes);
          content = up.pointer;
        }
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
      }
      const add = ["add", "-A", "--", ...files.map(f => join(abs(slug), f.path))];
      // Portable mode must stay portable even when the developer has Git LFS
      // installed globally and this repository's .gitattributes names assets.
      // Otherwise `git add` silently creates an unresolvable pointer while no
      // LFS endpoint exists. Explicit LFS mode already uploads and stages the
      // verified pointer, so only the no-service path bypasses clean filters.
      git(lfsUrl ? add : ["-c", "filter.lfs.process=", "-c", "filter.lfs.clean=cat",
        "-c", "filter.lfs.smudge=cat", "-c", "filter.lfs.required=false", ...add]);
      try {
        git(["diff", "--cached", "--quiet", "--", ...files.map(f => join(abs(slug), f.path))], QUIET);
        return { sha: git(["rev-parse", "--short", "HEAD"]), unchanged: true };
      } catch (error) {
        if (error.status !== 1) throw error;
      }
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
    async fork(src, dest, transformYaml, message, author, ref = "HEAD", identity = null, repositoryFiles = []) {
      const { dir, cleanup } = await store.materialize(src, ref);
      try {
        cpSync(dir, abs(dest), { recursive: true,
          filter: (p) => !p.includes("/exports") && !p.split("/").pop().startsWith(".") });
        const yaml = readFileSync(join(abs(dest), "game.yaml"), "utf8");
        writeFileSync(join(abs(dest), "game.yaml"), transformYaml(yaml));
        if (identity) {
          mkdirSync(dirname(join(abs(dest), PROJECT_META)), { recursive: true });
          writeFileSync(join(abs(dest), PROJECT_META), identity);
        }
        for (const file of repositoryFiles) {
          const target = join(abs(dest), file.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, file.content);
        }
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

    createReleaseTag(slug, tag, target, message, author) {
      if (!/^v[0-9][0-9A-Za-z._-]{0,31}$/.test(tag)) throw new Error("release tags must start with v and a number");
      const ref = `refs/tags/forge/${slug}/${tag}`;
      try { git(["show-ref", "--verify", "--quiet", ref], QUIET); throw new Error(`release tag '${tag}' already exists`); }
      catch (error) { if (/already exists/.test(error.message)) throw error; }
      const fullTarget = git(["rev-parse", target]);
      const parsed = String(author ?? "Forge <releases@forge.invalid>").match(/^(.*?)\s*<(.+)>$/);
      const name = parsed?.[1] || "Forge", email = parsed?.[2] || "releases@forge.invalid";
      git(["tag", "-a", `forge/${slug}/${tag}`, fullTarget, "-m", message],
        { env: { ...process.env, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } });
      return { tag, target: git(["rev-parse", `${ref}^{}`]), tagObject: git(["rev-parse", ref]),
        annotated: git(["cat-file", "-t", ref]) === "tag", protected: true };
    },

    releaseTagInfo(slug, tag) {
      const ref = `refs/tags/forge/${slug}/${tag}`;
      try { return { tag, target: git(["rev-parse", `${ref}^{}`]), tagObject: git(["rev-parse", ref]),
        annotated: git(["cat-file", "-t", ref]) === "tag", protected: true,
        message: git(["for-each-ref", "--format=%(contents)", ref]) }; }
      catch { return null; }
    },

    /** SPEC §7 write path: LFS batch upload + pointer committed (or portable inline). */
    async putAsset(slug, relPath, buf, author, extraFiles = []) {
      let mode = "portable", oid = null, content = buf;
      if (lfsUrl) {
        const up = await uploadAsset(lfsUrl, relPath, buf);
        cacheLocalLfsObject(up.oid, buf);
        content = up.pointer; mode = "lfs"; oid = up.oid;
      }
      const { sha } = await store.writeFiles(slug, [{ path: relPath, content }, ...extraFiles],
        `assets: add ${relPath}${mode === "lfs" ? " (LFS)" : ""}`, author);
      return { mode, oid, sha };
    },
    /** Read an asset, materializing LFS pointers back into bytes. */
    async getAsset(slug, relPath) {
      let buf = store.readFile(slug, relPath);
      if (!buf) return null;
      if (buf.slice(0, 60).toString().startsWith("version https://git-lfs")) {
        buf = lfsUrl ? await downloadAsset(lfsUrl, buf.toString()) : localLfsObject(buf);
      }
      return buf;
    },

    async materialize(slug, ref, { resolveLfs = true } = {}) {
      const tmp = mkdtempSync(join(tmpdir(), "at-sha-"));
      execFileSync("bash", ["-c",
        `set -o pipefail; git archive ${ref === "HEAD" ? "HEAD" : ref} -- ${JSON.stringify(rel(slug))} | tar -x -C ${JSON.stringify(tmp)}`],
        { cwd: root, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });
      const dir = join(tmp, rel(slug));
      if (resolveLfs && existsSync(join(dir, "assets"))) {
        const walk = d => readdirSync(d).flatMap(name => {
          const path = join(d, name); return statSync(path).isDirectory() ? walk(path) : [path];
        });
        for (const path of walk(join(dir, "assets"))) {
          const bytes = readFileSync(path);
          if (isPointer(bytes)) writeFileSync(path,
            lfsUrl ? await downloadAsset(lfsUrl, bytes.toString()) : localLfsObject(bytes));
        }
      }
      return { dir, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
    },
  };
  return store;
}
