#!/usr/bin/env node
/** Real-browser artwork loading, retry, and navigation regressions in a disposable game store. */
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
async function imageState(image, state) {
  await image.locator(`:scope[data-image-state="${state}"]`).waitFor();
  assert.equal(await image.getAttribute("aria-busy"), state === "loading" ? "true" : "false");
  if (state === "ready") {
    const img = image.locator("img");
    assert.ok(await img.evaluate(async element => {
      await element.decode(); return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
    }), "Ready means the browser decoded real image pixels");
    await image.page().waitForFunction(element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return Number(style.opacity) > 0 && style.visibility === "visible" && style.display !== "none" && box.width > 0 && box.height > 0;
    }, await img.elementHandle());
  }
}
const documentBox = locator => locator.evaluate(element => {
  const box = element.getBoundingClientRect();
  return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height };
});
function stableBox(before, after, description) {
  for (const key of Object.keys(before)) assert.ok(Math.abs(before[key] - after[key]) < 1,
    `${description}: ${key} changed from ${before[key]} to ${after[key]}`);
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
      const manifest = yaml.load(content); manifest.families[0].match = {};
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
  const png = readFileSync(join(games, "ember", "assets", "art", "kindling.png"));
  // Distinct URLs exercise pagination and image lifecycles without copying 90
  // artwork files. All bytes remain the rights-cleared, local Ember fixture.
  const fixtureItems = count => Array.from({ length: count }, (_, index) => {
    const suffix = index === 5 ? ' artist\'s "study"' : index === 6 ? ' " data-injected="unsafe' : "";
    const name = `loading-${String(index).padStart(3, "0")}${suffix}.png`;
    return { path: `assets/art/${name}`, name, kind: "image", category: "art", size: png.length,
      url: `/api/games/ember/assets/art/${encodeURIComponent(name)}?ref=${ref}`, packages: [], used_by: [], tags: [], editable: false };
  });
  const items = fixtureItems(90);
  const metadata = { commit: ref, count: items.length, items, categories: [{ name: "art", count: items.length }],
    access: { can_write: false, signed_in: false, requires_fork: false } };

  async function withPage(description, run) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [], gates = [];
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    const network = { metadataReads: 0, metadata, metadataFault: false, imageReads: new Map(), faults: new Map(), metadataGate: null, imageGate: null };
    const gate = () => { const value = deferred(); gates.push(value); return value; };
    await page.route(`${origin}/api/games/ember/repository/assets**`, async route => {
      network.metadataReads++;
      const waiting = network.metadataGate;
      if (waiting) await waiting.promise;
      await route.fulfill(network.metadataFault ? { status: 503, json: { error: "Artwork index temporarily unavailable" } }
        : { status: 200, json: network.metadata }).catch(error => { if (!page.isClosed()) throw error; });
    });
    await page.route(`${origin}/api/games/ember/assets/art/loading-*.png*`, async route => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1);
      network.imageReads.set(name, (network.imageReads.get(name) || 0) + 1);
      const waiting = network.imageGate, fault = network.faults.get(name);
      if (waiting) await waiting.promise;
      const response = fault === "missing" ? { status: 404, contentType: "text/plain", body: "Missing artwork" }
        : fault === "corrupt" ? { status: 200, contentType: "image/png", body: "These are not PNG pixels" }
        : { status: 200, contentType: "image/png", body: png };
      await route.fulfill(response).catch(error => { if (!page.isClosed()) throw error; });
    });
    try {
      await run({ page, network, gate });
      assert.deepEqual(errors, [], `${description}: no unhandled browser errors`);
      console.log(`  ✓ ${description}`);
    } catch (error) {
      console.error(`${description}\n${errors.join("\n")}\n${(await page.locator("body").innerText()).slice(-6000)}\n${logs.slice(-4000)}`);
      throw error;
    } finally {
      for (const waiting of gates) waiting.release();
      await context.close();
    }
  }
  const tile = (page, index) => page.locator(`article.asset-tile[data-asset-path=${JSON.stringify(items[index].path)}]`);
  async function openStudio(page) {
    await page.goto(`${origin}/#g/community/ember/design`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Open Forge Studio", exact: true }).click();
    await page.locator("#authModal").waitFor({ state: "visible" });
    await page.locator("#amHandle").fill("artwork-test");
    await page.locator("#amPass").fill("artwork-password-123");
    await page.locator("#amSubmit").click();
    await page.getByRole("button", { name: "Choose library", exact: true }).waitFor();
  }
  const settleFrames = page => page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  const metadataResponse = page => page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/repository/assets"));

  await withPage("Slow artwork reserves space; decoded thumbnails survive pagination and filtering", async ({ page, network, gate }) => {
    network.metadataGate = gate(); network.imageGate = gate();
    await page.goto(`${origin}/#g/community/ember/assets`, { waitUntil: "domcontentloaded" });
    await until(() => network.metadataReads === 1, "Assets metadata request starts");
    assert.match(await page.locator("#pane").innerText(), /reading|loading/i, "Slow metadata has visible progress");
    assert.equal(await page.locator("article.asset-tile").count(), 0);
    network.metadataGate.release();
    await tile(page, 0).waitFor();
    assert.equal(await page.locator("article.asset-tile").count(), 80, "First page is bounded to 80 tiles");
    const thumbnail = tile(page, 0).locator(".forge-image");
    await imageState(thumbnail, "loading");
    const box = await documentBox(tile(page, 0));
    await page.mouse.wheel(0, 10000);
    await tile(page, 79).scrollIntoViewIfNeeded();
    const lastBox = await documentBox(tile(page, 79));
    network.imageGate.release();
    await imageState(tile(page, 79).locator(".forge-image"), "ready");
    stableBox(lastBox, await documentBox(tile(page, 79)), "Scrolling into a loaded image cannot move its tile");
    await tile(page, 0).scrollIntoViewIfNeeded();
    await imageState(thumbnail, "ready");
    await page.mouse.move(0, 0);
    stableBox(box, await documentBox(tile(page, 0)), "Decoded images retain their reserved layout");
    const oldTile = await tile(page, 0).elementHandle(), oldImage = await thumbnail.locator("img").elementHandle();
    const imageReads = network.imageReads.get(items[0].name);
    const quotedTile = await tile(page, 5).elementHandle();
    assert.equal(await tile(page, 5).getAttribute("data-asset-path"), items[5].path, "Quoted paths stay intact in HTML attributes");
    await tile(page, 5).getByRole("group", { name: `${items[5].name} preview`, exact: true }).waitFor();
    assert.equal(await tile(page, 6).getAttribute("data-asset-path"), items[6].path);
    assert.equal(await page.locator("[data-injected]").count(), 0, "Filename text cannot create extra HTML attributes");
    await page.getByRole("button", { name: /show 10 more/i }).click();
    await tile(page, 89).waitFor();
    assert.equal(await page.locator("article.asset-tile").count(), 90);
    assert.ok(await oldTile.evaluate(element => element.isConnected), "Show more keeps existing tile nodes");
    assert.ok(await oldImage.evaluate(element => element.isConnected), "Show more keeps decoded thumbnail nodes");
    const input = page.locator("#assetq");
    await input.click();
    const oldInput = await input.elementHandle();
    await input.pressSequentially("loading-0");
    assert.equal(await input.inputValue(), "loading-0");
    assert.ok(await oldInput.evaluate(element => element.isConnected && document.activeElement === element),
      "Typing preserves the focused search input itself");
    assert.ok(await oldImage.evaluate(element => element.isConnected), "Matching decoded thumbnails survive filtering");
    assert.ok(await quotedTile.evaluate(element => element.isConnected), "Quoted filename tiles also survive pagination and filtering");
    await imageState(thumbnail, "ready"); await settleFrames(page);
    assert.equal(network.imageReads.get(items[0].name), imageReads, "Pagination and filtering do not reload retained artwork");
    assert.equal(network.metadataReads, 1, "Pagination and cached filtering do not refetch metadata");
  });

  await withPage("404 and corrupt HTTP 200 artwork show retryable errors instead of blank ready tiles", async ({ page, network, gate }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    network.faults.set(items[0].name, "missing"); network.faults.set(items[1].name, "corrupt");
    await page.goto(`${origin}/#g/community/ember/assets`, { waitUntil: "domcontentloaded" });
    for (const index of [0, 1]) {
      await page.setViewportSize({ width: index === 0 ? 390 : 320, height: 844 });
      const wrapper = tile(page, index).locator(".forge-image");
      await imageState(wrapper, "error");
      const height = (await wrapper.boundingBox()).height, retry = wrapper.locator(".forge-image-retry");
      assert.ok((await retry.boundingBox()).height >= 44, "Mobile artwork Retry has a 44px tap target");
      const viewport = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth,
        overflowing: [...document.querySelectorAll("#pane *,#top *,nav.tabs")].filter(element => element.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 8).map(element => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right })) }));
      assert.ok(Math.max(viewport.body, viewport.document) <= viewport.width + 1,
        `The Assets page does not overflow a narrow viewport: ${JSON.stringify(viewport)}`);
      const before = network.imageReads.get(items[index].name);
      network.faults.delete(items[index].name);
      network.imageGate = gate();
      await retry.focus(); await retry.press("Enter");
      await imageState(wrapper, "loading");
      assert.equal((await wrapper.boundingBox()).height, height, "Retry loading preserves the failed image's reserved height");
      assert.equal(await wrapper.locator(".forge-image-loading").evaluate(element => getComputedStyle(element).animationName), "none",
        "The loading shimmer respects reduced-motion preferences");
      network.imageGate.release(); network.imageGate = null;
      await imageState(wrapper, "ready");
      assert.equal((await wrapper.boundingBox()).height, height, "Successful mobile retry preserves the same preview height");
      assert.ok(network.imageReads.get(items[index].name) > before, "Retry requests the failed artwork again");
      assert.equal(await page.locator("#modal.on").count(), 0, "Retry does not accidentally open asset details");
    }
  });

  await withPage("An unavailable artwork index shows an error and can be retried without leaving Assets", async ({ page, network }) => {
    network.metadataFault = true;
    await page.goto(`${origin}/#g/community/ember/assets`, { waitUntil: "domcontentloaded" });
    await page.locator('#pane [role="alert"]').waitFor();
    assert.match(await page.locator("#pane").innerText(), /Artwork index temporarily unavailable/);
    network.metadataFault = false;
    await page.locator("#pane").getByRole("button", { name: "Retry", exact: true }).click();
    await tile(page, 0).waitFor();
    assert.equal(network.metadataReads, 2);
    assert.equal(await page.locator("article.asset-tile").count(), 80);
  });

  await withPage("A delayed Assets response cannot overwrite the Cards page after navigation", async ({ page, network, gate }) => {
    network.metadataGate = gate();
    await page.goto(`${origin}/#g/community/ember/assets`, { waitUntil: "domcontentloaded" });
    await until(() => network.metadataReads === 1, "The delayed Assets request is in flight");
    await page.getByRole("navigation", { name: "Game workspace" }).getByRole("link", { name: /^Cards/ }).click();
    await page.locator("#cardq").waitFor();
    const cardsPane = await page.locator("#cardq").elementHandle();
    const response = metadataResponse(page);
    network.metadataGate.release();
    await response;
    await settleFrames(page);
    assert.ok(await cardsPane.evaluate(element => element.isConnected), "Late Assets metadata must not replace Cards content");
    assert.equal(await page.locator(".asset-grid").count(), 0);
    assert.ok(new URL(page.url()).hash.endsWith("/cards"));
  });

  await withPage("Asset details open before history arrives; closing and choosing another file rejects stale history", async ({ page, gate }) => {
    const historyGate = gate(); let firstHistoryReads = 0;
    await page.route(`${origin}/api/games/ember/repository/history/**`, async route => {
      const first = route.request().url().includes(items[0].name);
      if (first) { firstHistoryReads++; await historyGate.promise; }
      await route.fulfill({ status: 200, json: { history: [{ sha: ref.slice(0, 7),
        subject: first ? "First file history" : "Second file history", author: "Fixture", date: "2026-01-01" }] } });
    });
    await page.goto(`${origin}/#g/community/ember/assets`, { waitUntil: "domcontentloaded" });
    const open = tile(page, 0).getByRole("button", { name: `Open ${items[0].name}`, exact: true });
    await open.focus(); await open.press("Enter");
    const first = page.locator("#asset-detail-content");
    await first.waitFor();
    await until(() => firstHistoryReads === 1, "The history request begins after the detail shell opens");
    assert.match(await first.locator("[data-asset-history]").innerText(), /loading/i);
    await imageState(first.locator(".asset-detail-image"), "ready");
    await page.getByRole("button", { name: "Close asset details" }).click();
    await tile(page, 1).click();
    await page.getByText("Second file history", { exact: true }).waitFor();
    const second = await page.locator("#asset-detail-content").elementHandle();
    const response = page.waitForResponse(value => value.url().includes(`/repository/history/${items[0].path}`));
    historyGate.release(); await response; await settleFrames(page);
    assert.ok(await second.evaluate(element => element.isConnected));
    assert.equal(await page.getByText("First file history", { exact: true }).count(), 0);
    assert.equal(await page.locator("#asset-detail-content h2").innerText(), items[1].name);
    await page.getByRole("button", { name: "Close asset details" }).click();
    await tile(page, 5).click();
    await page.locator("#asset-detail-content").getByRole("heading", { name: items[5].name, exact: true }).waitFor();
    const download = await page.locator("#asset-detail-content a[download]").getAttribute("href");
    assert.ok(decodeURIComponent(new URL(download, origin).pathname).endsWith(items[5].path), "Quoted and apostrophe paths open the correct detail download");
  });

  await withPage("Studio library closes while loading and cached front/back filtering keeps focused inputs and decoded images", async ({ page, network, gate }) => {
    await openStudio(page);
    network.metadataGate = gate();
    await page.getByRole("button", { name: "Choose library", exact: true }).click();
    const picker = page.locator('.forge-art-picker[data-art-face="front"]');
    await picker.locator(':scope[data-art-state="loading"]').waitFor();
    await until(() => network.metadataReads === 1, "Studio artwork metadata starts");
    assert.equal(await picker.locator(".forge-art-library").getAttribute("aria-busy"), "true");
    await picker.getByRole("button", { name: "× Close", exact: true }).click();
    await page.getByRole("button", { name: "Table", exact: true }).click();
    const table = await page.locator("#des-data-rows").elementHandle();
    const response = metadataResponse(page);
    network.metadataGate.release(); await response; await settleFrames(page);
    assert.ok(await table.evaluate(element => element.isConnected), "Late artwork data cannot replace an unrelated modal");
    assert.equal(await page.locator("#modal.on .forge-art-picker").count(), 0);
    await page.locator("#mbody").getByRole("button", { name: "× Close", exact: true }).click();
    for (const face of ["front", "back"]) {
      if (face === "back") {
        await page.getByRole("group", { name: "Card face" }).getByRole("button", { name: "Back", exact: true }).click();
        await page.locator('[data-design-region="back_title"]').click();
      }
      await page.getByRole("button", { name: face === "front" ? "Choose library" : "Choose back artwork", exact: true }).click();
      const current = page.locator(`.forge-art-picker[data-art-face="${face}"][data-art-state="ready"]`);
      await current.waitFor();
      assert.equal(await current.locator(".forge-art-library").getAttribute("aria-busy"), "false");
      if (face === "front") {
        for (const target of await current.locator("[data-art-target]").all()) await target.uncheck();
        assert.equal(await current.locator("[data-art-upload]").isDisabled(), true, "No selected printing disables artwork upload");
        await current.locator("[data-art-target]").first().check();
        assert.equal(await current.locator("[data-art-upload]").isDisabled(), false, "Choosing a target enables artwork upload");
      }
      const matching = current.locator(`article.forge-art-item[data-art-path="${items[0].path}"]`);
      await matching.scrollIntoViewIfNeeded();
      await imageState(matching.locator(".forge-image"), "ready");
      const oldImage = await matching.locator("img").elementHandle();
      const imageReads = network.imageReads.get(items[0].name);
      const filter = current.getByRole("searchbox", { name: "Filter artwork" });
      await filter.click(); const oldInput = await filter.elementHandle();
      await filter.pressSequentially("loading-00");
      assert.equal(await filter.inputValue(), "loading-00");
      assert.ok(await oldInput.evaluate(element => element.isConnected && document.activeElement === element), `${face} search retains its focused DOM node`);
      assert.ok(await oldImage.evaluate(element => element.isConnected), `${face} matching image stays decoded while filtering`);
      assert.equal(await current.locator("article.forge-art-item:visible").count(), 10);
      await filter.fill("nothing-matches-this-file");
      await current.getByText("No artwork matches this filter.", { exact: true }).waitFor();
      await filter.fill("loading-00");
      assert.ok(await oldImage.evaluate(element => element.isConnected), `${face} cached images survive filtering out and back in`);
      await imageState(matching.locator(".forge-image"), "ready");
      await settleFrames(page);
      assert.equal(network.imageReads.get(items[0].name), imageReads, `${face} filtering never reloads the retained artwork`);
      assert.equal(network.metadataReads, 1, "Reopening and cached front/back filters share one metadata result");
      await current.getByRole("button", { name: "× Close", exact: true }).click();
    }
  });

  await withPage("Switching from a loading front library to the back library keeps the current picker and coalesces requests", async ({ page, network, gate }) => {
    await openStudio(page); network.metadataGate = gate();
    const largeItems = fixtureItems(420);
    network.metadata = { ...metadata, items: largeItems, count: largeItems.length, categories: [{ name: "art", count: largeItems.length }] };
    await page.getByRole("button", { name: "Choose library", exact: true }).click();
    const front = page.locator('.forge-art-picker[data-art-face="front"]');
    await front.locator(':scope[data-art-state="loading"]').waitFor();
    await until(() => network.metadataReads === 1, "First artwork library request is held");
    await front.getByRole("button", { name: "× Close", exact: true }).click();
    await page.getByRole("group", { name: "Card face" }).getByRole("button", { name: "Back", exact: true }).click();
    await page.locator('[data-design-region="back_title"]').click();
    await page.getByRole("button", { name: "Choose back artwork", exact: true }).click();
    const back = page.locator('.forge-art-picker[data-art-face="back"]');
    await back.locator(':scope[data-art-state="loading"]').waitFor();
    const filter = back.getByRole("searchbox", { name: "Filter artwork" });
    await filter.fill("loading-00"); const oldInput = await filter.elementHandle();
    network.metadataGate.release();
    await back.locator(':scope[data-art-state="ready"]').waitFor();
    assert.ok(await oldInput.evaluate(element => element.isConnected && document.activeElement === element), "Pending filter input survives metadata completion");
    assert.equal(await filter.inputValue(), "loading-00");
    assert.equal(await back.locator("article.forge-art-item:visible").count(), 10);
    assert.equal(await page.locator('.forge-art-picker[data-art-face="front"]').count(), 0);
    assert.equal(network.metadataReads, 1, "Front and back requests share the same pending metadata read");
    await filter.fill("loading-1");
    let retained;
    for (const query of ["loading-0", "loading-2", "loading-3", "loading-1"]) {
      await filter.fill(query);
      const visible = await back.locator("article.forge-art-item").evaluateAll(tiles => tiles.filter(tile => !tile.hidden).map(tile => tile.dataset.artPath));
      assert.deepEqual(visible, largeItems.filter(item => item.name.includes(query)).map(item => item.path),
        "Displayed artwork remains in the same sorted DOM order for keyboard navigation");
      assert.ok(await back.locator("article.forge-art-item").count() <= 320, "Filtering does not accumulate an unbounded hidden library");
      if (query === "loading-2") {
        const warmImage = back.locator('[data-art-path="assets/art/loading-200.png"] .forge-image');
        await warmImage.scrollIntoViewIfNeeded(); await imageState(warmImage, "ready");
        retained = await warmImage.locator("img").elementHandle();
      }
    }
    assert.ok(await retained.evaluate(element => element.isConnected), "A recent decoded image stays within the bounded warm cache");
    assert.equal(network.metadataReads, 1, "Large-library filtering is still local");
  });

  console.log("ARTWORK LOADING BROWSER GREEN — Assets and Studio loading, retry, filtering, and navigation verified.");
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit"); server.kill("SIGTERM"); await stopped;
  }
  rmSync(scratch, { recursive: true, force: true });
}
