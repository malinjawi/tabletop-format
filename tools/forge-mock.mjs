#!/usr/bin/env node
/**
 * forge-mock.mjs — a protocol-faithful stand-in for Forgejo's REST + LFS
 * surface, backed by REAL git repos on disk. Zero dependencies.
 *
 * Serves exactly the endpoints store1-forgejo.mjs consumes (shapes mirror
 * what the Phase-1 spike observed against live Forgejo 11), so the
 * PRODUCTION Store-1 backend can be exercised end-to-end without Docker:
 *
 *   POST /api/v1/admin/users                    lazy user provisioning (A)
 *   POST /api/v1/user/repos          (Sudo)     repo create, auto_init (A)
 *   PUT  /api/v1/repos/:o/:r/topics/:t          discovery tag
 *   GET  /api/v1/repos/search?topic             discovery (DA-9)
 *   POST /api/v1/repos/:o/:r/contents           BATCH commit w/ author (B/D):
 *                                               create-exists→422, update-missing→404,
 *                                               stale sha→409 — same conflicts as real
 *   GET  /api/v1/repos/:o/:r/contents/:path     blob sha for update ops
 *   GET  /api/v1/repos/:o/:r/raw/:path?ref      bytes as stored (pointers stay pointers)
 *   GET  /api/v1/repos/:o/:r/commits            history
 *   GET  /api/v1/repos/:o/:r/git/commits/:sha   parent resolution
 *   GET  /api/v1/repos/:o/:r/branches/main      head
 *   GET  /api/v1/repos/:o/:r/archive/:ref.tar.gz  Store-3 materialization
 *   POST /:o/:r.git/info/lfs/objects/batch      LFS batch (C) + object PUT/GET,
 *                                               R2 key layout lfs/xx/yy/oid
 *
 * Usage: node tools/forge-mock.mjs --port 4500 --store /tmp/forge
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const PORT = parseInt(opt("--port", "4500"), 10);
const STORE = opt("--store", "/tmp/forge-mock");
mkdirSync(join(STORE, "repos"), { recursive: true });
mkdirSync(join(STORE, "lfs"), { recursive: true });

const users = new Map();   // handle → email
const topics = new Map();  // "owner/repo" → Set(topic)
const tagProtections = new Map(); // "owner/repo" → [{id,name_pattern,whitelist_usernames}]

const repoDir = (o, r) => join(STORE, "repos", o, r);
const git = (dir, a, opts = {}) => execFileSync("git", ["-C", dir, ...a],
  { encoding: opts.buffer ? undefined : "utf8", ...opts });
const env = (name, email) => ({ ...process.env,
  GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
const oidKey = (oid) => join(STORE, "lfs", oid.slice(0, 2), oid.slice(2, 4), oid);

const readBody = (req) => new Promise((res) => {
  const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => res(Buffer.concat(chunks)));
});
const send = (res, code, obj, type = "application/json") => {
  const body = Buffer.isBuffer(obj) ? obj : JSON.stringify(obj ?? {});
  res.writeHead(code, { "content-type": type }); res.end(body);
};

const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : null;
  const j = () => { try { return JSON.parse(body.toString()); } catch { return {}; } };
  let m;
  try {
    /* ---- LFS (spike C shapes; R2 key layout) ---- */
    if ((m = p.match(/^\/([^/]+)\/([^/]+)\.git\/info\/lfs\/objects\/batch$/)) && req.method === "POST") {
      const { operation, objects } = j();
      return send(res, 200, { transfer: "basic", objects: objects.map(({ oid, size }) => {
        const exists = existsSync(oidKey(oid));
        if (operation === "upload") return { oid, size, ...(exists ? {} :
          { actions: { upload: { href: `http://localhost:${PORT}/lfs-objects/${oid}` },
                       verify: { href: `http://localhost:${PORT}/lfs-verify` } } }) };
        return exists
          ? { oid, size, actions: { download: { href: `http://localhost:${PORT}/lfs-objects/${oid}` } } }
          : { oid, size, error: { code: 404, message: "object not found" } };
      }) });
    }
    if ((m = p.match(/^\/lfs-objects\/([0-9a-f]{64})$/))) {
      if (req.method === "PUT") {
        const oid = createHash("sha256").update(body).digest("hex");
        if (oid !== m[1]) return send(res, 422, { message: "oid mismatch" });
        mkdirSync(dirname(oidKey(oid)), { recursive: true });
        writeFileSync(oidKey(oid), body);
        return send(res, 200, {});
      }
      if (!existsSync(oidKey(m[1]))) return send(res, 404, { message: "no object" });
      return send(res, 200, readFileSync(oidKey(m[1])), "application/octet-stream");
    }
    if (p === "/lfs-verify") return send(res, 200, {});

    /* ---- admin: users ---- */
    if (p === "/api/v1/admin/users" && req.method === "POST") {
      const { username, email } = j();
      if (users.has(username)) return send(res, 422, { message: "user already exists" });
      users.set(username, email ?? `${username}@mock`);
      return send(res, 201, { username });
    }
    /* ---- repo create (Sudo = acting user) ---- */
    if (p === "/api/v1/user/repos" && req.method === "POST") {
      const owner = req.headers.sudo;
      const { name, auto_init } = j();
      if (!owner || !users.has(owner)) return send(res, 403, { message: "sudo user unknown" });
      const dir = repoDir(owner, name);
      if (existsSync(dir)) return send(res, 409, { message: "repo exists" });
      mkdirSync(dir, { recursive: true });
      git(dir, ["init", "-qb", "main"]);
      if (auto_init) {
        writeFileSync(join(dir, "README.md"), `# ${name}\n`);
        git(dir, ["add", "-A"]);
        git(dir, ["commit", "-qm", "Initial commit"], { env: env(owner, users.get(owner)) });
      }
      return send(res, 201, { id: `${owner}/${name}`, name, owner: { login: owner } });
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/topics\/([^/]+)$/)) && req.method === "PUT") {
      const k = `${m[1]}/${m[2]}`;
      topics.set(k, (topics.get(k) ?? new Set()).add(m[3]));
      res.writeHead(204); return res.end();
    }
    /* ---- discovery ---- */
    if (p === "/api/v1/repos/search") {
      const want = u.searchParams.get("q");
      const data = [];
      for (const [k, ts] of topics) if (!want || ts.has(want)) {
        const [owner, name] = k.split("/");
        if (existsSync(repoDir(owner, name))) data.push({ id: k, name, owner: { login: owner } });
      }
      const limit = Math.max(1, Number(u.searchParams.get("limit") || 50));
      const page = Math.max(1, Number(u.searchParams.get("page") || 1));
      return send(res, 200, { data: data.slice((page - 1) * limit, page * limit), ok: true });
    }

    const rm = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (rm) {
      const [, o, r] = rm; const rest = rm[3] ?? ""; const dir = repoDir(o, r);
      if (!existsSync(dir)) return send(res, 404, { message: "no repo" });

      if (rest === "/tag_protections") {
        const key = `${o}/${r}`;
        if (req.method === "GET") return send(res, 200, tagProtections.get(key) ?? []);
        if (req.method === "POST") {
          const value = j(), list = tagProtections.get(key) ?? [];
          if (list.some(rule => rule.name_pattern === value.name_pattern))
            return send(res, 422, { message: "tag protection already exists" });
          const rule = { id: list.length + 1, name_pattern: value.name_pattern,
            whitelist_usernames: value.whitelist_usernames ?? [], whitelist_teams: value.whitelist_teams ?? [] };
          list.push(rule); tagProtections.set(key, list); return send(res, 201, rule);
        }
      }
      if (rest === "/tags" && req.method === "POST") {
        const { tag_name, target = "main", message = "" } = j(), actor = req.headers.sudo;
        const rules = tagProtections.get(`${o}/${r}`) ?? [];
        const matching = rules.filter(rule => rule.name_pattern === "v*" && tag_name.startsWith("v"));
        if (matching.length && !matching.some(rule => rule.whitelist_usernames.includes(actor)))
          return send(res, 403, { message: "protected tag" });
        try { git(dir, ["show-ref", "--verify", `refs/tags/${tag_name}`]); return send(res, 409, { message: "tag exists" }); }
        catch {}
        git(dir, ["tag", "-a", tag_name, target, "-m", message],
          { env: env(actor ?? o, users.get(actor ?? o) ?? `${actor ?? o}@mock`) });
        const id = git(dir, ["rev-parse", `refs/tags/${tag_name}`]).trim();
        const sha = git(dir, ["rev-parse", `${tag_name}^{}`]).trim();
        return send(res, 201, { id, name: tag_name, message, commit: { sha } });
      }
      if ((m = rest.match(/^\/tags\/(.+)$/)) && req.method === "GET") {
        const tag = decodeURIComponent(m[1]);
        try { return send(res, 200, { id: git(dir, ["rev-parse", `refs/tags/${tag}`]).trim(),
          name: tag, message: git(dir, ["for-each-ref", "--format=%(contents)", `refs/tags/${tag}`]).trim(),
          commit: { sha: git(dir, ["rev-parse", `${tag}^{}`]).trim() } }); }
        catch { return send(res, 404, { message: "tag not found" }); }
      }
      if ((m = rest.match(/^\/git\/tags\/([0-9a-f]+)$/)) && req.method === "GET") {
        try {
          const raw = git(dir, ["cat-file", "-p", m[1]]), lines = raw.split("\n");
          const object = lines.find(line => line.startsWith("object "))?.slice(7);
          const tag = lines.find(line => line.startsWith("tag "))?.slice(4);
          const blank = lines.indexOf("");
          return send(res, 200, { sha: m[1], tag, object: { sha: object, type: "commit" },
            message: lines.slice(blank + 1).join("\n") });
        } catch { return send(res, 404, { message: "annotated tag not found" }); }
      }

      /* batch commit — the spike's B/C/D semantics incl. conflict behavior */
      if (rest === "/contents" && req.method === "POST") {
        const { message, files, author } = j();
        for (const f of files) {
          const fp = join(dir, f.path);
          let cur = null;
          try { cur = git(dir, ["ls-tree", "main", "--", f.path]).split(/\s+/)[2] ?? null; } catch {}
          if (f.operation === "create" && cur) return send(res, 422, { message: `${f.path} already exists` });
          if (f.operation === "update" && !cur) return send(res, 404, { message: `${f.path} not found` });
          if (f.operation === "update" && f.sha && f.sha !== cur)
            return send(res, 409, { message: `${f.path} sha mismatch (stale)` });
          if (f.operation === "delete") { rmSync(fp, { force: true }); continue; }
          mkdirSync(dirname(fp), { recursive: true });
          writeFileSync(fp, Buffer.from(f.content, "base64"));
        }
        git(dir, ["add", "-A"]);
        git(dir, ["commit", "-qm", message ?? "update"],
          { env: env(author?.name ?? "unknown", author?.email ?? "unknown@mock") });
        return send(res, 201, { commit: { sha: git(dir, ["rev-parse", "HEAD"]).trim() } });
      }
      if ((m = rest.match(/^\/contents\/(.+)$/)) && req.method === "GET") {
        try {
          const sha = git(dir, ["ls-tree", u.searchParams.get("ref") ?? "main", "--", decodeURIComponent(m[1])])
            .split(/\s+/)[2];
          return sha ? send(res, 200, { path: m[1], sha }) : send(res, 404, { message: "not found" });
        } catch { return send(res, 404, { message: "not found" }); }
      }
      if ((m = rest.match(/^\/raw\/(.+)$/))) {
        const ref = u.searchParams.get("ref") ?? "main";
        try {
          const buf = git(dir, ["show", `${ref}:${decodeURIComponent(m[1])}`], { buffer: true });
          return send(res, 200, buf, "application/octet-stream");
        } catch { return send(res, 404, { message: "not found" }); }
      }
      if (rest === "/commits") {
        const path = u.searchParams.get("path");
        const limit = u.searchParams.get("limit") ?? "20";
        let log = "";
        try { log = git(dir, ["log", `-${limit}`, "--format=%H|%an|%ae|%aI|%s",
          ...(path ? ["--", path] : [])]).trim(); } catch {}
        return send(res, 200, (log ? log.split("\n") : []).map(l => {
          const [sha, an, ae, date, ...s] = l.split("|");
          return { sha, commit: { message: s.join("|"), author: { name: an, email: ae, date } } };
        }));
      }
      if ((m = rest.match(/^\/git\/commits\/([0-9a-f]+)$/))) {
        try {
          const parent = git(dir, ["rev-parse", `${m[1]}^`]).trim();
          return send(res, 200, { sha: m[1], parents: [{ sha: parent }] });
        } catch { return send(res, 200, { sha: m[1], parents: [] }); }
      }
      if (rest === "/branches/main")
        return send(res, 200, { name: "main", commit: { id: git(dir, ["rev-parse", "main"]).trim() } });
      if ((m = rest.match(/^\/archive\/(.+)\.tar\.gz$/))) {
        const archive = execFileSync("git", ["-C", dir,
          "-c", "filter.lfs.process=", "-c", "filter.lfs.smudge=cat",
          "-c", "filter.lfs.required=false", "archive", `--prefix=${r}/`, decodeURIComponent(m[1])],
          { maxBuffer: 128 * 1024 * 1024 });
        return send(res, 200, gzipSync(archive), "application/gzip");
      }
    }
    send(res, 404, { message: `forge-mock: no route ${req.method} ${p}` });
  } catch (e) {
    send(res, 500, { message: String(e.message ?? e) });
  }
});
server.listen(PORT, () => console.log(`forge-mock on :${PORT} store=${STORE}`));
