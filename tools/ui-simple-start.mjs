#!/usr/bin/env node
/** Title-only private creation, optional brief and import review in a real browser. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-ui-simple-start."));
const store = join(scratch, "store"), games = join(store, "examples");
const chrome = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync);
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const port = probe.address().port;
    probe.close(error => error ? reject(error) : resolvePort(port)); });
});
let server, browser, page, logs = "";

try {
  assert.ok(chrome, "Chrome/Chromium is required; set CHROME_PATH");
  mkdirSync(games, { recursive: true });
  cpSync(join(ROOT, "examples", "ember"), join(games, "ember"), { recursive: true,
    filter: path => !path.split(/[\\/]/).includes("exports") });
  const git = (...args) => execFileSync("git", args, { cwd: store, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Export browser test");
  git("config", "user.email", "export@example.invalid"); git("add", "examples");
  git("commit", "-qm", "seed disposable export game");
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port), "--games", games], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      NODE_ENV: "development", DB: "sqlite", STORE1: "local", LOCAL_STORE_ROOT: store,
      DB_PATH: join(scratch, "platform.db"), CACHE_DIR: join(scratch, "cache"), FARM_DIR: join(scratch, "farm"),
      RELEASE_VAULT_DIR: join(scratch, "vault"), FORGE_HUB_PATH: join(scratch, "hub.html"),
      FORGE_PUBLIC_ORIGIN: origin, FORGE_LISTEN_HOST: "127.0.0.1", FORGE_REGISTRATION_MODE: "open",
      FORGE_RATE_MAX: "1000", FORGE_INCLUDE_TEST_FIXTURES: "0", FORGE_LOCAL_PRIVATE_PREVIEW: "0" },
  });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-12000); });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  assert.ok(ready, `Export server did not start: ${logs}`);
  const registration = await fetch(`${origin}/api/auth/register`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({
      handle: "export-test", email: "export@example.invalid", password: "export-password-123",
    }) });
  assert.equal(registration.status, 201, "The disposable user is registered independently of browser cookies");
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 } });
  page = await context.newPage();
  const errors = [];
  page.setDefaultTimeout(20_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.locator("#authArea").getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("#amHandle").fill("export-test");
  await page.locator("#amPass").fill("export-password-123");
  await page.locator("#amSubmit").click();
  await page.locator("#authArea").getByText("@export-test", { exact: false }).waitFor();
  await page.locator(".hero").getByRole("button",{name:"New game",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Start or bring a game"});
  await dialog.waitFor();
  assert.equal(await page.locator("#ng-add-brief").isChecked(),false);
  assert.equal(await page.locator("#ng-spark").isVisible(),false);
  await page.locator("#ng-title").fill("Private Starting Point");
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,`${width}px creation fits`);
  }
  await page.locator("#ng-ok").focus();await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(()=>document.activeElement?.name),"ng-mode","keyboard stays in the modal");
  const createdPromise=page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname==="/api/games");
  await page.getByRole("button",{name:"Create game",exact:true}).click();
  const created=await createdPromise;assert.equal(created.status(),201);const project=await created.json();
  assert.equal(project.cards,0);
  await page.waitForURL(/private-starting-point\/design$/);
  await page.getByRole("heading",{name:"Put the first playable cards on the table",exact:true}).waitFor();
  assert.equal((await fetch(`${origin}/api/games/${project.slug}/ui`)).status,404,"private source is hidden from strangers");
  const createdDir=join(games,project.slug);
  assert.equal(existsSync(join(createdDir,"design/brief.json")),false,"no fabricated brief");
  assert.deepEqual(JSON.parse(readFileSync(join(createdDir,"components/cards.json"))),[]);
  assert.match(readFileSync(join(createdDir,"game.yaml"),"utf8"),/proprietary/);
  if(process.env.FORGE_START_EVIDENCE_DIR){
    mkdirSync(process.env.FORGE_START_EVIDENCE_DIR,{recursive:true});
    await page.screenshot({path:join(process.env.FORGE_START_EVIDENCE_DIR,"empty-private-game.png"),fullPage:true});
  }
  await page.getByRole("button",{name:"Build the first card system",exact:true}).click();
  await page.getByLabel(/Starter card names/).fill("Strike\nGuard");
  await page.getByRole("button",{name:"Review first component",exact:true}).click();
  await page.getByRole("heading",{name:"Review the first component system",exact:true}).waitFor();
  assert.deepEqual(JSON.parse(readFileSync(join(createdDir,"components/cards.json"))),[],"review has not committed cards");
  await page.getByRole("button",{name:"Commit first component",exact:true}).click();
  await page.waitForURL(/private-starting-point\/cards\/edit$/);
  assert.equal(JSON.parse(readFileSync(join(createdDir,"components/cards.json"))).length,2);

  await page.goto(origin,{waitUntil:"domcontentloaded"});
  await page.locator("#authArea").getByText("@export-test",{exact:false}).waitFor();
  await page.locator(".hero").getByRole("button",{name:"New game",exact:true}).click();
  await page.locator("#ng-title").fill("Optional Brief");
  await page.locator("#ng-add-brief").check();
  await page.locator("#ng-spark").fill("An original game about sharing a garden.");
  await page.locator("#ng-experience").fill("Cooperate under time pressure.");
  await page.locator("#ng-mvp").fill("Choose two cards and compare outcomes.");
  await page.locator("#ng-question").fill("Does sharing feel useful?");
  await page.getByRole("radio",{name:/Import CSV/}).check();
  await page.getByRole("radio",{name:/Empty game/}).check();
  assert.equal(await page.locator("#ng-spark").inputValue(),"An original game about sharing a garden.","switching path preserves optional brief");
  await page.locator("#ng-ok").click();await page.waitForURL(/optional-brief$/);
  const brief=JSON.parse(readFileSync(join(games,"optional-brief/design/brief.json")));
  assert.equal(brief.spark,"An original game about sharing a garden.");
  assert.equal(brief.mvp.question,"Does sharing feel useful?");

  await page.goto(origin,{waitUntil:"domcontentloaded"});
  await page.locator("#authArea").getByText("@export-test",{exact:false}).waitFor();
  await page.locator(".hero").getByRole("button",{name:"New game",exact:true}).click();
  await page.getByRole("radio",{name:/Import CSV/}).check();
  await page.getByLabel("CSV card data").fill("name,type,text\nOriginal,card,First row");
  let releaseReview,seenReview;
  const seen=new Promise(resolve=>{seenReview=resolve;});
  const delayed=new Promise(resolve=>{releaseReview=resolve;});
  await page.route("**/api/imports/csv/preview",async route=>{
    const response=await route.fetch();seenReview();await delayed;await route.fulfill({response});
  });
  await page.getByRole("button",{name:"Review columns",exact:true}).click();await seen;
  await page.getByLabel("CSV card data").fill("name,type,text\nChanged,card,Unreviewed row");
  releaseReview();await page.waitForTimeout(100);
  assert.equal(await page.locator("#ng-ok").isDisabled(),true,"late review cannot authorize newer CSV");
  assert.equal(await page.evaluate(()=>NG_CSV_PREVIEW),null);
  await page.unroute("**/api/imports/csv/preview");
  await page.getByRole("button",{name:"Review columns",exact:true}).click();
  await page.getByText("1 cards ready",{exact:true}).waitFor();
  assert.equal(await page.locator("#ng-ok").isEnabled(),true);
  await page.keyboard.press("Escape");assert.equal(await dialog.count(),0);
  assert.deepEqual(errors,[]);
  console.log("SIMPLE START GREEN — private title-only project, no invented brief/cards, reviewed first cards, optional brief retained, mobile/keyboard and stale CSV rejection.");
} catch(error) {
  console.error(logs.slice(-4000));
  if(page&&!page.isClosed()) console.error((await page.locator("#mbody").innerText()).slice(-4000));
  throw error;
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit"); server.kill("SIGTERM"); await stopped;
  }
  rmSync(scratch, { recursive: true, force: true });
}
