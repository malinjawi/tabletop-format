#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createReleaseVault } from "../platform/release-vault.mjs";

const ROOT = resolve(import.meta.dirname, ".."), SCRIPT = join(ROOT, "deploy", "release-vault-snapshot.mjs");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "forge-release-vault-snapshot-test-")));
const sha256 = value => createHash("sha256").update(value).digest("hex");
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
const succeeds = (...args) => {
  const result = run(...args);
  assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
};
const fails = (...args) => {
  const result = run(...args);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
  return result;
};

try {
  const source = join(scratch, "source"), payload = join(scratch, "payload");
  const snapshot = join(scratch, "snapshot"), restored = join(scratch, "restored");
  mkdirSync(join(payload, "nested"), { recursive: true });
  const payloads = new Map([
    ["alpha.bin", Buffer.from([0, 1, 2, 3, 255])],
    ["nested/release-v1.json", Buffer.from("{\"release\":\"v1\"}\n")],
    ["empty.dat", Buffer.alloc(0)],
  ]);
  for (const [name, bytes] of payloads) writeFileSync(join(payload, ...name.split("/")), bytes);
  const sourceSha = "a".repeat(40);
  createReleaseVault({ root: source }).publishRelease({
    slug: "ember", tag: "v1", sourceSha, sourceDir: payload,
    artifacts: [...payloads].map(([name, bytes]) => ({
      status: "ready", name, bytes: bytes.length, sha256: sha256(bytes),
    })),
  });

  succeeds("backup", "--source", source, "--output", snapshot);
  succeeds("verify", "--input", snapshot);
  const manifest = JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8"));
  assert.equal(manifest.format, "forge-release-vault-snapshot");
  assert.equal(manifest.version, 1);
  assert(manifest.files.some(file => file.path === "manifests/ember/v1.json"));
  assert(manifest.files.some(file => file.path.startsWith("blobs/sha256/")));
  for (const file of manifest.files) {
    assert.equal(file.file, sha256(Buffer.from(file.path)));
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }

  succeeds("restore", "--input", snapshot, "--output", restored);
  const restoredVault = createReleaseVault({ root: restored });
  assert.equal(restoredVault.audit().ok, true);
  for (const [name, bytes] of payloads)
    assert.deepEqual(restoredVault.readArtifact({ slug: "ember", tag: "v1", sourceSha, name }).bytes, bytes);

  const nonempty = join(scratch, "nonempty");
  mkdirSync(nonempty); writeFileSync(join(nonempty, "keep"), "untouched");
  assert.match(fails("restore", "--input", snapshot, "--output", nonempty).stderr, /not empty/);
  assert.equal(readFileSync(join(nonempty, "keep"), "utf8"), "untouched");

  const corrupt = join(scratch, "corrupt");
  cpSync(snapshot, corrupt, { recursive: true });
  writeFileSync(join(corrupt, "objects", manifest.files[0].file), "corrupt");
  assert.match(fails("verify", "--input", corrupt).stderr, /integrity check/);

  const extra = join(scratch, "extra");
  cpSync(snapshot, extra, { recursive: true });
  writeFileSync(join(extra, "objects", "f".repeat(64)), "undeclared");
  assert.match(fails("verify", "--input", extra).stderr, /undeclared or unsafe object/);

  const traversal = join(scratch, "traversal"), escaped = join(scratch, "escaped");
  cpSync(snapshot, traversal, { recursive: true });
  const malicious = JSON.parse(readFileSync(join(traversal, "manifest.json"), "utf8"));
  malicious.files[0].path = "../escaped";
  writeFileSync(join(traversal, "manifest.json"), `${JSON.stringify(malicious)}\n`);
  assert.match(fails("restore", "--input", traversal, "--output", join(scratch, "traversal-output")).stderr,
    /malformed file record/);
  assert.equal(existsSync(escaped), false);

  const unsafeSource = join(scratch, "unsafe-source"), unsafeOutput = join(scratch, "unsafe-output");
  mkdirSync(unsafeSource); writeFileSync(join(unsafeSource, "target"), "bytes");
  symlinkSync("target", join(unsafeSource, "link"));
  assert.match(fails("backup", "--source", unsafeSource, "--output", unsafeOutput).stderr, /symbolic link/);
  assert.equal(existsSync(unsafeOutput), false);

  const invalidVault = join(scratch, "invalid-vault"), invalidSnapshot = join(scratch, "invalid-snapshot");
  mkdirSync(join(invalidVault, "blobs", "sha256"), { recursive: true });
  mkdirSync(join(invalidVault, "manifests", "ember"), { recursive: true });
  mkdirSync(join(invalidVault, "staging"), { recursive: true });
  writeFileSync(join(invalidVault, "manifests", "ember", "v1.json"), "not a release manifest\n");
  assert.match(fails("backup", "--source", invalidVault, "--output", invalidSnapshot).stderr,
    /semantic release-vault audit/);
  assert.equal(existsSync(invalidSnapshot), false);

  const alias = join(scratch, "source-alias");
  symlinkSync(source, alias);
  assert.match(fails("backup", "--source", source, "--output", join(alias, "nested-backup")).stderr,
    /symbolic link/);
  assert.equal(existsSync(join(source, "nested-backup")), false);

  // A snapshot whose byte inventory has been maliciously made self-consistent
  // still cannot restore a semantically invalid release vault.
  const semanticCorrupt = join(scratch, "semantic-corrupt");
  cpSync(snapshot, semanticCorrupt, { recursive: true });
  const corruptManifest = JSON.parse(readFileSync(join(semanticCorrupt, "manifest.json"), "utf8"));
  const vaultManifest = corruptManifest.files.find(file => file.path === "manifests/ember/v1.json");
  const corruptBytes = Buffer.from("not a release manifest\n");
  writeFileSync(join(semanticCorrupt, "objects", vaultManifest.file), corruptBytes);
  corruptManifest.total_bytes += corruptBytes.length - vaultManifest.bytes;
  vaultManifest.bytes = corruptBytes.length;
  vaultManifest.sha256 = sha256(corruptBytes);
  writeFileSync(join(semanticCorrupt, "manifest.json"), `${JSON.stringify(corruptManifest, null, 2)}\n`);
  succeeds("verify", "--input", semanticCorrupt);
  assert.match(fails("restore", "--input", semanticCorrupt, "--output", join(scratch, "semantic-output")).stderr,
    /semantic release-vault audit/);

  console.log("RELEASE VAULT SNAPSHOT TEST GREEN — semantic vault audit, safe canonical paths, hashes, corruption checks, and empty-target restore enforced.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
