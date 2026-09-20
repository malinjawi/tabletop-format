#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  realpathSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createReleaseVaultTasks } from "../platform/release-vault-tasks.mjs";
import {
  createReleaseVault, isReleaseVaultVersionSupported, RELEASE_VAULT_FORMAT,
  RELEASE_VAULT_NATIVE_VERSION, RELEASE_VAULT_SUPPORTED_VERSIONS, RELEASE_VAULT_VERSION,
} from "../platform/release-vault.mjs";

// macOS exposes /var and /tmp as compatibility symlinks. Resolve the test
// parent so normal fixtures exercise a real path; dedicated cases below prove
// that a configured symlink path is rejected.
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "forge-release-vault."));
const fullSha = "0123456789abcdef0123456789abcdef01234567";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const receipt = (name, bytes) => ({ status: "ready", name, bytes: bytes.length, sha256: hash(bytes) });
const put = (root, name, bytes) => {
  const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return path;
};
const expectCode = (code, run, label) => assert.throws(run,
  error => error?.code === code || (Array.isArray(code) && code.includes(error?.code)), label);

try {
  const initializedRoot=join(scratch,"initialized-empty-vault");
  const initializedVault=createReleaseVault({root:initializedRoot});
  initializedVault.initialize();
  for(const directory of ["blobs","blobs/sha256","manifests","staging"])
    assert.equal(existsSync(join(initializedRoot,directory)),true,
      `initialize provisions the known ${directory} directory before the first release`);
  assert.deepEqual(initializedVault.audit().counts,
    {manifests:0,blobs:0,staging:0,orphans:0,corruption:0});
  initializedVault.initialize();
  assert.equal(initializedVault.audit().ok,true,"vault initialization is idempotent");

  const source = join(scratch, "source"); mkdirSync(source);
  const pnp = Buffer.from("exact printable release\n"), setup = Buffer.from("<svg>exact setup</svg>\n");
  put(source, "pnp.pdf", pnp); put(source, "setup-maps/table.svg", setup);
  const artifacts = [receipt("setup-maps/table.svg", setup), receipt("pnp.pdf", pnp)];
  const root = join(scratch, "vault"), vault = createReleaseVault({ root });

  const published = vault.publishRelease({ slug: "alice~demo-game", tag: "v1.0", sourceSha: fullSha, sourceDir: source, artifacts });
  assert.equal(published.created, true);
  assert.equal(published.idempotent, false);
  assert.equal(published.manifest.format, RELEASE_VAULT_FORMAT);
  assert.equal(published.manifest.version, 1);
  assert.equal(RELEASE_VAULT_VERSION, 1, "the current writer continues to emit v1 bytes");
  assert.equal(RELEASE_VAULT_NATIVE_VERSION, 2, "native recoverable publications use a distinct v2 envelope");
  assert.deepEqual(RELEASE_VAULT_SUPPORTED_VERSIONS, [1, 2]);
  assert.equal(isReleaseVaultVersionSupported(1), true);
  assert.equal(isReleaseVaultVersionSupported(2), true);
  assert.deepEqual(published.manifest.artifacts.map(item => item.name), ["pnp.pdf", "setup-maps/table.svg"]);
  assert.match(published.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(published.manifestKey, "manifests/alice~demo-game/v1.0.json");
  const rawManifest = readFileSync(join(root, published.manifestKey), "utf8");
  const expectedV1Raw=`{"artifacts":[{"blob":"sha256:${hash(pnp)}","bytes":${pnp.length},"name":"pnp.pdf","sha256":"${hash(pnp)}"},{"blob":"sha256:${hash(setup)}","bytes":${setup.length},"name":"setup-maps/table.svg","sha256":"${hash(setup)}"}],"format":"${RELEASE_VAULT_FORMAT}","release":{"slug":"alice~demo-game","source_sha":"${fullSha}","tag":"v1.0"},"version":1}\n`;
  assert.equal(rawManifest,expectedV1Raw,
    "the legacy publishRelease writer preserves its exact canonical v1 bytes");
  assert(rawManifest.startsWith('{"artifacts":[') && rawManifest.endsWith("\n") && !rawManifest.includes("\n{"),
    "manifest is deterministic canonical JSON rather than presentation JSON");
  assert.equal(readdirSync(join(root, "staging")).length, 0, "successful publication leaves no staging files");

  const read = vault.readRelease({ slug: "alice~demo-game", tag: "v1.0", sourceSha: fullSha });
  assert.equal(read.manifestSha256, published.manifestSha256);
  assert.equal(read.manifest.release.source_sha, fullSha);
  assert.equal(read.manifest.version, 1, "read results expose the dispatched manifest version");
  const downloaded = vault.readArtifact({ slug: "alice~demo-game", tag: "v1.0", sourceSha: fullSha, name: "setup-maps/table.svg" });
  assert.deepEqual(downloaded.bytes, setup);
  assert.deepEqual(downloaded.receipt, published.manifest.artifacts[1]);
  assert.equal(downloaded.manifest.version, 1);

  const repeated = vault.publishRelease({ slug: "alice~demo-game", tag: "v1.0", sourceSha: fullSha,
    sourceDir: source, artifacts: [...artifacts].reverse() });
  assert.equal(repeated.created, false);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.manifestSha256, published.manifestSha256);
  assert.equal(readdirSync(join(root, "staging")).length, 0);
  assert.equal(vault.deleteRelease, undefined, "vault intentionally exposes no delete API");

  const nativeArtifacts=[...artifacts,{status:"failed_optional",kind:"vtt",error:"optional renderer unavailable"}];
  const nativePublication={created_at:1_725_000_000_000,sealed_at:1_725_000_000_000,
    release:{artifacts:nativeArtifacts,author_id:"usr_alice",build:{format:"forge-release-build",version:1},
      notes:"- exact release notes",rights:{publishable:true},title:"Recoverable publication"},
    event:{actor_id:"usr_alice",id:"ev_release_native_fixture",kind:"release"},
    publisher:{email:"alice@example.invalid",name:"alice"}};
  const native=vault.publishNativeRelease({slug:"alice~demo-game",tag:"v1.1",sourceSha:fullSha,
    sourceDir:source,artifacts,publication:nativePublication});
  assert.equal(native.manifest.version,2);
  assert.deepEqual(native.manifest.publication,nativePublication,
    "v2 cryptographically binds exact release, event, timing, and publisher metadata");
  const nativeRead=vault.readRelease({slug:"alice~demo-game",tag:"v1.1",sourceSha:fullSha});
  assert.equal(nativeRead.manifestSha256,native.manifestSha256);
  assert.deepEqual(nativeRead.manifest.publication,nativePublication);
  const runTask=createReleaseVaultTasks({root,concurrency:1});
  const reading=runTask("readRelease",{slug:"alice~demo-game",tag:"v1.1",sourceSha:fullSha});
  await assert.rejects(runTask("readRelease",{slug:"alice~demo-game",tag:"v1.1"}),{code:"VAULT_BUSY"});
  assert.deepEqual(await reading,nativeRead,"worker verification preserves canonical metadata and digest");
  assert.equal((await runTask("publishNativeRelease",{slug:"alice~demo-game",tag:"v1.1",sourceSha:fullSha,
    sourceDir:source,artifacts,publication:nativePublication})).idempotent,true);
  await assert.rejects(runTask("readRelease",{slug:"alice~demo-game",tag:"v404"}),{code:"VAULT_MISSING"});
  const nativeRepeat=vault.publishNativeRelease({slug:"alice~demo-game",tag:"v1.1",sourceSha:fullSha,
    sourceDir:source,artifacts:[...artifacts].reverse(),publication:nativePublication});
  assert.equal(nativeRepeat.idempotent,true);
  expectCode("VAULT_INPUT",()=>vault.publishNativeRelease({slug:"alice~demo-game",tag:"v1.2",
    sourceSha:fullSha,sourceDir:source,artifacts,
    publication:{...nativePublication,release:{...nativePublication.release,artifacts:[artifacts[0]]}}}),
  "v2 refuses publication metadata whose ready receipts omit immutable blobs");

  writeFileSync(join(source, "pnp.pdf"), "changed after receipt\n");
  expectCode("VAULT_RECEIPT_MISMATCH", () => vault.publishRelease({ slug: "alice~demo-game", tag: "v1.0",
    sourceSha: fullSha, sourceDir: source, artifacts }), "source bytes must match the release receipt before idempotence is accepted");
  assert.deepEqual(vault.readArtifact({ slug: "alice~demo-game", tag: "v1.0", name: "pnp.pdf" }).bytes, pnp,
    "a failed retry never overwrites the preserved blob");
  writeFileSync(join(source, "pnp.pdf"), pnp);

  const alternate = Buffer.from("a different but valid release\n");
  const alternateSource = join(scratch, "alternate-source"); mkdirSync(alternateSource); put(alternateSource, "pnp.pdf", alternate);
  expectCode("VAULT_CONFLICT", () => vault.publishRelease({ slug: "alice~demo-game", tag: "v1.0",
    sourceSha: fullSha, sourceDir: alternateSource, artifacts: [receipt("pnp.pdf", alternate)] }),
  "one game/tag cannot be rebound to a different exact manifest");
  assert.deepEqual(vault.readArtifact({ slug: "alice~demo-game", tag: "v1.0", name: "pnp.pdf" }).bytes, pnp);

  for (const bad of [
    { slug: "../demo", tag: "v1.1", sourceSha: fullSha, artifacts: [receipt("pnp.pdf", pnp)] },
    { slug: "demo", tag: "latest", sourceSha: fullSha, artifacts: [receipt("pnp.pdf", pnp)] },
    { slug: "demo", tag: "v1.1", sourceSha: fullSha.slice(0, 12), artifacts: [receipt("pnp.pdf", pnp)] },
    { slug: "demo", tag: "v1.1", sourceSha: fullSha, artifacts: [{ ...receipt("../pnp.pdf", pnp) }] },
    { slug: "demo", tag: "v1.1", sourceSha: fullSha, artifacts: [receipt("pnp.pdf", pnp), receipt("pnp.pdf", pnp)] },
    { slug: "demo", tag: "v1.1", sourceSha: fullSha, artifacts: [{ ...receipt("pnp.pdf", pnp), status: "failed_optional" }] },
  ]) expectCode("VAULT_INPUT", () => vault.publishRelease({ ...bad, sourceDir: source }), "unsafe release identity or receipt must fail closed");

  const symlinkSource = join(scratch, "symlink-source"); mkdirSync(symlinkSource);
  symlinkSync(join(source, "pnp.pdf"), join(symlinkSource, "pnp.pdf"));
  expectCode("VAULT_SYMLINK", () => vault.publishRelease({ slug: "demo", tag: "v1.2", sourceSha: fullSha,
    sourceDir: symlinkSource, artifacts: [receipt("pnp.pdf", pnp)] }), "source artifact symlinks are not followed");

  // The root is checked one path component at a time before any directory is
  // created. A missing vault leaf therefore cannot escape into a mutable cache
  // through an existing ancestor alias.
  const mutableCache = join(scratch, "mutable-cache"); mkdirSync(mutableCache);
  const cacheAlias = join(scratch, "cache-alias"); symlinkSync(mutableCache, cacheAlias);
  const aliasedVault = createReleaseVault({ root: join(cacheAlias, "release-vault") });
  expectCode("VAULT_SYMLINK",()=>aliasedVault.initialize(),
    "startup initialization cannot traverse a configured symlink ancestor");
  expectCode("VAULT_SYMLINK", () => aliasedVault.publishRelease({ slug: "demo", tag: "v1.3", sourceSha: fullSha,
    sourceDir: source, artifacts }), "a missing vault beneath a symlinked root ancestor is rejected");
  assert.equal(existsSync(join(mutableCache, "release-vault")), false,
    "vault initialization never follows the alias or creates data in the cache target");
  const aliasAudit = aliasedVault.audit();
  assert.equal(aliasAudit.ok, false, "audit also rejects a configured vault path containing an ancestor symlink");
  assert(aliasAudit.corruption.some(item => item.path === "." && item.code === "symlink"));

  // Future envelopes are rejected by the reader dispatch explicitly, while
  // the original v1 fixture above remains readable through the permanent v1
  // reader rather than a check against the writer constant.
  const futureRoot = join(scratch, "future-vault"), futureVault = createReleaseVault({ root: futureRoot });
  const futurePublished = futureVault.publishRelease({ slug: "demo", tag: "v1.4", sourceSha: fullSha,
    sourceDir: source, artifacts });
  const futureManifest = join(futureRoot, futurePublished.manifestKey);
  const futureRaw = readFileSync(futureManifest, "utf8").replace('"version":1', '"version":99');
  assert.notEqual(futureRaw, readFileSync(futureManifest, "utf8"), "future-version fixture changed the envelope");
  writeFileSync(futureManifest, futureRaw);
  expectCode("VAULT_UNSUPPORTED_VERSION", () => futureVault.readRelease({ slug: "demo", tag: "v1.4" }),
    "unknown future manifest versions fail explicitly rather than being parsed as v1");

  // External damage is never silently repaired by a publish retry or read.
  const corruptSource = join(scratch, "corrupt-source"); mkdirSync(corruptSource); put(corruptSource, "artifact.bin", Buffer.from("preserve me"));
  const corruptReceipt = receipt("artifact.bin", Buffer.from("preserve me"));
  const corruptRoot = join(scratch, "corrupt-vault"), corruptVault = createReleaseVault({ root: corruptRoot });
  const corruptPublished = corruptVault.publishRelease({ slug: "demo", tag: "v2.0", sourceSha: fullSha,
    sourceDir: corruptSource, artifacts: [corruptReceipt] });
  const corruptBlob = join(corruptRoot, "blobs", "sha256", corruptReceipt.sha256.slice(0, 2), corruptReceipt.sha256);
  writeFileSync(corruptBlob, "tampered");
  expectCode("VAULT_CORRUPT", () => corruptVault.readRelease({ slug: "demo", tag: "v2.0" }),
    "reads reject corrupt content-addressed blobs");
  expectCode("VAULT_CORRUPT", () => corruptVault.publishRelease({ slug: "demo", tag: "v2.0", sourceSha: fullSha,
    sourceDir: corruptSource, artifacts: [corruptReceipt] }), "idempotent publish refuses to repair or replace corrupt finalized bytes");
  assert.equal(readFileSync(corruptBlob, "utf8"), "tampered");
  const corruptAudit = corruptVault.audit();
  assert.equal(corruptAudit.ok, false);
  assert(corruptAudit.corruption.some(item => item.code === "digest-mismatch"));
  assert(corruptAudit.corruption.some(item => item.code === "missing-or-corrupt-blob"));
  assert.equal(corruptPublished.manifestSha256.length, 64);

  const symlinkRoot = join(scratch, "symlink-vault"), symlinkVault = createReleaseVault({ root: symlinkRoot });
  symlinkVault.publishRelease({ slug: "demo", tag: "v3.0", sourceSha: fullSha, sourceDir: corruptSource, artifacts: [corruptReceipt] });
  const manifestPath = join(symlinkRoot, "manifests", "demo", "v3.0.json");
  unlinkSync(manifestPath); symlinkSync(join(source, "pnp.pdf"), manifestPath);
  expectCode("VAULT_SYMLINK", () => symlinkVault.readRelease({ slug: "demo", tag: "v3.0" }),
    "manifest symlinks are not followed");
  const symlinkAudit = symlinkVault.audit();
  assert(symlinkAudit.corruption.some(item => item.path === "manifests/demo/v3.0.json" && item.code === "symlink"));

  const blobSymlinkRoot = join(scratch, "blob-symlink-vault"), blobSymlinkVault = createReleaseVault({ root: blobSymlinkRoot });
  blobSymlinkVault.publishRelease({ slug: "demo", tag: "v3.1", sourceSha: fullSha,
    sourceDir: corruptSource, artifacts: [corruptReceipt] });
  const blobSymlinkPath = join(blobSymlinkRoot, "blobs", "sha256", corruptReceipt.sha256.slice(0, 2), corruptReceipt.sha256);
  unlinkSync(blobSymlinkPath); symlinkSync(join(source, "pnp.pdf"), blobSymlinkPath);
  expectCode("VAULT_SYMLINK", () => blobSymlinkVault.readArtifact({ slug: "demo", tag: "v3.1", name: "artifact.bin" }),
    "blob symlinks are not followed");
  assert(blobSymlinkVault.audit().corruption.some(item => item.code === "symlink"));

  // Audit distinguishes incomplete staging and unreferenced valid blobs from corruption.
  const orphan = Buffer.from("valid unreferenced vault object"), orphanHash = hash(orphan);
  const orphanPath = join(root, "blobs", "sha256", orphanHash.slice(0, 2), orphanHash);
  mkdirSync(dirname(orphanPath), { recursive: true }); writeFileSync(orphanPath, orphan);
  writeFileSync(join(root, "staging", "interrupted.tmp"), "partial");
  const audit = vault.audit();
  assert.equal(audit.ok, false, "staging remnants make the vault audit non-green");
  assert.deepEqual(audit.counts, { manifests: 2, blobs: 3, staging: 1, orphans: 1, corruption: 0 });
  assert(audit.staging.some(item => item.path === "staging/interrupted.tmp"));
  assert(audit.orphans.some(item => item.sha256 === orphanHash));
  assert.equal(audit.corruption.length, 0);

  // Missing finalized bytes fail closed and are named by audit.
  const missingRoot = join(scratch, "missing-vault"), missingVault = createReleaseVault({ root: missingRoot });
  missingVault.publishRelease({ slug: "demo", tag: "v4.0", sourceSha: fullSha, sourceDir: corruptSource, artifacts: [corruptReceipt] });
  const missingBlob = join(missingRoot, "blobs", "sha256", corruptReceipt.sha256.slice(0, 2), corruptReceipt.sha256);
  unlinkSync(missingBlob);
  expectCode("VAULT_MISSING", () => missingVault.readArtifact({ slug: "demo", tag: "v4.0", name: "artifact.bin" }),
    "missing finalized blobs fail closed");
  assert(missingVault.audit().corruption.some(item => item.code === "missing-or-corrupt-blob"));

  const partialRoot = join(scratch, "partial-vault"); mkdirSync(partialRoot);
  const partialAudit = createReleaseVault({ root: partialRoot }).audit();
  assert.equal(partialAudit.ok, false, "an initialized-looking root without its required directories is not healthy");
  assert(partialAudit.corruption.some(item => item.path === "manifests" && item.code === "missing"));

  assert(!existsSync(join(root, "delete")), "test never relies on a mutable vault endpoint");
  console.log("RELEASE VAULT GREEN — canonical release bindings, checked receipts, create-only CAS blobs, idempotence, fail-closed reads, and integrity audit verified.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
