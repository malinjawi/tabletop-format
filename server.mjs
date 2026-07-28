#!/usr/bin/env node
/**
 * server.mjs — the platform backend (Block G), now a real GATEWAY.
 * Usage: node server.mjs [--port 8420] [--games <dir>] [--readonly]
 * Env: STORE1 (local|forgejo) · LFS_URL (local asset mode) · DB_PATH (Store 2)
 *      CACHE_DIR (Store 3) · FORGE_URL/FORGE_TOKEN (forgejo backend)
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
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createGateway, readBody } from "./platform/gateway.mjs";
import { diffCards, summarize, mergeCards } from "./tools/lib/carddiff.mjs";
import { assertAssetAllowed } from "./tools/lib/limits.mjs";
import { newId } from "./platform/db.mjs";
import { hashPassword, verifyPassword, newToken, SESSION_TTL_MS, validHandle, validEmail } from "./platform/auth.mjs";
import * as cache from "./platform/cache.mjs";
import { createLocalStore } from "./platform/store1-local.mjs";

/* ---------- config ---------- */
const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const PORT = parseInt(opt("--port", "8420"), 10);
const GAMES_DIR = resolve(opt("--games", join(ROOT, "examples")));
const READONLY = args.includes("--readonly");
const RATE = { windowMs: 60_000, max: 120 };
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
               svg: "image/svg+xml", ogg: "audio/ogg", mp3: "audio/mpeg", woff2: "font/woff2",
               pdf: "application/pdf", json: "application/json" };

/* ---------- stores ---------- */
// Store 2 — driver behind the same q surface: node:sqlite (dev) or Postgres (prod)
const { openDb, q } = process.env.DB === "postgres"
  ? await import("./platform/db-pg.mjs") : await import("./platform/db.mjs");
const db = await openDb();
const py = (script, a) => spawnSync("python3", [join(ROOT, "tools", script), ...a], { encoding: "utf8" });

// Store 1 — THE seam. Routes below talk to `store` only; no git, no game paths.
const STORE1 = process.env.STORE1 ?? "local";
const store = STORE1 === "forgejo"
  ? (await import("./platform/store1-forgejo.mjs")).createForgejoStore({
      root: ROOT, forgeUrl: process.env.FORGE_URL, token: process.env.FORGE_TOKEN,
      basicAuth: process.env.FORGE_BASIC ?? null, farmDir: process.env.FARM_DIR })
  : createLocalStore({ root: ROOT, gamesDir: GAMES_DIR, lfsUrl: process.env.LFS_URL ?? null });
const mat = (slug) => (ref) => store.materialize(slug, ref); // Store-3 feed

async function reindexGames() { // DA-3: derived, rebuildable
  for (const slug of await store.list()) {
    const m = await store.readMeta(slug);
    await q.upsertGame(db, { slug, title: m.title, license: m.license, card_count: m.cardCount });
  }
}
await reindexGames();

let hubVersion = null;
async function hubHtml() {
  const v = await store.catalogVersion();
  const out = join(ROOT, "hub.html");
  if (!existsSync(out) || hubVersion !== v) {
    const r = py("build_hub.py", ["-o", out, "--games", await store.treeRoot()]);
    if (r.status !== 0) throw new Error(r.stderr);
    hubVersion = v;
  }
  return readFileSync(out, "utf8");
}

/* ---------- gateway + middleware ---------- */
const gw = createGateway({ name: "forge-platform", version: "0.2" });
const hits = new Map();
gw.use((ctx) => { if (ctx.req.method === "OPTIONS") ctx.send(204, ""); });
gw.use((ctx) => { // rate limit
  const ip = ctx.req.socket.remoteAddress ?? "?";
  const now = Date.now();
  const h = hits.get(ip) ?? { t: now, n: 0 };
  if (now - h.t > RATE.windowMs) { h.t = now; h.n = 0; }
  h.n++; hits.set(ip, h);
  if (hits.size > 10_000) hits.clear();
  if (h.n > RATE.max) ctx.send(429, { error: "rate limited — be gentle" });
});
gw.use((ctx) => { // readonly gate (showcase mode)
  if (READONLY && ctx.req.method !== "GET")
    ctx.send(403, { error: "read-only beta — clone the repo to make it yours" });
});
const authedUser = async (ctx) => {
  const m = (ctx.req.headers.authorization ?? "").match(/^Bearer (\w{64})$/);
  return m ? q.sessionUser(db, m[1]) : null;
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
  return !!(await q.isCollaborator(db, slug, u.id));
}
const denyWrite = (ctx, u) => u
  ? ctx.send(403, { error: "no commit access to this game", propose: true,
      hint: "fork it and open a PR (POST /api/games/:slug/cards/propose does both in one step), or ask the owner for access" })
  : ctx.send(401, { error: "sign in to save changes" });

const requireGame = (ctx) => {
  if (!store.has(ctx.params.slug)) { ctx.send(404, { error: `no game '${ctx.params.slug}'` }); return null; }
  return ctx.params.slug;
};
const json = async (ctx) => JSON.parse((await readBody(ctx.req)).toString());

/** Validate a candidate tree = game at HEAD + one replaced file. Never touches
 *  the live tree — the rollback path is simply "don't commit". Backend-agnostic. */
async function validateCandidate(slug, relPath, content) {
  const { dir, cleanup } = await store.materialize(slug, "HEAD");
  try {
    writeFileSync(join(dir, relPath), content);
    const v = py("validate.py", [dir]);
    return { ok: v.status === 0, report: v.stdout.split("\n") };
  } finally { cleanup(); }
}

/* ---------- routes: hub + live editor ---------- */
gw.route("GET", "/", async (ctx) => ctx.send(200, await hubHtml(), "text/html; charset=utf-8"), "hub UI");
const editorBuilt = new Map(); // slug -> {version}
gw.route("GET", "/edit/:slug", async (ctx) => {
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
  const kind = file.startsWith("pnp") ? "pnp" : "tts";
  const { dir } = await cache.ensureExport(mat(slug), slug, ref, kind);
  const fp = join(dir, file);
  if (!existsSync(fp)) return ctx.send(404, { error: "not producible" });
  ctx.sendRaw(200, readFileSync(fp), { "content-type": MIME[fp.split(".").pop()] ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable" });
}, "frozen export artifact (sha or release tag)");

/* ---------- routes: Store 2 — identity & social ---------- */
gw.route("POST", "/api/auth/register", async (ctx) => {
  const { handle, email, password } = await json(ctx);
  if (!validHandle(handle)) return ctx.send(422, { error: "handle: 2-32 chars, kebab-case" });
  if (!validEmail(email)) return ctx.send(422, { error: "invalid email" });
  if ((password ?? "").length < 8) return ctx.send(422, { error: "password: 8+ chars" });
  if (await q.userByHandle(db, handle) || await q.userByEmail(db, email)) return ctx.send(409, { error: "handle or email already registered" });
  const id = newId("u");
  await q.createUser(db, { id, handle, email, pass_hash: hashPassword(password) });
  const token = newToken();
  await q.createSession(db, token, id, SESSION_TTL_MS);
  ctx.send(201, { token, user: { id, handle } });
}, "create account");
gw.route("POST", "/api/auth/login", async (ctx) => {
  const { handle, password } = await json(ctx);
  const u = await q.userByHandle(db, handle) ?? await q.userByEmail(db, handle);
  if (!u || !verifyPassword(password ?? "", u.pass_hash)) return ctx.send(401, { error: "bad credentials" });
  const token = newToken();
  await q.createSession(db, token, u.id, SESSION_TTL_MS);
  ctx.send(200, { token, user: { id: u.id, handle: u.handle } });
}, "get session token");
gw.route("GET", "/api/me", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  ctx.send(200, { id: u.id, handle: u.handle, email: u.email,
    claims: await q.claimsOf(db, u.id), starred: (await q.starredBy(db, u.id)).map(r => r.game_slug),
    games: await q.gamesOwnedBy(db, u.id) });
}, "who am I + claims + stars + owned games");
gw.route("POST", "/api/games", async (ctx) => {
  // THE HOSTING VERB: a designer brings a CSV, leaves with a hosted, owned, versioned game
  const u = await requireAuth(ctx); if (!u) return;
  const { title, csv } = await json(ctx);
  if (!title?.trim()) return ctx.send(422, { error: "title required" });
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  if (!slug || store.has(slug)) return ctx.send(409, { error: `slug '${slug}' unavailable` });
  // import into a SCRATCH tree, validate there, only then let the store commit it —
  // no backend ever holds an invalid or uncommitted game
  const tmp = mkdtempSync(join(tmpdir(), "csv-"));
  try {
    writeFileSync(join(tmp, "in.csv"), csv ?? "name,type,text\nFirst Card,card,Hello world.");
    const imp = spawnSync(process.execPath,
      [join(ROOT, "tools/import-csv.mjs"), join(tmp, "in.csv"), join(tmp, "game"), "--title", title.trim()],
      { encoding: "utf8" });
    if (imp.status !== 0) return ctx.send(422, { error: "import failed", detail: imp.stderr });
    const v = py("validate.py", [join(tmp, "game")]);
    if (v.status !== 0) return ctx.send(422, { error: "imported game failed validation", report: v.stdout.split("\n") });
    const { sha } = await store.createGame(slug, join(tmp, "game"),
      `new game: ${title.trim()} (${slug})\n\nimported from CSV via platform`, await authorOf(ctx));
    await reindexGames();
    await q.setForkMeta(db, slug, null, u.id);  // ownership
    ctx.send(201, { slug, owner: u.handle, commit: sha,
      cards: JSON.parse((await store.readFile(slug, "components/cards.json")).toString()).length,
      url: `/#/g/${slug}`, edit: `/edit/${slug}` });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}, "host a NEW game from a CSV — owned, committed, validated, live");
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
  ctx.send(200, { starred: true, stars: await q.starCount(db, ctx.params.slug) });
}, "star");
gw.route("DELETE", "/api/stars/:slug", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  if (!requireGame(ctx)) return;
  await q.unstar(db, u.id, ctx.params.slug);
  ctx.send(200, { starred: false, stars: await q.starCount(db, ctx.params.slug) });
}, "unstar");

/* ---------- routes: Store 1 — games (behind the store interface) ---------- */
gw.route("GET", "/api/games", async (ctx) => {
  await reindexGames();
  ctx.send(200, (await q.listGames(db)).map(g => ({ slug: g.slug, title: g.title, license: g.license,
    cards: g.card_count, stars: g.stars, forked_from: g.forked_from ?? null,
    owner_handle: g.owner_handle ?? null })));
}, "catalog from the rebuildable index (DA-3), star counts included");
async function doFork(u, src) {
  const newSlug = `${src}-${u.handle}`.slice(0, 60);
  if (store.has(newSlug)) { const e = new Error(`you already forked this ('${newSlug}')`); e.code = 409; throw e; }
  const srcYaml = (await store.readFile(src, "game.yaml")).toString();
  const title = (srcYaml.match(/^title:\s*"?([^"\n]+)"?/m) ?? [])[1] ?? src;
  const lic = (srcYaml.match(/^license:\s*(\S+)/m) ?? [])[1] ?? "unknown";
  const transform = (yaml) => {
    let out = yaml.replace(/^id:\s*\S+/m, `id: ${newSlug}`);
    if (!/^attribution:/m.test(out)) {
      out = out.trimEnd() + `\nattribution:\n  source_id: ${src}\n  source_title: ${JSON.stringify(title)}\n  source_license: ${lic}\n`;
    }
    return out;
  };
  const { sha } = await store.fork(src, newSlug, transform,
    `fork: ${src} → ${newSlug} by ${u.handle}\n\nattribution committed per SPEC §9`,
    `${u.handle} <${u.email}>`);
  await reindexGames();
  await q.setForkMeta(db, newSlug, src, u.id);
  return { slug: newSlug, sha };
}
gw.route("POST", "/api/games/:slug/fork", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const src = requireGame(ctx); if (!src) return;
  try {
    const f = await doFork(u, src);
    ctx.send(201, { slug: f.slug, forked_from: src, commit: f.sha, url: `/#/g/${f.slug}` });
  } catch (e) { ctx.send(e.code ?? 500, { error: e.message }); }
}, "one-click fork: copy → attribution block → commit → indexed w/ forked_from");
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
  const forkSlug = `${slug}-${u.handle}`.slice(0, 60);
  if (!store.has(forkSlug)) await doFork(u, slug);
  else {
    const fr = await q.gameBySlug(db, forkSlug);
    if (fr?.owner_id !== u.id) return ctx.send(409, { error: `'${forkSlug}' exists and isn't yours` });
  }
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
  await q.addCollaborator(db, slug, target.id, u.id);
  ctx.send(200, { granted: ctx.params.handle, collaborators: await q.collaboratorsOf(db, slug) });
}, "owner grants direct-commit access");
gw.route("DELETE", "/api/games/:slug/collaborators/:handle", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const g = await q.gameBySlug(db, slug);
  if (g?.owner_id !== u.id) return ctx.send(403, { error: "only the owner manages access" });
  const target = await q.userByHandle(db, ctx.params.handle);
  if (!target) return ctx.send(404, { error: `no user '${ctx.params.handle}'` });
  await q.removeCollaborator(db, slug, target.id);
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
gw.route("POST", "/api/games/:slug/assets", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const u = await authedUser(ctx);
  if (!await canWrite(u, slug)) return denyWrite(ctx, u);
  const rel = ctx.url.searchParams.get("path");
  if (!rel || !rel.startsWith("assets/") || rel.includes("..")) return ctx.send(400, { error: "path must be under assets/ (SPEC §7)" });
  const buf = await readBody(ctx.req);
  try { assertAssetAllowed(rel, buf.length); } catch (e) { return ctx.send(422, { error: e.message }); }
  const { mode, oid, sha } = await store.putAsset(slug, rel, buf, `${u.handle} <${u.email}>`);
  ctx.send(200, { saved: true, path: rel, mode, oid, commit: sha });
}, "upload asset: LFS batch → pointer committed (the SPEC §7 write path)");
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
gw.route("POST", "/api/games/:slug/prs", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const to = requireGame(ctx); if (!to) return;
  const { from, title, body } = await json(ctx);
  if (!from || !store.has(from)) return ctx.send(422, { error: "unknown source game 'from'" });
  if (from === to) return ctx.send(422, { error: "cannot PR a game into itself" });
  const fromRow = await q.gameBySlug(db, from);
  if (fromRow?.owner_id !== u.id) return ctx.send(403, { error: "you can only propose from a game you own" });
  if (!title?.trim()) return ctx.send(422, { error: "title required" });
  const base = await cardsOf(to);
  const proposed = await cardsOf(from);
  const changes = diffCards(base, proposed);
  if (!changes.length) return ctx.send(422, { error: "no card changes between the games" });
  const id = newId("pr");
  await q.createPr(db, { id, to_slug: to, from_slug: from, title: title.trim(), body,
    author_id: u.id, base: JSON.stringify(base), proposed: JSON.stringify(proposed) });
  ctx.send(201, { id, to, from, title: title.trim(), changes, summary: summarize(changes)?.title });
}, "open a PR: propose your fork's card changes back to the source");
gw.route("GET", "/api/games/:slug/prs", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  ctx.send(200, await q.prsFor(db, slug));
}, "list PRs targeting this game");
gw.route("GET", "/api/games/:slug/prs/:id", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const pr = await q.prById(db, ctx.params.id);
  if (!pr || pr.to_slug !== slug) return ctx.send(404, { error: "no such PR" });
  const base = JSON.parse(pr.base), proposed = JSON.parse(pr.proposed);
  const current = await cardsOf(slug);
  const { conflicts } = mergeCards(base, proposed, current);
  ctx.send(200, { id: pr.id, to: pr.to_slug, from: pr.from_slug, title: pr.title, body: pr.body,
    author: pr.author_handle, status: pr.status, merge_sha: pr.merge_sha ?? null,
    changes: diffCards(base, proposed),
    stale: diffCards(base, current).length > 0, conflicts });
}, "PR detail: semantic diff + live staleness/conflict check");
gw.route("POST", "/api/games/:slug/prs/:id/merge", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const pr = await q.prById(db, ctx.params.id);
  if (!pr || pr.to_slug !== slug) return ctx.send(404, { error: "no such PR" });
  if (pr.status !== "open") return ctx.send(409, { error: `PR is ${pr.status}` });
  const game = await q.gameBySlug(db, slug);
  if (game?.owner_id !== u.id) return ctx.send(403, { error: "only the game's owner can merge" });
  const current = await cardsOf(slug);
  const { merged, conflicts } = mergeCards(JSON.parse(pr.base), JSON.parse(pr.proposed), current);
  if (conflicts.length) return ctx.send(409, { error: "conflicts — both sides changed these cards", conflicts });
  const content = JSON.stringify(merged, null, 2) + "\n";
  const v = await validateCandidate(slug, "components/cards.json", content);
  if (!v.ok) return ctx.send(422, { error: "merged result fails validation", report: v.report });
  const changes = diffCards(current, merged);
  const auto = summarize(changes);
  const { sha } = await store.writeFiles(slug, [{ path: "components/cards.json", content }],
    `merge: ${pr.title} (PR from ${pr.from_slug})\n\n${auto?.body ?? ""}\nmerged-by: ${u.handle}`,
    `${pr.author_handle} <${pr.author_email}>`);
  await q.setPrStatus(db, pr.id, "merged", sha);
  ctx.send(200, { merged: true, commit: sha, changes });
}, "merge a PR: card-level three-way merge → validate → commit AUTHORED AS THE PROPOSER");
gw.route("POST", "/api/games/:slug/prs/:id/close", async (ctx) => {
  const u = await requireAuth(ctx); if (!u) return;
  const slug = requireGame(ctx); if (!slug) return;
  const pr = await q.prById(db, ctx.params.id);
  if (!pr || pr.to_slug !== slug) return ctx.send(404, { error: "no such PR" });
  if (pr.status !== "open") return ctx.send(409, { error: `PR is ${pr.status}` });
  const game = await q.gameBySlug(db, slug);
  if (game?.owner_id !== u.id && pr.author_id !== u.id)
    return ctx.send(403, { error: "only the owner or the author can close" });
  await q.setPrStatus(db, pr.id, "closed");
  ctx.send(200, { closed: true });
}, "close a PR without merging");

gw.route("POST", "/api/games/:slug/export/:fmt", async (ctx) => {
  const slug = requireGame(ctx); if (!slug) return;
  const { fmt } = ctx.params;
  if (!["pnp", "tts"].includes(fmt)) return ctx.send(400, { error: "pnp or tts" });
  const sha = await store.headSha(slug);
  const { hit } = await cache.ensureExport(mat(slug), slug, sha, fmt);
  const base = `/cache/exports/${slug}/${sha}`;
  ctx.send(200, { ok: true, ref: sha, cached: hit,
    urls: fmt === "pnp" ? [`${base}/pnp.pdf`] : [`${base}/tts.json`, `${base}/sheet.png`, `${base}/back.png`] });
}, "export into the immutable cache; returns permanent URLs");

/* ---------- boot ---------- */
const nGames = (await Promise.resolve(store.list())).length;
gw.listen(PORT, () => console.log(
  `forge-platform gateway on http://localhost:${PORT}\n` +
  `  store1: ${store.kind} · games: ${nGames} · readonly: ${READONLY}\n` +
  `  GET /api for the route index · /healthz for probes`));
