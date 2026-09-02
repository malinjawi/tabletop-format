#!/usr/bin/env node
/**
 * Build the exact operator-owned Google Sheets Editor add-on source package.
 * The checked-in connector remains environment-neutral; this command pins one
 * stable Forge HTTPS origin into both runtime code and Apps Script's mandatory
 * versioned-deployment URL allowlist.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, "integrations", "google-sheets");
const args = process.argv.slice(2);
const valueOf = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const has = name => args.includes(name);

function usage(code = 0) {
  console[code ? "error" : "log"](`Usage:
  node tools/package-sheets-addon.mjs --origin https://forge.example --out /safe/output/dir [--script-id ID]

Options:
  --origin       Stable public HTTPS Forge origin embedded for every pilot user
  --out          New or empty output directory (never overwrites a non-empty directory)
  --script-id    Optional operator-owned Apps Script ID; writes a local .clasp.json
  --allow-dirty  Development only; production packaging rejects connector changes outside HEAD`);
  process.exit(code);
}

if (has("--help") || has("-h")) usage();
const rawOrigin = valueOf("--origin").trim().replace(/\/+$/, "");
const out = resolve(valueOf("--out") || "");
const scriptId = valueOf("--script-id").trim();
if (!rawOrigin || !valueOf("--out")) usage(2);

let parsedOrigin;
try { parsedOrigin = new URL(rawOrigin); }
catch { throw new Error("--origin must be a valid public HTTPS origin"); }
if (parsedOrigin.protocol !== "https:" || parsedOrigin.username || parsedOrigin.password
  || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash)
  throw new Error("--origin must contain only a public https:// host and optional port (no path, query, credentials, or fragment)");
const host = parsedOrigin.hostname.toLowerCase();
if (host === "localhost" || host === "::1" || /^127\./.test(host) || /^10\./.test(host)
  || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host))
  throw new Error("--origin must be reachable from Google; localhost and private-network hosts are not deployable");
if (scriptId && !/^[A-Za-z0-9_-]{20,}$/.test(scriptId))
  throw new Error("--script-id does not look like a Google Apps Script project ID");
if (out === ROOT || out === resolve("/")) throw new Error("refusing to use a repository or filesystem root as --out");
if (existsSync(out) && readdirSync(out).length) throw new Error("--out must be new or empty; existing package files are never overwritten");

const dirty = execFileSync("git", ["status", "--porcelain", "--", "integrations/google-sheets"],
  { cwd: ROOT, encoding: "utf8" }).trim();
if (dirty && !has("--allow-dirty"))
  throw new Error("Google Sheets connector sources differ from HEAD; commit and qualify them before packaging (or use --allow-dirty only for development)");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const claspVersion = String(packageJson.devDependencies?.["@google/clasp"] || "").replace(/^[^\d]*/, "");
if (!claspVersion) throw new Error("pin @google/clasp in devDependencies before packaging");

const codeTemplate = readFileSync(join(SOURCE, "Code.gs"), "utf8");
const marker = 'const FORGE_DEPLOYMENT_ORIGIN = "";';
if (codeTemplate.split(marker).length !== 2) throw new Error("Code.gs deployment-origin marker is missing or ambiguous");
const code = codeTemplate.replace(marker, `const FORGE_DEPLOYMENT_ORIGIN = ${JSON.stringify(rawOrigin)};`);
const sidebar = readFileSync(join(SOURCE, "Sidebar.html"), "utf8");
const manifest = JSON.parse(readFileSync(join(SOURCE, "appsscript.json"), "utf8"));
manifest.urlFetchWhitelist = [`${rawOrigin}/`];
const manifestText = JSON.stringify(manifest, null, 2) + "\n";

mkdirSync(join(out, "src"), { recursive: true });
const sourceFiles = { "Code.gs": code, "Sidebar.html": sidebar, "appsscript.json": manifestText };
for (const [name, content] of Object.entries(sourceFiles)) writeFileSync(join(out, "src", name), content);

const clasp = { scriptId: scriptId || "REPLACE_WITH_OPERATOR_OWNED_SCRIPT_ID", rootDir: "src" };
writeFileSync(join(out, scriptId ? ".clasp.json" : ".clasp.json.example"), JSON.stringify(clasp, null, 2) + "\n");
const digest = content => createHash("sha256").update(content).digest("hex");
const receipt = {
  format: "forge-google-sheets-addon-package",
  version: 1,
  forge_origin: rawOrigin,
  source_revision: revision,
  source_dirty: !!dirty,
  clasp_version: claspVersion,
  oauth_scopes: manifest.oauthScopes,
  url_fetch_allowlist: manifest.urlFetchWhitelist,
  files: Object.entries(sourceFiles).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => ({
    path: `src/${name}`, bytes: Buffer.byteLength(content), sha256: digest(content),
  })),
};
writeFileSync(join(out, "forge-deployment.json"), JSON.stringify(receipt, null, 2) + "\n");
writeFileSync(join(out, "README.md"), `# Forge Google Sheets private-beta package

This package pins Forge ${revision} to ${rawOrigin}. The receipt in
\`forge-deployment.json\` records every byte. Do not edit the remote Apps Script
project by hand after deployment; rebuild this package from Git instead.

## Operator deployment

1. Enable the Apps Script API for the operator account.
2. Create or select an operator-owned Apps Script project and put its script ID
   in \`.clasp.json\` (already written when \`--script-id\` was supplied).
3. From this directory run:

       npx --no-install clasp push
       npx --no-install clasp version "Forge ${revision.slice(0, 12)}"

4. In Apps Script choose **Deploy → Test deployments → Install** for controlled
   testers. For Marketplace distribution, configure an **Editor add-on** using
   this script ID and immutable version in the operator's Marketplace SDK project.
5. Confirm the OAuth consent screen declares exactly the scopes recorded in the
   receipt. Public publication requires Google's separate OAuth verification and
   Marketplace review; do not represent a test deployment as publicly approved.
6. Run the live private-Sheet journey against ${rawOrigin} and record its
   resulting Forge commit before inviting pilot users.

The add-on asks only for the current spreadsheet, container UI, and outbound
HTTPS access. The generated manifest restricts outbound requests to
${rawOrigin}/.
`);

console.log(`SHEETS ADD-ON PACKAGE READY — ${out}`);
console.log(`  source ${revision}${dirty ? " (dirty development build)" : ""}`);
console.log(`  Forge  ${rawOrigin}`);
console.log(`  files  ${receipt.files.length}; receipt forge-deployment.json`);
