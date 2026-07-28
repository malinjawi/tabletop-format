// @ts-check
/**
 * store1-forgejo.mjs — Store 1 backend: REAL FORGE (production driver).
 *
 * Same surface as store1-local.mjs, implemented over Forgejo's REST API using
 * ONLY primitives the Phase-1 spike verified against a live Forgejo:
 *   A  per-user multi-tenancy   → admin token + `Sudo:` header, lazy user provisioning
 *   B  atomic multi-file commit → POST /repos/{o}/{r}/contents (batch, author fields)
 *   C  LFS write path (SPEC §7) → lfs.mjs batch upload + pointer in the same commit
 *   D  optimistic concurrency   → update operations carry the file sha
 *   G  archive                  → /archive/{ref}.tar.gz feeds Store-3 materialization
 *
 * Model: one game = one Forgejo repo under its owner's account, tagged with
 * the `fmt-game` topic. The topic search IS the source of truth for discovery
 * (DA-9: the platform DB stays a rebuildable index; losing it loses nothing).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, statSync, mkdirSync,
         mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { uploadAsset, downloadAsset, parsePointer } from "../tools/lib/lfs.mjs";

const TOPIC = "fmt-game";
const short = (sha) => (sha ?? "").slice(0, 7);
const firstLine = (s) => (s ?? "").split("\n")[0];
const parseAuthor = (a) => {
  const m = (a ?? "").match(/^(.*?)\s*<(.+)>$/);
  return m ? { name: m[1], email: m[2] } : { name: a || "platform", email: "platform@invalid" };
};
const isPointer = (buf) => buf.slice(0, 60).toString().startsWith("version https://git-lfs");

/** @param {{root:string, forgeUrl:string, token:string, basicAuth?:string|null, farmDir?:string}} cfg */
export function createForgejoStore({ root, forgeUrl, token, basicAuth = null, farmDir }) {
  if (!forgeUrl || !token) throw new Error("STORE1=forgejo requires FORGE_URL and FORGE_TOKEN");
  const base = forgeUrl.replace(/\/$/, "");
  const FARM = farmDir ?? join(root, "data", "forge-farm");
  const lfsAuth = basicAuth ? `Basic ${Buffer.from(basicAuth).toString("base64")}` : `token ${token}`;
  const lfsUrl = (o, r) => `${base}/${o}/${r}.git/info/lfs`;

  /** registry: slug → { owner, head? } — refreshed from the topic search */
  const reg = new Map();

  async function api(method, path, { body, sudo, expect } = {}) {
    const r = await fetch(`${base}/api/v1${path}`, { method,
      headers: { Authorization: `token ${token}`,
                 ...(sudo ? { Sudo: sudo } : {}),
                 ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    if (expect && !expect.includes(r.status))
      throw new Error(`forge ${method} ${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const t = await r.text();
    try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
  }
  async function raw(path) {
    const r = await fetch(`${base}/api/v1${path}`, { headers: { Authorization: `token ${token}` } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`forge raw ${path} → ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async function ensureUser(handle, email) {
    const r = await api("POST", "/admin/users", { body: { username: handle, email,
      password: `Fp-${Math.random().toString(36).slice(2)}9x!`, must_change_password: false } });
    if (![201, 422].includes(r.status)) // 422 = already exists
      throw new Error(`user provisioning failed for ${handle}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  const ownerOf = (slug) => {
    const e = reg.get(slug);
    if (!e) throw new Error(`unknown game '${slug}' (not in forge registry)`);
    return e.owner;
  };

  async function refresh() {
    const r = await api("GET", `/repos/search?q=${TOPIC}&topic=true&limit=50`, { expect: [200] });
    const seen = new Set();
    for (const repo of r.data.data ?? []) {
      reg.set(repo.name, { owner: repo.owner.login });
      seen.add(repo.name);
    }
    for (const k of [...reg.keys()]) if (!seen.has(k)) reg.delete(k);
    return [...reg.keys()];
  }

  /** Walk a local tree into batch-commit file entries (mirrors local fork filter). */
  function treeFiles(dir, prefix = "") {
    const out = [];
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "exports") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...treeFiles(p, `${prefix}${name}/`));
      else out.push({ path: `${prefix}${name}`, content: readFileSync(p) });
    }
    return out;
  }

  async function blobShaOf(owner, slug, path) {
    const r = await api("GET", `/repos/${owner}/${slug}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=main`);
    return r.status === 200 ? r.data.sha : null;
  }

  /** Batch commit with correct create/update ops + author. The spike's B+C+D as one call. */
  async function commitFiles(owner, slug, files, message, author) {
    const ops = [];
    for (const f of files) {
      const sha = await blobShaOf(owner, slug, f.path);
      ops.push({ operation: sha ? "update" : "create", path: f.path,
                 content: Buffer.from(f.content).toString("base64"), ...(sha ? { sha } : {}) });
    }
    const a = parseAuthor(author);
    const r = await api("POST", `/repos/${owner}/${slug}/contents`, { sudo: owner,
      body: { branch: "main", message, files: ops, author: a, committer: a }, expect: [200, 201] });
    reg.set(slug, { owner }); // head changed
    return { sha: short(r.data.commit?.sha ?? r.data.files?.[0]?.commit?.sha) };
  }

  async function createRepo(owner, slug) {
    await api("POST", "/user/repos", { sudo: owner,
      body: { name: slug, auto_init: true, default_branch: "main", private: false }, expect: [201] });
    await api("PUT", `/repos/${owner}/${slug}/topics/${TOPIC}`, { sudo: owner, expect: [204] });
  }

  const store = {
    kind: "forgejo",

    async list() { return refresh(); },
    has(slug) { return reg.has(slug); },

    async readFile(slug, rel) {
      const o = ownerOf(slug);
      return raw(`/repos/${o}/${slug}/raw/${rel}?ref=main`);
    },
    async readMeta(slug) {
      const gy = (await store.readFile(slug, "game.yaml"))?.toString() ?? "";
      let cardCount = null;
      try { cardCount = JSON.parse((await store.readFile(slug, "components/cards.json")).toString()).length; } catch {}
      return { title: (gy.match(/^title:\s*"?([^"\n]+)"?/m) ?? [])[1] ?? slug,
               license: (gy.match(/^license:\s*(\S+)/m) ?? [])[1] ?? null,
               cardCount };
    },

    async writeFiles(slug, files, message, author) {
      return commitFiles(ownerOf(slug), slug, files, message, author);
    },

    async createGame(slug, srcTree, message, author) {
      const { name: owner, email } = parseAuthor(author);
      await ensureUser(owner, email);
      await createRepo(owner, slug);
      reg.set(slug, { owner });
      return commitFiles(owner, slug, treeFiles(srcTree), message, author);
    },

    async fork(src, dest, transformYaml, message, author) {
      const { name: forker, email } = parseAuthor(author);
      const srcOwner = ownerOf(src);
      const { dir, cleanup } = await store.materialize(src, "HEAD", { resolveLfs: false });
      try {
        const files = treeFiles(dir);
        const gy = files.find(f => f.path === "game.yaml");
        gy.content = Buffer.from(transformYaml(gy.content.toString()));
        await ensureUser(forker, email);
        await createRepo(forker, dest);
        reg.set(dest, { owner: forker });
        const res = await commitFiles(forker, dest, files, message, author);
        // carry LFS objects across: pointers were committed verbatim; move the blobs too
        for (const f of files.filter(f => isPointer(f.content))) {
          const bytes = await downloadAsset(lfsUrl(srcOwner, src), f.content.toString(), lfsAuth);
          await uploadAsset(lfsUrl(forker, dest), f.path, bytes, lfsAuth);
        }
        return res;
      } finally { cleanup(); }
    },

    async history(slug, rel, n = 20) {
      const o = ownerOf(slug);
      const r = await api("GET",
        `/repos/${o}/${slug}/commits?path=${encodeURIComponent(rel)}&limit=${n}&stat=false&verification=false&files=false`);
      if (r.status !== 200) return [];
      return (r.data ?? []).map(c => ({ full: c.sha, sha: short(c.sha),
        author: c.commit?.author?.name ?? "?", date: (c.commit?.author?.date ?? "").slice(0, 10),
        subject: firstLine(c.commit?.message) }));
    },
    async fileAt(slug, ref, rel) {
      const o = ownerOf(slug);
      if (ref.endsWith("^")) {
        const r = await api("GET", `/repos/${o}/${slug}/git/commits/${ref.slice(0, -1)}`);
        const parent = r.status === 200 ? r.data.parents?.[0]?.sha : null;
        if (!parent) return null;
        ref = parent;
      }
      return raw(`/repos/${o}/${slug}/raw/${rel}?ref=${ref}`);
    },
    async headSha(slug) {
      const o = ownerOf(slug);
      const r = await api("GET", `/repos/${o}/${slug}/branches/main`, { expect: [200] });
      return short(r.data.commit?.id);
    },

    async putAsset(slug, rel, buf, author) {
      const o = ownerOf(slug);
      const up = await uploadAsset(lfsUrl(o, slug), rel, buf, lfsAuth);
      const { sha } = await commitFiles(o, slug, [{ path: rel, content: up.pointer }],
        `assets: add ${rel} (LFS)`, author);
      return { mode: "lfs", oid: up.oid, sha };
    },
    async getAsset(slug, rel) {
      const buf = await store.readFile(slug, rel);
      if (!buf) return null;
      if (isPointer(buf)) return downloadAsset(lfsUrl(ownerOf(slug), slug), buf.toString(), lfsAuth);
      return buf;
    },

    /** Exact tree at ref via the archive API; LFS pointers under assets/ are
     *  materialized so renderers see real bytes (skip with resolveLfs:false). */
    async materialize(slug, ref, { resolveLfs = true } = {}) {
      const o = ownerOf(slug);
      if (ref === "HEAD") ref = "main";
      const r = await fetch(`${base}/api/v1/repos/${o}/${slug}/archive/${ref}.tar.gz`,
        { headers: { Authorization: `token ${token}` } });
      if (!r.ok) throw new Error(`archive ${slug}@${ref} → ${r.status}`);
      const tmp = mkdtempSync(join(tmpdir(), "forge-at-"));
      writeFileSync(join(tmp, "a.tgz"), Buffer.from(await r.arrayBuffer()));
      execFileSync("tar", ["-xzf", "a.tgz"], { cwd: tmp });
      const top = readdirSync(tmp).find(d => d !== "a.tgz" && statSync(join(tmp, d)).isDirectory());
      const dir = join(tmp, top);
      if (resolveLfs) {
        const walk = (d) => readdirSync(d).flatMap(n => {
          const p = join(d, n);
          return statSync(p).isDirectory() ? walk(p) : [p];
        });
        for (const p of (existsSync(join(dir, "assets")) ? walk(join(dir, "assets")) : [])) {
          const b = readFileSync(p);
          if (isPointer(b)) writeFileSync(p, await downloadAsset(lfsUrl(o, slug), b.toString(), lfsAuth));
        }
      }
      return { dir, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
    },

    /** checkout farm: a refreshed local tree per game (python tools + hub eat these) */
    async dir(slug) {
      const head = await store.headSha(slug);
      const d = join(FARM, slug);
      const stamp = join(FARM, `.${slug}.head`);
      if (!existsSync(d) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== head) {
        rmSync(d, { recursive: true, force: true });
        const { dir, cleanup } = await store.materialize(slug, "HEAD");
        mkdirSync(FARM, { recursive: true });
        execFileSync("cp", ["-r", dir, d]);
        cleanup();
        writeFileSync(stamp, head);
      }
      return d;
    },
    async treeRoot() {
      for (const slug of await store.list()) await store.dir(slug);
      return FARM;
    },
    async version(slug) { return store.headSha(slug); },
    async catalogVersion() {
      const slugs = await store.list();
      return (await Promise.all(slugs.map(s => store.headSha(s).catch(() => "?")))).join("|");
    },
  };
  return store;
}
