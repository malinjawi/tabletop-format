#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "forge-bootstrap-test-"));
try {
  const realForgejo = process.argv.includes("--real-forgejo");
  const input = join(temp, "input"), access = join(input, "access"), secret = join(input, "secret");
  mkdirSync(input, { mode: 0o700 });
  writeFileSync(access, "r2-test-access-0123456789\n", { mode: 0o600 });
  writeFileSync(secret, "r2-test-secret-9876543210\n", { mode: 0o600 });
  chmodSync(access, 0o600); chmodSync(secret, 0o600);
  const env = join(temp, "deployment", ".env"), secrets = join(temp, "deployment", ".secrets");
  const digest = letter => letter.repeat(64);
  const args = ["deploy/bootstrap.mjs", ...(realForgejo ? [] : ["--test-deterministic-secrets"]),
    "--forge-origin", "https://forge.pilot.test", "--git-origin", "https://git.forge.pilot.test",
    "--operator", "Forge Pilot Operator", "--contact", "ops@forge.test",
    "--gateway-image", `registry.forge.test/platform@sha256:${digest("a")}`,
    "--r2-account-id", "b".repeat(32), "--r2-bucket", "forge-pilot-lfs",
    "--r2-access-key-file", access, "--r2-secret-key-file", secret,
    "--backup-destination", "/mnt/forge-pilot-backups", "--env", env, "--secret-dir", secrets];
  const run = extra => spawnSync(process.execPath, [...args, ...(extra || [])], { cwd: root, encoding: "utf8" });
  const created = run();
  assert.equal(created.status, 0, created.stderr || created.stdout);
  assert.match(created.stdout, /FORGE DEPLOYMENT BOOTSTRAP READY/);
  assert.doesNotMatch(`${created.stdout}${created.stderr}`, /r2-test-(?:access|secret)/);
  assert.equal(lstatSync(env).mode & 0o777, 0o600);
  assert.equal(lstatSync(secrets).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(secrets).sort(), ["forge-db-password", "forge-token", "forgejo-internal-token",
    "forgejo-oauth2-jwt-secret", "forgejo-secret-key", "lfs-jwt-secret", "pg-super-password",
    "platform-db-password", "r2-access-key", "r2-secret-key"]);
  const values = readdirSync(secrets).filter(name => name !== "forge-token").map(name => {
    assert.equal(lstatSync(join(secrets, name)).mode & 0o777, 0o600);
    const value = readFileSync(join(secrets, name), "utf8").trim(); assert.ok(value.length >= 16); return value;
  });
  assert.equal(new Set(values).size, values.length);
  assert.equal(readFileSync(join(secrets, "forge-token"), "utf8"), "");
  const preflight = spawnSync(process.execPath, ["deploy/preflight.mjs", "--env", env, "--first-boot", "--test-no-image-inspect"],
    { cwd: root, encoding: "utf8" });
  assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
  assert.match(preflight.stdout, /PRODUCTION PREFLIGHT GREEN/);
  const overwrite = run();
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /refusing to overwrite/);
  assert.doesNotMatch(`${overwrite.stdout}${overwrite.stderr}`, /r2-test-(?:access|secret)/);
  if (!realForgejo) {
    const unsafeArgs = [...args];
    unsafeArgs[unsafeArgs.indexOf("--operator") + 1] = "Operator $(touch should-not-run)";
    const unsafeEnv = join(temp, "unsafe", ".env"), unsafeSecrets = join(temp, "unsafe", ".secrets");
    unsafeArgs[unsafeArgs.indexOf("--env") + 1] = unsafeEnv;
    unsafeArgs[unsafeArgs.indexOf("--secret-dir") + 1] = unsafeSecrets;
    const unsafe = spawnSync(process.execPath, unsafeArgs, { cwd: root, encoding: "utf8" });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /unsafe in a deployment environment file/);
    assert.equal(existsSync(unsafeEnv), false);
    assert.equal(existsSync(unsafeSecrets), false);
  }
  console.log(`DEPLOYMENT BOOTSTRAP GREEN — ${realForgejo ? "the pinned Forgejo CLI generated" : "test generation produced"} exact config and unique protected secrets atomically; overwrite is refused without disclosure.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
