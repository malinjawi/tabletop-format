#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenDigest } from "../platform/auth.mjs";
import { openDb, q } from "../platform/db.mjs";
import { projectAccess } from "../platform/project-access.mjs";
import { PROJECT_KIND_OWNED, PROJECT_META, projectMetaBytes } from "../platform/project-ref.mjs";

const owner = { id: "u_owner" };
const stranger = { id: "u_stranger" };

const expect = (label, actual, expected) => {
  for (const [key, value] of Object.entries(expected))
    assert.equal(actual[key], value, `${label}: ${key}`);
};

expect("missing project index", projectAccess(null, owner), {
  can_read: false, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});

const publicOwnerless = { owner_id: null, visibility: "public" };
expect("anonymous public ownerless demo", projectAccess(publicOwnerless, null), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: true, sandbox: false,
});
expect("signed-in public ownerless demo", projectAccess(publicOwnerless, stranger), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: true, sandbox: false,
});
const explicitPublicSandbox = { owner_id: null, visibility: "public", project_kind: "public-sandbox" };
expect("explicit signed-in public sandbox", projectAccess(explicitPublicSandbox, stranger), {
  can_read: true, can_write: true, can_review: true, can_merge: true,
  can_release: false, ownerless: true, sandbox: true,
});
expect("private sandbox marker stays closed", projectAccess({ ...explicitPublicSandbox, visibility: "private" }, stranger), {
  can_read: false, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: true, sandbox: false,
});
expect("owned sandbox marker stays owner-controlled", projectAccess({ ...explicitPublicSandbox, owner_id: owner.id }, stranger), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});

const privateOwnerless = { owner_id: null, visibility: "private" };
for (const [label, user] of [["anonymous", null], ["unrelated user", stranger]])
  expect(`${label} private ownerless fixture`, projectAccess(privateOwnerless, user), {
    can_read: false, can_write: false, can_review: false, can_merge: false,
    can_release: false, ownerless: true, sandbox: false,
  });
expect("explicit contributor on private ownerless fixture",
  projectAccess(privateOwnerless, stranger, "contributor"), {
    can_read: true, can_write: true, can_review: false, can_merge: false,
    can_release: false, ownerless: true, sandbox: false,
  });
expect("explicit maintainer on private ownerless fixture",
  projectAccess(privateOwnerless, stranger, "maintainer"), {
    can_read: true, can_write: true, can_review: true, can_merge: true,
    can_release: false, ownerless: true, sandbox: false,
  });

const privateOwned = { owner_id: owner.id, visibility: "private" };
expect("anonymous private owned project", projectAccess(privateOwned, null), {
  can_read: false, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});
expect("unrelated user on private owned project", projectAccess(privateOwned, stranger), {
  can_read: false, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});
expect("private project owner", projectAccess(privateOwned, owner), {
  can_read: true, can_write: true, can_review: true, can_merge: true,
  can_release: true, ownerless: false, sandbox: false,
});
expect("private project commenter", projectAccess(privateOwned, stranger, "commenter"), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});
expect("private project contributor", projectAccess(privateOwned, stranger, "contributor"), {
  can_read: true, can_write: true, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});
expect("private project maintainer", projectAccess(privateOwned, stranger, "maintainer"), {
  can_read: true, can_write: true, can_review: true, can_merge: true,
  can_release: false, ownerless: false, sandbox: false,
});

const publicOwned = { owner_id: owner.id, visibility: "public" };
expect("anonymous public owned project", projectAccess(publicOwned, null), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});
expect("unrelated user on public owned project", projectAccess(publicOwned, stranger), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "forge-project-route-access-"));
const games = join(temp, "games"), dbPath = join(temp, "platform.db");
const routeOwner = { id: "u_route_owner", handle: "route-owner", email: "route-owner@example.test", pass_hash: "test" };
const routeOutsider = { id: "u_route_outsider", handle: "route-outsider", email: "route-outsider@example.test", pass_hash: "test" };
const ownerToken = "a".repeat(64), outsiderToken = "b".repeat(64);
const json = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};
const copyRouteFixture = (storageKey, namespace, visibility) => {
  const destination = join(games, storageKey);
  cpSync(join(ROOT, "examples", "ember"), destination, { recursive: true,
    filter: source => !source.split(/[\\/]/).includes("exports") });
  const gamePath = join(destination, "game.yaml");
  writeFileSync(gamePath, readFileSync(gamePath, "utf8")
    .replace(/^id:\s*ember$/m, `id: ${storageKey}`)
    .replace(/^title:\s*Ember$/m, `title: ${visibility === "public" ? "Public" : "Private"} Route`));
  writeFileSync(join(destination, PROJECT_META), projectMetaBytes({ storageKey,
    projectId: visibility === "public" ? "p_1111111111111111" : "p_2222222222222222",
    namespace, slug: storageKey, projectKind: PROJECT_KIND_OWNED }));
  if (visibility === "private") json(join(destination, "forge", "rights.json"), {
    format: "forge-rights", version: 1,
    project: { license: "proprietary", owner: namespace, release_permission: "unverified" },
    default: { license: "proprietary", status: "unknown", copyright: [namespace],
      redistribution: "private-only" },
    files: [],
  });
};
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(error => error ? reject(error) : resolvePort(address.port));
  });
});

let server;
let serverOutput = "";
try {
  mkdirSync(games, { recursive: true });
  copyRouteFixture("public-route", "community", "public");
  copyRouteFixture("private-route", routeOwner.handle, "private");
  execFileSync("git", ["init", "-q"], { cwd: temp });
  execFileSync("git", ["config", "user.name", "Project access test"], { cwd: temp });
  execFileSync("git", ["config", "user.email", "project-access@example.test"], { cwd: temp });
  execFileSync("git", ["add", "."], { cwd: temp });
  execFileSync("git", ["commit", "-qm", "route access fixtures"], { cwd: temp });

  const seed = openDb(dbPath);
  await q.createUser(seed, routeOwner);
  await q.createUser(seed, routeOutsider);
  await q.createSession(seed, tokenDigest(ownerToken), routeOwner.id, 60_000);
  await q.createSession(seed, tokenDigest(outsiderToken), routeOutsider.id, 60_000);
  seed.close();

  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port), "--games", games], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development", STORE1: "local", LOCAL_STORE_ROOT: temp,
      DB_PATH: dbPath, CACHE_DIR: join(temp, "cache"), FORGE_HUB_PATH: join(ROOT, "tools", "hub_template.html"),
      FORGE_PUBLIC_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { serverOutput += chunk; });
  server.stderr.on("data", chunk => { serverOutput += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  assert.equal(ready, true, `server did not start:\n${serverOutput}`);

  const request = async (path, token = null) => {
    const response = await fetch(origin + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { response, body: await response.json() };
  };
  const publicProjectPath = "/api/projects/community/public-route";
  for (const [label, token] of [["anonymous", null], ["signed-in outsider", outsiderToken]]) {
    const project = await request(publicProjectPath, token);
    assert.equal(project.response.status, 200, `${label} can resolve a public project`);
    assert.equal(project.body.project_id, "p_1111111111111111");
    const cards = await request(`${publicProjectPath}/cards?limit=2`, token);
    assert.equal(cards.response.status, 200, `${label} can read public project cards`);
    assert.equal(cards.body.items.length, 2);
    assert.match(cards.body.ref, /^[0-9a-f]{40}$/);
  }

  const privateProjectPath = `/api/projects/${routeOwner.handle}/private-route`;
  for (const [label, token] of [["anonymous", null], ["non-member", outsiderToken]]) {
    for (const suffix of ["", "/cards?limit=2"]) {
      const result = await request(privateProjectPath + suffix, token);
      assert.equal(result.response.status, 404, `${label} cannot read private project${suffix ? " cards" : ""}`);
      assert.equal(typeof result.body.error, "string", "private routes return only a generic not-found error");
    }
  }
  const ownerProject = await request(privateProjectPath, ownerToken);
  assert.equal(ownerProject.response.status, 200, "the private project owner can resolve their project");
  assert.equal(ownerProject.body.project_id, "p_2222222222222222");
  const ownerCards = await request(`${privateProjectPath}/cards?limit=2`, ownerToken);
  assert.equal(ownerCards.response.status, 200, "the private project owner can read project cards");
  assert.equal(ownerCards.body.items.length, 2);

  console.log("PROJECT ACCESS GREEN — project and card routes expose public work, hide private work, and admit its owner.");
} finally {
  if (server) {
    server.kill("SIGTERM");
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  rmSync(temp, { recursive: true, force: true });
}
