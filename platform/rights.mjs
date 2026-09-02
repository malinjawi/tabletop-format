// @ts-check
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const RIGHTS_MANIFEST = "forge/rights.json";
const REMIXABLE = new Set(["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0",
  "CC-BY-NC-SA-4.0", "MIT", "Apache-2.0"]);
const BLOCKED_LICENSES = new Set(["", "unknown", "imported-see-source"]);

const jsonBytes = value => JSON.stringify(value, null, 2) + "\n";
const GENERATED_PATHS = [".gitattributes", "CODEOWNERS", "forge/project.json", "forge/collaboration.json", "forge/imports/**", "forge/jams/**"];
const generatedRule = owner => ({ paths: GENERATED_PATHS,
  license: "CC0-1.0", status: "generated", copyright: [`Forge metadata for ${owner}`], redistribution: "allowed" });

export function createRightsManifest({ license, owner, status = "original", copyright = null }) {
  return { format: "forge-rights", version: 1,
    project: { license, owner, trademark_notice: null },
    default: { license, status, copyright: copyright || [owner],
      redistribution: status === "unknown" ? "private-only" : "allowed" },
    files: [generatedRule(owner)] };
}

export function rightsManifestBytes(options) { return jsonBytes(createRightsManifest(options)); }

export function parseRights(bytes) {
  if (!bytes) return null;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return value?.format === "forge-rights" && value?.version === 1 ? value : null;
  } catch { return null; }
}

export function forkRightsManifest(bytes, { license, owner, sourceProject, sourceRef }) {
  const source = parseRights(bytes);
  const sourceLicense = source?.project?.license || license || "unknown";
  const manifest = source || createRightsManifest({ license: sourceLicense, owner: sourceProject,
    status: REMIXABLE.has(sourceLicense) ? "licensed" : "unknown" });
  manifest.project = { ...manifest.project, license: sourceLicense, owner,
    source_project: sourceProject, source_ref: sourceRef, source_license: sourceLicense,
    derivative: true, release_permission: REMIXABLE.has(sourceLicense) ? "license" : "unverified" };
  manifest.files = (manifest.files || []).filter(rule =>
    !(rule.paths || []).some(path => GENERATED_PATHS.includes(path)));
  manifest.files.push(generatedRule(owner));
  return manifest;
}

export function setFileRight(bytes, path, right, fallback) {
  const manifest = parseRights(bytes) || createRightsManifest(fallback);
  manifest.files = (manifest.files || []).filter(rule => !(rule.paths || []).includes(path));
  manifest.files.push({ paths: [path], license: right.license || manifest.project.license,
    status: right.status || "unknown", copyright: right.copyright || [],
    redistribution: right.redistribution || (right.status === "unknown" ? "private-only" : "allowed"),
    ...(right.source ? { source: right.source } : {}), ...(right.notes ? { notes: right.notes } : {}) });
  return manifest;
}

function patternRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function allFiles(root, dir = root) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "exports") continue;
    const full = join(dir, name), stat = statSync(full);
    if (stat.isDirectory()) out.push(...allFiles(root, full));
    else if (stat.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

const digest = value => createHash("sha256").update(value).digest("hex");

export function auditRights(root, { sourceSha = null } = {}) {
  const manifestPath = join(root, RIGHTS_MANIFEST);
  const raw = existsSync(manifestPath) ? readFileSync(manifestPath) : null;
  const manifest = parseRights(raw);
  const blockers = [];
  if (!manifest) return { publishable: false, blockers: [`${RIGHTS_MANIFEST} is missing or invalid`],
    warnings: [], source_sha: sourceSha, manifest_sha256: null, project: null, files: [] };
  if (BLOCKED_LICENSES.has(String(manifest.project.license || "").toLowerCase()))
    blockers.push(`project license '${manifest.project.license || "missing"}' is not publishable`);
  if (manifest.project.derivative && manifest.project.release_permission === "unverified")
    blockers.push(`derivative rights from '${manifest.project.source_license || "unknown"}' are unverified`);
  const rules = (manifest.files || []).flatMap(rule => (rule.paths || []).map(pattern => ({ rule, rx: patternRegex(pattern) })));
  const files = [];
  for (const path of allFiles(root).filter(path => path !== RIGHTS_MANIFEST).sort()) {
    let right = manifest.default;
    for (const candidate of rules) if (candidate.rx.test(path)) right = candidate.rule;
    const license = String(right?.license || ""), status = right?.status || "unknown";
    if (BLOCKED_LICENSES.has(license.toLowerCase())) blockers.push(`${path}: license '${license || "missing"}'`);
    if (status === "unknown") blockers.push(`${path}: rights status is unknown`);
    if (status === "permission-only" && right.redistribution !== "allowed") blockers.push(`${path}: redistribution permission is not documented`);
    if (!Array.isArray(right?.copyright) || !right.copyright.length) blockers.push(`${path}: copyright/credit is missing`);
    const bytes = readFileSync(join(root, path));
    files.push({ path, sha256: digest(bytes), license, status,
      copyright: right?.copyright || [], redistribution: right?.redistribution || "restricted",
      ...(right?.source ? { source: right.source } : {}) });
  }
  return { format: "forge-rights-receipt", version: 1, publishable: blockers.length === 0,
    blockers: [...new Set(blockers)], warnings: [], source_sha: sourceSha,
    manifest_sha256: digest(raw), project: manifest.project, files };
}

export function rightsReceiptBytes(receipt) { return jsonBytes(receipt); }
