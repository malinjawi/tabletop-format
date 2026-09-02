#!/usr/bin/env node
/** Launch-level browser smoke: lazy shell, topics, narrow layouts, and touch size. */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-ui-smoke."));
const storeRoot = join(scratch, "store"), gamesRoot = join(storeRoot, "examples");
const port = 30000 + Math.floor(Math.random() * 10000);
const origin = `http://127.0.0.1:${port}`;
const chrome = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find(existsSync);
const sourceGit=(args)=>spawnSync("git",args,{cwd:ROOT,encoding:"utf8"}).stdout.trimEnd();
const sourceBefore={head:sourceGit(["rev-parse","HEAD"]),status:sourceGit(["status","--porcelain"])};

if (!chrome) throw new Error("Chrome/Chromium not found; run npm run doctor or set CHROME_PATH");

// Local Store-1 commits to its configured Git root. Seed a small, fully
// isolated repository so this mutating UI test can never advance the
// developer's branch or add a fixture to the real catalog.
mkdirSync(join(gamesRoot, "_fixtures"), { recursive: true });
for (const [source, target] of [
  [join(ROOT, "examples", "ember"), join(gamesRoot, "ember")],
  [join(ROOT, "examples", "secret-hitler"), join(gamesRoot, "secret-hitler")],
  [join(ROOT, "examples", "_fixtures", "cards-against-humanity"), join(gamesRoot, "_fixtures", "cards-against-humanity")],
]) cpSync(source, target, { recursive: true, filter: path => !path.split("/").includes("exports") });
for (const args of [
  ["init", "-q"], ["config", "user.name", "Forge UI Smoke"],
  ["config", "user.email", "ui-smoke@example.invalid"], ["add", "examples"],
  ["commit", "-q", "-m", "seed isolated UI fixtures"],
]) {
  const git=spawn("git", args, { cwd: storeRoot, stdio: "ignore" });
  // Complete each setup command before the next one so server startup cannot
  // race the fixture commit.
  await new Promise((resolveDone,reject)=>git.once("exit",code=>code===0?resolveDone():reject(new Error(`git ${args[0]} failed`))));
}

let logs = "";
const server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port), "--games", gamesRoot], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: join(scratch, "platform.db"), CACHE_DIR: join(scratch, "cache"),
    FARM_DIR: join(scratch, "farm"), FORGE_HUB_PATH: join(scratch, "hub.html"),
    LOCAL_STORE_ROOT: storeRoot, FORGE_PUBLIC_ORIGIN: origin, FORGE_REGISTRATION_MODE: "open" },
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
  assert(await page.getByLabel("How Forge helps").isVisible()
    && await page.getByText("Review the actual game", { exact: true }).isVisible(),
    "Explore explains the game-aware layer before exposing repository mechanics");

  const pseudoLink = page.locator(".gcard h3 a").first();
  assert(await pseudoLink.getAttribute("role") === "link" && await pseudoLink.getAttribute("tabindex") === "0",
    "client navigation is keyboard and screen-reader reachable");

  const registration = await page.evaluate(async () => {
    const response = await fetch("/api/auth/register", { method: "POST", headers: {
      "content-type": "application/json", "x-forge-browser": "1",
    }, body: JSON.stringify({ handle: "onboarding-smoke", email: "onboarding@example.invalid", password: "password123" }) });
    return { status: response.status, body: await response.text() };
  });
  assert(registration.status === 201, "onboarding smoke account created in the disposable server", `${registration.status} ${registration.body}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Bring or start a game" }).click();
  assert(await page.getByRole("radio", { name: /Start from an idea/ }).isChecked(),
    "new game opens on the guided idea path");
  await page.getByRole("radio", { name: /Import CSV/ }).check();
  assert(await page.getByLabel("CSV card data").isVisible() && !await page.getByLabel("What should players feel?").isVisible(),
    "CSV path shows only import-relevant fields");
  await page.getByRole("radio", { name: /Connect Google Sheet/ }).check();
  assert(await page.getByLabel("Published Google Sheet URL").isVisible() && !await page.getByLabel("CSV card data").isVisible(),
    "Sheets path is distinct from CSV and explains the working-copy boundary");
  await page.getByRole("button", { name: "Cancel" }).click();

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth,
      scroll: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll("button")]
        .filter(button => { const box = button.getBoundingClientRect(); return box.width && box.height && box.bottom > 0 && box.top < innerHeight; })
        .map(button => ({ label: button.textContent.trim(), height: button.getBoundingClientRect().height })),
    }));
    assert(geometry.scroll <= geometry.viewport, `${width}px Explore has no horizontal overflow`, `${geometry.scroll}/${geometry.viewport}`);
    const shortButtons=geometry.buttons.filter(button=>button.height<44);
    assert(geometry.buttons.length > 0 && shortButtons.length===0,
      `${width}px visible buttons meet the 44px touch target`, JSON.stringify(shortButtons));
  }

  await page.getByLabel("Topic filters").getByRole("button", { name: "party", exact: true }).click();
  const partyTitles = await page.locator(".gcard h3").allTextContents();
  assert(partyTitles.length === 2 && partyTitles.some(title => title.includes("Cards Against Humanity"))
    && partyTitles.some(title => title.includes("Secret Hitler")), "topic facet filters the live catalog");

  await page.getByLabel("Topic filters").getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search games and cards").fill("dueling");
  const searchTitles = await page.locator(".gcard h3").allTextContents();
  assert(searchTitles.some(title=>title.includes("Ember")), "global search includes indexed topics", JSON.stringify(searchTitles));

  // Exercise the real self-serve import UI, not merely its API. The disposable
  // server/store keeps this mutation isolated from the developer's catalog.
  await page.getByRole("button", { name: "Bring or start a game" }).click();
  await page.getByRole("radio", { name: /Import CSV/ }).check();
  await page.getByLabel("Working title").fill("Onboarding Smoke Game");
  await page.getByLabel("CSV card data").fill(`name,type,text,cost\nSpark,unit,Deal 1 damage.,1\nGuard,unit,Prevent 1 damage.,2`);
  await page.getByRole("button", { name: "Import cards as first commit" }).click();
  try {
    await page.waitForURL(/#\/g\/onboarding-smoke\/onboarding-smoke-game\/cards$/,
      { timeout: 20_000, waitUntil: "domcontentloaded" });
  } catch (error) {
    const detail=await page.evaluate(()=>({url:location.href,
      formError:document.getElementById("ngErr")?.textContent,
      modal:document.querySelector("#newGameOverlay")?.textContent,
      toast:document.querySelector(".toast")?.textContent}));
    throw new Error(`CSV onboarding navigation failed: ${JSON.stringify(detail)}\n${error.message}`);
  }
  const imported = await page.evaluate(async()=>await (await fetch("/api/games/onboarding-smoke-game/ui")).json());
  assert(imported.ncards === 2 && imported.namespace === "onboarding-smoke",
    "a stranger can import CSV as an owned two-card first commit through the UI");
  assert(imported.repository === null, "local projects do not advertise a fake hosted Git remote");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: /Portable source project/ }).waitFor();
  const overviewText=await page.locator("body").innerText();
  assert(!overviewText.includes("forge.example") && overviewText.includes("does not trap the project"),
    "project overview proves source portability without placeholder clone commands");
  const sourceAfter={head:sourceGit(["rev-parse","HEAD"]),status:sourceGit(["status","--porcelain"])};
  assert(sourceAfter.head===sourceBefore.head && sourceAfter.status===sourceBefore.status,
    "mutating browser smoke leaves the source checkout untouched");
  assert(errors.length === 0, "Explore produces no browser errors", errors.join(" | "));

  console.log("\nUI SMOKE GREEN — onboarding, CSV import, lazy catalog, facets, search, narrow layout, and touch targets verified.");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
  await Promise.race([
    new Promise(resolveExit => server.once("exit", resolveExit)),
    new Promise(resolveWait => setTimeout(resolveWait, 2000)),
  ]);
  rmSync(scratch, { recursive: true, force: true });
}
