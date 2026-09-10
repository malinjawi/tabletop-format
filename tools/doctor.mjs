#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, ".."), rows = [];
const pass = (name, detail) => rows.push({ ok: true, name, detail });
const fail = (name, detail) => rows.push({ ok: false, name, detail });
const command = (name, args = [], options = {}) => spawnSync(name, args, { cwd: root, encoding: "utf8", ...options });

const nodeMajor = Number(process.versions.node.split(".")[0]);
nodeMajor >= 20 ? pass("Node", process.version) : fail("Node", `${process.version}; Forge needs Node 20+`);
existsSync(join(root, "package-lock.json")) ? pass("npm lockfile", "package-lock.json present") : fail("npm lockfile", "missing; run npm install --package-lock-only");
for (const dependency of ["ajv", "js-yaml", "yaml", "playwright-core"]) {
  try { await import(dependency); pass(`npm:${dependency}`, "installed"); }
  catch { fail(`npm:${dependency}`, "missing; run npm run setup:dev"); }
}
const venvPython = process.platform === "win32" ? join(root, ".venv", "Scripts", "python.exe") : join(root, ".venv", "bin", "python");
const python = process.env.FORGE_PYTHON || (existsSync(venvPython) ? venvPython : "python3");
const py = command(python, ["-c", "import sys,yaml,jsonschema,openpyxl,PIL,pypdf,reportlab; print(sys.version.split()[0], yaml.__version__, jsonschema.__version__ if hasattr(jsonschema,'__version__') else 'ok', openpyxl.__version__, PIL.__version__, pypdf.__version__, reportlab.Version)"]);
py.status === 0 ? pass("Python production libs", py.stdout.trim()) : fail("Python production libs", `${python}: ${(py.stderr || py.stdout).trim() || "unavailable"}`);
const git = command("git", ["--version"]);
git.status === 0 ? pass("Git", git.stdout.trim()) : fail("Git", "not found");
const chromeCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const chrome = process.env.CHROME_PATH || chromeCandidates.find(existsSync);
chrome ? pass("Chromium renderer", chrome) : fail("Chromium renderer", "set CHROME_PATH or install Chrome/Chromium");
const nandeck = process.env.NANDECK_PATH;
pass("nanDECK adapter", nandeck ? `external app declared at ${nandeck}` : "script import/export ready; external app optional and not run by Forge");
const squib = command("ruby", ["-e", "begin; require 'squib'; print Squib::VERSION; rescue LoadError; exit 3; end"]);
pass("Squib adapter", squib.status === 0 ? `external preview runtime ${squib.stdout.trim()} available`
  : "safe CSV/YAML import/export ready; optional local preview needs Ruby 3 and the pinned bundle");
const claspPath = process.platform === "win32" ? join(root, "node_modules", ".bin", "clasp.cmd") : join(root, "node_modules", ".bin", "clasp");
const clasp = command(claspPath, ["--version"]);
clasp.status === 0 ? pass("Google Sheets deployer", `clasp ${clasp.stdout.trim()}`)
  : fail("Google Sheets deployer", "missing; run npm ci before packaging the private Editor add-on");

for (const row of rows) console.log(`${row.ok ? "✓" : "✗"} ${row.name}: ${row.detail}`);
const failures = rows.filter(row => !row.ok);
if (failures.length) { console.error(`\n${failures.length} required check${failures.length === 1 ? "" : "s"} failed.`); process.exit(1); }
console.log("\nForge development toolchain is ready.");
