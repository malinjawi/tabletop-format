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
 *   setVisibility(slug, value)     → storage-layer visibility reconciliation
 *   writeFiles(slug, files, message, author, { expectedRef? }) → { sha }
 *                                      // atomic multi-file compare-and-commit
 *   createGame(slug, srcTree, message, author) → { sha } // import a validated tree
 *   fork(src, dest, transformYaml, message, author, ref?) → { sha }
 *   history(slug, rel, n)         → [{ full, sha, author, date, subject }]
 *   fileAt(slug, ref, rel)        → Buffer | null        // file content at a commit
 *   resolveRef(slug, ref)         → full 40-character commit sha
 *   headSha(slug)                 → full 40-character commit sha
 *   materialize(slug, ref)        → { dir, cleanup }     // exact tree at ref (Store 3 feed)
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync,
         mkdirSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { join, dirname, isAbsolute, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { uploadAsset, downloadAsset } from "../tools/lib/lfs.mjs";
import { PROJECT_META, parseProjectMeta } from "./project-ref.mjs";
import { fullStore1ObjectId, localStore1Ref } from "./store1-ref.mjs";

// A local Store-1 instance uses one physical Git repository for every game.
// Serialize every index/worktree mutation per repository root so concurrent
// requests cannot stage into one another's commit. The map is module-wide so
// two Store instances aimed at the same checkout share the same lock.
const LOCAL_MUTATION_TAILS = new Map();

function withLocalMutationLock(root, mutate) {
  const previous = LOCAL_MUTATION_TAILS.get(root) ?? Promise.resolve();
  const running = previous.catch(() => {}).then(mutate);
  const settled = running.then(() => undefined, () => undefined);
  LOCAL_MUTATION_TAILS.set(root, settled);
  settled.then(() => {
    if (LOCAL_MUTATION_TAILS.get(root) === settled) LOCAL_MUTATION_TAILS.delete(root);
  });
  return running;
}

function expectedRefConflict(slug, expectedRef, currentRef) {
  return Object.assign(
    new Error(`project '${slug}' changed from ${expectedRef} to ${currentRef}; no files were written`),
    { code: "STORE1_EXPECTED_REF_MISMATCH", status: 409, expectedRef, currentRef, written: false },
  );
}

/** @param {{root: string, gamesDir: string, lfsUrl?: string|null, includeFixtures?: boolean}} cfg */
export function createLocalStore({ root, gamesDir, lfsUrl = null, includeFixtures = false }) {
  const git = (a, opts = {}) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8", ...opts }).trimEnd();
  // Local Forge commits must work on a clean machine with no global Git
  // identity. The signed-in person remains the commit author; Forge is the
  // deterministic committer that writes the reviewed transaction.
  const commit = (args) => git(["-c", "user.name=Forge Platform",
    "-c", "user.email=noreply@forge.local", "commit", ...args]);
  const QUIET = { stdio: ["pipe", "pipe", "ignore"] };
  // Hosted projects are DIRECT children of gamesDir. Internal regression
  // fixtures under FIXTURES_DIR are deliberately invisible unless a local test
  // opts in; fixture location must never imply publication or route access.
  // `abs`/`rel` are the ONE shared path helper every method below routes through
  // (has/readFile/writeFiles/history/fileAt/materialize/...), so patching them here
  // is enough to make fixture games work everywhere, not just in list().
  const FIXTURES_DIR = "_fixtures";
  const hasGameYaml = (dir) => existsSync(join(dir, "game.yaml"));
  /** slug -> absolute directory. Direct child wins; an explicitly enabled test
   *  may fall back to _fixtures/<slug>. New projects always land at top level. */
  const abs = (slug) => {
    const top = join(gamesDir, slug);
    if (hasGameYaml(top)) return top;
    const fixture = join(gamesDir, FIXTURES_DIR, slug);
    if (includeFixtures && hasGameYaml(fixture)) return fixture;
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
      if (!includeFixtures) return top;
      const fixturesDir = join(gamesDir, FIXTURES_DIR);
      const nested = existsSync(fixturesDir)
        ? readdirSync(fixturesDir).filter(d => hasGameYaml(join(fixturesDir, d)))
        : [];
      return [...top, ...nested.filter(slug => !top.includes(slug))]; // top-level hosted game wins
    },

    isFixture(slug) {
      return includeFixtures && abs(slug).startsWith(join(gamesDir, FIXTURES_DIR) + sep);
    },
    has(slug) { return okSlug(slug) && store.list().includes(slug); },
    repositoryIdentity(slug) {
      const meta = store.readMeta(slug);
      return { repoId: meta.repoId, namespace: meta.namespace, repoSlug: meta.repoSlug };
    },
    // Hosted Store 1 can remap a mutable discovery name to a durable key and
    // quarantine a conflicting native repository. The local monorepo already
    // uses its directory name as the durable key, so these interface hooks are
    // deliberately strict/no-op equivalents.
    bindProjectKey(currentKey, stableKey) {
      if (currentKey !== stableKey)
        throw new Error("the local Store1 backend cannot rename a project during reindex");
      return stableKey;
    },
    quarantineProject(_slug) { return false; },
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
               repoSlug: project.slug, repoId: null, projectKind: project.project_kind,
               ownerNamespaceTrusted: project.metadata_valid };
    },

    // The local backend is one developer-owned checkout, so project privacy is
    // enforced by the gateway. The production Forgejo backend implements the
    // same method by reconciling the repository's native private flag.
    async setVisibility(_slug, visibility) {
      return { visibility: visibility === "public" ? "public" : "private" };
    },
    async ensurePrivate(_slug) {
      return { visibility: "private", changed: false, confirmed: true };
    },

    projectKey(namespace, repoSlug) {
      for (const key of store.list()) {
        const project = parseProjectMeta(store.readFile(key, PROJECT_META), key);
        if (project.namespace === namespace && project.slug === repoSlug) return key;
      }
      return null;
    },

    /** files: [{path, content:Buffer|string}] — one atomic commit, authored as the user.
     *  expectedRef must be the exact project head the editor opened. The check
     *  happens inside the local mutation lock and before any live-tree write. */
    async writeFiles(slug, files, message, author, { expectedRef = null } = {}) {
      return withLocalMutationLock(root, async () => {
        if (expectedRef !== null && expectedRef !== undefined) {
          const expected = fullStore1ObjectId(expectedRef, "expected project revision");
          const current = store.headSha(slug);
          if (expected !== current) throw expectedRefConflict(slug, expected, current);
        }
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
          return { sha: store.headSha(slug), unchanged: true };
        } catch (error) {
          if (error.status !== 1) throw error;
        }
        commit(["-m", message, "--author", author]);
        return { sha: fullStore1ObjectId(git(["rev-parse", "HEAD"]), "committed revision") };
      });
    },

    /** Import an already-validated tree as a new hosted game. */
    createGame(slug, srcTree, message, author) {
      cpSync(srcTree, abs(slug), { recursive: true });
      git(["add", "--", abs(slug)]);
      commit(["-m", message, "--author", author]);
      return { sha: fullStore1ObjectId(git(["rev-parse", "HEAD"]), "created project revision") };
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
        commit(["-m", message, "--author", author]);
        return { sha: fullStore1ObjectId(git(["rev-parse", "HEAD"]), "fork revision") };
      } finally { cleanup(); }
    },

    history(slug, relPath, n = 20) {
      const p = `${rel(slug)}/${relPath}`;
      const log = git(["log", `-${n}`, "--format=%H|%h|%an|%as|%s", "--", p], QUIET);
      return (log ? log.split("\n") : []).map(line => {
        const [full, sha, author, date, subject] = line.split("|");
        return { full: fullStore1ObjectId(full, `history revision for ${slug}`),
          sha, author, date, subject };
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
    resolveRef(slug, ref) {
      const safeRef = localStore1Ref(ref, slug);
      try {
        return fullStore1ObjectId(git(["rev-parse", "--verify", `${safeRef}^{commit}`], QUIET),
          `resolved revision for ${slug}`);
      } catch (cause) {
        throw Object.assign(new Error(`version '${ref}' is unavailable for ${slug}`), { status: 422, cause });
      }
    },
    headSha(slug) {
      const sha = git(["log", "-1", "--format=%H", "--", rel(slug)], QUIET)
        || git(["rev-parse", "HEAD"]);
      return fullStore1ObjectId(sha, `head revision for ${slug}`);
    },

    createReleaseTag(slug, tag, target, message, author) {
      if (!/^v[0-9][0-9A-Za-z._-]{0,31}$/.test(tag)) throw new Error("release tags must start with v and a number");
      const ref = `refs/tags/forge/${slug}/${tag}`;
      try { git(["show-ref", "--verify", "--quiet", ref], QUIET); throw new Error(`release tag '${tag}' already exists`); }
      catch (error) { if (/already exists/.test(error.message)) throw error; }
      const fullTarget = fullStore1ObjectId(git(["rev-parse", "--verify", `${target}^{commit}`]),
        `release target for ${slug}`);
      const parsed = String(author ?? "Forge <releases@forge.invalid>").match(/^(.*?)\s*<(.+)>$/);
      const name = parsed?.[1] || "Forge", email = parsed?.[2] || "releases@forge.invalid";
      git(["tag", "-a", `forge/${slug}/${tag}`, fullTarget, "-m", message],
        { env: { ...process.env, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } });
      return { tag, target: fullStore1ObjectId(git(["rev-parse", `${ref}^{commit}`]), "release target"),
        tagObject: fullStore1ObjectId(git(["rev-parse", ref]), "release tag object"),
        annotated: git(["cat-file", "-t", ref]) === "tag", protected: true };
    },

    releaseTagInfo(slug, tag) {
      const ref = `refs/tags/forge/${slug}/${tag}`;
      try { return { tag,
        target: fullStore1ObjectId(git(["rev-parse", `${ref}^{commit}`]), "release target"),
        tagObject: fullStore1ObjectId(git(["rev-parse", ref]), "release tag object"),
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
      const safeRef = store.resolveRef(slug, ref);
      const tmp = mkdtempSync(join(tmpdir(), "at-sha-")), archive = join(tmp, "source.tar");
      try {
        // Keep ref and paths as process arguments. They must never cross a
        // command-language boundary: materialize is reached by public version
        // selectors as well as trusted internal callers.
        execFileSync("git", ["-C", root, "archive", "--format=tar", `--output=${archive}`,
          safeRef, "--", rel(slug)],
          { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });
        execFileSync("tar", ["-xf", archive, "-C", tmp]);
        rmSync(archive, { force: true });
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
      } catch (error) {
        rmSync(tmp, { recursive: true, force: true });
        throw error;
      }
    },
  };
  return store;
}
