#!/usr/bin/env node
/** Prove the operator CLI and production registration route as one workflow. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "forge-pilot-invite-test-"));
const dbPath = join(temp, "platform.db"), games = join(temp, "games");
mkdirSync(games);
const port = 46_000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
let server;
let browser;
const chrome = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync);
const runCli = (...args) => spawnSync(process.execPath, ["tools/pilot-invite.mjs", ...args, "--db", dbPath],
  { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
const runAccountCli = (...args) => spawnSync(process.execPath, ["tools/pilot-account.mjs", ...args, "--db", dbPath],
  { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
const api = async (body) => {
  const response = await fetch(`${origin}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json", "x-forge-browser": "1" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const request = async (method, path, { body, token, browserRequest = false } = {}) => {
  const response = await fetch(`${origin}${path}`, { method, headers: {
    ...(body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(browserRequest ? { "x-forge-browser": "1" } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
};

try {
  assert.ok(chrome, "Chrome/Chromium is required for the pilot registration proof");
  const issued = runCli("create", "--label", "Amina designer", "--cohort", "beta-01", "--hours", "24");
  assert.equal(issued.status, 0, issued.stderr);
  const token = issued.stdout.match(/(?:^|\s)(fpi_[A-Za-z0-9_-]{32})(?=\s|$)/m)?.[1];
  assert.ok(token, "CLI prints the one-time invitation token");
  const inspected = new DatabaseSync(dbPath);
  const stored = inspected.prepare("SELECT token_hash FROM pilot_invites").get();
  inspected.close();
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.token_hash, token, "database keeps only the token digest");

  server = spawn(process.execPath, ["server.mjs", "--port", String(port), "--games", games], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath,
      FORGE_PUBLIC_ORIGIN: origin,
      FORGE_LISTEN_HOST: "127.0.0.1", FORGE_REGISTRATION_MODE: "invite", FORGE_INVITE_MODE: "database",
      FORGE_OPERATOR_NAME: "Forge Pilot Operator", FORGE_CONTACT_EMAIL: "ops@forge.test",
      FORGE_HUB_PATH: join(temp, "hub.html"), CACHE_DIR: join(temp, "cache"), FARM_DIR: join(temp, "farm") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startup = "";
  server.stdout.on("data", chunk => { startup += chunk; });
  server.stderr.on("data", chunk => { startup += chunk; });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${origin}/healthz`)).ok) { healthy = true; break; } } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  assert.ok(healthy, startup || "server did not become healthy");
  const health = await (await fetch(`${origin}/healthz`)).json();
  assert.equal(health.registration, "invite");
  assert.equal(health.password_min, 8);
  const shell = await (await fetch(`${origin}/`)).text();
  assert.match(shell, /id="amInvite"/);
  assert.match(shell, /body\.invite_code=inviteField/);

  const invalid = await api({ handle: "intruder", email: "intruder@example.com",
    password: "correct-horse-11", invite_code: "wrong-token" });
  assert.equal(invalid.status, 403);
  assert.equal(invalid.body.error, "invite is invalid or no longer available");

  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => REGISTRATION === "invite");
  await page.locator("#authArea button").click();
  await page.locator("#amSwitch").click();
  assert.notEqual(await page.locator("#amInvite").evaluate(element => getComputedStyle(element).display), "none");
  assert.equal(await page.locator("#amPass").getAttribute("placeholder"), "password (8+ chars)");
  await page.locator("#amHandle").fill("amina");
  await page.locator("#amEmail").fill("amina@example.com");
  await page.locator("#amPass").fill("correct-horse-12");
  await page.locator("#amInvite").fill(token);
  const registrationResponse = page.waitForResponse(response => response.url().endsWith("/api/auth/register"));
  await page.locator("#authModal button.primary").click();
  const browserRegistration = await registrationResponse;
  assert.equal(browserRegistration.status(), 201, await browserRegistration.text());
  await page.locator("#authArea").getByText("@amina").waitFor();
  assert.equal(await page.locator("#amInvite").inputValue(), "", "browser clears the bearer token immediately");
  assert.equal(await page.locator("#amPass").inputValue(), "", "browser clears the password immediately");
  await browser.close(); browser = null;

  const oldLogin = await request("POST", "/api/auth/login", { body: {
    handle: "amina", password: "correct-horse-12",
  } });
  assert.equal(oldLogin.status, 200);
  const oldSession = oldLogin.body.token;

  const resetIssued = runAccountCli("reset", "--handle", "amina", "--hours", "1");
  assert.equal(resetIssued.status, 0, resetIssued.stderr);
  const resetToken = resetIssued.stdout.match(/(?:^|\s)(fpr_[A-Za-z0-9_-]{32})(?=\s|$)/m)?.[1];
  assert.ok(resetToken, "operator CLI prints the one-time recovery token");
  const resetDb = new DatabaseSync(dbPath);
  const storedReset = resetDb.prepare("SELECT token_hash FROM password_reset_tokens").get();
  resetDb.close();
  assert.match(storedReset.token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(storedReset.token_hash, resetToken, "database keeps only the recovery-token digest");

  const invalidReset = await request("POST", "/api/auth/password-reset", { body: {
    reset_token: "not-a-reset", password: "correct-horse-14",
  }, browserRequest: true });
  assert.equal(invalidReset.status, 403);
  assert.equal(invalidReset.body.error, "reset is invalid or no longer available");

  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const recoveryPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await recoveryPage.goto(`${origin}/`, { waitUntil: "networkidle" });
  await recoveryPage.locator("#authArea button").click();
  await recoveryPage.locator("#amResetLink").click();
  assert.ok(await recoveryPage.locator("#amResetToken").isVisible());
  assert.ok(await recoveryPage.locator("#amPassConfirm").isVisible());
  await recoveryPage.locator("#amResetToken").fill(resetToken);
  await recoveryPage.locator("#amPass").fill("correct-horse-14");
  await recoveryPage.locator("#amPassConfirm").fill("correct-horse-14");
  const resetResponse = recoveryPage.waitForResponse(response => response.url().endsWith("/api/auth/password-reset"));
  await recoveryPage.locator("#authModal button.primary").click();
  const browserReset = await resetResponse;
  assert.equal(browserReset.status(), 200, await browserReset.text());
  assert.equal(await recoveryPage.locator("#amResetToken").inputValue(), "");
  assert.equal(await recoveryPage.locator("#amPass").inputValue(), "");
  assert.ok(await recoveryPage.locator("#amHandle").isVisible(), "successful recovery returns to sign in");
  await browser.close(); browser = null;

  assert.equal((await request("GET", "/api/me", { token: oldSession })).status, 401,
    "password recovery revokes the old bearer session");
  const rejectedOldPassword = await request("POST", "/api/auth/login", { body: {
    handle: "amina", password: "correct-horse-12",
  } });
  assert.equal(rejectedOldPassword.status, 401, "old password stops working");
  const recoveredLogin = await request("POST", "/api/auth/login", { body: {
    handle: "amina", password: "correct-horse-14",
  } });
  assert.equal(recoveredLogin.status, 200, "new password works");
  const resetReplay = await request("POST", "/api/auth/password-reset", { body: {
    reset_token: resetToken, password: "correct-horse-15",
  }, browserRequest: true });
  assert.equal(resetReplay.status, 403);
  const resetList = runAccountCli("resets");
  assert.equal(resetList.status, 0, resetList.stderr);
  assert.match(resetList.stdout, /redeemed[\s\S]*amina/);
  assert.doesNotMatch(resetList.stdout, /fpr_|[a-f0-9]{64}/i);

  const outstandingReset = runAccountCli("reset", "--handle", "amina", "--hours", "1");
  assert.equal(outstandingReset.status, 0, outstandingReset.stderr);
  const outstandingToken = outstandingReset.stdout.match(/(?:^|\s)(fpr_[A-Za-z0-9_-]{32})(?=\s|$)/m)?.[1];
  assert.ok(outstandingToken);
  const suspended = runAccountCli("suspend", "--handle", "amina", "--operator", "Forge Pilot Operator",
    "--reason", "participant requested access pause");
  assert.equal(suspended.status, 0, suspended.stderr);
  assert.match(suspended.stdout, /every session and outstanding recovery token was revoked/);
  assert.equal((await request("GET", "/api/me", { token: recoveredLogin.body.token })).status, 401,
    "suspension immediately invalidates an existing bearer session");
  const suspendedLogin = await request("POST", "/api/auth/login", { body: {
    handle: "amina", password: "correct-horse-14",
  } });
  assert.equal(suspendedLogin.status, 401);
  assert.equal(suspendedLogin.body.error, rejectedOldPassword.body.error,
    "suspension does not disclose account status through login");
  assert.equal((await request("POST", "/api/auth/password-reset", { body: {
    reset_token: outstandingToken, password: "correct-horse-15",
  }, browserRequest: true })).status, 403, "suspension revokes already-issued recovery");
  const resetWhileSuspended = runAccountCli("reset", "--handle", "amina");
  assert.equal(resetWhileSuspended.status, 2);
  assert.match(resetWhileSuspended.stderr, /account is suspended/);
  const suspendedStatus = runAccountCli("status", "--handle", "amina");
  assert.equal(suspendedStatus.status, 0, suspendedStatus.stderr);
  assert.match(suspendedStatus.stdout, /amina\tsuspended[\s\S]*Forge Pilot Operator[\s\S]*participant requested access pause/);
  assert.doesNotMatch(suspendedStatus.stdout, /@|fpr_|[a-f0-9]{64}/i);

  const restored = runAccountCli("restore", "--handle", "amina", "--operator", "Forge Pilot Operator",
    "--reason", "participant confirmed return");
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /no session or password was created/);
  assert.equal((await request("POST", "/api/auth/login", { body: {
    handle: "amina", password: "correct-horse-14",
  } })).status, 200, "restoration re-enables login with the unchanged password");
  const restoredStatus = runAccountCli("status", "--handle", "amina");
  assert.match(restoredStatus.stdout, /amina\tactive[\s\S]*restore[\s\S]*suspend/);
  assert.doesNotMatch(restoredStatus.stdout, /@|fpr_|[a-f0-9]{64}/i);

  const replay = await api({ handle: "replay", email: "replay@example.com",
    password: "correct-horse-13", invite_code: token });
  assert.equal(replay.status, 403);
  assert.equal(replay.body.error, invalid.body.error);

  const listed = runCli("list");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /redeemed[\s\S]*Amina designer[\s\S]*amina/);
  assert.doesNotMatch(listed.stdout, /fpi_|[a-f0-9]{64}/i);
  console.log("PILOT ACCOUNT ACCESS GREEN — single-use admission, recovery, suspension, and restoration are auditable and safe.");
} finally {
  if (browser) await browser.close();
  if (server && !server.killed) server.kill("SIGTERM");
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  rmSync(temp, { recursive: true, force: true });
}
