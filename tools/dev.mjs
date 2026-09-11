#!/usr/bin/env node
/** Start a persistent, loopback-only development workspace, separate from app source. */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(import.meta.dirname, ".."), data = join(root, "data");
const runtime = join(data, "dev"), lock = join(data, ".dev.lock");
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--port" && /^\d+$/.test(args[1]))) {
  console.error("Usage: npm run dev -- [--port 8420]");
  process.exit(2);
}
const port = Number(args[1] || 8420);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("Choose a development port between 1024 and 65535.");
  process.exit(2);
}
const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 20) {
  console.error("Use the qualified Node version in .nvmrc (24.20.0), then run npm run setup:dev.");
  process.exit(1);
}
const rejectLink = path => {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Development state must not be a symlink: ${path}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
};
const git = (cwd, argv) => {
  const result = spawnSync("git", argv, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "Git is unavailable; run npm run doctor.");
  return result.stdout.trim();
};
let child, ownLock = false, temporary;
const identity = JSON.stringify({ pid: process.pid, token: randomUUID() });
const cleanup = () => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  if (ownLock && existsSync(lock) && readFileSync(lock, "utf8") === identity) rmSync(lock);
};
process.on("exit", cleanup);
try {
  for (const path of [data, runtime, lock]) rejectLink(path);
  mkdirSync(data, { recursive: true });
  if (existsSync(lock)) {
    const previous = JSON.parse(readFileSync(lock, "utf8"));
    if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error("Invalid development lock; inspect data/.dev.lock before restarting.");
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
    if (alive) throw new Error("This checkout already has a running development workspace. Stop it with Ctrl+C before restarting.");
    throw new Error("The previous launcher stopped unexpectedly. Verify no Forge server still uses data/dev, then remove data/.dev.lock and restart. Your workspace has been preserved.");
  }
  writeFileSync(lock, identity, { flag: "wx", mode: 0o600 });
  ownLock = true;
  if (!existsSync(runtime)) {
    temporary = mkdtempSync(join(data, ".dev-init-"));
    const seedStore = join(temporary, "store");
    mkdirSync(join(seedStore, "examples"), { recursive: true });
    cpSync(join(root, "examples", "ember"), join(seedStore, "examples", "ember"), {
      recursive: true,
      filter: path => !path.split(/[\\/]/).some(part => part === "exports" || part === ".git" || part === ".forge"),
    });
    writeFileSync(join(seedStore, ".gitignore"), "examples/**/exports/\nexamples/**/.forge/\n");
    git(seedStore, ["init", "-q"]);
    git(seedStore, ["add", "."]);
    git(seedStore, ["-c", "user.name=Forge Development", "-c", "user.email=dev@example.invalid",
      "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", "Start local Ember workspace"]);
    writeFileSync(join(temporary, "workspace.json"), JSON.stringify({ version: 1, seed: "ember", source: git(root, ["rev-parse", "HEAD"]) }, null, 2) + "\n");
    renameSync(temporary, runtime);
    temporary = null;
  }
  for (const name of ["workspace.json", "store", "store/.git", "platform.db", "hub.html", "cache", "farm", "release-vault"]) rejectLink(join(runtime, name));
  const marker = JSON.parse(readFileSync(join(runtime, "workspace.json"), "utf8"));
  if (marker.version !== 1 || !existsSync(join(runtime, "store", ".git")))
    throw new Error("Unrecognized data/dev workspace. Preserve it and inspect it before starting Forge.");

  const origin = `http://localhost:${port}`;
  const build = git(root, ["rev-parse", "HEAD"]) + (git(root, ["status", "--porcelain"]) ? "-dirty" : "");
  const env = { ...process.env, NODE_ENV: "development", DB: "sqlite", STORE1: "local",
    LOCAL_STORE_ROOT: join(runtime, "store"), DB_PATH: join(runtime, "platform.db"),
    CACHE_DIR: join(runtime, "cache"), FARM_DIR: join(runtime, "farm"), FORGE_HUB_PATH: join(runtime, "hub.html"),
    RELEASE_VAULT_DIR: join(runtime, "release-vault"), FORGE_PUBLIC_ORIGIN: origin,
    FORGE_LISTEN_HOST: "127.0.0.1", FORGE_REGISTRATION_MODE: "open", FORGE_INVITE_MODE: "shared",
    FORGE_INCLUDE_TEST_FIXTURES: "0", FORGE_LOCAL_PRIVATE_PREVIEW: "0", FORGE_HTTPS: "0", FORGE_BUILD_ID: build,
  };
  delete env.LFS_URL;
  delete env.FORGE_ALLOWED_ORIGINS;
  console.log(`Forge local development\nOpen ${origin}/\nState: ${runtime}\nBuild: ${build}\nCtrl+C stops the server; your games and accounts stay in data/dev.\n`);
  child = spawn(process.execPath, [join(root, "server.mjs"), "--port", String(port), "--games", join(runtime, "store", "examples")],
    { cwd: root, env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.once("error", error => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1); });
} catch (error) {
  console.error(`Forge development startup failed: ${error.message}`);
  process.exitCode = 1;
}
