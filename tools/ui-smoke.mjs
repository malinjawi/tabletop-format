#!/usr/bin/env node
/** Launch-level browser smoke: lazy shell, topics, narrow layouts, and touch size. */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { DatabaseSync } from "node:sqlite";
import { readZip } from "./lib/deterministic-zip.mjs";

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
const PYTHON=process.env.FORGE_PYTHON||(existsSync(join(ROOT,".venv","bin","python"))?join(ROOT,".venv","bin","python"):"python3");
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
  [join(ROOT, "examples", "_fixtures", "netrunner-sg"), join(gamesRoot, "_fixtures", "netrunner-sg")],
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
    LOCAL_STORE_ROOT: storeRoot, FORGE_PUBLIC_ORIGIN: origin, FORGE_REGISTRATION_MODE: "open", FORGE_RATE_MAX: "1000",
    FORGE_INCLUDE_TEST_FIXTURES: "1" },
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
  const fixtureOwner = new DatabaseSync(join(scratch, "platform.db"));
  fixtureOwner.prepare(`UPDATE games SET owner_id =
    (SELECT id FROM users WHERE handle = 'onboarding-smoke') WHERE slug = 'netrunner-sg'`).run();
  fixtureOwner.close();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Bring or start a game" }).click();
  assert(await page.getByRole("radio", { name: /Start from an idea/ }).isChecked(),
    "new game opens on the guided idea path");
  await page.getByRole("radio", { name: /Import CSV/ }).check();
  assert(await page.getByLabel("CSV card data").isVisible() && !await page.getByLabel("What should players feel?").isVisible(),
    "CSV path shows only import-relevant fields");
  const candidateWorkbook=join(scratch,"existing-designer-workbook.xlsx");
  const candidateBuild=spawnSync(PYTHON,["-c",String.raw`
from openpyxl import Workbook
import sys
w=Workbook();w.active.title="Notes";w.active.append(["Prototype notes"]);w.active.append(["Keep this workbook"])
s=w.create_sheet("Card Pool");s.append(["Card Key","Card Title","Category","Rules","Energy"]);s.append(["spark-01","Spark","unit","Deal 1 damage.",1]);s.append(["guard-02","Guard","unit","Prevent 1 damage.",2]);w.save(sys.argv[1])
`,candidateWorkbook],{encoding:"utf8"});
  assert(candidateBuild.status===0,"ordinary XLSX onboarding fixture is available",candidateBuild.stderr);
  const candidateChooserPromise=page.waitForEvent("filechooser");
  await page.getByText("Upload CSV / XLSX",{exact:false}).click();
  const candidateChooser=await candidateChooserPromise;await candidateChooser.setFiles(candidateWorkbook);
  await page.getByLabel("Workbook card tab").waitFor();
  assert(await page.getByLabel("Workbook card tab").inputValue()==="Card Pool"
    && (await page.getByLabel("CSV card data").inputValue()).includes("spark-01,Spark"),
    "ordinary Excel/LibreOffice onboarding chooses the card-like tab without manual CSV conversion");
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

  await page.goto(`${origin}/#g/netrunner-sg/design`, { waitUntil:"domcontentloaded" });
  await page.getByRole("heading", { name:"Design once. Review every card. Ship the exact version." }).waitFor();
  assert(await page.getByRole("button", { name:"Open Forge Studio" }).first().isVisible()
    && await page.getByText("Keep your existing tools", { exact:true }).isVisible(),
    "Design starts with a visible choice between Forge Studio and an external working copy");
  assert(await page.getByText("Excel · LibreOffice · Dextrous · Component Studio · Sheets", { exact:true }).isVisible()
    && await page.getByRole("button", { name:"Excel / LibreOffice" }).isVisible()
    && await page.getByRole("button", { name:"Cards CSV" }).isVisible()
    && await page.getByRole("button", { name:"Return XLSX / CSV / ZIP" }).first().isVisible(),
    "Excel, LibreOffice, Dextrous, Component Studio, and Sheets share an explicit data round-trip path");
  const squibTool=page.locator(".design-tool").filter({hasText:"Squib"});
  assert(await squibTool.getByText("Squib",{exact:true}).isVisible()
    && await squibTool.getByRole("button",{name:"Download"}).isVisible()
    && await squibTool.getByRole("button",{name:"Return"}).isVisible(),
    "Squib is a first-class external working-copy path with an explicit return action");
  const squibDownloadPromise=page.waitForEvent("download");
  await squibTool.getByRole("button",{name:"Download"}).click();
  const squibDownload=await squibDownloadPromise,squibPath=await squibDownload.path();
  assert(squibDownload.suggestedFilename()==="netrunner-sg-squib-v1.zip","one click downloads the version-pinned Squib kit");
  const squibChooserPromise=page.waitForEvent("filechooser");
  await squibTool.getByRole("button",{name:"Return"}).click();
  const squibChooser=await squibChooserPromise;await squibChooser.setFiles(squibPath);
  await page.getByRole("heading",{name:"Review Squib working copy"}).waitFor();
  assert(await page.getByText("RUBY NOT EXECUTED",{exact:false}).isVisible()
    && await page.getByText("This Squib working copy already matches Forge.",{exact:false}).isVisible(),
    "a returned Squib kit opens a no-write review and states the code-execution boundary");
  await page.getByRole("button",{name:"× Close"}).click();
  const workbookDownloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Excel / LibreOffice"}).click();
  const workbookDownload=await workbookDownloadPromise,workbookPath=join(scratch,"netrunner-ui-return.xlsx");
  cpSync(await workbookDownload.path(),workbookPath);
  assert(workbookDownload.suggestedFilename()==="netrunner-sg-data-v3.xlsx","one click downloads the traced workbook");
  const workbookEdit=spawnSync(PYTHON,["-c",String.raw`
from openpyxl import load_workbook
import sys
p=sys.argv[1];w=load_workbook(p);ws=w["cards"]
headers=[cell.value for cell in ws[1]];i=headers.index("id")+1;j=headers.index("name")+1
for row in range(2,ws.max_row+1):
    if ws.cell(row,i).value=="buzzsaw": ws.cell(row,j).value="Buzzsaw Workbook Browser Return";break
w.save(p)
`,workbookPath],{encoding:"utf8"});
  assert(workbookEdit.status===0,"browser workbook fixture can be edited with the production adapter",workbookEdit.stderr);
  const workbookChooserPromise=page.waitForEvent("filechooser");
  await page.getByRole("button",{name:"Return XLSX / CSV / ZIP"}).first().click();
  const workbookChooser=await workbookChooserPromise;
  await workbookChooser.setFiles(workbookPath);
  await page.getByRole("heading",{name:"Review external table changes"}).waitFor();
  assert(await page.getByText("Buzzsaw Workbook Browser Return",{exact:true}).first().isVisible()
    && await page.getByText("Rendered impact",{exact:true}).isVisible(),
    "a returned workbook recovers its Git baseline and opens the normal rendered dry run");
  await page.getByRole("button",{name:"× Close"}).click();
  const tableDownloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Cards CSV"}).click();
  const tableDownload=await tableDownloadPromise;
  assert(tableDownload.suggestedFilename()==="cards.csv"
    && await page.evaluate(()=>!!localStorage.getItem("forge:data-base:netrunner-sg")),
    "one click downloads a direct cards.csv and remembers its exact Git baseline");
  const returnedTable=readFileSync(await tableDownload.path(),"utf8").replace(",Buzzsaw,",",Buzzsaw Browser Return,");
  const tableChooserPromise=page.waitForEvent("filechooser");
  await page.getByRole("button",{name:"Return XLSX / CSV / ZIP"}).first().click();
  const tableChooser=await tableChooserPromise;
  await tableChooser.setFiles({name:"cards.csv",mimeType:"text/csv",buffer:Buffer.from(returnedTable)});
  await page.getByRole("heading",{name:"Review external table changes"}).waitFor();
  assert(await page.getByText("Buzzsaw Browser Return",{exact:true}).first().isVisible()
    && await page.getByText("Rendered impact",{exact:true}).isVisible(),
    "a returned editor CSV opens a semantic and rendered dry run before any commit");
  await page.getByRole("button",{name:"× Close"}).click();
  await page.getByRole("button", { name:"Open Forge Studio" }).first().click();
  await page.getByText("Edit the card, not the template", { exact:true }).waitFor();
  assert(await page.getByRole("button", { name:"Content", exact:true }).isVisible()
    && await page.getByRole("button", { name:"Layout", exact:true }).isVisible()
    && await page.getByLabel("Name", { exact:true }).isVisible(),
    "Forge Studio presents card content and shared layout as one component workspace");
  await page.getByRole("button", { name:"Table", exact:true }).click();
  await page.getByRole("heading", { name:/Edit .* cards as a table/ }).waitFor();
  const studioRowsBefore=await page.locator("#des-data-rows tr[data-card]").count();
  assert(studioRowsBefore>0
    && await page.getByRole("columnheader", { name:"Permanent ID", exact:true }).isVisible()
    && await page.getByLabel("Filter component table", { exact:true }).isVisible(),
    "Studio exposes a deck-scale component table while keeping permanent IDs visible");
  const gridOriginal=await page.evaluate(()=>desFamilyCards(G(DES.slug)).slice(0,3).map(card=>({id:card.id,name:card.name,subtypes:(card.subtypes||[]).join(", ")})));
  await page.locator("[data-grid-select]").nth(1).check();
  await page.locator("[data-grid-select]").nth(2).check();
  const firstGridName=page.locator('[data-grid-cell][data-col="0"]').first();
  await firstGridName.focus();
  assert((await page.locator("#des-grid-selection").textContent())==="3 rows selected"
    && await page.getByRole("button",{name:"Fill down",exact:true}).isEnabled(),
    "the bulk table supports explicit multi-row selection and identifies the active source column");
  await page.getByRole("button",{name:"Fill down",exact:true}).click();
  assert((await page.locator('[data-grid-cell][data-col="0"]').evaluateAll(inputs=>inputs.slice(0,3).map(input=>input.value))).every(value=>value===gridOriginal[0].name),
    "Fill down copies the focused cell across selected card rows as one local draft");
  const pasteGrid=async (locator,text)=>locator.evaluate((input,value)=>{const transfer=new DataTransfer();transfer.setData("text/plain",value);input.dispatchEvent(new ClipboardEvent("paste",{clipboardData:transfer,bubbles:true,cancelable:true}));},text);
  await pasteGrid(page.locator('[data-grid-cell][data-col="0"]').first(),gridOriginal.map(card=>card.name).join("\n"));
  await pasteGrid(page.locator('[data-grid-cell][data-col="0"]').first(),"Grid Alpha\tPrototype, Event\nGrid Beta\tPrototype, Resource");
  const pastedGrid=await page.evaluate(()=>DES.gridSelection.map(id=>{const card=DES.cards.find(item=>item.id===id);return{name:card.name,subtypes:card.subtypes};}));
  assert(pastedGrid.length===2&&pastedGrid[0].name==="Grid Alpha"&&pastedGrid[1].subtypes.join(", ")==="Prototype, Resource",
    "a Sheets-style row-and-column paste is parsed and applied to typed card fields atomically",JSON.stringify(pastedGrid));
  await pasteGrid(page.locator('[data-grid-cell][data-col="0"]').first(),gridOriginal.slice(0,2).map(card=>`${card.name}\t${card.subtypes}`).join("\n"));
  const invalidPasteBefore=await page.evaluate(id=>{const card=DES.cards.find(item=>item.id===id);return{keywords:card.keywords,deck_limit:card.deck_limit};},gridOriginal[0].id);
  await pasteGrid(page.locator('[data-grid-cell][data-col="3"]').first(),"should-not-stick\tnot-a-number");
  const invalidPasteAfter=await page.evaluate(id=>{const card=DES.cards.find(item=>item.id===id);return{keywords:card.keywords,deck_limit:card.deck_limit};},gridOriginal[0].id);
  assert(JSON.stringify(invalidPasteAfter)===JSON.stringify(invalidPasteBefore),
    "an invalid typed cell rejects the entire spreadsheet paste without partial card edits",JSON.stringify(invalidPasteAfter));
  const multilineContract=await page.evaluate(()=>{DES.gridSelection=[DES.gridSelection[0]];desGridUpdateSelectionUi();const input=document.querySelector('[data-grid-cell][data-col="2"]');let prevented=false;const accepted=desGridPaste({clipboardData:{getData:()=>"First paragraph\nSecond paragraph"},preventDefault(){prevented=true;}},input);return{accepted,prevented};});
  assert(multilineContract.accepted===true&&!multilineContract.prevented,
    "ordinary multiline rules text remains a one-cell paste unless multiple rows are explicitly selected",JSON.stringify(multilineContract));
  const firstGridId=gridOriginal[0].id,secondGridId=gridOriginal[1].id;
  await page.locator(`[data-grid-cell][data-card="${encodeURIComponent(firstGridId)}"][data-col="0"]`).focus();
  await page.locator(`[data-grid-cell][data-card="${encodeURIComponent(firstGridId)}"][data-col="0"]`).press("Enter");
  const downCard=await page.evaluate(()=>decodeURIComponent(document.activeElement?.dataset?.card||""));
  await page.locator(`[data-grid-cell][data-card="${encodeURIComponent(secondGridId)}"][data-col="0"]`).press("Shift+Enter");
  const upCard=await page.evaluate(()=>decodeURIComponent(document.activeElement?.dataset?.card||""));
  assert(downCard===secondGridId&&upCard===firstGridId,
    "Enter and Shift+Enter provide spreadsheet-style vertical keyboard navigation without making IDs editable");
  await page.getByRole("button", { name:"Duplicate active card", exact:true }).click();
  const studioRowsAfter=await page.locator("#des-data-rows tr[data-card]").count();
  assert(studioRowsAfter===studioRowsBefore+1
    && (await page.locator("#des-grid-status").textContent()).includes("1 card draft"),
    "one action duplicates the selected card and its production printing as an uncommitted component draft");
  await page.getByRole("button", { name:"× Close", exact:true }).click();
  assert(await page.getByText("Production printing", { exact:true }).isVisible()
    && await page.getByRole("button", { name:"Choose library", exact:true }).isVisible()
    && await page.getByRole("button", { name:"Upload new", exact:true }).isVisible(),
    "the selected card exposes its physical printing and reusable artwork workflow inside Studio");
  const studioArtChooserPromise=page.waitForEvent("filechooser");
  await page.getByRole("button", { name:"Upload new", exact:true }).click();
  const studioArtChooser=await studioArtChooserPromise;
  await studioArtChooser.setFiles({name:"studio-art.png",mimeType:"image/png",buffer:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64")});
  await page.getByRole("heading",{name:/Credit the art for/}).waitFor();
  await page.getByLabel(/I confirm this declaration is accurate/).check();
  await page.getByRole("button",{name:"Record rights & continue"}).click();
  await page.getByText(/New file staged/).waitFor();
  const verticalFocus=page.getByLabel("Vertical focus");
  await verticalFocus.fill("0.67");
  assert((await page.locator(".forge-studio-status").textContent()).includes("1 art file")
    && await page.getByText(/rights included in review/).isVisible(),
    "art bytes, credit, and non-destructive crop stay local until the combined review");
  const artBatch=await page.evaluate(()=>{const current=desCard(),other=desFamilyCards(G(DES.slug)).find(card=>card.id!==current.id);DES.gridSelection=[current.id,other.id];return{cards:DES.gridSelection,current:desSelectedPrinting(current)?.id,other:desSelectedPrinting(other)?.id};});
  await page.getByRole("button",{name:"Choose library",exact:true}).click();
  await page.getByRole("heading",{name:"Reuse art across exact printings"}).waitFor();
  await page.getByRole("button",{name:"Selected table cards (2)",exact:true}).click();
  await page.getByText("2 printings selected",{exact:true}).waitFor();
  let stagedArt=page.locator(".forge-art-item").filter({hasText:"staged"}).first();
  await stagedArt.getByLabel(/Tags for/).fill("Portrait, Cyberpunk");
  await stagedArt.getByRole("button",{name:"Save",exact:true}).click();
  stagedArt=page.locator(".forge-art-item").filter({hasText:"staged"}).first();
  assert(await stagedArt.getByText("portrait",{exact:true}).isVisible()
    && await page.getByText("tag changes staged",{exact:false}).isVisible(),
    "project artwork gets portable, versioned search tags instead of browser-only folders");
  await stagedArt.getByRole("button",{name:"Use on 2",exact:true}).click();
  const artAssignment=await page.evaluate(ids=>{const printings=ids.map(id=>DES.printings.find(printing=>printing.id===id));return{paths:printings.map(printing=>printing?.art),artists:printings.map(printing=>printing?.artist),tags:DES.artLibrary.assets};},[artBatch.current,artBatch.other]);
  assert(artAssignment.paths[0]&&artAssignment.paths[0]===artAssignment.paths[1]
    && artAssignment.artists[0]&&artAssignment.artists.every(artist=>artist===artAssignment.artists[0])
    && artAssignment.tags.some(record=>record.path===artAssignment.paths[0]&&record.tags.join(",")==="portrait,cyberpunk"),
    "one explicit target set batch-assigns the same versioned art and credit without flattening per-printing data",JSON.stringify(artAssignment));
  await page.getByRole("button",{name:"Layout",exact:true}).click();
  const alignPair=await page.evaluate(()=>{const regions=DES.layout.regions||[];for(const first of regions)for(const second of regions)if(first.id!==second.id&&Math.abs(Number(first.x||0)-Number(second.x||0))>.5)return[first.id,second.id];return regions.slice(0,2).map(region=>region.id);});
  await page.evaluate(ids=>{desSelectRegion(ids[0]);desSelectRegion(ids[1],{toggle:true});},alignPair);
  await page.getByText("2 elements selected",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Align left",exact:true}).click();
  const aligned=await page.evaluate(ids=>ids.map(id=>DES.layout.regions.find(region=>region.id===id)?.x),alignPair);
  assert(aligned[0]===aligned[1]
    && await page.getByText("Moves as one selection",{exact:true}).isVisible(),
    "multi-select alignment edits shared production geometry as one undoable layout change",JSON.stringify(aligned));
  await page.getByPlaceholder("e.g. title lockup").fill("production lockup");
  await page.getByRole("button",{name:"Create",exact:true}).click();
  const grouped=await page.evaluate(ids=>({selected:desSelectionIds(),groups:ids.map(id=>desRegion(id)?.group)}),alignPair);
  assert(grouped.groups.every(group=>group==="production_lockup")&&grouped.selected.length===2,
    "a multi-selection becomes a persistent named group instead of disappearing after the browser session",JSON.stringify(grouped));
  const effectRegionId=await page.evaluate(()=>DES.layout.regions.find(region=>region.type!=="rect")?.id);
  await page.evaluate(id=>desSelectRegion(id,{individual:true}),effectRegionId);
  await page.getByLabel("Enable border",{exact:true}).check();
  await page.getByLabel("Border width",{exact:true}).fill("0.45");
  await page.getByLabel("Border width",{exact:true}).press("Tab");
  await page.getByLabel("Enable shadow",{exact:true}).check();
  await page.getByLabel("Shadow blur",{exact:true}).fill("1.75");
  await page.getByLabel("Shadow blur",{exact:true}).press("Tab");
  const productionEffects=await page.evaluate(id=>{const region=desRegion(id);return{border:region?.border,shadow:region?.shadow_spec,rendered:layPosCss(region)};},effectRegionId);
  assert(productionEffects.border?.width_mm===0.45
    &&productionEffects.shadow?.blur_mm===1.75&&productionEffects.rendered.includes("border:0.45mm solid #111111")&&productionEffects.rendered.includes("box-shadow:"),
    "structured border and shadow controls update the production renderer without raw YAML",JSON.stringify(productionEffects));
  const typographyIds=await page.evaluate(()=>(DES.layout.regions||[]).filter(region=>["text","richtext","body","badge","pips"].includes(region.type)).slice(0,2).map(region=>region.id));
  assert(typographyIds.length===2,"the production family exposes at least two reusable typography targets",JSON.stringify(typographyIds));
  await page.evaluate(id=>desSelectRegion(id,{individual:true}),typographyIds[0]);
  await page.getByLabel("Reusable text style",{exact:true}).selectOption("__new__");
  await page.locator("#des-new-text-style").fill("Card title");
  await page.locator("#des-new-text-style + button").click();
  const styleSize=page.getByLabel("Size (pt)",{exact:true});
  const originalStyleSize=Number(await styleSize.inputValue());
  await styleSize.fill(String(originalStyleSize+0.5));
  await styleSize.press("Tab");
  await page.evaluate(id=>desSelectRegion(id,{individual:true}),typographyIds[1]);
  await page.getByLabel("Reusable text style",{exact:true}).selectOption("card_title");
  const textStyleDraft=await page.evaluate(ids=>({style:DES.layout.text_styles?.card_title,assignments:ids.map(id=>desRegion(id)?.text_style),resolved:ids.map(id=>layStyledRegion(DES.layout,desRegion(id))?.size_pt)}),typographyIds);
  assert(textStyleDraft.style?.size_pt===originalStyleSize+0.5
    &&textStyleDraft.assignments.every(value=>value==="card_title")
    &&textStyleDraft.resolved.every(value=>value===originalStyleSize+0.5)
    &&await page.getByText(/2 layers · 1 family · .* cards/).isVisible(),
    "one named text style drives multiple layers and exposes its rendered blast radius before commit",JSON.stringify(textStyleDraft));
  const fitRegionId=await page.evaluate(()=>DES.layout.regions.find(region=>region.type==="body"&&region.autoshrink)?.id);
  await page.evaluate(id=>desSelectRegion(id,{individual:true}),fitRegionId);
  const fitControl=page.getByLabel("Text fit",{exact:true});
  const measuredFit=await page.evaluate(()=>{
    const host=document.createElement("div");host.style.cssText="position:fixed;left:-1000px;top:0;width:320px;height:30px";
    host.innerHTML='<div data-lay-region="fit-test" data-lay-fit="shrink" data-lay-start-pt="18" data-lay-min-pt="6" style="box-sizing:border-box;width:320px;height:30px;overflow:hidden;white-space:nowrap;font:18pt Arial">A deliberately long production heading</div>';
    document.body.appendChild(host);const result=layMeasureAndFit(host)[0],node=host.firstElementChild;const status=node.dataset.layFitStatus;host.remove();return{result,status};
  });
  const fitUi={region:fitRegionId,value:await fitControl.inputValue(),minVisible:await page.getByLabel("Min size (pt)",{exact:true}).isVisible(),lineVisible:await page.getByLabel("Line height",{exact:true}).isVisible()};
  assert(fitUi.region&&fitUi.value==="shrink"&&fitUi.minVisible&&fitUi.lineVisible
    &&measuredFit.status==="fit"&&measuredFit.result.used_pt<18&&measuredFit.result.used_pt>=6,
    "Studio exposes measured shrink-to-fit, readable minimum, and line-height controls",JSON.stringify({fitUi,measuredFit}));
  await page.getByRole("button",{name:"Back",exact:true}).click();
  await page.getByRole("button",{name:"Make back editable",exact:true}).click();
  assert(await page.getByRole("button",{name:"Choose back artwork",exact:true}).isVisible()
    &&await page.getByRole("button",{name:"Upload back art",exact:true}).isVisible(),
    "the shared back exposes the same approachable rights-aware artwork path as card fronts");
  await page.getByRole("button",{name:"Choose back artwork",exact:true}).click();
  await page.getByRole("heading",{name:"Choose one back for every card",exact:true}).waitFor();
  await page.locator("[data-back-art-use]").first().click();
  await page.evaluate(()=>desSelectRegion("back_title",{individual:true}));
  const backX=page.locator("#des-ix");
  const originalBackX=Number(await backX.inputValue());
  await backX.fill(String(originalBackX+0.5));
  await backX.press("Tab");
  const backDraft=await page.evaluate(expected=>({face:desFace(),ids:DES.layout.back?.regions?.map(region=>region.id),x:desRegion("back_title")?.x,
    art:DES.layout.back?.art,expected,preview:document.querySelector('[data-lay-region="back_art"] img')?.getAttribute("src"),rendered:document.querySelector('[data-card-face="back"], [data-lay-region="back_title"]')?.outerHTML?.slice(0,180),impact:document.querySelector(".forge-studio-impact")?.textContent}),artAssignment.paths[0]);
  assert(backDraft.face==="back"&&backDraft.ids?.includes("back_field")&&backDraft.ids?.includes("back_art")&&backDraft.ids?.includes("back_border")&&backDraft.ids?.includes("back_title")
    &&backDraft.art===backDraft.expected&&backDraft.preview?.startsWith("blob:")&&backDraft.x===originalBackX+0.5&&backDraft.rendered&&backDraft.impact?.includes("SHARED DUPLEX BACK"),
    "Studio promotes the legacy back to editable versioned layers and previews its all-family blast radius",JSON.stringify(backDraft));
  await page.getByRole("button",{name:"Front",exact:true}).click();
  await page.getByRole("button",{name:"Content",exact:true}).click();
  const richRules=page.getByLabel("Rules text",{exact:true});
  const richBefore=await richRules.inputValue();
  await richRules.evaluate((input,end)=>{input.focus();input.setSelectionRange(0,end);},Math.min(8,richBefore.length));
  await page.getByRole("button",{name:"Bold selected text",exact:true}).click();
  const firstSymbol=await page.getByLabel("Insert game symbol",{exact:true}).locator("option").nth(1).getAttribute("value");
  await page.getByLabel("Insert game symbol",{exact:true}).selectOption(firstSymbol);
  const richAfter=await richRules.inputValue();
  assert(richAfter.includes("**")&&richAfter.includes(`[${firstSymbol}]`)
    && await page.locator("#des-stage-inner strong").first().isVisible()
    && await page.getByText("Face preflight",{exact:false}).isVisible(),
    "Studio authors portable bold text and game symbols with live rendered preflight",richAfter);
  const studioName=page.getByLabel("Name", { exact:true });
  const originalStudioName=await studioName.inputValue();
  await studioName.fill(`${originalStudioName} Studio UI Draft`);
  const studioDraft=await page.evaluate(()=>({status:document.querySelector(".forge-studio-status")?.textContent,
    canvas:document.querySelector(".forge-studio-canvasbar .card-title")?.textContent,
    input:document.getElementById("des-content-name")?.value}));
  assert(studioDraft.status?.includes("2 cards")&&studioDraft.status?.includes("draft")&&studioDraft.canvas===`${originalStudioName} Studio UI Draft`,
    "card content edits re-render the selected production face and expose the local draft boundary",JSON.stringify(studioDraft));
  await page.getByRole("button", { name:"Review changes", exact:true }).click();
  await page.getByRole("heading", { name:"Review component content, artwork, and layout together" }).waitFor();
  const studioReview=await page.evaluate(()=>({text:document.getElementById("mbody")?.textContent,
    commitDisabled:document.getElementById("des-studio-commit")?.disabled}));
  assert(await page.getByText("Combined validation passed", { exact:false }).isVisible()
    && studioReview.text?.includes("1 new art file")
    && studioReview.text?.includes("1 art tag record")
    && await page.evaluate(()=>DES_REVIEW.data.layout_changes.some(change=>change.path==="group")
      &&DES_REVIEW.data.layout_changes.some(change=>change.path==="border")
      &&DES_REVIEW.data.layout_changes.some(change=>change.path==="shadow_spec")
      &&DES_REVIEW.data.layout_changes.some(change=>change.path==="text_styles")
      &&DES_REVIEW.data.layout_changes.some(change=>change.id==="$back"&&change.path==="back")
      &&DES_REVIEW.data.layout_changes.filter(change=>change.path==="text_style").length===2)
    && await page.getByRole("button", { name:"Commit reviewed candidate" }).isEnabled(),
    "Studio dry-runs the combined component candidate before enabling its atomic commit",JSON.stringify(studioReview));
  await page.getByRole("button", { name:"Keep editing", exact:true }).click();
  await page.reload({ waitUntil:"domcontentloaded" });
  await page.getByRole("heading", { name:"Design once. Review every card. Ship the exact version." }).waitFor();
  const designSteps=await page.locator(".design-golden-step").allTextContents();
  assert(designSteps.length===5&&designSteps[0].includes("Choose a template")&&designSteps[4].includes("Print or play"),
    "Design explains the complete template-to-release path",JSON.stringify(designSteps));
  for (const width of [320,390]) {
    await page.setViewportSize({width,height:844});
    const geometry=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth,
      visible:[...document.querySelectorAll(".design-start button,.design-choice-grid button,.design-workspace-map button")].filter(button=>{const box=button.getBoundingClientRect();return box.width&&box.height&&box.bottom>0&&box.top<innerHeight;})
        .map(button=>({label:button.textContent.trim(),height:button.getBoundingClientRect().height}))}));
    assert(geometry.scroll<=geometry.viewport,`${width}px Design workspace has no horizontal overflow`,`${geometry.scroll}/${geometry.viewport}`);
    assert(geometry.visible.every(button=>button.height>=44),`${width}px visible Design controls meet the 44px touch target`,JSON.stringify(geometry.visible));
  }

  await page.setViewportSize({width:1280,height:900});
  await page.getByRole("button",{name:"Open pieces"}).click();
  await page.getByRole("heading",{name:/Pieces — Netrunner/}).waitFor();
  assert(await page.getByText(/Add a token, counter, tile, dial, or board/).isVisible(),
    "a card project can enter the component studio without pre-existing piece files");
  await page.getByRole("button",{name:"Sheet setup",exact:true}).click();
  await page.getByRole("heading",{name:"Manufacturing sheet"}).waitFor();
  assert(await page.getByLabel("Paper").inputValue()==="A4"
    && await page.getByLabel("Bleed mm").inputValue()==="2"
    && await page.getByLabel("Safe inset mm").inputValue()==="1.5"
    && await page.getByText(/green safe-area guide is preview-only/).isVisible(),
    "manufacturing settings distinguish versioned output controls from preview-only guidance");
  await page.getByLabel("Paper").selectOption("Letter");
  await page.getByLabel("Safe inset mm").fill("2");
  await page.getByLabel("Safe inset mm").press("Tab");
  assert(await page.getByText(/Letter printable area/).isVisible()
    && await page.getByLabel("Safe inset mm").inputValue()==="2",
    "paper and safety changes update the live versioned production summary");
  await page.getByRole("button",{name:"× Close"}).click();
  await page.getByRole("button",{name:"Create first token"}).click();
  assert(await page.locator('[data-forge-guide="safe"]').isVisible(),
    "the selected safety inset is visible on the live component proof");
  await page.getByLabel("Name").fill("Run marker");
  await page.getByRole("spinbutton",{name:"Quantity",exact:true}).fill("4");
  await page.getByLabel("Quantity is per player").check();
  await page.getByLabel("Kit player count").selectOption("2");
  await page.getByLabel("Game symbol").selectOption("credit");
  await page.locator(".component-studio-inspector input[type=color]").first().fill("#173b57");
  await page.getByLabel("Two-sided piece").check();
  await page.getByLabel("Back name").fill("Run spent");
  const componentLive=await page.locator(".component-studio-grid").textContent();
  assert(await page.getByLabel(/Run marker production preview/).isVisible()
    && await page.getByLabel(/Run spent back production preview/).isVisible()
    && componentLive.includes("×8")
    && componentLive.includes("4 × 2 players")
    && componentLive.includes("2printed sides"),
    "component data, selected-player quantity, two-sided pairing, and shared family styling update live production previews",
    componentLive.replace(/\s+/g," ").trim());
  await page.getByRole("button",{name:"+ Piece"}).click();
  await page.getByRole("heading",{name:"Choose a physical component"}).waitFor();
  assert(await page.getByText(/A preset only creates a local starting point/).isVisible(),
    "the component picker explains that presets are editable drafts, not manufacturing guarantees");
  await page.getByRole("button",{name:"Add board"}).click();
  assert(await page.getByLabel("Kind").inputValue()==="board"
    && await page.getByLabel("Width mm").inputValue()==="180"
    && await page.getByLabel("Height mm").inputValue()==="120"
    && await page.getByLabel("Visual family").inputValue()==="generic-piece"
    && await page.getByText(/Boards larger than the selected sheet are poster-tiled/).isVisible(),
    "a guided board preset chooses sensible dimensions, family, and honest production guidance");
  await page.getByLabel("Name").fill("Prototype board");
  await page.getByLabel("Width mm").fill("310");
  await page.getByLabel("Height mm").fill("220");
  assert((await page.locator(".component-impact").textContent()).includes("310 × 220 mm"),
    "oversize board dimensions remain editable in the same piece studio");
  await page.getByRole("button",{name:"+ Piece"}).click();
  await page.getByRole("button",{name:"Add dial"}).click();
  assert(await page.getByLabel("Start value").inputValue()==="0"
    && await page.getByLabel("Maximum value").inputValue()==="10"
    && await page.getByLabel("Step").inputValue()==="1"
    && await page.locator('[data-forge-dial-scale="0,1,2,3,4,5,6,7,8,9,10"]').isVisible()
    && await page.getByText(/spindle, rivet, and physical assembly remain external/).isVisible(),
    "the dial preset exposes a live printable scale while keeping assembly hardware explicit");
  await page.getByLabel("Start value").fill("1");
  await page.getByLabel("Maximum value").fill("5");
  await page.getByLabel("Step").fill("2");
  assert(await page.locator('[data-forge-dial-scale="1,3,5"]').isVisible()
    && await page.getByText(/3 printed positions/).isVisible(),
    "dial ranges update the actual production face rather than remaining hidden metadata");
  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"Delete piece"}).click();
  await page.getByRole("button",{name:"+ Piece"}).click();
  await page.getByRole("button",{name:"Add token"}).click();
  await page.getByLabel("Name").fill("Alert marker");
  assert(await page.getByText(/Shared style · 2 pieces/).isVisible(),
    "the inspector makes shared-family blast radius visible before a style edit");
  await page.getByRole("button",{name:"Make this style independent"}).click();
  assert(await page.getByLabel("Visual family").inputValue()==="new-token-2-style",
    "one action creates and binds a stable independent family for this piece");
  await page.locator(".component-studio-inspector input[type=color]").first().fill("#7c3aed");
  await page.locator(".component-studio-list button").filter({hasText:"Run marker"}).click();
  assert(await page.locator(".component-studio-inspector input[type=color]").first().inputValue()==="#173b57",
    "editing the independent family no longer changes the original shared token style");
  await page.locator(".component-studio-list button").filter({hasText:"Prototype board"}).click();
  await page.getByLabel("Stage this piece in setup").check();
  const setupMap=page.getByLabel("System Gateway starter duel component setup map");
  await setupMap.click({position:{x:430,y:210}});
  assert(await page.getByText(/Click the table to move Prototype board/).isVisible()
    && Number(await page.getByLabel("Setup X").inputValue())>0,
    "a non-card piece can be positioned visually in the existing versioned table setup");
  await page.setViewportSize({width:390,height:844});
  const componentMobile=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth,
    controls:[...document.querySelectorAll(".component-studio-head button,.component-studio-head select,.component-studio-head input")].map(control=>({label:control.textContent?.trim()||control.getAttribute("aria-label"),height:control.getBoundingClientRect().height})),
    offenders:[...document.querySelectorAll("#pane *")].map(element=>({tag:element.tagName,cls:element.className?.toString?.()||"",right:Math.round(element.getBoundingClientRect().right),width:Math.round(element.getBoundingClientRect().width),scroll:element.scrollWidth})).filter(item=>item.right>innerWidth+1||item.scroll>item.width+1).slice(0,12)}));
  assert(componentMobile.scroll<=componentMobile.viewport,
    "390px Piece Studio has no horizontal overflow",`${componentMobile.scroll}/${componentMobile.viewport} ${JSON.stringify(componentMobile.offenders)}`);
  assert(componentMobile.controls.every(control=>control.height>=44),
    "390px Piece Studio production controls meet the 44px touch target",JSON.stringify(componentMobile.controls));
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole("button",{name:"Review changes"}).click();
  await page.getByRole("heading",{name:"Review component production change"}).waitFor();
  await page.getByText("Exact uncommitted manufacturing proof",{exact:true}).waitFor({timeout:15_000});
  await page.locator(".component-proof-card img").first().waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll(".component-proof-card img")]
    .every(image=>image.complete&&image.naturalWidth>0));
  assert(await page.getByText(/3 added/).isVisible() && await page.getByText(/setup map changed/).isVisible()
    && await page.getByText("One atomic commit",{exact:true}).isVisible(),
    "component review names semantic and family impact before writing");
  assert(await page.getByText(/Letter · 10 physical pieces/).isVisible()
    && await page.getByText(/1 front \+ 1 back sheets/).isVisible()
    && await page.getByText(/2 poster tiles/).isVisible()
    && await page.locator(".component-proof-card img").count()===3
    && await page.locator(".component-proof-card img").first().evaluate(image=>image.complete&&image.naturalWidth>0)
    && await page.getByRole("button",{name:"Commit component change"}).isEnabled(),
    "review renders canonical front, duplex-back, and poster-tile proofs before enabling commit",
    await page.locator("#component-manufacturing-proof").textContent());
  const componentCommitResponse=page.waitForResponse(response=>response.request().method()==="PUT"
    &&new URL(response.url()).pathname.endsWith("/components/pieces"));
  await page.getByRole("button",{name:"Commit component change"}).click();
  const componentCommitResult=await componentCommitResponse;
  assert(componentCommitResult.ok(),"component data and reusable design commit atomically through the UI",
    `${componentCommitResult.status()} ${await componentCommitResult.text()}`);
  await page.getByText(/3 stable piece types/).waitFor({timeout:15_000});
  await page.locator(".component-section").getByRole("button",{name:"Open Piece Studio"}).click();
  await page.getByRole("heading",{name:/Pieces — Netrunner/}).waitFor();
  await page.locator(".component-studio-list button").filter({hasText:"Prototype board"}).click();
  const componentArtChooserPromise=page.waitForEvent("filechooser");
  await page.getByRole("button",{name:"Upload front art + rights"}).click();
  const componentArtChooser=await componentArtChooserPromise;
  await componentArtChooser.setFiles({name:"board.png",mimeType:"image/png",buffer:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64")});
  await page.getByRole("heading",{name:"Credit front art for Prototype board"}).waitFor();
  await page.getByLabel(/I confirm this declaration is accurate/).check();
  const componentArtResponse=page.waitForResponse(response=>response.request().method()==="POST"
    &&new URL(response.url()).pathname.endsWith("/components/pieces/new_board/art"));
  await page.getByRole("button",{name:"Record rights & continue"}).click();
  assert((await componentArtResponse).ok(),"component art, its piece assignment, and rights record commit atomically");
  await page.evaluate(()=>componentStudioOpen("netrunner-sg"));
  await page.locator(".component-studio-list button").filter({hasText:"Prototype board"}).click();
  assert(await page.getByLabel("Art path").inputValue()==="assets/components/new_board-front.png",
    "the committed artwork assignment returns to the selected component inspector");
  const componentRights=await page.evaluate(async()=>await (await fetch("/api/games/netrunner-sg/rights")).json());
  assert(componentRights.files.some(file=>file.path==="assets/components/new_board-front.png"&&file.status==="original"),
    "component artwork carries its auditable rights into the repository");
  await page.locator(".component-studio-list button").filter({hasText:"Run marker"}).click();
  const familySvgDownloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Take family SVG"}).click();
  const familySvgDownload=await familySvgDownloadPromise;
  const familySvg=readFileSync(await familySvgDownload.path(),"utf8");
  assert(/round-token\.svg$/.test(familySvgDownload.suggestedFilename())
    && familySvg.includes('data-forge-component-region="name"'),
    "piece studio exports a named, editable family SVG pinned to the committed design");
  const returnedFamilySvg=familySvg.replace('fill="#173b57"','fill="#204060"');
  const familySvgChooserPromise=page.waitForEvent("filechooser");
  await page.getByRole("button",{name:"Return family SVG"}).click();
  const familySvgChooser=await familySvgChooserPromise;
  await familySvgChooser.setFiles({name:"round-token.svg",mimeType:"image/svg+xml",buffer:Buffer.from(returnedFamilySvg)});
  await page.getByRole("heading",{name:"Review round-token family"}).waitFor();
  assert(await page.getByText("Bounded editor bridge",{exact:true}).isVisible()
    && await page.getByText("RETURNED SVG",{exact:true}).isVisible(),
    "returned family SVG gets a visual, bounded dry run before writing");
  const familySvgCommitResponse=page.waitForResponse(response=>response.request().method()==="POST"
    &&new URL(response.url()).pathname.endsWith("/components/import/svg"));
  await page.getByRole("button",{name:"Commit returned family"}).click();
  assert((await familySvgCommitResponse).ok(),
    "piece studio commits the reviewed external family edit through the browser");
  await page.getByRole("heading",{name:/Pieces — Netrunner/}).waitFor({timeout:15_000});
  const componentDownloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Build cut sheets"}).click();
  const componentDownload=await componentDownloadPromise;
  const componentKit=readZip(readFileSync(await componentDownload.path()));
  const componentManifest=JSON.parse(componentKit.get("manifest.json"));
  assert(/netrunner-sg-components-v6\.zip$/.test(componentDownload.suggestedFilename())
    && componentKit.has("faces/new_token-back.svg")
    && componentKit.has("cut-sheets/01-letter-back.svg")
    && componentKit.has("large-pieces/new_board-01-front-r1c2-letter.svg")
    && componentKit.has("setup-maps/system-gateway-duel.svg")
    && componentManifest.quantity_resolution.player_count===2
    && componentManifest.production.sheet.page==="Letter"
    && componentManifest.production.safe_mm===2
    && componentManifest.pieces[0].resolved_quantity===8
    && componentManifest.large_piece_tiles[0].columns===2
    && componentManifest.setup_maps[0].placements.some(item=>item.component_id==="new_board")
    && componentManifest.pieces.find(item=>item.id==="new_board").artwork[0].rights.status==="original",
    "component studio produces an exact-version kit with player-count quantities, duplex backs, tiled oversize boards, and a setup map");

  // The art flow must collect provenance before bytes enter the repository;
  // cancelling the declaration therefore cannot leave an unknown-rights file.
  await page.goto(`${origin}/#/g/onboarding-smoke/onboarding-smoke-game/cards`, { waitUntil:"domcontentloaded" });
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
    "legacy/imported unknown-rights files remain fail-closed",JSON.stringify(unknownUpload));
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

  await page.getByRole("button", { name:"Cut this exact release" }).click();
  await page.getByLabel("Tag (e.g. v1.0)").fill("v0.1");
  await page.getByLabel("Title (optional)").fill("UI manufacturing proof");
  const releaseResponse=page.waitForResponse(response=>response.request().method()==="POST"
    &&new URL(response.url()).pathname==="/api/games/onboarding-smoke-game/releases",{timeout:90_000});
  await page.getByRole("button",{name:"Release",exact:true}).click();
  assert((await releaseResponse).status()===201,"the browser cuts a rights-cleared exact release before printer handoff");
  await page.getByRole("button",{name:"Record exact handoff"}).waitFor({timeout:90_000});
  await page.getByRole("button",{name:"Record exact handoff"}).click();
  await page.getByLabel("Printer or manufacturer").fill("Example Print House");
  await page.getByLabel("Job / quote reference").fill("UI-JOB-42");
  await page.getByLabel("Evidence file (optional)").setInputFiles({name:"submission.txt",mimeType:"text/plain",buffer:Buffer.from("submitted UI-JOB-42")});
  await page.getByLabel(/I confirm this record is accurate/).check();
  const deliveryResponse=page.waitForResponse(response=>response.request().method()==="POST"
    &&new URL(response.url()).pathname.endsWith("/releases/v0.1/print-deliveries"));
  await page.getByRole("button",{name:"Record handoff",exact:true}).click();
  const deliveryHttp=await deliveryResponse,deliveryBody=await deliveryHttp.json();
  assert(deliveryHttp.status()===201&&deliveryBody.artifact.sha256.length===64
    &&deliveryBody.delivery.evidence_sha256.length===64
    &&deliveryBody.trust.independently_verified===false,
    "the UI binds a locally hashed submission receipt to immutable release bytes without uploading private evidence");
  await page.getByText("SUBMITTED",{exact:true}).waitFor();
  await page.getByRole("button",{name:"✓ Record approval"}).click();
  await page.getByLabel("Named reviewer").fill("Prepress Reviewer");
  await page.getByLabel("Printer / organization").fill("Example Print House");
  await page.getByLabel("Evidence file (required)").setInputFiles({name:"approval.txt",mimeType:"text/plain",buffer:Buffer.from("approved UI-JOB-42 as supplied")});
  await page.getByLabel(/I confirm this record is accurate/).check();
  const decisionResponse=page.waitForResponse(response=>response.request().method()==="POST"
    &&new URL(response.url()).pathname.endsWith(`/print-deliveries/${deliveryBody.id}/decision`));
  await page.getByRole("button",{name:"Record approved",exact:true}).click();
  const decisionHttp=await decisionResponse,decisionBody=await decisionHttp.json();
  assert(decisionHttp.status()===201&&decisionBody.status==="approved"
    &&decisionBody.decision.evidence_sha256.length===64
    &&decisionBody.artifact.sha256===deliveryBody.artifact.sha256,
    "the UI records one named, hashed printer approval against the same exact artifact");
  await page.getByText("APPROVED",{exact:true}).waitFor();
  assert(await page.getByRole("link",{name:"View JSON receipt"}).isVisible()
    &&(await page.locator("body").innerText()).includes("not independently verified by Forge"),
    "the release surfaces a downloadable receipt and keeps the evidence boundary explicit");

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
  const bobPrAccess=await bobPage.evaluate(async({slug,id})=>await (await fetch(`/api/games/${slug}/prs/${id}`)).json(),
    {slug:"onboarding-smoke-game",id:bobProposal.data.id});
  assert(bobPrAccess.access?.is_author===true,"proposal API recognizes its author in the independent browser session",JSON.stringify(bobPrAccess.access));
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

  // Run the empty-project bootstrap after collaboration tests because Local
  // Store-1 intentionally commits every project into one disposable Git root.
  const wizardProject=await page.evaluate(async()=>{
    const response=await fetch("/api/games",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      title:"Wizard UI Smoke",license:"CC0-1.0",brief:{schema_version:1,status:"idea",starting_point:"mechanism",
        spark:"Prove an empty idea can become a usable card system without YAML.",
        design_intent:{player_experience:"Make a clear choice."},mvp:{playable_slice:"Choose one of two cards."}}
    })});return {status:response.status,data:await response.json()};
  });
  assert(wizardProject.status===201&&wizardProject.data.cards===0,
    "idea-first onboarding creates an empty versioned project for the card wizard",JSON.stringify(wizardProject));
  await page.goto(`${origin}/#/g/onboarding-smoke/wizard-ui-smoke/design`,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"Build first card component",exact:true}).click();
  await page.getByLabel("Starting layout").selectOption("classic");
  await page.getByLabel("Physical size").selectOption("japanese");
  await page.getByLabel("Copies of each").fill("2");
  await page.getByLabel("Shared card-back title").fill("WIZARD DECK");
  await page.getByLabel(/Category/).check();
  await page.getByLabel(/Starter card names/).fill("Strike\nGuard");
  const starterDryResponse=page.waitForResponse(response=>response.request().method()==="POST"
    &&new URL(response.url()).pathname.endsWith("/design/card-starter")&&!new URL(response.url()).searchParams.has("commit"));
  await page.getByRole("button",{name:"Review first component",exact:true}).click();
  const starterDryHttp=await starterDryResponse,starterDryText=await starterDryHttp.text();
  assert(starterDryHttp.ok(),"the first-component dry run succeeds",`${starterDryHttp.status()} ${starterDryText}`);
  await page.getByRole("heading",{name:"Review the first component system",exact:true}).waitFor();
  assert(await page.getByText("Shared duplex back",{exact:true}).isVisible()
    && await page.getByText("Complete project validation passed",{exact:false}).isVisible()
    && await page.locator("#mbody").getByText("templates/layout.yaml",{exact:true}).isVisible()
    && await page.getByRole("button",{name:"Commit first component",exact:true}).isEnabled(),
    "the wizard renders exact fronts/back and names every validated file before commit");
  const starterCommitResponse=page.waitForResponse(response=>response.request().method()==="POST"
    &&new URL(response.url()).pathname.endsWith("/design/card-starter")&&new URL(response.url()).searchParams.get("commit")==="1");
  await page.getByRole("button",{name:"Commit first component",exact:true}).click();
  assert((await starterCommitResponse).ok(),"the exact reviewed starter commits successfully");
  await page.waitForFunction(async()=>{
    const cards=await (await fetch("/api/games/wizard-ui-smoke/cards")).json();return cards.length===2;
  });
  const wizardCards=JSON.parse(readFileSync(join(gamesRoot,"wizard-ui-smoke","components","cards.json"),"utf8"));
  const wizardLayout=readFileSync(join(gamesRoot,"wizard-ui-smoke","templates","layout.yaml"),"utf8");
  const wizardPrint=readFileSync(join(gamesRoot,"wizard-ui-smoke","templates","print.yaml"),"utf8");
  assert(wizardCards.map(card=>card.id).join(",")==="strike,guard"&&wizardCards.every(card=>card.attributes.category==="starter")
    &&/w_mm: 59/.test(wizardLayout)&&/text: WIZARD DECK/.test(wizardLayout)
    &&/preset: balanced-duplex/.test(wizardPrint),
    "the browser commits stable rows, typed fields, Japanese trim, shared back, and print contract atomically");

  await page.goto(`${origin}/#/g/onboarding-smoke/wizard-ui-smoke/decks`,{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"Save the exact cards you intend to test or manufacture",exact:true}).waitFor();
  await page.getByRole("button",{name:"New playable build",exact:false}).click();
  await page.locator("#deck-name").fill("First exact playtest");
  assert(await page.locator("#deck-id").inputValue()==="first-exact-playtest",
    "the visual build editor proposes a portable stable ID from the human name");
  await page.getByLabel("Strike quantity",{exact:true}).fill("2");
  await page.getByLabel("Guard quantity",{exact:true}).fill("1");
  const deckPreviewResponse=page.waitForResponse(response=>response.request().method()==="POST"
    &&new URL(response.url()).pathname.endsWith("/decks/preview"));
  const deckPreviewHttp=await deckPreviewResponse,deckPreviewBody=await deckPreviewHttp.json();
  assert(deckPreviewHttp.ok()&&deckPreviewBody.written===false&&deckPreviewBody.legality.legal
    &&deckPreviewBody.totals.cards===3&&deckPreviewBody.totals.exact_printings===2,
    "the editor previews legality and exact physical face counts without writing",JSON.stringify(deckPreviewBody));
  const deckCommitButton=page.getByRole("button",{name:"Commit playable build",exact:true});
  await deckCommitButton.waitFor();
  const deckCommitResponse=page.waitForResponse(response=>response.request().method()==="PUT"
    &&new URL(response.url()).pathname.endsWith("/decks/first-exact-playtest"));
  await deckCommitButton.click();
  const deckCommitHttp=await deckCommitResponse,deckCommitBody=await deckCommitHttp.json();
  assert(deckCommitHttp.ok()&&deckCommitBody.saved&&deckCommitBody.legality.legal,
    "the reviewed visual build becomes one authored Git commit",JSON.stringify(deckCommitBody));
  await page.waitForFunction(async()=>{
    const response=await fetch("/api/games/wizard-ui-smoke/decks");
    return response.ok&&(await response.json()).decks.some(deck=>deck.id==="first-exact-playtest");
  });
  const committedBuild=JSON.parse(readFileSync(join(gamesRoot,"wizard-ui-smoke","decks","first-exact-playtest.json"),"utf8"));
  assert(committedBuild.cards.strike===2&&committedBuild.cards.guard===1
    &&Object.values(committedBuild.printings).reduce((sum,count)=>sum+count,0)===3,
    "the committed portable deck document reconciles gameplay counts with manufacturing quantities");
  await page.waitForTimeout(900);
  await page.goto(`${origin}/#/g/onboarding-smoke/wizard-ui-smoke/decks`,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"Plan exact print run",exact:false}).click();
  await page.getByRole("heading",{name:"Choose exactly what Forge will manufacture",exact:true}).waitFor();
  assert(await page.locator("#print-selection").inputValue()==="exact"
    &&(await page.locator("#print-selection").locator("option:checked").innerText()).includes("First exact playtest")
    &&(await page.locator("#print-card-selector").innerText()).includes("2× exact")
    &&(await page.locator("#print-card-selector").innerText()).includes("1× exact"),
    "one action carries the saved build's exact faces and counts into the production planner");
  await page.getByRole("button",{name:"Close",exact:false}).click();

  await page.goto(`${origin}/#/g/onboarding-smoke/wizard-ui-smoke/design`,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"Print profile",exact:true}).click();
  await page.getByRole("heading",{name:"Choose exactly what Forge will manufacture",exact:true}).waitFor();
  await page.getByLabel("Starting preset").selectOption("the-game-crafter-poker");
  assert(await page.getByLabel("Production target").inputValue()==="the-game-crafter-poker"
    &&(await page.locator("#mbody").innerText()).includes("file handoff—not native publishing")
    &&(await page.locator("#mbody").innerText()).includes("receiving printer must approve"),
    "the planner exposes the TGC selection without hiding the file-handoff and printer-approval boundary");
  await page.getByLabel("Starting preset").selectOption("custom-cmyk-pdfx1a");
  assert(await page.getByLabel("Production target").inputValue()==="custom-cmyk-pdfx1a"
    &&await page.locator("#print-cmyk-fields").isVisible()
    &&(await page.locator("#print-cmyk-fields").innerText()).includes("Upload a CMYK printer ICC in Assets first")
    &&(await page.locator("#print-cmyk-fields").innerText()).includes("Maximum total ink")
    &&await page.getByLabel("Add named spot-color cut path").isVisible(),
    "profile-driven CMYK exposes the exact repository ICC, output condition, rendering, ink, and finishing contract");
  await page.getByLabel("Add named spot-color cut path").check();
  assert(await page.getByLabel("Printer's exact spot name").inputValue()==="CutContour"
    &&await page.locator("#print-dieline-fields").isVisible()
    &&(await page.locator("#print-dieline-fields").innerText()).includes("always full tint and stroke-overprinting"),
    "spot finishing is an explicit versioned trim path rather than a process-color decoration");
  await page.getByLabel("Starting preset").selectOption("opaque-sleeves");
  assert(await page.getByLabel("Home marks appear on").inputValue()==="fronts"
    &&await page.getByLabel("Press marks appear on").inputValue()==="fronts",
    "the fronts-only preset selects visible, versioned front-page marks rather than an implicit renderer rule");
  await page.locator("#print-selection").selectOption("selected");
  await page.locator('[data-print-card][value="guard"]').uncheck();
  const printDryResponse=page.waitForResponse(response=>response.request().method()==="POST"
    &&new URL(response.url()).pathname.endsWith("/design/print-profile"));
  await page.getByRole("button",{name:"Review exact profile",exact:true}).click();
  const printDryHttp=await printDryResponse,printDryBody=await printDryHttp.json();
  assert(printDryHttp.ok()&&printDryBody.selected_cards.map(card=>card.id).join(",")==="strike"
    &&printDryBody.physical_cards===2,
    "the visual print planner dry-runs an exact stable-card selection and physical quantity",JSON.stringify(printDryBody));
  await page.getByRole("heading",{name:"Review the exact production contract",exact:true}).waitFor();
  const printReviewText=await page.locator("#mbody").innerText();
  assert(printReviewText.includes("Complete project validation passed")
    &&printReviewText.includes("labels generic output sRGB")
    &&await page.getByRole("button",{name:"Commit print profile",exact:true}).isEnabled(),
    "the production review exposes validation, exact counts, and the honest press boundary");
  const printCommitResponse=page.waitForResponse(response=>response.request().method()==="PUT"
    &&new URL(response.url()).pathname.endsWith("/design/print-profile"));
  await page.getByRole("button",{name:"Commit print profile",exact:true}).click();
  const printCommitHttp=await printCommitResponse,printCommitBody=await printCommitHttp.json();
  assert(printCommitHttp.ok()&&printCommitBody.saved,
    "the exact reviewed print contract becomes a repository commit",JSON.stringify(printCommitBody));
  const printProfile=readFileSync(join(gamesRoot,"wizard-ui-smoke","templates","print.yaml"),"utf8");
  assert(/preset: opaque-sleeves/.test(printProfile)&&/- strike/.test(printProfile)
    &&/fronts_only: true/.test(printProfile)&&/gutter_mm: 3/.test(printProfile)
    &&/crop_mark_sides: fronts/.test(printProfile)
    &&/sleeve_profile: japanese-62x89/.test(printProfile),
    "the committed profile preserves preset, selection, fronts-only, gutter, and sleeve intent");

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
