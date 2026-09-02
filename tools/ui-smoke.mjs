#!/usr/bin/env node
/** Launch-level browser smoke: lazy shell, topics, narrow layouts, and touch size. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-ui-smoke."));
const port = 30000 + Math.floor(Math.random() * 10000);
const origin = `http://127.0.0.1:${port}`;
const chrome = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find(existsSync);

if (!chrome) throw new Error("Chrome/Chromium not found; run npm run doctor or set CHROME_PATH");

let logs = "";
const server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port)], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: join(scratch, "platform.db"), CACHE_DIR: join(scratch, "cache"),
    FARM_DIR: join(scratch, "farm"), FORGE_HUB_PATH: join(scratch, "hub.html") },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", chunk => { logs = (logs + chunk).slice(-12000); });
server.stderr.on("data", chunk => { logs = (logs + chunk).slice(-12000); });

let browser;
const assert = (condition, message, detail = "") => {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ""}`);
  console.log(`  ✓ ${message}`);
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode != null) throw new Error(`server exited ${server.exitCode}\n${logs}`);
    try { ready = (await fetch(`${origin}/healthz`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  if (!ready) throw new Error(`server did not become healthy\n${logs}`);

  const shell = Buffer.from(await (await fetch(origin)).arrayBuffer());
  assert(gzipSync(shell).byteLength < 250 * 1024, "compressed live shell stays below 250 KB", `${gzipSync(shell).byteLength} bytes`);
  const index = new DatabaseSync(join(scratch, "platform.db"));
  index.prepare(`INSERT INTO games
    (slug, project_id, namespace, repo_slug, title, visibility, updated_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, 'public', ?, ?)`).run(
      "removed-fixture", "project_removed_fixture", "community", "removed-fixture",
      "Removed fixture", Date.now(), Date.now());
  index.close();
  const catalog = await (await fetch(`${origin}/api/catalog?limit=24`)).json();
  assert(catalog.items.every(game => Array.isArray(game.cards) && game.cards.length === 0),
    "catalog summaries contain no production card faces");
  assert(!catalog.items.some(game => game.slug === "removed-fixture"),
    "catalog ignores stale index rows whose repositories no longer exist");

  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("response", response => {
    const path = new URL(response.url()).pathname, status = response.status();
    if (status >= 400 && !((path === "/api/me" && status === 401) || (path === "/favicon.ico" && status === 404)))
      errors.push(`${status} ${path}`);
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Topic filters").waitFor();

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth,
      scroll: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll("button")]
        .filter(button => { const box = button.getBoundingClientRect(); return box.width && box.height && box.bottom > 0 && box.top < innerHeight; })
        .map(button => button.getBoundingClientRect().height),
    }));
    assert(geometry.scroll <= geometry.viewport, `${width}px Explore has no horizontal overflow`, `${geometry.scroll}/${geometry.viewport}`);
    assert(geometry.buttons.length > 0 && Math.min(...geometry.buttons) >= 44,
      `${width}px visible buttons meet the 44px touch target`, String(Math.min(...geometry.buttons)));
  }

  await page.getByLabel("Topic filters").getByRole("button", { name: "party", exact: true }).click();
  const partyTitles = await page.locator(".gcard h3").allTextContents();
  assert(partyTitles.length === 2 && partyTitles.some(title => title.includes("Cards Against Humanity"))
    && partyTitles.some(title => title.includes("Secret Hitler")), "topic facet filters the live catalog");

  await page.getByLabel("Topic filters").getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search games and cards").fill("dueling");
  const searchTitles = await page.locator(".gcard h3").allTextContents();
  assert(searchTitles.length === 1 && searchTitles[0].includes("Ember"), "global search includes indexed topics");
  assert(errors.length === 0, "Explore produces no browser errors", errors.join(" | "));

  console.log("\nUI SMOKE GREEN — lazy catalog, facets, search, 320/390px layout, and touch targets verified.");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
  await Promise.race([
    new Promise(resolveExit => server.once("exit", resolveExit)),
    new Promise(resolveWait => setTimeout(resolveWait, 2000)),
  ]);
  rmSync(scratch, { recursive: true, force: true });
}
