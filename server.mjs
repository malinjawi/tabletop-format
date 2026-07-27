#!/usr/bin/env node
/**
 * server.mjs — the platform backend (Block G), now a real GATEWAY.
 * Usage: node server.mjs [--port 8420] [--games <dir>] [--readonly]
 * Env: LFS_URL (platform asset mode) · DB_PATH (Store 2) · CACHE_DIR (Store 3)
 *
 * Structure (mirrors the system-design diagram):
 *   gateway kernel (platform/gateway.mjs): middleware → route table → logs
 *   middleware:   CORS preflight → rate limit → readonly gate
 *   route groups: hub · Store-3 cache · auth/social (Store 2) · games (Store 1)
 *   stores:       git (plain now, Forgejo later) · sqlite→Postgres · fs→R2
 * GET /api lists every route; GET /healthz for probes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway, readBody } from "./platform/gateway.mjs";
import { diffCards, summarize } from "./tools/lib/carddiff.mjs";
import { uploadAsset, downloadAsset } from "./tools/lib/lfs.mjs";
import { assertAssetAllowed } from "./tools/lib/limits.mjs";
import { openDb, q, newId } from "./platform/db.mjs";
import { hashPassword, verifyPassword, newToken, SESSION_TTL_MS, validHandle, validEmail } from "./platform/auth.mjs";
import * as cache from "./platform/cache.mjs";

/* ---------- config ---------- */
const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const PORT = parseInt(opt("--port", "8420"), 10);
const GAMES_DIR = resolve(opt("--games", join(ROOT, "examples")));
const READONLY = args.includes("--readonly");
const LFS_URL = process.env.LFS_URL ?? null;
const RATE = { windowMs: 60_000, max: 120 };
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
               svg: "image/svg+xml", ogg: "audio/ogg", mp3: "audio/mpeg", woff2: "font/woff2",
               pdf: "application/pdf", json: "application/json" };

/* ---------- stores ---------- */
const db = openDb();
const git = (a, opts = {}) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", ...opts }).trimEnd();
const py = (script, a) => spawnSync("python3", [join(ROOT, "tools", script), ...a], { encoding: "utf8" });
const games = () => readdirSync(GAMES_DIR).filter(d => existsSync(join(GAMES_DIR, d, "game.yaml")));
const gameDir = (slug) => (/^[a-z0-9][a-z0-9-]*$/.test(slug) && games().includes(slug)) ? join(GAMES_DIR, slug) : null;
const gameRel = (slug) => `${GAMES_DIR.replace(ROOT + "/", "")}/${slug}`;

function reindexGames() { // DA-3: derived, rebuildable
  for (const slug of games()) {
    const gy = readFileSync(join(GAMES_DIR, slug, "game.yaml"), "utf8");
    let cardCount = null;
    try { cardCount = JSON.parse(readFileSync(join(GAMES_DIR, slug, "components/cards.json"), "utf8")).length; } catch {}
    q.upsertGame(db, { slug,
      title: (gy.match(/^title:\s*"?([^"\n]+)"?/m) ?? [])[1] ?? slug,
      license: (gy.match(/^license:\s*(\S+)/m) ?? [])[1] ?? null,
      card_count: cardCount });
  }
}
reindexGames();

let hubBuilt = 0;
function hubHtml() {
  const newest = Math.max(0, ...games().flatMap(s =>
    ["game.yaml", "components/cards.json", "community.yaml"].map(f => {
      const p = join(GAMES_DIR, s, f); return existsSync(p) ? statSync(p).mtimeMs : 0; })));
  const out = join(ROOT, "hub.html");
  if (!existsSync(out) || hubBuilt < newest) {
    const r = py("build_hub.py", ["-o", out, "--games", GAMES_DIR]);
    if (r.status !== 0) throw new Error(r.stderr);
    hubBuilt = Date.now();
  }
  return readFileSync(out, "utf8");
}

/* ---------- gateway + middleware ---------- */
const gw = createGateway({ name: "forge-platform", version: "0.1" });
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
const authedUser = (ctx) => {
  const m = (ctx.req.headers.authorization ?? "").match(/^Bearer (\w{64})$/);
  return m ? q.sessionUser(db, m[1]) : null;
};
const requireAuth = (ctx) => { const u = authedUser(ctx); if (!u) ctx.send(401, { error: "auth required" }); return u; };
// per-user data lineage: authed requests commit AS the user; anonymous falls back
const authorOf = (ctx) => { const u = authedUser(ctx); return u ? `${u.handle} <${u.email}>` : "web editor <editor@platform>"; };
const requireGame = (ctx) => { const gd = gameDir(ctx.params.slug); if (!gd) ctx.send(404, { error: `no game '${ctx.params.slug}'` }); return gd; };
const json = async (ctx) => JSON.parse((await readBody(ctx.req)).toString());

/* ---------- routes: hub + live editor ---------- */
gw.route("GET", "/", (ctx) => ctx.send(200, hubHtml(), "text/html; charset=utf-8"), "hub UI");
const editorBuilt = new Map(); // slug -> {mtime, path}
gw.route("GET", "/edit/:slug", (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  const slug = ctx.params.slug;
  const srcMtime = Math.max(statSync(join(gd, "game.yaml")).mtimeMs,
                            statSync(join(gd, "components/cards.json")).mtimeMs);
  const out = join(ROOT, "data", `editor-${slug}.html`);
  const cached = editorBuilt.get(slug);
  if (!cached || cached.mtime < srcMtime || !existsSync(out)) {
    mkdirSync(join(ROOT, "data"), { recursive: true });
    const r = py("build_editor.py", [gd, "-o", out, "--live", slug]);
    if (r.status !== 0) return ctx.send(500, { error: r.stderr });
    editorBuilt.set(slug, { mtime: srcMtime });
  }
  ctx.send(200, readFileSync(out, "utf8"), "text/html; charset=utf-8");
}, "LIVE editor: edit cards in browser, Save = real git commit");

/* ---------- routes: Store 3 — immutable cache (DA-5) ---------- */
gw.route("GET", "/cache/renders/:slug/:ref/*", (ctx) => {
  if (!requireGame(ctx)) return;
  const { slug, ref } = ctx.params;
  if (!/^[0-9a-fv][0-9a-f.\-]*$/i.test(ref) || ctx.params["*"].includes("..")) return ctx.send(404, { error: "bad ref" });
  const { keyDir } = cache.ensureRenders(gameRel(slug), slug, ref);
  const fp = join(keyDir, ctx.params["*"]);
  if (!existsSync(fp)) return ctx.send(404, { error: "not producible" });
  ctx.sendRaw(200, readFileSync(fp), { "content-type": MIME[fp.split(".").pop()] ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable" });
}, "card render at exact commit — URL never changes meaning");
gw.route("GET", "/cache/exports/:slug/:ref/*", (ctx) => {
  if (!requireGame(ctx)) return;
  const { slug, ref } = ctx.params;
  const file = ctx.params["*"];
  if (!/^[0-9a-fv][0-9a-f.\-]*$/i.test(ref) || file.includes("..")) return ctx.send(404, { error: "bad ref" });
  const kind = file.startsWith("pnp") ? "pnp" : "tts";
  const { dir } = cache.ensureExport(gameRel(slug), slug, ref, kind);
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
  if (q.userByHandle(db, handle) || q.userByEmail(db, email)) return ctx.send(409, { error: "handle or email already registered" });
  const id = newId("u");
  q.createUser(db, { id, handle, email, pass_hash: hashPassword(password) });
  const token = newToken();
  q.createSession(db, token, id, SESSION_TTL_MS);
  ctx.send(201, { token, user: { id, handle } });
}, "create account");
gw.route("POST", "/api/auth/login", async (ctx) => {
  const { handle, password } = await json(ctx);
  const u = q.userByHandle(db, handle) ?? q.userByEmail(db, handle);
  if (!u || !verifyPassword(password ?? "", u.pass_hash)) return ctx.send(401, { error: "bad credentials" });
  const token = newToken();
  q.createSession(db, token, u.id, SESSION_TTL_MS);
  ctx.send(200, { token, user: { id: u.id, handle: u.handle } });
}, "get session token");
gw.route("GET", "/api/me", (ctx) => {
  const u = requireAuth(ctx); if (!u) return;
  ctx.send(200, { id: u.id, handle: u.handle, email: u.email,
    claims: q.claimsOf(db, u.id), starred: q.starredBy(db, u.id).map(r => r.game_slug),
    games: q.gamesOwnedBy(db, u.id) });
}, "who am I + claims + stars + owned games");
gw.route("POST", "/api/games", async (ctx) => {
  // THE HOSTING VERB: a designer brings a CSV, leaves with a hosted, owned, versioned game
  const u = requireAuth(ctx); if (!u) return;
  const { title, csv } = await json(ctx);
  if (!title?.trim()) return ctx.send(422, { error: "title required" });
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  if (!slug || games().includes(slug)) return ctx.send(409, { error: `slug '${slug}' unavailable` });
  const { writeFileSync: wf, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = mkdtempSync(join(tmpdir(), "csv-"));
  wf(join(tmp, "in.csv"), csv ?? "name,type,text\nFirst Card,card,Hello world.");
  const imp = spawnSync(process.execPath,
    [join(ROOT, "tools/import-csv.mjs"), join(tmp, "in.csv"), join(GAMES_DIR, slug), "--title", title.trim()],
    { encoding: "utf8" });
  rmSync(tmp, { recursive: true, force: true });
  if (imp.status !== 0) return ctx.send(422, { error: "import failed", detail: imp.stderr });
  const v = py("validate.py", [join(GAMES_DIR, slug)]);
  if (v.status !== 0) {
    rmSync(join(GAMES_DIR, slug), { recursive: true, force: true });
    return ctx.send(422, { error: "imported game failed validation", report: v.stdout.split("\n") });
  }
  git(["add", "--", join(GAMES_DIR, slug)]);
  git(["commit", "-m", `new game: ${title.trim()} (${slug})\n\nimported from CSV via platform`, "--author", authorOf(ctx)]);
  reindexGames();
  q.setForkMeta(db, slug, null, u.id);  // ownership
  ctx.send(201, { slug, owner: u.handle, commit: git(["rev-parse", "--short", "HEAD"]),
    cards: JSON.parse(readFileSync(join(GAMES_DIR, slug, "components/cards.json"), "utf8")).length,
    url: `/#/g/${slug}`, edit: `/edit/${slug}` });
}, "host a NEW game from a CSV — owned, committed, validated, live");
gw.route("POST", "/api/claims", async (ctx) => {
  const u = requireAuth(ctx); if (!u) return;
  const { author } = await json(ctx);
  if (!author?.trim()) return ctx.send(422, { error: "author string required" });
  if (q.claimOwner(db, author.trim())) return ctx.send(409, { error: "already claimed" });
  q.claim(db, u.id, author.trim());
  ctx.send(201, { claimed: author.trim() });
}, "claim a git/playtest author string (DA-7)");
gw.route("PUT", "/api/stars/:slug", (ctx) => {
  const u = requireAuth(ctx); if (!u) return;
  if (!requireGame(ctx)) return;
  q.star(db, u.id, ctx.params.slug);
  ctx.send(200, { starred: true, stars: q.starCount(db, ctx.params.slug) });
}, "star");
gw.route("DELETE", "/api/stars/:slug", (ctx) => {
  const u = requireAuth(ctx); if (!u) return;
  if (!requireGame(ctx)) return;
  q.unstar(db, u.id, ctx.params.slug);
  ctx.send(200, { starred: false, stars: q.starCount(db, ctx.params.slug) });
}, "unstar");

/* ---------- routes: Store 1 — games (git) ---------- */
gw.route("GET", "/api/games", (ctx) => {
  reindexGames();
  ctx.send(200, q.listGames(db).map(g => ({ slug: g.slug, title: g.title, license: g.license,
    cards: g.card_count, stars: g.stars, forked_from: g.forked_from ?? null,
    owner_handle: g.owner_handle ?? null })));
}, "catalog from the rebuildable index (DA-3), star counts included");
gw.route("POST", "/api/games/:slug/fork", async (ctx) => {
  const u = requireAuth(ctx); if (!u) return;
  const gd = requireGame(ctx); if (!gd) return;
  const src = ctx.params.slug;
  const newSlug = `${src}-${u.handle}`.slice(0, 60);
  if (games().includes(newSlug)) return ctx.send(409, { error: `you already forked this ('${newSlug}')` });
  const dest = join(GAMES_DIR, newSlug);
  const { cpSync } = await import("node:fs");
  cpSync(gd, dest, { recursive: true,
    filter: (p) => !p.includes("/exports") && !p.split("/").pop().startsWith(".") });
  // rewrite id + append the SPEC §9 attribution block
  const srcYaml = readFileSync(join(gd, "game.yaml"), "utf8");
  const title = (srcYaml.match(/^title:\s*"?([^"\n]+)"?/m) ?? [])[1] ?? src;
  const lic = (srcYaml.match(/^license:\s*(\S+)/m) ?? [])[1] ?? "unknown";
  let forkYaml = srcYaml.replace(/^id:\s*\S+/m, `id: ${newSlug}`);
  if (!/^attribution:/m.test(forkYaml)) {
    forkYaml = forkYaml.trimEnd() + `\nattribution:\n  source_id: ${src}\n  source_title: ${JSON.stringify(title)}\n  source_license: ${lic}\n`;
  }
  writeFileSync(join(dest, "game.yaml"), forkYaml);
  git(["add", "--", dest]);
  git(["commit", "-m", `fork: ${src} → ${newSlug} by ${u.handle}\n\nattribution committed per SPEC §9`,
       "--author", `${u.handle} <${u.email}>`]);
  reindexGames();
  q.setForkMeta(db, newSlug, src, u.id);
  ctx.send(201, { slug: newSlug, forked_from: src,
    commit: git(["rev-parse", "--short", "HEAD"]), url: `/#/g/${newSlug}` });
}, "one-click fork: copy → attribution block → commit → indexed w/ forked_from");
gw.route("GET", "/api/games/:slug", (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  const r = py("stats.py", [gd, "--json"]);
  ctx.send(200, { slug: ctx.params.slug, stats: JSON.parse(r.stdout || "{}") });
}, "game meta + design/playtest stats");
gw.route("GET", "/api/games/:slug/cards", (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  ctx.send(200, JSON.parse(readFileSync(join(gd, "components/cards.json"), "utf8")));
}, "card data");
gw.route("PUT", "/api/games/:slug/cards", async (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  const cardsPath = join(gd, "components/cards.json");
  const incoming = await json(ctx);
  const before = JSON.parse(readFileSync(cardsPath, "utf8"));
  const changes = diffCards(before, incoming);
  if (!changes.length) return ctx.send(200, { saved: false, message: "no changes" });
  writeFileSync(cardsPath, JSON.stringify(incoming, null, 2) + "\n");
  const v = py("validate.py", [gd]);
  if (v.status !== 0) {
    writeFileSync(cardsPath, JSON.stringify(before, null, 2) + "\n");
    return ctx.send(422, { saved: false, error: "validation failed", report: v.stdout.split("\n") });
  }
  const auto = summarize(changes);
  git(["add", "--", cardsPath]);
  git(["commit", "-m", `${auto.title}\n\n${auto.body}`, "--author", authorOf(ctx)]);
  ctx.send(200, { saved: true, commit: git(["rev-parse", "--short", "HEAD"]), message: auto.title, changes });
}, "edit cards: validate → rollback-or-commit w/ auto message");
gw.route("POST", "/api/games/:slug/assets", async (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  const rel = ctx.url.searchParams.get("path");
  if (!rel || !rel.startsWith("assets/") || rel.includes("..")) return ctx.send(400, { error: "path must be under assets/ (SPEC §7)" });
  const buf = await readBody(ctx.req);
  try { assertAssetAllowed(rel, buf.length); } catch (e) { return ctx.send(422, { error: e.message }); }
  const dest = join(gd, rel);
  mkdirSync(dirname(dest), { recursive: true });
  let mode = "portable", oid = null;
  if (LFS_URL) { const up = await uploadAsset(LFS_URL, rel, buf); writeFileSync(dest, up.pointer); mode = "lfs"; oid = up.oid; }
  else writeFileSync(dest, buf);
  git(["add", "--", dest]);
  git(["commit", "-m", `assets: add ${rel}${mode === "lfs" ? " (LFS)" : ""}`, "--author", authorOf(ctx)]);
  ctx.send(200, { saved: true, path: rel, mode, oid, commit: git(["rev-parse", "--short", "HEAD"]) });
}, "upload asset: LFS batch → pointer committed (the SPEC §7 write path)");
gw.route("GET", "/api/games/:slug/assets/*", async (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  const rel = ctx.params["*"];
  const p = join(gd, "assets", rel);
  if (rel.includes("..") || !existsSync(p)) return ctx.send(404, { error: "no such asset" });
  let buf = readFileSync(p);
  if (buf.slice(0, 60).toString().startsWith("version https://git-lfs")) {
    if (!LFS_URL) return ctx.send(502, { error: "pointer file but no LFS_URL configured" });
    buf = await downloadAsset(LFS_URL, buf.toString());
  }
  ctx.sendRaw(200, buf, { "content-type": MIME[rel.toLowerCase().split(".").pop()] ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable" });
}, "serve asset, materializing LFS pointers");
gw.route("GET", "/api/games/:slug/history", (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  const rel = `${gameRel(ctx.params.slug)}/components/cards.json`;
  const QUIET = { stdio: ["pipe", "pipe", "ignore"] };
  const log = git(["log", "-20", "--format=%H|%h|%an|%as|%s", "--", rel], QUIET);
  const at = (ref) => { try { return JSON.parse(git(["show", `${ref}:${rel}`], QUIET)); } catch { return []; } };
  ctx.send(200, (log ? log.split("\n") : []).map(line => {
    const [full, sha, author, date, subject] = line.split("|");
    return { sha, author, date, subject, changes: diffCards(at(`${full}^`), at(full)) };
  }));
}, "git log as semantic card changes");
gw.route("GET", "/api/games/:slug/stats", (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  const r = py("stats.py", [gd, "--json"]);
  ctx.send(r.status ? 500 : 200, JSON.parse(r.stdout || "{}"));
}, "design + playtest analytics");
gw.route("GET", "/api/games/:slug/validate", (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  const r = py("validate.py", [gd]);
  ctx.send(200, { ok: r.status === 0, report: r.stdout.trim().split("\n") });
}, "format conformance (SPEC §10)");
gw.route("GET", "/api/games/:slug/credits", (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  const r = py("credits.py", [gd]);
  ctx.send(200, { ok: r.status === 0, credits: readFileSync(join(gd, "CREDITS.md"), "utf8") });
}, "auto credit roll");
gw.route("POST", "/api/games/:slug/export/:fmt", (ctx) => {
  const gd = requireGame(ctx); if (!gd) return;
  const { slug, fmt } = ctx.params;
  if (!["pnp", "tts"].includes(fmt)) return ctx.send(400, { error: "pnp or tts" });
  const sha = git(["rev-parse", "--short", "HEAD"]);
  const { hit } = cache.ensureExport(gameRel(slug), slug, sha, fmt);
  const base = `/cache/exports/${slug}/${sha}`;
  ctx.send(200, { ok: true, ref: sha, cached: hit,
    urls: fmt === "pnp" ? [`${base}/pnp.pdf`] : [`${base}/tts.json`, `${base}/sheet.png`, `${base}/back.png`] });
}, "export into the immutable cache; returns permanent URLs");

/* ---------- boot ---------- */
gw.listen(PORT, () => console.log(
  `forge-platform gateway on http://localhost:${PORT}\n` +
  `  games: ${GAMES_DIR} (${games().length}) · readonly: ${READONLY} · lfs: ${LFS_URL ?? "portable"}\n` +
  `  GET /api for the route index · /healthz for probes`));
