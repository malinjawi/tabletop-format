#!/usr/bin/env node
/**
 * server.mjs — the platform, v0 (Block G). ZERO dependencies (node:http).
 * Usage: node server.mjs [--port 8420] [--games <dir>]
 *
 * This is where prototypes end and the product begins: a live HTTP server
 * over real game repos. Reads come from the filesystem; WRITES BECOME GIT
 * COMMITS with auto-written semantic messages (the porcelain, over HTTP).
 *
 *   GET  /                            live hub UI (rebuilt when games change)
 *   GET  /api/games                   list games (discovered, not hard-coded)
 *   GET  /api/games/:slug             full metadata
 *   GET  /api/games/:slug/cards       cards.json
 *   PUT  /api/games/:slug/cards       write cards -> validate -> COMMIT (auto message)
 *   GET  /api/games/:slug/history     git log as semantic card changes
 *   GET  /api/games/:slug/stats       design + playtest analytics
 *   GET  /api/games/:slug/validate    full validation report
 *   GET  /api/games/:slug/credits     merged credit roll
 *   POST /api/games/:slug/export/:fmt trigger pnp|tts export
 *
 * The same verbs Block G will speak against Forgejo — proven here against
 * plain git first, so the Forgejo swap changes plumbing, not contracts.
 */
import { createServer } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffCards, summarize } from "./tools/lib/carddiff.mjs";
import { uploadAsset, downloadAsset, parsePointer } from "./tools/lib/lfs.mjs";
import { assertAssetAllowed } from "./tools/lib/limits.mjs";
const LFS_URL = process.env.LFS_URL ?? null;  // set -> platform mode (pointers); unset -> portable (plain blobs)
// ---- Store 2 (identity & conversation; DA-9: losing this never loses a game) ----
import { openDb, q, newId } from "./platform/db.mjs";
import * as cache from "./platform/cache.mjs";
import { hashPassword, verifyPassword, newToken, SESSION_TTL_MS, validHandle, validEmail } from "./platform/auth.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const PORT = parseInt(opt("--port", "8420"), 10);
const GAMES_DIR = resolve(opt("--games", join(ROOT, "examples")));
const READONLY = args.includes("--readonly");          // beta showcase: no writes
const MAX_BODY = 1024 * 1024;                          // 1MB write cap
const RATE = { windowMs: 60_000, max: 120 };           // 120 req/min/ip
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip) ?? { t: now, n: 0 };
  if (now - h.t > RATE.windowMs) { h.t = now; h.n = 0; }
  h.n++; hits.set(ip, h);
  if (hits.size > 10_000) hits.clear();                // crude memory guard
  return h.n > RATE.max;
}

const py = (script, a) => spawnSync("python3", [join(ROOT, "tools", script), ...a], { encoding: "utf8" });
const git = (a, opts = {}) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", ...opts }).trimEnd();

function games() {
  return readdirSync(GAMES_DIR).filter(d => existsSync(join(GAMES_DIR, d, "game.yaml")));
}
const db = openDb();
function reindexGames() { // DA-3: games table is DERIVED from git, rebuildable any time
  for (const slug of games()) {
    const gy = readFileSync(join(GAMES_DIR, slug, "game.yaml"), "utf8");
    let cardCount = null;
    try { cardCount = JSON.parse(readFileSync(join(GAMES_DIR, slug, "components/cards.json"), "utf8")).length; } catch {}
    q.upsertGame(db, {
      slug,
      title: (gy.match(/^title:\s*"?([^"\n]+)"?/m) ?? [])[1] ?? slug,
      license: (gy.match(/^license:\s*(\S+)/m) ?? [])[1] ?? null,
      card_count: cardCount,
    });
  }
}
reindexGames();
const authedUser = (req) => {
  const m = (req.headers.authorization ?? "").match(/^Bearer (\w{64})$/);
  return m ? q.sessionUser(db, m[1]) : null;
};
function gameDir(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !games().includes(slug)) return null;
  return join(GAMES_DIR, slug);
}
const send = (res, code, body, type = "application/json") => {
  const data = type === "application/json" ? JSON.stringify(body, null, 2) : body;
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*",
                        "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
                        "access-control-allow-headers": "content-type" });
  res.end(data);
};
const readBody = (req) => new Promise((ok, no) => {
  const chunks = []; let n = 0;
  req.on("data", c => { n += c.length; if (n > MAX_BODY) { no(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
  req.on("end", () => ok(Buffer.concat(chunks)));
});
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
               svg: "image/svg+xml", ogg: "audio/ogg", mp3: "audio/mpeg", woff2: "font/woff2" };

// hub cache: rebuild when any game.yaml/cards.json is newer than the cached page
let hubBuilt = 0;
function hubHtml() {
  const newest = Math.max(0, ...games().flatMap(s =>
    ["game.yaml", "components/cards.json", "community.yaml"].map(f => {
      const p = join(GAMES_DIR, s, f);
      return existsSync(p) ? statSync(p).mtimeMs : 0;
    })));
  const out = join(ROOT, "hub.html");
  if (!existsSync(out) || hubBuilt < newest) {
    const r = py("build_hub.py", ["-o", out, "--games", GAMES_DIR]);
    if (r.status !== 0) throw new Error(r.stderr);
    hubBuilt = Date.now();
  }
  return readFileSync(out, "utf8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    const ip = req.socket.remoteAddress ?? "?";
    if (rateLimited(ip)) return send(res, 429, { error: "rate limited — beta playground, be gentle" });
    if (READONLY && req.method !== "GET")
      return send(res, 403, { error: "read-only beta — clone the repo to make it yours: git clone <repo>" });

    if (req.method === "GET" && parts.length === 0)
      return send(res, 200, hubHtml(), "text/html; charset=utf-8");

    // ---- Store 3: immutable derived-cache URLs (DA-5; TTS links never rot) ----
    // GET /cache/renders/:game/:sha/:printing.png · GET /cache/exports/:game/:ref/:file
    if (req.method === "GET" && parts[0] === "cache" && parts.length >= 4) {
      const [, tier, gameSlug, ref, ...rest] = parts.map(decodeURIComponent);
      const gd2 = gameDir(gameSlug);
      if (!gd2 || !/^[0-9a-fv][0-9a-f.\-]*$/i.test(ref) || rest.some(x => x.includes("..")))
        return send(res, 404, { error: "bad cache path" });
      const gameRel = `${GAMES_DIR.replace(ROOT + "/", "")}/${gameSlug}`;
      let filePath;
      if (tier === "renders") {
        const { keyDir } = cache.ensureRenders(gameRel, gameSlug, ref);
        filePath = join(keyDir, rest.join("/"));
      } else if (tier === "exports") {
        const file = rest.join("/");
        const kind = file.startsWith("pnp") ? "pnp" : "tts";
        const { dir } = cache.ensureExport(gameRel, gameSlug, ref, kind);
        filePath = join(dir, file);
      } else return send(res, 404, { error: "renders|exports" });
      if (!existsSync(filePath)) return send(res, 404, { error: "not in cache and not producible" });
      const ext = filePath.toLowerCase().split(".").pop();
      res.writeHead(200, { "content-type": MIME[ext] ?? (ext === "pdf" ? "application/pdf" : "application/octet-stream"),
                           "cache-control": "public, max-age=31536000, immutable",
                           "access-control-allow-origin": "*" });
      return res.end(readFileSync(filePath));
    }

    // ---- Store-2 routes: identity & social (Slice 1) ----
    if (parts[0] === "api" && parts[1] === "auth") {
      if (req.method === "POST" && parts[2] === "register") {
        const { handle, email, password } = JSON.parse((await readBody(req)).toString());
        if (!validHandle(handle)) return send(res, 422, { error: "handle: 2-32 chars, kebab-case" });
        if (!validEmail(email)) return send(res, 422, { error: "invalid email" });
        if ((password ?? "").length < 8) return send(res, 422, { error: "password: 8+ chars" });
        if (q.userByHandle(db, handle) || q.userByEmail(db, email))
          return send(res, 409, { error: "handle or email already registered" });
        const id = newId("u");
        q.createUser(db, { id, handle, email, pass_hash: hashPassword(password) });
        const token = newToken();
        q.createSession(db, token, id, SESSION_TTL_MS);
        return send(res, 201, { token, user: { id, handle } });
      }
      if (req.method === "POST" && parts[2] === "login") {
        const { handle, password } = JSON.parse((await readBody(req)).toString());
        const u = q.userByHandle(db, handle) ?? q.userByEmail(db, handle);
        if (!u || !verifyPassword(password ?? "", u.pass_hash))
          return send(res, 401, { error: "bad credentials" });
        const token = newToken();
        q.createSession(db, token, u.id, SESSION_TTL_MS);
        return send(res, 200, { token, user: { id: u.id, handle: u.handle } });
      }
      return send(res, 404, { error: "not found" });
    }
    if (parts[0] === "api" && parts[1] === "me") {
      const u = authedUser(req);
      if (!u) return send(res, 401, { error: "auth required" });
      return send(res, 200, { id: u.id, handle: u.handle, email: u.email,
        claims: q.claimsOf(db, u.id), starred: q.starredBy(db, u.id).map(r => r.game_slug) });
    }
    if (parts[0] === "api" && parts[1] === "claims" && req.method === "POST") {
      const u = authedUser(req);
      if (!u) return send(res, 401, { error: "auth required" });
      const { author } = JSON.parse((await readBody(req)).toString());
      if (!author?.trim()) return send(res, 422, { error: "author string required" });
      if (q.claimOwner(db, author.trim())) return send(res, 409, { error: "already claimed" });
      q.claim(db, u.id, author.trim());
      return send(res, 201, { claimed: author.trim() });
    }
    if (parts[0] === "api" && parts[1] === "stars" && parts[2]) {
      const u = authedUser(req);
      if (!u) return send(res, 401, { error: "auth required" });
      const slug = parts[2];
      if (!games().includes(slug)) return send(res, 404, { error: "no such game" });
      if (req.method === "PUT") { q.star(db, u.id, slug); return send(res, 200, { starred: true, stars: q.starCount(db, slug) }); }
      if (req.method === "DELETE") { q.unstar(db, u.id, slug); return send(res, 200, { starred: false, stars: q.starCount(db, slug) }); }
      return send(res, 405, { error: "PUT or DELETE" });
    }
    if (parts[0] !== "api" || parts[1] !== "games") return send(res, 404, { error: "not found" });

    if (parts.length === 2) {  // GET /api/games — served from the Store-2 index (DA-3) w/ star counts
      reindexGames();
      return send(res, 200, q.listGames(db).map(g => ({
        slug: g.slug, title: g.title, license: g.license,
        cards: g.card_count, stars: g.stars,
      })));
    }

    const slug = parts[2];
    const gd = gameDir(slug);
    if (!gd) return send(res, 404, { error: `no game '${slug}'` });
    const sub = parts[3];
    const cardsPath = join(gd, "components/cards.json");
    const relCards = `${GAMES_DIR.replace(ROOT + "/", "")}/${slug}/components/cards.json`;

    if (req.method === "GET" && !sub) {
      const meta = py("stats.py", [gd, "--json"]);
      return send(res, 200, { slug, stats: JSON.parse(meta.stdout || "{}") });
    }
    if (req.method === "GET" && sub === "cards")
      return send(res, 200, JSON.parse(readFileSync(cardsPath, "utf8")));

    if (req.method === "PUT" && sub === "cards") {
      const incoming = JSON.parse(await readBody(req));
      const before = JSON.parse(readFileSync(cardsPath, "utf8"));
      const changes = diffCards(before, incoming);
      if (!changes.length) return send(res, 200, { saved: false, message: "no changes" });
      // write, validate, commit — reject and roll back if invalid
      writeFileSync(cardsPath, JSON.stringify(incoming, null, 2) + "\n");
      const v = py("validate.py", [gd]);
      if (v.status !== 0) {
        writeFileSync(cardsPath, JSON.stringify(before, null, 2) + "\n");
        return send(res, 422, { saved: false, error: "validation failed", report: v.stdout.split("\n") });
      }
      const auto = summarize(changes);
      git(["add", "--", cardsPath]);
      git(["commit", "-m", `${auto.title}\n\n${auto.body}`,
           "--author", "web editor <editor@platform>"]);
      const sha = git(["rev-parse", "--short", "HEAD"]);
      return send(res, 200, { saved: true, commit: sha, message: auto.title, changes });
    }

    // ---- assets: the Store-1 write path over HTTP (SPEC §7) ----
    if (req.method === "POST" && sub === "assets") {
      const rel = url.searchParams.get("path");
      if (!rel || !rel.startsWith("assets/") || rel.includes(".."))
        return send(res, 400, { error: "path must be under assets/ (SPEC §7)" });
      const buf = await readBody(req);
      try { assertAssetAllowed(rel, buf.length); }
      catch (e) { return send(res, 422, { error: e.message }); }
      const dest = join(gd, rel);
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(dest, ".."), { recursive: true });
      let mode = "portable", oid = null;
      if (LFS_URL) {
        const up = await uploadAsset(LFS_URL, rel, buf);
        writeFileSync(dest, up.pointer);              // git gets the POINTER
        mode = "lfs"; oid = up.oid;
      } else {
        writeFileSync(dest, buf);                     // portable: plain blob
      }
      git(["add", "--", dest]);
      git(["commit", "-m", `assets: add ${rel}${mode === "lfs" ? " (LFS)" : ""}`,
           "--author", "web editor <editor@platform>"]);
      const sha = git(["rev-parse", "--short", "HEAD"]);
      return send(res, 200, { saved: true, path: rel, mode, oid, commit: sha });
    }
    if (req.method === "GET" && sub === "assets") {
      const rel = parts.slice(4).map(decodeURIComponent).join("/");
      const p = join(gd, "assets", rel);
      if (rel.includes("..") || !existsSync(p)) return send(res, 404, { error: "no such asset" });
      let buf = readFileSync(p);
      const head = buf.slice(0, 60).toString();
      if (head.startsWith("version https://git-lfs")) {   // pointer -> materialize from LFS
        if (!LFS_URL) return send(res, 502, { error: "pointer file but no LFS_URL configured" });
        buf = await downloadAsset(LFS_URL, buf.toString());
      }
      const ext = rel.toLowerCase().split(".").pop();
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream",
                           "cache-control": "public, max-age=31536000, immutable",
                           "access-control-allow-origin": "*" });
      return res.end(buf);
    }

    if (req.method === "GET" && sub === "history") {
      const log = git(["log", "-20", "--format=%H|%h|%an|%as|%s", "--", relCards], { stdio: ["pipe", "pipe", "ignore"] });
      const out = [];
      for (const line of log ? log.split("\n") : []) {
        const [full, sha, author, date, subject] = line.split("|");
        const at = (ref) => { try { return JSON.parse(git(["show", `${ref}:${relCards}`], { stdio: ["pipe", "pipe", "ignore"] })); } catch { return []; } };
        out.push({ sha, author, date, subject, changes: diffCards(at(`${full}^`), at(full)) });
      }
      return send(res, 200, out);
    }

    if (req.method === "GET" && sub === "stats") {
      const r = py("stats.py", [gd, "--json"]);
      return send(res, r.status ? 500 : 200, JSON.parse(r.stdout || "{}"));
    }
    if (req.method === "GET" && sub === "validate") {
      const r = py("validate.py", [gd]);
      return send(res, 200, { ok: r.status === 0, report: r.stdout.trim().split("\n") });
    }
    if (req.method === "GET" && sub === "credits") {
      const r = py("credits.py", [gd]);
      return send(res, 200, { ok: r.status === 0, credits: readFileSync(join(gd, "CREDITS.md"), "utf8") });
    }
    if (req.method === "POST" && sub === "export") {
      const fmt = parts[4];
      if (!["pnp", "tts"].includes(fmt)) return send(res, 400, { error: "pnp or tts" });
      // Store-3 path: export at the CURRENT sha into the immutable cache, return permanent URLs
      const sha = git(["rev-parse", "--short", "HEAD"]);
      const gameRel = `${GAMES_DIR.replace(ROOT + "/", "")}/${slug}`;
      const { hit } = cache.ensureExport(gameRel, slug, sha, fmt);
      const base = `/cache/exports/${slug}/${sha}`;
      return send(res, 200, { ok: true, ref: sha, cached: hit,
        urls: fmt === "pnp" ? [`${base}/pnp.pdf`]
                            : [`${base}/tts.json`, `${base}/sheet.png`, `${base}/back.png`] });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(
  `platform v0 listening on http://localhost:${PORT}\n` +
  `  games dir: ${GAMES_DIR} (${games().length} games discovered)\n` +
  `  writes become commits. Ctrl-C to stop.`));
