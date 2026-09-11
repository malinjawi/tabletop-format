#!/usr/bin/env node
/** Browser fault coverage for the actual connector and game-creation functions.
 * The disposable HTTP server controls outcomes; no Google account or game store
 * is touched. API/protocol tests separately cover the Sheets merge contract. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright-core";

const template=readFileSync(new URL("./hub_template.html",import.meta.url),"utf8");
const between=(start,end)=>{
  const a=template.indexOf(start),b=template.indexOf(end,a);
  assert.ok(a>=0&&b>a,`Missing actual UI functions: ${start}`);
  return template.slice(a,b);
};
const connector=between("async function liveSync(slug)","function cards(g, mode)");
const creation=between("async function ngSubmit(close)","/* ---------- Build the test:");
const esc=template.match(/^const esc = .*$/m)?.[0];
assert.ok(esc,"Use Forge's actual HTML escaping behavior");
const script=`const $=s=>document.querySelector(s);${esc}
const LIVE=true;let ME={handle:'writer'};const authHdr=()=>({'content-type':'application/json'});
const G=()=>({cards:[],printings:[]});const NG_CSV_PREVIEW=null;
function chgHtml(change){return '<div>'+esc(change.kind)+'</div>';}
window.notices=[];function toast(text){notices.push(text);document.querySelector('#notice').innerHTML=text;}
${connector}\n${creation}
if(location.hash.includes('/cards')){document.querySelector('#creation').remove();liveSync('ux-sheet');}
else document.querySelector('#ng-ok').onclick=()=>ngSubmit(()=>document.querySelector('#creation').remove());`;
const html=`<!doctype html><html><head><meta charset="utf-8"><style>
body{font:16px system-ui;margin:20px}.box{border:1px solid #bbb}.bh,.bb{padding:12px}button{padding:9px}
</style></head><body><div id="notice" role="status"></div><div id="pane"></div>
<div id="creation"><div id="ngErr"></div><input name="ng-mode" type="radio" value="sheet" checked>
<input id="ng-title" value="Connector test"><input id="ng-spark"><input id="ng-experience"><input id="ng-mvp"><input id="ng-question">
<select id="ng-license"><option value="proprietary">Private</option></select><input id="ng-sheet" aria-label="New Sheet URL">
<button id="ng-ok">Create game and connect Sheet</button></div><script>${script}</script></body></html>`;
const chrome=process.env.CHROME_PATH||[
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome","/usr/bin/chromium","/usr/bin/chromium-browser",
].find(existsSync);
assert.ok(chrome,"Chrome/Chromium is required; set CHROME_PATH");
const sha="1".repeat(40),source="2".repeat(64),sheetUrl="https://docs.google.com/spreadsheets/d/fixture/edit#gid=0";
let state,requests=[];
function reset(extra={}){requests=[];state={canWrite:true,connected:false,source_mode:"published",attachStatus:200,detachStatus:200,pullStatus:200,pullData:{dry:true,changes:[],printing_changes:[],conflicts:[],preview:{head_sha:sha,source_hash:source},validation:{ok:true},can_commit:true},...extra};}
reset();
const server=createServer(async(req,res)=>{
  let body="";for await(const chunk of req)body+=chunk;
  const url=new URL(req.url,"http://localhost");requests.push({method:req.method,path:url.pathname,query:url.search,body});
  const json=(status,data)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(data));};
  if(url.pathname==="/api/games/ux-sheet/access")return json(200,{canWrite:state.canWrite,authed:true});
  if(url.pathname==="/api/games/ux-sheet/sync")return json(200,{connected:state.connected,source_mode:state.source_mode,url:sheetUrl});
  if(url.pathname==="/api/games/ux-sheet/sync/sheet"){
    if(req.method==="PUT"){
      if(state.attachStatus===200){state.connected=true;return json(200,{connected:true,cards:3,identity_safe:true});}
      return json(state.attachStatus,{error:'Published tab is unavailable <check sharing>'});
    }
    if(state.detachStatus===200){state.connected=false;return json(200,{connected:false});}
    return json(state.detachStatus,{error:"Disconnect failed; retry later"});
  }
  if(url.pathname==="/api/games/ux-sheet/sync/pull")return json(state.pullStatus,state.pullData);
  if(url.pathname==="/api/games"&&req.method==="POST")return json(201,{slug:"ux-sheet",url:"#/g/ux-sheet",cards:0});
  res.writeHead(200,{"content-type":"text/html"});res.end(html);
});
let browser;
try{
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:chrome,headless:true});
  const context=await browser.newContext({viewport:{width:1024,height:900}}),page=await context.newPage();
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  let visit=0;
  const loadCards=async()=>{await page.goto(`${origin}/?visit=${++visit}#g/ux-sheet/cards`);await page.locator("#sync-box").waitFor();};
  const openSetup=async()=>{await page.getByText("Connect Google Sheets",{exact:true}).click();};
  const connect=async()=>{await page.getByLabel("Published Google Sheet URL").fill(sheetUrl);await page.getByRole("button",{name:"Connect Sheet",exact:true}).click();};
  await loadCards();
  assert.equal(await page.getByLabel("Published Google Sheet URL").isVisible(),false,"Optional connector setup starts collapsed");
  await openSetup();await page.getByRole("button",{name:"Connect Sheet",exact:true}).click();
  await page.getByText("Enter the published Google Sheet URL.",{exact:true}).waitFor();
  state.attachStatus=422;await connect();
  await page.getByText("Published tab is unavailable <check sharing>",{exact:true}).waitFor();
  assert.equal(await page.locator("#sync-out check").count(),0,"Response text is escaped");
  assert.equal(await page.getByRole("button",{name:"Connect Sheet",exact:true}).isEnabled(),true,"Failed connection can be corrected");
  assert.deepEqual(await page.evaluate(()=>notices),[],"Failed attachment does not announce success");
  state.attachStatus=200;await connect();await page.getByText("Google Sheets connected",{exact:true}).waitFor();
  assert.match(await page.locator("#sync-box").innerText(),/3 cards read; review the changes before committing/);
  assert.equal(requests.filter(r=>r.path.endsWith("/sync/pull")).length,0,"Connecting never commits unreviewed cards");
  console.log("  ✓ Optional setup stays quiet; attachment failures remain visible; connection requires a separate review");

  await page.getByText("Connection details",{exact:true}).click();state.detachStatus=500;
  await page.getByRole("button",{name:"Disconnect Sheet",exact:true}).click();
  await page.getByText("Disconnect failed; retry later",{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>notices),[],"Rejected disconnect cannot announce success");
  await page.route("**/sync/sheet",route=>route.abort("failed"));
  await page.getByRole("button",{name:"Disconnect Sheet",exact:true}).click();
  await page.getByText("Could not confirm disconnection. Refresh its status before trying again.",{exact:true}).waitFor();
  await page.unroute("**/sync/sheet");
  await page.getByRole("button",{name:"Refresh connection status",exact:true}).click();
  await page.getByText("Google Sheets connected",{exact:true}).waitFor();
  assert.equal(state.connected,true);
  console.log("  ✓ Rejected and interrupted disconnects preserve truthful recovery");

  state.pullStatus=502;state.pullData={error:"Could not read the Sheet"};
  await page.getByRole("button",{name:"Review Sheet changes",exact:true}).click();
  await page.getByText("Could not read the Sheet",{exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Commit reviewed changes",exact:true}).count(),0);
  assert.equal(await page.getByRole("button",{name:"Review again",exact:true}).isEnabled(),true);
  state.pullStatus=200;state.pullData={dry:true,changes:[{kind:"added",card:"new-card"}],printing_changes:[],conflicts:[],preview:{head_sha:sha,source_hash:source},validation:{ok:true},counts:{cards:1,added:1},can_commit:true};
  await page.getByRole("button",{name:"Review again",exact:true}).click();
  await page.getByRole("button",{name:"Commit reviewed changes",exact:true}).waitFor();
  state.pullStatus=409;state.pullData={error:"Forge changed after review",stale:"forge"};
  await page.getByRole("button",{name:"Commit reviewed changes",exact:true}).click();
  await page.getByText("Forge changed after review",{exact:true}).waitFor();
  const attempt=requests.filter(r=>r.path.endsWith("/sync/pull")&&!r.query).at(-1);
  assert.equal(JSON.parse(attempt.body).preview.head_sha,sha,"Commit carries the exact reviewed Forge version");
  assert.equal(JSON.parse(attempt.body).preview.source_hash,source,"Commit carries the exact reviewed Sheet bytes");
  assert.equal(await page.getByRole("button",{name:"Commit reviewed changes",exact:true}).count(),0,"Stale review cannot be re-committed");
  assert.deepEqual(await page.evaluate(()=>notices),[],"Failed review or commit cannot announce success");
  await page.route("**/sync/pull*",route=>route.abort("failed"));
  await page.getByRole("button",{name:"Review again",exact:true}).click();
  await page.getByText("Could not complete the Sheet review. Check your connection and try again.",{exact:true}).waitFor();
  await page.unroute("**/sync/pull*");
  state.pullStatus=200;state.pullData={dry:true,changes:[{kind:"added",card:"new-card"}],printing_changes:[],conflicts:[],preview:{head_sha:sha,source_hash:source},validation:{ok:true},counts:{cards:1,added:1},can_commit:true};
  await page.getByRole("button",{name:"Review again",exact:true}).click();
  await page.getByRole("button",{name:"Commit reviewed changes",exact:true}).waitFor();
  await page.route("**/sync/pull",route=>route.abort("failed"));
  await page.getByRole("button",{name:"Commit reviewed changes",exact:true}).click();
  await page.getByText("Could not confirm whether the changes were committed. Reload Cards to check the latest version before trying again.",{exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Reload Cards",exact:true}).isVisible(),true,"An uncertain commit tells the user to check actual state, without blindly retrying writes");
  assert.equal(await page.getByRole("button",{name:"Commit reviewed changes",exact:true}).count(),0);
  assert.deepEqual(await page.evaluate(()=>notices),[],"An interrupted commit cannot announce success");
  await page.unroute("**/sync/pull");
  console.log("  ✓ Review and commit failures keep exact-version protection and actionable next steps");

  reset({connected:true,source_mode:"addon"});await loadCards();
  assert.match(await page.locator("#sync-box").innerText(),/Extensions → Forge → Open candidate panel/);
  assert.equal(await page.getByRole("button",{name:"Review Sheet changes",exact:true}).count(),0,"Private add-on connection points to the actual active Sheet workflow");
  assert.equal(await page.locator("#sync-box button:disabled").count(),0,"Add-on guidance is not a disabled fake action");
  reset({canWrite:false,connected:true});await Promise.all([
    page.waitForResponse(response=>response.url().endsWith("/access")),
    page.goto(`${origin}/?visit=${++visit}#g/ux-sheet/cards`),
  ]);
  assert.equal(await page.locator("#sync-box").count(),0,"Read-only users see no connector write controls");
  assert.equal(requests.filter(r=>r.path.endsWith("/sync")).length,0,"Read-only view does not request private connection details");
  console.log("  ✓ Add-on and read-only states show only actions that are available");

  for(const fail of [false,true]){
    reset({attachStatus:fail?422:200});await page.goto(`${origin}/new`);
    await page.evaluate(()=>sessionStorage.clear());
    await page.getByLabel("New Sheet URL").fill(sheetUrl);
    await page.getByRole("button",{name:"Create game and connect Sheet",exact:true}).click();
    await page.waitForFunction(()=>notices.length===1);
    const notice=await page.locator("#notice").innerText();
    assert.equal((await page.evaluate(()=>notices)).length,1,"Creation emits one truthful outcome, without overwriting errors");
    if(fail){assert.match(notice,/Game created\. The Sheet could not connect/);assert.doesNotMatch(notice,/Sheet connected/);}
    else assert.match(notice,/Game created and Sheet connected\. Review Sheet changes/);
    await page.waitForURL(url=>url.hash.includes("/cards"));await page.locator("#sync-box").waitFor();
    if(fail){
      assert.match(await page.locator("#sync-box").innerText(),/The Sheet could not connect/);
      assert.equal(await page.getByLabel("Published Google Sheet URL").inputValue(),sheetUrl,"Failed setup retains the source URL after navigation");
      assert.equal(await page.getByLabel("Published Google Sheet URL").isVisible(),true,"Failed setup opens the recovery form");
    }else assert.equal(await page.getByRole("button",{name:"Review Sheet changes",exact:true}).isVisible(),true);
    assert.equal(requests.filter(r=>r.path==="/api/games"&&r.method==="POST").length,1,"Recovery never duplicates the created game");
    assert.equal(requests.filter(r=>r.path.endsWith("/sync/pull")).length,0,"Creation never attempts an unreviewed first commit");
    // A collaborator can change the connection after this tab stores its setup
    // outcome. The newly fetched state must supersede that older local message.
    state.connected=fail;await loadCards();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem("forge:sheet-setup:ux-sheet")),null,"Contradictory setup outcome is removed from this session");
    if(fail){
      assert.equal(await page.getByText("Google Sheets connected",{exact:true}).isVisible(),true);
      assert.doesNotMatch(await page.locator("#sync-box").innerText(),/The Sheet could not connect/);
    }else{
      assert.equal(await page.getByText("Connect Google Sheets",{exact:true}).isVisible(),true);
      assert.equal(await page.getByLabel("Published Google Sheet URL").isVisible(),false,"Externally disconnected setup returns to the optional collapsed state");
      assert.doesNotMatch(await page.locator("#sync-box").innerText(),/Game created and Sheet connected/);
    }
  }
  assert.deepEqual(errors,[],"Connector workflows have no unhandled browser errors");
  console.log("  ✓ Creation preserves success or partial failure across navigation and never duplicates the game or commits unreviewed cards");
  console.log("  ✓ Fresh connection state clears obsolete success and failure notices from this browser session");
  console.log("SHEETS CONNECTOR BROWSER GREEN");
  await context.close();
}finally{if(browser)await browser.close();server.close();await once(server,"close");}
