#!/usr/bin/env node
/** Fast browser gate for complete public and loopback-private card previews. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { PROJECT_META, projectMetaBytes } from "../platform/project-ref.mjs";
import { checkPublicPreviewAssets } from "../deploy/preview-assets.mjs";
import { inspectPreviewAssets, observePreviewAssets } from "./lib/browser-preview-assets.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-ui-preview-assets."));
const store = join(scratch, "store"), games = join(store, "examples");
const privateSlug = "preview-assets-fixture", family = "Forge Preview DejaVu";
const chrome = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync);
const git = (...args) => execFileSync("git", args, { cwd: store, encoding: "utf8" }).trim();
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(error => error ? reject(error) : resolvePort(port)); });
});
let server, browser, logs = "";

try {
  assert.ok(chrome, "Chrome/Chromium is required; set CHROME_PATH");
  mkdirSync(join(games, "_fixtures"), { recursive: true });
  for (const directory of [join(games, "ember"), join(games, "_fixtures", privateSlug)]) {
    cpSync(join(ROOT, "examples", "ember"), directory, { recursive: true,
      filter: path => !path.split(/[\\/]/).includes("exports") });
  }
  const fixture = join(games, "_fixtures", privateSlug);
  writeFileSync(join(fixture, "game.yaml"), readFileSync(join(fixture, "game.yaml"), "utf8")
    .replace(/^id:\s*ember$/m, `id: ${privateSlug}`).replace(/^license:\s*CC0-1\.0$/m, "license: proprietary"));
  writeFileSync(join(fixture, PROJECT_META), projectMetaBytes({ storageKey: privateSlug,
    projectId: "p_6666666666666666", namespace: "community", slug: privateSlug }));
  // These are Ember's CC0 bytes with restricted test metadata, never proprietary
  // game artwork. Exercise the same anonymous fixture policy as local previews.
  writeFileSync(join(fixture, "forge", "rights.json"), JSON.stringify({ format: "forge-rights", version: 1,
    project: { license: "proprietary", owner: "Preview test", release_permission: "unverified" },
    default: { license: "proprietary", status: "unknown", copyright: ["Preview test"], redistribution: "private-only" }, files: [] }));
  mkdirSync(join(fixture, "assets", "fonts"));
  cpSync(join(ROOT, "tools", "fonts", "DejaVuSans.ttf"), join(fixture, "assets", "fonts", "Preview.ttf"));
  writeFileSync(join(fixture, "templates", "layout.yaml"), JSON.stringify({
    card: { w_mm: 63.5, h_mm: 88.9, bg: "#fff" },
    fonts: [{ id: "body", family, asset: "assets/fonts/Preview.ttf", weight: 400 }],
    regions: [
      { id: "name", type: "text", src: "card.name", x: 3, y: 3, w: 57, h: 12, font: "body", size_pt: 12 },
      { id: "art", type: "image", src: "printing.art_data", x: 3, y: 17, w: 57, h: 40 },
      { id: "text", type: "richtext", src: "card.text", x: 3, y: 60, w: 57, h: 25, font: "body", size_pt: 10, symbols: true },
    ],
  }));
  // The stock compact Ember grid intentionally omits illustrations. Give both
  // disposable copies the same real production layout so the public case also
  // exercises artwork, symbols, and repository-hosted fonts in the card grid.
  mkdirSync(join(games, "ember", "assets", "fonts"));
  cpSync(join(fixture, "assets", "fonts", "Preview.ttf"), join(games, "ember", "assets", "fonts", "Preview.ttf"));
  cpSync(join(fixture, "templates", "layout.yaml"), join(games, "ember", "templates", "layout.yaml"));
  git("init", "-q"); git("config", "user.name", "Preview browser gate");
  git("config", "user.email", "preview@example.invalid"); git("add", "examples"); git("commit", "-qm", "seed independent preview fixtures");
  const ref = git("rev-parse", "HEAD"), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port), "--games", games], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      NODE_ENV: "development", DB: "sqlite", STORE1: "local", LOCAL_STORE_ROOT: store,
      DB_PATH: join(scratch, "platform.db"), CACHE_DIR: join(scratch, "cache"), FARM_DIR: join(scratch, "farm"),
      RELEASE_VAULT_DIR: join(scratch, "vault"), FORGE_HUB_PATH: join(scratch, "hub.html"),
      FORGE_PUBLIC_ORIGIN: origin, FORGE_LISTEN_HOST: "127.0.0.1", FORGE_RATE_MAX: "1000",
      FORGE_INCLUDE_TEST_FIXTURES: "1", FORGE_LOCAL_PRIVATE_PREVIEW: "1" },
  });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-16000); });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  assert.ok(ready, `Preview server did not start: ${logs}`);
  const onlineProof = await checkPublicPreviewAssets(origin, { slug: "ember" });
  assert.equal(onlineProof.ref, ref);
  assert.ok(onlineProof.checked >= 6, "Online launch preflight must inspect the real view's artwork, symbols, and font bytes");
  console.log(`  ✓ Online launch preflight accepts ${onlineProof.checked} exact assets from the real public server`);
  browser = await chromium.launch({ executablePath: chrome, headless: true });

  const preview = async (slug, { fault, expectedFonts = [] } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), observed = observePreviewAssets(page);
    try {
      if (fault) await page.route(`**/api/games/${slug}/assets/${fault.path}*`, route => route.fulfill({
        status: fault.status, contentType: fault.contentType || "image/png", body: fault.body || "broken asset",
      }));
      await page.goto(`${origin}/#g/community/${slug}/cards`, { waitUntil: "domcontentloaded" });
      const proof = await inspectPreviewAssets(page, { expectedFonts });
      assert.ok(proof.cards >= 8, `The complete ${slug} grid must render`);
      assert.ok(proof.images >= 4, `The proof must cover actual artwork and symbols: ${JSON.stringify(proof)}`);
      assert.ok(observed.requests.size >= 3, "Browser requests must reach versioned asset endpoints");
      for (const url of observed.requests) assert.equal(new URL(url).searchParams.get("ref"), ref, "Every rendered asset is pinned to the displayed commit");
      return { ...proof, failures: [...proof.failures, ...observed.failures] };
    } finally { observed.dispose(); await context.close(); }
  };
  for (const slug of ["ember", privateSlug]) {
    const proof = await preview(slug, { expectedFonts: [family] });
    assert.deepEqual(proof.failures, [], `${slug}: ${proof.failures.join("\n")}`);
    console.log(`  ✓ Anonymous ${slug}: ${proof.cards} cards, ${proof.images} decoded images, ${proof.fonts.filter(font => font.status === "loaded").length} loaded fonts`);
  }
  for (const fault of [
    { path: "art/kindling.png", status: 404, expected: /HTTP 404/ },
    { path: "art/kindling.png", status: 200, expected: /Image decode failed/ },
    { path: "fonts/Preview.ttf", status: 200, contentType: "font/ttf", expected: /Font decode failed|Required font did not load/ },
  ]) {
    const proof = await preview(privateSlug, { fault, expectedFonts: [family] });
    assert.match(proof.failures.join("\n"), fault.expected, "The gate must reject the injected broken asset even if a placeholder hides it");
    console.log(`  ✓ Gate rejects ${fault.status} ${fault.path}`);
  }

  // Browser CSS backgrounds have no naturalWidth or error event in the DOM.
  // Verify the same audit decodes them, including corrupt responses with 200.
  const context = await browser.newContext(), page = await context.newPage();
  const backgroundUrl = `${origin}/api/games/ember/assets/art/kindling.png?ref=${ref}`;
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.setContent(`<div class="cf-card" style="width:200px;height:200px;background-image:url('${backgroundUrl}')"></div>`);
  const healthyBackground = await inspectPreviewAssets(page);
  assert.equal(healthyBackground.backgrounds, 1);
  assert.deepEqual(healthyBackground.failures, []);
  await page.route("**/api/games/ember/assets/art/kindling.png*", route => route.fulfill({ status: 200, contentType: "image/png", body: "corrupt" }));
  await page.setContent(`<div class="cf-card" style="width:200px;height:200px;background-image:url('${backgroundUrl}&fault=1')"></div>`);
  assert.match((await inspectPreviewAssets(page)).failures.join("\n"), /Image decode failed/);
  await context.close();
  console.log("  ✓ Gate decodes CSS artwork and rejects corrupt CSS backgrounds");
  console.log("PREVIEW ASSET BROWSER GREEN — public and private exact previews decode; missing and corrupt resources fail the gate.");
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit"); server.kill("SIGTERM"); await stopped;
  }
  rmSync(scratch, { recursive: true, force: true });
}
