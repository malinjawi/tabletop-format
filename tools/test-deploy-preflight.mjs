#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "forge-preflight-test-"));
try {
  const secretDir = join(temp, "secrets"), envPath = join(temp, "production.env");
  mkdirSync(secretDir, { mode: 0o700 });
  const names = ["forge-token", "pg-super-password", "forge-db-password", "platform-db-password",
    "forgejo-secret-key", "forgejo-internal-token", "forgejo-oauth2-jwt-secret", "lfs-jwt-secret",
    "r2-access-key", "r2-secret-key"];
  names.forEach((name, index) => {
    const path = join(secretDir, name);
    writeFileSync(path, `test-secret-${String(index).padStart(2, "0")}-0123456789abcdef\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  });
  const digest = letter => `${letter}`.repeat(64);
  writeFileSync(envPath, [
    "FORGE_PUBLIC_ORIGIN=https://forge.pilot.test",
    "FORGEJO_PUBLIC_ORIGIN=https://git.forge.pilot.test",
    "FORGE_BIND_IP=127.0.0.1",
    "FORGEJO_BIND_PORT=3000",
    `FORGE_SECRET_DIR=${secretDir}`,
    "FORGE_REGISTRATION_MODE=invite",
    "FORGE_INVITE_CODE=0123456789abcdef0123456789abcdef",
    "FORGE_OPERATOR_NAME=Forge Pilot Operator",
    "FORGE_CONTACT_EMAIL=ops@forge.test",
    "ACME_EMAIL=tls@forge.test",
    `FORGE_GATEWAY_IMAGE=registry.forge.test/platform@sha256:${digest("a")}`,
    `FORGEJO_IMAGE=codeberg.org/forgejo/forgejo@sha256:${digest("b")}`,
    "FORGEJO_VERSION=15.0.7",
    `POSTGRES_IMAGE=postgres@sha256:${digest("c")}`,
    "POSTGRES_MAJOR=16",
    `R2_ACCOUNT_ID=${"d".repeat(32)}`,
    "R2_LFS_BUCKET=forge-pilot-lfs",
    "FORGE_BACKUP_DESTINATION=/mnt/forge-pilot-backups",
    "",
  ].join("\n"), { mode: 0o600 });

  const run = () => spawnSync(process.execPath, ["deploy/preflight.mjs", "--env", envPath, "--test-no-image-inspect"],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const passing = run();
  assert.equal(passing.status, 0, passing.stderr || passing.stdout);
  assert.match(passing.stdout, /PRODUCTION PREFLIGHT GREEN/);
  assert.doesNotMatch(passing.stdout, /test-secret-/);

  chmodSync(join(secretDir, "r2-secret-key"), 0o644);
  const unsafe = run();
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stdout, /secret r2-secret-key permissions: mode 644/);
  assert.match(unsafe.stderr, /PRODUCTION PREFLIGHT FAILED/);
  assert.doesNotMatch(`${unsafe.stdout}${unsafe.stderr}`, /test-secret-/);
  console.log("PRODUCTION PREFLIGHT TEST GREEN — strict host settings pass; unsafe secret permissions fail without disclosure.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
