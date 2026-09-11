#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, ".."), venv = join(root, ".venv");
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor !== 24 || nodeMinor < 20) {
  console.error("Forge development uses Node 24.20.0 (.nvmrc). Select that version before installing dependencies.");
  process.exit(1);
}
const python = process.env.FORGE_BOOTSTRAP_PYTHON || "python3";
const venvPython = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
const run = (command, args) => {
  console.log(`\n› ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
};
if (!existsSync(venvPython)) run(python, ["-m", "venv", venv]);
run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-r", join(root, "requirements.txt")]);
run("npm", [existsSync(join(root, "package-lock.json")) ? "ci" : "install"]);
run(process.execPath, [join(root, "tools", "doctor.mjs")]);
