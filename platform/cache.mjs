/**
 * cache.mjs — Store 3: the derived cache (DATA-ARCHITECTURE Store 3, DA-5).
 *
 * Everything here is REGENERABLE from Store 1 (git) — losing this store loses
 * nothing. Keys are content-addressed by commit sha, so an exact URL keeps the
 * same byte identity. The gateway still requires shared-cache revalidation:
 * repository visibility can change until Forge defines an explicit,
 * irrevocable-publication policy.
 *
 *   renders/{game}/{sha}/{printing_id}.png     card faces at an exact commit
 *   exports/{game}/{ref}/{pnp.pdf|tts.json|table.json|table.vtt|...}
 *                                              ref = sha (GC-able) or tag (kept forever)
 *
 * Dev driver: filesystem under data/cache/ with the EXACT R2 key layout.
 * Prod driver: same keys in the forge-cache R2 bucket behind a CDN — a
 * storage-call swap, not a key change. v0 runs generation inline in the
 * server process; the queue/worker split (DD5) is a scale move, not a
 * correctness one — generation is idempotent per key either way.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, readdirSync,
         statSync, utimesSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { COMPONENT_EXPORT_VERSION } from "../tools/lib/component-design.mjs";
import { PRINT_EXPORT_VERSION, printArtifactName, isPrintArtifact } from "../tools/lib/print-artifact.mjs";
export { printArtifactName, isPrintArtifact };
const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENV_PYTHON = process.platform === "win32" ? join(ROOT, ".venv", "Scripts", "python.exe") : join(ROOT, ".venv", "bin", "python");
const PYTHON = process.env.FORGE_PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
export const CACHE_DIR = process.env.CACHE_DIR ?? join(ROOT, "data", "cache");
export const VTT_EXPORT_VERSION = 3;
export const vttArtifactName = (ext) => `table-v${VTT_EXPORT_VERSION}.${ext}`;
export const TTPG_EXPORT_VERSION = 1;
export const ttpgArtifactName = gameSlug => `${gameSlug}-ttpg-v${TTPG_EXPORT_VERSION}.zip`;
// Artifact filenames are part of the immutable cache identity. Bump when an
// exporter gains new required contents; never overwrite bytes at an old URL.
export const PROJECT_EXPORT_VERSION = 7;
export const projectArtifactName = gameSlug => `${gameSlug}-v${PROJECT_EXPORT_VERSION}.forge-project.zip`;
export const DATA_EXPORT_VERSION = 3;
export const dataArtifactName = gameSlug => `${gameSlug}-data-v${DATA_EXPORT_VERSION}.forge-project.zip`;
export const dataWorkbookArtifactName = gameSlug => `${gameSlug}-data-v${DATA_EXPORT_VERSION}.xlsx`;
export const NANDECK_EXPORT_VERSION = 1;
export const nandeckArtifactName = gameSlug => `${gameSlug}-nandeck-v${NANDECK_EXPORT_VERSION}.zip`;
export const SVG_DESIGN_EXPORT_VERSION = 1;
export const svgDesignArtifactName = gameSlug => `${gameSlug}-svg-design-v${SVG_DESIGN_EXPORT_VERSION}.zip`;
export const PNPINK_EXPORT_VERSION = 1;
export const pnpinkArtifactName = gameSlug => `${gameSlug}-pnpink-v${PNPINK_EXPORT_VERSION}.zip`;
export const SQUIB_EXPORT_VERSION = 1;
export const squibArtifactName = gameSlug => `${gameSlug}-squib-v${SQUIB_EXPORT_VERSION}.zip`;
export { COMPONENT_EXPORT_VERSION };
export const componentArtifactName = gameSlug => `${gameSlug}-components-v${COMPONENT_EXPORT_VERSION}.zip`;
export const EXPORTER_VERSIONS = { pnp: 2, print: PRINT_EXPORT_VERSION, tts: 4, ttc: 1, ttpg: TTPG_EXPORT_VERSION, vtt: VTT_EXPORT_VERSION,
  project: PROJECT_EXPORT_VERSION, data: DATA_EXPORT_VERSION, nandeck: NANDECK_EXPORT_VERSION, svg: SVG_DESIGN_EXPORT_VERSION,
  pnpink: PNPINK_EXPORT_VERSION, squib: SQUIB_EXPORT_VERSION, components: COMPONENT_EXPORT_VERSION,
  rulebook: 1, publication: 1 };
export const exporterVersion = kind => EXPORTER_VERSIONS[kind] ?? 1;

export const renderKey = (game, sha, printing) => `renders/${game}/${sha}/${printing}.png`;
export const exportKey = (game, ref, file) => `exports/${game}/${ref}/${file}`;
export const RENDER_CACHE_VERSION = 1;
export const RENDER_COMPLETION_FILE = `.complete-renders-v${RENDER_CACHE_VERSION}.json`;
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

const safeCacheRelativePath = name => typeof name === "string" && name.length > 0
  && !name.startsWith("/") && name.split("/").every(segment => segment && segment !== "."
    && segment !== ".." && !segment.startsWith(".") && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment));
const fileReceipt = (root, item) => ({ name: item.name, bytes: item.stat.size,
  sha256: createHash("sha256").update(readFileSync(item.file)).digest("hex") });
const walkFiles = (root, dir = root) => readdirSync(dir).flatMap(name => {
  const file = join(dir, name), stat = statSync(file);
  return stat.isDirectory() ? walkFiles(root, file) : [{ file, name: relative(root, file).replaceAll("\\", "/"), stat }];
});
function validRenderManifest(keyDir, gameSlug, sha) {
  const marker = join(keyDir, RENDER_COMPLETION_FILE);
  if (!existsSync(marker)) return null;
  let manifest;
  try { manifest = JSON.parse(readFileSync(marker, "utf8")); } catch { return null; }
  if (manifest?.format !== "forge-render-cache" || manifest.version !== RENDER_CACHE_VERSION
    || manifest.slug !== gameSlug || manifest.ref !== sha || !Array.isArray(manifest.files)
    || manifest.files.length === 0) return null;
  const names = new Set();
  for (const expected of manifest.files) {
    if (!safeCacheRelativePath(expected?.name) || names.has(expected.name)
      || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0
      || !/^[0-9a-f]{64}$/i.test(expected.sha256 || "")) return null;
    names.add(expected.name);
    const file = join(keyDir, expected.name);
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const actual = fileReceipt(keyDir, { file, name: expected.name, stat: statSync(file) });
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) return null;
  }
  const actualNames = walkFiles(keyDir).map(item => item.name)
    .filter(name => name !== RENDER_COMPLETION_FILE);
  if (actualNames.some(name => !names.has(name)) || actualNames.length !== names.size) return null;
  return manifest;
}

/** Build a release receipt from the exact successful export manifests selected
 * for that release. Files merely present in the shared cache directory are not
 * publication authority and are intentionally ignored. */
export function releaseArtifactReceipts(outDir, outputs, gameSlug, ref) {
  const receipts = new Map();
  for (const output of outputs) {
    const manifest = output?.manifest;
    const version = Number(manifest?.exporter_version);
    const inputHash = createHash("sha256")
      .update(`${gameSlug}\0${ref}\0${manifest?.kind}\0${version}`).digest("hex");
    if (output?.ok !== true || output.ref !== ref || manifest?.format !== "forge-export-attempt"
      || manifest.version !== 1 || manifest.slug !== gameSlug || manifest.ref !== ref
      || !Number.isSafeInteger(version) || version !== exporterVersion(manifest.kind)
      || manifest.input_hash !== inputHash || !Array.isArray(manifest.files))
      throw new Error("release export returned invalid artifact evidence");
    const names = new Set();
    for (const expected of manifest.files) {
      if (!safeCacheRelativePath(expected?.name) || names.has(expected.name)
        || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0
        || !/^[0-9a-f]{64}$/i.test(expected.sha256 || ""))
        throw new Error("release export returned an invalid artifact receipt");
      names.add(expected.name);
      const file = join(outDir, expected.name);
      if (!existsSync(file) || !statSync(file).isFile())
        throw new Error(`release artifact is missing: ${expected.name}`);
      const actual = fileReceipt(outDir, { file, name: expected.name, stat: statSync(file) });
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
        throw new Error(`release artifact does not match its export receipt: ${expected.name}`);
      const prior = receipts.get(expected.name);
      if (prior && (prior.bytes !== expected.bytes || prior.sha256 !== expected.sha256))
        throw new Error(`release exporters disagree about artifact bytes: ${expected.name}`);
      receipts.set(expected.name, { status: "ready", name: expected.name,
        bytes: expected.bytes, sha256: expected.sha256 });
    }
  }
  return [...receipts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const renderInflight = new Map();
/** Ensure all face renders for a game at a sha exist in a completed, verified
 * cache generation. A non-empty or partially written directory is never a hit. */
export async function ensureRenders(gameRel, gameSlug, sha) {
  const keyDir = join(CACHE_DIR, "renders", gameSlug, sha);
  let current = null;
  try { current = existsSync(keyDir) ? validRenderManifest(keyDir, gameSlug, sha) : null; }
  catch { current = null; }
  if (current) return { keyDir, hit: true, manifest: current };
  const key = `${gameSlug}@${sha}:renders:v${RENDER_CACHE_VERSION}`;
  if (renderInflight.has(key)) return renderInflight.get(key);
  const run = (async () => {
    const materialized = await materialize(gameRel, sha);
    mkdirSync(join(CACHE_DIR, "jobs"), { recursive: true });
    const stage = mkdtempSync(join(CACHE_DIR, "jobs", "render-"));
    try {
      execFileSync(process.execPath, [join(ROOT, "tools/render_cards.mjs"), materialized.dir, stage], { stdio: "pipe" });
      const outputs = walkFiles(stage).filter(item => !item.name.startsWith("."));
      if (!outputs.length) throw new Error("renderer produced no card faces");
      const unsafe=outputs.find(item => !safeCacheRelativePath(item.name));
      if (unsafe) throw new Error(`renderer produced an unsafe cache path: ${unsafe.name}`);
      const manifest = { format: "forge-render-cache", version: RENDER_CACHE_VERSION,
        slug: gameSlug, ref: sha, files: outputs.map(item => fileReceipt(stage, item)) };
      writeFileSync(join(stage, RENDER_COMPLETION_FILE), JSON.stringify(manifest, null, 2) + "\n");
      mkdirSync(dirname(keyDir), { recursive: true });
      rmSync(keyDir, { recursive: true, force: true });
      renameSync(stage, keyDir);
      return { keyDir, hit: false, manifest };
    } finally {
      materialized.cleanup();
      rmSync(stage, { recursive: true, force: true });
    }
  })();
  renderInflight.set(key, run);
  try { return await run; } finally { renderInflight.delete(key); }
}

const exportInflight = new Map();
export const EXPORT_BUDGET = {
  wall_time_ms: Math.max(10_000, Number(process.env.EXPORT_WALL_TIME_MS) || 180_000),
  child_timeout_ms: Math.max(5_000, Number(process.env.EXPORT_CHILD_TIMEOUT_MS) || 120_000),
  max_files: Math.max(10, Number(process.env.EXPORT_MAX_FILES) || 2_500),
  max_output_bytes: Math.max(1024 * 1024, Number(process.env.EXPORT_MAX_OUTPUT_BYTES) || 512 * 1024 * 1024),
  max_log_bytes: Math.max(64 * 1024, Number(process.env.EXPORT_MAX_LOG_BYTES) || 2 * 1024 * 1024),
};
const doneName = (gameSlug, kind) => ({ pnp: "pnp.pdf", print: printArtifactName("ready.zip"), tts: "tts.json",
  ttc: `${gameSlug}-ttc.zip`, ttpg: ttpgArtifactName(gameSlug), vtt: vttArtifactName("vtt"), project: projectArtifactName(gameSlug), data: dataArtifactName(gameSlug),
  nandeck: nandeckArtifactName(gameSlug), svg: svgDesignArtifactName(gameSlug), pnpink: pnpinkArtifactName(gameSlug), squib: squibArtifactName(gameSlug),
  components: componentArtifactName(gameSlug), rulebook: "rulebook-build.json",
  publication: "publication-build.json" })[kind];
export function exportReady(gameSlug, ref, kind) {
  const done=doneName(gameSlug,kind);
  if(!done)return false;
  const outDir=join(CACHE_DIR,"exports",gameSlug,ref);
  const marker=join(outDir,`.complete-${kind}-v${exporterVersion(kind)}.json`);
  return existsSync(marker)&&existsSync(join(outDir,done));
}
/** Ensure a frozen export for a game at a ref. Work runs in a credential-free
 * child process and publishes only after its manifest and quotas verify. */
export async function ensureExport(gameRel, gameSlug, ref, kind, { publicOrigin = null, allowNetwork = false, buildPdf = true } = {}) {
  const outDir = join(CACHE_DIR, "exports", gameSlug, ref), done = doneName(gameSlug, kind);
  if (!done) throw new Error(`unknown export kind '${kind}'`);
  const marker = join(outDir, `.complete-${kind}-v${exporterVersion(kind)}.json`);
  if (exportReady(gameSlug, ref, kind)) return { dir: outDir, hit: true,
    manifest: JSON.parse(readFileSync(marker, "utf8")) };
  const key = `${gameSlug}@${ref}:${kind}:v${exporterVersion(kind)}`;
  if (exportInflight.has(key)) return exportInflight.get(key);
  const run = (async () => {
    const materialized = await materialize(gameRel, ref);
    mkdirSync(join(CACHE_DIR, "jobs"), { recursive: true });
    const stage = mkdtempSync(join(CACHE_DIR, "jobs", `export-${kind}-`));
    try {
      const input = { source_dir: materialized.dir, stage_dir: stage, kind, slug: gameSlug, ref,
        public_origin: publicOrigin || process.env.FORGE_PUBLIC_ORIGIN || "http://localhost:8420",
        allow_network: !!allowNetwork, build_pdf: !!buildPdf, exporter_version: exporterVersion(kind),
        names: { ttc: `${gameSlug}-ttc.zip`, project: projectArtifactName(gameSlug),
          ttpg: ttpgArtifactName(gameSlug),
          data: dataArtifactName(gameSlug), data_workbook: dataWorkbookArtifactName(gameSlug),
          nandeck: nandeckArtifactName(gameSlug), svg: svgDesignArtifactName(gameSlug), pnpink: pnpinkArtifactName(gameSlug), squib: squibArtifactName(gameSlug),
          components: componentArtifactName(gameSlug),
          vtt_json: vttArtifactName("json"), vtt_package: vttArtifactName("vtt") },
        budget: EXPORT_BUDGET };
      const jobFile = join(stage, ".job.json"); writeFileSync(jobFile, JSON.stringify(input));
      const env = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TMPDIR", "FORGE_PYTHON", "CHROME_PATH", "FMT_CHROME_BIN", "FORGE_CHROME"]
        .filter(name => process.env[name] != null).map(name => [name, process.env[name]]));
      const { stdout } = await execFileAsync(process.execPath, [join(ROOT, "tools", "export-job-worker.mjs"), jobFile],
        { cwd: ROOT, env, timeout: EXPORT_BUDGET.wall_time_ms, maxBuffer: EXPORT_BUDGET.max_log_bytes });
      const manifest = JSON.parse(stdout), staged = walkFiles(stage).filter(item => !item.name.startsWith(".job"));
      const actual = new Map(staged.map(item => [item.name, item]));
      for (const file of manifest.files || []) {
        const item = actual.get(file.name); if (!item) throw new Error(`worker manifest file missing: ${file.name}`);
        const hash=createHash("sha256");
        for await(const chunk of createReadStream(item.file,{highWaterMark:256*1024}))hash.update(chunk);
        const sha=hash.digest("hex");
        if (sha !== file.sha256 || item.stat.size !== file.bytes) throw new Error(`worker manifest mismatch: ${file.name}`);
      }
      if (!actual.has(done)) throw new Error(`worker did not produce required artifact '${done}'`);
      mkdirSync(outDir, { recursive: true });
      for (const item of staged) {
        const target = join(outDir, item.name); mkdirSync(dirname(target), { recursive: true });
        rmSync(target, { recursive: item.stat.isDirectory(), force: true });
        renameSync(item.file, target);
      }
      const published = { ...manifest, published_at: Date.now(), input_hash: createHash("sha256").update(`${gameSlug}\0${ref}\0${kind}\0${exporterVersion(kind)}`).digest("hex") };
      const markerTmp = `${marker}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(markerTmp, JSON.stringify(published, null, 2) + "\n"); renameSync(markerTmp, marker);
      return { dir: outDir, hit: false, manifest: published };
    } finally { materialized.cleanup(); rmSync(stage, { recursive: true, force: true }); }
  })();
  exportInflight.set(key, run);
  try { return await run; } finally { exportInflight.delete(key); }
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
