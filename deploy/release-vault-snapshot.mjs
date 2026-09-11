#!/usr/bin/env node
/**
 * Snapshot and restore Forge's filesystem release-artifact vault.
 *
 * The snapshot stores each vault file under a hash of its relative path. This
 * keeps untrusted vault names away from the backup directory while a checked
 * manifest preserves the exact tree. Symlinks and every non-regular file are
 * rejected; restore always targets a new or completely empty directory.
 */
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createReleaseVault } from "../platform/release-vault.mjs";

const FORMAT = "forge-release-vault-snapshot";
const VERSION = 1;
const BUFFER_BYTES = 1024 * 1024;
const noFollow = constants.O_NOFOLLOW || 0;

function parseArguments(raw) {
  const args = [...raw], operation = args.shift(), options = new Map();
  while (args.length) {
    const name = args.shift();
    if (!/^--[a-z-]+$/.test(name || "") || !args.length || String(args[0]).startsWith("--"))
      throw new Error(`invalid or missing value for ${name || "argument"}`);
    if (options.has(name)) throw new Error(`duplicate option: ${name}`);
    options.set(name, args.shift());
  }
  const allowed = operation === "backup" ? new Set(["--source", "--output"])
    : operation === "verify" ? new Set(["--input"])
    : operation === "restore" ? new Set(["--input", "--output"])
    : null;
  if (!allowed) throw new Error("usage: release-vault-snapshot.mjs backup|verify|restore [options]");
  for (const name of options.keys()) if (!allowed.has(name)) throw new Error(`unsupported option for ${operation}: ${name}`);
  const required = name => {
    const value = options.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return { operation, required };
}

function lstatOrNull(path) {
  try { return lstatSync(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function canonicalPathWithoutSymlinks(path, label, { mustExist = true } = {}) {
  const absolute = resolve(path), root = parse(absolute).root;
  if (!isAbsolute(absolute) || absolute === root) throw new Error(`${label} must be a narrow directory path`);
  const segments = relative(root, absolute).split(sep).filter(Boolean), missing = [];
  let cursor = root, missingSeen = false;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const stat = lstatOrNull(cursor);
    if (!stat) { missingSeen = true; missing.push(segment); continue; }
    if (missingSeen) throw new Error(`${label} has an inconsistent missing path ancestor`);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link: ${cursor}`);
    if (!stat.isDirectory()) throw new Error(`${label} path ancestor must be a directory: ${cursor}`);
  }
  if (mustExist && missing.length) throw new Error(`${label} does not exist: ${absolute}`);
  if (!missing.length) return realpathSync(absolute);
  let existing = absolute;
  for (let index = 0; index < missing.length; index += 1) existing = dirname(existing);
  return join(realpathSync(existing), ...missing);
}

function safeRoot(path, label, { mustExist = true } = {}) {
  const root = canonicalPathWithoutSymlinks(path, label, { mustExist });
  if (!existsSync(root)) return root;
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return root;
}

function assertSemanticVault(root, label) {
  const report = createReleaseVault({ root }).audit();
  if (!report.ok) {
    const detail = report.corruption[0]?.error || (report.staging.length
      ? `${report.staging.length} unfinished staging object(s)` : "unknown vault integrity failure");
    throw new Error(`${label} failed semantic release-vault audit: ${detail}`);
  }
  return report;
}

function inside(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function safeRelativePath(path) {
  if (typeof path !== "string" || !path || path.length > 4096 || isAbsolute(path)
      || path.includes("\\") || /[\0-\x1f\x7f]/.test(path)) return false;
  return path.split("/").every(part => part && part !== "." && part !== "..");
}

function pathHash(path) {
  return createHash("sha256").update(Buffer.from(path, "utf8")).digest("hex");
}

function walkRegularFiles(root, dir = root) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`vault contains a symbolic link: ${relative(root, path)}`);
    if (stat.isDirectory()) files.push(...walkRegularFiles(root, path));
    else if (stat.isFile()) {
      const rel = relative(root, path).split(sep).join("/");
      if (!safeRelativePath(rel)) throw new Error(`vault contains an unsafe path: ${rel}`);
      files.push({ path, relative: rel });
    } else throw new Error(`vault contains a non-regular file: ${relative(root, path)}`);
  }
  return files.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
}

function hashRegularFile(path) {
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`not a regular file: ${path}`);
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(fd);
    if (bytes !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error(`file changed while it was being read: ${path}`);
    return { bytes, sha256: hash.digest("hex") };
  } finally { closeSync(fd); }
}

function copyRegularFile(source, target) {
  const sourceFd = openSync(source, constants.O_RDONLY | noFollow);
  let targetFd = null;
  try {
    const before = fstatSync(sourceFd);
    if (!before.isFile()) throw new Error(`not a regular file: ${source}`);
    targetFd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    let bytes = 0;
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (!count) break;
      let written = 0;
      while (written < count) written += writeSync(targetFd, buffer, written, count - written);
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    fsyncSync(targetFd);
    const after = fstatSync(sourceFd);
    if (bytes !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error(`file changed while it was being copied: ${source}`);
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  } finally {
    if (targetFd !== null) closeSync(targetFd);
    closeSync(sourceFd);
  }
}

function loadSnapshot(input) {
  const root = safeRoot(input, "--input"), manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink())
    throw new Error("release-vault snapshot manifest is missing or is not a regular file");
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { throw new Error("release-vault snapshot manifest is not valid JSON"); }
  if (manifest?.format !== FORMAT || manifest.version !== VERSION || !Array.isArray(manifest.files)
      || !Number.isSafeInteger(manifest.total_bytes) || manifest.total_bytes < 0)
    throw new Error("unsupported or malformed release-vault snapshot manifest");
  return { root, manifest };
}

function verifySnapshot(input) {
  const loaded = loadSnapshot(input), objectsDir = join(loaded.root, "objects");
  const rootNames = readdirSync(loaded.root).sort();
  if (rootNames.length !== 2 || rootNames[0] !== "manifest.json" || rootNames[1] !== "objects")
    throw new Error("release-vault snapshot contains undeclared top-level entries");
  if (!existsSync(objectsDir) || !lstatSync(objectsDir).isDirectory() || lstatSync(objectsDir).isSymbolicLink())
    throw new Error("release-vault snapshot objects directory is missing or unsafe");

  const expectedObjects = new Set(), seenPaths = new Set();
  let previous = null, total = 0;
  for (const file of loaded.manifest.files) {
    if (!file || !safeRelativePath(file.path) || seenPaths.has(file.path)
        || !/^[a-f0-9]{64}$/.test(file.file || "") || file.file !== pathHash(file.path)
        || !/^[a-f0-9]{64}$/.test(file.sha256 || "")
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0)
      throw new Error("malformed file record in release-vault snapshot");
    if (previous !== null && file.path <= previous)
      throw new Error("release-vault snapshot file records are not uniquely sorted");
    previous = file.path;
    seenPaths.add(file.path);
    if (expectedObjects.has(file.file)) throw new Error("duplicate object record in release-vault snapshot");
    expectedObjects.add(file.file);
    const objectPath = join(objectsDir, file.file);
    if (!existsSync(objectPath) || !lstatSync(objectPath).isFile() || lstatSync(objectPath).isSymbolicLink())
      throw new Error(`snapshot object is missing or unsafe: ${file.path}`);
    const actual = hashRegularFile(objectPath);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error(`snapshot object failed integrity check: ${file.path}`);
    total += actual.bytes;
    if (!Number.isSafeInteger(total)) throw new Error("release-vault snapshot byte total exceeds the safe integer range");
  }
  const objectNames = readdirSync(objectsDir).sort();
  for (const name of objectNames) {
    const objectPath = join(objectsDir, name), stat = lstatSync(objectPath);
    if (!/^[a-f0-9]{64}$/.test(name) || !stat.isFile() || stat.isSymbolicLink() || !expectedObjects.has(name))
      throw new Error(`release-vault snapshot contains an undeclared or unsafe object: ${name}`);
  }
  if (objectNames.length !== expectedObjects.size || total !== loaded.manifest.total_bytes)
    throw new Error("release-vault snapshot inventory totals do not match its manifest");
  return { ...loaded, total };
}

function backup(sourcePath, outputPath) {
  const source = safeRoot(sourcePath, "--source"), output = safeRoot(outputPath, "--output", { mustExist: false });
  if (existsSync(output)) throw new Error(`backup output already exists: ${output}`);
  if (inside(source, output) || inside(output, source))
    throw new Error("backup source and output must not contain one another");
  const sourceFiles = walkRegularFiles(source);
  assertSemanticVault(source, "backup source");
  try {
    mkdirSync(output, { mode: 0o700 });
    const objectsDir = join(output, "objects");
    mkdirSync(objectsDir, { mode: 0o700 });
    const files = [];
    let totalBytes = 0;
    for (const sourceFile of sourceFiles) {
      const file = pathHash(sourceFile.relative), receipt = copyRegularFile(sourceFile.path, join(objectsDir, file));
      totalBytes += receipt.bytes;
      if (!Number.isSafeInteger(totalBytes)) throw new Error("release vault exceeds the safe integer byte range");
      files.push({ path: sourceFile.relative, file, bytes: receipt.bytes, sha256: receipt.sha256 });
    }
    const manifest = { format: FORMAT, version: VERSION, created_at: new Date().toISOString(),
      total_bytes: totalBytes, files };
    writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const verified = verifySnapshot(output);
    assertSemanticVault(source, "backup source after copy");
    console.log(`RELEASE VAULT SNAPSHOT GREEN — ${files.length} file(s), ${verified.total} bytes backed up and verified.`);
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function restore(inputPath, outputPath) {
  const snapshot = verifySnapshot(inputPath);
  const output = safeRoot(outputPath, "--output", { mustExist: false });
  if (inside(snapshot.root, output) || inside(output, snapshot.root))
    throw new Error("restore input and output must not contain one another");
  if (existsSync(output)) {
    if (readdirSync(output).length) throw new Error("restore target is not empty; use a fresh isolated release vault");
  } else mkdirSync(output, { recursive: true, mode: 0o700 });
  // The snapshot inventory is file-oriented, so recreate the vault's required
  // empty structural directories (especially staging/) explicitly.
  for (const dir of [join(output, "blobs"), join(output, "blobs", "sha256"),
    join(output, "manifests"), join(output, "staging")])
    mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (const file of snapshot.manifest.files) {
    const target = resolve(output, ...file.path.split("/"));
    if (!inside(output, target)) throw new Error(`unsafe restore target: ${file.path}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const copied = copyRegularFile(join(snapshot.root, "objects", file.file), target);
    if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256)
      throw new Error(`restored release-vault file failed integrity check: ${file.path}`);
  }
  const restored = walkRegularFiles(output).map(file => ({ path: file.relative, ...hashRegularFile(file.path) }));
  if (restored.length !== snapshot.manifest.files.length
      || restored.some((file, index) => file.path !== snapshot.manifest.files[index].path
        || file.bytes !== snapshot.manifest.files[index].bytes
        || file.sha256 !== snapshot.manifest.files[index].sha256))
    throw new Error("restored release vault does not match the snapshot manifest");
  assertSemanticVault(output, "restored output");
  console.log(`RELEASE VAULT RESTORE GREEN — ${restored.length} file(s), ${snapshot.total} bytes restored exactly.`);
}

try {
  const { operation, required } = parseArguments(process.argv.slice(2));
  if (operation === "backup") backup(required("--source"), required("--output"));
  else if (operation === "verify") {
    const verified = verifySnapshot(required("--input"));
    console.log(`RELEASE VAULT SNAPSHOT VERIFIED — ${verified.manifest.files.length} file(s), ${verified.total} bytes.`);
  } else restore(required("--input"), required("--output"));
} catch (error) {
  console.error(`RELEASE VAULT SNAPSHOT FAILED — ${error.message}`);
  process.exit(1);
}
