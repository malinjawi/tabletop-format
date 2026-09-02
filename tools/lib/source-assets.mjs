import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const SOURCE_ASSETS_MANIFEST = "assets/manifest.json";
const SOURCE_ROOTS = ["assets/", "templates/", "rules/", "setups/", "boards/", "components/", "design/"];
const sha256 = value => createHash("sha256").update(value).digest("hex");

function safeSourcePath(root, rel) {
  const parts = typeof rel === "string" ? rel.split("/") : [];
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || rel.includes("\\")
    || parts.some(part => !part || part === "." || part === "..")
    || !SOURCE_ROOTS.some(prefix => rel.startsWith(prefix)))
    throw new Error(`source package path is not an allowed game-relative source: ${rel}`);
  const path = resolve(root, rel), check = relative(root, path);
  if (check === ".." || check.startsWith(`..${sep}`) || isAbsolute(check))
    throw new Error(`source package path escapes the game: ${rel}`);
  return path;
}

function fileView(root, record) {
  const path = safeSourcePath(root, record.path);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { ...record, exists: false, size: null, sha256: null,
      issue: record.optional ? null : `missing required source file: ${record.path}` };
  }
  const bytes = readFileSync(path);
  return { ...record, exists: true, size: bytes.length, sha256: sha256(bytes), issue: null };
}

export function loadSourceAssets(gameDir) {
  const root = resolve(gameDir), path = resolve(root, SOURCE_ASSETS_MANIFEST);
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.format !== "forge-source-assets" || manifest.version !== 1 || !Array.isArray(manifest.packages))
    throw new Error(`unsupported ${SOURCE_ASSETS_MANIFEST} format`);
  const seen = new Set();
  const packages = manifest.packages.map(item => {
    if (seen.has(item.id)) throw new Error(`duplicate source package id: ${item.id}`);
    seen.add(item.id);
    const source_files = (item.source_files || []).map(record => fileView(root, record));
    const previews = (item.previews || []).map(record => fileView(root, record));
    const issues = [...source_files, ...previews].map(record => record.issue).filter(Boolean);
    if (!source_files.length && !item.external) issues.push("package has neither source files nor an external reference");
    const inputs = [...source_files, ...previews].filter(record => record.exists)
      .map(record => `${record.path}:${record.sha256}`).sort();
    if (item.external) inputs.push(`external:${item.external.url}`);
    return { ...structuredClone(item), source_files, previews, issues,
      ready: !issues.length, input_hash: `sha256:${sha256(Buffer.from(inputs.join("\n")))}` };
  });
  return {
    format: manifest.format,
    version: manifest.version,
    manifest_path: SOURCE_ASSETS_MANIFEST,
    packages,
    summary: {
      total: packages.length,
      ready: packages.filter(item => item.ready).length,
      active: packages.filter(item => item.status === "active").length,
      external: packages.filter(item => !!item.external).length,
      three_d: packages.filter(item => ["miniature", "model-3d"].includes(item.kind)).length,
      issues: packages.reduce((count, item) => count + item.issues.length, 0),
    },
  };
}

export function sourceAssetMetadata(loaded) {
  return loaded ? structuredClone(loaded) : null;
}
