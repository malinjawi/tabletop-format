#!/usr/bin/env node
/**
 * Small, dependency-free S3 snapshotter for Forge's dedicated LFS bucket.
 * Credentials are accepted only as file paths so they never enter argv or
 * logs. Objects are stored by a hash of their key and described by a checked
 * manifest, preventing an object key from escaping the backup directory.
 */
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const argv = process.argv.slice(2), operation = argv.shift();
const valueAfter = name => {
  const at = argv.indexOf(name);
  return at < 0 ? null : argv[at + 1];
};
const has = name => argv.includes(name);
const required = name => {
  const value = valueAfter(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const decodeXml = value => value
  .replace(/&#x([0-9a-f]+);/gi, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
  .replace(/&#([0-9]+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
const xmlTag = (xml, name) => {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decodeXml(match[1]) : "";
};

function absoluteFile(path, label) {
  const result = resolve(path);
  if (!isAbsolute(result) || !existsSync(result) || !statSync(result).isFile())
    throw new Error(`${label} must name an existing file`);
  return result;
}

function snapshotManifest(input) {
  const root = resolve(input), path = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.format !== "forge-s3-snapshot" || manifest.version !== 1 || !Array.isArray(manifest.objects))
    throw new Error("unsupported or malformed S3 snapshot manifest");
  return { root, path, manifest };
}

function verifySnapshot(input) {
  const loaded = snapshotManifest(input), seenKeys = new Set(), seenFiles = new Set();
  let total = 0;
  for (const object of loaded.manifest.objects) {
    if (!object || typeof object.key !== "string" || !/^[a-f0-9]{64}$/.test(object.file || "")
      || !/^[a-f0-9]{64}$/.test(object.sha256 || "") || !Number.isSafeInteger(object.size) || object.size < 0)
      throw new Error("malformed object record in S3 snapshot");
    if (object.file !== sha256(Buffer.from(object.key)) || !object.key.startsWith(loaded.manifest.prefix || ""))
      throw new Error("S3 snapshot object is not bound to its declared key/prefix");
    if (seenKeys.has(object.key) || seenFiles.has(object.file)) throw new Error("duplicate object record in S3 snapshot");
    seenKeys.add(object.key); seenFiles.add(object.file);
    const path = join(loaded.root, "objects", object.file), bytes = readFileSync(path);
    if (bytes.length !== object.size || sha256(bytes) !== object.sha256)
      throw new Error(`snapshot object failed integrity check: ${object.key}`);
    total += bytes.length;
  }
  return { ...loaded, total };
}

function clientOptions() {
  const endpoint = new URL(required("--endpoint"));
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password)
    throw new Error("--endpoint must be a credential-free HTTP(S) origin with no path");
  const bucket = required("--bucket");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("invalid S3 bucket name");
  const accessPath = absoluteFile(required("--access-key-file"), "--access-key-file");
  const secretPath = absoluteFile(required("--secret-key-file"), "--secret-key-file");
  const access = readFileSync(accessPath, "utf8").trim(), secret = readFileSync(secretPath, "utf8").trim();
  if (access.length < 3 || secret.length < 8) throw new Error("S3 credential files are empty or too short");
  return { endpoint, bucket, region: valueAfter("--region") || "auto", access, secret };
}

function makeClient(options) {
  const { endpoint, bucket, region, access, secret } = options;
  const canonicalUri = key => `/${encode(bucket)}${key == null ? "" : `/${key.split("/").map(encode).join("/")}`}`;
  async function request(method, { key = null, query = [], body = Buffer.alloc(0) } = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const canonicalQuery = query.map(([name, value]) => [encode(name), encode(value)])
      .sort(([aName, aValue], [bName, bValue]) => aName.localeCompare(bName) || aValue.localeCompare(bValue))
      .map(([name, value]) => `${name}=${value}`).join("&");
    const now = new Date(), amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = amzDate.slice(0, 8);
    const payloadHash = sha256(payload), signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders = `host:${endpoint.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const uri = canonicalUri(key);
    const canonical = [method, uri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${day}/${region}/s3/aws4_request`;
    const signingKey = hmac(hmac(hmac(hmac(Buffer.from(`AWS4${secret}`), day), region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey)
      .update(["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n")).digest("hex");
    const url = `${endpoint.origin}${uri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    const response = await fetch(url, {
      method, body: ["GET", "HEAD"].includes(method) ? undefined : payload,
      redirect: "manual", signal: AbortSignal.timeout(120_000), headers: {
        "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash,
        authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 1000);
      throw new Error(`S3 ${method} ${key ?? bucket} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    return response;
  }
  async function list(prefix = "") {
    const objects = [];
    let continuation = "";
    do {
      const query = [["list-type", "2"], ["max-keys", "1000"]];
      if (prefix) query.push(["prefix", prefix]);
      if (continuation) query.push(["continuation-token", continuation]);
      const xml = await (await request("GET", { query })).text();
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
        const key = xmlTag(block, "Key"), size = Number(xmlTag(block, "Size"));
        if (!key || !Number.isSafeInteger(size) || size < 0) throw new Error("malformed S3 ListObjectsV2 response");
        objects.push({ key, size, etag: xmlTag(block, "ETag").replace(/^"|"$/g, "") });
        if (objects.length > 100_000) throw new Error("S3 snapshot exceeds the 100,000-object safety limit");
      }
      const truncated = xmlTag(xml, "IsTruncated") === "true";
      continuation = truncated ? xmlTag(xml, "NextContinuationToken") : "";
      if (truncated && !continuation) throw new Error("S3 listing was truncated without a continuation token");
    } while (continuation);
    return objects;
  }
  return { request, list };
}

async function createBucket(client) {
  try {
    await client.request("GET", { query: [["list-type", "2"], ["max-keys", "1"]] });
    return false;
  } catch (error) {
    if (!/HTTP 404/.test(error.message)) throw error;
  }
  await client.request("PUT");
  return true;
}

async function backup() {
  const options = clientOptions(), client = makeClient(options), output = resolve(required("--output"));
  if (existsSync(output)) throw new Error(`backup output already exists: ${output}`);
  mkdirSync(output, { mode: 0o700 });
  mkdirSync(join(output, "objects"), { mode: 0o700 });
  const prefix = valueAfter("--prefix") || "", listed = await client.list(prefix), objects = [];
  for (const item of listed) {
    const response = await client.request("GET", { key: item.key });
    const responseEtag = (response.headers.get("etag") || "").replace(/^"|"$/g, "");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== item.size || (item.etag && responseEtag && responseEtag !== item.etag))
      throw new Error(`S3 object changed during backup: ${item.key}`);
    const file = sha256(Buffer.from(item.key)), path = join(output, "objects", file);
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    objects.push({ ...item, file, sha256: sha256(bytes) });
  }
  const manifest = { format: "forge-s3-snapshot", version: 1, created_at: new Date().toISOString(),
    bucket: options.bucket, prefix, objects };
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(output, 0o700);
  const verified = verifySnapshot(output);
  console.log(`S3 SNAPSHOT GREEN — ${objects.length} object(s), ${verified.total} bytes backed up and verified.`);
}

async function restore() {
  const options = clientOptions(), client = makeClient(options), input = resolve(required("--input"));
  const loaded = verifySnapshot(input);
  if (has("--create-bucket")) await createBucket(client);
  const existing = await client.list(loaded.manifest.prefix || "");
  if (existing.length) throw new Error("restore target is not empty; use a fresh isolated bucket");
  for (const object of loaded.manifest.objects) {
    const bytes = readFileSync(join(loaded.root, "objects", object.file));
    await client.request("PUT", { key: object.key, body: bytes });
  }
  const restored = await client.list(loaded.manifest.prefix || "");
  if (restored.length !== loaded.manifest.objects.length) throw new Error("restored S3 object count differs from snapshot");
  for (const object of loaded.manifest.objects) {
    const bytes = Buffer.from(await (await client.request("GET", { key: object.key })).arrayBuffer());
    if (bytes.length !== object.size || sha256(bytes) !== object.sha256)
      throw new Error(`restored S3 object failed integrity check: ${object.key}`);
  }
  console.log(`S3 RESTORE GREEN — ${restored.length} object(s), ${loaded.total} bytes restored and re-read exactly.`);
}

try {
  if (operation === "backup") await backup();
  else if (operation === "restore") await restore();
  else if (operation === "create") {
    const client = makeClient(clientOptions()), created = await createBucket(client);
    console.log(`S3 BUCKET GREEN — ${created ? "created" : "already available"}.`);
  }
  else if (operation === "verify") {
    const verified = verifySnapshot(required("--input"));
    console.log(`S3 SNAPSHOT VERIFIED — ${verified.manifest.objects.length} object(s), ${verified.total} bytes.`);
  } else throw new Error("usage: s3-snapshot.mjs backup|restore|verify|create [options]");
} catch (error) {
  console.error(`S3 SNAPSHOT FAILED — ${error.message}`);
  process.exit(1);
}
