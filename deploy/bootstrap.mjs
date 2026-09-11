#!/usr/bin/env node
/** Prepare a new controlled-beta environment without printing secret values. */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const valueOf = flag => { const at = args.indexOf(flag); return at >= 0 ? String(args[at + 1] || "").trim() : ""; };
const has = flag => args.includes(flag);
const usage = code => {
  console[code ? "error" : "log"](`Usage:
  node deploy/bootstrap.mjs \\
    --forge-origin https://forge.example \\
    --git-origin https://git.forge.example \\
    --operator "Accountable operator" --contact support@example.com \\
    --gateway-image registry.example/forge/platform@sha256:<digest> \\
    --r2-account-id <32-hex-id> --r2-bucket forge-lfs \\
    --r2-access-key-file /secure/r2-access-key \\
    --r2-secret-key-file /secure/r2-secret-key \\
    --release-vault-volume forge-release-vault-production \\
    --backup-destination /encrypted/off-host/forge-backups

Optional: --acme-email EMAIL --env PATH --secret-dir PATH
          --forgejo-image IMAGE --forgejo-version VERSION
          --postgres-image IMAGE --postgres-major MAJOR --forgejo-bind-port PORT

The command creates a new environment and secret directory atomically. It never
overwrites either target and never prints credential values.`);
  process.exit(code);
};
if (has("--help") || has("-h")) usage(0);

const parseEnv = path => Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/)
  .map(line => line.trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]));
const qualified = parseEnv(join(ROOT, "deploy", "qualified-images.env"));
const envPath = resolve(valueOf("--env") || join(ROOT, "deploy", ".env"));
const secretDir = resolve(valueOf("--secret-dir") || join(ROOT, "deploy", ".secrets"));
const forgeOrigin = valueOf("--forge-origin"), gitOrigin = valueOf("--git-origin");
const operator = valueOf("--operator"), contact = valueOf("--contact");
const acmeEmail = valueOf("--acme-email") || contact;
const gatewayImage = valueOf("--gateway-image");
const forgejoImage = valueOf("--forgejo-image") || qualified.FORGEJO_TEST_IMAGE;
const forgejoVersion = valueOf("--forgejo-version") || "15.0.7";
const postgresImage = valueOf("--postgres-image") || qualified.POSTGRES_TEST_IMAGE;
const postgresMajor = valueOf("--postgres-major") || "16";
const forgejoPort = valueOf("--forgejo-bind-port") || "3000";
const r2Account = valueOf("--r2-account-id"), r2Bucket = valueOf("--r2-bucket");
const backupDestination = valueOf("--backup-destination");
const releaseVaultVolume = valueOf("--release-vault-volume");
const r2AccessPath = resolve(valueOf("--r2-access-key-file") || "/missing");
const r2SecretPath = resolve(valueOf("--r2-secret-key-file") || "/missing");
const testSecrets = has("--test-deterministic-secrets");

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const validOrigin = input => {
  try { const url = new URL(input); return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash; }
  catch { return false; }
};
const imagePattern = /^[^\s]+@sha256:[a-f0-9]{64}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const placeholder = input => /(?:replace|example|your organization|<|>)/i.test(input);
check(validOrigin(forgeOrigin), "--forge-origin must be a public HTTPS origin with no path");
check(validOrigin(gitOrigin), "--git-origin must be a public HTTPS origin with no path");
check(forgeOrigin !== gitOrigin, "Forge and Git origins must differ");
check(operator.length >= 2 && !placeholder(operator), "--operator must name the accountable operator");
check(emailPattern.test(contact) && !contact.endsWith(".invalid") && !placeholder(contact), "--contact must be a real public contact email");
check(emailPattern.test(acmeEmail) && !acmeEmail.endsWith(".invalid") && !placeholder(acmeEmail), "--acme-email must be a real certificate-alert email");
check(imagePattern.test(gatewayImage), "--gateway-image must be an immutable registry digest");
check(imagePattern.test(forgejoImage), "--forgejo-image must be an immutable digest");
check(imagePattern.test(postgresImage), "--postgres-image must be an immutable digest");
check(/^15\./.test(forgejoVersion), "--forgejo-version must remain on the recovery-qualified 15.x major");
check(postgresMajor === "16", "--postgres-major must remain on the recovery-qualified 16 major");
check(/^\d{2,5}$/.test(forgejoPort) && Number(forgejoPort) >= 1024 && Number(forgejoPort) <= 65535,
  "--forgejo-bind-port must be an unprivileged TCP port");
check(/^[a-f0-9]{32}$/i.test(r2Account), "--r2-account-id must contain 32 hexadecimal characters");
check(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(r2Bucket), "--r2-bucket is not a valid dedicated bucket name");
check(/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/.test(releaseVaultVolume) && !placeholder(releaseVaultVolume),
  "--release-vault-volume must be an explicit safe Docker volume name");
check(isAbsolute(backupDestination) && !["/", "/tmp", "/var", "/Users", "/home"].includes(resolve(backupDestination || "/"))
  && !resolve(backupDestination || "/").startsWith(join(ROOT, "deploy") + sep),
"--backup-destination must be an explicit absolute off-host path outside deploy/");
for (const [label, path] of [["R2 access-key", r2AccessPath], ["R2 secret-key", r2SecretPath]]) {
  const present = existsSync(path) && lstatSync(path).isFile();
  check(present, `${label} file is missing`);
  if (present) check((lstatSync(path).mode & 0o077) === 0, `${label} file must not be readable by group or others`);
}
check(!existsSync(envPath), `refusing to overwrite existing environment: ${envPath}`);
check(!existsSync(secretDir), `refusing to overwrite existing secret directory: ${secretDir}`);
check(envPath !== resolve("/") && secretDir !== resolve("/") && secretDir !== ROOT,
  "environment and secret targets must not be filesystem or repository roots");
if (testSecrets) check(envPath.startsWith(resolve(tmpdir()) + sep) && secretDir.startsWith(resolve(tmpdir()) + sep),
  "--test-deterministic-secrets is restricted to temporary output paths");
if (failures.length) {
  failures.forEach(message => console.error(`ERROR ${message}`));
  process.exit(2);
}

const r2Access = readFileSync(r2AccessPath, "utf8").trim();
const r2Secret = readFileSync(r2SecretPath, "utf8").trim();
check(r2Access.length >= 16, "R2 access-key file is unexpectedly short");
check(r2Secret.length >= 16, "R2 secret-key file is unexpectedly short");
check(r2Access !== r2Secret, "R2 access and secret keys must not be identical");
if (failures.length) {
  failures.forEach(message => console.error(`ERROR ${message}`));
  process.exit(2);
}

const forgejoSecret = kind => {
  if (testSecrets) return `test-${kind.toLowerCase()}-${randomBytes(16).toString("hex")}`;
  const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--entrypoint", "forgejo", forgejoImage, "generate", "secret", kind],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
  const value = result.stdout.trim();
  if (result.status !== 0 || value.length < 16)
    throw new Error(`Forgejo could not generate ${kind}; verify Docker and the pinned image`);
  return value;
};
const secretValues = {
  "forge-token": "",
  "pg-super-password": randomBytes(32).toString("base64"),
  "forge-db-password": randomBytes(32).toString("base64"),
  "platform-db-password": randomBytes(32).toString("base64"),
  "forgejo-secret-key": forgejoSecret("SECRET_KEY"),
  "forgejo-internal-token": forgejoSecret("INTERNAL_TOKEN"),
  "forgejo-oauth2-jwt-secret": forgejoSecret("JWT_SECRET"),
  "lfs-jwt-secret": forgejoSecret("LFS_JWT_SECRET"),
  "r2-access-key": r2Access,
  "r2-secret-key": r2Secret,
};
const nonEmpty = Object.entries(secretValues).filter(([name]) => name !== "forge-token").map(([, value]) => value);
if (new Set(nonEmpty).size !== nonEmpty.length) throw new Error("generated secret values were not unique");

// Double-quoted values work as both Docker Compose dotenv and POSIX shell input.
// Reject expansion/escape characters rather than producing a file that changes
// meaning when the documented operator commands source it.
const envQuote = (name, value) => {
  if (/[\r\n\0"\\$`]/.test(value)) throw new Error(`${name} contains a character that is unsafe in a deployment environment file`);
  return `"${value}"`;
};
const environment = `# Generated by deploy/bootstrap.mjs. Contains configuration, not secret values.\nFORGE_PUBLIC_ORIGIN=${envQuote("Forge origin", forgeOrigin)}\nFORGEJO_PUBLIC_ORIGIN=${envQuote("Git origin", gitOrigin)}\nFORGE_BIND_IP="127.0.0.1"\nFORGEJO_BIND_PORT=${envQuote("Forgejo port", forgejoPort)}\nFORGE_SECRET_DIR=${envQuote("secret directory", secretDir)}\nFORGE_RELEASE_VAULT_VOLUME=${envQuote("release vault volume", releaseVaultVolume)}\n\nFORGE_REGISTRATION_MODE="invite"\nFORGE_INVITE_MODE="database"\nFORGE_OPERATOR_NAME=${envQuote("operator", operator)}\nFORGE_CONTACT_EMAIL=${envQuote("contact", contact)}\nACME_EMAIL=${envQuote("ACME email", acmeEmail)}\n\nFORGE_GATEWAY_IMAGE=${envQuote("gateway image", gatewayImage)}\nFORGEJO_IMAGE=${envQuote("Forgejo image", forgejoImage)}\nFORGEJO_VERSION=${envQuote("Forgejo version", forgejoVersion)}\nPOSTGRES_IMAGE=${envQuote("PostgreSQL image", postgresImage)}\nPOSTGRES_MAJOR=${envQuote("PostgreSQL major", postgresMajor)}\n\nR2_ACCOUNT_ID=${envQuote("R2 account", r2Account)}\nR2_LFS_BUCKET=${envQuote("R2 bucket", r2Bucket)}\nFORGE_BACKUP_DESTINATION=${envQuote("backup destination", backupDestination)}\n`;

mkdirSync(dirname(envPath), { recursive: true });
mkdirSync(dirname(secretDir), { recursive: true });
const stagedSecrets = mkdtempSync(join(dirname(secretDir), ".forge-secrets-"));
const stagedEnv = join(dirname(envPath), `.${basename(envPath)}.forge-${process.pid}-${randomBytes(5).toString("hex")}`);
let movedSecrets = false, movedEnv = false;
try {
  chmodSync(stagedSecrets, 0o700);
  for (const [name, value] of Object.entries(secretValues))
    writeFileSync(join(stagedSecrets, name), value ? `${value}\n` : "", { mode: 0o600, flag: "wx" });
  writeFileSync(stagedEnv, environment, { mode: 0o600, flag: "wx" });
  renameSync(stagedSecrets, secretDir); movedSecrets = true;
  renameSync(stagedEnv, envPath); movedEnv = true;
} catch (error) {
  if (!movedSecrets) rmSync(stagedSecrets, { recursive: true, force: true });
  if (!movedEnv) rmSync(stagedEnv, { force: true });
  if (movedSecrets && !movedEnv) rmSync(secretDir, { recursive: true, force: true });
  throw error;
}

console.log("FORGE DEPLOYMENT BOOTSTRAP READY — configuration and 10 secret files created without disclosure.");
console.log(`  environment ${envPath}`);
console.log(`  secrets     ${secretDir}`);
console.log("  forge-token is intentionally empty until the scoped Forgejo service account is created.");
console.log(`Next: create external Docker volume ${releaseVaultVolume}, then run node deploy/preflight.mjs --env ${JSON.stringify(envPath)} --first-boot`);
