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

  // Exercise the Google-hosted sidebar as a user sees it. Apps Script itself is
  // covered by sheets-addon-check.mjs; this browser mock verifies the client
  // state machine without requiring a live Google account in CI.
  const addonPage = await browser.newPage({ viewport: { width: 320, height: 760 } });
  const addonErrors = [];
  addonPage.on("pageerror", error => addonErrors.push(error.message));
  await addonPage.addInitScript(() => {
    let state = { origin:"", game:"", source_id:"sheet:cards=73;printings=-", configured_source_id:"",
      dirty_at:"", has_token:false, user_handle:"", sheet_name:"Cards", spreadsheet_name:"Pilot cards",
      tabs:[{id:73,name:"Cards"},{id:74,name:"Printings"}], tab_mapping:{cards:73,printings:null}, pending_connection:null };
    window.__forgeAddonCalls = [];
    const asyncCall = fn => setTimeout(fn, 0);
    const runner = () => {
      let success = () => {}, failure = () => {};
      const api = {
        withSuccessHandler(fn){ success=fn; return api; },
        withFailureHandler(fn){ failure=fn; return api; },
        getForgeState(){ asyncCall(()=>success(structuredClone(state))); },
        testForgeConnection(input){
          window.__forgeAddonCalls.push({name:"test",input});
          if (/localhost|127\.0\.0\.1/.test(input.origin)) return asyncCall(()=>failure({message:"Google Sheets cannot reach localhost. Use a public HTTPS Forge URL."}));
          const pending={origin:input.origin,game:input.game,cards_tab:Number(input.cards_tab),
            printings_tab:input.printings_tab===""?null:Number(input.printings_tab),verified_at:new Date().toISOString()};
          state={...state,has_token:true,user_handle:"pilot-editor",pending_connection:pending};
          asyncCall(()=>success({state:structuredClone(state),connection:{ok:true,origin:input.origin,game:input.game,
            version:"0.1.0",role:"owner",can_write:true,can_release:true}}));
        },
        saveForgeSettings(input){
          window.__forgeAddonCalls.push({name:"attach",input});
          state={...state,origin:input.origin,game:input.game,configured_source_id:state.source_id,
            has_token:true,user_handle:"pilot-editor",pending_connection:null};
          asyncCall(()=>success({state:structuredClone(state),result:{connected:true,source_mode:"addon"}}));
        },
        getForgePulse(){ asyncCall(()=>success({dirty_at:state.dirty_at,source_id:state.source_id,
          configured_source_id:state.configured_source_id,has_token:state.has_token})); },
        checkForgeCandidate(){ asyncCall(()=>success({state:structuredClone(state),stale_local:false,result:{status:"clean",
          preview:{head_sha:"abcdef1234567890"},counts:{cards:0,modified:0,added:0,removed:0,printings:0},
          changes:[],warnings:[],candidate_cards:[],validation:{ok:true},can_commit:false}})); },
        signOutForge(){ state={...state,has_token:false,user_handle:"",pending_connection:null}; asyncCall(()=>success(structuredClone(state))); },
        detachForgeWorkingCopy(){ state={...state,origin:"",game:"",configured_source_id:"",pending_connection:null}; asyncCall(()=>success({state:structuredClone(state),result:{connected:false}})); },
        commitForgeCandidate(){ asyncCall(()=>failure({message:"No candidate in this UI setup test"})); },
      };
      return api;
    };
    window.google={script:{}};
    Object.defineProperty(window.google.script,"run",{get:runner});
  });
  const addonHtml=readFileSync(join(ROOT,"integrations","google-sheets","Sidebar.html"),"utf8");
  await addonPage.goto(`data:text/html;charset=utf-8,${encodeURIComponent(addonHtml)}`,{waitUntil:"domcontentloaded"});
  await addonPage.getByText("Not checked yet.",{exact:false}).waitFor();
  assert(await addonPage.locator("#attach").isDisabled()
    && await addonPage.getByText(/localhost and private-network URLs cannot work here/).isVisible(),
    "Sheets sidebar prevents an unverified attachment and explains why local Forge is unreachable from Google");
  await addonPage.locator("#origin").fill("http://localhost:4897");
  await addonPage.locator("#game").fill("pilot-game");
  await addonPage.locator("#handle").fill("pilot-editor");
  await addonPage.locator("#password").fill("password123");
  await addonPage.getByRole("button",{name:"Test & sign in"}).click();
  await addonPage.getByText(/cannot reach localhost/).waitFor();
  assert(await addonPage.getByRole("button",{name:"Fix connection"}).isVisible(),
    "a failed endpoint check becomes an in-place recovery path instead of a stuck sidebar");
  await addonPage.locator("#origin").fill("https://forge.example.test");
  await addonPage.getByRole("button",{name:"Test & sign in"}).click();
  await addonPage.getByText(/access confirmed/).waitFor();
  assert(!await addonPage.locator("#attach").isDisabled() && await addonPage.locator("#password").inputValue()==="",
    "successful verification enables attachment and clears the password field");
  await addonPage.getByRole("button",{name:"Attach working copy"}).click();
  await addonPage.getByRole("link",{name:/Open this game in Forge/}).waitFor();
  assert((await addonPage.getByRole("link",{name:/Open this game in Forge/}).getAttribute("href"))
    ==="https://forge.example.test/#g/pilot-game/cards",
    "attached sidebar returns the editor to the exact Forge game");
  await addonPage.getByRole("button",{name:"Connection"}).click();
  await addonPage.getByRole("button",{name:"← Back to candidate"}).click();
  assert(await addonPage.getByRole("button",{name:"Check draft changes"}).isVisible(),
    "connection settings always return to the active candidate");
  assert(addonErrors.length===0,"Sheets sidebar produces no browser errors",addonErrors.join(" | "));
  await addonPage.close();

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
  await page.getByLabel("CSV card data").fill(`Card Key,Card Title,Category,Rules,Energy\nspark-01,Spark,unit,Deal 1 damage.,1\nguard-02,Guard,unit,Prevent 1 damage.,2`);
  assert(await page.getByRole("button", { name: "Review CSV to continue" }).isDisabled(),
    "CSV cannot become a commit before its columns are reviewed");
  await page.getByRole("button", { name: "Review columns" }).click();
  await page.getByText("2 cards ready", { exact: true }).waitFor();
  const mappedTargets=await page.locator("[data-ng-csv-target]").evaluateAll(selects=>selects.map(select=>select.value));
  assert(mappedTargets.join(",")==="id,name,type,text,attributes.energy",
    "unfamiliar CSV headers map visibly to stable IDs, canonical fields, and typed custom data",JSON.stringify(mappedTargets));
  assert(await page.getByText(/Permanent IDs will survive renames/).isVisible()
    && await page.getByRole("button", { name: "Import reviewed cards as first commit" }).isEnabled(),
    "valid mapped CSV exposes its rename safety and enables the exact reviewed commit");
  await page.setViewportSize({width:320,height:844});
  const csvMobile=await page.evaluate(()=>{const modal=document.getElementById("ngModal"),box=modal?.firstElementChild;
    return {page:document.documentElement.scrollWidth,viewport:innerWidth,boxScroll:box?.scrollWidth,boxWidth:box?.clientWidth};});
  assert(csvMobile.page<=csvMobile.viewport&&csvMobile.boxScroll<=csvMobile.boxWidth,
    "reviewed CSV mapping fits a 320px screen without horizontal scrolling",JSON.stringify(csvMobile));
  await page.setViewportSize({width:390,height:844});
  await page.getByLabel("License").selectOption("CC-BY-4.0");
  await page.getByRole("button", { name: "Import reviewed cards as first commit" }).click();
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
  const importedCards=await page.evaluate(async()=>await (await fetch("/api/games/onboarding-smoke-game/cards")).json());
  assert(importedCards[0].id==="spark_01"&&importedCards[0].attributes?.energy===1&&importedCards[1].text==="Prevent 1 damage.",
    "the committed cards exactly match the reviewed mapping and inferred field types",JSON.stringify(importedCards));
  const csvReceipt=JSON.parse(readFileSync(join(gamesRoot,"onboarding-smoke-game","forge","imports","csv.json"),"utf8"));
  assert(csvReceipt.adapter.version===3&&csvReceipt.source.columns[1]==="Card Title"
    &&csvReceipt.promotion.mapping[4].target==="attributes.energy"&&csvReceipt.result.identity_safe,
    "the repository preserves original columns, reviewed mapping, and identity result in its import receipt");
  assert(imported.repository === null, "local projects do not advertise a fake hosted Git remote");

  // The art flow must collect provenance before bytes enter the repository;
  // cancelling the declaration therefore cannot leave an unknown-rights file.
  await page.locator("#pane").getByRole("button", { name: /Edit cards/ }).click();
  await page.getByRole("heading", { name: /Editing cards/ }).waitFor();
  const chooserPromise=page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /Art/ }).click();
  const chooser=await chooserPromise;
  await chooser.setFiles({ name:"spark.png", mimeType:"image/png", buffer:Buffer.concat([
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64"),Buffer.alloc(300)]) });
  await page.getByRole("heading", { name:/Credit the art for Spark/ }).waitFor();
  assert(await page.getByLabel("Artist, creator, or copyright holder").inputValue()==="onboarding-smoke",
    "art onboarding starts with explicit creator credit instead of assuming a license");
  await page.getByLabel(/I confirm this declaration is accurate/).check();
  const artAssigned=page.waitForResponse(response=>response.request().method()==="PUT"&&new URL(response.url()).pathname.endsWith("/art"));
  await page.getByRole("button", { name:"Record rights & continue" }).click();
  assert((await artAssigned).ok(), "art bytes, credit, license, and redistribution are assigned through the browser");
  const artRights=await page.evaluate(async()=>await (await fetch("/api/games/onboarding-smoke-game/rights")).json());
  assert(artRights.publishable && artRights.files.some(file=>file.path==="assets/art/spark_01.png"&&file.copyright.includes("onboarding-smoke")),
    "the uploaded art is release-cleared and credited in the repository rights ledger",JSON.stringify(artRights));

  await page.locator("details.more-tabs summary").click();
  await page.locator("details.more-tabs .repo-menu a").filter({hasText:"Releases"}).click();
  await page.getByText(/^Release readiness/).waitFor();
  assert(await page.getByText("READY", { exact:true }).isVisible()
    && await page.getByRole("button", { name:"Cut this exact release" }).isVisible(),
    "the owner sees a preflighted exact version before starting an expensive release build");

  // An old/API/imported asset can still arrive without rights. The release UI
  // must name it, withhold the release action, and provide the repair path.
  const unknownUpload=await page.evaluate(async(bytes)=>{
    const response=await fetch("/api/games/onboarding-smoke-game/assets?path=assets%2Fart%2Funclassified.png",{
      method:"POST",body:new Uint8Array(bytes)});
    return {status:response.status,body:await response.json()};
  },[...Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64"),Buffer.alloc(300)])]);
  assert(unknownUpload.status===200&&unknownUpload.body.rights_status==="unknown",
    "legacy/imported unknown-rights files remain fail-closed");
  await page.locator("nav.tabs > a").filter({hasText:"Cards"}).click();
  await page.locator("details.more-tabs summary").click();
  await page.locator("details.more-tabs .repo-menu a").filter({hasText:"Releases"}).click();
  await page.getByText("BLOCKED", { exact:true }).waitFor();
  const declareButton=page.getByRole("button", { name:"Declare assets/art/unclassified.png" });
  assert(await declareButton.isVisible() && await page.getByRole("button", { name:"Cut this exact release" }).count()===0,
    "release readiness names the blocking file and withholds the publish action");
  await declareButton.click();
  await page.getByLabel(/I confirm this declaration is accurate/).check();
  await page.getByRole("button", { name:"Record rights & continue" }).click();
  await page.getByText("READY", { exact:true }).waitFor();
  assert(await page.getByRole("button", { name:"Cut this exact release" }).isVisible(),
    "the owner can repair a rights blocker without leaving the release workflow");

  // Build a real Bob proposal through the public contract, then verify the
  // browser presents only the actions each person is authorized to perform.
  const api=async(method,path,token,body)=>{
    const response=await fetch(origin+path,{method,headers:{...(token?{authorization:`Bearer ${token}`}:{ }),
      ...(body?{"content-type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json()};
  };
  const bobRegistration=await api("POST","/api/auth/register",null,{handle:"bob",email:"bob@example.invalid",password:"password123"});
  assert(bobRegistration.status===201&&bobRegistration.data.token,"second pilot participant can create an account");
  const bobToken=bobRegistration.data.token;
  const bobFork=await api("POST","/api/games/onboarding-smoke-game/fork",bobToken,{ref:"HEAD"});
  const bobCards=await api("GET",`/api/games/${bobFork.data.slug}/cards`,bobToken);
  bobCards.data.find(card=>card.id==="spark_01").text="Deal 2 damage after review.";
  const bobEdit=await api("PUT",`/api/games/${bobFork.data.slug}/cards`,bobToken,bobCards.data);
  const bobProposal=await api("POST","/api/games/onboarding-smoke-game/prs",bobToken,{
    from:bobFork.data.slug,title:"Tune Spark after playtest"});
  assert(bobFork.status===201&&bobEdit.status===200&&bobProposal.status===201,
    "the collaborator's independent edition becomes a semantic proposal");

  const proposalUrl=`${origin}/#/g/onboarding-smoke/onboarding-smoke-game/suggestions`;
  await page.goto(proposalUrl,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"View game changes"}).click();
  await page.getByRole("button",{name:"✓ Approve"}).waitFor();
  assert(await page.getByRole("button",{name:"Merge after approval"}).isDisabled()
    && await page.getByRole("button",{name:"✎ Request changes"}).isVisible(),
    "the owner sees review controls while merge stays locked behind approval");

  const bobContext=await browser.newContext({viewport:{width:390,height:844}}),bobPage=await bobContext.newPage();
  await bobPage.goto(origin,{waitUntil:"domcontentloaded"});
  const bobLogin=await bobPage.evaluate(async()=>{
    const response=await fetch("/api/auth/login",{method:"POST",headers:{"content-type":"application/json","x-forge-browser":"1"},
      body:JSON.stringify({handle:"bob",password:"password123"})});return response.status;
  });
  assert(bobLogin===200,"collaborator can sign into an independent browser session");
  await bobPage.goto(proposalUrl,{waitUntil:"domcontentloaded"});
  await bobPage.getByRole("button",{name:"View game changes"}).click();
  await bobPage.getByText(/A maintainer must review it/).waitFor();
  assert(await bobPage.getByRole("button",{name:"Close"}).isVisible()
    && await bobPage.getByRole("button",{name:/Approve|Merge/}).count()===0,
    "the proposer sees close and discussion, never unauthorized approve or merge controls");

  await page.getByRole("button",{name:"✓ Approve"}).click();
  const mergeButton=page.getByRole("button",{name:/Merge — commits as bob/});
  await mergeButton.waitFor();
  const mergeResponse=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname.endsWith(`/prs/${bobProposal.data.id}/merge`));
  await mergeButton.click();
  assert((await mergeResponse).ok(),"the owner approves and merges the visual proposal through the browser");
  const mergedCards=await api("GET","/api/games/onboarding-smoke-game/cards",null);
  assert(mergedCards.data.find(card=>card.id==="spark_01").text==="Deal 2 damage after review.",
    "the accepted browser proposal lands exactly and preserves the collaborator's authored content");
  await bobContext.close();

  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: /Portable source project/ }).waitFor();
  const overviewText=await page.locator("body").innerText();
  assert(!overviewText.includes("forge.example") && overviewText.includes("does not trap the project"),
    "project overview proves source portability without placeholder clone commands");
  const sourceAfter={head:sourceGit(["rev-parse","HEAD"]),status:sourceGit(["status","--porcelain"])};
  assert(sourceAfter.head===sourceBefore.head && sourceAfter.status===sourceBefore.status,
    "mutating browser smoke leaves the source checkout untouched");
  assert(errors.length === 0, "Explore produces no browser errors", errors.join(" | "));

  console.log("\nUI SMOKE GREEN — onboarding, CSV/art rights, two-person review, release readiness, portability, narrow layout, and discovery verified.");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
  await Promise.race([
    new Promise(resolveExit => server.once("exit", resolveExit)),
    new Promise(resolveWait => setTimeout(resolveWait, 2000)),
  ]);
  rmSync(scratch, { recursive: true, force: true });
}
