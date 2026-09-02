#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "forge-sheets-package."));
const out = join(scratch, "package");
const origin = "https://pilot.forge.example";
const scriptId = "1M8Wbh2NVyDnQ0KXonPuLRcC2Ar8t5O0d_gZHyq9rCY8hrFyNb40m6MRB";
let checks = 0;
const ok = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${String(++checks).padStart(2, "0")}  ${message}`);
};

const run = spawnSync(process.execPath, [join(ROOT, "tools", "package-sheets-addon.mjs"),
  "--origin", origin, "--out", out, "--script-id", scriptId, "--allow-dirty"],
{ cwd: ROOT, encoding: "utf8" });
if (run.status !== 0) throw new Error(run.stderr || run.stdout || `packager exited ${run.status}`);
ok(/SHEETS ADD-ON PACKAGE READY/.test(run.stdout), "operator package command completes with an explicit receipt");

const code = readFileSync(join(out, "src", "Code.gs"), "utf8");
const sidebar = readFileSync(join(out, "src", "Sidebar.html"), "utf8");
const manifestText = readFileSync(join(out, "src", "appsscript.json"), "utf8");
const manifest = JSON.parse(manifestText);
const clasp = JSON.parse(readFileSync(join(out, ".clasp.json"), "utf8"));
const receipt = JSON.parse(readFileSync(join(out, "forge-deployment.json"), "utf8"));
const guide = readFileSync(join(out, "README.md"), "utf8");

ok(code.includes(`const FORGE_DEPLOYMENT_ORIGIN = "${origin}";`) && !code.includes('const FORGE_DEPLOYMENT_ORIGIN = "";'),
  "runtime code pins the operator's one stable Forge origin");
new vm.Script(code, { filename: "packaged/Code.gs" });
ok(true, "origin-injected Apps Script remains syntactically valid");
ok(sidebar.includes("s.default_origin") && sidebar.includes("s.origin_locked") && sidebar.includes("operator-managed Forge service"),
  "sidebar consumes the packaged origin as a locked operator-managed endpoint");
ok(manifest.urlFetchWhitelist?.length === 1 && manifest.urlFetchWhitelist[0] === `${origin}/`,
  "versioned manifest restricts UrlFetch to that Forge origin");
ok(manifest.oauthScopes?.length === 3 && manifest.oauthScopes.includes("https://www.googleapis.com/auth/spreadsheets.currentonly")
  && manifest.oauthScopes.includes("https://www.googleapis.com/auth/script.container.ui")
  && manifest.oauthScopes.includes("https://www.googleapis.com/auth/script.external_request"),
  "package retains the three narrow connector scopes");
ok(clasp.scriptId === scriptId && clasp.rootDir === "src", "clasp targets the explicit operator-owned script project and source root");
ok(receipt.format === "forge-google-sheets-addon-package" && receipt.forge_origin === origin
  && receipt.source_revision === execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  "deployment receipt pins the exact Git source and Forge origin");
for (const file of receipt.files) {
  const bytes = readFileSync(join(out, file.path));
  ok(bytes.byteLength === file.bytes && createHash("sha256").update(bytes).digest("hex") === file.sha256,
    `receipt verifies ${file.path} byte-for-byte`);
}
ok(guide.includes("clasp push") && guide.includes("clasp version") && guide.includes("OAuth verification")
  && guide.includes("live private-Sheet journey"),
  "operator guide distinguishes test deployment, immutable versioning, public review, and live qualification");
const packageText = `${code}\n${sidebar}\n${manifestText}\n${guide}\n${JSON.stringify(receipt)}`;
ok(!/"token"\s*:\s*"[A-Za-z0-9_-]{20,}"/i.test(packageText)
  && !/Bearer\s+[A-Za-z0-9_-]{20,}/.test(packageText),
  "package contains no generated bearer credential");
const duplicateOut = join(scratch, "duplicate-package");
const duplicate = spawnSync(process.execPath, [join(ROOT, "tools", "package-sheets-addon.mjs"),
  "--origin", origin, "--out", duplicateOut, "--script-id", scriptId, "--allow-dirty"],
{ cwd: ROOT, encoding: "utf8" });
if (duplicate.status !== 0) throw new Error(duplicate.stderr || duplicate.stdout);
const duplicateReceipt = JSON.parse(readFileSync(join(duplicateOut, "forge-deployment.json"), "utf8"));
ok(JSON.stringify(duplicateReceipt.files) === JSON.stringify(receipt.files),
  "same source and origin produce identical deployable connector bytes");
const overwrite = spawnSync(process.execPath, [join(ROOT, "tools", "package-sheets-addon.mjs"),
  "--origin", origin, "--out", out, "--script-id", scriptId, "--allow-dirty"],
{ cwd: ROOT, encoding: "utf8" });
ok(overwrite.status !== 0 && /never overwritten|new or empty/i.test(overwrite.stderr),
  "packager refuses to overwrite an existing candidate directory");

for (const [label, badOrigin] of [["loopback", "http://127.0.0.1:4897"], ["private host", "https://192.168.1.4"],
  ["path-bearing host", "https://forge.example/app"]]) {
  const bad = spawnSync(process.execPath, [join(ROOT, "tools", "package-sheets-addon.mjs"),
    "--origin", badOrigin, "--out", join(scratch, `bad-${label.replace(/\s/g, "-")}`), "--allow-dirty"],
  { cwd: ROOT, encoding: "utf8" });
  ok(bad.status !== 0, `packager rejects ${label} as a Google-hosted connector origin`);
}

console.log(`\nSHEETS PACKAGE GREEN — ${checks} checks; stable origin, narrow allowlist, immutable source receipt, and operator handoff verified.`);
rmSync(scratch, { recursive: true, force: true });
