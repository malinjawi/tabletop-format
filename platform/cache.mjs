/**
 * cache.mjs — Store 3: the derived cache (DATA-ARCHITECTURE Store 3, DA-5).
 *
 * Everything here is REGENERABLE from Store 1 (git) — losing this store loses
 * nothing. Keys are content-addressed by commit sha, therefore IMMUTABLE:
 * a URL, once minted, serves the same bytes forever (infinite cache headers;
 * this is the TTS-links-never-rot property as code).
 *
 *   renders/{game}/{sha}/{printing_id}.png     card faces at an exact commit
 *   exports/{game}/{ref}/{pnp.pdf|tts.json|sheet.png|back.png}
 *                                              ref = sha (GC-able) or tag (kept forever)
 *
 * Dev driver: filesystem under data/cache/ with the EXACT R2 key layout.
 * Prod driver: same keys in the forge-cache R2 bucket behind a CDN — a
 * storage-call swap, not a key change. v0 runs generation inline in the
 * server process; the queue/worker split (DD5) is a scale move, not a
 * correctness one — generation is idempotent per key either way.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, readdirSync,
         statSync, utimesSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_DIR = process.env.CACHE_DIR ?? join(ROOT, "data", "cache");

export const renderKey = (game, sha, printing) => `renders/${game}/${sha}/${printing}.png`;
export const exportKey = (game, ref, file) => `exports/${game}/${ref}/${file}`;
const p = (key) => join(CACHE_DIR, key);
export const has = (key) => existsSync(p(key));
export const get = (key) => readFileSync(p(key));
export const pathOf = (key) => p(key);

const sh = (args, cwd = ROOT) => execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" }).trim();

/** Materialize a game dir exactly as it was at `ref`.
 *  `src` is either a repo-relative path (legacy: git archive in the platform
 *  monorepo) or a MATERIALIZER FUNCTION `(ref) => ({dir, cleanup})` provided
 *  by a Store-1 backend (store1-local / store1-forgejo) — the store decides
 *  how trees are produced; this store only derives from them. */
function materialize(src, ref) {
  if (typeof src === "function") return src(ref);
  const tmp = mkdtempSync(join(tmpdir(), "at-sha-"));
  execFileSync("bash", ["-c",
    `git archive ${ref} -- ${JSON.stringify(src)} | tar -x -C ${JSON.stringify(tmp)}`],
    { cwd: ROOT });
  return { dir: join(tmp, src), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

/** Ensure all face renders for a game at a sha exist in the cache; returns key dir. Idempotent. */
export async function ensureRenders(gameRel, gameSlug, sha) {
  const keyDir = join(CACHE_DIR, "renders", gameSlug, sha);
  if (existsSync(keyDir) && readdirSync(keyDir).length > 0) return { keyDir, hit: true };
  const { dir, cleanup } = await materialize(gameRel, sha);
  try {
    mkdirSync(keyDir, { recursive: true });
    execFileSync("python3", [join(ROOT, "tools/render_cards.py"), dir, keyDir], { stdio: "pipe" });
  } finally { cleanup(); }
  return { keyDir, hit: false };
}

/** Ensure pnp/tts exports for a game at a ref (sha or tag). Idempotent per key. */
export async function ensureExport(gameRel, gameSlug, ref, kind) {
  const outDir = join(CACHE_DIR, "exports", gameSlug, ref);
  const done = { pnp: join(outDir, "pnp.pdf"), tts: join(outDir, "tts.json") }[kind];
  if (existsSync(done)) return { dir: outDir, hit: true };
  const { dir, cleanup } = await materialize(gameRel, ref);
  try {
    mkdirSync(outDir, { recursive: true });
    execFileSync("python3", [join(ROOT, "tools/render_cards.py"), dir], { stdio: "pipe" });
    if (kind === "pnp") {
      execFileSync("python3", [join(ROOT, "tools/export_pnp.py"), dir], { stdio: "pipe" });
      const pdf = readdirSync(join(dir, "exports")).find(f => f.endsWith("-pnp.pdf"));
      cpSync(join(dir, "exports", pdf), join(outDir, "pnp.pdf"));
    } else {
      execFileSync("python3", [join(ROOT, "tools/export_tts.py"), dir], { stdio: "pipe" });
      const tts = join(dir, "exports", "tts");
      const save = readdirSync(tts).find(f => f.endsWith(".json"));
      cpSync(join(tts, save), join(outDir, "tts.json"));
      cpSync(join(tts, "sheet.png"), join(outDir, "sheet.png"));
      cpSync(join(tts, "back.png"), join(outDir, "back.png"));
    }
  } finally { cleanup(); }
  return { dir: outDir, hit: false };
}

/**
 * GC (DA-5 policy): delete cached refs older than maxAgeMs — EXCEPT refs in
 * `keep` (current heads + all release tags, which live forever).
 */
export function gc({ maxAgeMs = 30 * 24 * 3600 * 1000, keep = new Set() } = {}) {
  const removed = [];
  for (const tier of ["renders", "exports"]) {
    const tierDir = join(CACHE_DIR, tier);
    if (!existsSync(tierDir)) continue;
    for (const game of readdirSync(tierDir)) {
      for (const ref of readdirSync(join(tierDir, game))) {
        if (keep.has(ref)) continue;
        const dir = join(tierDir, game, ref);
        if (Date.now() - statSync(dir).mtimeMs > maxAgeMs) {
          rmSync(dir, { recursive: true, force: true });
          removed.push(`${tier}/${game}/${ref}`);
        }
      }
    }
  }
  return removed;
}

/** test helper: age a cached ref so GC tests don't need to wait 30 days */
export function _ageForTest(key, ageMs) {
  const t = new Date(Date.now() - ageMs);
  utimesSync(p(key), t, t);
}
