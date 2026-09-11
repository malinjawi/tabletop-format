#!/usr/bin/env node
/** Exercise the developer launcher against a disposable application checkout.
 * This never starts the real checkout's server or touches its development data. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const ROOT=resolve(import.meta.dirname,".."),scratch=mkdtempSync(join(tmpdir(),"forge-dev-launcher-test."));
const app=join(scratch,"app"),runtime=join(app,"data","dev"),store=join(runtime,"store"),lock=join(app,"data",".dev.lock");
const running=new Set();
let browser;
const git=(cwd,...args)=>{
  const result=spawnSync("git",args,{cwd,encoding:"utf8"});
  assert.equal(result.status,0,`Git ${args[0]} failed: ${result.stderr}`);return result.stdout.trim();
};
const freePort=()=>new Promise((resolvePort,reject)=>{
  const listener=createServer();listener.once("error",reject);
  listener.listen(0,"127.0.0.1",()=>{const port=listener.address().port;listener.close(error=>error?reject(error):resolvePort(port));});
});
const pause=ms=>new Promise(resolveWait=>setTimeout(resolveWait,ms));
const request=async(origin,path,{method="GET",token,json}={})=>{
  const response=await fetch(`${origin}${path}`,{method,headers:{...(token?{authorization:`Bearer ${token}`}:{}) ,...(json===undefined?{}:{"content-type":"application/json"})},
    body:json===undefined?undefined:JSON.stringify(json),signal:AbortSignal.timeout(15000)});
  const data=await response.json().catch(()=>({}));
  assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);return {response,data};
};
const start=(port,env={})=>{
  const child=spawn(process.execPath,[join(app,"tools","dev.mjs"),"--port",String(port)],{
    cwd:app,env:{...process.env,...env},stdio:["ignore","pipe","pipe"],detached:true,
  });
  const handle={child,output:"",done:null};running.add(handle);
  for(const stream of [child.stdout,child.stderr])stream.on("data",chunk=>{handle.output=(handle.output+chunk).slice(-14000);});
  handle.done=new Promise((resolveDone,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>resolveDone({code,signal}));});
  return handle;
};
const waitReady=async(handle,origin)=>{
  for(let i=0;i<240;i++){
    if(handle.child.exitCode!==null||handle.child.signalCode)break;
    try{const result=await fetch(`${origin}/healthz`,{signal:AbortSignal.timeout(500)});if(result.ok)return await result.json();}catch{}
    await pause(100);
  }
  assert.fail(`Developer server did not become ready:\n${handle.output}`);
};
const waitExit=async handle=>{
  let timeout;
  try{return await Promise.race([handle.done,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error(`Launcher did not exit:\n${handle.output}`)),10000);})]);}
  finally{clearTimeout(timeout);}
};
const stop=async handle=>{
  handle.child.kill("SIGTERM");const exit=await waitExit(handle);running.delete(handle);
  assert.equal(exit.code,0,`Graceful stop failed:\n${handle.output}`);
};
const assertPortClosed=async port=>{
  const listener=createServer();await new Promise((resolveListen,reject)=>{listener.once("error",reject);listener.listen(port,"127.0.0.1",resolveListen);});
  await new Promise((resolveClose,reject)=>listener.close(error=>error?reject(error):resolveClose()));
};

try{
  // Copy app code, schemas and docs, but never copy another game's restricted
  // content, a runtime, accounts, or the real app's Git repository.
  mkdirSync(app,{recursive:true});
  const files=spawnSync("git",["ls-files","-z"],{cwd:ROOT,encoding:"utf8"});assert.equal(files.status,0);
  for(const name of new Set([...files.stdout.split("\0").filter(Boolean),"tools/dev.mjs"])){
    if(name.startsWith("examples/")&&!name.startsWith("examples/ember/"))continue;
    if(name.startsWith("examples/ember/exports/")||!existsSync(join(ROOT,name)))continue;
    mkdirSync(dirname(join(app,name)),{recursive:true});cpSync(join(ROOT,name),join(app,name));
  }
  for(const name of ["node_modules",".venv"]){
    assert.ok(existsSync(join(ROOT,name)),`Run npm run setup:dev before testing; missing ${name}`);
    symlinkSync(realpathSync(join(ROOT,name)),join(app,name),"dir");
  }
  // A second CC0 example in app source makes the Ember-only seed observable.
  const decoy=join(app,"examples","extra-game");cpSync(join(app,"examples","ember"),decoy,{recursive:true});
  writeFileSync(join(decoy,"game.yaml"),readFileSync(join(decoy,"game.yaml"),"utf8").replace(/^id:.*$/m,"id: extra-game"));
  git(app,"init","-q");git(app,"config","user.name","Developer launcher test");git(app,"config","user.email","dev-test@example.invalid");
  git(app,"config","commit.gpgsign","false");git(app,"config","core.hooksPath","/dev/null");git(app,"add",".");git(app,"commit","-qm","Disposable application snapshot");
  const appHead=git(app,"rev-parse","HEAD"),appState=git(app,"status","--porcelain");assert.equal(appState,"");
  const sourceCardBytes=readFileSync(join(app,"examples","ember","components","cards.json"));
  for(const args of [["--port","80"],["--port","65536"],["--port","garbage"],["--unknown"]]){
    const result=spawnSync(process.execPath,[join(app,"tools","dev.mjs"),...args],{cwd:app,encoding:"utf8"});
    assert.equal(result.status,2,`Invalid launch arguments must fail: ${args.join(" ")}`);
    assert.equal(existsSync(join(app,"data")),false,"Invalid arguments cannot create development state");
  }
  console.log("  ✓ Invalid launch arguments fail before creating state");

  const port=await freePort(),origin=`http://localhost:${port}`,wrongState=join(scratch,"must-not-use");
  const hostileEnvironment={NODE_ENV:"production",DB:"postgres",STORE1:"forgejo",PG_URL:"postgres://invalid:invalid@127.0.0.1:1/invalid",
    LOCAL_STORE_ROOT:wrongState,DB_PATH:join(wrongState,"private.db"),CACHE_DIR:join(wrongState,"cache"),FARM_DIR:join(wrongState,"farm"),
    RELEASE_VAULT_DIR:join(wrongState,"vault"),FORGE_HUB_PATH:join(wrongState,"hub.html"),FORGE_PUBLIC_ORIGIN:"https://wrong-origin.example.invalid",
    FORGE_LISTEN_HOST:"0.0.0.0",FORGE_HTTPS:"1",FORGE_REGISTRATION_MODE:"closed",FORGE_INVITE_MODE:"database",
    FORGE_INCLUDE_TEST_FIXTURES:"1",FORGE_LOCAL_PRIVATE_PREVIEW:"1",FORGE_ALLOWED_ORIGINS:"https://wrong-origin.example.invalid",
    FORGE_URL:"http://127.0.0.1:1",LFS_URL:"http://127.0.0.1:1"};
  const first=start(port,hostileEnvironment),health=await waitReady(first,origin);
  assert.equal(health.ok,true);assert.equal(health.registration,"open");
  assert.equal(existsSync(wrongState),false,"Inherited production paths are never created or used");
  const initial=(await request(origin,"/api/games")).data;
  assert.deepEqual(initial.map(game=>game.slug),["ember"],"A fresh launcher exposes only Ember");
  assert.deepEqual(readdirSync(join(store,"examples")),["ember"],"Only Ember is copied into the writable source store");
  const hubResponse=await fetch(origin),hub=await hubResponse.text();assert.equal(hubResponse.status,200);
  const embedded=hub.match(/let DATA = ([\s\S]*?);\n\/\//);assert.ok(embedded,"Hub contains its generated source data");
  assert.deepEqual(JSON.parse(embedded[1]).games,[],"The public hub shell does not embed private game data before catalog hydration");
  const chrome=process.env.CHROME_PATH||["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/Applications/Chromium.app/Contents/MacOS/Chromium","/usr/bin/google-chrome","/usr/bin/chromium","/usr/bin/chromium-browser"].find(existsSync);
  assert.ok(chrome,"Chrome/Chromium is required for the developer workspace check; set CHROME_PATH");
  browser=await chromium.launch({executablePath:chrome,headless:true});
  const page=await browser.newPage();await page.goto(`${origin}/#g/community/ember/cards`);
  await page.locator("#cgrid .ctile").first().waitFor();
  assert.deepEqual(await page.evaluate(()=>DATA.games.map(game=>game.slug)),["ember"],"The hydrated hub displays only the isolated Ember workspace");
  assert.ok(await page.locator("#cgrid .cf-card").count()>0,"A developer can see actual rendered Ember cards");
  await browser.close();browser=null;
  const ember=(await request(origin,"/api/games/ember/ui")).data;assert.ok(ember.cards.length>0);
  assert.match(ember.source_ref,/^[0-9a-f]{40}$/);
  assert.equal(git(app,"rev-parse","HEAD"),appHead);assert.equal(git(app,"status","--porcelain"),appState);
  console.log("  ✓ Real health, hub and card APIs use an isolated Ember-only local workspace despite production environment variables");

  const secondPort=await freePort(),second=start(secondPort,hostileEnvironment),rejected=await waitExit(second);running.delete(second);
  assert.notEqual(rejected.code,0,"A second launcher for this checkout must be refused even on a different port");
  assert.match(second.output,/already has a running development workspace/);
  assert.equal((await request(origin,"/healthz")).data.ok,true,"Rejected second launcher leaves the first server running");
  await assertPortClosed(secondPort);
  console.log("  ✓ Another port cannot bypass the single-workspace lock");

  const owner=(await request(origin,"/api/auth/register",{method:"POST",json:{handle:"launcher-developer",email:"launcher@example.invalid",password:"isolated-test-password"}})).data;
  assert.ok(owner.token,"Developer can register without deployment secrets or invites");
  const created=(await request(origin,"/api/games",{method:"POST",token:owner.token,json:{title:"Developer isolation",license:"proprietary",csv:"name,type,text,cost\nLocal card,unit,Before edit,1\n"}})).data;
  assert.ok(created.slug);const opened=(await request(origin,`/api/games/${created.slug}/ui`,{token:owner.token})).data;
  const cards=structuredClone(opened.cards);cards[0].text="This edit belongs only to the developer's game store.";
  const edited=(await request(origin,`/api/games/${created.slug}/cards`,{method:"PUT",token:owner.token,json:{cards,base_ref:opened.source_ref}})).data;
  assert.equal(edited.saved,true);assert.notEqual(edited.commit,opened.source_ref);
  const gameHead=git(store,"rev-parse","HEAD");assert.equal(gameHead,edited.commit);
  assert.notEqual(gameHead,appHead,"User source has an independent Git history");
  assert.equal(git(app,"rev-parse","HEAD"),appHead,"API game commits do not advance application HEAD");
  assert.equal(git(app,"status","--porcelain"),appState,"API game commits do not dirty application files");
  assert.deepEqual(readFileSync(join(app,"examples","ember","components","cards.json")),sourceCardBytes,"Application example bytes remain unchanged");
  const sentinel=join(runtime,"release-vault","developer-preservation.txt"),sentinelBytes="Existing release-vault data must survive a developer restart.\n";
  writeFileSync(sentinel,sentinelBytes);
  await stop(first);await assertPortClosed(port);assert.equal(existsSync(lock),false,"Graceful stop removes only the launcher lock");
  console.log("  ✓ Creating and editing an owned game changes its source store while application Git stays untouched");

  // Store a synthetic restricted fixture next to existing games. A developer's
  // inherited fixture flags must not expose it when the launcher restarts.
  const fixture=join(store,"examples","_fixtures","hidden-dev-fixture");mkdirSync(dirname(fixture),{recursive:true});
  cpSync(join(store,"examples","ember"),fixture,{recursive:true,filter:path=>!path.split(/[\\/]/).includes("exports")});
  writeFileSync(join(fixture,"game.yaml"),readFileSync(join(fixture,"game.yaml"),"utf8").replace(/^id:.*$/m,"id: hidden-dev-fixture").replace(/^license:.*$/m,"license: proprietary"));
  git(store,"-c","user.name=Developer launcher test","-c","user.email=dev-test@example.invalid","add","examples/_fixtures");
  git(store,"-c","user.name=Developer launcher test","-c","user.email=dev-test@example.invalid","-c","commit.gpgsign=false","-c","core.hooksPath=/dev/null","commit","-qm","Synthetic fixture must stay hidden");
  const preservedHead=git(store,"rev-parse","HEAD");
  const restarted=start(port,hostileEnvironment);await waitReady(restarted,origin);
  const signedIn=(await request(origin,"/api/me",{token:owner.token})).data;assert.equal(signedIn.handle,"launcher-developer","Account and session survive restart");
  const restored=(await request(origin,`/api/games/${created.slug}/ui`,{token:owner.token})).data;
  assert.equal(restored.cards[0].text,cards[0].text,"Authored card edit survives restart");
  assert.equal(git(store,"rev-parse","HEAD"),preservedHead,"Restart does not reseed or commit over existing game history");
  assert.equal(readFileSync(sentinel,"utf8"),sentinelBytes,"Existing release-vault bytes survive restart");
  assert.deepEqual((await request(origin,"/api/games")).data.map(game=>game.slug),["ember"],"Private game and fixture stay out of the anonymous catalog");
  const fixtureResponse=await fetch(`${origin}/api/games/hidden-dev-fixture/ui`);assert.equal(fixtureResponse.status,404,"Inherited private-fixture preview flags are overridden");
  assert.equal(existsSync(wrongState),false);assert.equal(git(app,"rev-parse","HEAD"),appHead);assert.equal(git(app,"status","--porcelain"),appState);
  await stop(restarted);await assertPortClosed(port);assert.equal(existsSync(lock),false);
  console.log("  ✓ Restart preserves accounts, authored source and vault bytes; restricted fixtures stay hidden; shutdown leaves no listener");
  const abandonedLock=JSON.stringify({pid:restarted.child.pid,token:"preserved-after-unexpected-stop"});writeFileSync(lock,abandonedLock);
  const stale=start(port,hostileEnvironment),staleExit=await waitExit(stale);running.delete(stale);
  assert.notEqual(staleExit.code,0,"An abandoned lock requires deliberate recovery before another server can start");
  assert.match(stale.output,/previous launcher stopped unexpectedly/);
  assert.equal(readFileSync(lock,"utf8"),abandonedLock,"An uncertain previous workspace lock is preserved for inspection");
  assert.equal(git(store,"rev-parse","HEAD"),preservedHead);assert.equal(readFileSync(sentinel,"utf8"),sentinelBytes);
  await assertPortClosed(port);
  console.log("  ✓ Unexpected-stop recovery preserves the lock and existing workspace instead of guessing that another server is gone");
  console.log("DEVELOPER LAUNCHER GREEN");
}finally{
  if(browser)await browser.close();
  for(const handle of running){
    try{process.kill(-handle.child.pid,"SIGTERM");}catch{}
    try{await waitExit(handle);}catch{try{process.kill(-handle.child.pid,"SIGKILL");}catch{}}
  }
  rmSync(scratch,{recursive:true,force:true});
}
