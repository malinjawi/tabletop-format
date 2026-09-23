#!/usr/bin/env node
/** Visual card setup and safe field migrations in a disposable original game. */
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
const scratch = mkdtempSync(join(tmpdir(), "forge-ui-card-setup."));
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

  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000);
  await page.goto(`${origin}/#g/community/ember/cards/edit`,{waitUntil:'domcontentloaded'});
  await page.locator('#authModal').waitFor({state:'visible'});
  await page.locator('#amHandle').fill('artwork-test');await page.locator('#amPass').fill('artwork-password-123');await page.locator('#amSubmit').click();
  await page.goto(`${origin}/#g/community/ember/cards/setup`);
  await page.getByRole('heading',{name:'Cards & fields',exact:true}).waitFor();
  const originalCards=readFileSync(join(ember,'components/cards.json'),'utf8'),originalLayout=readFileSync(join(ember,'templates/card-design/families/card.yaml'),'utf8');
  await page.getByRole('button',{name:'Add field',exact:true}).click();
  await page.getByLabel('Field name',{exact:true}).fill('Health');
  await page.getByLabel('Input',{exact:true}).selectOption('number');
  await page.getByLabel('Section',{exact:false}).fill('Combat');
  await page.getByLabel('Help text',{exact:false}).fill('Remaining hit points.');
  await page.getByLabel('Show on',{exact:true}).selectOption('selected');
  await page.locator('.cs-checks').getByLabel('ember',{exact:true}).check();
  await page.getByLabel('Required on these card types',{exact:true}).check();
  await page.getByRole('button',{name:'Review changes',exact:true}).click();
  await page.locator('.cs-error').waitFor();assert.match(await page.locator('.cs-error').innerText(),/Health is required/);
  assert.equal(git('rev-parse','HEAD'),ref);assert.equal(readFileSync(join(ember,'components/cards.json'),'utf8'),originalCards);
  await page.getByLabel('Default value',{exact:false}).fill('3.5');await page.getByLabel('Minimum',{exact:true}).fill('0');await page.getByLabel('Maximum',{exact:true}).fill('10');await page.locator('#cs-max').blur();
  await page.locator('#cs-preview-type').selectOption('ward');assert.equal(await page.locator('#cs-sample-health').count(),0);
  await page.locator('#cs-preview-type').selectOption('ember');assert.equal(await page.locator('#cs-sample-health').inputValue(),'3.5');
  await page.getByRole('button',{name:'Add field',exact:true}).click();await page.getByLabel('Field name',{exact:true}).fill('Guild');await page.getByLabel('Input',{exact:true}).selectOption('dropdown');await page.getByLabel('Choices · one per line',{exact:true}).fill('Dawn\nDusk');await page.locator('#cs-choices').blur();
  await page.getByLabel('Default value',{exact:false}).fill('Dawn');await page.locator('#cs-default').blur();
  await page.getByRole('button',{name:'Move up',exact:true}).click();
  await page.reload();await page.getByRole('heading',{name:'Cards & fields',exact:true}).waitFor();assert.match(await page.locator('.cs-notice').innerText(),/restored/);
  await page.getByRole('button',{name:'Power Whole number',exact:true}).click();await page.getByRole('button',{name:'Hide field',exact:true}).click();
  assert.equal(await page.locator('#cs-sample-power').count(),0);
  await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.locator('#cs-save').waitFor();
  assert.equal(git('rev-parse','HEAD'),ref,'Review must not write');
  assert.match(await page.locator('#cs-review').innerText(),/missing values will receive defaults/);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/forge-card-setup-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow on a phone');await page.getByRole('button',{name:'Preview form',exact:true}).click();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/forge-card-setup-mobile.png',fullPage:true});await page.getByRole('button',{name:'Edit setup',exact:true}).click();
  await page.setViewportSize({width:1440,height:1050});
  const saved=page.waitForResponse(r=>r.url().endsWith('/card-setup?commit=1'));await page.locator('#cs-save').click();assert.equal((await saved).status(),200);
  await page.getByRole('heading',{name:'Cards & fields',exact:true}).waitFor();
  assert.notEqual(git('rev-parse','HEAD'),ref);
  const committed=yaml.load(readFileSync(join(ember,'game.yaml'),'utf8')),currentCards=JSON.parse(readFileSync(join(ember,'components/cards.json'),'utf8'));
  assert.equal(committed.attribute_definitions.find(d=>d.key==='health').type,'number');
  for(const card of currentCards){assert.equal(card.attributes.health,card.type==='ember'?3.5:undefined);assert.equal(card.attributes.guild,'Dawn');assert.equal(card.attributes.power,JSON.parse(originalCards).find(c=>c.id===card.id).attributes.power);}
  assert.equal(readFileSync(join(ember,'templates/card-design/families/card.yaml'),'utf8'),originalLayout);
  await page.goto(`${origin}/#g/community/ember/cards/edit`);await page.locator('#ef-attributes_health').waitFor();
  assert.equal(await page.locator('#ef-attributes_health').getAttribute('step'),'any');assert.equal(await page.locator('#ef-attributes_power').count(),0);
  assert.equal(await page.getByLabel('Guild',{exact:true}).inputValue(),'Dawn');
  await page.locator('#ef-type').selectOption('ward');assert.equal(await page.locator('#ef-attributes_health').count(),0);
  await page.locator('#ef-type').selectOption('ember');assert.equal(await page.locator('#ef-attributes_health').inputValue(),'3.5');
  await page.goto(`${origin}/#g/community/ember/design`);await page.getByRole('button',{name:'Open Forge Studio',exact:true}).click();
  await page.getByRole('button',{name:'Content',exact:true}).click();await page.locator('#des-content-attributes-health').waitFor();assert.equal(await page.locator('#des-content-attributes-power').count(),0);
  await page.getByRole('button',{name:'Layers',exact:true}).first().click();await page.locator('[data-design-region="title"]').click();
  await page.getByLabel('Show value from',{exact:true}).selectOption('card.attributes.health');
  await page.locator('.des-cardhost[data-card-state="ready"]').waitFor();assert.match(await page.locator('.des-cardhost [data-lay-region="title"]').innerText(),/3.5/);
  await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.locator('#des-studio-commit').waitFor();assert.equal(await page.locator('#des-studio-commit').isEnabled(),true);
  const bound=page.waitForResponse(r=>r.url().endsWith('/design/studio?commit=1'));await page.locator('#des-studio-commit').click();assert.equal((await bound).status(),200);
  assert.equal(yaml.load(readFileSync(join(ember,'templates/card-design/families/card.yaml'),'utf8')).regions.find(r=>r.id==='title').src,'card.attributes.health');
  await page.reload();await page.getByRole('button',{name:'Open Forge Studio',exact:true}).click();await page.getByRole('button',{name:'Layers',exact:true}).first().click();await page.locator('[data-design-region="title"]').click();assert.equal(await page.getByLabel('Show value from',{exact:true}).inputValue(),'card.attributes.health');
  // Independently exercise access, review binding and stale writes through the real endpoint.
  const api=async(path,body)=>page.evaluate(async({path,body})=>{const r=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,body:await r.json()};},{path,body});
  const opening=await api('/api/games/ember/card-setup');assert.equal(opening.status,200);
  const candidate=structuredClone(opening.body.setup);candidate.attribute_definitions.find(d=>d.key==='health').description='Updated help';
  const reviewed=await api('/api/games/ember/card-setup',{base_ref:opening.body.base_ref,setup:candidate});assert.equal(reviewed.status,200);
  const tampered=structuredClone(candidate);tampered.attribute_definitions.find(d=>d.key==='health').description='Different help';
  const denied=await api('/api/games/ember/card-setup?commit=1',{base_ref:opening.body.base_ref,setup:tampered,review_token:reviewed.body.review_token});assert.equal(denied.status,409);
  writeFileSync(join(ember,'design/test-note.md'),'Another editor changed the game.');git('add','examples/ember/design/test-note.md');git('commit','-qm','Concurrent change');
  const race=await api('/api/games/ember/card-setup?commit=1',{base_ref:opening.body.base_ref,setup:candidate,review_token:reviewed.body.review_token});assert.equal(race.status,409);assert.notEqual(yaml.load(readFileSync(join(ember,'game.yaml'),'utf8')).attribute_definitions.find(d=>d.key==='health').description,'Updated help');
  const latest=await api('/api/games/ember/card-setup');
  const requests=[];
  for(const label of ['First concurrent help','Second concurrent help']){const setup=structuredClone(latest.body.setup);setup.attribute_definitions.find(d=>d.key==='health').description=label;const review=await api('/api/games/ember/card-setup',{base_ref:latest.body.base_ref,setup});assert.equal(review.status,200);requests.push({base_ref:latest.body.base_ref,setup,review_token:review.body.review_token});}
  const simultaneous=await Promise.all(requests.map(body=>api('/api/games/ember/card-setup?commit=1',body)));assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,409]);
  const created=await api('/api/games',{title:'Field Setup Starter',license:'CC0-1.0',empty:true});assert.equal(created.status,201);
  const owned=created.body.slug,start=await api(`/api/games/${owned}/card-setup`),contract={card_types:['Character','Spell'],attribute_definitions:[{key:'health',name:'Health',type:'integer',required:true,default:4,applies_to:['Character']},{key:'unique',name:'Unique',type:'boolean',default:false}]};
  const planned=await api(`/api/games/${owned}/card-setup`,{base_ref:start.body.base_ref,setup:contract});assert.equal(planned.status,200,JSON.stringify(planned));
  const applied=await api(`/api/games/${owned}/card-setup?commit=1`,{base_ref:start.body.base_ref,setup:contract,review_token:planned.body.review_token});assert.equal(applied.status,200);
  const first=await api(`/api/games/${owned}/design/card-starter`,{starter:{names:['Hero'],fields:[],template:'classic',size:'poker'}});assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.body.cards[0].attributes.health,4);assert.equal(first.body.cards[0].attributes.unique,false);assert.equal(first.body.cards[0].type,'Character');
  const outsiderResponse=await fetch(`${origin}/api/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:'setup-outsider',email:'outsider@example.invalid',password:'test-password-123'})});assert.equal(outsiderResponse.status,201);const outsider=await outsiderResponse.json();
  for(const method of ['GET','POST']){const r=await fetch(`${origin}/api/games/${owned}/card-setup`,{method,headers:{authorization:`Bearer ${outsider.token}`,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify({base_ref:applied.body.commit,setup:contract})}:{})});assert.ok([403,404].includes(r.status),`Unauthorized ${method} returned ${r.status}`);}
  const anonymous=await fetch(`${origin}/api/games/ember/card-setup`);assert.equal(anonymous.status,401);
  assert.deepEqual(errors,[]);console.log('CARD SETUP BROWSER / SERVER GREEN');
} catch(error) { console.error(logs);throw error; } finally {
  if(browser)await browser.close();if(server&&server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}
  rmSync(scratch,{recursive:true,force:true});
}
