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
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { buildCardStarter } from "./lib/card-starter.mjs";
import { readZip } from "./lib/deterministic-zip.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-ui-export-selection."));
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
  await page.getByRole("button", { name: "Configure print", exact: true }).click();
  await page.getByRole("heading", { name: "Print settings", exact: true }).waitFor();
  assert.equal(await page.locator("#print-insert-fields").isVisible(), false);
  await page.getByLabel("Card insert size", { exact: true }).selectOption("custom");
  await page.getByLabel("Dimension units", { exact: true }).selectOption("in");
  await page.getByLabel("Insert width", { exact: true }).fill("2.6");
  await page.getByLabel("Insert height", { exact: true }).fill("3.58");
  await page.getByLabel("Dimension units", { exact: true }).selectOption("mm");
  assert.equal(await page.getByLabel("Insert width", { exact: true }).inputValue(), "66.04");
  assert.equal(await page.getByLabel("Insert height", { exact: true }).inputValue(), "90.932");
  await page.getByLabel("Insert width", { exact: true }).fill("66");
  await page.getByLabel("Insert height", { exact: true }).fill("90.892");
  await page.getByLabel("Paper orientation", { exact: true }).selectOption("landscape");
  await page.getByLabel("Home PDFs are fronts only", { exact: true }).check();
  await page.getByLabel("Home crop marks", { exact: true }).selectOption("corners");
  assert.equal(await page.locator("#print-gutter").inputValue(), "3");
  await page.getByLabel("Home crop marks", { exact: true }).selectOption("grid");
  assert.equal(await page.locator("#print-gutter").inputValue(), "0");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "print settings fit a phone viewport");
  let exportRequests=0;
  page.on("request", request => {if(request.method()==="POST" && request.url().endsWith("/export/print"))exportRequests++;});
  await page.getByRole("button", { name: "A4 sheets", exact: true }).click();
  await page.getByText("Review and save these print settings before downloading.", { exact: true }).waitFor();
  assert.equal(exportRequests,0,"unsaved settings cannot silently download the previous cut size");
  const before = git("rev-parse", "HEAD");
  const reviewResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/design/print-profile"));
  await page.getByRole("button", { name: "Review exact profile", exact: true }).click();
  const review = await reviewResponse;
  assert.equal(review.status(), 200, await review.text());
  const reviewed = await review.json();
  const ajv = new Ajv2020({strict:true,allErrors:true});addFormats(ajv);
  const validateProfile=ajv.compile(JSON.parse(readFileSync(join(ROOT,"schemas/print-profile.schema.json"),"utf8")));
  assert.ok(validateProfile(reviewed.profile),JSON.stringify(validateProfile.errors));
  assert.deepEqual(reviewed.profile.home.insert_mm, { w_mm: 66, h_mm: 90.892 });
  assert.equal(git("rev-parse", "HEAD"), before, "review writes no game source");
  await page.getByText("66 × 90.892 mm cut size", { exact: false }).waitFor();
  await page.getByRole("button",{name:"← Revise",exact:true}).click();
  assert.equal(await page.getByLabel("Insert height",{exact:true}).inputValue(),"90.892","revise preserves entered dimensions");
  assert.equal(await page.getByLabel("Paper orientation",{exact:true}).inputValue(),"landscape");
  await page.getByRole("button",{name:"A4 sheets",exact:true}).click();
  assert.equal(exportRequests,0,"revise does not turn unsaved settings into the saved baseline");
  await page.getByRole("button",{name:"Review exact profile",exact:true}).click();
  await page.getByRole("heading",{name:"Review the exact production contract",exact:true}).waitFor();
  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Commit print profile", exact: true }).click();
  await navigation;
  const saved = yaml.load(readFileSync(join(games, "ember/templates/print.yaml"), "utf8"));
  assert.deepEqual(saved.home, reviewed.profile.home);
  const committed = git("rev-parse", "HEAD");
  assert.notEqual(committed, before);
  // A new exporter must not replace bytes addressed by the old print URL.
  const oldPath = join(scratch, "cache/exports/ember", committed, "print-a4.pdf");
  mkdirSync(join(scratch, "cache/exports/ember", committed), { recursive: true });
  writeFileSync(oldPath, "old exporter bytes retained");
  await page.getByRole("button", { name: "Configure print", exact: true }).click();
  assert.equal(await page.getByLabel("Insert height", { exact: true }).inputValue(), "90.892");
  const downloadTo = async (name, target) => {
    const downloaded = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByRole("button", { name, exact: true }).click();
    const file = await downloaded; await file.saveAs(target); return file.url();
  };
  const output = join(scratch, "custom-a4.pdf"), calibration = join(scratch, "calibration-a4.pdf");
  const url = await downloadTo("A4 sheets", output);
  assert.ok(url.endsWith("/v3-print-a4.pdf") && url.includes(committed));
  const proofUrl = await downloadTo("A4 calibration", calibration);
  assert.ok(proofUrl.endsWith("/v3-print-calibration-a4.pdf"));
  assert.equal(readFileSync(oldPath, "utf8"), "old exporter bytes retained");
  const result = JSON.parse(execFileSync(join(ROOT, ".venv/bin/python"), ["-c", `
import json,sys
from pypdf import PdfReader
from pypdf.generic import ContentStream
r=PdfReader(sys.argv[1]);current=None;boxes=[]
for values,op in ContentStream(r.pages[0].get_contents(), r).operations:
 if op==b'cm':current=[float(v) for v in values]
 if op==b'Do':boxes.append(current)
print(json.dumps({'page':[float(r.pages[0].mediabox.width),float(r.pages[0].mediabox.height)],'cards':boxes,'calibration':PdfReader(sys.argv[2]).pages[0].extract_text()}))
`, output, calibration], { encoding: "utf8" }));
  assert.ok(result.page[0] > result.page[1], "downloaded A4 uses saved landscape orientation");
  assert.ok(result.cards.length > 0);
  assert.ok(Math.abs(result.cards[0][0] * 25.4 / 72 - 66) < .001);
  assert.ok(Math.abs(result.cards[0][3] * 25.4 / 72 - 90.892) < .001);
  assert.match(result.calibration, /66 x 90.892 mm/);
  const zip = readZip(readFileSync(join(scratch, "cache/exports/ember", committed, "v3-print-ready.zip")));
  const manifest = JSON.parse(zip.get("manifest.json").toString());
  assert.deepEqual(manifest.home_downloads.trim_mm, [66, 90.892]);
  assert.deepEqual(zip.get(`pdf/${manifest.home_downloads.a4_pdf}`), readFileSync(output));
  assert.deepEqual(errors, []);
  if(process.env.FORGE_PRINT_EVIDENCE_DIR){
    const evidence = resolve(process.env.FORGE_PRINT_EVIDENCE_DIR);mkdirSync(evidence,{recursive:true});
    cpSync(output,join(evidence,"custom-a4.pdf"));cpSync(calibration,join(evidence,"calibration-a4.pdf"));
    await downloadTo("Letter sheets",join(evidence,"custom-letter.pdf"));
    await downloadTo("Letter calibration",join(evidence,"calibration-letter.pdf"));
    await page.screenshot({path:join(evidence,"print-settings-mobile.png"),fullPage:true});
  }
  await page.goto(`${origin}/#help/printing`,{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"Home printing",exact:true}).waitFor();
  assert.match(await page.locator("article").innerText(),/both rulers: each must be 50 mm/);
  await context.close();
  console.log("HOME PRINT BROWSER GREEN — units, shared cuts, mobile, review/commit, saved dimensions, calibration and preserved old bytes.");
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
