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
  let b = "";
  req.on("data", c => { b += c; if (b.length > MAX_BODY) { no(new Error("body too large")); req.destroy(); } });
  req.on("end", () => ok(b));
});

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

    if (parts[0] !== "api" || parts[1] !== "games") return send(res, 404, { error: "not found" });

    if (parts.length === 2)  // GET /api/games
      return send(res, 200, games().map(s => {
        const g = readFileSync(join(GAMES_DIR, s, "game.yaml"), "utf8");
        const title = (g.match(/^title:\s*"?([^"\n]+)"?/m) || [])[1] ?? s;
        const license = (g.match(/^license:\s*(\S+)/m) || [])[1] ?? "?";
        return { slug: s, title, license };
      }));

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
      const r1 = py("render_cards.py", [gd]);
      const r2 = py(fmt === "pnp" ? "export_pnp.py" : "export_tts.py", [gd]);
      return send(res, r1.status || r2.status ? 500 : 200,
                  { ok: !(r1.status || r2.status), output: (r2.stdout || "").trim().split("\n") });
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
