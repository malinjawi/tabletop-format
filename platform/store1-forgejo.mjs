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
import { PROJECT_META, parseProjectMeta } from "./project-ref.mjs";

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
  let lfsAuth = basicAuth ? `Basic ${Buffer.from(basicAuth).toString("base64")}` : null;
  const lfsUrl = (o, r) => `${base}/${o}/${r}.git/info/lfs`;

  /** registry: stable storage key → Forgejo repository identity. */
  const reg = new Map();

  /** @param {{body?: unknown, sudo?: string, expect?: number[]}} [options] */
  async function api(method, path, options = {}) {
    const { body, sudo, expect } = options;
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
  async function lfsAuthorization() {
    if (lfsAuth) return lfsAuth;
    // Forgejo's API accepts `Authorization: token …`, while Git/LFS uses HTTP
    // Basic with the service-account username and its access token as password.
    // Resolve the token owner through the authenticated API so production does
    // not need a second password or a duplicated username secret.
    const current = await api("GET", "/user", { expect: [200] });
    const username = current.data?.login ?? current.data?.username;
    if (!username) throw new Error("Forgejo service token has no resolvable owner for LFS authentication");
    lfsAuth = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
    return lfsAuth;
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
  const repoOf = (key) => {
    const e = reg.get(key);
    if (!e) throw new Error(`unknown game '${key}' (not in forge registry)`);
    return e;
  };
  const ownerOf = (key) => repoOf(key).owner;

  async function rawRepo(owner, slug, rel, ref = "main") {
    const r = await fetch(`${base}/api/v1/repos/${owner}/${slug}/raw/${rel}?ref=${encodeURIComponent(ref)}`,
      { headers: { Authorization: `token ${token}` } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`forge raw ${owner}/${slug}/${rel} → ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async function refresh() {
    const seen = new Set();
    for (let page = 1; ; page++) {
      const r = await api("GET", `/repos/search?q=${TOPIC}&topic=true&limit=50&page=${page}`, { expect: [200] });
      const repos = r.data.data ?? [];
      for (const repo of repos) {
        const bytes = await rawRepo(repo.owner.login, repo.name, PROJECT_META);
        const project = parseProjectMeta(bytes, repo.name, repo.owner.login, { storedKey: true });
        reg.set(project.storage_key, { owner: repo.owner.login, slug: repo.name,
          repoId: repo.id == null ? null : String(repo.id), project });
        seen.add(project.storage_key);
      }
      if (repos.length < 50) break;
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
  async function commitFiles(key, files, message, author) {
    const { owner, slug } = repoOf(key);
    const ops = [];
    for (const f of files) {
      const sha = await blobShaOf(owner, slug, f.path);
      if (f.content === null) {
        if (sha) ops.push({ operation: "delete", path: f.path, sha });
        continue;
      }
      ops.push({ operation: sha ? "update" : "create", path: f.path,
                 content: Buffer.from(f.content).toString("base64"), ...(sha ? { sha } : {}) });
    }
    if (!ops.length) return { sha: await store.headSha(key) };
    const a = parseAuthor(author);
    const r = await api("POST", `/repos/${owner}/${slug}/contents`, { sudo: owner,
      body: { branch: "main", message, files: ops, author: a, committer: a }, expect: [200, 201] });
    reg.set(key, { ...repoOf(key), owner, slug }); // head changed
    return { sha: short(r.data.commit?.sha ?? r.data.files?.[0]?.commit?.sha) };
  }

  async function createRepo(owner, slug) {
    const created = await api("POST", "/user/repos", { sudo: owner,
      body: { name: slug, auto_init: true, default_branch: "main", private: false }, expect: [201] });
    await api("PUT", `/repos/${owner}/${slug}/topics/${TOPIC}`, { sudo: owner, expect: [204] });
    return created.data;
  }

  const store = {
    kind: "forgejo",

    async list() { return refresh(); },
    has(slug) { return reg.has(slug); },

    async readFile(key, rel) {
      const { owner, slug } = repoOf(key);
      return rawRepo(owner, slug, rel);
    },
    async readMeta(key) {
      const entry = repoOf(key);
      const gy = (await store.readFile(key, "game.yaml"))?.toString() ?? "";
      const project = parseProjectMeta(await store.readFile(key, PROJECT_META), key, entry.owner, { storedKey: true });
      let cardCount = null;
      try { cardCount = JSON.parse((await store.readFile(key, "components/cards.json")).toString()).length; } catch {}
      return { title: (gy.match(/^title:\s*"?([^"\n]+)"?/m) ?? [])[1] ?? project.slug,
               license: (gy.match(/^license:\s*(\S+)/m) ?? [])[1] ?? null,
               cardCount, projectId: project.project_id, namespace: project.namespace,
               repoSlug: project.slug, repoId: entry.repoId };
    },

    projectKey(namespace, repoSlug) {
      for (const [key, entry] of reg)
        if (entry.project.namespace === namespace && entry.project.slug === repoSlug) return key;
      return null;
    },

    async writeFiles(slug, files, message, author) {
      const { owner, slug: repoSlug } = repoOf(slug), prepared = [];
      for (const f of files) {
        if (f.content !== null && f.path.startsWith("assets/") && !isPointer(Buffer.from(f.content))) {
          const up = await uploadAsset(lfsUrl(owner, repoSlug), f.path, Buffer.from(f.content), await lfsAuthorization());
          prepared.push({ ...f, content: up.pointer });
        } else prepared.push(f);
      }
      return commitFiles(slug, prepared, message, author);
    },

    async createGame(key, srcTree, message, author) {
      const authored = parseAuthor(author);
      const project = parseProjectMeta(readFileSync(join(srcTree, PROJECT_META)), key, authored.name, { storedKey: true });
      const owner = project.namespace, email = authored.email;
      if (owner !== authored.name) throw new Error("project namespace must match the creating account");
      await ensureUser(owner, email);
      const created = await createRepo(owner, project.slug);
      reg.set(key, { owner, slug: project.slug, repoId: created?.id == null ? null : String(created.id), project });
      return { ...(await commitFiles(key, treeFiles(srcTree), message, author)), key };
    },

    async fork(src, dest, transformYaml, message, author, ref = "HEAD", identity = null, repositoryFiles = []) {
      const { name: forker, email } = parseAuthor(author);
      const source = repoOf(src), srcOwner = source.owner;
      const { dir, cleanup } = await store.materialize(src, ref, { resolveLfs: false });
      try {
        const files = treeFiles(dir);
        const gy = files.find(f => f.path === "game.yaml");
        gy.content = Buffer.from(transformYaml(gy.content.toString()));
        if (identity) {
          const meta = files.find(f => f.path === PROJECT_META);
          if (meta) meta.content = identity;
          else files.push({ path: PROJECT_META, content: identity });
        }
        for (const file of repositoryFiles) {
          const existing = files.find(value => value.path === file.path);
          if (existing) existing.content = file.content;
          else files.push(file);
        }
        const project = parseProjectMeta(identity, dest, forker, { storedKey: true });
        await ensureUser(forker, email);
        const created = await createRepo(forker, project.slug);
        reg.set(dest, { owner: forker, slug: project.slug,
          repoId: created?.id == null ? null : String(created.id), project });
        const res = await commitFiles(dest, files, message, author);
        // carry LFS objects across: pointers were committed verbatim; move the blobs too
        for (const f of files.filter(f => isPointer(f.content))) {
          const bytes = await downloadAsset(lfsUrl(srcOwner, source.slug), f.content.toString(), await lfsAuthorization());
          await uploadAsset(lfsUrl(forker, project.slug), f.path, bytes, await lfsAuthorization());
        }
        return res;
      } finally { cleanup(); }
    },

    async history(slug, rel, n = 20) {
      const { owner: o, slug: repoSlug } = repoOf(slug);
      const r = await api("GET",
        `/repos/${o}/${repoSlug}/commits?path=${encodeURIComponent(rel)}&limit=${n}&stat=false&verification=false&files=false`);
      if (r.status !== 200) return [];
      return (r.data ?? []).map(c => ({ full: c.sha, sha: short(c.sha),
        author: c.commit?.author?.name ?? "?", date: (c.commit?.author?.date ?? "").slice(0, 10),
        subject: firstLine(c.commit?.message) }));
    },
    async fileAt(slug, ref, rel) {
      const { owner: o, slug: repoSlug } = repoOf(slug);
      if (ref.endsWith("^")) {
        const r = await api("GET", `/repos/${o}/${repoSlug}/git/commits/${ref.slice(0, -1)}`);
        const parent = r.status === 200 ? r.data.parents?.[0]?.sha : null;
        if (!parent) return null;
        ref = parent;
      }
      return rawRepo(o, repoSlug, rel, ref);
    },
    async headSha(slug) {
      const { owner: o, slug: repoSlug } = repoOf(slug);
      const r = await api("GET", `/repos/${o}/${repoSlug}/branches/main`, { expect: [200] });
      return short(r.data.commit?.id);
    },

    async createReleaseTag(key, tag, target, message) {
      if (!/^v[0-9][0-9A-Za-z._-]{0,31}$/.test(tag)) throw new Error("release tags must start with v and a number");
      const { owner, slug } = repoOf(key);
      const protections = await api("GET", `/repos/${owner}/${slug}/tag_protections`, { expect: [200] });
      if (!(protections.data ?? []).some(rule => rule.name_pattern === "v*")) {
        await api("POST", `/repos/${owner}/${slug}/tag_protections`, { sudo: owner,
          body: { name_pattern: "v*", whitelist_usernames: [owner], whitelist_teams: [] }, expect: [201] });
      }
      const created = await api("POST", `/repos/${owner}/${slug}/tags`, { sudo: owner,
        body: { tag_name: tag, target, message }, expect: [201] });
      const current = await api("GET", `/repos/${owner}/${slug}/tags/${encodeURIComponent(tag)}`, { expect: [200] });
      const tagObject = current.data.id ?? created.data.id;
      const annotated = tagObject
        ? await api("GET", `/repos/${owner}/${slug}/git/tags/${tagObject}`, { expect: [200] }) : null;
      return { tag, target: annotated?.data?.object?.sha ?? current.data.commit?.sha,
        tagObject, annotated: !!annotated?.data?.message, protected: true };
    },

    async releaseTagInfo(key, tag) {
      const { owner, slug } = repoOf(key);
      const current = await api("GET", `/repos/${owner}/${slug}/tags/${encodeURIComponent(tag)}`);
      if (current.status === 404) return null;
      if (current.status !== 200) throw new Error(`cannot read release tag '${tag}'`);
      const tagObject = current.data.id;
      const annotated = tagObject ? await api("GET", `/repos/${owner}/${slug}/git/tags/${tagObject}`) : null;
      const protections = await api("GET", `/repos/${owner}/${slug}/tag_protections`, { expect: [200] });
      return { tag, target: annotated?.data?.object?.sha ?? current.data.commit?.sha,
        tagObject, annotated: annotated?.status === 200 && !!annotated.data?.message,
        protected: (protections.data ?? []).some(rule => rule.name_pattern === "v*"),
        message: annotated?.data?.message ?? current.data.message ?? "" };
    },

    async putAsset(slug, rel, buf, author, extraFiles = []) {
      const { owner: o, slug: repoSlug } = repoOf(slug);
      const up = await uploadAsset(lfsUrl(o, repoSlug), rel, buf, await lfsAuthorization());
      const { sha } = await commitFiles(slug, [{ path: rel, content: up.pointer }, ...extraFiles],
        `assets: add ${rel} (LFS)`, author);
      return { mode: "lfs", oid: up.oid, sha };
    },
    async getAsset(slug, rel) {
      const buf = await store.readFile(slug, rel);
      if (!buf) return null;
      if (isPointer(buf)) { const repo = repoOf(slug); return downloadAsset(lfsUrl(repo.owner, repo.slug), buf.toString(), await lfsAuthorization()); }
      return buf;
    },

    /** Exact tree at ref via the archive API; LFS pointers under assets/ are
     *  materialized so renderers see real bytes (skip with resolveLfs:false). */
    async materialize(slug, ref, { resolveLfs = true } = {}) {
      const { owner: o, slug: repoSlug } = repoOf(slug);
      if (ref === "HEAD") ref = "main";
      const r = await fetch(`${base}/api/v1/repos/${o}/${repoSlug}/archive/${ref}.tar.gz`,
        { headers: { Authorization: `token ${token}` } });
      if (!r.ok) throw new Error(`archive ${slug}@${ref} → ${r.status}`);
      const tmp = mkdtempSync(join(tmpdir(), "forge-at-"));
      writeFileSync(join(tmp, "a.tgz"), Buffer.from(await r.arrayBuffer()));
      execFileSync("tar", ["-xzf", "a.tgz"], { cwd: tmp });
      const top = readdirSync(tmp).find(d => d !== "a.tgz" && statSync(join(tmp, d)).isDirectory());
      if (!top) {
        rmSync(tmp, { recursive: true, force: true });
        throw new Error(`archive ${slug}@${ref} did not contain a project tree`);
      }
      const dir = join(tmp, top);
      if (resolveLfs) {
        const walk = (d) => readdirSync(d).flatMap(n => {
          const p = join(d, n);
          return statSync(p).isDirectory() ? walk(p) : [p];
        });
        for (const p of (existsSync(join(dir, "assets")) ? walk(join(dir, "assets")) : [])) {
          const b = readFileSync(p);
          if (isPointer(b)) writeFileSync(p, await downloadAsset(lfsUrl(o, repoSlug), b.toString(), await lfsAuthorization()));
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
