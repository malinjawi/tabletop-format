#!/usr/bin/env node
/** Browser regression for selected downloads across sign-in and failed builds. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

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
let server, browser, fileServer, logs = "";

try {
  assert.ok(chrome, "Chrome/Chromium is required; set CHROME_PATH");
  mkdirSync(games, { recursive: true });
  cpSync(join(ROOT, "examples", "ember"), join(games, "ember"), { recursive: true,
    filter: path => !path.split(/[\\/]/).includes("exports") });
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
  // Browser download requests leave Playwright's page routing. Serve only the
  // synthetic response bytes from an actual disposable local HTTP endpoint.
  fileServer = createHttpServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    response.writeHead(200, { "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${path.split("/").at(-1)}"` });
    response.end(`chosen ${path}`);
  });
  await new Promise((resolveListening, reject) => {
    fileServer.once("error", reject); fileServer.listen(0, "127.0.0.1", resolveListening);
  });
  const fileOrigin = `http://127.0.0.1:${fileServer.address().port}`;
  const urls = ["bundle.forge-project.zip", "workbook.xlsx", "cards.csv"].map(name => `${fileOrigin}/test-downloads/${name}`);
  const output = { ref, urls }, statusUrl = `${origin}/test-export-status`;
  const faults = [
    ["connection", "Forge could not be reached. Try the download again."],
    ["json", "Forge returned an unreadable download response (HTTP 200). Try the download again."],
    ["http", "The export service is temporarily unavailable."],
    ["poll-connection", "Forge could not be reached. Try the download again."],
    ["poll-json", "Forge returned an unreadable download response (HTTP 200). Try the download again."],
    ["job", "Artwork needs attention before this download can be built."],
    ["incomplete", "Forge did not return a downloadable file. Try the download again."],
  ];
  for (const [kind, suffix] of [["workbook", ".xlsx"], ["cards", "/cards.csv"]]) {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage(), errors = [], downloads = [];
    let fault = "", statusReads = 0;
    page.on("pageerror", error => errors.push(error.message));
    page.on("download", download => downloads.push(download));
    await page.route(`${origin}/api/games/ember/export/data`, route => {
      if (fault === "connection") return route.abort("failed");
      if (fault === "json") return route.fulfill({ status: 200, contentType: "text/html", body: "<html>Proxy error</html>" });
      if (fault === "http") return route.fulfill({ status: 503, json: { error: faults.find(([name]) => name === "http")[1] } });
      if (fault === "incomplete") return route.fulfill({ status: 200, json: { ref } });
      if (fault.startsWith("poll-") || fault === "job" || fault === "async")
        return route.fulfill({ status: 202, json: { status: "queued", progress: 0, status_url: statusUrl } });
      return route.fulfill({ status: 200, json: output });
    });
    await page.route(statusUrl, route => {
      if (fault === "poll-connection") return route.abort("failed");
      if (fault === "poll-json") return route.fulfill({ status: 200, contentType: "text/html", body: "<html>Status unavailable</html>" });
      if (fault === "job") return route.fulfill({ status: 200, json: { status: "failed", error: faults.find(([name]) => name === "job")[1] } });
      statusReads++;
      return route.fulfill({ status: 200, json: statusReads === 1
        ? { status: "running", progress: 50, status_url: statusUrl }
        : { status: "succeeded", output } });
    });
    await page.goto(`${origin}/#g/community/ember/design`, { waitUntil: "domcontentloaded" });
    const selection = page.locator(`button[onclick^="designExportData("][onclick*="'${kind}'"]`).first();
    const selectDownload = async () => {
      await selection.waitFor({ state: "attached" });
      while (!await selection.isVisible()) {
        const section = selection.locator("xpath=ancestor::details[not(@open)]").first();
        assert.ok(await section.count(), "The selected download must be reachable through a visible editor section");
        await section.locator(":scope > summary").click();
      }
      await selection.click();
    };
    await selectDownload();
    await page.locator("#authModal").waitFor({ state: "visible" });
    await page.locator("#amHandle").fill("export-test");
    await page.locator("#amPass").fill("export-password-123");
    const selectedDownload = page.waitForEvent("download");
    await page.locator("#amSubmit").click();
    const download = await selectedDownload;
    assert.ok(download.url().endsWith(suffix), `Sign-in must retain the selected ${kind} file: ${download.url()}`);
    const saved = join(scratch, `${kind}-download`); await download.saveAs(saved);
    assert.equal(readFileSync(saved, "utf8"), `chosen ${new URL(download.url()).pathname}`);
    assert.equal(await page.evaluate(() => localStorage.getItem("forge:data-base:ember")), ref, "The data return retains its exact baseline");
    console.log(`  ✓ ${kind} selection survives real browser sign-in and downloads the chosen file`);

    if (kind === "cards") {
      for (const [name, message] of faults) {
        // Repeated connection/JSON messages must come from this attempt, not
        // from a previous toast that is still visible during a fast retry.
        await page.getByText(message, { exact: true }).last().waitFor({ state: "hidden" });
        fault = name;
        const before = downloads.length;
        await selectDownload();
        await page.getByText(message, { exact: true }).last().waitFor();
        assert.equal(downloads.length, before, `${name} must not start a download`);
        fault = "";
        const retryDownload = page.waitForEvent("download"); await selectDownload();
        assert.ok((await retryDownload).url().endsWith(suffix), `${name} leaves the original selected download retryable`);
        console.log(`  ✓ ${name} shows a truthful error and the selected download succeeds on retry`);
      }
      fault = "async";
      const completed = page.waitForEvent("download"); await selectDownload();
      assert.ok((await completed).url().endsWith(suffix));
      assert.equal(statusReads, 2, "A 200 running status keeps polling until the output succeeds");
      console.log("  ✓ Queued export retains selection through running and completed job states");
    }
    assert.deepEqual(errors, [], "Export failures never escape as unhandled browser errors");
    await context.close();
  }
  console.log("EXPORT SELECTION BROWSER GREEN — sign-in preserves the chosen file; failures remain retryable.");
} finally {
  if (browser) await browser.close();
  if (fileServer) await new Promise(resolveClosed => fileServer.close(resolveClosed));
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit"); server.kill("SIGTERM"); await stopped;
  }
  rmSync(scratch, { recursive: true, force: true });
}
