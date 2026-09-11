#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, q } from "../platform/db.mjs";
import { createReleaseVault } from "../platform/release-vault.mjs";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "tools", "release-vault.mjs");
const temp = mkdtempSync(join(realpathSync(tmpdir()), "forge-release-vault-cli-"));
const dbPath = join(temp, "platform.db"), cacheDir = join(temp, "cache"), vaultDir = join(temp, "vault");
const slug = "migration-fixture";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = digit => digit.repeat(40);
const artifactName = tag => `packages/${tag}.zip`;
const artifactDir = sourceSha => join(cacheDir, "exports", slug, sourceSha, "packages");
const args = (tag, sourceSha, apply = false) => ["migrate", "--db-path", dbPath,
  "--cache-dir", cacheDir, "--vault-dir", vaultDir, "--slug", slug, "--tag", tag,
  "--sha", sourceSha, ...(apply ? ["--apply"] : [])];

function invoke(argv) {
  const result = spawnSync(process.execPath, [cli, ...argv], { cwd: root, encoding: "utf8" });
  const stream = result.status === 0 ? result.stdout : result.stderr;
  let body;
  try { body = JSON.parse(stream); }
  catch { throw new Error(`CLI did not return JSON (status ${result.status}):\n${result.stdout}\n${result.stderr}`); }
  return { ...result, body };
}

function receipt(name, bytes) {
  return { status: "ready", name, bytes: bytes.length, sha256: hash(bytes) };
}

function writeCached(sourceSha, name, bytes) {
  const dir = artifactDir(sourceSha); mkdirSync(dir, { recursive: true });
  writeFileSync(join(cacheDir, "exports", slug, sourceSha, name), bytes);
}

try {
  mkdirSync(cacheDir, { recursive: true });
  const fixtures = [
    { tag: "v1.0", sourceSha: sha("a"), bytes: Buffer.from("verified legacy package\n") },
    { tag: "v1.1", sourceSha: sha("b"), bytes: Buffer.from("expected package\n"), corrupt: true },
    { tag: "v1.2", sourceSha: sha("c"), bytes: Buffer.from("planned package\n") },
    { tag: "v1.3", sourceSha: sha("d"), bytes: Buffer.from("symlink package\n"), symlink: true },
  ];
  const db = openDb(dbPath);
  q.upsertGame(db, { slug, project_id: "project_release_migration", namespace: "owner",
    repo_slug: slug, title: "Migration fixture", license: "CC0-1.0", visibility: "private" });
  for (const fixture of fixtures) {
    const name = artifactName(fixture.tag);
    writeCached(fixture.sourceSha, name, fixture.corrupt ? Buffer.from("tampered package\n") : fixture.bytes);
    q.createRelease(db, { game_slug: slug, tag: fixture.tag, sha: fixture.sourceSha,
      title: fixture.tag, artifacts_json: JSON.stringify([receipt(name, fixture.bytes)]) });
  }
  db.close();

  // Dry-run is the default and is genuinely read-only: no vault path or DB
  // association appears after all receipts have been checked.
  const dry = invoke(args("v1.0", sha("a")));
  assert.equal(dry.status, 0, JSON.stringify(dry.body));
  assert.equal(dry.body.mode, "dry-run");
  assert.equal(dry.body.result, "would-seal-and-attach");
  assert.equal(dry.body.written, false);
  assert.equal(dry.body.cache.artifacts_verified, 1);
  assert.equal(existsSync(vaultDir), false);
  let check = openDb(dbPath);
  assert.equal(q.releaseByTag(check, slug, "v1.0").vault_manifest_sha256, null);
  check.close();

  const applied = invoke(args("v1.0", sha("a"), true));
  assert.equal(applied.status, 0);
  assert.equal(applied.body.result, "sealed-and-attached");
  assert.equal(applied.body.vault.seal_created, true);
  assert.equal(applied.body.vault.database_attached, true);
  const stored = createReleaseVault({ root: vaultDir }).readArtifact({ slug, tag: "v1.0",
    sourceSha: sha("a"), name: artifactName("v1.0") });
  assert.equal(stored.bytes.toString(), "verified legacy package\n");
  check = openDb(dbPath);
  assert.equal(q.releaseByTag(check, slug, "v1.0").vault_manifest_sha256,
    applied.body.vault.manifest_sha256);
  check.close();

  const retry = invoke(args("v1.0", sha("a"), true));
  assert.equal(retry.status, 0);
  assert.equal(retry.body.result, "already-attached-and-verified");
  assert.equal(retry.body.written, false);
  assert.equal(retry.body.vault.seal_created, false);
  assert.equal(retry.body.vault.database_attached, false);

  const corrupt = invoke(args("v1.1", sha("b"), true));
  assert.notEqual(corrupt.status, 0);
  assert.equal(corrupt.body.code, "MIGRATION_RECEIPT_MISMATCH");
  check = openDb(dbPath);
  assert.equal(q.releaseByTag(check, slug, "v1.1").vault_manifest_sha256, null);
  check.close();
  assert.throws(() => createReleaseVault({ root: vaultDir }).readRelease({ slug, tag: "v1.1" }),
    error => error?.code === "VAULT_MISSING");

  // A healthy pre-existing seal for the same tag but different bytes must be
  // retained and rejected, never overwritten or attached to the legacy row.
  const otherDir = join(temp, "different", "packages"); mkdirSync(otherDir, { recursive: true });
  const otherBytes = Buffer.from("different immutable package\n");
  writeFileSync(join(otherDir, "v1.2.zip"), otherBytes);
  const existing = createReleaseVault({ root: vaultDir }).publishRelease({ slug, tag: "v1.2",
    sourceSha: sha("c"), sourceDir: join(temp, "different"),
    artifacts: [receipt(artifactName("v1.2"), otherBytes)] });
  const conflict = invoke(args("v1.2", sha("c"), true));
  assert.notEqual(conflict.status, 0);
  assert.equal(conflict.body.code, "MIGRATION_VAULT_CONFLICT");
  assert.equal(createReleaseVault({ root: vaultDir }).readRelease({ slug, tag: "v1.2" }).manifestSha256,
    existing.manifestSha256);
  check = openDb(dbPath);
  assert.equal(q.releaseByTag(check, slug, "v1.2").vault_manifest_sha256, null);
  check.close();

  const linked = join(cacheDir, "exports", slug, sha("d"), artifactName("v1.3"));
  const outside = join(temp, "outside.zip"); writeFileSync(outside, Buffer.from("symlink package\n"));
  unlinkSync(linked); symlinkSync(outside, linked);
  const symlink = invoke(args("v1.3", sha("d")));
  assert.notEqual(symlink.status, 0);
  assert.equal(symlink.body.code, "MIGRATION_SYMLINK");

  const audit = invoke(["audit", "--vault-dir", vaultDir]);
  assert.equal(audit.status, 0);
  assert.equal(audit.body.ok, true);
  assert.equal(audit.body.command, "audit");
  assert.equal(audit.body.counts.manifests, 2);

  console.log("release vault migration CLI: dry-run, exact seal, retry, corruption, conflict, symlink, and audit passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
