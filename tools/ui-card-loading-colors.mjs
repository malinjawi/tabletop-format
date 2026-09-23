#!/usr/bin/env node
/** Complete-card paging and shared color rules in a disposable original game. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import yaml from "js-yaml";
import { buildCardStarter } from "./lib/card-starter.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-ui-artwork-loading."));
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
const deferred = () => {
  let release;
  const promise = new Promise(resolvePromise => { release = resolvePromise; });
  return { promise, release };
};
async function until(predicate, description) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
}
let server, browser, logs = "";

try {
  assert.ok(chrome, "Chrome/Chromium is required; set CHROME_PATH");
  mkdirSync(games, { recursive: true });
  cpSync(join(ROOT, "examples", "ember"), join(games, "ember"), { recursive: true,
    filter: path => !path.split(/[\\/]/).includes("exports") });
  // Stock Ember uses the compact renderer. Add the maintained starter design
  // only to this disposable copy so the real Studio can open its original cards.
  const ember = join(games, "ember"), cards = JSON.parse(readFileSync(join(ember, "components/cards.json"), "utf8"));
  const starter = buildCardStarter(yaml.load(readFileSync(join(ember, "game.yaml"), "utf8")), {
    names: cards.map(card => card.name), template: "classic", size: "poker", fields: [],
  });
  for (const file of starter.files.filter(file => file.path.startsWith("templates/"))) {
    let content = file.content;
    if (file.path.endsWith("/manifest.yaml")) {
      const manifest = yaml.load(content); manifest.families[0].match = { type: [...new Set(cards.map(card=>card.type))] };
      manifest.families[0].specimens = cards.slice(0, 3).map(card => card.id); content = yaml.dump(manifest);
    }
    const path = join(ember, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
  }
  const git = (...args) => execFileSync("git", args, { cwd: store, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Artwork browser test");
  git("config", "user.email", "artwork@example.invalid"); git("config", "core.hooksPath", "/dev/null");
  git("config", "commit.gpgsign", "false"); git("add", "examples"); git("commit", "-qm", "seed disposable artwork game");
  const ref = git("rev-parse", "HEAD"), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const environment = { ...process.env, NODE_ENV: "development", DB: "sqlite", STORE1: "local",
    LOCAL_STORE_ROOT: store, DB_PATH: join(scratch, "platform.db"), CACHE_DIR: join(scratch, "cache"),
    FARM_DIR: join(scratch, "farm"), RELEASE_VAULT_DIR: join(scratch, "vault"),
    FORGE_HUB_PATH: join(scratch, "hub.html"), FORGE_PUBLIC_ORIGIN: origin, FORGE_LISTEN_HOST: "127.0.0.1",
    FORGE_REGISTRATION_MODE: "open", FORGE_RATE_MAX: "1000", FORGE_INCLUDE_TEST_FIXTURES: "0",
    FORGE_LOCAL_PRIVATE_PREVIEW: "0", FORGE_HTTPS: "0" };
  delete environment.LFS_URL;
  server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port), "--games", games], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: environment,
  });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-12000); });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  assert.ok(ready, `Artwork server did not start: ${logs}`);
  const registration = await fetch(`${origin}/api/auth/register`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({
      handle: "artwork-test", email: "artwork@example.invalid", password: "artwork-password-123",
    }) });
  assert.equal(registration.status, 201, "Register only a disposable test account");
  browser = await chromium.launch({ executablePath: chrome, headless: true });

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(20000);
  // Expand the read-only gallery response; the actual versioned game stays small.
  await page.route(`${origin}/api/games/ember/ui`, async route => {
    const response = await route.fetch(), data = await response.json();
    const game = data.game || data;

    if(game.cards) game.cards = Array.from({ length: 30 }, (_, index) => ({ ...game.cards[index % game.cards.length], name: `Gallery ${index}` }));
    for(const family of game.card_design?.families||[])family.layout.regions.push({id:"test_slow_art",type:"image",src:`${origin}/api/games/ember/assets/art/{card.name}.png`,x:3,y:15,w:57,h:25});
    await route.fulfill({ response, json: data });
  });
  const png = readFileSync(join(games, "ember", "assets", "art", "kindling.png"));
  let gate = deferred(), blocked = false, fail = false;
  await page.route(/\/api\/games\/ember\/assets\//, async route => {
    if(route.request().resourceType() !== "image") return route.continue();
    blocked = true; await gate.promise;
    await route.fulfill(fail ? { status: 404, body: "missing" } : { status: 200, contentType: "image/png", body: png });
  });
  await page.goto(`${origin}/#g/community/ember/cards`, { waitUntil: "domcontentloaded" });
  await page.locator('#cgrid[data-card-state="loading"]').waitFor();
  assert.equal(await page.locator(".ctile").count(), 12);
  assert.equal(await page.locator(".card-paint-content").first().evaluate(el => getComputedStyle(el).visibility), "hidden");
  await until(()=>blocked,"A real card image request is pending");
  assert.equal(await page.locator("#cgrid").getAttribute("data-card-state"),"loading");
  gate.release();
  await page.locator('#cgrid[data-card-state="ready"]').waitFor().catch(async error=>{console.error(await page.locator('#cgrid').innerText(),errors);throw error;});
  assert.equal(await page.locator("#cgrid").getAttribute("aria-busy"), "false");
  fail=true;
  await page.locator('[data-page="next"]').click();
  await page.locator('#cgrid[data-card-state="error"]').waitFor();
  assert.equal(await page.locator('#cgrid .card-paint-content').evaluate(el=>getComputedStyle(el).visibility),'hidden');
  fail=false;
  await page.getByRole('button',{name:'Retry preview',exact:true}).click();
  await page.locator('#cgrid[data-card-state="ready"]').waitFor().catch(async error=>{console.error(await page.locator('#cgrid').innerText(),errors);throw error;});
  assert.match(await page.locator('#card-pages').innerText(), /13–24 of 30/);
  assert.equal(await page.evaluate(() => document.activeElement.id), "cgrid", "Retry returns keyboard focus to the preview");
  await page.locator('[data-page="next"]').click();
  await page.locator('#cgrid[data-card-state="ready"]').waitFor().catch(async error=>{console.error(await page.locator('#cgrid').innerText(),errors);throw error;});
  assert.equal(await page.locator('.ctile').count(), 6);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.page),'previous','Paging retains keyboard focus');
  await page.locator('#cardq').focus(); await page.locator('#cardq').fill('Gallery 29');
  await page.locator('#cgrid[data-card-state="ready"]').waitFor().catch(async error=>{console.error(await page.locator('#cgrid').innerText(),errors);throw error;});
  assert.equal(await page.locator('.ctile').count(), 1);
  await page.locator('#cardq').fill('No such card');
  assert.match(await page.locator('#cgrid').innerText(), /No cards match/);
  assert.equal(await page.locator('.card-paint-status').count(), 0);
  // A page replaced while assets are pending must never reveal its stale cards.
  gate=deferred(); blocked=false;
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('#cgrid[data-card-state="loading"]').waitFor();
  await page.goto(`${origin}/#g/community/ember/assets`);
  gate.release();
  assert.equal(await page.locator('#cgrid').count(),0);
  await page.unroute(`${origin}/api/games/ember/ui`);
  await page.unroute(/\/api\/games\/ember\/assets\//);
  await page.goto(`${origin}/#g/community/ember/design`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Open Forge Studio", exact: true }).click();
  await page.locator("#authModal").waitFor({ state: "visible" });
  await page.locator("#amHandle").fill("artwork-test");
  await page.locator("#amPass").fill("artwork-password-123");
  await page.locator("#amSubmit").click();
  await page.getByRole('button',{name:'Layers',exact:true}).first().click();
  await page.locator('[data-design-region="shell"]').click();
  await page.getByLabel('Fill color source',{exact:true}).selectOption('palette');
  await page.getByRole("button", { name: "Colors", exact: true }).click();
  await page.locator('#des-palette-by').selectOption('attributes.cost');
  await page.locator('#des-palette-0').fill('#123456');
  await page.locator('#des-palette-default').fill('#654321');
  await page.locator('.des-cardhost[data-card-state="ready"]').waitFor();
  assert.equal(await page.locator('.des-cardhost [data-lay-region="shell"]').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(18, 52, 86)','Selected field value drives the actual preview color');
  assert.equal(git('rev-parse','HEAD'),ref,"Editing stays in the browser");
  await page.getByRole('button',{name:'Review changes',exact:true}).click();
  await page.getByRole('button',{name:'Commit reviewed candidate',exact:true}).waitFor();
  assert.equal(git('rev-parse','HEAD'),ref,"Review writes nothing");
  if(!await page.locator('#des-studio-commit').isEnabled())console.log(await page.locator('#mbody').innerText());
  assert.equal(await page.locator('#des-studio-commit').isEnabled(),true);
  const saved = page.waitForResponse(r => r.url().endsWith('/design/studio?commit=1') && r.request().method()==='POST');
  await page.locator('#des-studio-commit').click();
  assert.equal((await saved).ok(),true);
  assert.notEqual(git('rev-parse','HEAD'),ref);
  const system = yaml.load(readFileSync(join(ember,'templates/card-design/system.yaml'),'utf8'));
  assert.equal(yaml.load(readFileSync(join(ember,'templates/card-design/families/card.yaml'),'utf8')).regions.find(region=>region.id==='shell').fill,'palette');
  assert.equal(system.palette.by,'attributes.cost'); assert.equal(system.palette.default,'#654321'); assert.equal(system.palette.map['0'],'#123456');
  await page.reload();
  await page.getByRole('button',{name:'Open Forge Studio',exact:true}).click();
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  assert.equal(await page.locator('#des-palette-by').inputValue(),'attributes.cost');
  assert.equal(await page.locator('#des-palette-default').inputValue(),'#654321');
  await page.locator('.des-cardhost[data-card-state="ready"]').waitFor();
  assert.equal(await page.locator('.des-cardhost [data-lay-region="shell"]').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(18, 52, 86)');
  await page.screenshot({path:"/tmp/forge-color-rules-desktop.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1),'Mobile page does not overflow');
  await page.screenshot({path:"/tmp/forge-color-rules-mobile.png",fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('CARD LOADING / COLOR RULES BROWSER GREEN');
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit"); server.kill("SIGTERM"); await stopped;
  }
  rmSync(scratch, { recursive: true, force: true });
}
