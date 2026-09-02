#!/usr/bin/env node
/**
 * Fail-closed production host preflight. It never prints secret values.
 *
 * Template/CI lint:
 *   node deploy/preflight.mjs --env deploy/.env.example --lint
 * Real host, before first boot:
 *   node deploy/preflight.mjs --env deploy/.env --first-boot
 * Real host, before invitations (also checks DNS, TLS, and read-only R2 access):
 *   node deploy/preflight.mjs --env deploy/.env --online --evidence /safe/path/preflight.json
 */
import { createHash, createHmac } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { lookup } from "node:dns/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const valueAfter = flag => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : null; };
const envPath = resolve(valueAfter("--env") || "deploy/.env");
const lint = args.includes("--lint"), online = args.includes("--online"), firstBoot = args.includes("--first-boot");
const skipImageInspect = args.includes("--test-no-image-inspect");
const evidencePath = valueAfter("--evidence");
if (lint && (online || evidencePath)) throw new Error("--lint cannot perform online checks or write launch evidence");
if (skipImageInspect && !envPath.startsWith(resolve(tmpdir()) + sep))
  throw new Error("--test-no-image-inspect is restricted to a temporary test environment");

function parseEnv(path) {
  if (!existsSync(path)) throw new Error(`deployment environment not found: ${path}`);
  const out = {};
  for (const [index, raw] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`${path}:${index + 1}: expected NAME=value`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

const fileEnv = parseEnv(envPath), env = lint ? { ...fileEnv } : { ...fileEnv, ...process.env };
const checks = [];
function check(condition, name, detail) {
  checks.push({ ok: !!condition, name, detail: String(detail || "") });
}
function value(name) { return String(env[name] || "").trim(); }
const placeholder = input => /(?:replace|example|your organization|<|>)/i.test(input);
const validEmail = input => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) && !input.endsWith(".invalid");
const validOrigin = input => {
  try { const url = new URL(input); return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash; }
  catch { return false; }
};

const requiredKeys = ["FORGE_PUBLIC_ORIGIN", "FORGEJO_PUBLIC_ORIGIN", "FORGE_BIND_IP", "FORGEJO_BIND_PORT",
  "FORGE_SECRET_DIR",
  "FORGE_REGISTRATION_MODE", "FORGE_INVITE_MODE", "FORGE_OPERATOR_NAME", "FORGE_CONTACT_EMAIL", "ACME_EMAIL",
  "FORGE_GATEWAY_IMAGE", "FORGEJO_IMAGE", "FORGEJO_VERSION", "POSTGRES_IMAGE", "POSTGRES_MAJOR", "R2_ACCOUNT_ID", "R2_LFS_BUCKET",
  "FORGE_BACKUP_DESTINATION"];
for (const name of requiredKeys) check(!!value(name), `environment ${name}`, value(name) ? "declared" : "missing");

if (lint) {
  check(requiredKeys.every(name => Object.hasOwn(fileEnv, name)), "template completeness", `${requiredKeys.length} required settings declared`);
  for (const name of ["FORGE_GATEWAY_IMAGE", "FORGEJO_IMAGE", "POSTGRES_IMAGE"])
    check(value(name).includes("@sha256:"), `${name} digest form`, "template uses an immutable digest slot");
} else {
  check(validOrigin(value("FORGE_PUBLIC_ORIGIN")), "Forge HTTPS origin", "absolute HTTPS origin with no path");
  check(validOrigin(value("FORGEJO_PUBLIC_ORIGIN")), "Forgejo HTTPS origin", "absolute HTTPS origin with no path");
  check(value("FORGE_PUBLIC_ORIGIN") !== value("FORGEJO_PUBLIC_ORIGIN"), "separate public origins", "Forge and Git origins differ");
  check(["127.0.0.1", "::1"].includes(value("FORGE_BIND_IP")), "loopback-only service bind", value("FORGE_BIND_IP") || "missing");
  check(value("FORGE_REGISTRATION_MODE") === "invite", "invite-only registration", value("FORGE_REGISTRATION_MODE") || "missing");
  check(value("FORGE_INVITE_MODE") === "database", "single-use invitation backend",
    value("FORGE_INVITE_MODE") || "missing");
  check(!value("FORGE_INVITE_CODE"), "no reusable invitation secret",
    value("FORGE_INVITE_CODE") ? "remove FORGE_INVITE_CODE" : "none declared");
  check(value("FORGE_OPERATOR_NAME").length >= 2 && !placeholder(value("FORGE_OPERATOR_NAME")),
    "accountable operator", value("FORGE_OPERATOR_NAME") ? "named" : "missing");
  check(validEmail(value("FORGE_CONTACT_EMAIL")) && !placeholder(value("FORGE_CONTACT_EMAIL")),
    "public support contact", validEmail(value("FORGE_CONTACT_EMAIL")) ? "valid address" : "missing or invalid");
  check(validEmail(value("ACME_EMAIL")) && !placeholder(value("ACME_EMAIL")),
    "TLS expiry contact", validEmail(value("ACME_EMAIL")) ? "valid address" : "missing or invalid");
  for (const name of ["FORGE_GATEWAY_IMAGE", "FORGEJO_IMAGE", "POSTGRES_IMAGE"])
    check(/^[^\s]+@sha256:[a-f0-9]{64}$/.test(value(name)), `${name} immutable digest`, "full sha256 image reference");
  check(/^15\./.test(value("FORGEJO_VERSION")), "qualified Forgejo major", `${value("FORGEJO_VERSION") || "missing"}; production recovery is qualified on 15.x`);
  check(value("POSTGRES_MAJOR") === "16", "qualified PostgreSQL major", `${value("POSTGRES_MAJOR") || "missing"}; production recovery is qualified on 16.x`);
  check(/^[a-f0-9]{32}$/i.test(value("R2_ACCOUNT_ID")), "R2 account identifier", "32 hex characters");
  check(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value("R2_LFS_BUCKET")), "R2 bucket name", value("R2_LFS_BUCKET") || "missing");
  const backup = value("FORGE_BACKUP_DESTINATION");
  const unsafeBackup = !isAbsolute(backup) || ["/", "/tmp", "/var", "/Users", "/home"].includes(backup)
    || resolve(backup).startsWith(resolve(ROOT, "deploy") + "/");
  check(!unsafeBackup && !placeholder(backup), "off-host backup destination", unsafeBackup ? "missing, broad, or inside deploy/" : "declared absolute target");
}

const secretNames = ["forge-token", "pg-super-password", "forge-db-password", "platform-db-password",
  "forgejo-secret-key", "forgejo-internal-token", "forgejo-oauth2-jwt-secret", "lfs-jwt-secret",
  "r2-access-key", "r2-secret-key"];
const secretDirSetting = value("FORGE_SECRET_DIR");
const secretDir = isAbsolute(secretDirSetting) ? resolve(secretDirSetting) : resolve(ROOT, "deploy", secretDirSetting);
if (!lint) {
  const fingerprints = new Map();
  for (const name of secretNames) {
    const path = resolve(secretDir, name), present = existsSync(path) && lstatSync(path).isFile();
    check(present, `secret ${name}`, present ? "file present" : "missing");
    if (!present) continue;
    const mode = lstatSync(path).mode & 0o777, content = readFileSync(path);
    check((mode & 0o077) === 0, `secret ${name} permissions`, `mode ${mode.toString(8).padStart(3, "0")}`);
    const allowEmpty = firstBoot && name === "forge-token";
    check(allowEmpty || content.toString("utf8").trim().length >= 16, `secret ${name} content`, allowEmpty ? "empty allowed for first boot" : "non-empty");
    if (content.length) {
      const fingerprint = createHash("sha256").update(content).digest("hex");
      fingerprints.set(fingerprint, [...(fingerprints.get(fingerprint) || []), name]);
    }
  }
  const duplicates = [...fingerprints.values()].filter(names => names.length > 1);
  check(!duplicates.length, "unique secret material", duplicates.length ? `duplicate files: ${duplicates.map(v => v.join("/")).join(", ")}` : "no reused values");
}

const compose = spawnSync("docker", ["compose", "--env-file", envPath, "-f", resolve(ROOT, "deploy/docker-compose.prod.yml"), "config", "--quiet"],
  { cwd: ROOT, encoding: "utf8" });
check(compose.status === 0, "Compose resolves", compose.status === 0 ? "configuration valid" : (compose.stderr || "docker compose failed").trim().split("\n").at(-1));
if (!lint && !skipImageInspect) {
  for (const name of ["FORGE_GATEWAY_IMAGE", "FORGEJO_IMAGE", "POSTGRES_IMAGE"]) {
    const inspected = spawnSync("docker", ["image", "inspect", value(name)], { cwd: ROOT, encoding: "utf8" });
    check(inspected.status === 0, `${name} available`, inspected.status === 0 ? "exact digest present on host" : "pull/build the exact digest before preflight");
  }
  const forgejoVersion = spawnSync("docker", ["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.version"}}', value("FORGEJO_IMAGE")],
    { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  check(forgejoVersion === value("FORGEJO_VERSION"), "Forgejo digest/version match", `${forgejoVersion || "unknown"} == declared ${value("FORGEJO_VERSION")}`);
  const postgresEnv = spawnSync("docker", ["image", "inspect", "--format", "{{json .Config.Env}}", value("POSTGRES_IMAGE")],
    { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  let postgresMajor = "";
  try { postgresMajor = (JSON.parse(postgresEnv).find(item => item.startsWith("PG_MAJOR=")) || "").split("=")[1] || ""; } catch {}
  check(postgresMajor === value("POSTGRES_MAJOR"), "PostgreSQL digest/major match", `${postgresMajor || "unknown"} == declared ${value("POSTGRES_MAJOR")}`);
}
const caddy = readFileSync(resolve(ROOT, "deploy/Caddyfile.example"), "utf8");
check(caddy.includes("{$FORGE_PUBLIC_ORIGIN}") && caddy.includes("127.0.0.1:8420")
  && caddy.includes("{$FORGEJO_PUBLIC_ORIGIN}") && caddy.includes("127.0.0.1:3000"),
"TLS proxy contract", "both loopback services declared");

const hex = data => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
async function checkHttp(url, name, predicate) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    check(await predicate(response), name, `HTTP ${response.status}`);
  } catch (error) { check(false, name, error.message); }
}
async function checkR2() {
  const account = value("R2_ACCOUNT_ID"), bucket = value("R2_LFS_BUCKET");
  const access = readFileSync(resolve(secretDir, "r2-access-key"), "utf8").trim();
  const secret = readFileSync(resolve(secretDir, "r2-secret-key"), "utf8").trim();
  const now = new Date(), amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = amzDate.slice(0, 8);
  const host = `${account}.r2.cloudflarestorage.com`, query = "list-type=2&max-keys=1";
  const payload = hex(Buffer.alloc(0)), headers = `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amzDate}\n`;
  const canonical = ["GET", `/${bucket}`, query, headers, "host;x-amz-content-sha256;x-amz-date", payload].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(Buffer.from(`AWS4${secret}`), day), "auto"), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  try {
    const response = await fetch(`https://${host}/${bucket}?${query}`, { signal: AbortSignal.timeout(10_000), headers: {
      "x-amz-date": amzDate, "x-amz-content-sha256": payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    } });
    check(response.status === 200, "R2 bucket read", `HTTP ${response.status}; bucket-scoped credentials`);
  } catch (error) { check(false, "R2 bucket read", error.message); }
}

if (online && !checks.some(row => !row.ok)) {
  for (const [name, origin] of [["Forge DNS", value("FORGE_PUBLIC_ORIGIN")], ["Forgejo DNS", value("FORGEJO_PUBLIC_ORIGIN")]]) {
    try { const result = await lookup(new URL(origin).hostname); check(!!result.address, name, "resolves"); }
    catch (error) { check(false, name, error.code || error.message); }
  }
  await checkHttp(`${value("FORGE_PUBLIC_ORIGIN")}/healthz`, "Forge HTTPS health",
    async response => response.status === 200 && /max-age=/.test(response.headers.get("strict-transport-security") || ""));
  await checkHttp(`${value("FORGEJO_PUBLIC_ORIGIN")}/api/healthz`, "Forgejo HTTPS health", async response => response.status === 200);
  await checkR2();
}

for (const row of checks) console.log(`${row.ok ? "✓" : "✗"} ${row.name}: ${row.detail}`);
const failures = checks.filter(row => !row.ok);
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim() || "unknown";
if (evidencePath) {
  if (!isAbsolute(evidencePath)) throw new Error("--evidence path must be absolute");
  writeFileSync(evidencePath, `${JSON.stringify({ format: "forge-production-preflight", version: 1,
    checked_at: new Date().toISOString(), commit, online, origins: {
      forge: value("FORGE_PUBLIC_ORIGIN"), forgejo: value("FORGEJO_PUBLIC_ORIGIN"), r2_bucket: value("R2_LFS_BUCKET"),
    }, images: { gateway: value("FORGE_GATEWAY_IMAGE"), forgejo: value("FORGEJO_IMAGE"), forgejo_version: value("FORGEJO_VERSION"),
      postgres: value("POSTGRES_IMAGE"), postgres_major: value("POSTGRES_MAJOR") },
    checks }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(`\nEvidence written with no secret values: ${evidencePath}`);
}
if (failures.length) {
  console.error(`\nPRODUCTION PREFLIGHT FAILED — ${failures.length} check(s) need attention.`);
  process.exit(1);
}
console.log(`\nPRODUCTION PREFLIGHT GREEN — ${checks.length} checks passed for ${lint ? "the deployment template" : commit}.`);
