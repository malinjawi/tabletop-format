#!/usr/bin/env node
/**
 * Conservative operator tooling for the immutable release artifact vault.
 *
 * Migration is deliberately receipt-only: this tool never invokes an
 * exporter, repairs cache files, rewrites a vault object, or infers a source
 * revision.  A legacy release is eligible only when its exact database tag,
 * full Git SHA, and every ready artifact receipt match the existing cache.
 */
import { createHash } from "node:crypto";
import {
  closeSync, constants as FS, lstatSync, openSync, readSync, realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDb, q } from "../platform/db.mjs";
import {
  createReleaseVault, RELEASE_VAULT_FORMAT, RELEASE_VAULT_VERSION,
} from "../platform/release-vault.mjs";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}(?:~[a-z0-9][a-z0-9_-]{0,63})?$/;
const TAG_RE = /^v[0-9][0-9A-Za-z._-]{0,31}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

class MigrationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ReleaseVaultMigrationError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => { throw new MigrationError(code, message, details); };

function statOrNull(path) {
  try { return lstatSync(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function assertNoSymlinkPath(path, { allowMissingLeaf = false } = {}) {
  const absolute = resolve(path), root = parse(absolute).root;
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]);
    const stat = statOrNull(cursor);
    if (!stat) {
      if (allowMissingLeaf && index === segments.length - 1) return;
      fail("MIGRATION_PATH_MISSING", `required path is missing: ${cursor}`);
    }
    if (stat.isSymbolicLink()) fail("MIGRATION_SYMLINK", `symbolic links are not accepted: ${cursor}`);
  }
}

function requireRegularFile(path, label) {
  const stat = statOrNull(path);
  if (stat?.isSymbolicLink()) fail("MIGRATION_SYMLINK", `${label} must not be a symbolic link`);
  if (!stat?.isFile()) fail("MIGRATION_PATH", `${label} must be a regular file`);
  return realpathSync(path);
}

function requireDirectory(path, label) {
  const stat = statOrNull(path);
  if (stat?.isSymbolicLink()) fail("MIGRATION_SYMLINK", `${label} must not be a symbolic link`);
  if (!stat?.isDirectory()) fail("MIGRATION_PATH", `${label} must be a real directory`);
  return realpathSync(path);
}

function canonicalDestination(path, label) {
  const absolute = resolve(path), stat = statOrNull(absolute);
  if (stat) {
    if (stat.isSymbolicLink()) fail("MIGRATION_SYMLINK", `${label} must not be a symbolic link`);
    if (!stat.isDirectory()) fail("MIGRATION_PATH", `${label} must be a directory`);
    return realpathSync(absolute);
  }
  const missing = [];
  let cursor = absolute;
  while (!statOrNull(cursor)) { missing.unshift(parse(cursor).base); cursor = dirname(cursor); }
  const ancestor = statOrNull(cursor);
  if (ancestor.isSymbolicLink()) fail("MIGRATION_SYMLINK", `${label} parent must not be a symbolic link`);
  if (!ancestor.isDirectory()) fail("MIGRATION_PATH", `${label} parent must be a directory`);
  return join(realpathSync(cursor), ...missing);
}

function contained(root, target) {
  const rel = relative(root, target);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function safeArtifactName(value) {
  if (typeof value !== "string" || !value || value.length > 512
      || value.startsWith("/") || value.includes("\\") || value.includes("\0"))
    fail("MIGRATION_RECEIPT", "release contains an unsafe artifact name");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.length > 200 || !SEGMENT_RE.test(part)))
    fail("MIGRATION_RECEIPT", `release contains an unsafe artifact name: ${value}`);
  return value;
}

function parseReadyReceipts(release) {
  let artifacts;
  try { artifacts = JSON.parse(release.artifacts_json || "null"); }
  catch { fail("MIGRATION_RECEIPT", "release artifacts_json is not valid JSON"); }
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    fail("MIGRATION_RECEIPT", "release has no immutable artifact receipts");
  const ready = [], names = new Set();
  for (const item of artifacts) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      fail("MIGRATION_RECEIPT", "release contains a malformed artifact receipt");
    if (item.status === "failed_optional") continue;
    if (item.status !== "ready")
      fail("MIGRATION_RECEIPT", `release artifact '${String(item.name || "")}' has an unsupported status`);
    const name = safeArtifactName(item.name);
    if (names.has(name)) fail("MIGRATION_RECEIPT", `release repeats artifact '${name}'`);
    names.add(name);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !SHA256_RE.test(item.sha256 || ""))
      fail("MIGRATION_RECEIPT", `release artifact '${name}' has an invalid byte receipt`);
    ready.push({ status: "ready", name, bytes: item.bytes, sha256: item.sha256 });
  }
  if (!ready.length) fail("MIGRATION_RECEIPT", "release has no ready artifact receipts to preserve");
  return ready.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function verifyReceiptFile(sourceDir, receipt) {
  const file = resolve(sourceDir, ...receipt.name.split("/"));
  if (!contained(sourceDir, file)) fail("MIGRATION_PATH", `artifact '${receipt.name}' escaped the exact cache directory`);
  assertNoSymlinkPath(file);
  const stat = statOrNull(file);
  if (!stat?.isFile()) fail("MIGRATION_RECEIPT_MISMATCH", `artifact '${receipt.name}' is not a regular file`);
  let fd;
  try {
    fd = openSync(file, FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count; hash.update(buffer.subarray(0, count));
    }
    const sha256 = hash.digest("hex");
    if (bytes !== receipt.bytes || sha256 !== receipt.sha256)
      fail("MIGRATION_RECEIPT_MISMATCH", `artifact '${receipt.name}' does not match its published receipt`, {
        expected: { bytes: receipt.bytes, sha256: receipt.sha256 }, actual: { bytes, sha256 },
      });
    return bytes;
  } catch (error) {
    if (error?.code === "ELOOP") fail("MIGRATION_SYMLINK", `artifact '${receipt.name}' must not be a symbolic link`);
    throw error;
  } finally { if (fd != null) closeSync(fd); }
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function plannedManifest(slug, tag, sha, receipts) {
  const manifest = {
    artifacts: receipts.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256, blob: `sha256:${sha256}` })),
    format: RELEASE_VAULT_FORMAT,
    release: { slug, source_sha: sha, tag },
    version: RELEASE_VAULT_VERSION,
  };
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  return { manifest, manifestSha256: createHash("sha256").update(bytes).digest("hex") };
}

function normalizeOptions(options) {
  const slug = String(options.slug || ""), tag = String(options.tag || ""), sha = String(options.sha || "");
  if (!SLUG_RE.test(slug)) fail("MIGRATION_INPUT", "--slug must be a safe Forge storage slug");
  if (!TAG_RE.test(tag)) fail("MIGRATION_INPUT", "--tag must be an exact v-prefixed release tag");
  if (!SHA1_RE.test(sha)) fail("MIGRATION_INPUT", "--sha must be the exact full lowercase 40-character Git SHA");
  for (const key of ["dbPath", "cacheDir", "vaultDir"])
    if (typeof options[key] !== "string" || !options[key].trim())
      fail("MIGRATION_INPUT", `--${key === "dbPath" ? "db-path" : key === "cacheDir" ? "cache-dir" : "vault-dir"} is required`);
  const dbPath = resolve(options.dbPath), cacheDir = resolve(options.cacheDir), vaultDir = resolve(options.vaultDir);
  if (cacheDir === vaultDir || contained(cacheDir, vaultDir) || contained(vaultDir, cacheDir))
    fail("MIGRATION_INPUT", "the release vault and disposable cache must be separate directory trees");
  return { slug, tag, sha, dbPath, cacheDir, vaultDir, apply: options.apply === true };
}

export async function migrateLegacyRelease(rawOptions) {
  const normalized = normalizeOptions(rawOptions);
  const options = { ...normalized,
    dbPath: requireRegularFile(normalized.dbPath, "SQLite database"),
    cacheDir: requireDirectory(normalized.cacheDir, "cache root"),
    vaultDir: canonicalDestination(normalized.vaultDir, "vault root") };
  if (options.cacheDir === options.vaultDir || contained(options.cacheDir, options.vaultDir)
      || contained(options.vaultDir, options.cacheDir))
    fail("MIGRATION_INPUT", "the release vault and disposable cache must be separate directory trees");

  // Inspection always starts through a read-only SQLite handle. Even apply
  // mode does not open a database write path until all receipts have passed.
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    const release = q.releaseByTag(db, options.slug, options.tag);
    if (!release) fail("MIGRATION_RELEASE_MISSING", `release '${options.slug}/${options.tag}' does not exist`);
    if (release.sha !== options.sha)
      fail("MIGRATION_SOURCE_MISMATCH", "the supplied SHA does not exactly match the release record", {
        expected: release.sha, supplied: options.sha,
      });
    const receipts = parseReadyReceipts(release);
    const sourceDir = resolve(options.cacheDir, "exports", options.slug, options.sha);
    if (!contained(options.cacheDir, sourceDir)) fail("MIGRATION_PATH", "computed release cache path escaped the cache root");
    requireDirectory(sourceDir, "exact release cache directory");
    const totalBytes = receipts.reduce((sum, receipt) => sum + verifyReceiptFile(sourceDir, receipt), 0);
    const planned = plannedManifest(options.slug, options.tag, options.sha, receipts);
    const vault = createReleaseVault({ root: options.vaultDir });
    const audit = vault.audit();
    if (!audit.ok) fail("MIGRATION_VAULT_UNHEALTHY", "release vault audit failed; repair is an explicit operator action", {
      counts: audit.counts, corruption: audit.corruption, staging: audit.staging,
    });

    let existing = null;
    try { existing = vault.readRelease({ slug: options.slug, tag: options.tag, sourceSha: options.sha }); }
    catch (error) {
      if (error?.code !== "VAULT_MISSING") throw error;
    }
    if (existing && existing.manifestSha256 !== planned.manifestSha256)
      fail("MIGRATION_VAULT_CONFLICT", "this release tag is already sealed to different immutable bytes", {
        existing: existing.manifestSha256, planned: planned.manifestSha256,
      });
    const associatedDigest = release.vault_manifest_sha256 || null;
    if (associatedDigest && associatedDigest !== planned.manifestSha256)
      fail("MIGRATION_DATABASE_CONFLICT", "the release database is already attached to a different vault manifest", {
        existing: associatedDigest, planned: planned.manifestSha256,
      });
    if (associatedDigest && !existing)
      fail("MIGRATION_VAULT_MISSING", "the database claims this release is vaulted, but its verified manifest is missing");
    if (associatedDigest && Number(release.vault_format_version) !== RELEASE_VAULT_VERSION)
      fail("MIGRATION_DATABASE_CONFLICT", "the release database uses a different vault format version");

    const base = {
      format: "forge-release-vault-migration", version: 1, ok: true,
      command: "migrate", mode: options.apply ? "apply" : "dry-run",
      release: { slug: options.slug, tag: options.tag, sha: options.sha },
      cache: { source_dir: sourceDir, artifacts_verified: receipts.length, bytes_verified: totalBytes },
      vault: { root: options.vaultDir, format_version: RELEASE_VAULT_VERSION,
        manifest_sha256: planned.manifestSha256, binding: "db-receipt" },
    };
    if (!options.apply) return { ...base, result: associatedDigest
      ? "already-attached-and-verified"
      : existing ? "would-attach-existing-seal" : "would-seal-and-attach", written: false };

    const sealed = vault.publishRelease({ slug: options.slug, tag: options.tag,
      sourceSha: options.sha, sourceDir, artifacts: receipts });
    if (sealed.manifestSha256 !== planned.manifestSha256)
      fail("MIGRATION_INTERNAL", "vault returned a manifest digest different from the audited migration plan");
    const writeDb = openDb(options.dbPath);
    let attached;
    try {
      const current = q.releaseByTag(writeDb, options.slug, options.tag);
      if (!current || current.sha !== release.sha || current.artifacts_json !== release.artifacts_json)
        fail("MIGRATION_DATABASE_CONFLICT", "the release record changed after migration verification; no association was attached");
      if (current.vault_manifest_sha256 && current.vault_manifest_sha256 !== sealed.manifestSha256)
        fail("MIGRATION_DATABASE_CONFLICT", "the release was concurrently attached to a different vault manifest");
      attached = q.attachReleaseVault(writeDb, { game_slug: options.slug, release_tag: options.tag,
        format_version: RELEASE_VAULT_VERSION, binding_kind: "db-receipt",
        manifest_sha256: sealed.manifestSha256, sealed_at: Date.now() });
    } finally { writeDb.close(); }
    return { ...base, result: attached.attached ? "sealed-and-attached" : "already-attached-and-verified",
      written: !!(sealed.created || attached.attached), vault: { ...base.vault,
        seal_created: sealed.created, database_attached: attached.attached } };
  } finally { db.close(); }
}

export function auditReleaseVault({ vaultDir }) {
  if (typeof vaultDir !== "string" || !vaultDir.trim()) fail("MIGRATION_INPUT", "--vault-dir is required");
  const root = canonicalDestination(vaultDir, "vault root");
  const audit = createReleaseVault({ root }).audit();
  return { ...audit, command: "audit", root };
}

function parseArgs(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (!command || !["audit", "migrate"].includes(command))
    fail("MIGRATION_USAGE", "usage: release-vault.mjs audit|migrate --vault-dir PATH [migration options]");
  const values = {}, flags = new Set();
  const keys = new Map([["--db-path", "dbPath"], ["--db", "dbPath"],
    ["--cache-dir", "cacheDir"], ["--cache", "cacheDir"],
    ["--vault-dir", "vaultDir"], ["--vault", "vaultDir"],
    ["--slug", "slug"], ["--tag", "tag"], ["--sha", "sha"]]);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--apply") { if (flags.has(arg)) fail("MIGRATION_USAGE", "duplicate --apply flag"); flags.add(arg); continue; }
    const key = keys.get(arg);
    if (!key) fail("MIGRATION_USAGE", `unknown argument: ${arg}`);
    if (values[key] != null) fail("MIGRATION_USAGE", `duplicate option: ${arg}`);
    const value = rest[++index];
    if (!value || value.startsWith("--")) fail("MIGRATION_USAGE", `${arg} requires a value`);
    values[key] = value;
  }
  values.vaultDir ??= env.RELEASE_VAULT_DIR;
  if (command === "audit") {
    if (flags.has("--apply") || Object.keys(values).some(key => key !== "vaultDir"))
      fail("MIGRATION_USAGE", "audit accepts only --vault-dir");
    return { command, options: values };
  }
  values.dbPath ??= env.DB_PATH;
  values.cacheDir ??= env.CACHE_DIR;
  return { command, options: { ...values, apply: flags.has("--apply") } };
}

export async function runReleaseVaultCli(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv, env);
  const result = parsed.command === "audit"
    ? auditReleaseVault(parsed.options)
    : await migrateLegacyRelease(parsed.options);
  if (parsed.command === "audit" && !result.ok)
    fail("MIGRATION_VAULT_UNHEALTHY", "release vault audit found corruption or unfinished staging", result);
  return result;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try { console.log(JSON.stringify(await runReleaseVaultCli(), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ format: "forge-release-vault-error", version: 1, ok: false,
      code: error?.code || "MIGRATION_FAILED", error: String(error?.message || error),
      ...(error?.details === undefined ? {} : { details: error.details }) }, null, 2));
    process.exitCode = 1;
  }
}
