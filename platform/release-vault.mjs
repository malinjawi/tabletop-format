/**
 * release-vault.mjs — append-only preservation for published release bytes.
 *
 * This is deliberately separate from Store 3. The cache may be regenerated or
 * garbage-collected; a vault release is a create-only binding from
 * (storage slug, release tag) to one canonical manifest and content-addressed
 * blobs. There is intentionally no overwrite or delete API.
 *
 * Filesystem layout:
 *   blobs/sha256/ab/<64 lowercase hex>
 *   manifests/<storage-slug>/<release-tag>.json
 *   staging/<random>.tmp                         (crash remnants only)
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants as FS, existsSync, fsyncSync, fstatSync, linkSync,
  lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const FORMAT = "forge-release-vault-manifest";
const VERSION = 1;
const NATIVE_VERSION = 2;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}(?:~[a-z0-9][a-z0-9_-]{0,63})?$/;
const TAG_RE = /^v[0-9][0-9A-Za-z._-]{0,31}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ARTIFACT_SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const COPY_BUFFER_BYTES = 1024 * 1024;

/** @typedef {{ root?: string }} ReleaseVaultOptions */
/** @typedef {{ status?: "ready", name: string, bytes: number, sha256: string }} ReleaseArtifactReceiptInput */
/** @typedef {{ slug?: string, tag?: string, sourceSha?: string, sourceDir?: string, artifacts?: ReleaseArtifactReceiptInput[] }} PublishReleaseInput */
/** @typedef {PublishReleaseInput & { publication?: unknown }} PublishNativeReleaseInput */
/** @typedef {{ slug?: string, tag?: string, sourceSha?: string }} ReadReleaseInput */
/** @typedef {{ slug?: string, tag?: string, sourceSha?: string, name?: string }} ReadArtifactInput */

export class ReleaseVaultError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ReleaseVaultError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => { throw new ReleaseVaultError(code, message, details); };
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const ownKeys = value => value && typeof value === "object" && !Array.isArray(value)
  ? Object.keys(value).sort() : null;
const sameKeys = (value, expected) => {
  const keys = ownKeys(value);
  return !!keys && keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
};

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("VAULT_MANIFEST", "canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("VAULT_MANIFEST", "canonical JSON contains an unsupported value");
}

const canonicalBytes = value => Buffer.from(`${canonicalJson(value)}\n`, "utf8");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function validSlug(value) {
  if (typeof value !== "string" || !SLUG_RE.test(value))
    fail("VAULT_INPUT", "release vault slug must be a safe Forge storage slug");
  return value;
}

function validTag(value) {
  if (typeof value !== "string" || !TAG_RE.test(value))
    fail("VAULT_INPUT", "release vault tag must match Forge's v-prefixed release-tag format");
  return value;
}

function validSourceSha(value) {
  if (typeof value !== "string" || !SHA1_RE.test(value))
    fail("VAULT_INPUT", "release vault sourceSha must be a full lowercase 40-character Git SHA");
  return value;
}

function validArtifactName(value) {
  if (typeof value !== "string" || !value || value.length > 512 || value.startsWith("/") || value.includes("\\") || value.includes("\0"))
    fail("VAULT_INPUT", "release artifact name must be a safe relative path");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.length > 200 || !ARTIFACT_SEGMENT_RE.test(part)))
    fail("VAULT_INPUT", `unsafe release artifact name '${value}'`);
  return value;
}

function validReceipt(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("VAULT_INPUT", "release artifact receipt must be an object");
  if (input.status != null && input.status !== "ready")
    fail("VAULT_INPUT", `release artifact '${String(input.name || "")}' is not ready`);
  const name = validArtifactName(input.name);
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0)
    fail("VAULT_INPUT", `release artifact '${name}' has an invalid byte receipt`);
  if (typeof input.sha256 !== "string" || !SHA256_RE.test(input.sha256))
    fail("VAULT_INPUT", `release artifact '${name}' has an invalid lowercase SHA-256 receipt`);
  return { name, bytes: input.bytes, sha256: input.sha256, blob: `sha256:${input.sha256}` };
}

function manifestFor({ slug, tag, sourceSha, artifacts }) {
  const names = new Set();
  const receipts = artifacts.map(validReceipt).sort((a, b) => compareText(a.name, b.name));
  if (!receipts.length) fail("VAULT_INPUT", "a release vault manifest needs at least one ready artifact");
  for (const receipt of receipts) {
    if (names.has(receipt.name)) fail("VAULT_INPUT", `duplicate release artifact '${receipt.name}'`);
    names.add(receipt.name);
  }
  return {
    artifacts: receipts,
    format: FORMAT,
    release: { slug: validSlug(slug), source_sha: validSourceSha(sourceSha), tag: validTag(tag) },
    version: VERSION,
  };
}

function publicationText(value, label, { optional = false, max = 100_000 } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0]/.test(value))
    fail("VAULT_INPUT", `native release publication has invalid ${label}`);
  return value;
}

function publicationJsonValue(value, label, { optional = false } = {}) {
  if (value == null && optional) return null;
  let encoded;
  try { encoded = canonicalJson(value); }
  catch (error) { fail("VAULT_INPUT", `native release publication has invalid ${label}: ${error.message}`); }
  if (Buffer.byteLength(encoded, "utf8") > 5_000_000)
    fail("VAULT_INPUT", `native release publication ${label} is too large`);
  return value;
}

function validatedPublicationV2(value, vaultArtifacts, code = "VAULT_INPUT") {
  // `publisher` is Forge's sealed human credit/recovery identity. It is not a
  // claim about the Git tagger: hosted Store-1 APIs such as Forgejo may record
  // their authenticated repository actor instead. Live verification binds the
  // protected tag object, target, and vault marker message instead.
  const invalid = message => fail(code, `native release publication ${message}`);
  if (!sameKeys(value, ["created_at", "event", "publisher", "release", "sealed_at"]))
    invalid("has an invalid envelope");
  if (!Number.isSafeInteger(value.created_at) || value.created_at < 0)
    invalid("has an invalid creation time");
  if (!Number.isSafeInteger(value.sealed_at) || value.sealed_at < 0) invalid("has an invalid seal time");
  if (!sameKeys(value.release, ["artifacts", "author_id", "build", "notes", "rights", "title"]))
    invalid("has invalid release metadata");
  if (!sameKeys(value.event, ["actor_id", "id", "kind"]) || value.event.kind !== "release")
    invalid("has invalid event metadata");
  if (!sameKeys(value.publisher, ["email", "name"])) invalid("has invalid publisher metadata");
  let title, notes, authorId, eventId, eventActorId, publisherName, publisherEmail,
    rights, build, artifactReport;
  try {
    title = publicationText(value.release.title, "title", { optional: true, max: 160 });
    notes = publicationText(value.release.notes, "notes", { max: 500_000 });
    authorId = publicationText(value.release.author_id, "author id", { max: 256 });
    eventId = publicationText(value.event.id, "event id", { max: 256 });
    eventActorId = publicationText(value.event.actor_id, "event actor id", { max: 256 });
    publisherName = publicationText(value.publisher.name, "publisher name", { max: 200 });
    publisherEmail = publicationText(value.publisher.email, "publisher email", { max: 320 });
    rights = publicationJsonValue(value.release.rights, "rights", { optional: true });
    build = publicationJsonValue(value.release.build, "build", { optional: true });
    artifactReport = publicationJsonValue(value.release.artifacts, "artifact report");
  } catch (error) {
    if (code === "VAULT_INPUT") throw error;
    invalid(error.message);
  }
  if (authorId !== eventActorId)
    invalid("must bind the release author to the event actor");
  if (/\r|\n|</.test(publisherName) || /\s|\r|\n|<|>/.test(publisherEmail)
      || !publisherEmail.includes("@")) invalid("has unsafe publisher metadata");
  if (!Array.isArray(artifactReport) || !artifactReport.length)
    invalid("has no artifact report");
  const ready = [], names = new Set();
  for (const item of artifactReport) {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("has a malformed artifact report");
    if (item.status === "ready") {
      let receipt;
      try { receipt = validReceipt(item); }
      catch (error) { invalid(`has an invalid ready artifact: ${error.message}`); }
      if (names.has(receipt.name)) invalid(`repeats artifact '${receipt.name}'`);
      names.add(receipt.name); ready.push(receipt);
    } else if (item.status === "failed_optional") {
      if (typeof item.kind !== "string" || !item.kind || item.kind.length > 80
          || typeof item.error !== "string" || !item.error || item.error.length > 1000)
        invalid("has an invalid optional-export failure receipt");
    } else invalid("contains an unsupported artifact status");
  }
  const compact = items => items.map(item => ({ name: item.name, bytes: item.bytes, sha256: item.sha256 }))
    .sort((a, b) => compareText(a.name, b.name));
  if (canonicalJson(compact(ready)) !== canonicalJson(compact(vaultArtifacts)))
    invalid("artifact report does not match its immutable blobs");
  return {
    created_at: value.created_at,
    event: { actor_id: eventActorId, id: eventId, kind: "release" },
    publisher: { email: publisherEmail, name: publisherName },
    release: { artifacts: artifactReport, author_id: authorId,
      build, notes, rights, title },
    sealed_at: value.sealed_at,
  };
}

function nativeManifestFor({ slug, tag, sourceSha, artifacts, publication }) {
  const base = manifestFor({ slug, tag, sourceSha, artifacts });
  return { artifacts: base.artifacts, format: FORMAT,
    publication: validatedPublicationV2(publication, base.artifacts),
    release: base.release, version: NATIVE_VERSION };
}

function validateManifestV1(value) {
  if (!sameKeys(value, ["artifacts", "format", "release", "version"])
      || value.format !== FORMAT || value.version !== 1 || !Array.isArray(value.artifacts))
    fail("VAULT_CORRUPT", "release vault manifest has an invalid envelope");
  if (!sameKeys(value.release, ["slug", "source_sha", "tag"]))
    fail("VAULT_CORRUPT", "release vault manifest has an invalid release binding");
  let slug, tag, sourceSha;
  try {
    slug = validSlug(value.release.slug);
    tag = validTag(value.release.tag);
    sourceSha = validSourceSha(value.release.source_sha);
  } catch (error) {
    fail("VAULT_CORRUPT", `release vault manifest binding is invalid: ${error.message}`);
  }
  if (!value.artifacts.length) fail("VAULT_CORRUPT", "release vault manifest contains no artifacts");
  const artifacts = [], names = new Set();
  for (const raw of value.artifacts) {
    if (!sameKeys(raw, ["blob", "bytes", "name", "sha256"]))
      fail("VAULT_CORRUPT", "release vault manifest contains an invalid artifact receipt");
    let receipt;
    try { receipt = validReceipt(raw); }
    catch (error) { fail("VAULT_CORRUPT", `release vault artifact receipt is invalid: ${error.message}`); }
    if (raw.blob !== `sha256:${receipt.sha256}`)
      fail("VAULT_CORRUPT", `release artifact '${receipt.name}' is bound to the wrong blob`);
    if (names.has(receipt.name)) fail("VAULT_CORRUPT", `release vault manifest repeats '${receipt.name}'`);
    names.add(receipt.name); artifacts.push(receipt);
  }
  const sorted = [...artifacts].sort((a, b) => compareText(a.name, b.name));
  if (artifacts.some((artifact, index) => artifact.name !== sorted[index].name))
    fail("VAULT_CORRUPT", "release vault manifest artifacts are not in canonical name order");
  return { artifacts, format: FORMAT, release: { slug, source_sha: sourceSha, tag }, version: 1 };
}

function validateManifestV2(value) {
  if (!sameKeys(value, ["artifacts", "format", "publication", "release", "version"])
      || value.format !== FORMAT || value.version !== NATIVE_VERSION || !Array.isArray(value.artifacts))
    fail("VAULT_CORRUPT", "release vault manifest has an invalid envelope");
  if (!sameKeys(value.release, ["slug", "source_sha", "tag"]))
    fail("VAULT_CORRUPT", "release vault manifest has an invalid release binding");
  let slug, tag, sourceSha;
  try {
    slug = validSlug(value.release.slug); tag = validTag(value.release.tag);
    sourceSha = validSourceSha(value.release.source_sha);
  } catch (error) { fail("VAULT_CORRUPT", `release vault manifest binding is invalid: ${error.message}`); }
  if (!value.artifacts.length) fail("VAULT_CORRUPT", "release vault manifest contains no artifacts");
  const artifacts = [], names = new Set();
  for (const raw of value.artifacts) {
    if (!sameKeys(raw, ["blob", "bytes", "name", "sha256"]))
      fail("VAULT_CORRUPT", "release vault manifest contains an invalid artifact receipt");
    let receipt;
    try { receipt = validReceipt(raw); }
    catch (error) { fail("VAULT_CORRUPT", `release vault artifact receipt is invalid: ${error.message}`); }
    if (raw.blob !== `sha256:${receipt.sha256}`)
      fail("VAULT_CORRUPT", `release artifact '${receipt.name}' is bound to the wrong blob`);
    if (names.has(receipt.name)) fail("VAULT_CORRUPT", `release vault manifest repeats '${receipt.name}'`);
    names.add(receipt.name); artifacts.push(receipt);
  }
  const sorted = [...artifacts].sort((a, b) => compareText(a.name, b.name));
  if (artifacts.some((artifact, index) => artifact.name !== sorted[index].name))
    fail("VAULT_CORRUPT", "release vault manifest artifacts are not in canonical name order");
  const publication = validatedPublicationV2(value.publication, artifacts, "VAULT_CORRUPT");
  return { artifacts, format: FORMAT, publication,
    release: { slug, source_sha: sourceSha, tag }, version: NATIVE_VERSION };
}

// Readers are deliberately version-dispatched instead of being coupled to the
// current writer version. Once published, a v1 release must remain readable
// even after Forge gains a newer manifest writer.
const MANIFEST_READERS = new Map([[1, validateManifestV1], [2, validateManifestV2]]);
const SUPPORTED_VERSIONS = Object.freeze([...MANIFEST_READERS.keys()].sort((a, b) => a - b));

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.format !== FORMAT || !Object.hasOwn(value, "version"))
    fail("VAULT_CORRUPT", "release vault manifest has an invalid envelope");
  if (!Number.isSafeInteger(value.version) || value.version < 1)
    fail("VAULT_CORRUPT", "release vault manifest has an invalid version");
  const reader = MANIFEST_READERS.get(value.version);
  if (!reader)
    fail("VAULT_UNSUPPORTED_VERSION", `release vault manifest version ${value.version} is not supported`,
      { version: value.version, supportedVersions: [...SUPPORTED_VERSIONS] });
  return reader(value);
}

function lstatOrNull(path) {
  try { return lstatSync(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function assertDirectory(path, label) {
  const stat = lstatOrNull(path);
  if (!stat) fail("VAULT_MISSING", `${label} is missing`);
  if (stat.isSymbolicLink()) fail("VAULT_SYMLINK", `${label} must not be a symbolic link`);
  if (!stat.isDirectory()) fail("VAULT_CORRUPT", `${label} is not a directory`);
}

function makeDirectory(path, parent, label) {
  const current = lstatOrNull(path);
  if (current) {
    if (current.isSymbolicLink()) fail("VAULT_SYMLINK", `${label} must not be a symbolic link`);
    if (!current.isDirectory()) fail("VAULT_CORRUPT", `${label} is not a directory`);
    return false;
  }
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    assertDirectory(path, label);
    return false;
  }
  fsyncDirectory(parent);
  return true;
}

function fsyncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, FS.O_RDONLY | (FS.O_DIRECTORY || 0) | (FS.O_NOFOLLOW || 0));
    fsyncSync(fd);
  } finally { if (fd != null) closeSync(fd); }
}

function readRegular(path, label) {
  const stat = lstatOrNull(path);
  if (!stat) fail("VAULT_MISSING", `${label} is missing`);
  if (stat.isSymbolicLink()) fail("VAULT_SYMLINK", `${label} must not be a symbolic link`);
  if (!stat.isFile()) fail("VAULT_CORRUPT", `${label} is not a regular file`);
  let fd;
  try {
    fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()) fail("VAULT_CORRUPT", `${label} is not a regular file`);
    return readFileSync(fd);
  } catch (error) {
    if (error?.code === "ELOOP") fail("VAULT_SYMLINK", `${label} must not be a symbolic link`);
    throw error;
  } finally { if (fd != null) closeSync(fd); }
}

function digestRegular(path,label){
  let fd;
  try{
    const stat=lstatOrNull(path);
    if(!stat)fail("VAULT_MISSING",`${label} is missing`);
    if(stat.isSymbolicLink())fail("VAULT_SYMLINK",`${label} must not be a symbolic link`);
    if(!stat.isFile())fail("VAULT_CORRUPT",`${label} is not a regular file`);
    fd=openSync(path,FS.O_RDONLY|(FS.O_NOFOLLOW||0)|(FS.O_NONBLOCK||0));
    if(!fstatSync(fd).isFile())fail("VAULT_CORRUPT",`${label} is not a regular file`);
    const hash=createHash("sha256"),buffer=Buffer.allocUnsafe(COPY_BUFFER_BYTES);let bytes=0;
    while(true){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;bytes+=count;hash.update(buffer.subarray(0,count));}
    return {bytes,sha256:hash.digest("hex")};
  }finally{if(fd!=null)closeSync(fd);}
}

function sameRegularFiles(left,right){
  let a,b;
  try{
    a=openSync(left,FS.O_RDONLY|(FS.O_NOFOLLOW||0));b=openSync(right,FS.O_RDONLY|(FS.O_NOFOLLOW||0));
    const as=fstatSync(a),bs=fstatSync(b);if(!as.isFile()||!bs.isFile()||as.size!==bs.size)return false;
    const x=Buffer.allocUnsafe(COPY_BUFFER_BYTES),y=Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset=0;
    while(offset<as.size){
      const size=Math.min(x.length,as.size-offset);let nx=0,ny=0;
      while(nx<size){const n=readSync(a,x,nx,size-nx,offset+nx);if(!n)return false;nx+=n;}
      while(ny<size){const n=readSync(b,y,ny,size-ny,offset+ny);if(!n)return false;ny+=n;}
      if(!x.subarray(0,size).equals(y.subarray(0,size)))return false;offset+=size;
    }
    return true;
  }finally{if(a!=null)closeSync(a);if(b!=null)closeSync(b);}
}

function assertContained(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    fail("VAULT_INPUT", "release vault path escaped its configured root");
}

function rootPathChain(path) {
  const chain = [];
  let cursor = resolve(path);
  while (true) {
    chain.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return chain;
}

function ensureRootPathWithoutSymlinks(path, { create = false } = {}) {
  const chain = rootPathChain(path);
  for (let index = 0; index < chain.length; index += 1) {
    const current = chain[index], stat = lstatOrNull(current);
    const label = index === chain.length - 1
      ? "release vault root"
      : `release vault root ancestor '${current}'`;
    if (stat) {
      if (stat.isSymbolicLink()) fail("VAULT_SYMLINK", `${label} must not be a symbolic link`);
      if (!stat.isDirectory()) fail("VAULT_CORRUPT", `${label} is not a directory`);
      continue;
    }
    if (!create) fail("VAULT_MISSING", "release vault root is missing");
    const parent = chain[index - 1];
    if (!parent) fail("VAULT_CORRUPT", "filesystem root is missing");
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const created = lstatOrNull(current);
    if (!created) fail("VAULT_MISSING", `${label} could not be created`);
    if (created.isSymbolicLink()) fail("VAULT_SYMLINK", `${label} must not be a symbolic link`);
    if (!created.isDirectory()) fail("VAULT_CORRUPT", `${label} is not a directory`);
    fsyncDirectory(parent);
  }
}

/** @param {ReleaseVaultOptions} [options] */
export function createReleaseVault({ root } = {}) {
  if (typeof root !== "string" || !root.trim()) fail("VAULT_INPUT", "createReleaseVault requires a filesystem root");
  const vaultRoot = resolve(root);
  const blobsRoot = join(vaultRoot, "blobs"), shaRoot = join(blobsRoot, "sha256");
  const manifestsRoot = join(vaultRoot, "manifests"), stagingRoot = join(vaultRoot, "staging");

  const ensureRoot = ({ create = false } = {}) => {
    ensureRootPathWithoutSymlinks(vaultRoot, { create });
    assertDirectory(vaultRoot, "release vault root");
  };

  const ensureLayout = () => {
    ensureRoot({ create: true });
    makeDirectory(blobsRoot, vaultRoot, "release vault blobs directory");
    makeDirectory(shaRoot, blobsRoot, "release vault SHA-256 directory");
    makeDirectory(manifestsRoot, vaultRoot, "release vault manifests directory");
    makeDirectory(stagingRoot, vaultRoot, "release vault staging directory");
  };

  // Provision the complete known layout even before the first publication so
  // an external-volume snapshot can distinguish an empty healthy vault from
  // an incomplete/corrupt mount. The same symlink-safe checks as publication
  // apply, and repeated startup calls are idempotent.
  const initialize = () => { ensureLayout(); };

  const ensureDescendantDirectory = (base, segments, label) => {
    let current = base;
    assertDirectory(current, label);
    for (const segment of segments) {
      const next = join(current, segment); assertContained(vaultRoot, next);
      makeDirectory(next, current, label); current = next;
    }
    return current;
  };

  const manifestKey = (slug, tag) => `manifests/${validSlug(slug)}/${validTag(tag)}.json`;
  const manifestPath = (slug, tag) => join(vaultRoot, manifestKey(slug, tag));
  const blobKey = digest => `blobs/sha256/${digest.slice(0, 2)}/${digest}`;
  const blobPath = digest => join(vaultRoot, blobKey(digest));

  const verifyFileReceipt = (path, receipt, label, retainBytes=true) => {
    const bytes=retainBytes?readRegular(path,label):null;
    const actual=bytes?{bytes:bytes.length,sha256:sha256(bytes)}:digestRegular(path,label);
    if (actual.bytes !== receipt.bytes || actual.sha256 !== receipt.sha256)
      fail("VAULT_CORRUPT", `${label} does not match its immutable receipt`, { expected: receipt, actual });
    return bytes;
  };

  const stageArtifact = (sourceDir, receipt) => {
    const base = resolve(sourceDir);
    const baseStat = lstatOrNull(base);
    if (!baseStat || baseStat.isSymbolicLink() || !baseStat.isDirectory())
      fail(baseStat?.isSymbolicLink() ? "VAULT_SYMLINK" : "VAULT_INPUT", "release sourceDir must be a real directory");
    let cursor = base;
    const parts = receipt.name.split("/");
    for (const segment of parts.slice(0, -1)) {
      cursor = join(cursor, segment);
      const stat = lstatOrNull(cursor);
      if (!stat) fail("VAULT_RECEIPT_MISMATCH", `source artifact '${receipt.name}' is missing`);
      if (stat.isSymbolicLink()) fail("VAULT_SYMLINK", `source artifact '${receipt.name}' traverses a symbolic link`);
      if (!stat.isDirectory()) fail("VAULT_RECEIPT_MISMATCH", `source artifact '${receipt.name}' has a non-directory parent`);
    }
    const source = join(base, receipt.name), sourceStat = lstatOrNull(source);
    if (!sourceStat) fail("VAULT_RECEIPT_MISMATCH", `source artifact '${receipt.name}' is missing`);
    if (sourceStat.isSymbolicLink()) fail("VAULT_SYMLINK", `source artifact '${receipt.name}' must not be a symbolic link`);
    if (!sourceStat.isFile()) fail("VAULT_RECEIPT_MISMATCH", `source artifact '${receipt.name}' is not a regular file`);

    const stage = join(stagingRoot, `artifact-${process.pid}-${randomBytes(16).toString("hex")}.tmp`);
    let input, output;
    try {
      input = openSync(source, FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
      output = openSync(stage, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW || 0), 0o600);
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES); let total = 0;
      while (true) {
        const count = readSync(input, buffer, 0, buffer.length, null); if (!count) break;
        hash.update(buffer.subarray(0, count)); total += count;
        let offset = 0;
        while (offset < count) offset += writeSync(output, buffer, offset, count - offset);
      }
      fsyncSync(output);
      const digest = hash.digest("hex");
      if (total !== receipt.bytes || digest !== receipt.sha256)
        fail("VAULT_RECEIPT_MISMATCH", `source artifact '${receipt.name}' does not match its release receipt`,
          { expected: { bytes: receipt.bytes, sha256: receipt.sha256 }, actual: { bytes: total, sha256: digest } });
      return stage;
    } catch (error) {
      if (lstatOrNull(stage)) unlinkSync(stage);
      throw error;
    } finally {
      if (input != null) closeSync(input);
      if (output != null) closeSync(output);
    }
  };

  const stageBytes = bytes => {
    const stage = join(stagingRoot, `manifest-${process.pid}-${randomBytes(16).toString("hex")}.tmp`);
    let fd;
    try {
      fd = openSync(stage, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW || 0), 0o600);
      writeFileSync(fd, bytes); fsyncSync(fd); return stage;
    } catch (error) {
      if (lstatOrNull(stage)) unlinkSync(stage);
      throw error;
    } finally { if (fd != null) closeSync(fd); }
  };

  const commitStage = (stage, target, receipt, label) => {
    let created = false;
    try {
      linkSync(stage, target); created = true; fsyncDirectory(dirname(target));
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      verifyFileReceipt(target, receipt, label, false);
      verifyFileReceipt(stage, receipt, "release vault staging object", false);
      if (!sameRegularFiles(target,stage)) fail("VAULT_CONFLICT", `${label} already exists with different bytes`);
    } finally {
      if (lstatOrNull(stage)) { unlinkSync(stage); fsyncDirectory(stagingRoot); }
    }
    return created;
  };

  const loadManifest = ({ slug, tag, sourceSha = undefined }, { verifyBlobs = false } = {}) => {
    slug = validSlug(slug); tag = validTag(tag);
    if (sourceSha != null) sourceSha = validSourceSha(sourceSha);
    ensureRoot();
    assertDirectory(manifestsRoot, "release vault manifests directory");
    const slugDir = join(manifestsRoot, slug);
    assertDirectory(slugDir, `release vault manifest directory '${slug}'`);
    const path = manifestPath(slug, tag), raw = readRegular(path, `release vault manifest '${slug}/${tag}'`);
    let parsed;
    try { parsed = JSON.parse(raw.toString("utf8")); }
    catch { fail("VAULT_CORRUPT", `release vault manifest '${slug}/${tag}' is not valid JSON`); }
    const manifest = validateManifest(parsed), expected = canonicalBytes(manifest);
    if (!raw.equals(expected)) fail("VAULT_CORRUPT", `release vault manifest '${slug}/${tag}' is not canonical`);
    if (manifest.release.slug !== slug || manifest.release.tag !== tag
        || (sourceSha != null && manifest.release.source_sha !== sourceSha))
      fail("VAULT_CONFLICT", `release vault manifest '${slug}/${tag}' does not match the requested release binding`);
    const digest = sha256(raw);
    if (verifyBlobs) {
      assertDirectory(blobsRoot, "release vault blobs directory");
      assertDirectory(shaRoot, "release vault SHA-256 directory");
      for (const receipt of manifest.artifacts) {
        const prefix = join(shaRoot, receipt.sha256.slice(0, 2));
        assertDirectory(prefix, `release vault blob prefix '${receipt.sha256.slice(0, 2)}'`);
        verifyFileReceipt(blobPath(receipt.sha256), receipt, `release vault blob '${receipt.sha256}'`, false);
      }
    }
    return { manifest, manifestSha256: digest, manifestKey: manifestKey(slug, tag) };
  };

  const sealManifest = (manifest, sourceDir, operation) => {
    const manifestBytes = canonicalBytes(manifest), manifestDigest = sha256(manifestBytes);
    if (typeof sourceDir !== "string" || !sourceDir.trim()) fail("VAULT_INPUT", `${operation} requires sourceDir`);
    const { slug, tag, source_sha: sourceSha } = manifest.release;
    ensureLayout();
    const staged = [];
    try {
      for (const receipt of manifest.artifacts) staged.push({ receipt, path: stageArtifact(sourceDir, receipt) });
      const targetManifest = manifestPath(slug, tag);
      if (existsSync(targetManifest)) {
        const current = loadManifest({ slug, tag, sourceSha }, { verifyBlobs: true });
        if (current.manifestSha256 !== manifestDigest || !canonicalBytes(current.manifest).equals(manifestBytes))
          fail("VAULT_CONFLICT", `release '${slug}/${tag}' is already bound to different immutable bytes`);
        return { created: false, idempotent: true, manifestSha256: manifestDigest,
          manifestKey: current.manifestKey, manifest: current.manifest };
      }

      for (const entry of staged) {
        const prefix = ensureDescendantDirectory(shaRoot, [entry.receipt.sha256.slice(0, 2)], "release vault blob prefix");
        commitStage(entry.path, join(prefix, entry.receipt.sha256), entry.receipt,
          `release vault blob '${entry.receipt.sha256}'`);
        entry.path = null;
      }
      const slugDir = ensureDescendantDirectory(manifestsRoot, [slug], "release vault manifest directory");
      const manifestStage = stageBytes(manifestBytes);
      const created = commitStage(manifestStage, join(slugDir, `${tag}.json`),
        { bytes: manifestBytes.length, sha256: manifestDigest }, `release vault manifest '${slug}/${tag}'`);
      const current = loadManifest({ slug, tag, sourceSha }, { verifyBlobs: true });
      if (current.manifestSha256 !== manifestDigest)
        fail("VAULT_CONFLICT", `release '${slug}/${tag}' was concurrently bound to different immutable bytes`);
      return { created, idempotent: !created, manifestSha256: manifestDigest,
        manifestKey: current.manifestKey, manifest: current.manifest };
    } finally {
      for (const entry of staged) if (entry.path && lstatOrNull(entry.path)) unlinkSync(entry.path);
    }
  };

  /** @param {PublishReleaseInput} [input] */
  const publishRelease = ({ slug, tag, sourceSha, sourceDir, artifacts } = {}) => {
    if (!Array.isArray(artifacts)) fail("VAULT_INPUT", "publishRelease requires artifact receipts");
    return sealManifest(manifestFor({ slug, tag, sourceSha, artifacts }), sourceDir, "publishRelease");
  };

  /** @param {PublishNativeReleaseInput} [input] */
  const publishNativeRelease = ({ slug, tag, sourceSha, sourceDir, artifacts, publication } = {}) => {
    if (!Array.isArray(artifacts)) fail("VAULT_INPUT", "publishNativeRelease requires artifact receipts");
    return sealManifest(nativeManifestFor({ slug, tag, sourceSha, artifacts, publication }),
      sourceDir, "publishNativeRelease");
  };

  /** @param {ReadReleaseInput} [input] */
  const readRelease = ({ slug, tag, sourceSha = undefined } = {}) =>
    loadManifest({ slug, tag, sourceSha }, { verifyBlobs: true });

  // Metadata consumers verify the canonical manifest and its database digest
  // without synchronously rereading every large artifact blob. Individual
  // downloads and the vault audit still verify the referenced blob bytes.
  /** @param {ReadReleaseInput} [input] */
  const readManifest = ({ slug, tag, sourceSha = undefined } = {}) =>
    loadManifest({ slug, tag, sourceSha });

  // Metadata and path only: callers MUST verify the complete receipt before
  // serving bytes. The async download path uses a private verified snapshot.
  /** @param {ReadArtifactInput} [input] */
  const artifactSource = ({ slug, tag, sourceSha = undefined, name } = {}) => {
    name = validArtifactName(name);
    const release = loadManifest({ slug, tag, sourceSha });
    const receipt = release.manifest.artifacts.find(item => item.name === name);
    if (!receipt) fail("VAULT_MISSING", `release '${slug}/${tag}' has no artifact '${name}'`);
    assertDirectory(blobsRoot, "release vault blobs directory");
    assertDirectory(shaRoot, "release vault SHA-256 directory");
    assertDirectory(join(shaRoot, receipt.sha256.slice(0, 2)), `release vault blob prefix '${receipt.sha256.slice(0, 2)}'`);
    return { ...release, receipt, path:blobPath(receipt.sha256) };
  };

  /** @param {ReadArtifactInput} [input] */
  const readArtifact = (input = {}) => {
    const {path,...source}=artifactSource(input);
    const bytes=verifyFileReceipt(path,source.receipt,`release vault blob '${source.receipt.sha256}'`);
    return {...source,bytes};
  };

  const treeItems = (base, prefix = "") => {
    const out = [];
    const walk = (dir, rel) => {
      let names;
      try { names = readdirSync(dir).sort(); }
      catch (error) { out.push({ path: rel || prefix, type: "unreadable", error: error.message }); return; }
      for (const name of names) {
        const path = join(dir, name), itemRel = rel ? `${rel}/${name}` : name;
        let stat;
        try { stat = lstatSync(path); }
        catch (error) { out.push({ path: itemRel, type: "unreadable", error: error.message }); continue; }
        const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
        out.push({ path: itemRel, type, bytes: stat.isFile() ? stat.size : undefined });
        if (type === "directory") walk(path, itemRel);
      }
    };
    const stat = lstatOrNull(base);
    if (!stat) return out;
    if (stat.isSymbolicLink()) return [{ path: prefix || basename(base), type: "symlink" }];
    if (!stat.isDirectory()) return [{ path: prefix || basename(base), type: "other" }];
    walk(base, ""); return out;
  };

  const audit = () => {
    const report = { format: "forge-release-vault-audit", version: 1, ok: true,
      counts: { manifests: 0, blobs: 0, staging: 0, orphans: 0, corruption: 0 },
      manifests: [], staging: [], orphans: [], corruption: [] };
    const corrupt = (path, code, error) => report.corruption.push({ path, code, error: String(error) });
    try { ensureRootPathWithoutSymlinks(vaultRoot); }
    catch (error) {
      if (error?.code === "VAULT_MISSING") return report;
      corrupt(".", error?.code === "VAULT_SYMLINK" ? "symlink" : (error?.code || "invalid"), error.message);
      report.ok = false; report.counts.corruption = report.corruption.length; return report;
    }
    const rootStat = lstatOrNull(vaultRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      corrupt(".", rootStat.isSymbolicLink() ? "symlink" : "not-directory", "vault root is not a real directory");
      report.ok = false; report.counts.corruption = report.corruption.length; return report;
    }
    for (const [path, label] of [
      [blobsRoot, "blobs"], [shaRoot, "blobs/sha256"],
      [manifestsRoot, "manifests"], [stagingRoot, "staging"],
    ]) {
      const stat = lstatOrNull(path);
      if (!stat) corrupt(label, "missing", "required vault directory is missing");
      else if (stat.isSymbolicLink()) corrupt(label, "symlink", "required vault directory must not be a symbolic link");
      else if (!stat.isDirectory()) corrupt(label, "not-directory", "required vault path is not a directory");
    }
    for (const item of treeItems(stagingRoot, "staging"))
      if (item.type !== "directory") report.staging.push({ path: `staging/${item.path}`, type: item.type, bytes: item.bytes });

    const referenced = new Set(), manifestItems = treeItems(manifestsRoot, "manifests");
    for (const item of manifestItems) {
      if (item.type === "directory") continue;
      const match = item.type === "file" && item.path.match(/^([^/]+)\/(v[0-9][0-9A-Za-z._-]{0,31})\.json$/);
      if (!match || !SLUG_RE.test(match[1])) {
        corrupt(`manifests/${item.path}`, item.type === "symlink" ? "symlink" : "unexpected", "unexpected manifest vault entry");
        continue;
      }
      try {
        const loaded = loadManifest({ slug: match[1], tag: match[2] });
        report.manifests.push({ slug: match[1], tag: match[2], source_sha: loaded.manifest.release.source_sha,
          manifest_sha256: loaded.manifestSha256 });
        for (const artifact of loaded.manifest.artifacts) referenced.add(artifact.sha256);
      } catch (error) { corrupt(`manifests/${item.path}`, error.code || "invalid", error.message); }
    }

    const validBlobs = new Map(), blobItems = treeItems(shaRoot, "blobs/sha256");
    for (const item of blobItems) {
      if (item.type === "directory") continue;
      const match = item.type === "file" && item.path.match(/^([0-9a-f]{2})\/([0-9a-f]{64})$/);
      if (!match || match[1] !== match[2].slice(0, 2)) {
        corrupt(`blobs/sha256/${item.path}`, item.type === "symlink" ? "symlink" : "unexpected", "unexpected blob vault entry");
        continue;
      }
      try {
        const path=join(shaRoot,item.path),actual=digestRegular(path,`release vault blob '${match[2]}'`),digest=actual.sha256;
        if (digest !== match[2]) corrupt(`blobs/sha256/${item.path}`, "digest-mismatch", `blob hashes to ${digest}`);
        else validBlobs.set(match[2], { path: `blobs/sha256/${item.path}`, bytes: actual.bytes });
      } catch (error) { corrupt(`blobs/sha256/${item.path}`, error.code || "invalid", error.message); }
    }
    for (const manifest of report.manifests) {
      try {
        const loaded = loadManifest({ slug: manifest.slug, tag: manifest.tag, sourceSha: manifest.source_sha });
        for (const artifact of loaded.manifest.artifacts) {
          const blob = validBlobs.get(artifact.sha256);
          if (!blob) corrupt(`manifests/${manifest.slug}/${manifest.tag}.json`, "missing-or-corrupt-blob",
            `artifact '${artifact.name}' has no valid blob '${artifact.sha256}'`);
          else if (blob.bytes !== artifact.bytes) corrupt(blob.path, "receipt-mismatch",
            `artifact '${artifact.name}' expects ${artifact.bytes} bytes, found ${blob.bytes}`);
        }
      } catch (error) { corrupt(`manifests/${manifest.slug}/${manifest.tag}.json`, error.code || "invalid", error.message); }
    }
    for (const [digest, blob] of validBlobs) if (!referenced.has(digest))
      report.orphans.push({ ...blob, sha256: digest });

    const knownRoot = new Set(["blobs", "manifests", "staging"]);
    for (const item of treeItems(vaultRoot).filter(item => !item.path.includes("/")))
      if (!knownRoot.has(item.path)) corrupt(item.path, item.type === "symlink" ? "symlink" : "unexpected", "unexpected vault root entry");
    report.manifests.sort((a, b) => compareText(`${a.slug}/${a.tag}`, `${b.slug}/${b.tag}`));
    report.staging.sort((a, b) => compareText(a.path, b.path));
    report.orphans.sort((a, b) => compareText(a.sha256, b.sha256));
    report.corruption.sort((a, b) => compareText(a.path, b.path) || compareText(a.code, b.code));
    report.counts = { manifests: report.manifests.length, blobs: validBlobs.size,
      staging: report.staging.length, orphans: report.orphans.length, corruption: report.corruption.length };
    report.ok = report.corruption.length === 0 && report.staging.length === 0;
    return report;
  };

  return Object.freeze({ initialize, publishRelease, publishNativeRelease, readManifest, readRelease, artifactSource, readArtifact, audit });
}

export const RELEASE_VAULT_FORMAT = FORMAT;
export const RELEASE_VAULT_VERSION = VERSION;
export const RELEASE_VAULT_NATIVE_VERSION = NATIVE_VERSION;
export const RELEASE_VAULT_SUPPORTED_VERSIONS = SUPPORTED_VERSIONS;
export const isReleaseVaultVersionSupported = version => MANIFEST_READERS.has(version);
