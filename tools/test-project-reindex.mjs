#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, q } from "../platform/db.mjs";
import { PROJECT_KIND_OWNED, PROJECT_KIND_SANDBOX, PROJECT_META,
  projectMetaBytes } from "../platform/project-ref.mjs";
import { rightsManifestBytes } from "../platform/rights.mjs";

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(error => error ? reject(error) : resolve(address.port));
  });
});
const temp = mkdtempSync(join(tmpdir(), "forge-reindex-"));
const games = join(temp, "examples"), dbPath = join(temp, "platform.db");

const gameTree = (storageKey, { namespace = "community", slug = storageKey,
  projectKind = null, projectId = null } = {}) => {
  const root = join(games, storageKey);
  mkdirSync(join(root, "forge"), { recursive: true });
  writeFileSync(join(root, "game.yaml"), `id: ${slug}\ntitle: ${slug}\nlicense: CC0-1.0\n`);
  writeFileSync(join(root, "forge", "rights.json"), rightsManifestBytes({ license: "CC0-1.0", owner: namespace }));
  if (projectKind) writeFileSync(join(root, PROJECT_META), projectMetaBytes({ storageKey,
    projectId, namespace, slug, projectKind }));
};

gameTree("owned-demo", { namespace: "alice", projectKind: PROJECT_KIND_OWNED,
  projectId: "p_0123456789abcdef" });
gameTree("sandbox-demo", { namespace: "community", projectKind: PROJECT_KIND_SANDBOX,
  projectId: "p_fedcba9876543210" });
// The static jam definition references these two slugs. They intentionally
// double as legacy repositories with no protected identity metadata.
gameTree("ember");
gameTree("harbor-nine");

const seed = openDb(dbPath);
const alice = { id: "u_0123456789abcdef", handle: "alice", email: "alice@example.test", pass_hash: "hash" };
const community = { id: "u_fedcba9876543210", handle: "community", email: "community@example.test", pass_hash: "hash" };
await q.createUser(seed, alice);
await q.createUser(seed, community);
seed.close();

const port = await freePort();
let output = "";
const server = spawn(process.execPath, [join(process.cwd(), "server.mjs"), "--port", String(port), "--games", games], {
  cwd: process.cwd(), env: { ...process.env, NODE_ENV: "development", STORE1: "local",
    LOCAL_STORE_ROOT: temp, DB_PATH: dbPath, FORGE_INCLUDE_TEST_FIXTURES: "0",
    FORGE_HUB_PATH: join(temp, "hub.html") }, stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", chunk => { output += chunk; });
server.stderr.on("data", chunk => { output += chunk; });

try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(ready, true, `server did not start:\n${output}`);

  const indexed = new DatabaseSync(dbPath);
  const owned = indexed.prepare("SELECT * FROM games WHERE slug = 'owned-demo'").get();
  const sandbox = indexed.prepare("SELECT * FROM games WHERE slug = 'sandbox-demo'").get();
  const legacy = indexed.prepare("SELECT * FROM games WHERE slug = 'ember'").get();
  indexed.close();
  assert.equal(owned.owner_id, alice.id,
    "reindex restores an owned repository to the existing account matching its trusted namespace");
  assert.equal(owned.project_kind, PROJECT_KIND_OWNED);
  assert.equal(sandbox.owner_id, null,
    "an explicit sandbox remains ownerless even when an account matches its namespace");
  assert.equal(sandbox.project_kind, PROJECT_KIND_SANDBOX);
  assert.equal(legacy.owner_id, null,
    "legacy metadata does not attach a repository to a coincidentally matching account");
  assert.equal(legacy.project_kind, PROJECT_KIND_OWNED,
    "missing metadata fails closed as an ordinary non-sandbox project");

  console.log("PROJECT REINDEX GREEN — trusted ownership is recovered while sandbox and legacy projects remain ownerless.");
} finally {
  server.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}
