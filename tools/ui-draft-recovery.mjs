#!/usr/bin/env node
/** Real custom print review, commit and exact PDF download in an isolated game. */
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
const scratch = mkdtempSync(join(tmpdir(), "forge-ui-draft-recovery."));
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
  // Stock Ember uses the compact renderer. Add the maintained starter design
  // only to this disposable copy so the real Studio can open its original cards.
  const ember = join(games, "ember"), cards = JSON.parse(readFileSync(join(ember, "components/cards.json"), "utf8"));
  const starter = buildCardStarter(yaml.load(readFileSync(join(ember, "game.yaml"), "utf8")), {
    names: cards.map(card => card.name), template: "classic", size: "poker", fields: [],
  });
  for (const file of starter.files.filter(file => file.path.startsWith("templates/"))) {
    let content = file.content;
    if (file.path.endsWith("/manifest.yaml")) {
      const manifest = yaml.load(content); manifest.families[0].match = { id: cards.map(card => card.id) };
      manifest.families[0].specimens = cards.slice(0, 3).map(card => card.id); content = yaml.dump(manifest);
    }
    const path = join(ember, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
  }
  const git = (...args) => execFileSync("git", args, { cwd: store, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Export browser test");
  git("config", "user.email", "export@example.invalid"); git("add", "examples");
  git("commit", "-qm", "seed disposable export game");
  const ref = git("rev-parse", "HEAD"), port = await freePort(), origin = `http://127.0.0.1:${port}`;
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
  await page.goto(`${origin}/#g/community/ember/design`, { waitUntil: "domcontentloaded" });
  await page.locator("#authArea").getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("#amHandle").fill("export-test");
  await page.locator("#amPass").fill("export-password-123");
  await page.locator("#amSubmit").click();
  await page.locator("#authArea").getByText("@export-test", { exact: false }).waitFor();
  await page.getByRole("button", {name:"Open Forge Studio",exact:true}).click();
  await page.locator("#des-content-name").fill("Recovery test card");
  // Staged file bytes and provenance are part of the real Studio snapshot.
  const asset={content_base64:Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>").toString("base64"),
    credit:"Test artist",license:"CC0-1.0",source:"Original test drawing",tags:["draft"],preview_url:"blob:not-portable"};
  const record=await page.evaluate(async asset=>{
    DES.pendingAssets["assets/art/recovery.svg"]=asset;
    await desDraftFlush();return(await desDraftAll()).find(item=>item.key===desDraftKey());
  },asset);
  assert.equal(record.state.cards[0].name,"Recovery test card");
  assert.equal(record.state.pendingAssets["assets/art/recovery.svg"].preview_url,undefined);
  const base=git("rev-parse","HEAD");
  writeFileSync(join(ember,"recovery-collaborator.txt"),"Newer source must survive recovery export.\n");
  git("add","examples");git("commit","-qm","advance source independently");
  const newer=git("rev-parse","HEAD");assert.notEqual(newer,base);
  await page.evaluate(async()=>{
    await desDraftStore("readwrite",store=>store.put({key:"other-account-private",actor:"user:someone-else",version:2,dirty:true,
      slug:"Other account private project",ref:"b".repeat(40),saved_at:new Date().toISOString(),state:{cards:[{name:"Do not expose"}]}}));
    await desDraftStore("readwrite",store=>store.put({key:"old-piece-draft",actor:desDraftActor(),kind:COMPONENT_DRAFT_KIND,version:2,dirty:true,
      slug:"ember",ref:"a".repeat(40),saved_at:"2026-01-01T00:00:00Z",state:{pieces:[{id:"counter",name:"Retained piece"}],design:{families:[]},setup:{id:"original-setup"}}}));
  });
  await page.locator(".account-menu summary").click();
  await page.getByRole("link",{name:"Local drafts",exact:true}).click();
  await page.locator("#recovery-list").waitFor();
  assert.equal(await page.locator("[data-recovery-export]").count(),2);
  assert.ok(!(await page.locator("#view").innerText()).includes("Other account private"));
  assert.ok((await page.locator("#view").innerText()).includes(record.ref));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  const beforeFiles=git("status","--porcelain");
  const downloadPromise=page.waitForEvent("download");
  await page.locator('[data-recovery-export="0"]').focus();await page.keyboard.press("Enter");
  const download=await downloadPromise,target=join(scratch,"recovered.json");await download.saveAs(target);
  const exported=JSON.parse(readFileSync(target,"utf8"));
  assert.equal(exported.format,"forge-local-draft-recovery");assert.deepEqual({...exported.draft,saved_at:record.saved_at},record);
  assert.ok(Date.parse(exported.draft.saved_at)>=Date.parse(record.saved_at));
  assert.equal(exported.draft.state.pendingAssets["assets/art/recovery.svg"].content_base64,asset.content_base64);
  assert.equal(git("rev-parse","HEAD"),newer);assert.equal(git("status","--porcelain"),beforeFiles);
  assert.equal(await page.evaluate(async()=>(await desDraftAll()).length),3,"export retains every recovery copy");
  const pieceDownloadPromise=page.waitForEvent("download");
  await page.locator('[data-recovery-export="1"]').click();
  const pieceDownload=await pieceDownloadPromise;await pieceDownload.saveAs(target);
  assert.equal(JSON.parse(readFileSync(target,"utf8")).draft.state.setup.id,"original-setup");
  // A slow storage response must not overwrite later navigation.
  await page.evaluate(()=>{window.realDraftAll=desDraftAll;desDraftAll=()=>new Promise(resolve=>{window.releaseDraftRead=async()=>resolve(await realDraftAll());});void recoveryPage();});
  await page.waitForFunction(()=>!!window.releaseDraftRead);
  await page.getByRole("link",{name:"Help",exact:true}).click();
  await page.evaluate(async()=>{await releaseDraftRead();desDraftAll=realDraftAll;});
  await page.getByRole("heading",{name:"Make your first playable version in Forge",exact:true}).waitFor();
  assert.equal(await page.locator("#recovery-list").count(),0);
  // Actual account switching cannot display or export the first account's data.
  await page.evaluate(()=>signOut());
  await page.goto(`${origin}/#recovery`,{waitUntil:"domcontentloaded"});
  await page.getByText("Sign in to see this account’s drafts in this browser.",{exact:true}).waitFor();
  const second=await fetch(`${origin}/api/auth/register`,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({handle:"recovery-second",email:"second@example.invalid",password:"second-password-123"})});
  assert.equal(second.status,201);
  await page.locator("#authArea").getByRole("button",{name:"Sign in",exact:true}).click();
  await page.locator("#amHandle").fill("recovery-second");await page.locator("#amPass").fill("second-password-123");await page.locator("#amSubmit").click();
  await page.getByText("No retained drafts for this account in this browser.",{exact:true}).waitFor();
  assert.ok(!(await page.locator("#view").innerText()).includes(record.ref));
  assert.equal(await page.locator("[data-recovery-export]").count(),0);
  // Storage failures have a retry state rather than an empty-success message.
  await page.evaluate(()=>{desDraftAll=async()=>{throw new Error("storage denied")};void recoveryPage();});
  await page.getByRole("button",{name:"Retry",exact:true}).waitFor();
  await page.evaluate(()=>{desDraftAll=realDraftAll;});
  await page.getByRole("button",{name:"Retry",exact:true}).click();
  await page.getByText("No retained drafts for this account in this browser.",{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  await context.close();
  console.log("DRAFT RECOVERY GREEN — discoverable account-scoped copies, original base, staged bytes/rights, pieces/setup, keyboard/mobile, navigation races, storage retry and no source writes.");
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
