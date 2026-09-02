#!/usr/bin/env node
/**
 * server.mjs — the platform backend (Block G), now a real GATEWAY.
 * Usage: node server.mjs [--port 8420] [--games <dir>] [--readonly]
 * Env: STORE1 (local|forgejo) · LFS_URL (local asset mode) · DB_PATH (Store 2)
 *      CACHE_DIR (Store 3) · FORGE_URL/FORGE_TOKEN (forgejo backend)
 *      FORGE_PUBLIC_ORIGIN (absolute public URL embedded in TTS saves)
 *      VTT_ORIGIN (local/self-hosted VirtualTabletop.io; default localhost:8272)
 *
 * Structure (mirrors the system-design diagram):
 *   gateway kernel (platform/gateway.mjs): middleware → route table → logs
 *   middleware:   CORS preflight → rate limit → readonly gate
 *   route groups: hub · Store-3 cache · auth/social (Store 2) · games (Store 1)
 *   stores:       Store 1 behind an interface — store1-local (dev) or
 *                 store1-forgejo (production, spike-verified primitives);
 *                 sqlite→Postgres · fs→R2
 * GET /api lists every route; GET /healthz for probes.
 */
import { execFile, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { createGateway, readBody } from "./platform/gateway.mjs";
import { diffCards, summarize, mergeCards } from "./tools/lib/carddiff.mjs";
import { jamQualify } from "./tools/lib/jamcheck.mjs";
import { csvToCards, normalizeSheetUrl } from "./tools/lib/cardcsv.mjs";
import { fingerprintCsv, sheetCardsFromBase, sheetPrintingsFromBase, sheetPrintingsFromTable, mergeSheetState } from "./tools/lib/sheetsync.mjs";
import { assertAssetAllowed, MAX_ASSET_BYTES } from "./tools/lib/limits.mjs";
import { inspectAsset, inspectSvg } from "./platform/media-security.mjs";
import { analyzeForgeProject, diffRows, mergeRows } from "./tools/lib/forge-project.mjs";
import { analyzeNandeckImport, parseNandeckScript } from "./tools/lib/nandeck-layout.mjs";
import { loadRulebookPipeline, rulebookPipelineMetadata } from "./tools/lib/rulebook-pipeline.mjs";
import { loadRulebookPublication, rulebookPublicationMetadata } from "./tools/lib/rulebook-publication.mjs";
import { newId } from "./platform/db.mjs";
import { hashPassword, verifyPassword, newToken, tokenDigest, SESSION_TTL_MS, validHandle, validEmail } from "./platform/auth.mjs";
import * as cache from "./platform/cache.mjs";
import { createLocalStore } from "./platform/store1-local.mjs";
import { PROJECT_META, projectMetaBytes, publicProjectPath } from "./platform/project-ref.mjs";
import { collaborationFiles, collaborationPolicy, roleCapabilities, validCollaboratorRole } from "./platform/collaboration.mjs";
import { RIGHTS_MANIFEST, auditRights, forkRightsManifest, parseRights, rightsManifestBytes,
  rightsReceiptBytes, setFileRight } from "./platform/rights.mjs";

/* ---------- config ---------- */
const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const PORT = parseInt(opt("--port", "8420"), 10);
const PUBLIC_ORIGIN = process.env.FORGE_PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
const PRODUCTION = process.env.NODE_ENV === "production";
const HTTPS = process.env.FORGE_HTTPS === "1" || PUBLIC_ORIGIN.startsWith("https://");
const LISTEN_HOST = process.env.FORGE_LISTEN_HOST || (PRODUCTION ? "0.0.0.0" : "127.0.0.1");
const ALLOWED_ORIGINS = [...new Set([PUBLIC_ORIGIN,
  ...String(process.env.FORGE_ALLOWED_ORIGINS || "").split(",")].map(value => value.trim().replace(/\/$/, "")).filter(Boolean))];
const SESSION_COOKIE = HTTPS ? "__Host-forge_session" : "forge_session";
const REGISTRATION_MODE = process.env.FORGE_REGISTRATION_MODE || (PRODUCTION ? "closed" : "open");
const SESSION_TTL = PRODUCTION ? 7 * 24 * 3600 * 1000 : SESSION_TTL_MS;
const OPERATOR_NAME = process.env.FORGE_OPERATOR_NAME || "Forge local development";
const CONTACT_EMAIL = process.env.FORGE_CONTACT_EMAIL || "support@example.invalid";
if (PRODUCTION && !HTTPS) throw new Error("production requires an HTTPS FORGE_PUBLIC_ORIGIN (or FORGE_HTTPS=1)");
if (PRODUCTION && REGISTRATION_MODE === "open") throw new Error("public registration cannot be open in the controlled alpha");
if (PRODUCTION && (!validEmail(CONTACT_EMAIL) || CONTACT_EMAIL.endsWith(".invalid")))
  throw new Error("production requires FORGE_CONTACT_EMAIL for support, privacy, moderation, and takedown requests");
if (PRODUCTION && (!OPERATOR_NAME || OPERATOR_NAME === "Forge local development"))
  throw new Error("production requires FORGE_OPERATOR_NAME");
const VTT_ORIGIN = (process.env.VTT_ORIGIN ?? "http://localhost:8272").replace(/\/$/, "");
const VTT_HOST = (() => { try { return new URL(VTT_ORIGIN).hostname; } catch { return ""; } })();
const VTT_WRITE_ALLOWED = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(VTT_HOST)
  || process.env.ALLOW_REMOTE_VTT_WRITE === "1";
// Local development can run immutable application code from one directory while
// keeping the writable Git game store somewhere else.  This matters on macOS:
// launchd cannot reliably read a project checkout under Documents, and copying
// the whole repository for every deploy would either stale the app or overwrite
// game commits created through Forge.
const LOCAL_STORE_ROOT = resolve(process.env.LOCAL_STORE_ROOT ?? ROOT);
const GAMES_DIR = resolve(opt("--games", join(LOCAL_STORE_ROOT, "examples")));
const HUB_PATH = resolve(process.env.FORGE_HUB_PATH ?? join(ROOT, "hub.html"));
const READONLY = args.includes("--readonly");
const RATE = { windowMs: 60_000, max: 120 };
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
               svg: "image/svg+xml", ogg: "audio/ogg", mp3: "audio/mpeg", ttf: "font/ttf",
               otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
               pdf: "application/pdf", json: "application/json", yaml: "text/yaml", yml: "text/yaml",
               md: "text/markdown", txt: "text/plain", css: "text/css", csv: "text/csv", html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
               zip: "application/zip", vtt: "application/zip" };
const MAX_PROJECT_BYTES = 128 * 1024 * 1024;
const MAX_NANDECK_BYTES = 2 * 1024 * 1024;
const ADAPTER_CATALOG = JSON.parse(readFileSync(join(ROOT, "integrations", "adapters", "catalog.json"), "utf8"));

/* ---------- stores ---------- */
// Store 2 — driver behind the same q surface: node:sqlite (dev) or Postgres (prod)
const { openDb, q } = process.env.DB === "postgres"
  ? await import("./platform/db-pg.mjs") : await import("./platform/db.mjs");
const db = await openDb();
await q.pruneSessions(db);
setInterval(() => q.pruneSessions(db).catch?.(() => {}), 6 * 3600 * 1000).unref();
const VENV_PYTHON = process.platform === "win32" ? join(ROOT, ".venv", "Scripts", "python.exe") : join(ROOT, ".venv", "bin", "python");
const PYTHON = process.env.FORGE_PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
const py = (script, a) => spawnSync(PYTHON, [join(ROOT, "tools", script), ...a], { encoding: "utf8" });
const execFileAsync = promisify(execFile);

// Store 1 — THE seam. Routes below talk to `store` only; no git, no game paths.
const STORE1 = process.env.STORE1 ?? "local";
if (PRODUCTION && STORE1 !== "forgejo") throw new Error("production requires STORE1=forgejo");
if (PRODUCTION && !process.env.FORGE_TOKEN) throw new Error("production requires a scoped FORGE_TOKEN");
const store = STORE1 === "forgejo"
  ? (await import("./platform/store1-forgejo.mjs")).createForgejoStore({
      root: ROOT, forgeUrl: process.env.FORGE_URL, token: process.env.FORGE_TOKEN,
      basicAuth: process.env.FORGE_BASIC ?? null, farmDir: process.env.FARM_DIR })
  : createLocalStore({ root: LOCAL_STORE_ROOT, gamesDir: GAMES_DIR, lfsUrl: process.env.LFS_URL ?? null });
const mat = (slug) => (ref) => store.materialize(slug, ref); // Store-3 feed

async function reindexGames() { // DA-3: derived, rebuildable
  for (const slug of await store.list()) {
    const m = await store.readMeta(slug);
    let game = {};
    try { game = yaml.load((await store.readFile(slug, "game.yaml")).toString()) || {}; } catch {}
    const discovery = game.discovery || {};
    const topics = [...new Set([game.genre, ...(Array.isArray(game.tags) ? game.tags : []),
      discovery.game_type, discovery.complexity, discovery.maturity,
      ...(discovery.mechanisms || []), ...(discovery.modes || []), ...(discovery.themes || []),
      ...(discovery.languages || []).map(value => `language:${value}`),
      ...(discovery.tool_compatibility || []).map(value => `tool:${value}`),
      ...(discovery.accessibility || []).map(value => `accessibility:${value}`)]
      .map(value => String(value || "").trim().toLowerCase()).filter(Boolean))];
    const sourceLicense = m.license || game.license || "unknown";
    const rights = parseRights(await store.readFile(slug, RIGHTS_MANIFEST));
    const license = rights?.project?.license || sourceLicense;
    const rightsRules = [rights?.default, ...(rights?.files || [])].filter(Boolean);
    const publicRights = !!rights
      && !["", "unknown", "proprietary", "imported-see-source"].includes(String(license).toLowerCase())
      && rights?.project?.release_permission !== "unverified"
      && !rightsRules.some(rule => rule.status === "unknown" || rule.redistribution === "private-only");
    await q.upsertGame(db, { slug, project_id: m.projectId, namespace: m.namespace,
      repo_slug: m.repoSlug, repo_id: m.repoId, title: m.title,
      license, card_count: m.cardCount, description: game.description || "",
      topics_json: JSON.stringify(topics), players_min: game.players?.min ?? null,
      players_max: game.players?.max ?? null,
      visibility: publicRights ? "public" : "private" });
  }
}
await reindexGames();

/* ---------- jams: definitions from jams/*.yaml, entries live in Store 2 ---------- */
function loadJams() {
  const r = spawnSync(PYTHON, ["-c",
    "import yaml,json,glob,os,sys\nprint(json.dumps([yaml.safe_load(open(f).read()) for f in sorted(glob.glob(os.path.join(sys.argv[1],'jams','*.yaml')))]))",
    ROOT], { encoding: "utf8" });
  try { return JSON.parse(r.stdout || "[]"); } catch { return []; }
}
const JAMS = loadJams();
const jamById = (id) => JAMS.find(j => j.id === id);
const nowMs = () => {
  const forced = process.env.FORGE_NOW;
  if (PRODUCTION && forced) throw new Error("FORGE_NOW is test-only and cannot be set in production");
  return forced ? Date.parse(forced) : Date.now();
};
function jamStatus(jam, at = nowMs()) {
  if (jam.status_override) return jam.status_override;
  const start = Date.parse(jam.starts_at || jam.starts || ""), close = Date.parse(jam.submissions_close_at || jam.ends || "");
  const judgingEnd = Date.parse(jam.judging_ends_at || ""), results = Date.parse(jam.results_at || "");
  if (Number.isFinite(start) && at < start) return "scheduled";
  if (!Number.isFinite(close) || at < close) return "open";
  if (Number.isFinite(results) && at >= results) return "published";
  if (Number.isFinite(judgingEnd) && at < judgingEnd) return "judging";
  return "frozen";
}
for (const j of JAMS) for (const e of (j.entries || []))   // seed static host entries once
  if (e.game_id && !(await q.jamEntryOf(db, j.id, e.game_id)))
    await q.enterJam(db, { jam_id: j.id, game_slug: e.game_id, user_id: null, qualified: 1,
      award: e.award ?? null, state: "host" });

let hubVersion = null;
const uiGameCache = new Map();
async function hubHtml() {
  // In local development the application code and writable game store are
  // intentionally separate. Invalidate for either side: a game-data change,
  // or a renderer/builder change in this checkout. Otherwise a newly added
  // template can remain invisible until some unrelated card file is edited.
  const appVersion = Math.max(...["tools/build_hub.py", "tools/card_design.py", "tools/design_engines.py", "tools/hub_template.html"].map(rel => {
    const path = join(ROOT, rel); return existsSync(path) ? statSync(path).mtimeMs : 0;
  }));
  const v = String(appVersion);
  const out = HUB_PATH;
  if (!existsSync(out) || hubVersion !== v) {
    mkdirSync(dirname(out), { recursive: true });
    const buildArgs = ["-o", out, "--games", await store.treeRoot()];
    buildArgs.push("--live-assets", "--shell");
    if (STORE1 === "local") buildArgs.push("--repo-root", LOCAL_STORE_ROOT);
    const r = py("build_hub.py", buildArgs);
    if (r.status !== 0) throw new Error(r.stderr);
    hubVersion = v;
  }
  return readFileSync(out, "utf8");
}

async function uiGame(slug) {
  const sha = await store.headSha(slug), key = `${slug}@${sha}`;
  if (uiGameCache.has(key)) return uiGameCache.get(key);
  const dir = await store.dir(slug);
  const args = [join(ROOT, "tools", "build_hub.py"), "--game-json", dir, "--live-assets"];
  if (STORE1 === "local") args.push("--repo-root", LOCAL_STORE_ROOT);
  const { stdout } = await execFileAsync(PYTHON, args, { maxBuffer: 64 * 1024 * 1024 });
  const game = JSON.parse(stdout);
  uiGameCache.set(key, game);
  if (uiGameCache.size > 40) uiGameCache.delete(uiGameCache.keys().next().value);
  return game;
}

/* ---------- gateway + middleware ---------- */
const gw = createGateway({ name: "forge-platform", version: "0.3", allowedOrigins: ALLOWED_ORIGINS,
  production: PRODUCTION, https: HTTPS, host: LISTEN_HOST });
const hits = new Map();
gw.use((ctx) => { if (ctx.req.method === "OPTIONS") ctx.send(204, ""); });
gw.use((ctx) => { // rate limit
  const trusted = process.env.FORGE_TRUST_PROXY === "1";
  const forwarded = String(ctx.req.headers["cf-connecting-ip"] || ctx.req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = trusted && forwarded ? forwarded : (ctx.req.socket.remoteAddress ?? "?");
  const path = ctx.url.pathname;
  const bucket = path.startsWith("/api/auth/") ? "auth"
    : path.includes("/export/") ? "export"
    : path.includes("/assets") || path.includes("/design/import") ? "upload" : "general";
  const max = bucket === "auth" ? 12 : bucket === "export" ? 20 : bucket === "upload" ? 30 : RATE.max;
  const now = Date.now();
  const key = `${ip}:${bucket}`;
  const h = hits.get(key) ?? { t: now, n: 0 };
  if (now - h.t > RATE.windowMs) { h.t = now; h.n = 0; }
  h.n++; hits.set(key, h);
  if (hits.size > 10_000) hits.clear();
  if (h.n > max) { ctx.setHeader("retry-after", String(Math.max(1, Math.ceil((h.t + RATE.windowMs - now) / 1000))));
    ctx.send(429, { error: "rate limited", bucket, request_id: ctx.requestId }); }
});
gw.use((ctx) => { // readonly gate (showcase mode)
  if (READONLY && ctx.req.method !== "GET")
    ctx.send(403, { error: "read-only beta — clone the repo to make it yours" });
});
const cookiesOf = req => Object.fromEntries(String(req.headers.cookie || "").split(";").map(part => {
  const at = part.indexOf("="); return at < 0 ? ["", ""] : [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1))];
}).filter(([key]) => key));
const sessionTokenOf = ctx => {
  const m = (ctx.req.headers.authorization ?? "").match(/^Bearer (\w{64})$/);
  return m?.[1] || cookiesOf(ctx.req)[SESSION_COOKIE] || null;
};
const authedUser = async (ctx) => {
  const token = sessionTokenOf(ctx);
  return token && /^\w{64}$/.test(token) ? q.sessionUser(db, tokenDigest(token)) : null;
};
const requireAuth = async (ctx) => { const u = await authedUser(ctx); if (!u) ctx.send(401, { error: "auth required" }); return u; };
// per-user data lineage: authed requests commit AS the user; anonymous falls back
const authorOf = async (ctx) => { const u = await authedUser(ctx); return u ? `${u.handle} <${u.email}>` : "web editor <editor@platform>"; };
/** COMMIT ACCESS (the rule the anonymous-edit hole violated):
 *  anonymous → never. Owned game → owner or invited collaborator only.
 *  Unowned demo game → any signed-in user (explicit transitional rule).
 *  Everyone else still has a path: fork + PR (see /cards/propose). */
async function canWrite(u, slug) {
  if (!u) return false;
  const g = await q.gameBySlug(db, slug);
  if (!g || !g.owner_id) return true;
  if (g.owner_id === u.id) return true;
  return roleCapabilities(await q.collaboratorRole(db, slug, u.id)).can_write;
}
const isLoopbackRequest = (ctx) => {
  const authority = String(ctx?.req?.headers?.host || "").trim().toLowerCase();
  const host = authority.startsWith("[")
    ? authority.slice(1, authority.indexOf("]"))
    : authority.split(":")[0];
  return ["localhost", "127.0.0.1", "::1"].includes(host);
};
async function canRead(u, slug, ctx = null) {
  const g = await q.gameBySlug(db, slug);
  if (!g || g.visibility === "public") return true;
  // A developer may explicitly expose rights-restricted fixtures in the
  // loopback UI for local production testing. The Host check is deliberate:
  // the same process can sit behind a temporary Sheets tunnel, where private
  // projects must remain undiscoverable and inaccessible.
  if (!PRODUCTION && process.env.FORGE_LOCAL_PRIVATE_PREVIEW === "1" && isLoopbackRequest(ctx)) return true;
  if (!u) return false;
  if (!g.owner_id || g.owner_id === u.id) return true;
  return !!await q.collaboratorRole(db, slug, u.id);
}
async function canReview(u, slug) {
  if (!u) return false;
  const g = await q.gameBySlug(db, slug);
  if (!g || !g.owner_id || g.owner_id === u.id) return true;
  return roleCapabilities(await q.collaboratorRole(db, slug, u.id)).can_review;
}
/** ADMIN ACCESS (merge a PR, close a PR/issue, cut a release): same ownerless
 *  -> open-sandbox carve-out as canWrite() above, since none of the 12 shipped
 *  demo games have an owner and the whole point of the sandbox policy is that
 *  the collaboration loop (fork -> PR -> merge) has to actually be completable
 *  on them. BUT a release is a stronger, citable, harder-to-undo action than a
 *  merge, so it stays intentionally narrower: an invited collaborator (write
 *  access short of ownership) may merge/close but may NOT cut a release on
 *  someone else's game -- only the owner, or anyone on an ownerless/demo game,
 *  can do that. Pass { releases: true } to get that stricter rule. */
async function canAdmin(u, slug, { releases = false } = {}) {
  if (!u) return false;
  const g = await q.gameBySlug(db, slug);
  if (!g || !g.owner_id) return true;              // ownerless/demo game: open sandbox
  if (g.owner_id === u.id) return true;             // owner
  if (releases) return false;                       // releases: owner-or-ownerless only
  return roleCapabilities(await q.collaboratorRole(db, slug, u.id)).can_merge;
}
// A private/unverified research fixture may be addressed directly only by its
// owner or collaborators. This applies before every game, asset, editor and
// immutable-cache route so obscurity is never treated as authorization.
gw.use(async (ctx) => {
  const p = ctx.url.pathname.split("/").filter(Boolean);
  let slug = null;
  if (p[0] === "api" && p[1] === "games" && p.length >= 3) slug = decodeURIComponent(p[2]);
  else if (p[0] === "cache" && ["renders", "exports"].includes(p[1]) && p.length >= 3) slug = decodeURIComponent(p[2]);
  else if (p[0] === "edit" && p.length >= 2) slug = decodeURIComponent(p[1]);
  else if (p[0] === "api" && p[1] === "projects" && p.length >= 4) {
    const row = await q.gameByProject(db, decodeURIComponent(p[2]), decodeURIComponent(p[3])); slug = row?.slug || null;
  }
  if (slug && !await canRead(await authedUser(ctx), slug, ctx))
    ctx.send(404, { error: "project not found" });
});
const denyWrite = (ctx, u) => u
  ? ctx.send(403, { error: "no commit access to this game", propose: true,
      hint: "fork it and open a PR (POST /api/games/:slug/cards/propose does both in one step), or ask the owner for access" })
  : ctx.send(401, { error: "sign in to save changes" });

const requireGame = (ctx) => {
  if (!store.has(ctx.params.slug)) { ctx.send(404, { error: `no game '${ctx.params.slug}'` }); return null; }
  return ctx.params.slug;
};
const json = async (ctx) => {
  try { return JSON.parse((await readBody(ctx.req)).toString()); }
  catch (error) { if (!error.status) error.status = 400; throw error; }
};
const optionalJson = async (ctx) => {
  const raw = (await readBody(ctx.req)).toString().trim();
  return raw ? JSON.parse(raw) : {};
};

/** Validate a candidate tree = game at HEAD + one replaced file. Never touches
 *  the live tree — the rollback path is simply "don't commit". Backend-agnostic. */
async function validateCandidate(slug, relPath, content, extra = {}) {
  const { dir, cleanup } = await store.materialize(slug, "HEAD");
  try {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });   // new-file artifacts (e.g. playtests/) may need the dir
    writeFileSync(full, content);
    for (const [p, c] of Object.entries(extra)) {    // validate multi-file candidates together
      const f = join(dir, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, c);
    }
    const v = py("validate.py", [dir]);
    return { ok: v.status === 0, report: `${v.stdout || ""}\n${v.stderr || ""}`.trim().split("\n") };
  } finally { cleanup(); }
}

/* ---------- reusable repository assets ----------
 * Cards are structured objects, but the playable game also depends on files:
 * artwork, symbols, fonts, production templates, rulebook media, and table
 * setups. These paths are first-class game source. The helpers below provide
 * one safe, renderer-neutral inventory used by the Assets tab and by PRs. */
const REUSABLE_ROOTS = ["assets/", "templates/", "setups/", "rules/"];
const REVIEWED_EXACT = new Set(["game.yaml", "CREDITS.md", "CODEOWNERS", "forge/collaboration.json", RIGHTS_MANIFEST]);
const REVIEWED_PREFIXES = [
  "components/", "decks/", "formats/", "sets/", "design/",
  "forge/imports/", "forge/jams/",
];
const PR_LOCAL_ONLY = new Set(["CODEOWNERS", "forge/collaboration.json"]);
const REPO_TEXT_EXTS = new Set(["svg", "json", "yaml", "yml", "md", "txt", "css", "csv"]);
const REPO_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "svg"]);
const REPO_FONT_EXTS = new Set(["ttf", "otf", "woff", "woff2"]);
const REPO_AUDIO_EXTS = new Set(["ogg", "mp3", "wav", "m4a"]);
const repoExt = (path) => path.toLowerCase().split(".").pop();
const isReusablePath = (path) => typeof path === "string"
  && !path.startsWith("/") && !path.includes("..") && REUSABLE_ROOTS.some(root => path.startsWith(root));
const isReviewablePath = (path) => isReusablePath(path) || REVIEWED_EXACT.has(path)
  || REVIEWED_PREFIXES.some(prefix => path.startsWith(prefix) && !path.includes(".."));
const isRepoText = (path) => REPO_TEXT_EXTS.has(repoExt(path));
const hashBuffer = (buf) => createHash("sha256").update(buf).digest("hex");
function walkRepo(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "exports") continue;
    const full = join(dir, name), rel = `${prefix}${name}`;
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkRepo(full, `${rel}/`));
    else if (stat.isFile()) out.push({ path: rel, full, size: stat.size });
  }
  return out;
}
function repoCategory(path) {
  const ext = repoExt(path), low = path.toLowerCase();
  if (REVIEWED_EXACT.has(path) || REVIEWED_PREFIXES.some(prefix => path.startsWith(prefix))) return "Governance & receipts";
  if (path === "rules/pipeline.yaml") return "Rulebook pipeline";
  if (path.startsWith("rules/native/")) return "Native rulebook source";
  if (path.startsWith("templates/card-design/families/")) return "Card family templates";
  if (path.startsWith("templates/card-design/components/")) return "Card design components";
  if (path.startsWith("templates/card-design/")) return "Card design system";
  if (path.startsWith("templates/")) return "Design templates";
  if (path.startsWith("setups/")) return "Table setups";
  if (path.startsWith("rules/")) return "Rulebook";
  if (REPO_FONT_EXTS.has(ext) || low.includes("font")) return "Fonts";
  if (low.includes("symbol") || low.includes("icon")) return "Symbols & icons";
  if (low.startsWith("assets/art/")) return "Artwork";
  if (low.includes("source-face") || low.includes("source-patch") || low.includes("pnp-scan")) return "Source references";
  if (REPO_AUDIO_EXTS.has(ext)) return "Audio";
  return "Other media";
}
function repoKind(path) {
  const ext = repoExt(path);
  if (REPO_IMAGE_EXTS.has(ext)) return "image";
  if (REPO_FONT_EXTS.has(ext)) return "font";
  if (REPO_AUDIO_EXTS.has(ext)) return "audio";
  if (isRepoText(path)) return path.startsWith("templates/") ? "template" : "text";
  return "binary";
}
// A fork's rights manifest deliberately has fork-specific project ownership and
// lineage. Those fields must never overwrite the upstream project during a PR.
// Review/merge only the explicit per-file declarations; generated Forge rules
// and project/default policy remain owned by the destination repository.
function contributedRights(bytes) {
  const manifest = parseRights(bytes);
  return (manifest?.files || []).filter(rule => rule.status !== "generated")
    .map(rule => ({ ...rule, paths: [...(rule.paths || [])].sort() }))
    .sort((a, b) => JSON.stringify(a.paths).localeCompare(JSON.stringify(b.paths)));
}
function rightsContributionHash(bytes) {
  return hashBuffer(Buffer.from(JSON.stringify(contributedRights(bytes))));
}
function mergeContributedRights(currentBytes, proposedBytes) {
  const current = parseRights(currentBytes), proposed = parseRights(proposedBytes);
  if (!current || !proposed) throw Object.assign(new Error("rights manifest is missing or invalid"), { status: 422 });
  return { ...current, files: [
    ...(current.files || []).filter(rule => rule.status === "generated"),
    ...contributedRights(proposed),
  ] };
}
function gameYamlContribution(bytes) {
  const value = yaml.load(Buffer.from(bytes || "").toString("utf8")) || {};
  delete value.id;
  delete value.attribution;
  return value;
}
function gameYamlContributionHash(bytes) {
  return hashBuffer(Buffer.from(JSON.stringify(gameYamlContribution(bytes))));
}
function mergeContributedGameYaml(currentBytes, proposedBytes) {
  const current = yaml.load(Buffer.from(currentBytes || "").toString("utf8")) || {};
  const proposed = yaml.load(Buffer.from(proposedBytes || "").toString("utf8")) || {};
  proposed.id = current.id;
  if (Object.hasOwn(current, "attribution")) proposed.attribution = current.attribution;
  else delete proposed.attribution;
  return yaml.dump(proposed, { noRefs: true, lineWidth: -1, sortKeys: false });
}
function repoFileChanges(base = {}, proposed = {}) {
  const out = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(proposed)])) {
    const before = base[path] ?? null, after = proposed[path] ?? null;
    if ((before?.hash ?? null) === (after?.hash ?? null)) continue;
    out.push({ path, kind: !before ? "added" : !after ? "removed" : "changed",
      category: repoCategory(path), asset_kind: repoKind(path),
      before_size: before?.size ?? null, after_size: after?.size ?? null,
      before_hash: before?.hash ?? null, after_hash: after?.hash ?? null });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
function mergeRepoFiles(base = {}, proposed = {}, current = {}) {
  const changes = repoFileChanges(base, proposed), conflicts = [];
  for (const change of changes) {
    const b = base[change.path]?.hash ?? null, p = proposed[change.path]?.hash ?? null;
    const c = current[change.path]?.hash ?? null;
    if (c === p || c === b) continue;
    conflicts.push(change.path);
  }
  return { changes, conflicts };
}
const snapshotCache = new Map();
async function gameSnapshot(slug, ref = null) {
  const pinned = ref || await store.headSha(slug);
  const cacheKey = `${slug}@${pinned}`;
  if (snapshotCache.has(cacheKey)) return snapshotCache.get(cacheKey);
  const { dir, cleanup } = await store.materialize(slug, pinned);
  try {
    let cards = [], printings = [];
    try { cards = JSON.parse(readFileSync(join(dir, "components/cards.json"), "utf8")); } catch {}
    try { printings = JSON.parse(readFileSync(join(dir, "components/printings.json"), "utf8")); } catch {}
    const files = {};
    for (const item of walkRepo(dir).filter(item => isReviewablePath(item.path) && !PR_LOCAL_ONLY.has(item.path))) {
      const buf = readFileSync(item.full);
      const hash = item.path === RIGHTS_MANIFEST ? rightsContributionHash(buf)
        : item.path === "game.yaml" ? gameYamlContributionHash(buf) : hashBuffer(buf);
      files[item.path] = { hash, size: buf.length };
    }
    const snapshot = { version: 3, ref: pinned, cards, printings, files };
    snapshotCache.set(cacheKey, snapshot);
    if (snapshotCache.size > 80) snapshotCache.delete(snapshotCache.keys().next().value);
    return snapshot;
  } finally { cleanup(); }
}
function normalizePrSnapshot(value, fallbackRef = "HEAD") {
  if (Array.isArray(value)) return { version: 1, ref: fallbackRef, cards: value, printings: [], files: {} };
  return { version: value?.version || 2, ref: value?.ref || fallbackRef,
    cards: Array.isArray(value?.cards) ? value.cards : [],
    printings: Array.isArray(value?.printings) ? value.printings : [], files: value?.files || {} };
}

/* ---------- routes: hub + live editor ---------- */
gw.route("GET", "/", async (ctx) => ctx.send(200, await hubHtml(), "text/html; charset=utf-8"), "hub UI");
const POLICY_FILES = { terms: "terms.md", privacy: "privacy.md", community: "community.md",
  rights: "rights-and-takedown.md", support: "support.md" };
gw.route("GET", "/policies/:name", async (ctx) => {
  const file = POLICY_FILES[ctx.params.name]; if (!file) return ctx.send(404, { error: "no such policy" });
  const raw = readFileSync(join(ROOT, "policies", file), "utf8")
    .replaceAll("{{OPERATOR}}", OPERATOR_NAME).replaceAll("{{CONTACT}}", CONTACT_EMAIL);
  const escaped = raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  ctx.send(200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Forge — ${ctx.params.name}</title><style>body{font:16px/1.6 system-ui;max-width:780px;margin:40px auto;padding:0 22px;color:#24292f}pre{white-space:pre-wrap;font:inherit}a{color:#0969da}</style><p><a href="/">← Forge</a></p><pre>${escaped}</pre>`, "text/html; charset=utf-8");
}, "controlled-alpha terms, privacy, community, rights, and support documents");
const editorBuilt = new Map(); // slug -> {version}
gw.route("GET", "/edit/:slug", async (ctx) => {
  // legacy path → the app's routed edit mode (editing lives INSIDE the SPA now)
  if (!ctx.url.searchParams.has("raw")) {
    return ctx.sendRaw(302, "", { Location: `/#/g/${ctx.params.slug}/cards/edit` });
  }
  const slug = requireGame(ctx); if (!slug) return;
  const v = await store.version(slug);
  const out = join(ROOT, "data", `editor-${slug}.html`);
  const cached = editorBuilt.get(slug);
  if (!cached || cached.version !== v || !existsSync(out)) {
    mkdirSync(join(ROOT, "data"), { recursive: true });
    const r = py("build_editor.py", [await store.dir(slug), "-o", out, "--live", slug]);
    if (r.status !== 0) return ctx.send(500, { error: r.stderr });
    editorBuilt.set(slug, { version: v });
  }
  ctx.send(200, readFileSync(out, "utf8"), "text/html; charset=utf-8");
}, "LIVE editor: edit cards in browser, Save = real git commit");

/* ---------- routes: Store 3 — immutable cache (DA-5) ---------- */
gw.route("GET", "/cache/renders/:slug/:ref/*", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const { ref } = ctx.params;
  if (!/^[0-9a-fv][0-9a-f.\-]*$/i.test(ref) || ctx.params["*"].includes("..")) return ctx.send(404, { error: "bad ref" });
  const { keyDir } = await cache.ensureRenders(mat(slug), slug, ref);
  const fp = join(keyDir, ctx.params["*"]);
  if (!existsSync(fp)) return ctx.send(404, { error: "not producible" });
  ctx.sendRaw(200, readFileSync(fp), { "content-type": MIME[fp.split(".").pop()] ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable" });
}, "card render at exact commit — URL never changes meaning");
gw.route("GET", "/cache/exports/:slug/:ref/*", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const { ref } = ctx.params;
  const file = ctx.params["*"];
  if (!/^[0-9a-fv][0-9a-f.\-]*$/i.test(ref) || file.includes("..")) return ctx.send(404, { error: "bad ref" });
  const fp = cache.pathOf(cache.exportKey(slug, ref, file));
  if (!existsSync(fp)) return ctx.send(404, { error: "artifact is not published" });
  ctx.sendRaw(200, readFileSync(fp), { "content-type": MIME[fp.split(".").pop()] ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable" });
}, "frozen export artifact (sha or release tag)");

/* ---------- routes: Store 2 — identity & social ---------- */
function setSessionCookie(ctx, token, maxAge = Math.floor(SESSION_TTL / 1000)) {
  ctx.setHeader("set-cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${HTTPS ? "; Secure" : ""}`);
}
function authResponse(ctx, code, token, user, body = {}) {
  setSessionCookie(ctx, token);
  const apiToken = ctx.req.headers["x-forge-browser"] !== "1";
  ctx.send(code, { ...body, ...(apiToken ? { token } : {}), user });
}
gw.route("POST", "/api/auth/register", async (ctx) => {
  let { handle, email, password, invite_code: inviteCode } = await json(ctx);
  email = String(email || "").trim().toLowerCase();
  if (REGISTRATION_MODE === "closed") return ctx.send(403, { error: "registration is invite-only during the controlled alpha" });
  if (REGISTRATION_MODE === "invite" && (!process.env.FORGE_INVITE_CODE || inviteCode !== process.env.FORGE_INVITE_CODE))
    return ctx.send(403, { error: "a valid alpha invite code is required" });
  if (!validHandle(handle)) return ctx.send(422, { error: "handle: 2-32 chars, kebab-case" });
  if (!validEmail(email)) return ctx.send(422, { error: "invalid email" });
  const minimum = PRODUCTION ? 12 : 8;
  if ((password ?? "").length < minimum) return ctx.send(422, { error: `password: ${minimum}+ chars` });
  if (await q.userByHandle(db, handle) || await q.userByEmail(db, email)) return ctx.send(409, { error: "handle or email already registered" });
  const id = newId("u");
  await q.createUser(db, { id, handle, email, pass_hash: hashPassword(password) });
  const token = newToken();
  await q.createSession(db, tokenDigest(token), id, SESSION_TTL);
  authResponse(ctx, 201, token, { id, handle });
}, "create account");
gw.route("POST", "/api/auth/login", async (ctx) => {
  const { handle, password } = await json(ctx), identity = String(handle || "").trim();
  const u = await q.userByHandle(db, identity) ?? await q.userByEmail(db, identity.toLowerCase());
  if (!u || !verifyPassword(password ?? "", u.pass_hash)) return ctx.send(401, { error: "bad credentials" });
  const token = newToken();
  await q.createSession(db, tokenDigest(token), u.id, SESSION_TTL);
  authResponse(ctx, 200, token, { id: u.id, handle: u.handle });
}, "get session token");
gw.route("POST", "/api/auth/logout", async (ctx) => {
  const token = sessionTokenOf(ctx), u = await authedUser(ctx);
  if (token && u) await q.revokeSession(db, u.id, tokenDigest(token).slice(0, 16));
  setSessionCookie(ctx, "", 0);
  ctx.send(200, { signed_out: true });
}, "revoke the current session");
gw.route("GET", "/api/auth/sessions", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const current = tokenDigest(sessionTokenOf(ctx)).slice(0, 16);
  ctx.send(200, (await q.sessionsFor(db, u.id)).map(session => ({ ...session, current: session.id === current })));
}, "list active sessions without exposing bearer credentials");
gw.route("DELETE", "/api/auth/sessions/:id", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  if (!/^[0-9a-f]{16}$/.test(ctx.params.id)) return ctx.send(422, { error: "invalid session id" });
  await q.revokeSession(db, u.id, ctx.params.id);
  if (tokenDigest(sessionTokenOf(ctx)).startsWith(ctx.params.id)) setSessionCookie(ctx, "", 0);
  ctx.send(200, { revoked: true, id: ctx.params.id });
}, "revoke one active session");
gw.route("DELETE", "/api/auth/sessions", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  await q.revokeAllSessions(db, u.id); setSessionCookie(ctx, "", 0);
  ctx.send(200, { revoked_all: true });
}, "revoke every active session");
gw.route("GET", "/api/me", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  ctx.send(200, { id: u.id, handle: u.handle, email: u.email,
    claims: await q.claimsOf(db, u.id), starred: (await q.starredBy(db, u.id)).map(r => r.game_slug),
    games: await q.gamesOwnedBy(db, u.id) });
}, "who am I + claims + stars + owned games");
/** @param {any} u @param {string} title @param {string|undefined} csv @param {string} authorStr
 * @param {{brief?: any, license?: string}} [options] */
async function hostGame(u, title, csv, authorStr, options = {}) {
  const { brief, license = "CC-BY-4.0" } = options;
  const repoSlug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  if (!repoSlug) return { error: { code: 422, body: { error: "title does not produce a valid project slug" } } };
  const existing = await q.gameByProject(db, u.handle, repoSlug);
  if (existing) return { error: { code: 409, body: { error: `you already own '${u.handle}/${repoSlug}'`, existing: existing.slug } } };
  const storageKey = store.has(repoSlug) ? `${u.handle}~${repoSlug}` : repoSlug;
  if (store.has(storageKey)) return { error: { code: 409, body: { error: `project '${u.handle}/${repoSlug}' unavailable` } } };
  const projectId = newId("p");
  const tmp = mkdtempSync(join(tmpdir(), "csv-"));
  try {
    let imp;
    if (brief && !csv?.trim()) {
      writeFileSync(join(tmp, "brief.json"), JSON.stringify(brief, null, 2) + "\n");
      imp = spawnSync(process.execPath,
        [join(ROOT, "tools/new-game.mjs"), join(tmp, "game"), "--title", title.trim(),
          "--license", license, "--brief", join(tmp, "brief.json")],
        { encoding: "utf8" });
    } else {
      writeFileSync(join(tmp, "in.csv"), csv ?? "name,type,text\nFirst Card,card,Hello world.");
      imp = spawnSync(process.execPath,
        [join(ROOT, "tools/import-csv.mjs"), join(tmp, "in.csv"), join(tmp, "game"),
          "--title", title.trim(), "--license", license],
        { encoding: "utf8" });
      if (imp.status === 0 && brief) {
        mkdirSync(join(tmp, "game", "design"), { recursive: true });
        writeFileSync(join(tmp, "game", "design", "brief.json"), JSON.stringify(brief, null, 2) + "\n");
      }
    }
    if (imp.status !== 0) return { error: { code: 422, body: { error: "import failed", detail: imp.stderr } } };
    mkdirSync(join(tmp, "game", dirname(PROJECT_META)), { recursive: true });
    writeFileSync(join(tmp, "game", PROJECT_META), projectMetaBytes({ storageKey, projectId,
      namespace: u.handle, slug: repoSlug }));
    writeFileSync(join(tmp, "game", ".gitattributes"), "assets/** filter=lfs diff=lfs merge=lfs -text\n");
    for (const file of collaborationFiles(u.handle)) {
      mkdirSync(dirname(join(tmp, "game", file.path)), { recursive: true });
      writeFileSync(join(tmp, "game", file.path), file.content);
    }
    mkdirSync(dirname(join(tmp, "game", RIGHTS_MANIFEST)), { recursive: true });
    writeFileSync(join(tmp, "game", RIGHTS_MANIFEST), rightsManifestBytes({ license, owner: u.handle }));
    if (csv?.trim()) {
      const cards = JSON.parse(readFileSync(join(tmp, "game", "components/cards.json"), "utf8"));
      const receipt = { format: "forge-import-receipt", version: 1,
        adapter: { id: "csv-cards", version: 2, mode: "snapshot-import" },
        source: { sha256: createHash("sha256").update(csv).digest("hex"), bytes: Buffer.byteLength(csv) },
        imported_by: u.handle, imported_at: new Date().toISOString(), result: { cards: cards.length } };
      mkdirSync(join(tmp, "game", "forge", "imports"), { recursive: true });
      writeFileSync(join(tmp, "game", "forge", "imports", "csv.json"), JSON.stringify(receipt, null, 2) + "\n");
    }
    const v = py("validate.py", [join(tmp, "game")]);
    if (v.status !== 0) return { error: { code: 422, body: { error: "imported game failed validation", report: v.stdout.split("\n") } } };
    const commitMessage = brief
      ? `start game: ${title.trim()}\n\nDesign anchor: ${brief.starting_point}\nFirst playable slice: ${brief.mvp?.playable_slice || "not specified"}`
      : `new game: ${title.trim()} (${u.handle}/${repoSlug})\n\nimported from CSV via platform`;
    const { sha } = await store.createGame(storageKey, join(tmp, "game"),
      commitMessage, authorStr);
    await reindexGames();
    await q.setForkMeta(db, storageKey, null, u.id);  // ownership
    return { slug: storageKey, repo_slug: repoSlug, namespace: u.handle, project_id: projectId, sha };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
gw.route("POST", "/api/games", async (ctx) => {
  // THE HOSTING VERB: start from intent or bring structured components; both
  // leave as a hosted, owned, validated, versioned game.
  const u = await requireAuth(ctx); if (!u) return;
  const { title, csv, brief, license } = await json(ctx);
  if (!title?.trim()) return ctx.send(422, { error: "title required" });
  if (brief != null && (typeof brief !== "object" || Array.isArray(brief)))
    return ctx.send(422, { error: "brief must be an object" });
  const r = await hostGame(u, title.trim(), csv, await authorOf(ctx), { brief, license });
  if (r.error) return ctx.send(r.error.code, r.error.body);
  ctx.send(201, { slug: r.slug, repo_slug: r.repo_slug, namespace: r.namespace,
    project_id: r.project_id, owner: u.handle, commit: r.sha,
    cards: JSON.parse((await store.readFile(r.slug, "components/cards.json")).toString()).length,
    url: `/#${publicProjectPath({ namespace: r.namespace, slug: r.repo_slug })}`,
    edit: `/edit/${encodeURIComponent(r.slug)}` });
}, "start a game from a design brief or CSV — owned, committed, validated, live");
gw.route("POST", "/api/claims", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const { author } = await json(ctx);
  if (!author?.trim()) return ctx.send(422, { error: "author string required" });
  if (await q.claimOwner(db, author.trim())) return ctx.send(409, { error: "already claimed" });
  await q.claim(db, u.id, author.trim());
  ctx.send(201, { claimed: author.trim() });
}, "claim a git/playtest author string (DA-7)");
gw.route("PUT", "/api/stars/:slug", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  if (!requireGame(ctx)) return;
  await q.star(db, u.id, ctx.params.slug);
  await q.recordEvent(db, { id: newId("ev"), kind: "star", actor_id: u.id, game_slug: ctx.params.slug });
  ctx.send(200, { starred: true, stars: await q.starCount(db, ctx.params.slug) });
}, "star");
gw.route("DELETE", "/api/stars/:slug", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  if (!requireGame(ctx)) return;
  await q.unstar(db, u.id, ctx.params.slug);
  ctx.send(200, { starred: false, stars: await q.starCount(db, ctx.params.slug) });
}, "unstar");

/* ---------- routes: Store 1 — games (behind the store interface) ---------- */
const catalogSummary = g => ({ slug: g.slug, project_id: g.project_id, namespace: g.namespace,
  repo_slug: g.repo_slug, project_path: publicProjectPath({ namespace: g.namespace, slug: g.repo_slug }),
  title: g.title, description: g.description || "", license: g.license,
  topics: (() => { try { return JSON.parse(g.topics_json || "[]"); } catch { return []; } })(),
  players: g.players_min || g.players_max ? { min: g.players_min, max: g.players_max } : null,
  visibility: g.visibility || "public", cards: [], ncards: g.card_count || 0,
  prs: [], releases: [], updated: g.updated_at ? new Date(Number(g.updated_at)).toISOString().slice(0, 10) : "",
  stars: g.stars, forked_from: g.forked_from ?? null, owner_handle: g.owner_handle ?? null,
  _summary: true });
gw.route("GET", "/api/games", async (ctx) => {
  const u = await authedUser(ctx), visible = [];
  for (const g of await q.listGames(db))
    if (store.has(g.slug) && await canRead(u, g.slug, ctx)) visible.push(g);
  ctx.send(200, visible.map(g => ({ ...catalogSummary(g), cards: g.card_count, _summary: undefined })));
}, "catalog from the rebuildable index (DA-3), star counts included");
gw.route("GET", "/api/adapters", async (ctx) => {
  const stage = ctx.url.searchParams.get("stage"), status = ctx.url.searchParams.get("status");
  ctx.send(200, ADAPTER_CATALOG.filter(adapter => (!stage || adapter.stage === stage) && (!status || adapter.status === status)));
}, "versioned import, working-copy, source, export, and publisher contracts with explicit fidelity limits");
gw.route("GET", "/api/catalog", async (ctx) => {
  const u = await authedUser(ctx), rows = (await q.listGames(db)).filter(row => store.has(row.slug));
  const readablePrivate = new Set();
  for (const row of rows) if (row.visibility !== "public" && await canRead(u, row.slug, ctx)) readablePrivate.add(row.slug);
  const qtext = String(ctx.url.searchParams.get("q") || "").trim().toLowerCase();
  const topic = String(ctx.url.searchParams.get("topic") || "").trim().toLowerCase();
  const license = String(ctx.url.searchParams.get("license") || "").trim().toLowerCase();
  const players = Math.max(0, Number(ctx.url.searchParams.get("players")) || 0);
  const limit = Math.max(1, Math.min(50, Number(ctx.url.searchParams.get("limit")) || 24));
  let offset = 0;
  try { offset = Math.max(0, Number(Buffer.from(ctx.url.searchParams.get("cursor") || "", "base64url").toString()) || 0); } catch {}
  const filtered = rows.filter(row => {
    if (row.visibility !== "public" && !readablePrivate.has(row.slug)) return false;
    const topics = (() => { try { return JSON.parse(row.topics_json || "[]"); } catch { return []; } })();
    if (qtext && !`${row.slug} ${row.namespace || ""}/${row.repo_slug || ""} ${row.title} ${row.description || ""} ${topics.join(" ")}`.toLowerCase().includes(qtext)) return false;
    if (topic && !topics.includes(topic)) return false;
    if (license && String(row.license || "").toLowerCase() !== license) return false;
    if (players && ((row.players_min && players < row.players_min) || (row.players_max && players > row.players_max))) return false;
    return true;
  });
  const items = filtered.slice(offset, offset + limit).map(catalogSummary), next = offset + items.length;
  ctx.send(200, { items, total: filtered.length,
    next_cursor: next < filtered.length ? Buffer.from(String(next)).toString("base64url") : null });
}, "bounded catalog page from the repository-derived search index; no repository fan-out");
gw.route("GET", "/api/games/:slug/ui", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  try {
    // The generated project view can contain release examples inherited from
    // the source tree. Hosted releases live in Store 2 and must replace those
    // examples so a fork never advertises its parent's tags as its own. Keep
    // the cached repository payload immutable: cutting a release does not
    // create a game-source commit and therefore does not change its cache key.
    const game = await uiGame(slug);
    const releases = (await q.releasesFor(db, slug)).slice().reverse().map(release => ({
      tag: release.tag,
      sha: release.sha,
      title: release.title || "",
      notes: release.notes || "",
      date: new Date(Number(release.created_at)).toISOString().slice(0, 10),
      author: release.author_handle || "",
    }));
    ctx.send(200, { ...game, releases });
  }
  catch (error) { ctx.send(500, { error: "could not load this project view", detail: error.message }); }
}, "lazy full project view, cached by exact repository commit");
gw.route("GET", "/api/projects/:namespace/:slug", async (ctx) => {
  const game = await q.gameByProject(db, ctx.params.namespace, ctx.params.slug);
  if (!game || !store.has(game.slug)) return ctx.send(404, { error: "no such project" });
  ctx.send(200, { project_id: game.project_id, namespace: game.namespace,
    slug: game.repo_slug, storage_key: game.slug,
    api: `/api/games/${encodeURIComponent(game.slug)}`,
    path: publicProjectPath({ namespace: game.namespace, slug: game.repo_slug }) });
}, "resolve the public owner/slug identity to an immutable project id");
gw.route("GET", "/api/projects/:namespace/:slug/cards", async (ctx) => {
  const game = await q.gameByProject(db, ctx.params.namespace, ctx.params.slug);
  if (!game || !store.has(game.slug)) return ctx.send(404, { error: "no such project" });
  const cards = JSON.parse((await store.readFile(game.slug, "components/cards.json")).toString());
  const qtext = String(ctx.url.searchParams.get("q") || "").toLowerCase(), type = String(ctx.url.searchParams.get("type") || "").toLowerCase();
  const limit = Math.max(1, Math.min(100, Number(ctx.url.searchParams.get("limit")) || 40));
  let offset = 0;
  try { offset = Math.max(0, Number(Buffer.from(ctx.url.searchParams.get("cursor") || "", "base64url").toString()) || 0); } catch {}
  const filtered = cards.filter(card => (!qtext || `${card.name} ${card.text || ""}`.toLowerCase().includes(qtext))
    && (!type || String(card.type || "").toLowerCase() === type));
  const items = filtered.slice(offset, offset + limit), next = offset + items.length;
  ctx.send(200, { project_id: game.project_id, ref: await store.headSha(game.slug), items, total: filtered.length,
    next_cursor: next < filtered.length ? Buffer.from(String(next)).toString("base64url") : null });
}, "paginated card source for large projects");
async function resolveForkPoint(src, requestedRef) {
  const requested = String(requestedRef ?? "HEAD").trim() || "HEAD";
  if (/^(HEAD|latest)$/i.test(requested)) {
    const sha = await store.headSha(src);
    const sourceYaml = await store.fileAt(src, sha, "game.yaml");
    if (!sourceYaml) throw Object.assign(new Error("the latest source version is unavailable"), { code: 422 });
    return { sha, label: "latest working version", sourceYaml: sourceYaml.toString() };
  }
  const release = await q.releaseByTag(db, src, requested);
  const sha = release?.sha ?? requested;
  // Fork refs are deliberately narrower than general git refs: a release tag
  // is resolved server-side and an explicit version must be a commit id. This
  // keeps the local archive boundary safe and makes every fork reproducible.
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw Object.assign(new Error("fork from 'latest' or a published release/commit"), { code: 422 });
  }
  const sourceYaml = await store.fileAt(src, sha, "game.yaml");
  if (!sourceYaml) throw Object.assign(new Error(`source version '${requested}' is unavailable`), { code: 422 });
  let label = release ? `release ${release.tag}` : `commit ${sha}`;
  if (!release) {
    const releases = await q.releasesFor(db, src);
    const pinned = releases.find(r => r.sha === sha);
    if (pinned) label = `release ${pinned.tag}`;
  }
  return { sha, label, sourceYaml: sourceYaml.toString() };
}
async function doFork(u, src, requestedRef = "HEAD") {
  const sourceGame = await q.gameBySlug(db, src);
  const sourceRepoSlug = sourceGame?.repo_slug || src;
  const repoSlug = `${sourceRepoSlug}-${u.handle}`.slice(0, 60);
  const existing = await q.gameByProject(db, u.handle, repoSlug);
  if (existing) throw Object.assign(new Error(`your edition already exists ('${u.handle}/${repoSlug}')`), { code: 409, existing: existing.slug });
  const newSlug = store.has(repoSlug) ? `${u.handle}~${repoSlug}` : repoSlug;
  const projectId = newId("p");
  const point = await resolveForkPoint(src, requestedRef);
  const srcYaml = point.sourceYaml;
  const title = (srcYaml.match(/^title:\s*"?([^"\n]+)"?/m) ?? [])[1] ?? src;
  const lic = (srcYaml.match(/^license:\s*(\S+)/m) ?? [])[1] ?? "unknown";
  const transform = (yaml) => {
    let out = yaml.replace(/^id:\s*\S+/m, `id: ${repoSlug}`);
    if (!/^attribution:/m.test(out)) {
      out = out.trimEnd() + `\nattribution:\n  source_id: ${src}\n  source_title: ${JSON.stringify(title)}\n  source_license: ${lic}\n  source_ref: ${JSON.stringify(point.sha)}\n  note: ${JSON.stringify(`Forked from ${point.label}; this edition is independent unless its owner proposes changes upstream.`)}\n`;
    }
    return out;
  };
  const sourceRights = await store.fileAt(src, point.sha, RIGHTS_MANIFEST);
  const forkRights = forkRightsManifest(sourceRights, { license: lic, owner: u.handle,
    sourceProject: src, sourceRef: point.sha });
  const { sha } = await store.fork(src, newSlug, transform,
    `fork: ${src}@${point.sha} → ${newSlug} by ${u.handle}\n\nsource-version: ${point.sha}\nsource-label: ${point.label}\nattribution committed per SPEC §9`,
    `${u.handle} <${u.email}>`, point.sha,
    projectMetaBytes({ storageKey: newSlug, projectId, namespace: u.handle, slug: repoSlug }),
    [...collaborationFiles(u.handle),
      { path: ".gitattributes", content: "assets/** filter=lfs diff=lfs merge=lfs -text\n" },
      { path: RIGHTS_MANIFEST, content: rightsReceiptBytes(forkRights) }]);
  await reindexGames();
  await q.setForkMeta(db, newSlug, src, u.id);
  return { slug: newSlug, repo_slug: repoSlug, namespace: u.handle, project_id: projectId,
    sha, source_ref: point.sha, source_label: point.label };
}
async function ensureUserFork(u, src) {
  const sourceGame = await q.gameBySlug(db, src);
  const sourceRepoSlug = sourceGame?.repo_slug || src;
  const repoSlug = `${sourceRepoSlug}-${u.handle}`.slice(0, 60);
  const existing = await q.gameByProject(db, u.handle, repoSlug);
  if (!existing) return (await doFork(u, src)).slug;
  if (existing.owner_id !== u.id)
    throw Object.assign(new Error(`'${u.handle}/${repoSlug}' exists and is not yours`), { code: 409 });
  if (existing.forked_from !== src)
    throw Object.assign(new Error(`'${u.handle}/${repoSlug}' is not an edition of '${src}'`), { code: 409 });
  return existing.slug;
}
gw.route("POST", "/api/games/:slug/fork", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const src = requireGame(ctx); if (!src) return;
  try {
    const body = await optionalJson(ctx);
    const f = await doFork(u, src, body.ref ?? "HEAD");
    await q.recordEvent(db, { id: newId("ev"), kind: "fork", actor_id: u.id, game_slug: f.slug, target: src });
    const _og = await q.gameBySlug(db, src);
    if (_og?.owner_id && _og.owner_id !== u.id) await q.notify(db, { id: newId("n"), user_id: _og.owner_id, kind: "fork", actor_handle: u.handle, game_slug: src, target: f.slug });
    ctx.send(201, { slug: f.slug, repo_slug: f.repo_slug, namespace: f.namespace,
      project_id: f.project_id, forked_from: src, source_ref: f.source_ref,
      source_label: f.source_label, commit: f.sha,
      url: `/#${publicProjectPath({ namespace: f.namespace, slug: f.repo_slug })}` });
  } catch (e) { ctx.send(e.code ?? 500, { error: e.message,
      ...(e.existing ? { existing: e.existing, url: `/#/g/${e.existing}` } : {}) }); }
}, "create an independent edition from an exact version: copy → attribution → commit → indexed lineage");
gw.route("POST", "/api/games/:slug/cards/propose", async (ctx) => {
  // THE NO-ACCESS EDIT PATH: your edit becomes a commit in YOUR fork + a PR here
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const bodyIn = await json(ctx);
  const cards = Array.isArray(bodyIn) ? bodyIn : bodyIn.cards;
  const prTitle = (!Array.isArray(bodyIn) && bodyIn.title) || null;
  const before = JSON.parse((await store.readFile(slug, "components/cards.json")).toString());
  const changes = diffCards(before, cards ?? []);
  if (!changes.length) return ctx.send(422, { error: "no changes to propose" });
  let forkSlug;
  try { forkSlug = await ensureUserFork(u, slug); }
  catch (error) { return ctx.send(error.code ?? 500, { error: error.message }); }
  const content = JSON.stringify(cards, null, 2) + "\n";
  const v = await validateCandidate(forkSlug, "components/cards.json", content);
  if (!v.ok) return ctx.send(422, { error: "validation failed", report: v.report });
  const auto = summarize(changes);
  const { sha } = await store.writeFiles(forkSlug, [{ path: "components/cards.json", content }],
    `${auto.title}\n\n${auto.body}`, `${u.handle} <${u.email}>`);
  const id = newId("pr");
  await q.createPr(db, { id, to_slug: slug, from_slug: forkSlug,
    title: prTitle ?? auto.title, body: null, author_id: u.id,
    base: JSON.stringify(before), proposed: JSON.stringify(cards) });
  ctx.send(201, { proposed: true, pr: id, fork: forkSlug, commit: sha, message: auto.title, changes });
}, "edit without access → auto-fork, commit to your fork, PR opened for review");
gw.route("GET", "/api/games/:slug/access", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  const g = await q.gameBySlug(db, slug);
  const owner = g?.owner_id ?? null;
  ctx.send(200, { authed: !!u,
    canWrite: await canWrite(u, slug),
    canReview: await canReview(u, slug),
    canMerge: await canAdmin(u, slug),
    canRelease: await canAdmin(u, slug, { releases: true }),
    role: u ? (owner === u.id ? "owner" : await q.collaboratorRole(db, slug, u.id)) : null,
    isOwner: !!(u && owner && owner === u.id),
    ownerless: !owner,
    sandbox: !owner });   // explicit, UI-facing name for the same fact: no owner = open sandbox
}, "can the current user commit here directly? (editor picks commit vs propose) -- sandbox:true means any signed-in user can write/merge/close here directly");
gw.route("GET", "/api/games/:slug/collaborators", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  ctx.send(200, await q.collaboratorsOf(db, slug));
}, "who has commit access (besides the owner)");
gw.route("PUT", "/api/games/:slug/collaborators/:handle", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const g = await q.gameBySlug(db, slug);
  if (g?.owner_id !== u.id) return ctx.send(403, { error: "only the owner manages access" });
  const target = await q.userByHandle(db, ctx.params.handle);
  if (!target) return ctx.send(404, { error: `no user '${ctx.params.handle}'` });
  if (target.id === u.id) return ctx.send(422, { error: "you already own this game" });
  const body = await optionalJson(ctx), role = body.role || "maintainer";
  if (!validCollaboratorRole(role)) return ctx.send(422, { error: "role must be commenter, contributor, or maintainer" });
  const existing = await q.collaboratorsOf(db, slug);
  const maintainers = existing.filter(c => c.role === "maintainer" && c.handle !== target.handle).map(c => c.handle);
  if (role === "maintainer") maintainers.push(target.handle);
  await store.writeFiles(slug, collaborationFiles(u.handle, maintainers),
    `access: ${role} ${target.handle}\n\nCODEOWNERS and collaboration policy updated`, `${u.handle} <${u.email}>`);
  await q.addCollaborator(db, slug, target.id, u.id, role);
  await q.recordEvent(db, { id: newId("ev"), kind: "collaborator_grant", actor_id: u.id, game_slug: slug, target: `${target.handle}:${role}` });
  ctx.send(200, { granted: ctx.params.handle, role, capabilities: roleCapabilities(role), collaborators: await q.collaboratorsOf(db, slug) });
}, "owner grants an explicit commenter, contributor, or maintainer role");
gw.route("DELETE", "/api/games/:slug/collaborators/:handle", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const g = await q.gameBySlug(db, slug);
  if (g?.owner_id !== u.id) return ctx.send(403, { error: "only the owner manages access" });
  const target = await q.userByHandle(db, ctx.params.handle);
  if (!target) return ctx.send(404, { error: `no user '${ctx.params.handle}'` });
  const remaining = (await q.collaboratorsOf(db, slug)).filter(c => c.handle !== target.handle && c.role === "maintainer").map(c => c.handle);
  await store.writeFiles(slug, collaborationFiles(u.handle, remaining),
    `access: remove ${target.handle}\n\nCODEOWNERS and collaboration policy updated`, `${u.handle} <${u.email}>`);
  await q.removeCollaborator(db, slug, target.id);
  await q.recordEvent(db, { id: newId("ev"), kind: "collaborator_revoke", actor_id: u.id, game_slug: slug, target: target.handle });
  ctx.send(200, { revoked: ctx.params.handle, collaborators: await q.collaboratorsOf(db, slug) });
}, "owner revokes direct-commit access");
gw.route("GET", "/api/games/:slug", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const r = py("stats.py", [await store.dir(slug), "--json"]);
  ctx.send(200, { slug, stats: JSON.parse(r.stdout || "{}") });
}, "game meta + design/playtest stats");
gw.route("GET", "/api/games/:slug/cards", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  ctx.send(200, JSON.parse((await store.readFile(slug, "components/cards.json")).toString()));
}, "card data");
gw.route("GET", "/api/games/:slug/printings", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  ctx.send(200, JSON.parse((await store.readFile(slug, "components/printings.json")).toString()));
}, "printing/edition data");
gw.route("PUT", "/api/games/:slug/cards", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const incoming = await json(ctx);
  const before = JSON.parse((await store.readFile(slug, "components/cards.json")).toString());
  const changes = diffCards(before, incoming);
  if (!changes.length) return ctx.send(200, { saved: false, message: "no changes" });
  const content = JSON.stringify(incoming, null, 2) + "\n";
  const v = await validateCandidate(slug, "components/cards.json", content);
  if (!v.ok) return ctx.send(422, { saved: false, error: "validation failed", report: v.report });
  const auto = summarize(changes);
  const { sha } = await store.writeFiles(slug, [{ path: "components/cards.json", content }],
    `${auto.title}\n\n${auto.body}`, `${u.handle} <${u.email}>`);
  ctx.send(200, { saved: true, commit: sha, message: auto.title, changes });
}, "edit cards: validate candidate → commit w/ auto message (live tree never dirty)");
// EDITABLE ARTIFACTS beyond cards: rules, community, design notes, metadata.
// Same access + validate-candidate + commit discipline; cards keep their own
// semantic-diff route. Path is allowlisted — no arbitrary repo writes.
const ARTIFACTS = {
  "rules/rules.md":     { label: "rulebook",       msg: "rules: update rulebook" },
  "community.yaml":     { label: "community",      msg: "community: update governance & credits" },
  "design/notes.md":    { label: "design notes",   msg: "design: update notes" },
  "game.yaml":          { label: "game metadata",  msg: "meta: update game info" },
};
gw.route("PUT", "/api/games/:slug/artifact", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const { path, content } = await json(ctx);
  const spec = ARTIFACTS[path];
  if (!spec) return ctx.send(422, { error: `not an editable artifact: ${path}`, editable: Object.keys(ARTIFACTS) });
  if (typeof content !== "string") return ctx.send(422, { error: "content must be a string" });
  const before = (await store.readFile(slug, path))?.toString() ?? "";
  if (before === content) return ctx.send(200, { saved: false, message: "no changes" });
  const v = await validateCandidate(slug, path, content);
  if (!v.ok) return ctx.send(422, { saved: false, error: "validation failed", report: v.report });
  const { sha } = await store.writeFiles(slug, [{ path, content }], spec.msg, `${u.handle} <${u.email}>`);
  ctx.send(200, { saved: true, commit: sha, message: spec.msg, artifact: spec.label });
}, "edit a non-card artifact (rules, community, design, metadata) → validated commit");

gw.route("GET", "/api/games/:slug/prototype", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const raw = await store.readFile(slug, "design/prototype.json");
  if (!raw) return ctx.send(404, { error: "this game has no runnable prototype yet" });
  ctx.send(200, JSON.parse(raw.toString()));
}, "current low-fidelity test plan");

gw.route("PUT", "/api/games/:slug/prototype", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const prototype = await json(ctx);
  if (!prototype || typeof prototype !== "object" || Array.isArray(prototype))
    return ctx.send(422, { error: "prototype must be an object" });
  if (prototype.players?.min > prototype.players?.max)
    return ctx.send(422, { error: "maximum players must be at least minimum players" });
  const content = JSON.stringify(prototype, null, 2) + "\n";
  const before = (await store.readFile(slug, "design/prototype.json"))?.toString() ?? "";
  if (before === content) return ctx.send(200, { saved: false, message: "no changes" });

  // Creating the first runnable test advances the brief's lifecycle in the
  // same atomic commit. Intent and implementation can never disagree about
  // whether a prototype exists.
  const extra = {};
  const files = [{ path: "design/prototype.json", content }];
  const briefRaw = await store.readFile(slug, "design/brief.json");
  let briefStatus = null;
  if (briefRaw) {
    const brief = JSON.parse(briefRaw.toString());
    if (brief.status === "idea") brief.status = "prototype";
    briefStatus = brief.status;
    const briefContent = JSON.stringify(brief, null, 2) + "\n";
    extra["design/brief.json"] = briefContent;
    files.push({ path: "design/brief.json", content: briefContent });
  }
  const v = await validateCandidate(slug, "design/prototype.json", content, extra);
  if (!v.ok) return ctx.send(422, { saved: false, error: "prototype failed validation", report: v.report });
  const question = String(prototype.question || "first playable test").replace(/\s+/g, " ").slice(0, 100);
  const { sha } = await store.writeFiles(slug, files,
    `prototype: define iteration ${prototype.iteration || 1}\n\nQuestion: ${question}\nMaterials: ${(prototype.materials || []).length}`,
    `${u.handle} <${u.email}>`);
  ctx.send(200, { saved: true, commit: sha, iteration: prototype.iteration || 1,
    materials: (prototype.materials || []).length, brief_status: briefStatus });
}, "commit a validated runnable prototype and advance the design brief atomically");
// VISUAL CARD DESIGN EDITOR (tools/hub_template.html's "Card design" tab): drag-and-drop
// boxes onto a live card, bound to data fields by name -- writes the SAME templates/
// layout.yaml the rest of the engine already reads (schemas/layout.schema.json,
// layoutCard() in tools/hub_template.html). There is no YAML library in this Node
// runtime, so layoutToYaml() below is a small deterministic serializer scoped to
// exactly this schema's shape (block top-level keys, flow-map list items) -- the
// same style examples/arcmage/templates/layout.yaml is hand-authored in, and
// ordinary valid YAML (PyYAML/tools/build_hub.py + tools/validate.py need no
// changes to read it). The browser has a matching desYamlStringify() (used by the
// editor's raw-YAML power-user view) -- intentionally duplicated rather than
// shared, but both MUST stay format-compatible; a round-trip smoke test covers this.
const LAYOUT_FONT_KEYS = ["id", "family", "weight", "style"];
const LAYOUT_ROW_CELL_KEYS = ["key", "label", "font", "size_pt", "color", "show_if"];
const LAYOUT_REGION_KEYS = ["id", "type", "x", "y", "w", "h", "d", "shape", "src", "fallback_srcs", "text", "map", "glyph", "max", "credit", "fit",
  "font", "size_pt", "min_size_pt", "align", "valign", "color", "bg", "uppercase", "symbols",
  "autoshrink", "fill", "stroke", "stroke_w_mm", "radius_mm", "opacity", "gap_mm", "of", "show_if"];
function layoutYamlScalarStr(s) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s)) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
function layoutYamlVal(v, key) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (key === "of") return "[" + v.map(cell => layoutYamlFlowMap(cell, LAYOUT_ROW_CELL_KEYS)).join(", ") + "]";
    return "[" + v.map(x => layoutYamlVal(x)).join(", ") + "]";
  }
  if (typeof v === "object") return layoutYamlFlowMapRaw(v);
  return layoutYamlScalarStr(String(v));
}
function layoutYamlFlowMap(obj, order) {
  const keys = [...order.filter(k => obj[k] !== undefined && obj[k] !== null),
                ...Object.keys(obj).filter(k => !order.includes(k) && obj[k] !== undefined && obj[k] !== null)];
  return "{ " + keys.map(k => `${k}: ${layoutYamlVal(obj[k], k)}`).join(", ") + " }";
}
function layoutYamlFlowMapRaw(o) {
  return "{ " + Object.keys(o).map(k => `${layoutYamlScalarStr(String(k))}: ${layoutYamlScalarStr(String(o[k]))}`).join(", ") + " }";
}
/** Deterministic layout object -> layout.yaml text. Mirrors desYamlStringify() in
 *  tools/hub_template.html (browser twin, backs the raw-YAML power-user toggle). */
function layoutToYaml(layout) {
  const L = layout || {};
  const out = [];
  const card = L.card || {};
  out.push("card:");
  for (const k of ["w_mm", "h_mm", "bleed_mm", "radius_mm", "bg"])
    if (card[k] !== undefined && card[k] !== null) out.push(`  ${k}: ${layoutYamlVal(card[k])}`);
  out.push("");
  if (Array.isArray(L.fonts) && L.fonts.length) {
    out.push("fonts:");
    for (const f of L.fonts) out.push(`  - ${layoutYamlFlowMap(f, LAYOUT_FONT_KEYS)}`);
    out.push("");
  }
  if (L.palette && L.palette.by) {
    out.push("palette:");
    out.push(`  by: ${layoutYamlVal(L.palette.by)}`);
    if (L.palette.map) out.push(`  map: ${layoutYamlFlowMapRaw(L.palette.map)}`);
    if (L.palette.default !== undefined) out.push(`  default: ${layoutYamlVal(L.palette.default)}`);
    out.push("");
  }
  out.push("regions:");
  for (const r of (L.regions || [])) out.push(`  - ${layoutYamlFlowMap(r, LAYOUT_REGION_KEYS)}`);
  return out.join("\n") + "\n";
}
gw.route("PUT", "/api/games/:slug/layout", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const { layout } = await json(ctx);
  if (!layout || typeof layout !== "object" || Array.isArray(layout))
    return ctx.send(422, { error: "body must be {layout: <object>}" });
  if (!layout.card || typeof layout.card !== "object" || typeof layout.card.w_mm !== "number" || typeof layout.card.h_mm !== "number")
    return ctx.send(422, { error: "layout.card.w_mm and layout.card.h_mm are required" });
  if (!Array.isArray(layout.regions))
    return ctx.send(422, { error: "layout.regions must be an array" });
  const content = layoutToYaml(layout);
  const before = (await store.readFile(slug, "templates/layout.yaml"))?.toString() ?? "";
  if (before === content) return ctx.send(200, { saved: false, message: "no changes" });
  const v = await validateCandidate(slug, "templates/layout.yaml", content);
  if (!v.ok) return ctx.send(422, { saved: false, error: "validation failed", report: v.report });
  const { sha } = await store.writeFiles(slug, [{ path: "templates/layout.yaml", content }],
    "layout: update card design", `${u.handle} <${u.email}>`);
  ctx.send(200, { saved: true, commit: sha, message: "layout: update card design" });
}, "visual card-design editor: validated commit of templates/layout.yaml");
gw.route("PUT", "/api/games/:slug/art", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const { printing_id, art, artist, license, source } = await json(ctx);
  if (!printing_id) return ctx.send(422, { error: "printing_id required" });
  if (art && (!art.startsWith("assets/") || art.includes(".."))) return ctx.send(422, { error: "art must be a path under assets/ (upload it first via POST /assets)" });
  const printings = JSON.parse((await store.readFile(slug, "components/printings.json")).toString());
  const p = printings.find(x => x.id === printing_id);
  if (!p) return ctx.send(404, { error: `no printing '${printing_id}'` });
  if (art) {
    let asset = null; try { asset = await store.readFile(slug, art); } catch {}
    if (!asset) return ctx.send(422, { error: `asset not found in the repo: ${art} (upload it first via POST /assets)` });
    p.art = art;
  }
  if (artist) p.artist = artist;
  if (artist || license || source) {
    const prov = { ...(p.provenance || {}) };
    prov.source = source || prov.source || "human";
    if (artist) prov.creator = artist;
    if (license) prov.license = license;
    p.provenance = prov;
  }
  const content = JSON.stringify(printings, null, 2) + "\n";
  const v = await validateCandidate(slug, "components/printings.json", content);
  if (!v.ok) return ctx.send(422, { error: "printings failed validation", report: v.report });
  const writes = [{ path: "components/printings.json", content }];
  if (art && (artist || license || source)) {
    const game = await q.gameBySlug(db, slug);
    const currentRights = await store.readFile(slug, RIGHTS_MANIFEST);
    const rights = setFileRight(currentRights, art, { license: license || game?.license || "unknown",
      status: license ? "licensed" : "original", copyright: [artist || u.handle],
      redistribution: license ? "allowed" : "restricted", source },
    { license: game?.license || "unknown", owner: game?.owner_handle || u.handle, status: "unknown" });
    writes.push({ path: RIGHTS_MANIFEST, content: rightsReceiptBytes(rights) });
  }
  const { sha } = await store.writeFiles(slug, writes,
    `art: ${art ? "assign " + art : "credit"} on ${printing_id}`, `${u.handle} <${u.email}>`);
  if (writes.some(write => write.path === RIGHTS_MANIFEST)) await reindexGames();
  ctx.send(200, { saved: true, commit: sha, printing_id, art: p.art ?? null, artist: p.artist ?? null });
}, "assign uploaded art + credit/provenance to a printing — credit follows the work (SPEC §9)");

gw.route("GET", "/api/games/:slug/rules/pipeline", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  let loaded;
  try { loaded = loadRulebookPipeline(await store.dir(slug)); }
  catch (error) { return ctx.send(422, { error: error.message }); }
  if (!loaded) return ctx.send(200, { connected: false, legacy: "rules/rules.md" });
  const ref = await store.headSha(slug), key = cache.exportKey(slug, ref, "rulebook-build.json");
  let build = null;
  if (cache.has(key)) {
    try { build = JSON.parse(cache.get(key).toString("utf8")); } catch {}
  }
  const u = await authedUser(ctx);
  ctx.send(200, { connected: true, ref, ...rulebookPipelineMetadata(loaded), build,
    access: { signed_in: !!u, can_write: await canWrite(u, slug), requires_fork: !!u && !await canWrite(u, slug) } });
}, "native rulebook source lock, overlays, outputs, and immutable build status");

gw.route("GET", "/api/games/:slug/rules/publication", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  let loaded;
  try { loaded = loadRulebookPublication(await store.dir(slug)); }
  catch (error) { return ctx.send(422, { error: error.message }); }
  if (!loaded) return ctx.send(200, { connected: false });
  const ref = await store.headSha(slug), key = cache.exportKey(slug, ref, "publication-build.json");
  let build = null;
  if (cache.has(key)) {
    try { build = JSON.parse(cache.get(key).toString("utf8")); } catch {}
  }
  const u = await authedUser(ctx), writable = await canWrite(u, slug);
  ctx.send(200, { connected: true, ref, ...rulebookPublicationMetadata(loaded, { includeDocument: true }), build,
    access: { signed_in: !!u, can_write: writable, requires_fork: !!u && !writable } });
}, "designed rulebook pages, editor adapters, dependencies, outputs, and immutable build status");

gw.route("GET", "/api/games/:slug/repository/assets", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  const dir = await store.dir(slug);
  const all = walkRepo(dir);
  const reusable = all.filter(item => isReusablePath(item.path));
  // Usage is deliberately derived from repository source, never maintained as
  // a second database. A rename that forgets a reference becomes visibly unused.
  const searchable = all.filter(item => isRepoText(item.path) && item.size <= 2_000_000)
    .map(item => { try { return { path: item.path, text: readFileSync(item.full, "utf8") }; } catch { return null; } })
    .filter(Boolean);
  const items = reusable.map(item => {
    const used_by = searchable.filter(source => source.path !== item.path && source.text.includes(item.path))
      .map(source => source.path).slice(0, 12);
    return { path: item.path, name: item.path.split("/").pop(), size: item.size,
      extension: repoExt(item.path), category: repoCategory(item.path), kind: repoKind(item.path),
      previewable: REPO_IMAGE_EXTS.has(repoExt(item.path)) || REPO_AUDIO_EXTS.has(repoExt(item.path)),
      editable: isRepoText(item.path), used_by,
      url: `/api/games/${encodeURIComponent(slug)}/repository/file/${item.path.split("/").map(encodeURIComponent).join("/")}` };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
  const categories = Object.entries(items.reduce((out, item) => {
    out[item.category] = (out[item.category] || 0) + 1; return out;
  }, {})).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  ctx.send(200, { slug, commit: await store.headSha(slug), count: items.length, categories, items,
    access: { signed_in: !!u, can_write: await canWrite(u, slug), requires_fork: !!u && !await canWrite(u, slug) } });
}, "inventory every reusable repository asset with category, usage, and editability");

gw.route("GET", "/api/games/:slug/repository/history/*", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const path = ctx.params["*"];
  if (!isReusablePath(path)) return ctx.send(404, { error: "not a reusable game asset" });
  ctx.send(200, { path, history: await store.history(slug, path, 30) });
}, "file-level Git history for a reusable asset or design file");

gw.route("GET", "/api/games/:slug/repository/file/*", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const path = ctx.params["*"];
  if (!isReviewablePath(path)) return ctx.send(404, { error: "not a reviewable game source file" });
  const ref = ctx.url.searchParams.get("ref");
  let buf = null, cleanup = null;
  try {
    if (!ref || ref === "HEAD") {
      buf = path.startsWith("assets/") ? await store.getAsset(slug, path) : await store.readFile(slug, path);
    } else {
      const materialized = await store.materialize(slug, ref);
      cleanup = materialized.cleanup;
      const full = join(materialized.dir, path);
      if (existsSync(full) && statSync(full).isFile()) buf = readFileSync(full);
    }
    if (!buf) return ctx.send(404, { error: "no such file at this version" });
    const ext = repoExt(path);
    ctx.sendRaw(200, buf, { "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": ref ? "public, max-age=31536000, immutable" : "no-cache",
      "content-disposition": `inline; filename="${path.split("/").pop().replace(/[\"\\]/g, "")}"` });
  } finally { if (cleanup) cleanup(); }
}, "serve a reusable file from current HEAD or an exact historical ref");

gw.route("PUT", "/api/games/:slug/repository/file/*", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const path = ctx.params["*"];
  if (!isReviewablePath(path) || !isRepoText(path))
    return ctx.send(422, { error: "only reviewable text, SVG, JSON, YAML, Markdown, and CSS game-source files can be edited here" });
  if (path === "components/cards.json")
    return ctx.send(422, { error: "edit cards through the semantic card endpoint so Forge can generate a card diff" });
  const { content, message } = await json(ctx);
  if (typeof content !== "string") return ctx.send(422, { error: "content must be text" });
  if (Buffer.byteLength(content) > 1_500_000) return ctx.send(413, { error: "text asset is too large for the browser editor" });
  if (path.toLowerCase().endsWith(".svg")) {
    try { inspectSvg(content); } catch (error) { return ctx.send(error.status || 422, { error: error.message }); }
  }
  const before = (await store.readFile(slug, path))?.toString() ?? "";
  if (before === content) return ctx.send(200, { saved: false, message: "no changes" });
  const validation = await validateCandidate(slug, path, content);
  if (!validation.ok) return ctx.send(422, { error: "candidate failed game validation", report: validation.report });
  const cleanMessage = String(message || `assets: update ${path}`).replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  const { sha } = await store.writeFiles(slug, [{ path, content }], cleanMessage, `${u.handle} <${u.email}>`);
  ctx.send(200, { saved: true, path, commit: sha, message: cleanMessage });
}, "edit a reusable text/design asset as a validated Git commit");

gw.route("POST", "/api/games/:slug/assets", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const rel = ctx.url.searchParams.get("path");
  if (!rel || !rel.startsWith("assets/") || rel.includes("..")) return ctx.send(400, { error: "path must be under assets/ (SPEC §7)" });
  const buf = await readBody(ctx.req, MAX_ASSET_BYTES + 1);
  try { assertAssetAllowed(rel, buf.length); inspectAsset(rel, buf); }
  catch (e) { return ctx.send(e.status || 422, { error: e.message }); }
  const status = ctx.url.searchParams.get("rights_status") || "unknown";
  const allowedStatuses = new Set(["original", "commissioned", "licensed", "public-domain", "permission-only", "unknown"]);
  if (!allowedStatuses.has(status)) return ctx.send(422, { error: "rights_status is invalid" });
  const game = await q.gameBySlug(db, slug), creator = ctx.url.searchParams.get("creator") || u.handle;
  const license = ctx.url.searchParams.get("license") || game?.license || "unknown";
  const rights = setFileRight(await store.readFile(slug, RIGHTS_MANIFEST), rel,
    { license, status, copyright: [creator],
      redistribution: ctx.url.searchParams.get("redistribution") || (status === "unknown" ? "private-only" : "allowed"),
      source: ctx.url.searchParams.get("source") || undefined },
    { license: game?.license || "unknown", owner: game?.owner_handle || u.handle, status: "unknown" });
  const { mode, oid, sha } = await store.putAsset(slug, rel, buf, `${u.handle} <${u.email}>`,
    [{ path: RIGHTS_MANIFEST, content: rightsReceiptBytes(rights) }]);
  await reindexGames(); // unknown/private-only uploads immediately leave public discovery and direct anonymous access
  ctx.send(200, { saved: true, path: rel, mode, oid, commit: sha, rights_status: status });
}, "upload asset: LFS batch → pointer committed (the SPEC §7 write path)");

gw.route("GET", "/api/games/:slug/rights", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const ref = ctx.url.searchParams.get("ref") || "HEAD";
  const materialized = await store.materialize(slug, ref);
  try { ctx.send(200, auditRights(materialized.dir, { sourceSha: await store.headSha(slug) })); }
  finally { materialized.cleanup(); }
}, "audit every source file against the repository rights manifest");

gw.route("PUT", "/api/games/:slug/rights", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const game = await q.gameBySlug(db, slug);
  if (game?.owner_id && game.owner_id !== u.id)
    return ctx.send(403, { error: "only the project owner can make a rights declaration" });
  const body = await json(ctx), path = String(body.path || "");
  if (!isReviewablePath(path) || path === RIGHTS_MANIFEST || path === "forge/project.json")
    return ctx.send(422, { error: "path must name an existing reviewable project file" });
  if (!await store.readFile(slug, path)) return ctx.send(404, { error: `no file '${path}'` });
  const status = String(body.status || "unknown");
  if (!["original", "commissioned", "licensed", "public-domain", "permission-only", "unknown", "generated"].includes(status))
    return ctx.send(422, { error: "invalid rights status" });
  const copyright = Array.isArray(body.copyright) ? body.copyright.map(value => String(value).trim()).filter(Boolean) : [];
  if (!copyright.length) return ctx.send(422, { error: "at least one copyright holder or credit is required" });
  const redistribution = String(body.redistribution || (status === "unknown" ? "private-only" : "allowed"));
  if (!["allowed", "restricted", "private-only"].includes(redistribution))
    return ctx.send(422, { error: "invalid redistribution status" });
  const rights = setFileRight(await store.readFile(slug, RIGHTS_MANIFEST), path,
    { license: String(body.license || game?.license || "unknown"), status, copyright, redistribution,
      source: body.source ? String(body.source) : undefined, notes: body.notes ? String(body.notes) : undefined },
    { license: game?.license || "unknown", owner: u.handle, status: "unknown" });
  const content = rightsReceiptBytes(rights);
  const validation = await validateCandidate(slug, RIGHTS_MANIFEST, content);
  if (!validation.ok) return ctx.send(422, { error: "rights manifest failed validation", report: validation.report });
  const { sha } = await store.writeFiles(slug, [{ path: RIGHTS_MANIFEST, content }],
    `rights: declare ${path}`, `${u.handle} <${u.email}>`);
  await q.recordEvent(db, { id: newId("ev"), kind: "rights_declaration", actor_id: u.id, game_slug: slug, target: path });
  await reindexGames();
  ctx.send(200, { saved: true, commit: sha, path, rights: auditRights(await store.dir(slug), { sourceSha: sha }) });
}, "owner records an auditable per-file license, credit, and redistribution declaration");
gw.route("GET", "/api/games/:slug/assets/*", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const rel = ctx.params["*"];
  if (rel.includes("..")) return ctx.send(404, { error: "no such asset" });
  let buf;
  try { buf = await store.getAsset(slug, `assets/${rel}`); }
  catch (e) { return ctx.send(502, { error: e.message }); }
  if (!buf) return ctx.send(404, { error: "no such asset" });
  ctx.sendRaw(200, buf, { "content-type": MIME[rel.toLowerCase().split(".").pop()] ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable" });
}, "serve asset, materializing LFS pointers");

/* ---------- Affinity — committed data -> native production document ----------
 * Local Affinity is intentionally a derived worker, not Store 1. The bridge
 * input is generated from Git HEAD and its status names the exact commit it
 * rendered. Forge only advertises a preview when those identities match. */
function affinityBridgeOf(gameDir) {
  const configPath = join(gameDir, "templates", "affinity", "forge-affinity.json");
  if (!existsSync(configPath)) return { configured: false, bridgeDir: null };
  let config;
  try { config = JSON.parse(readFileSync(configPath, "utf8")); }
  catch { return { configured: true, bridgeDir: null, error: "invalid Affinity binding config" }; }
  const raw = config.bridge_dir || ".forge/affinity";
  const bridgeDir = raw === "~" ? homedir() : raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : resolve(gameDir, raw);
  // A game config is contributor-controlled. It may expose its own derived
  // worker state or Forge's dedicated Desktop exchange, never arbitrary files.
  const allowedRoots = [resolve(gameDir), resolve(homedir(), "Desktop", "Forge Affinity")];
  const allowed = allowedRoots.some(root => bridgeDir === root || bridgeDir.startsWith(root + sep));
  return allowed ? { configured: true, bridgeDir } : { configured: true, bridgeDir: null, error: "unsafe Affinity bridge_dir" };
}

gw.route("GET", "/api/games/:slug/affinity", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  if (STORE1 !== "local") return ctx.send(200, { enabled: false, reason: "local Affinity worker only" });
  const gameDir = await store.dir(slug);
  const bridge = affinityBridgeOf(gameDir);
  const { configured, bridgeDir } = bridge;
  if (bridge.error) return ctx.send(200, { enabled: true, state: "bad_config", error: bridge.error });
  if (!configured || !bridgeDir) return ctx.send(200, { enabled: false, state: "disabled" });
  const inputPath = join(bridgeDir, "input.json");
  const statusPath = join(bridgeDir, "status.json");
  if (!existsSync(inputPath)) return ctx.send(200, { enabled: configured, state: configured ? "not_prepared" : "disabled" });
  let input, status = null;
  try { input = JSON.parse(readFileSync(inputPath, "utf8")); }
  catch { return ctx.send(200, { enabled: true, state: "bad_input" }); }
  try { if (existsSync(statusPath)) status = JSON.parse(readFileSync(statusPath, "utf8")); } catch { /* visible below */ }
  const current = !!(status && status.state === "ready" && status.commit_sha === input.commit_sha
    && status.input_hash === input.input_hash && status.card_id === input.card?.id);
  const file = status?.preview_file;
  const safeFile = typeof file === "string" && /^[a-z0-9_.-]+\.png$/i.test(file) ? file : null;
  const previewPath = current && safeFile ? join(bridgeDir, "renders", input.commit_sha, safeFile) : null;
  const previewReady = !!(previewPath && existsSync(previewPath));
  ctx.send(200, {
    enabled: true,
    state: status?.state ?? "waiting_for_affinity",
    current: current && previewReady,
    game: input.game,
    card_id: input.card?.id,
    printing_id: input.printing_id,
    commit_sha: input.commit_sha,
    commit_short: input.commit_short,
    applied_fields: status?.applied_fields ?? [],
    reproducible: input.provenance?.reproducible !== false,
    layout_source: input.provenance?.layout_source ?? "unknown",
    error: status?.state === "error" ? status.error : null,
    updated_at: status?.updated_at ?? null,
    preview_url: current && previewReady
      ? `/api/games/${encodeURIComponent(slug)}/affinity/previews/${input.commit_sha}/${encodeURIComponent(safeFile)}?input=${encodeURIComponent(input.input_hash)}`
      : null,
  });
}, "Affinity production render status, pinned to exact Forge commit");

gw.route("GET", "/api/games/:slug/affinity/previews/:sha/:file", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  if (STORE1 !== "local") return ctx.send(404, { error: "local Affinity worker only" });
  const { sha, file } = ctx.params;
  if (!/^[0-9a-f]{40}$/i.test(sha) || !/^[a-z0-9_.-]+\.png$/i.test(file)) return ctx.send(404, { error: "bad Affinity preview identity" });
  const gameDir = await store.dir(slug);
  const bridge = affinityBridgeOf(gameDir);
  if (!bridge.bridgeDir || bridge.error) return ctx.send(404, { error: "Affinity bridge is not configured safely" });
  const path = join(bridge.bridgeDir, "renders", sha, file);
  if (!existsSync(path)) return ctx.send(404, { error: "Affinity has not rendered this commit" });
  ctx.sendRaw(200, readFileSync(path), {
    "content-type": "image/png",
    "cache-control": "public, max-age=31536000, immutable",
  });
}, "Affinity PNG at exact Forge commit and production input");

gw.route("GET", "/api/games/:slug/history", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const at = async (ref) => {
    const b = await store.fileAt(slug, ref, "components/cards.json");
    try { return b ? JSON.parse(b.toString()) : []; } catch { return []; }
  };
  const hist = await store.history(slug, "components/cards.json", 20);
  ctx.send(200, await Promise.all(hist.map(async h => ({
    sha: h.sha, author: h.author, date: h.date, subject: h.subject,
    changes: diffCards(await at(`${h.full}^`), await at(h.full)) }))));
}, "git log as semantic card changes");
gw.route("GET", "/api/games/:slug/stats", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const r = py("stats.py", [await store.dir(slug), "--json"]);
  ctx.send(r.status ? 500 : 200, JSON.parse(r.stdout || "{}"));
}, "design + playtest analytics");
gw.route("GET", "/api/games/:slug/validate", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const r = py("validate.py", [await store.dir(slug)]);
  ctx.send(200, { ok: r.status === 0, report: r.stdout.trim().split("\n") });
}, "format conformance (SPEC §10)");
gw.route("GET", "/api/games/:slug/credits", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const r = py("credits.py", [await store.dir(slug)]);
  ctx.send(200, { ok: r.status === 0, credits: (await store.readFile(slug, "CREDITS.md")).toString() });
}, "auto credit roll");
/* ---------- routes: pull requests — the remix loop closed ----------
 * The PROPOSAL lives in Store 2 (conversation); the MERGE is a real commit
 * through the Store-1 seam, authored as the PROPOSER. Owner-only merge is the
 * platform's first authorization rule beyond authorship. */
const cardsOf = async (slug) => JSON.parse((await store.readFile(slug, "components/cards.json")).toString());
async function directForkBaseRef(from, to, fromRow = null) {
  const row = fromRow || await q.gameBySlug(db, from);
  if (row?.forked_from !== to) return null;
  const yaml = (await store.readFile(from, "game.yaml"))?.toString() ?? "";
  const sourceId = (yaml.match(/^\s*source_id:\s*["']?([^"'\n]+)["']?\s*$/m) ?? [])[1]?.trim();
  const sourceRef = (yaml.match(/^\s*source_ref:\s*["']?([0-9a-f]{7,40})["']?\s*$/mi) ?? [])[1];
  return sourceId === to ? sourceRef ?? null : null;
}
async function ensureImportedFork(u, slug) {
  return ensureUserFork(u, slug);
}
async function prPolicy(slug) {
  try { return collaborationPolicy(await store.readFile(slug, "forge/collaboration.json")); }
  catch { return collaborationPolicy(null); }
}
function reviewState(policy, reviews, conflicts = []) {
  const approvals = reviews.filter(review => review.verdict === "approve");
  const changeRequests = reviews.filter(review => review.verdict === "request_changes");
  const checks = [
    { key: "conflicts", pass: conflicts.length === 0, detail: conflicts.length ? `${conflicts.length} conflict(s)` : "no conflicts" },
    { key: "approvals", pass: approvals.length >= policy.required_approvals,
      detail: `${approvals.length}/${policy.required_approvals} required approval(s)` },
    { key: "changes_requested", pass: changeRequests.length === 0,
      detail: changeRequests.length ? `${changeRequests.length} active change request(s)` : "no change requests" },
    { key: "validation", pass: null, detail: "candidate is validated atomically during merge" },
  ];
  return { reviews, approvals: approvals.length, change_requests: changeRequests.length,
    required_approvals: policy.required_approvals, checks,
    mergeable: checks.filter(check => check.pass !== null).every(check => check.pass) };
}
async function openOrRefreshImportedPr({ u, slug, destination, message, body }) {
  const fromRow = await q.gameBySlug(db, destination);
  const baseRef = await directForkBaseRef(destination, slug, fromRow);
  const proposed = await gameSnapshot(destination);
  const existing = (await q.prsFor(db, slug)).find(pr => pr.from_slug === destination && pr.status === "open");
  let id;
  if (existing) {
    const full = await q.prById(db, existing.id), base = normalizePrSnapshot(JSON.parse(full.base));
    id = existing.id;
    await q.refreshPr(db, id, message, JSON.stringify(base), JSON.stringify(proposed));
    if ((await prPolicy(slug)).dismiss_stale_reviews) await q.clearReviews(db, id);
  } else {
    const base = await gameSnapshot(slug, baseRef); id = newId("pr");
    await q.createPr(db, { id, to_slug: slug, from_slug: destination, title: message, body, author_id: u.id,
      base: JSON.stringify(base), proposed: JSON.stringify(proposed) });
    const owner = await q.gameBySlug(db, slug);
    if (owner?.owner_id && owner.owner_id !== u.id)
      await q.notify(db, { id: newId("n"), user_id: owner.owner_id, kind: "pr_open", actor_handle: u.handle, game_slug: slug, target: id });
  }
  return id;
}
gw.route("POST", "/api/games/:slug/prs", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const to = requireGame(ctx); if (!to) return;
  const { from, title, body } = await json(ctx);
  if (!from || !store.has(from)) return ctx.send(422, { error: "unknown source game 'from'" });
  if (from === to) return ctx.send(422, { error: "cannot PR a game into itself" });
  const fromRow = await q.gameBySlug(db, from);
  if (fromRow?.owner_id !== u.id) return ctx.send(403, { error: "you can only propose from a game you own" });
  if (!title?.trim()) return ctx.send(422, { error: "title required" });
  // A pull request is a three-way merge from the exact version the edition
  // forked, not from whatever happens to be current when the PR is opened.
  // Otherwise a long-lived edition could silently overwrite newer source work.
  const baseRef = await directForkBaseRef(from, to, fromRow);
  const [base, proposed] = await Promise.all([gameSnapshot(to, baseRef), gameSnapshot(from)]);
  const changes = diffCards(base.cards, proposed.cards);
  const printing_changes = diffRows(base.printings, proposed.printings, "printings");
  const file_changes = repoFileChanges(base.files, proposed.files);
  if (!changes.length && !printing_changes.changed.length && !printing_changes.added.length && !printing_changes.removed.length && !file_changes.length)
    return ctx.send(422, { error: "no game changes between the editions" });
  const id = newId("pr");
  await q.createPr(db, { id, to_slug: to, from_slug: from, title: title.trim(), body,
    author_id: u.id, base: JSON.stringify(base), proposed: JSON.stringify(proposed) });
  const cardSummary = summarize(changes)?.title;
  const printingTotal = printing_changes.changed.length + printing_changes.added.length + printing_changes.removed.length;
  const printingSummary = printingTotal ? `printings: ${printingTotal} row${printingTotal === 1 ? "" : "s"}` : null;
  const fileSummary = file_changes.length
    ? `assets: ${file_changes.length} reusable file${file_changes.length === 1 ? "" : "s"}` : null;
  ctx.send(201, { id, to, from, title: title.trim(), changes, printing_changes, file_changes,
    summary: [cardSummary, printingSummary, fileSummary].filter(Boolean).join(" · ") });
}, "open a PR: propose structured card and reusable-file changes back to the source");
gw.route("GET", "/api/games/:slug/prs", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  ctx.send(200, await q.prsFor(db, slug));
}, "list PRs targeting this game");
gw.route("GET", "/api/games/:slug/prs/:id", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const pr = await q.prById(db, ctx.params.id);
  if (!pr || pr.to_slug !== slug) return ctx.send(404, { error: "no such PR" });
  const base = normalizePrSnapshot(JSON.parse(pr.base));
  const proposed = normalizePrSnapshot(JSON.parse(pr.proposed));
  const current = await gameSnapshot(slug);
  const { conflicts } = mergeCards(base.cards, proposed.cards, current.cards);
  const printingMerge = mergeRows(base.printings, proposed.printings, current.printings, "printings");
  const printing_changes = diffRows(base.printings, proposed.printings, "printings");
  const changes = diffCards(base.cards, proposed.cards);
  const fileMerge = mergeRepoFiles(base.files, proposed.files, current.files);
  const file_changes = fileMerge.changes.map(change => ({ ...change,
    before_url: change.before_hash
      ? `/api/games/${encodeURIComponent(slug)}/repository/file/${change.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(base.ref)}` : null,
    after_url: change.after_hash
      ? `/api/games/${encodeURIComponent(pr.from_slug)}/repository/file/${change.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(proposed.ref)}` : null,
  }));
  // visual diff payload: ONLY the cards the diff actually touches (by id), so the
  // hub can render cardFrame(before) -> cardFrame(after) per card without shipping
  // the whole game's card pool over the wire.
  const changedIds = [...new Set(changes.map((c) => c.card))];
  const byId = (arr) => Object.fromEntries(arr.map((c) => [c.id, c]));
  const B = byId(base.cards), P = byId(proposed.cards);
  const before_cards = changedIds.map((id) => B[id]).filter(Boolean);
  const after_cards = changedIds.map((id) => P[id]).filter(Boolean);
  const rightsChanged = file_changes.some(change => change.path === RIGHTS_MANIFEST);
  const rights_diff = rightsChanged ? {
    before: parseRights(await store.fileAt(slug, base.ref, RIGHTS_MANIFEST)),
    after: mergeContributedRights(await store.fileAt(slug, current.ref, RIGHTS_MANIFEST),
      await store.fileAt(pr.from_slug, proposed.ref, RIGHTS_MANIFEST)),
  } : null;
  const allConflicts = [...conflicts, ...printingMerge.conflicts, ...fileMerge.conflicts];
  const policy = await prPolicy(slug);
  const review = reviewState(policy, await q.reviewsFor(db, pr.id), allConflicts);
  ctx.send(200, { id: pr.id, to: pr.to_slug, from: pr.from_slug, title: pr.title, body: pr.body,
    author: pr.author_handle, status: pr.status, merge_sha: pr.merge_sha ?? null,
    changes, printing_changes, before_cards, after_cards, file_changes, rights_diff,
    stale: diffCards(base.cards, current.cards).length > 0
      || (base.version >= 3 && (diffRows(base.printings, current.printings).changed.length || diffRows(base.printings, current.printings).added.length || diffRows(base.printings, current.printings).removed.length))
      || repoFileChanges(base.files, current.files).length > 0,
    conflicts, printing_conflicts: printingMerge.conflicts, file_conflicts: fileMerge.conflicts,
    policy, ...review,
    comments: await q.commentsFor(db, "pr", pr.id) });
}, "PR detail: semantic card and reusable-file diff + live three-way conflict check + discussion");
gw.route("POST", "/api/games/:slug/prs/:id/comments", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const pr = await q.prById(db, ctx.params.id);
  if (!pr || pr.to_slug !== slug) return ctx.send(404, { error: "no such PR" });
  const { body } = await json(ctx);
  if (!body?.trim()) return ctx.send(422, { error: "comment body required" });
  await q.addComment(db, { id: newId("c"), target_type: "pr", target_id: pr.id, author_id: u.id, body: body.trim() });
  if (pr.author_id !== u.id) await q.notify(db, { id: newId("n"), user_id: pr.author_id, kind: "pr_comment", actor_handle: u.handle, game_slug: slug, target: pr.id });
  ctx.send(201, { comments: await q.commentsFor(db, "pr", pr.id) });
}, "comment on a PR (review discussion)");
gw.route("POST", "/api/games/:slug/prs/:id/review", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const pr = await q.prById(db, ctx.params.id);
  if (!pr || pr.to_slug !== slug) return ctx.send(404, { error: "no such PR" });
  if (pr.status !== "open") return ctx.send(409, { error: `PR is ${pr.status}` });
  if (!await canReview(u, slug)) return ctx.send(403, { error: "only the game's owner or maintainers can review", propose: true });
  if (pr.author_id === u.id) return ctx.send(422, { error: "you can't review your own proposal" });
  const { verdict } = await json(ctx);
  if (!["approve", "request_changes"].includes(verdict))
    return ctx.send(422, { error: "verdict must be 'approve' or 'request_changes'" });
  await q.addReview(db, { pr_id: pr.id, reviewer_id: u.id, verdict });
  if (pr.author_id !== u.id) await q.notify(db, { id: newId("n"), user_id: pr.author_id, kind: "pr_review", actor_handle: u.handle, game_slug: slug, target: pr.id });
  ctx.send(201, { reviews: await q.reviewsFor(db, pr.id) });
}, "review a PR: approve or request changes (maintainers only, not the proposer)");
gw.route("POST", "/api/games/:slug/prs/:id/merge", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const pr = await q.prById(db, ctx.params.id);
  if (!pr || pr.to_slug !== slug) return ctx.send(404, { error: "no such PR" });
  if (pr.status !== "open") return ctx.send(409, { error: `PR is ${pr.status}` });
  if (!await canAdmin(u, slug)) return ctx.send(403, { error: "only the game's owner (or, on an open sandbox/ownerless game, any signed-in user) can merge" });
  const base = normalizePrSnapshot(JSON.parse(pr.base));
  const proposed = normalizePrSnapshot(JSON.parse(pr.proposed));
  const current = await gameSnapshot(slug);
  const { merged, conflicts } = mergeCards(base.cards, proposed.cards, current.cards);
  const printingMerge = mergeRows(base.printings, proposed.printings, current.printings, "printings");
  const fileMerge = mergeRepoFiles(base.files, proposed.files, current.files);
  if (conflicts.length || printingMerge.conflicts.length || fileMerge.conflicts.length)
    return ctx.send(409, { error: "conflicts — both sides changed the same game source",
      conflicts, printing_conflicts: printingMerge.conflicts, file_conflicts: fileMerge.conflicts });
  const policy = await prPolicy(slug);
  const reviews = await q.reviewsFor(db, pr.id);
  const review = reviewState(policy, reviews);
  if (!review.mergeable) return ctx.send(409, { error: "review requirements are not satisfied", policy, ...review });
  const changes = diffCards(current.cards, merged);
  const printing_changes = diffRows(current.printings, printingMerge.merged, "printings");
  const file_changes = fileMerge.changes.filter(change =>
    (current.files[change.path]?.hash ?? null) !== (proposed.files[change.path]?.hash ?? null));
  const writes = [];
  if (changes.length) writes.push({ path: "components/cards.json", content: JSON.stringify(merged, null, 2) + "\n" });
  if (printing_changes.changed.length || printing_changes.added.length || printing_changes.removed.length)
    writes.push({ path: "components/printings.json", content: JSON.stringify(printingMerge.merged, null, 2) + "\n" });
  let proposedTree = null;
  try {
    if (file_changes.length) {
      proposedTree = await store.materialize(pr.from_slug, proposed.ref);
      for (const change of file_changes) {
        const source = join(proposedTree.dir, change.path);
        writes.push({ path: change.path,
          content: change.path === RIGHTS_MANIFEST
            ? rightsReceiptBytes(mergeContributedRights(
                await store.fileAt(slug, current.ref, RIGHTS_MANIFEST),
                await store.fileAt(pr.from_slug, proposed.ref, RIGHTS_MANIFEST)))
            : change.path === "game.yaml"
              ? mergeContributedGameYaml(
                  await store.fileAt(slug, current.ref, "game.yaml"),
                  await store.fileAt(pr.from_slug, proposed.ref, "game.yaml"))
            : proposed.files[change.path] && existsSync(source) ? readFileSync(source) : null });
      }
    }
    if (!writes.length) {
      const sha = await store.headSha(slug);
      await q.setPrStatus(db, pr.id, "merged", sha);
      return ctx.send(200, { merged: true, commit: sha, changes: [], printing_changes, file_changes: [] });
    }
    const candidate = await store.materialize(slug, current.ref);
    try {
      for (const write of writes) {
        const path = join(candidate.dir, write.path);
        if (write.content === null) rmSync(path, { force: true });
        else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, write.content); }
      }
      const v = py("validate.py", [candidate.dir]);
      if (v.status !== 0)
        return ctx.send(422, { error: "merged result fails validation", report: v.stdout.split("\n") });
    } finally { candidate.cleanup(); }
  } finally { if (proposedTree) proposedTree.cleanup(); }
  const auto = summarize(changes);
  const printingBody = (printing_changes.changed.length || printing_changes.added.length || printing_changes.removed.length)
    ? `printings: changed ${printing_changes.changed.length}, added ${printing_changes.added.length}, removed ${printing_changes.removed.length}` : null;
  const fileBody = file_changes.map(change => `${change.kind}: ${change.path}`).join("\n");
  const { sha } = await store.writeFiles(slug, writes,
    `merge: ${pr.title} (PR from ${pr.from_slug})\n\n${[auto?.body, printingBody, fileBody].filter(Boolean).join("\n")}\nmerged-by: ${u.handle}`,
    `${pr.author_handle} <${pr.author_email}>`);
  await q.setPrStatus(db, pr.id, "merged", sha);
  if (writes.some(write => write.path === RIGHTS_MANIFEST || write.path === "game.yaml")) await reindexGames();
  await q.recordEvent(db, { id: newId("ev"), kind: "pr_merge", actor_id: u.id, game_slug: slug, target: pr.from_slug });
  if (pr.author_id !== u.id) await q.notify(db, { id: newId("n"), user_id: pr.author_id, kind: "pr_merge", actor_handle: u.handle, game_slug: slug, target: pr.id });
  ctx.send(200, { merged: true, commit: sha, changes, printing_changes, file_changes });
}, "merge a PR: three-way cards + reusable files → validate → atomic commit AUTHORED AS THE PROPOSER");
gw.route("POST", "/api/games/:slug/prs/:id/close", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const pr = await q.prById(db, ctx.params.id);
  if (!pr || pr.to_slug !== slug) return ctx.send(404, { error: "no such PR" });
  if (pr.status !== "open") return ctx.send(409, { error: `PR is ${pr.status}` });
  if (!await canAdmin(u, slug) && pr.author_id !== u.id)
    return ctx.send(403, { error: "only the owner (or, on an open sandbox/ownerless game, any signed-in user) or the PR's author can close" });
  await q.setPrStatus(db, pr.id, "closed");
  ctx.send(200, { closed: true });
}, "close a PR without merging");

/* ---------- routes: issues — bug reports & balance debates (the community layer) ---------- */
gw.route("GET", "/api/games/:slug/issues", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  ctx.send(200, await q.issuesFor(db, slug));
}, "list issues on a game");
gw.route("POST", "/api/games/:slug/issues", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const { title, body } = await json(ctx);
  if (!title?.trim()) return ctx.send(422, { error: "issue title required" });
  const number = await q.nextIssueNumber(db, slug);
  const id = newId("i");
  await q.createIssue(db, { id, game_slug: slug, number, title: title.trim(), body: body ?? null, author_id: u.id });
  ctx.send(201, { id, number, title: title.trim(), status: "open" });
}, "open an issue (any signed-in user)");
gw.route("GET", "/api/games/:slug/issues/:n", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const iss = await q.issueByNumber(db, slug, parseInt(ctx.params.n, 10));
  if (!iss) return ctx.send(404, { error: "no such issue" });
  ctx.send(200, { number: iss.number, title: iss.title, body: iss.body, author: iss.author_handle,
    status: iss.status, created_at: iss.created_at,
    comments: await q.commentsFor(db, "issue", iss.id) });
}, "issue detail + comment thread");
gw.route("POST", "/api/games/:slug/issues/:n/comments", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const iss = await q.issueByNumber(db, slug, parseInt(ctx.params.n, 10));
  if (!iss) return ctx.send(404, { error: "no such issue" });
  const { body } = await json(ctx);
  if (!body?.trim()) return ctx.send(422, { error: "comment body required" });
  await q.addComment(db, { id: newId("c"), target_type: "issue", target_id: iss.id, author_id: u.id, body: body.trim() });
  ctx.send(201, { comments: await q.commentsFor(db, "issue", iss.id) });
}, "comment on an issue");
gw.route("POST", "/api/games/:slug/issues/:n/close", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const iss = await q.issueByNumber(db, slug, parseInt(ctx.params.n, 10));
  if (!iss) return ctx.send(404, { error: "no such issue" });
  if (!await canAdmin(u, slug) && iss.author_id !== u.id)
    return ctx.send(403, { error: "only the owner (or, on an open sandbox/ownerless game, any signed-in user) or the issue's author can close" });
  await q.setIssueStatus(db, iss.id, iss.status === "open" ? "closed" : "open");
  ctx.send(200, { status: iss.status === "open" ? "closed" : "open" });
}, "close (or reopen) an issue — owner or author");

const EXPORT_KINDS = new Set(["print", "pnp", "tts", "ttc", "vtt", "project", "nandeck", "rulebook", "publication"]);
const activeExportJobs = new Map();
function exportPayload(slug, sha, fmt, artifact) {
  const dir = artifact.dir, base = `/cache/exports/${slug}/${sha}`;
  const urls = fmt === "print" ? [`${base}/print-ready.zip`, `${base}/print-a4.pdf`,
      `${base}/print-letter.pdf`, `${base}/print-press-rgb.pdf`]
    : fmt === "pnp" ? [`${base}/pnp.pdf`]
    : fmt === "ttc" ? [`${base}/${slug}-ttc.zip`]
    : fmt === "project" ? [`${base}/${cache.projectArtifactName(slug)}`]
    : fmt === "nandeck" ? [`${base}/${cache.nandeckArtifactName(slug)}`]
    : fmt === "rulebook" ? JSON.parse(readFileSync(join(dir, "rulebook-build.json"), "utf8")).outputs.map(output => `${base}/${output.file}`)
    : fmt === "publication" ? JSON.parse(readFileSync(join(dir, "publication-build.json"), "utf8")).outputs.map(output => `${base}/${output.file}`)
    : fmt === "vtt" ? [`${base}/${cache.vttArtifactName("vtt")}`, `${base}/${cache.vttArtifactName("json")}`]
    : [`${base}/tts.json`, ...readdirSync(dir).filter(file => /^sheet(?:-\d+)?\.png$/.test(file)).sort().map(file => `${base}/${file}`), `${base}/back.png`];
  const build = fmt === "rulebook" ? JSON.parse(readFileSync(join(dir, "rulebook-build.json"), "utf8"))
    : fmt === "publication" ? JSON.parse(readFileSync(join(dir, "publication-build.json"), "utf8")) : undefined;
  return { ok: true, ref: sha, cached: artifact.hit, urls, manifest: artifact.manifest, ...(build ? { build } : {}) };
}
const exportJobView = job => ({ id: job.id, game: job.game_slug, ref: job.ref, kind: job.kind,
  exporter_version: job.exporter_version, status: job.status, progress: job.progress, attempt: job.attempt,
  error: job.error || null, output: job.output_json ? JSON.parse(job.output_json) : null,
  created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at,
  status_url: `/api/export-jobs/${job.id}` });
async function queueExportJob({ slug, sha, kind, user = null, allowNetwork = false, buildPdf = true }) {
  const version = cache.exporterVersion(kind);
  let job = await q.exportJobByKey(db, slug, sha, kind, version);
  if (!job) {
    const id = newId("job"), inputHash = createHash("sha256").update(`${slug}\0${sha}\0${kind}\0${version}`).digest("hex");
    await q.createExportJob(db, { id, game_slug: slug, ref: sha, kind, exporter_version: version,
      input_hash: inputHash, created_by: user?.id ?? null, budget_json: JSON.stringify(cache.EXPORT_BUDGET) });
    job = await q.exportJobById(db, id);
  }
  if (job.status === "succeeded") return { job,
    promise: Promise.resolve({ ...JSON.parse(job.output_json), cached: true }) };
  if (activeExportJobs.has(job.id)) return { job, promise: activeExportJobs.get(job.id) };
  if (["failed", "running", "queued"].includes(job.status) && job.started_at) await q.retryExportJob(db, job.id);
  const promise = (async () => {
    await q.startExportJob(db, job.id);
    try {
      const artifact = await cache.ensureExport(mat(slug), slug, sha, kind,
        { publicOrigin: PUBLIC_ORIGIN, allowNetwork, buildPdf });
      const output = exportPayload(slug, sha, kind, artifact);
      await q.finishExportJob(db, job.id, "succeeded", JSON.stringify(output), null);
      return output;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 4000);
      await q.finishExportJob(db, job.id, "failed", null, message);
      throw error;
    } finally { activeExportJobs.delete(job.id); }
  })();
  activeExportJobs.set(job.id, promise);
  return { job: await q.exportJobById(db, job.id), promise };
}

gw.route("GET", "/api/export-jobs/:id", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const job = await q.exportJobById(db, ctx.params.id);
  if (!job) return ctx.send(404, { error: "no such export job" });
  if (job.created_by && job.created_by !== u.id && !await canWrite(u, job.game_slug))
    return ctx.send(403, { error: "this export job belongs to another project member" });
  ctx.send(200, exportJobView(job));
}, "observable export status, progress, attempt, output manifest, and failure receipt");

gw.route("POST", "/api/games/:slug/export/:fmt", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await requireAuth(ctx); if (!u) return;
  const { fmt } = ctx.params;
  if (!EXPORT_KINDS.has(fmt)) return ctx.send(400, { error: "print, pnp, tts, ttc, vtt, project, nandeck, rulebook, or publication" });
  const sha = await store.headSha(slug);
  const queued = await queueExportJob({ slug, sha, kind: fmt, user: u, allowNetwork: fmt === "rulebook" });
  if (ctx.url.searchParams.get("wait") === "1") {
    try { return ctx.send(200, { ...(await queued.promise), job: exportJobView(await q.exportJobById(db, queued.job.id)) }); }
    catch (error) { return ctx.send(422, { error: error.message, job: exportJobView(await q.exportJobById(db, queued.job.id)) }); }
  }
  ctx.send(202, exportJobView(await q.exportJobById(db, queued.job.id)));
}, "queue an isolated immutable export; poll the returned observable job");

gw.route("POST", "/api/games/:slug/design/import", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await requireAuth(ctx); if (!u) return;
  const direct = await canWrite(u, slug), commit = ctx.url.searchParams.get("commit") === "1";
  const bundle = await readBody(ctx.req, MAX_PROJECT_BYTES + 1);
  if (bundle.length > MAX_PROJECT_BYTES) return ctx.send(413, { error: "design project is larger than 128 MB" });
  let destination = slug, propose = false;
  if (commit && !direct) {
    try { destination = await ensureUserFork(u, slug); }
    catch (error) { return ctx.send(error.code ?? 500, { error: error.message }); }
    propose = true;
  }
  const materialized = await store.materialize(destination, "HEAD");
  try {
    let result;
    try { result = analyzeForgeProject(materialized.dir, bundle, { allowGameIdMismatch: destination !== slug }); }
    catch (error) { return ctx.send(422, { error: error?.message || "invalid Forge design project" }); }
    try {
      for (const file of result.files.filter(file => file.content !== null)) {
        if (file.path.startsWith("assets/")) {
          assertAssetAllowed(file.path, file.content.length); inspectAsset(file.path, file.content);
        } else if (file.path.toLowerCase().endsWith(".svg")) inspectSvg(file.content);
      }
    } catch (error) { return ctx.send(error.status || 422, { error: `unsafe imported media: ${error.message}` }); }
    const response = {
      ok: result.conflicts.length === 0,
      game: result.game,
      source_hash: result.source_hash,
      destination: commit ? destination : (direct ? slug : `${slug}-${u.handle}`.slice(0, 60)),
      propose: commit ? propose : !direct,
      changes: result.changes,
      changed_files: result.files.map(file => ({ path: file.path, operation: file.content === null ? "delete" : "write", kind: file.kind })),
      conflicts: result.conflicts,
    };
    if (!commit) return ctx.send(200, { ...response, mode: "dry-run" });
    if (result.conflicts.length) return ctx.send(409, { ...response, error: "project conflicts with newer Forge changes" });
    const removesRows = result.changes.cards.removed.length || result.changes.printings.removed.length;
    const removesFiles = result.files.some(file => file.content === null);
    if ((removesRows || removesFiles) && ctx.url.searchParams.get("allow_delete") !== "1")
      return ctx.send(422, { ...response, error: "project contains deletions; review them and explicitly allow deletion" });
    if (!result.files.length) return ctx.send(200, { ...response, saved: false, message: "no changes" });
    for (const file of result.files) {
      const full = join(materialized.dir, file.path);
      if (file.content === null) rmSync(full, { force: true });
      else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, file.content); }
    }
    const validation = spawnSync(process.execPath, [join(ROOT, "tools", "validate.mjs"), materialized.dir], { encoding: "utf8" });
    if (validation.status !== 0) return ctx.send(422, {
      ...response, error: "candidate project failed game validation",
      report: `${validation.stdout || ""}\n${validation.stderr || ""}`.trim().split("\n"),
    });
    const cardSummary = summarize(result.changes.card_fields);
    const message = cardSummary?.title || `design: import ${result.files.length} project file${result.files.length === 1 ? "" : "s"}`;
    const { sha } = await store.writeFiles(destination, result.files.map(file => ({ path: file.path, content: file.content })), message, `${u.handle} <${u.email}>`);
    if (!propose) return ctx.send(200, { ...response, saved: true, commit: sha, message });

    const fromRow = await q.gameBySlug(db, destination);
    const baseRef = await directForkBaseRef(destination, slug, fromRow);
    const proposedSnapshot = await gameSnapshot(destination);
    const existing = (await q.prsFor(db, slug)).find(pr => pr.from_slug === destination && pr.status === "open");
    let prId, baseSnapshot;
    if (existing) {
      const full = await q.prById(db, existing.id);
      baseSnapshot = normalizePrSnapshot(JSON.parse(full.base));
      prId = existing.id;
      await q.refreshPr(db, prId, message, JSON.stringify(baseSnapshot), JSON.stringify(proposedSnapshot));
      if ((await prPolicy(slug)).dismiss_stale_reviews) await q.clearReviews(db, prId);
    } else {
      baseSnapshot = await gameSnapshot(slug, baseRef);
      prId = newId("pr");
      await q.createPr(db, { id: prId, to_slug: slug, from_slug: destination, title: message,
        body: "Imported from a Forge design project after dry-run and validation.", author_id: u.id,
        base: JSON.stringify(baseSnapshot), proposed: JSON.stringify(proposedSnapshot) });
      const owner = await q.gameBySlug(db, slug);
      if (owner?.owner_id && owner.owner_id !== u.id)
        await q.notify(db, { id: newId("n"), user_id: owner.owner_id, kind: "pr_open", actor_handle: u.handle, game_slug: slug, target: prId });
    }
    ctx.send(200, { ...response, saved: true, proposed: true, commit: sha, message, pr: prId, fork: destination });
  } finally { materialized.cleanup(); }
}, "dry-run, commit, or fork+PR a Forge design project with three-way conflict detection");

gw.route("POST", "/api/games/:slug/design/import/nandeck", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await requireAuth(ctx); if (!u) return;
  const direct = await canWrite(u, slug), commit = ctx.url.searchParams.get("commit") === "1";
  const script = await readBody(ctx.req, MAX_NANDECK_BYTES + 1);
  if (script.length > MAX_NANDECK_BYTES) return ctx.send(413, { error: "nanDECK script is larger than 2 MB" });
  let destination = slug, propose = false;
  if (commit && !direct) {
    try { destination = await ensureImportedFork(u, slug); propose = true; }
    catch (error) { return ctx.send(error.code || 500, { error: error.message }); }
  }
  const materialized = await store.materialize(destination, "HEAD");
  try {
    let result;
    try { result = analyzeNandeckImport(materialized.dir, script); }
    catch (error) {
      if (!commit) {
        try {
          const candidate = parseNandeckScript(script);
          return ctx.send(200, { ok: true, mode: "candidate", candidate_only: true,
            reason: error.message, recovered: { card: candidate.layout.card, regions: candidate.layout.regions.length, fonts: candidate.layout.fonts?.length || 0 },
            layout: candidate.layout, warnings: candidate.warnings, unsupported: candidate.unsupported,
            conflicts: [], changes: [], changed_files: [], propose: false });
        } catch {}
      }
      return ctx.send(422, { error: error.message || "invalid nanDECK layout" });
    }
    const response = {
      ok: result.conflicts.length === 0,
      mode: commit ? "commit" : "dry-run",
      family: result.family,
      destination: commit ? destination : (direct ? slug : `${slug}-${u.handle}`.slice(0, 60)),
      propose: commit ? propose : !direct,
      source_hash: result.source_hash,
      current_source_hash: result.current_source_hash,
      stale: result.stale,
      changes: result.changes,
      affected_families: result.affected_families,
      changed_files: result.files.map(file => file.path),
      conflicts: result.conflicts,
      warnings: result.warnings,
      unsupported: result.unsupported,
    };
    if (!commit) return ctx.send(200, response);
    if (result.conflicts.length) return ctx.send(409, { ...response, error: "nanDECK layout conflicts with newer Forge design changes" });
    if (!result.files.length) return ctx.send(200, { ...response, saved: false, message: "no changes" });
    for (const file of result.files) {
      const full = join(materialized.dir, file.path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, file.content);
    }
    const validation = spawnSync(process.execPath, [join(ROOT, "tools", "validate.mjs"), materialized.dir], { encoding: "utf8" });
    if (validation.status !== 0) return ctx.send(422, { ...response, error: "candidate nanDECK design failed game validation",
      report: `${validation.stdout || ""}\n${validation.stderr || ""}`.trim().split("\n") });
    const message = `design: import nanDECK ${result.family} (${result.changes.length} field${result.changes.length === 1 ? "" : "s"})`;
    const { sha } = await store.writeFiles(destination, result.files, message, `${u.handle} <${u.email}>`);
    if (!propose) return ctx.send(200, { ...response, saved: true, commit: sha, message });
    const pr = await openOrRefreshImportedPr({ u, slug, destination, message,
      body: "Imported from a Forge-generated nanDECK family script after field-level dry-run, three-way merge, and game validation." });
    ctx.send(200, { ...response, saved: true, proposed: true, commit: sha, message, pr, fork: destination });
  } finally { materialized.cleanup(); }
}, "dry-run, commit, or fork+PR a traceable nanDECK family layout with field-level three-way merge");

gw.route("POST", "/api/games/:slug/play", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await requireAuth(ctx); if (!u) return;
  if (!VTT_WRITE_ALLOWED) return ctx.send(503, {
    error: "Refusing to write game state to a remote tabletop without explicit server opt-in",
    detail: "Set ALLOW_REMOTE_VTT_WRITE=1 only for a VTT instance you control and protect.",
  });
  const sha = await store.headSha(slug);
  let artifact;
  try {
    await (await queueExportJob({ slug, sha, kind: "vtt", user: u })).promise;
    artifact = { dir: dirname(cache.pathOf(cache.exportKey(slug, sha, "receipt-placeholder"))) };
  } catch (error) {
    return ctx.send(422, { error: error?.message || "this game does not have a playable setup" });
  }
  const room = `forge-${slug}-${sha.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const state = readFileSync(join(artifact.dir, cache.vttArtifactName("json")), "utf8");
    const response = await fetch(`${VTT_ORIGIN}/state/${room}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: state,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`VirtualTabletop returned ${response.status}`);
  } catch (error) {
    return ctx.send(503, {
      error: "Local VirtualTabletop is not running",
      detail: error?.message,
      vtt_origin: VTT_ORIGIN,
      command: "npm run vtt:up",
      download: `/cache/exports/${slug}/${sha}/${cache.vttArtifactName("vtt")}`,
    });
  }
  ctx.send(200, {
    ok: true,
    ref: sha,
    room,
    play_url: `${VTT_ORIGIN}/${room}`,
    download: `/cache/exports/${slug}/${sha}/${cache.vttArtifactName("vtt")}`,
  });
}, "stage the exact current build in a fresh local VirtualTabletop room");

/* ---------- routes: playtest analytics + ingestion (the 'test' pillar) ---------- */
gw.route("GET", "/api/games/:slug/analytics", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const sha = await store.headSha(slug);
  const { dir, cleanup } = await store.materialize(slug, sha);
  try {
    const r = py("stats.py", [dir, "--json"]);
    if (r.status !== 0) return ctx.send(500, { error: "analytics failed", detail: r.stderr });
    ctx.send(200, { ref: sha, ...JSON.parse(r.stdout) });
  } finally { cleanup(); }
}, "live playtest analytics aggregated from the game's playtests/");
gw.route("POST", "/api/games/:slug/playtests", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const s = await json(ctx);
  if (!s || !Array.isArray(s.players) || !s.players.some(p => p && p.name))
    return ctx.send(422, { error: "a session needs at least one named player" });
  const sha0 = await store.headSha(slug);
  const date = (typeof s.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date)) ? s.date : new Date().toISOString().slice(0, 10);
  let id = String(s.id || `${date}-${s.location || "session"}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!/^[a-z0-9]/.test(id)) id = `${date}-session`;
  const RES = new Set(["win", "loss", "draw"]);
  const TAGS = new Set(["balance", "confusing", "fun", "bug", "art", "timing"]);
  const session = {
    id, date, version_ref: s.version_ref || sha0,
    ...(s.format_id ? { format_id: s.format_id } : {}),
    ...(s.location ? { location: s.location } : {}),
    ...(s.duration_minutes ? { duration_minutes: parseInt(s.duration_minutes, 10) } : {}),
    players: s.players.filter(p => p && p.name).map(p => { const res = typeof p.result === "string" ? p.result.toLowerCase() : p.result; return {
      name: p.name, ...(p.deck_id ? { deck_id: p.deck_id } : {}),
      ...(RES.has(res) ? { result: res } : {}),
      ...(typeof p.score === "number" ? { score: p.score } : {}),
      ...(p.first_game ? { first_game: true } : {}) }; }),
    ...(Array.isArray(s.card_notes) ? { card_notes: s.card_notes
      .map(n => (n && n.card_id && n.note) ? { card_id: n.card_id, tag: String(n.tag || "").toLowerCase(), note: n.note, ...(n.suggestion ? { suggestion: n.suggestion } : {}) } : null)
      .filter(n => n && TAGS.has(n.tag)) } : {}),
    ...(Array.isArray(s.decisions) ? { decisions: s.decisions.filter(d => d && d.action)
      .map(d => ({ action: d.action, ...(d.card_id ? { card_id: d.card_id } : {}), ...(d.rationale ? { rationale: d.rationale } : {}) })) } : {}),
  };
  const path = `playtests/${id}.json`;
  const content = JSON.stringify(session, null, 2) + "\n";
  const v = await validateCandidate(slug, path, content);
  if (!v.ok) return ctx.send(422, { error: "playtest failed validation", report: v.report });
  const { sha } = await store.writeFiles(slug, [{ path, content }], `playtest: log session ${id}`, `${u.handle} <${u.email}>`);
  ctx.send(201, { id, commit: sha, pinned: session.version_ref });
}, "log a playtest session (owner/collaborator) → validated, version-pinned commit");
gw.route("GET", "/api/games/:slug/diff", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const to = ctx.url.searchParams.get("to") || await store.headSha(slug);
  let from = ctx.url.searchParams.get("from");
  if (!from) {
    const rels = await q.releasesFor(db, slug);
    from = rels[0]?.sha;
    if (!from) { const h = await store.history(slug, "components/cards.json", 2); from = (h[1] || h[0] || {}).sha; }
  }
  if (!from) return ctx.send(422, { error: "nothing to compare against yet" });
  const at = async (ref) => { const { dir, cleanup } = await store.materialize(slug, ref);
    try { return JSON.parse(readFileSync(join(dir, "components/cards.json"), "utf8")); } finally { cleanup(); } };
  try {
    const [a, b] = [await at(from), await at(to)];
    const changes = diffCards(a, b);
    ctx.send(200, { from, to, changes, summary: summarize(changes)?.title || null });
  } catch (e) { ctx.send(422, { error: "could not diff those versions", detail: e.message }); }
}, "balance diff: what changed in the cards between two versions");

/* ---------- routes: Sheets — external working copy → game candidate ----------
 * A game can attach a Google Sheet (or HTTPS CSV) as an authoring surface.
 * Sheets owns live drafting and collaboration; Forge owns the deliberate
 * promotion boundary into validated, reproducible game history. The last
 * candidate commit is a real three-way merge base:
 *
 *      last candidate commit
 *        /              \
 *   Forge HEAD       fresh Sheet
 *
 * Building a candidate never blindly replaces cards. Independent field edits
 * merge; divergent edits and delete-vs-edit races are returned as explicit
 * conflicts. A preview carries both working-copy and HEAD fingerprints so
 * Commit cannot promote a different Sheet or repository state than reviewed. */
const MAX_SHEET_BYTES = 5_000_000;
const SHEETS_ADAPTER = { id: "google-sheets-working-copy", version: 2 };
const SHEET_RECEIPT = "forge/imports/google-sheets.json";
const loopbackHost = (h) => ["localhost", "127.0.0.1", "::1"].includes(h.toLowerCase());
const privateAddress = (a) => {
  if (!isIP(a)) return true;
  if (a.includes(":")) {
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return privateAddress(mapped[1]);
    return a === "::" || a === "::1" || /^f[cd]/i.test(a) || /^fe[89ab]/i.test(a) || /^ff/i.test(a);
  }
  const p = a.split(".").map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
};
async function safeSyncUrl(raw) {
  const u = new URL(raw);
  if (u.username || u.password) throw new Error("source URLs cannot contain credentials");
  const devLoopback = loopbackHost(u.hostname) && loopbackHost(new URL(PUBLIC_ORIGIN).hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && devLoopback))
    throw new Error("Sheet/CSV sources must use HTTPS");
  if (!devLoopback) {
    const addresses = await lookup(u.hostname, { all: true });
    if (!addresses.length || addresses.some(a => privateAddress(a.address)))
      throw new Error("source resolves to a private or unsafe network address");
  }
  return u;
}
async function fetchCsv(url) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
  try {
    let current = await safeSyncUrl(url), r;
    for (let redirect = 0; redirect <= 5; redirect++) {
      r = await fetch(current, { signal: ac.signal, redirect: "manual",
        headers: { accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" } });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        if (redirect === 5) throw new Error("source redirected too many times");
        current = await safeSyncUrl(new URL(r.headers.get("location"), current).toString());
        continue;
      }
      break;
    }
    if (!r.ok) throw new Error(`source returned ${r.status}`);
    const declared = parseInt(r.headers.get("content-length") || "0", 10);
    if (declared > MAX_SHEET_BYTES) throw new Error("sheet is larger than the 5 MB working-copy limit");
    const text = await r.text();
    if (Buffer.byteLength(text) > MAX_SHEET_BYTES) throw new Error("sheet is larger than the 5 MB working-copy limit");
    if (/^\s*<(!doctype|html)/i.test(text))
      throw new Error("got a web page, not CSV — share the Sheet as 'anyone with the link' and select a tab");
    const hash = fingerprintCsv(text);
    return { text, hash, revision: r.headers.get("etag") || r.headers.get("last-modified") || `sha256:${hash}`,
      fetched_url: current.toString() };
  } finally { clearTimeout(t); }
}
function sheetSnapshot(body, fallbackUrl = "") {
  const tableText = value => typeof value === "string" ? value : value?.snapshot_csv ?? value?.csv;
  const text = tableText(body?.tables?.cards) ?? body?.snapshot_csv ?? body?.csv;
  if (text === undefined) return null;
  if (typeof text !== "string") throw Object.assign(new Error("the Sheet snapshot must be CSV text"), { status: 422 });
  const printings = tableText(body?.tables?.printings);
  if (printings !== undefined && typeof printings !== "string")
    throw Object.assign(new Error("the Printings tab snapshot must be CSV text"), { status: 422 });
  const total = Buffer.byteLength(text) + Buffer.byteLength(printings || "");
  if (total > MAX_SHEET_BYTES) throw Object.assign(new Error("Sheet tables are larger than the 5 MB working-copy limit"), { status: 422 });
  const hash = printings === undefined ? fingerprintCsv(text) : createHash("sha256")
    .update(`cards\0${text}\0printings\0${printings}`).digest("hex");
  return { text, hash, revision: String(body.source_revision || `sha256:${hash}`),
    fetched_url: fallbackUrl || String(body.source_id || "google-sheets-addon"),
    tables: { cards: { text, source_id: body?.tables?.cards?.source_id || null },
      ...(printings === undefined ? {} : { printings: { text: printings, source_id: body?.tables?.printings?.source_id || null } }) } };
}
const addonSourceUrl = (sourceId) => `gsheet://google/${encodeURIComponent(sourceId)}`;
const addonSourceId = (url) => url?.startsWith("gsheet://google/")
  ? decodeURIComponent(url.slice("gsheet://google/".length)) : null;
async function workingCopySource(src, body = {}) {
  const supplied = sheetSnapshot(body, src.url);
  const expectedId = addonSourceId(src.url);
  if (supplied) {
    if (expectedId && String(body.source_id || "") !== expectedId) {
      throw Object.assign(new Error("this snapshot came from a different spreadsheet or tab"), { status: 409 });
    }
    return supplied;
  }
  if (expectedId) {
    throw Object.assign(new Error("this is a private Sheet working copy — open Forge in that Sheet to check or build it"), { status: 422 });
  }
  return fetchCsv(src.url);
}
async function syncStateAt(slug, ref) {
  const { dir, cleanup } = await store.materialize(slug, ref);
  try {
    return { cards: JSON.parse(readFileSync(join(dir, "components/cards.json"), "utf8")),
      printings: JSON.parse(readFileSync(join(dir, "components/printings.json"), "utf8")) };
  } finally { cleanup(); }
}
const changedRecords = (a, b) => {
  const A = new Map(a.map(v => [v.id, v])), B = new Map(b.map(v => [v.id, v]));
  return [...new Set([...A.keys(), ...B.keys()])].filter(id => JSON.stringify(A.get(id)) !== JSON.stringify(B.get(id)));
};
async function sheetSyncPlan(slug, src, body = {}) {
  const headSha = await store.headSha(slug);
  const baseSha = src.last_sha || headSha;
  let base;
  try { base = await syncStateAt(slug, baseSha); }
  catch (cause) { throw Object.assign(new Error(`the previous Sheet candidate base is no longer available — reattach the Sheet to establish a new base (${cause.message})`), { status: 409 }); }
  const forge = baseSha === headSha ? base : await syncStateAt(slug, headSha);
  const source = await workingCopySource(src, body);
  const parsed = csvToCards(source.text);
  if (!parsed.cards.length) throw Object.assign(new Error("no cards in the Sheet — refusing to wipe the game"), { status: 422, warnings: parsed.warnings });
  const sheetCards = sheetCardsFromBase(base.cards, parsed);
  const printingTable = source.tables?.printings
    ? sheetPrintingsFromTable(base.printings, source.tables.printings.text) : null;
  const sheetPrintings = printingTable?.printings || sheetPrintingsFromBase(base.printings, sheetCards, parsed);
  if (printingTable) {
    const cardIds = new Set(sheetCards.map(card => card.id));
    const orphan = sheetPrintings.find(printing => !cardIds.has(printing.card_id));
    if (orphan) throw Object.assign(new Error(`Printings row '${orphan.id}' refers to missing card '${orphan.card_id}'`), { status: 422 });
    parsed.warnings.push(...printingTable.warnings);
    parsed.identitySafe = parsed.identitySafe && printingTable.identitySafe;
  }
  const merged = mergeSheetState({ baseCards: base.cards, forgeCards: forge.cards, sheetCards,
    basePrintings: base.printings, forgePrintings: forge.printings, sheetPrintings });
  return { headSha, baseSha, base, forge, source, parsed, sheetCards, sheetPrintings, merged,
    changes: diffCards(forge.cards, merged.cards),
    forgeChanges: diffCards(base.cards, forge.cards), remoteChanges: diffCards(base.cards, sheetCards),
    printingChanges: changedRecords(forge.printings, merged.printings) };
}
const sheetCandidateFiles = (plan) => ({
  cards: JSON.stringify(plan.merged.cards, null, 2) + "\n",
  printings: JSON.stringify(plan.merged.printings, null, 2) + "\n",
});
async function validateSheetCandidate(slug, plan) {
  if (plan.merged.conflicts.length) return { ok: false, skipped: true,
    report: ["Resolve working-copy conflicts before validation."] };
  const content = sheetCandidateFiles(plan);
  return validateCandidate(slug, "components/cards.json", content.cards,
    { "components/printings.json": content.printings });
}
function sheetCandidatePayload(plan, validation) {
  const candidateCards = new Map(plan.merged.cards.map(c => [c.id, c]));
  const currentCards = new Map(plan.forge.cards.map(c => [c.id, c]));
  const printingById = new Map([...plan.forge.printings, ...plan.merged.printings].map(p => [p.id, p]));
  const affected = new Set(plan.changes.map(c => c.card));
  for (const id of plan.printingChanges) if (printingById.get(id)?.card_id) affected.add(printingById.get(id).card_id);
  const cards = [...affected].map(id => ({ id, before: currentCards.get(id) ?? null,
    candidate: candidateCards.get(id) ?? null,
    printings: plan.merged.printings.filter(p => p.card_id === id) }));
  const cardIds = new Set(plan.changes.map(c => c.card));
  const counts = {
    cards: cardIds.size,
    fields: plan.changes.filter(c => c.kind === "changed").length,
    added: new Set(plan.changes.filter(c => c.kind === "added").map(c => c.card)).size,
    removed: new Set(plan.changes.filter(c => c.kind === "removed").map(c => c.card)).size,
    modified: new Set(plan.changes.filter(c => c.kind === "changed").map(c => c.card)).size,
    printings: plan.printingChanges.length,
  };
  const hasChanges = !!(plan.changes.length || plan.printingChanges.length);
  const canCommit = !plan.merged.conflicts.length && validation.ok;
  const status = plan.merged.conflicts.length ? "conflicts" : !validation.ok ? "invalid" : hasChanges ? "changes" : "clean";
  return { changes: plan.changes, printing_changes: plan.printingChanges,
    forge_changes: plan.forgeChanges, sheet_changes: plan.remoteChanges,
    conflicts: plan.merged.conflicts, can_apply: canCommit, can_commit: canCommit,
    warnings: plan.parsed.warnings, identity_safe: plan.parsed.identitySafe,
    validation, candidate_cards: cards, counts, status,
    summary: summarize(plan.changes)?.title ?? null };
}
gw.route("GET", "/api/games/:slug/sync", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const s = await q.sourceFor(db, slug, "sheet");
  if (!s) return ctx.send(200, { connected: false });
  const headSha = await store.headSha(slug);
  ctx.send(200, { connected: true, kind: "sheet", url: s.url,
    source_mode: addonSourceId(s.url) ? "addon" : "published", source_id: addonSourceId(s.url), last_sync: s.last_sync,
    adapter: s.adapter_id ? { id: s.adapter_id, version: s.adapter_version } : null,
    mapping: s.mapping_json ? JSON.parse(s.mapping_json) : null, last_receipt_sha: s.last_receipt_sha || null,
    base_sha: s.last_sha, source_hash: s.source_hash, source_revision: s.source_revision,
    head_sha: headSha, forge_ahead: !!s.last_sha && s.last_sha !== headSha });
}, "is this game attached to a Sheet working copy?");
gw.route("PUT", "/api/games/:slug/sync/sheet", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const body = await json(ctx);
  const { url, source_id: sourceId } = body;
  if (!sourceId && (!url || !/^https?:\/\//i.test(url)))
    return ctx.send(422, { error: "provide a Google Sheet/CSV URL, or connect from the Forge Sheets add-on" });
  const norm = sourceId ? addonSourceUrl(String(sourceId)) : normalizeSheetUrl(url.trim());
  try { const source = sourceId ? sheetSnapshot(body, norm) : await fetchCsv(norm);
    if (!source) return ctx.send(422, { error: "the Sheets add-on must include the active tab snapshot" });
    const parsed = csvToCards(source.text);
    if (!parsed.cards.length) return ctx.send(422, { error: "could not read any cards from that Sheet", warnings: parsed.warnings });
    const printingTable = source.tables?.printings ? sheetPrintingsFromTable([], source.tables.printings.text) : null;
    if (printingTable) parsed.warnings.push(...printingTable.warnings);
    const headSha = await store.headSha(slug);
    const mapping = Object.fromEntries(Object.entries(source.tables || { cards: {} })
      .map(([role, table]) => [role, table.source_id || (role === "cards" ? String(sourceId || norm) : null)]));
    await q.connectSource(db, { game_slug: slug, kind: "sheet", url: norm, connected_by: u.id, last_sha: headSha,
      adapter_id: sourceId ? SHEETS_ADAPTER.id : "published-csv-working-copy", adapter_version: SHEETS_ADAPTER.version,
      mapping_json: JSON.stringify(mapping) });
    ctx.send(200, { connected: true, url: norm, cards: parsed.cards.length,
      printings: printingTable?.printings.length ?? null, warnings: parsed.warnings,
      tables: Object.keys(source.tables || { cards: true }), identity_safe: parsed.identitySafe && (!printingTable || printingTable.identitySafe), base_sha: headSha, source_hash: source.hash,
      adapter: { id: sourceId ? SHEETS_ADAPTER.id : "published-csv-working-copy", version: SHEETS_ADAPTER.version },
      source_mode: sourceId ? "addon" : "published",
      message: "Working copy attached. Check its draft changes before building a candidate." });
  } catch (e) { return ctx.send(422, { error: `couldn't read the sheet: ${e.message}` }); }
}, "attach a public or add-on-provided Sheet as an external working copy");
gw.route("DELETE", "/api/games/:slug/sync/sheet", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  await q.disconnectSource(db, slug, "sheet");
  ctx.send(200, { connected: false });
}, "detach the Sheet working copy");
gw.route("POST", "/api/games/:slug/sync/pull", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const src = await q.sourceFor(db, slug, "sheet");
  if (!src) return ctx.send(422, { error: "no Sheet working copy attached" });
  const dry = ctx.url.searchParams.has("dry");
  let body;
  try { body = await optionalJson(ctx); }
  catch { return ctx.send(400, { error: "request body must be valid JSON" }); }
  let plan;
  try { plan = await sheetSyncPlan(slug, src, body); }
  catch (e) { return ctx.send(e.status || 502, { error: `couldn't read the Sheet working copy: ${e.message}`, warnings: e.warnings }); }
  const validation = await validateSheetCandidate(slug, plan);
  const preview = { source_hash: plan.source.hash, source_revision: plan.source.revision,
    head_sha: plan.headSha, base_sha: plan.baseSha };
  const payload = { ...sheetCandidatePayload(plan, validation), preview };
  if (dry) return ctx.send(200, { dry: true, ...payload });
  const expectedSource = ctx.url.searchParams.get("source_hash") || body.preview?.source_hash;
  const expectedHead = ctx.url.searchParams.get("head_sha") || body.preview?.head_sha;
  if (!expectedSource || !expectedHead)
    return ctx.send(409, { error: "check the working copy first, then commit that exact reviewed candidate", stale: "preview", ...payload });
  if (expectedSource && expectedSource !== plan.source.hash)
    return ctx.send(409, { error: "the Sheet changed after review — check it again before committing", stale: "sheet", ...payload });
  if (expectedHead && expectedHead !== plan.headSha)
    return ctx.send(409, { error: "Forge changed after review — check again so those edits are included", stale: "forge", ...payload });
  if (plan.merged.conflicts.length)
    return ctx.send(409, { error: "Sheet and Forge changed the same fields differently — resolve the conflicts before committing", ...payload });
  if (!validation.ok)
    return ctx.send(422, { error: "the candidate fails game validation — nothing was committed", report: validation.report, ...payload });
  if (!plan.changes.length && !plan.printingChanges.length) {
    return ctx.send(200, { saved: false, message: "no draft changes to build", ...payload });
  }
  if (await store.headSha(slug) !== plan.headSha)
    return ctx.send(409, { error: "Forge changed while the candidate was being validated — check again", stale: "forge", ...payload });
  const auto = summarize(plan.changes);
  const requested = String(body.commit_message || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const subject = requested || `sheet: build candidate with ${plan.changes.length} card change${plan.changes.length === 1 ? "" : "s"} and ${plan.printingChanges.length} printing change${plan.printingChanges.length === 1 ? "" : "s"}`;
  const contributors = Array.isArray(body.contributors) ? body.contributors
    .map(v => String(v).trim().replace(/[\r\n]+/g, " ").slice(0, 80)).filter(Boolean).slice(0, 20) : [];
  const content = sheetCandidateFiles(plan);
  const detail = [auto?.body, contributors.length ? `Contributors: ${contributors.join(", ")}` : null,
    `Source: attached Sheet working copy\nBase: ${plan.baseSha}`].filter(Boolean).join("\n\n");
  const receipt = {
    format: "forge-import-receipt", version: 1,
    adapter: { id: src.adapter_id || SHEETS_ADAPTER.id, version: src.adapter_version || SHEETS_ADAPTER.version,
      mode: "working-copy-promotion" },
    source: { id: addonSourceId(src.url) || src.url, revision: plan.source.revision, sha256: plan.source.hash,
      tables: Object.fromEntries(Object.entries(plan.source.tables || { cards: {} }).map(([role, table]) => [role, table.source_id || null])) },
    reviewed: { base_sha: plan.baseSha, head_sha: plan.headSha },
    promoted_by: u.handle, promoted_at: new Date().toISOString(),
    changes: { card_fields: plan.changes.length, printings: plan.printingChanges.length },
  };
  const receiptContent = JSON.stringify(receipt, null, 2) + "\n";
  const game = await q.gameBySlug(db, slug);
  const rights = setFileRight(await store.readFile(slug, RIGHTS_MANIFEST), SHEET_RECEIPT,
    { license: "CC0-1.0", status: "generated", copyright: [`Forge metadata for ${u.handle}`], redistribution: "allowed" },
    { license: game?.license || "unknown", owner: u.handle, status: "unknown" });
  const rightsContent = rightsReceiptBytes(rights);
  const { sha } = await store.writeFiles(slug,
    [{ path: "components/cards.json", content: content.cards }, { path: "components/printings.json", content: content.printings },
      { path: SHEET_RECEIPT, content: receiptContent }, { path: RIGHTS_MANIFEST, content: rightsContent }],
    `${subject}\n\n${detail}`,
    `${u.handle} <${u.email}>`);
  await q.recordSync(db, slug, "sheet", sha, plan.source.hash, plan.source.revision, sha);
  ctx.send(200, { saved: true, commit: sha, commit_message: subject, import_receipt: SHEET_RECEIPT,
    adapter: receipt.adapter, ...payload, summary: auto?.title ?? null });
}, "Sheet working copy → semantic/visual candidate → optimistic, validated commit (?dry=1 checks)");

/* ---------- routes: releases (citable, immutable versions) ---------- */
const TAG_RE = /^v[0-9][0-9A-Za-z._-]{0,31}$/;
function artifactReceipt(dir) {
  const files = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const file = join(path, name), stat = statSync(file);
      if (stat.isDirectory()) walk(file);
      else files.push({ status: "ready", name: relative(dir, file).replaceAll("\\", "/"), bytes: stat.size,
        sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
    }
  };
  walk(dir);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
gw.route("GET", "/api/games/:slug/releases", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  ctx.send(200, (await q.releasesFor(db, slug)).map(r => {
    const rights = r.rights_json ? JSON.parse(r.rights_json) : null;
    return { ...r, rights_json: undefined,
      tag_annotated: !!r.tag_annotated, tag_protected: !!r.tag_protected,
      artifacts: r.artifacts_json ? JSON.parse(r.artifacts_json) : [],
      rights: rights ? { publishable: rights.publishable, manifest_sha256: rights.manifest_sha256,
        file_count: rights.files?.length || 0, blockers: rights.blockers || [] } : null };
  }));
}, "list a game's releases (citable versions)");
gw.route("GET", "/api/games/:slug/releases/:tag", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const r = await q.releaseByTag(db, slug, ctx.params.tag);
  if (!r) return ctx.send(404, { error: "no such release" });
  const base = `/cache/exports/${slug}/${r.sha}`;
  const liveTag = await store.releaseTagInfo(slug, r.tag);
  const artifacts = r.artifacts_json ? JSON.parse(r.artifacts_json) : [];
  const ready = new Set(artifacts.filter(a => a.status === "ready").map(a => a.name));
  const downloads = {};
  if (ready.has("print-ready.zip")) downloads.print = `${base}/print-ready.zip`;
  if (ready.has("pnp.pdf")) downloads.pnp = `${base}/pnp.pdf`;
  if (ready.has("tts.json")) downloads.tts = `${base}/tts.json`;
  if (ready.has(`${slug}-ttc.zip`)) downloads.ttc = `${base}/${slug}-ttc.zip`;
  if (ready.has(cache.vttArtifactName("vtt"))) downloads.vtt = `${base}/${cache.vttArtifactName("vtt")}`;
  ctx.send(200, { tag: r.tag, sha: r.sha, title: r.title, notes: r.notes, author: r.author_handle, created_at: r.created_at,
    repository_tag: { object_sha: r.tag_object_sha, annotated: !!r.tag_annotated,
      protected: !!r.tag_protected, verified_now: !!liveTag && liveTag.annotated && liveTag.protected
        && String(liveTag.target).startsWith(r.sha) },
    artifacts, rights: r.rights_json ? JSON.parse(r.rights_json) : null, downloads });
}, "release detail + frozen (immutable) export URLs pinned to the exact sha");
gw.route("POST", "/api/games/:slug/releases", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  if (!await canAdmin(u, slug, { releases: true })) return ctx.send(403, { error: "only the game's owner can cut a release (an open sandbox/ownerless game may be cut by any signed-in user, but a collaborator alone may not)" });
  const { tag, title } = await json(ctx);
  if (!tag || !TAG_RE.test(tag)) return ctx.send(422, { error: "tag must start with v and a number, for example v1.0" });
  if (await q.releaseByTag(db, slug, tag)) return ctx.send(409, { error: `release ${tag} already exists` });
  const sha = await store.headSha(slug);
  const source = await store.materialize(slug, sha);
  let rights, legacyRights;
  try {
    rights = auditRights(source.dir, { sourceSha: sha });
    legacyRights = py("check_licenses.py", [source.dir]);
  }
  finally { source.cleanup(); }
  if (legacyRights.status !== 0) return ctx.send(422, { error: "release blocked by license/provenance checks",
    report: `${legacyRights.stdout || ""}\n${legacyRights.stderr || ""}`.trim().split("\n") });
  if (!rights.publishable) return ctx.send(422, { error: "release blocked by repository rights", rights });
  const prev = (await q.releasesFor(db, slug))[0];
  const hist = await store.history(slug, "components/cards.json", 30);
  let commits = hist;
  if (prev) { const i = hist.findIndex(h => h.sha === prev.sha || h.full === prev.sha); if (i >= 0) commits = hist.slice(0, i); }
  const notes = commits.map(h => `- ${h.subject} (${h.author})`).join("\n") || "- (initial release)";
  let exportDir;
  try {
    for (const kind of ["pnp", "tts", "ttc", "project"])
      await (await queueExportJob({ slug, sha, kind, user: u })).promise;
    exportDir = dirname(cache.pathOf(cache.exportKey(slug, sha, "receipt-placeholder")));
  } catch (error) {
    return ctx.send(500, { error: "a required playable release export failed; no tag or release was created", detail: error.message });
  }
  const optionalFailures = [];
  for (const kind of ["print", "vtt"]) {
    try { await (await queueExportJob({ slug, sha, kind, user: u })).promise; }
    catch (error) { optionalFailures.push({ status: "failed_optional", kind, error: String(error.message).split("\n")[0] }); }
  }
  writeFileSync(join(exportDir, "forge-rights-receipt.json"), rightsReceiptBytes(rights));
  const artifacts = [...artifactReceipt(exportDir), ...optionalFailures];
  const tagMessage = `${title?.trim() || tag}\n\n${notes}\n\nForge project: ${slug}\nExact source: ${sha}`;
  let repositoryTag;
  try { repositoryTag = await store.createReleaseTag(slug, tag, sha, tagMessage, `${u.handle} <${u.email}>`); }
  catch (error) { return ctx.send(409, { error: "repository tag could not be created; release was not published", detail: error.message }); }
  if (!repositoryTag.annotated || !repositoryTag.protected || !String(repositoryTag.target).startsWith(sha))
    return ctx.send(500, { error: "repository tag verification failed; release record was not published" });
  await q.createRelease(db, { game_slug: slug, tag, sha, title: title?.trim() || null, notes, author_id: u.id,
    tag_object_sha: repositoryTag.tagObject, tag_annotated: true, tag_protected: true,
    artifacts_json: JSON.stringify(artifacts), rights_json: JSON.stringify(rights) });
  await q.recordEvent(db, { id: newId("ev"), kind: "release", actor_id: u.id, game_slug: slug, target: tag });
  ctx.send(201, { tag, sha, notes, repository_tag: repositoryTag, artifacts, rights });
}, "cut a release atomically: required exports → annotated protected Git tag → immutable receipt");

/* ---------- routes: discovery + activity feed ---------- */
gw.route("GET", "/api/discover", async (ctx) => {
  const qs = (ctx.url.searchParams.get("q") || "").toLowerCase();
  const genre = (ctx.url.searchParams.get("genre") || "").toLowerCase();
  const tag = (ctx.url.searchParams.get("tag") || "").toLowerCase();
  const clean = (s) => s.replace(/^["']|["']$/g, "").trim();
  const out = [];
  for (const slug of await store.list()) {
    let y = ""; try { y = (await store.readFile(slug, "game.yaml")).toString(); } catch { continue; }
    const title = clean((y.match(/^title:\s*(.+)$/m) || [])[1] || slug);
    const g = clean((y.match(/^genre:\s*(.+)$/m) || [])[1] || "").toLowerCase();
    const desc = clean((y.match(/^description:\s*(.+)$/m) || [])[1] || "");
    const inline = (y.match(/^tags:\s*\[([^\]]*)\]/m) || [])[1];
    const block = (y.match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m) || [])[1];
    const tags = (inline != null ? inline.split(",")
      : (block || "").split("\n").map(l => l.replace(/^\s*-\s*/, "")))
      .map(s => s.replace(/["']/g, "").trim().toLowerCase()).filter(Boolean);
    if (qs && !(title + " " + desc + " " + g + " " + tags.join(" ") + " " + slug).toLowerCase().includes(qs)) continue;
    if (genre && g !== genre) continue;
    if (tag && !tags.includes(tag)) continue;
    out.push({ slug, title, genre: g || null, tags });
  }
  ctx.send(200, out);
}, "discover / search games by text, genre, or tag");
gw.route("GET", "/api/activity", async (ctx) => {
  const handle = ctx.url.searchParams.get("user");
  if (handle) {
    const u = await q.userByHandle(db, handle);
    return ctx.send(200, u ? await q.eventsByActor(db, u.id, 30) : []);
  }
  ctx.send(200, await q.recentEvents(db, 30));
}, "recent activity feed (global, or ?user=<handle> for one person)");
gw.route("GET", "/api/notifications", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  ctx.send(200, { unread: await q.unreadCount(db, u.id), items: await q.notificationsFor(db, u.id, 30) });
}, "your notification inbox");
gw.route("POST", "/api/notifications/read", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  await q.markAllRead(db, u.id);
  ctx.send(200, { ok: true, unread: 0 });
}, "mark all your notifications read");

/* ---------- routes: jams (Store-2-backed entries; the co-creation front door) ---------- */
gw.route("GET", "/api/jams", async (ctx) => {
  const out = [];
  for (const j of JAMS) out.push({ id: j.id, title: j.title, theme: j.theme, tagline: j.tagline ?? "",
    status: jamStatus(j), starts_at: j.starts_at || j.starts, submissions_close_at: j.submissions_close_at || j.ends,
    entries: (await q.jamEntriesFor(db, j.id)).filter(entry => entry.state !== "draft").length });
  ctx.send(200, out);
}, "list jams (definitions + live entry counts)");
gw.route("GET", "/api/jams/:id", async (ctx) => {
  const j = jamById(ctx.params.id);
  if (!j) return ctx.send(404, { error: "no such jam" });
  const entries = (await q.jamEntriesFor(db, j.id)).map(e => ({ game_slug: e.game_slug,
    title: e.title ?? e.game_slug, author: e.author_handle ?? null, forked_from: e.forked_from ?? null,
    state: e.state || "draft", qualified: !!e.qualified, award: e.award ?? null, submitted_at: e.submitted_at,
    release: e.release_sha ? { tag: e.release_tag, sha: e.release_sha } : null,
    team: e.team_json ? JSON.parse(e.team_json) : [] }));
  ctx.send(200, { ...j, status: jamStatus(j), entries });
}, "jam detail: definition + LIVE entries (Store 2)");
gw.route("POST", "/api/jams/:id/join", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const j = jamById(ctx.params.id);
  if (!j) return ctx.send(404, { error: "no such jam" });
  const status = jamStatus(j);
  if (status !== "open") return ctx.send(409, { error: `jam is ${status} — not accepting entries` });
  const starter = join(ROOT, "jams", `${j.id}-starter.csv`);
  const csv = existsSync(starter) ? readFileSync(starter, "utf8")
    : `name,type,text\n${j.theme} Spark,card,"A ${j.theme} to build on."`;
  const r = await hostGame(u, `${u.handle}'s ${j.theme} entry`, csv, await authorOf(ctx));
  if (r.error) return ctx.send(r.error.code, r.error.body);
  await q.enterJam(db, { jam_id: j.id, game_slug: r.slug, user_id: u.id, qualified: 1, state: "draft" });
  await q.recordEvent(db, { id: newId("ev"), kind: "jam_join", actor_id: u.id, game_slug: r.slug, target: j.id });
  ctx.send(201, { slug: r.slug, entered: true, state: "draft",
    url: `/#${publicProjectPath({ namespace: r.namespace, slug: r.repo_slug })}` });
}, "one-click join: create a correctly licensed draft starter in your account");
async function qualifyJamGame(jam, game, ref = "HEAD") {
  const materialized = await store.materialize(game, ref);
  try {
    const cards = JSON.parse(readFileSync(join(materialized.dir, "components/cards.json"), "utf8"));
    const printings = JSON.parse(readFileSync(join(materialized.dir, "components/printings.json"), "utf8"));
    const gameYaml = readFileSync(join(materialized.dir, "game.yaml"), "utf8");
    let rulesMd = ""; try { rulesMd = readFileSync(join(materialized.dir, "rules/rules.md"), "utf8"); } catch {}
    return jamQualify(jam, { gameYaml, cards, printings, rulesMd });
  } finally { materialized.cleanup(); }
}
gw.route("GET", "/api/jams/:id/eligibility", async (ctx) => {
  const j = jamById(ctx.params.id); if (!j) return ctx.send(404, { error: "no such jam" });
  const game = ctx.url.searchParams.get("game"), ref = ctx.url.searchParams.get("ref") || "HEAD";
  if (!game || !store.has(game)) return ctx.send(422, { error: "choose a Forge game" });
  try { ctx.send(200, { game, ref, status: jamStatus(j), ...(await qualifyJamGame(j, game, ref)) }); }
  catch (error) { ctx.send(422, { error: `could not check ${game}@${ref}: ${error.message}` }); }
}, "continuously check a project or release against machine-readable jam constraints");
gw.route("POST", "/api/jams/:id/submit", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const j = jamById(ctx.params.id);
  if (!j) return ctx.send(404, { error: "no such jam" });
  const status = jamStatus(j);
  if (status !== "open") return ctx.send(409, { error: `jam is ${status} — submissions are frozen` });
  const { game, release: releaseTag, team = [] } = await json(ctx);
  if (!game || !store.has(game)) return ctx.send(422, { error: "unknown game" });
  const g = await q.gameBySlug(db, game);
  if (g?.owner_id !== u.id) return ctx.send(403, { error: "you can only submit a game you own" });
  // Give design feedback before demanding packaging, so an off-theme draft
  // gets the useful constraint failure rather than only “cut a release”.
  const head = await qualifyJamGame(j, game, "HEAD");
  if (!head.qualified) return ctx.send(422, { error: "entry does not qualify", reasons: head.reasons, eligibility: head });
  if (!releaseTag) return ctx.send(422, { error: "submit an immutable Forge release tag, not mutable project HEAD" });
  const release = await q.releaseByTag(db, game, String(releaseTag));
  if (!release) return ctx.send(422, { error: `release '${releaseTag}' does not exist on this game` });
  const res = await qualifyJamGame(j, game, release.sha);
  if (!res.qualified) return ctx.send(422, { error: "entry does not qualify", reasons: res.reasons });
  const handles = [...new Set([u.handle, ...(Array.isArray(team) ? team : [])]
    .map(value => String(value).trim().replace(/^@/, "")).filter(value => validHandle(value)).slice(0, 12))];
  const prior = await q.jamEntryOf(db, j.id, game), submittedAt = new Date(nowMs()).toISOString();
  const definitionHash = createHash("sha256").update(JSON.stringify(j)).digest("hex");
  const receipt = { format: "forge-jam-submission", version: 1, jam: j.id, definition_sha256: definitionHash,
    game, release: { tag: release.tag, sha: release.sha }, submitted_by: u.handle, team: handles,
    submitted_at: submittedAt, eligibility: res,
    rights: release.rights_json ? { sha256: createHash("sha256").update(release.rights_json).digest("hex") } : null };
  receipt.sha256 = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  const receiptJson = JSON.stringify(receipt);
  await q.enterJam(db, { jam_id: j.id, game_slug: game, user_id: u.id, qualified: 1, state: "submitted",
    release_tag: release.tag, release_sha: release.sha, receipt_json: receiptJson, team_json: JSON.stringify(handles),
    replaced_at: prior?.release_sha ? nowMs() : null });
  const action = prior?.release_sha ? "replace" : "submit";
  await q.recordJamSubmission(db, { id: newId("jsub"), jam_id: j.id, game_slug: game, user_id: u.id,
    release_tag: release.tag, release_sha: release.sha, receipt_json: receiptJson, action });
  await q.recordJamAudit(db, { id: newId("ja"), jam_id: j.id, actor_id: u.id, action,
    target: `${game}@${release.tag}`, detail_json: JSON.stringify({ receipt_sha256: receipt.sha256 }) });
  await q.recordEvent(db, { id: newId("ev"), kind: "jam_submit", actor_id: u.id, game_slug: game, target: `${j.id}:${release.tag}` });
  ctx.send(prior?.release_sha ? 200 : 201, { entered: true, state: "submitted", qualified: true,
    game, release: receipt.release, receipt });
}, "pin an eligible, rights-checked Forge release as an immutable jam submission");
gw.route("GET", "/api/jams/:id/entries/:slug/history", async (ctx) => {
  const j = jamById(ctx.params.id); if (!j) return ctx.send(404, { error: "no such jam" });
  const entry = await q.jamEntryOf(db, j.id, ctx.params.slug); if (!entry) return ctx.send(404, { error: "no such entry" });
  const u = await authedUser(ctx);
  if (jamStatus(j) === "open" && entry.user_id !== u?.id) return ctx.send(404, { error: "entry history is private until submissions close" });
  ctx.send(200, (await q.jamSubmissionHistory(db, j.id, ctx.params.slug)).map(item => ({ ...item,
    receipt: JSON.parse(item.receipt_json), receipt_json: undefined })));
}, "immutable submission and replacement history");
gw.route("GET", "/api/jams/:id/archive", async (ctx) => {
  const j = jamById(ctx.params.id); if (!j) return ctx.send(404, { error: "no such jam" });
  const entries = (await q.jamEntriesFor(db, j.id)).filter(entry => entry.release_sha && entry.state === "submitted")
    .map(entry => ({ game: entry.game_slug, release: { tag: entry.release_tag, sha: entry.release_sha },
      receipt: JSON.parse(entry.receipt_json), award: entry.award || null }));
  const archive = { format: "forge-jam-archive", version: 1, jam: j, status: jamStatus(j), entries };
  archive.sha256 = createHash("sha256").update(JSON.stringify(archive)).digest("hex");
  ctx.send(200, archive);
}, "downloadable permanent manifest of commit-pinned jam entries");

/* ---------- boot ---------- */
const nGames = (await Promise.resolve(store.list())).length;
gw.listen(PORT, (port) => console.log(
  `forge-platform gateway on http://localhost:${port}\n` +
  `  store1: ${store.kind} · games: ${nGames} · readonly: ${READONLY}\n` +
  `  GET /api for the route index · /healthz for probes`));
