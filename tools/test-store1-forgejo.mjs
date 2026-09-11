#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createForgejoStore } from "../platform/store1-forgejo.mjs";
import { PROJECT_KIND_OWNED, PROJECT_KIND_SANDBOX, PROJECT_META,
  projectMetaBytes } from "../platform/project-ref.mjs";

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(error => error ? reject(error) : resolve(address.port));
  });
});
const tmp = mkdtempSync(join(tmpdir(), "forge-store1-"));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const mock = spawn(process.execPath, [join(process.cwd(), "tools/forge-mock.mjs"),
  "--port", String(port), "--store", join(tmp, "mock")], { stdio: "ignore" });
const api = async (path, authenticated = true) => {
  const response = await fetch(`${origin}/api/v1${path}`, { headers: authenticated
    ? { Authorization: "token mock-token" } : {} });
  let body = null; try { body = await response.json(); } catch {}
  return { response, body };
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await api("/repos/search?q=fmt-game&topic=true")).response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(ready, true, "Forgejo mock becomes ready");

  const source = join(tmp, "source");
  mkdirSync(join(source, "forge"), { recursive: true });
  writeFileSync(join(source, "game.yaml"), "id: demo\ntitle: Demo\nlicense: CC-BY-4.0\n");
  writeFileSync(join(source, PROJECT_META), projectMetaBytes({ storageKey: "demo",
    projectId: "p_0123456789abcdef", namespace: "alice", slug: "demo",
    projectKind: PROJECT_KIND_OWNED }));

  const store = createForgejoStore({ root: process.cwd(), forgeUrl: origin,
    token: "mock-token", farmDir: join(tmp, "farm") });
  const createdGame = await store.createGame("demo", source, "new game", "alice <alice@example.test>");
  assert.match(createdGame.sha, /^[0-9a-f]{40}$/,
    "Forgejo project creation returns the authoritative full commit ID");
  assert.deepEqual(store.repositoryIdentity("demo"), {
    repoId: String((await api("/repos/alice/demo")).body.id), namespace: "alice", repoSlug: "demo"
  }, "Store1 exposes the live physical identity used by authorization");
  await assert.rejects(() => store.materialize("demo", "../../user?token=unsafe"),
    error => error?.status === 422 && /version reference/.test(error.message),
    "the Forgejo Store1 boundary rejects path-like refs before making an archive request");
  const releasedAt = await store.headSha("demo");
  assert.match(releasedAt, /^[0-9a-f]{40}$/,
    "Forgejo head returns the authoritative full commit ID");
  assert.equal(await store.resolveRef("demo", releasedAt.slice(0, 7)), releasedAt,
    "Forgejo expands a legacy abbreviated input before it can be persisted downstream");
  const release = await store.createReleaseTag("demo", "v1.0", releasedAt,
    "test release", "alice <alice@example.test>");
  assert.match(release.target, /^[0-9a-f]{40}$/);
  assert.match(release.tagObject, /^[0-9a-f]{40}$/);
  assert.equal(await store.resolveRef("demo", "v1.0"), releasedAt,
    "Forgejo resolves a safe v* release name to its full commit ID");
  const released = await store.materialize("demo", "v1.0", { resolveLfs: false });
  try {
    assert.match(readFileSync(join(released.dir, "game.yaml"), "utf8"),
      /title: Demo/, "a validated public v* release name is safely encoded and materialized from this Forgejo repo");
  } finally { released.cleanup(); }

  const racePath = "playtests/forgejo-create-race.json";
  assert.equal(await store.fileAt("demo", await store.headSha("demo"), racePath), null,
    "the route-style precheck sees the playtest path as absent");
  const competitor = Buffer.from('{"winner":"competing request"}\n');
  const originalFetch = globalThis.fetch;
  let injectedCompetitor = false;
  globalThis.fetch = async (input, init = {}) => {
    const response = await originalFetch(input, init);
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = String(init.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
    if (!injectedCompetitor && method === "GET" && response.status === 404
      && url.pathname.endsWith(`/contents/${racePath}`)) {
      // Land another writer after Store 1's absence read but before its batch
      // create. This is the exact window that used to turn a create into an
      // update when the route retried through generic writeFiles.
      injectedCompetitor = true;
      const repository = join(tmp, "mock", "repos", "alice", "demo");
      mkdirSync(join(repository, "playtests"), { recursive: true });
      writeFileSync(join(repository, racePath), competitor);
      execFileSync("git", ["-C", repository, "add", "--", racePath]);
      execFileSync("git", ["-C", repository, "-c", "user.name=Competitor",
        "-c", "user.email=competitor@example.test", "commit", "-m", "competing playtest create"]);
    }
    if (injectedCompetitor && method === "POST" && url.pathname.endsWith("/repos/alice/demo/contents")
      && response.status === 422) {
      // Forgejo v15 can preserve the competing commit yet map the final
      // non-fast-forward push as HTTP 500. Store 1 must inspect the protected
      // path after any failed batch instead of relying on one status mapping.
      return new Response(await response.arrayBuffer(), { status: 500, headers: response.headers });
    }
    return response;
  };
  try {
    await assert.rejects(() => store.writeFiles("demo", [{ path: racePath,
      content: '{"winner":"original request"}\n' }], "log playtest", "alice <alice@example.test>",
    { createOnlyPaths: [racePath] }), error => error?.code === "STORE1_PATH_EXISTS"
      && error?.status === 409 && error?.written === false && error?.path === racePath,
    "a competing Forgejo create is surfaced as a create-only conflict");
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(injectedCompetitor, true, "the test exercised the between-check-and-write race window");
  assert.deepEqual(await store.fileAt("demo", await store.headSha("demo"), racePath), competitor,
    "the losing create-only request never overwrites the competitor's bytes");

  let repository = await api("/repos/alice/demo");
  assert.equal(repository.body.private, true, "new repositories are private before policy reconciliation");
  assert.equal((await api("/repos/alice/demo/raw/game.yaml?ref=main")).response.status, 200,
    "the Forge service token can still read private source");
  assert.equal((await api("/repos/alice/demo", false)).response.status, 404,
    "anonymous Forgejo access cannot observe private source");

  let visibility = await store.setVisibility("demo", "public");
  assert.deepEqual(visibility, { visibility: "public", changed: true });
  repository = await api("/repos/alice/demo");
  assert.equal(repository.body.private, false, "public policy updates Forgejo's native private flag");
  assert.equal((await store.setVisibility("demo", "public")).changed, false,
    "matching native visibility is not rewritten");
  assert.equal((await store.setVisibility("demo", "private")).changed, true,
    "a public repository can be reconciled private again");

  const sandboxWrite = await store.writeFiles("demo", [{ path: PROJECT_META,
    content: projectMetaBytes({ storageKey: "demo", projectId: "p_0123456789abcdef",
      namespace: "alice", slug: "demo", projectKind: PROJECT_KIND_SANDBOX }) }],
  "operator marks disposable sandbox", "alice <alice@example.test>");
  assert.match(sandboxWrite.sha, /^[0-9a-f]{40}$/,
    "Forgejo writes return the authoritative full commit ID");
  await store.list();
  let metadata = await store.readMeta("demo");
  assert.equal(metadata.projectKind, PROJECT_KIND_SANDBOX,
    "a valid protected repository marker survives Forgejo refresh");

  const forged = JSON.parse(projectMetaBytes({ storageKey: "victim", projectId: "p_fedcba9876543210",
    namespace: "victim", slug: "stolen", projectKind: PROJECT_KIND_SANDBOX }).toString());
  await store.writeFiles("demo", [{ path: PROJECT_META, content: JSON.stringify(forged) }],
    "simulate out-of-band metadata tampering", "alice <alice@example.test>");
  await store.list();
  metadata = await store.readMeta("demo");
  assert.deepEqual({ namespace: metadata.namespace, slug: metadata.repoSlug,
    kind: metadata.projectKind, trusted: metadata.ownerNamespaceTrusted },
  { namespace: "alice", slug: "demo", kind: PROJECT_KIND_OWNED, trusted: true },
  "Forgejo owner/name override a conflicting file and sandbox authority is discarded");

  assert.equal(store.bindProjectKey("demo", "stable-demo"), "stable-demo",
    "reindex can preserve a durable internal key when native repository identity changes");
  assert.equal(store.has("demo"), false);
  assert.equal(store.has("stable-demo"), true);
  await store.list();
  assert.equal(store.has("stable-demo"), true,
    "Forgejo refresh matches the stable repository id rather than reverting its internal key");
  assert.equal(store.quarantineProject("stable-demo"), true);
  assert.equal(store.has("stable-demo"), false);
  await store.list();
  assert.equal(store.has("stable-demo"), false,
    "a quarantined identity cannot be silently re-admitted by an in-process catalog refresh");

  console.log("FORGEJO STORE GREEN — privacy, stable keys, and identity quarantine work.");
} finally {
  mock.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
}
