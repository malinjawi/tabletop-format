#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PROJECT_META, projectMetaBytes } from "../platform/project-ref.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-local-private-preview-"));
const games = join(scratch, "examples");
const fixtureSlug = "preview-fixture";
const fixtureDir = join(games, "_fixtures", fixtureSlug);
const assetRel = "art/kindling.png";
const assetPath = `/api/games/${fixtureSlug}/assets/${assetRel}`;
const servers = new Set();
// Node's fetch can replace an explicitly supplied Host header. Use an actual
// HTTP request to model the public authority forwarded by a local tunnel.
const statusWithHost = (url, host) => new Promise((resolveStatus, reject) => {
  const request = httpRequest(url, { headers: { host } }, response => {
    response.resume();
    response.once("end", () => resolveStatus(response.statusCode));
  });
  request.once("error", reject);
  request.end();
});
const git = (...args) => execFileSync("git", args, { cwd: scratch, encoding: "utf8" }).trim();
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close(error => error ? reject(error) : resolvePort(port));
  });
});
const stop = async server => {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  servers.delete(server);
};
const seedGame = (dir, slug, projectId) => {
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(join(ROOT, "examples", "ember"), dir, { recursive: true,
    filter: source => !source.split(/[\\/]/).includes("exports") });
  const gamePath = join(dir, "game.yaml");
  writeFileSync(gamePath, readFileSync(gamePath, "utf8")
    .replace(/^id:\s*ember$/m, `id: ${slug}`)
    .replace(/^license:\s*CC0-1\.0$/m, "license: proprietary"));
  writeFileSync(join(dir, PROJECT_META), projectMetaBytes({ storageKey: slug,
    projectId, namespace: "community", slug }));
  writeFileSync(join(dir, "forge", "rights.json"), JSON.stringify({
    format: "forge-rights", version: 1,
    project: { license: "proprietary", owner: "Preview test", release_permission: "unverified" },
    default: { license: "proprietary", status: "unknown", copyright: ["Preview test"],
      redistribution: "private-only" },
    files: [],
  }) + "\n");
};
const start = async enabled => {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  let output = "";
  const runDir = join(scratch, enabled ? "enabled" : "disabled");
  mkdirSync(runDir);
  const server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port), "--games", games], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development", DB: "sqlite", STORE1: "local",
      LOCAL_STORE_ROOT: scratch, DB_PATH: join(runDir, "platform.db"),
      CACHE_DIR: join(runDir, "cache"), FARM_DIR: join(runDir, "farm"),
      RELEASE_VAULT_DIR: join(runDir, "vault"), FORGE_HUB_PATH: join(runDir, "hub.html"),
      FORGE_INCLUDE_TEST_FIXTURES: "1", FORGE_LOCAL_PRIVATE_PREVIEW: enabled ? "1" : "0",
      FORGE_LISTEN_HOST: "127.0.0.1", FORGE_PUBLIC_ORIGIN: "https://preview-tunnel.example" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.add(server);
  server.stdout.on("data", chunk => { output += chunk; });
  server.stderr.on("data", chunk => { output += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  assert.equal(ready, true, `preview server did not start:\n${output}`);
  return { origin, server };
};

try {
  seedGame(fixtureDir, fixtureSlug, "p_4444444444444444");
  seedGame(join(games, "private-project"), "private-project", "p_5555555555555555");
  git("init", "-q");
  git("config", "user.name", "Private preview test");
  git("config", "user.email", "preview@example.test");
  git("add", ".");
  git("commit", "-qm", "private preview fixtures");
  const oldRef = git("rev-parse", "HEAD");
  const oldBytes = readFileSync(join(fixtureDir, "assets", assetRel));
  const newBytes = readFileSync(join(fixtureDir, "assets", "art", "wildfire.png"));
  assert.notDeepEqual(oldBytes, newBytes, "the test must distinguish historical and current artwork");
  writeFileSync(join(fixtureDir, "assets", assetRel), newBytes);
  git("add", ".");
  git("commit", "-qm", "replace fixture artwork");
  const currentRef = git("rev-parse", "HEAD");

  const { origin, server } = await start(true);
  const ui = await fetch(`${origin}/api/games/${fixtureSlug}/ui`);
  assert.equal(ui.status, 200, "anonymous loopback preview can load its private fixture");
  assert.equal(ui.headers.get("cache-control"), "private, no-store");
  const game = await ui.json();
  assert.equal(game.source_ref, currentRef);
  // Follow the URLs actually emitted for the card view. A successful /ui
  // response alone missed the regression: its versioned images returned 404.
  const urls = new Set(JSON.stringify(game).match(/\/api\/games\/preview-fixture\/assets\/[^"\s\\<>]+/g));
  assert.ok(urls.size >= 5, "the generated view must expose artwork and symbol assets");
  for (const path of urls) {
    const url = new URL(path, origin);
    assert.equal(url.searchParams.get("ref"), currentRef, "the preview asset stays pinned to its view");
    const response = await fetch(url);
    assert.equal(response.status, 200, `generated preview asset loads: ${path}`);
    assert.equal(response.headers.get("cache-control"), "private, no-store", "restricted bytes cannot enter a shared cache");
    const relativeAsset = decodeURIComponent(url.pathname.split("/assets/")[1]);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(join(fixtureDir, "assets", relativeAsset)),
      "the preview receives the committed source bytes");
  }
  for (const [suffix, expected] of [[`?ref=${oldRef}`, oldBytes], [`?ref=${currentRef}`, newBytes], ["", newBytes]]) {
    const response = await fetch(origin + assetPath + suffix);
    assert.equal(response.status, 200, "local preview can read current and historical fixture assets");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected,
      "an exact historical request must not silently fall back to current artwork");
  }
  for (const path of [`/api/games/${fixtureSlug}/ui`, assetPath, `${assetPath}?ref=${oldRef}`]) {
    assert.equal(await statusWithHost(origin + path, "preview-tunnel.example"), 404,
      "a tunneled request cannot inherit loopback preview access");
  }
  for (const path of ["/api/games/private-project/ui", "/api/games/private-project/assets/art/kindling.png",
    `/api/games/private-project/assets/art/kindling.png?ref=${oldRef}`]) {
    assert.equal((await fetch(origin + path)).status, 404, "the preview exception never exposes an ordinary private project");
  }
  const write = await fetch(`${origin}/api/games/${fixtureSlug}/cards`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(write.status, 401, "anonymous preview does not grant editing permission");
  await stop(server);

  const disabled = await start(false);
  for (const path of [`/api/games/${fixtureSlug}/ui`, assetPath, `${assetPath}?ref=${oldRef}`]) {
    assert.equal((await fetch(disabled.origin + path)).status, 404,
      "fixture assets remain private when the explicit local preview flag is disabled");
  }
  await stop(disabled.server);
  const production = spawnSync(process.execPath, [join(ROOT, "server.mjs"), "--port", "0"], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", FORGE_INCLUDE_TEST_FIXTURES: "1", FORGE_LOCAL_PRIVATE_PREVIEW: "1" },
  });
  assert.notEqual(production.status, 0);
  assert.match(`${production.stdout}\n${production.stderr}`, /production cannot include internal test fixtures/);

  console.log("LOCAL PRIVATE PREVIEW GREEN — generated exact assets load locally, preserve versions, and stay private elsewhere.");
} finally {
  for (const server of servers) await stop(server);
  rmSync(scratch, { recursive: true, force: true });
}
