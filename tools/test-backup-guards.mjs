#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "forge-backup-guards-")));
const waitFor = async path => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
};
const collect = child => new Promise(resolveChild => {
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("close", (status, signal) => resolveChild({ status, signal, stdout, stderr }));
});

try {
  const fakeBin = join(scratch, "bin"), secrets = join(scratch, "secrets");
  const destination = join(scratch, "backups"), envPath = join(scratch, "forge.env");
  mkdirSync(fakeBin); mkdirSync(secrets); mkdirSync(destination);
  writeFileSync(join(secrets, "r2-access-key"), "access-for-backup-guard\n");
  writeFileSync(join(secrets, "r2-secret-key"), "secret-for-backup-guard\n");
  writeFileSync(envPath, [
    "R2_ACCOUNT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "R2_LFS_BUCKET=forge-test-lfs",
    `FORGE_SECRET_DIR=${secrets}`,
    "FORGE_RELEASE_VAULT_VOLUME=forge-release-vault-guard",
    "",
  ].join("\n"));
  const fakeDocker = join(fakeBin, "docker");
  writeFileSync(fakeDocker, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *" ps --status running --services") printf 'db\\nforgejo\\ngateway\\n' ;;
  *" ps -q gateway") printf 'fake-gateway\\n' ;;
  *"{{range .Mounts}}"*) printf 'forge-release-vault-guard\\n' ;;
  *"{{.Image}}"*) printf 'sha256:%s\\n' "$(printf a%.0s $(seq 1 64))" ;;
  *" stop gateway forgejo")
    : > "$FAKE_STOP_MARKER"
    sleep "\${FAKE_STOP_SLEEP:-0}"
    exit "\${FAKE_STOP_STATUS:-0}"
    ;;
  *" up -d forgejo gateway") : > "$FAKE_RESTART_MARKER" ;;
  *) exit 23 ;;
esac
`, { mode: 0o700 });
  chmodSync(fakeDocker, 0o700);

  const baseEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FORGE_ENV_FILE: envPath,
    FORGE_BACKUP_ACK_DOWNTIME: "1",
    FORGE_COMPOSE_PROJECT: "forge-guard-test",
    FAKE_DOCKER_LOG: join(scratch, "docker.log"),
  };

  const firstStop = join(scratch, "first-stop"), firstRestart = join(scratch, "first-restart");
  const first = spawn("bash", ["deploy/backup.sh", destination], {
    cwd: root, env: { ...baseEnv, FAKE_STOP_MARKER: firstStop, FAKE_RESTART_MARKER: firstRestart,
      FAKE_STOP_SLEEP: "1", FAKE_STOP_STATUS: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const firstResult = collect(first);
  await waitFor(firstStop);
  const second = spawnSync("bash", ["deploy/backup.sh", destination], {
    cwd: root, env: { ...baseEnv, FAKE_STOP_MARKER: join(scratch, "second-stop"),
      FAKE_RESTART_MARKER: join(scratch, "second-restart"), FAKE_STOP_SLEEP: "0", FAKE_STOP_STATUS: "0" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /another backup owns the write outage/);
  assert.equal(existsSync(join(scratch, "second-stop")), false,
    "a rejected concurrent backup must not touch service state");
  const completedFirst = await firstResult;
  assert.notEqual(completedFirst.status, 0, "the fake snapshot intentionally ends the first backup");
  assert.equal(existsSync(firstRestart), true, "the failed backup must restart writers");

  const partialStop = join(scratch, "partial-stop"), partialRestart = join(scratch, "partial-restart");
  const partial = spawnSync("bash", ["deploy/backup.sh", destination], {
    cwd: root, env: { ...baseEnv, FAKE_STOP_MARKER: partialStop, FAKE_RESTART_MARKER: partialRestart,
      FAKE_STOP_SLEEP: "0", FAKE_STOP_STATUS: "17" }, encoding: "utf8", timeout: 10_000,
  });
  assert.notEqual(partial.status, 0);
  assert.equal(existsSync(partialStop), true);
  assert.equal(existsSync(partialRestart), true,
    `restart was not attempted after a partial stop failure:\n${partial.stderr}`);
  assert.match(readFileSync(join(scratch, "docker.log"), "utf8"), /up -d forgejo gateway/);

  console.log("BACKUP GUARDS GREEN — concurrent outages fail closed and a partial stop always arms service restart.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
