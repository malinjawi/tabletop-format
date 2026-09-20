#!/usr/bin/env node
/** Read-only discovery and exact-identity recovery through the real server/UI. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {realpathSync,unlinkSync} from "node:fs";
import {createReleaseVault} from "../platform/release-vault.mjs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-ui-release-recovery."));
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

  const created=await page.evaluate(async()=>{
    const r=await fetch('/api/games',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({title:'Recovery Original',license:'CC0-1.0',csv:'name,type,text\nFirst,card,Original source'})});
    return {status:r.status,data:await r.json()};
  });
  assert.equal(created.status,201);const project=created.data;
  const database=new DatabaseSync(join(scratch,'platform.db'));
  const publisher=database.prepare("SELECT id,handle,email FROM users WHERE handle='export-test'").get();
  const vaultRoot=realpathSync(join(scratch,'vault')),vault=createReleaseVault({root:vaultRoot});
  const files=join(scratch,'release-files');mkdirSync(files);
  const frozen=Buffer.from('preserved original release bytes\n');writeFileSync(join(files,'pnp.pdf'),frozen);
  const receipt={status:'ready',name:'pnp.pdf',bytes:frozen.length,sha256:createHash('sha256').update(frozen).digest('hex')};
  const seal=tag=>vault.publishNativeRelease({slug:project.slug,tag,sourceSha:project.commit,sourceDir:files,artifacts:[receipt],
    publication:{created_at:100,sealed_at:100,publisher:{name:publisher.handle,email:publisher.email},
      release:{artifacts:[receipt],author_id:publisher.id,build:{version:1},notes:'Original notes',rights:{publishable:true},title:'Retained <release>'},
      event:{id:`event-${tag}`,kind:'release',actor_id:publisher.id}}});
  const original=seal('v1.0'),manifestPath=join(vaultRoot,original.manifestKey),originalManifest=readFileSync(manifestPath);
  const api=async(method,path,body)=>page.evaluate(async({method,path,body})=>{
    const r=await fetch(path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,data:await r.json()};
  },{method,path,body});
  const recoveryUrl=`/api/games/${project.slug}/releases/recovery`,releaseUrl=`/api/games/${project.slug}/releases`;
  assert.equal((await fetch(origin+recoveryUrl)).status,401);
  const outsiderResponse=await fetch(`${origin}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({handle:'other-owner',email:'other@example.invalid',password:'other-password-123'})});
  const outsider=await outsiderResponse.json();assert.equal(outsiderResponse.status,201);
  const outsiderHeaders={'content-type':'application/json',authorization:`Bearer ${outsider.token}`};
  assert.equal((await fetch(origin+recoveryUrl,{headers:outsiderHeaders})).status,403,'a signed-in non-owner cannot inspect recovery');
  const otherResponse=await fetch(`${origin}/api/games`,{method:'POST',headers:outsiderHeaders,
    body:JSON.stringify({title:'Other Private Project',license:'proprietary',csv:'name,type,text\nSecret,card,Private source'})});
  const other=await otherResponse.json();assert.equal(otherResponse.status,201);
  const otherActor=database.prepare("SELECT id FROM users WHERE handle='other-owner'").get().id;
  vault.publishNativeRelease({slug:other.slug,tag:'v9.0',sourceSha:other.commit,sourceDir:files,artifacts:[receipt],
    publication:{created_at:101,sealed_at:101,publisher:{name:'other-owner',email:'other@example.invalid'},
      release:{artifacts:[receipt],author_id:otherActor,build:{version:1},notes:'Private notes',rights:{publishable:true},title:'Other private release'},
      event:{id:'event-other-private',kind:'release',actor_id:otherActor}}});
  const before=git('rev-parse','HEAD');
  let report=await api('GET',recoveryUrl);assert.equal(report.status,200);assert.equal(report.data.items[0].can_resume,true);
  assert.equal(report.data.items.length,1);assert.ok(!JSON.stringify(report).includes('Other private'),'other project inventory is never returned');
  assert.equal(report.data.items[0].source_sha,project.commit);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM pending_release_publications').get().n,0,'inventory cannot prepare publication');
  assert.equal(git('rev-parse','HEAD'),before);
  const wrong=await api('POST',releaseUrl,{tag:'v1.0',resume_only:true,recovery_manifest_sha256:'f'.repeat(64)});
  assert.equal(wrong.status,409);assert.equal(database.prepare('SELECT COUNT(*) AS n FROM pending_release_publications').get().n,0);
  writeFileSync(join(games,project.slug,'newer-source.txt'),'A later edit must not replace the saved release.\n');
  git('add','examples');git('commit','-qm','Advance source independently');const newer=git('rev-parse','HEAD');
  await page.goto(`${origin}/#g/${project.slug}/releases`,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Resume this release',exact:true}).waitFor();
  assert.ok((await page.locator('#release-recovery').innerText()).includes(project.commit));
  assert.ok((await page.locator('#release-recovery').innerText()).includes('Retained <release>'));
  assert.equal(await page.locator('#release-recovery release').count(),0,'publication text is escaped');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  if(process.env.FORGE_RELEASE_RECOVERY_EVIDENCE_DIR){mkdirSync(process.env.FORGE_RELEASE_RECOVERY_EVIDENCE_DIR,{recursive:true});
    await page.screenshot({path:join(process.env.FORGE_RELEASE_RECOVERY_EVIDENCE_DIR,'interrupted-release-mobile.png'),fullPage:true});}
  const resumedPromise=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===releaseUrl);
  await page.getByRole('button',{name:'Resume this release',exact:true}).click();
  const resumed=await resumedPromise;assert.equal(resumed.status(),201);const result=await resumed.json();
  assert.equal(result.sha,project.commit);assert.equal(result.resumed_pending,true);
  await page.getByText('No interrupted releases found for this game.',{exact:true}).waitFor();
  assert.equal(git('rev-parse','HEAD'),newer);assert.deepEqual(readFileSync(manifestPath),originalManifest);
  assert.equal(git('rev-parse',`refs/tags/forge/${project.slug}/v1.0^{commit}`),project.commit);
  const download=await fetch(`${origin}/cache/releases/${project.slug}/v1.0/pnp.pdf`);
  assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),frozen);
  const lost=seal('v1.1'),lostPath=join(vaultRoot,lost.manifestKey),lostBytes=readFileSync(lostPath);
  unlinkSync(lostPath);
  const missing=await api('POST',releaseUrl,{tag:'v1.1',resume_only:true,recovery_manifest_sha256:lost.manifestSha256});
  assert.equal(missing.status,409);assert.equal(database.prepare('SELECT COUNT(*) AS n FROM releases').get().n,1,'missing seal cannot become a newly built release');
  writeFileSync(lostPath,lostBytes);
  writeFileSync(lostPath,'corrupt pre-journal manifest');
  report=await api('GET',recoveryUrl);assert.equal(report.data.project_storage_issue,true,'an unreadable orphan seal cannot look like an empty healthy inventory');
  writeFileSync(lostPath,lostBytes);
  const blob=join(vaultRoot,'blobs/sha256',receipt.sha256.slice(0,2),receipt.sha256);unlinkSync(blob);
  report=await api('GET',recoveryUrl);assert.equal(report.status,200);
  assert.ok(report.data.items.every(item=>item.classification==='missing'&&!item.can_resume));
  writeFileSync(blob,frozen);
  // A delayed check cannot repaint another page after navigation.
  let finishCheck,checkSeen;const seen=new Promise(resolve=>checkSeen=resolve),delay=new Promise(resolve=>finishCheck=resolve);
  await page.route(`**${recoveryUrl}`,async route=>{const response=await route.fetch();checkSeen();await delay;await route.fulfill({response});});
  await page.getByRole('button',{name:'Check again',exact:true}).click();await seen;
  await page.getByRole('link',{name:'Help',exact:true}).first().click();finishCheck();
  await page.getByRole('heading',{name:'Make your first playable version in Forge',exact:true}).waitFor();
  assert.equal(await page.locator('#release-recovery').count(),0);
  assert.deepEqual(errors,[]);database.close();
  console.log('RELEASE RECOVERY GREEN — owner-only read-only discovery, exact sealed identity, old source retention, corruption refusal, no replacement build, escaped mobile UI and stale navigation.');

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
