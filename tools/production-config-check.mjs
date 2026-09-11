#!/usr/bin/env node
/** Fail closed when the documented production topology stops being deployable. */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT=resolve(import.meta.dirname,"..");
let checks=0;
const ok=(condition,message)=>{
  if(!condition)throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${String(++checks).padStart(2,"0")}  ${message}`);
};
const result=spawnSync("docker",["compose","--env-file","deploy/.env.example","-f","deploy/docker-compose.prod.yml","config","--format","json"],{
  cwd:ROOT,encoding:"utf8",maxBuffer:8*1024*1024,
});
if(result.status!==0)throw new Error(`docker compose config failed:\n${result.stderr}`);
const config=JSON.parse(result.stdout), services=config.services||{};
const gateway=services.gateway||{}, forgejo=services.forgejo||{}, db=services.db||{};
const env=gateway.environment||{};

ok([gateway,forgejo,db].every(service=>/@sha256:/.test(service.image||"")),
  "gateway, Forgejo, and Postgres images are digest-pinned");
ok(gateway.read_only===true && gateway.user==="1000:1000"
  && gateway.cap_drop?.includes("ALL") && gateway.security_opt?.includes("no-new-privileges:true"),
  "gateway filesystem, identity, capabilities, and privilege escalation are constrained");
ok(gateway.command?.[0]==="/bin/sh" && gateway.command?.[1]==="-ec"
  && gateway.command?.[2]?.includes("/run/secrets/forge_token")
  && gateway.command?.[2]?.includes("exec node server.mjs --port 8420"),
  "gateway reads runtime secrets before replacing the shell with Node");
const dockerfile=readFileSync(resolve(ROOT,"Dockerfile.prod"),"utf8");
ok(/^CMD \["node", "server\.mjs", "--port", "8420"\]$/m.test(dockerfile)
  && !/^ENTRYPOINT /m.test(dockerfile),
  "image defaults to Node without overriding the Compose secret-loading command");
ok(dockerfile.includes("test -f /etc/debian_version")
  && dockerfile.includes("ARG FORGE_SOURCE_REVISION")
  && dockerfile.includes('org.opencontainers.image.revision="${FORGE_SOURCE_REVISION}"'),
  "image requires a compatible Debian base and records its exact source revision");
ok(dockerfile.includes("mkdir -p /app/data /app/vault && chown node:node /app/data /app/vault"),
  "image seeds the writable cache and release-vault mountpoints for the unprivileged runtime user");
const dockerignore=readFileSync(resolve(ROOT,".dockerignore"),"utf8");
ok(/^hub\.html$/m.test(dockerignore) && /^beta-site$/m.test(dockerignore)
  && /^data$/m.test(dockerignore) && /^output$/m.test(dockerignore),
  "image excludes generated hubs, static previews, runtime data, and export output");
ok(/apt-get install[\s\S]*\bchromium\b/.test(dockerfile)
  && /apt-get install[\s\S]*\bpython3-pypdf\b/.test(dockerfile)
  && /apt-get install[\s\S]*\bpython3-openpyxl\b/.test(dockerfile),
  "image includes the headless renderer, PDF inspector, and workbook adapter required by production exports");
ok(env.STORE1==="forgejo" && env.DB==="postgres" && env.FORGE_URL==="http://forgejo:3000",
  "production uses Forgejo and PostgreSQL rather than local stores");
ok(env.FORGE_HUB_PATH==="/app/data/hub.html" && env.CACHE_DIR?.startsWith("/app/data/")
  && env.FARM_DIR?.startsWith("/app/data/"),
  "regenerable gateway files live on the writable Store-3 data volume");
const releaseVaultMount=(gateway.volumes||[]).find(volume=>volume.target==="/app/vault");
const releaseVaultVolume=config.volumes?.["release-vault-data"];
ok(env.RELEASE_VAULT_DIR==="/app/vault" && releaseVaultMount?.type==="volume"
  && releaseVaultMount?.source==="release-vault-data" && releaseVaultVolume?.external===true
  && /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/.test(releaseVaultVolume?.name||""),
  "release bytes use a pre-created external volume outside Compose and Store-3 lifecycles");
ok(env.FORGE_BUILD_ID===gateway.image&&/@sha256:/.test(env.FORGE_BUILD_ID||""),
  "release build identity records the digest-pinned gateway image");
ok(env.FORGE_HTTPS==="1" && /^https:\/\//.test(env.FORGE_PUBLIC_ORIGIN||"")
  && /^https:\/\//.test(env.FORGEJO_PUBLIC_ORIGIN||"")
  && env.FORGE_ALLOWED_ORIGINS===env.FORGE_PUBLIC_ORIGIN,
  "Forge and its visible Git remote use HTTPS, with exact-origin browser writes enforced");
ok(env.FORGE_REGISTRATION_MODE==="invite" && env.FORGE_INVITE_MODE==="database"
  && !("FORGE_INVITE_CODE" in env),
  "controlled-beta registration uses database-backed single-use invitations");
ok(!("FORGE_TOKEN" in env) && !("PGPASSWORD" in env),
  "service and database credentials are not exposed in Compose environment metadata");
ok(gateway.ports?.length===1 && gateway.ports[0].host_ip==="127.0.0.1" && gateway.ports[0].target===8420,
  "Forge HTTP binds only to loopback for the TLS proxy");
ok(forgejo.ports?.length===1 && forgejo.ports[0].host_ip==="127.0.0.1" && forgejo.ports[0].target===3000,
  "Forgejo Git/LFS binds only to loopback for the TLS proxy");
ok(config.networks?.backend?.internal===true && Object.keys(db.networks||{}).length===1
  && "backend" in (db.networks||{}) && !db.ports,
  "PostgreSQL stays on the private backend network with no host port");
ok(forgejo.environment?.FORGEJO__service__DISABLE_REGISTRATION==="true"
  && forgejo.environment?.FORGEJO__security__INSTALL_LOCK==="true"
  && forgejo.environment?.FORGEJO__repository__FORCE_PRIVATE==="true"
  && forgejo.environment?.FORGEJO__repository__DEFAULT_PRIVATE==="private",
  "Forgejo cannot become a second uncontrolled account surface and repositories start private");
const forgejoRecoverySecrets={
  forgejo_secret_key:["FORGEJO__security__SECRET_KEY__FILE","/run/secrets/forgejo_secret_key"],
  forgejo_internal_token:["FORGEJO__security__INTERNAL_TOKEN__FILE","/run/secrets/forgejo_internal_token"],
  forgejo_oauth2_jwt_secret:["FORGEJO__oauth2__JWT_SECRET__FILE","/run/secrets/forgejo_oauth2_jwt_secret"],
  lfs_jwt_secret:["FORGEJO__server__LFS_JWT_SECRET__FILE","/run/secrets/lfs_jwt_secret"],
};
ok(Object.entries(forgejoRecoverySecrets).every(([source,[key,value]])=>
  forgejo.environment?.[key]===value && forgejo.secrets?.some(secret=>secret.source===source)),
  "Forgejo encryption, internal, OAuth, and LFS keys are file-backed recovery inputs");
ok(forgejo.environment?.FORGEJO__oauth2__JWT_SIGNING_ALGORITHM==="HS256",
  "OAuth token signing has no untracked generated private-key dependency");
ok(forgejo.environment?.FORGEJO__database__PASSWD_URI==="file:/run/secrets/forge_db_password"
  && !Object.keys(forgejo.environment||{}).some(key=>key.endsWith("PASSWD__FILE")),
  "Forgejo keeps its database password out of generated app.ini");
ok(Array.isArray(gateway.secrets) && gateway.secrets.some(secret=>secret.source==="forge_token")
  && gateway.secrets.some(secret=>secret.source==="platform_db_password"),
  "gateway credentials are file-mounted secrets");
const edge=readFileSync(resolve(ROOT,"deploy/Caddyfile.example"),"utf8");
ok(edge.includes("{$FORGE_PUBLIC_ORIGIN}") && edge.includes("127.0.0.1:8420")
  && edge.includes("{$FORGEJO_PUBLIC_ORIGIN}") && edge.includes("127.0.0.1:3000")
  && edge.includes("email {$ACME_EMAIL}"),
  "host TLS proxy has explicit Forge, Forgejo, and certificate-contact routes");
const template=readFileSync(resolve(ROOT,"deploy/.env.example"),"utf8");
ok(/^ACME_EMAIL=.+/m.test(template) && /^FORGE_BACKUP_DESTINATION=\/.+/m.test(template)
  && /^FORGE_RELEASE_VAULT_VOLUME=[A-Za-z0-9][A-Za-z0-9_.-]+$/m.test(template),
  "deployment template requires TLS alerts, an external vault, and an explicit off-host backup target");
ok(/^FORGEJO_VERSION=15\./m.test(template) && /^POSTGRES_MAJOR=16$/m.test(template),
  "deployment template pins the majors qualified by the recovery drill");
const restoreDrill=readFileSync(resolve(ROOT,"tools/disposable-restore-drill.sh"),"utf8");
const restoreRunbook=readFileSync(resolve(ROOT,"deploy/RESTORE-DRILL.md"),"utf8");
ok(restoreDrill.includes("FORGE_GATEWAY_TEST_IMAGE")
  && restoreDrill.includes("org.opencontainers.image.revision")
  && restoreDrill.includes("--read-only --tmpfs /tmp"),
  "recovery can be verified through the exact source-matched, read-only gateway image");
const qualified=readFileSync(resolve(ROOT,"deploy/qualified-images.env"),"utf8");
const qualifiedImages=[...qualified.matchAll(/^([A-Z0-9_]+_IMAGE)=([^\n]+)$/gm)];
ok(qualifiedImages.length===6 && qualifiedImages.every(([, , value])=>/@sha256:[a-f0-9]{64}$/.test(value)),
  "qualified gateway dependencies are recorded as six immutable image digests");
const imageGate=readFileSync(resolve(ROOT,"tools/qualify-production-image.sh"),"utf8");
const workflow=readFileSync(resolve(ROOT,".github/workflows/quality.yml"),"utf8");
ok(imageGate.includes("deploy/qualified-images.env")
  && imageGate.includes("FORGE_SOURCE_REVISION")
  && imageGate.includes("S3_TEST_IMAGE")
  && imageGate.includes("disposable-restore-drill.sh")
  && workflow.includes("./tools/qualify-production-image.sh"),
  "CI builds the source-labelled gateway and rehearses synchronized recovery through that exact image");
const workflowActions=[...workflow.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)/gm)];
const trustedActions=new Set(["actions/checkout", "actions/setup-node", "actions/setup-python",
  "actions/upload-artifact", "actions/download-artifact"]);
ok(workflowActions.length===7
  && workflowActions.every(([, action, revision])=>trustedActions.has(action) && /^[a-f0-9]{40}$/.test(revision)),
  "CI uses only allowlisted first-party actions pinned to immutable commit SHAs");
const publisher=workflow.slice(workflow.indexOf("  publish-image:"));
ok(workflow.includes("needs: [product-gate, release-image]")
  && publisher.includes("packages: write")
  && !publisher.includes("contents: write")
  && publisher.includes("if: github.event_name == 'push' && github.ref == 'refs/heads/main'")
  && publisher.includes(":sha-${GITHUB_SHA}")
  && publisher.includes('existing_image_id" != "$local_image_id')
  && publisher.includes("refusing to overwrite")
  && publisher.includes("docker load")
  && !publisher.includes("docker build"),
  "GHCR promotion is main-push-only, reuses the qualified image, and refuses mismatched commit tags");
ok(workflow.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}")
  && workflow.includes("github.event_name == 'pull_request' && github.ref || github.sha"),
  "only superseded pull-request checks may cancel; main release runs are isolated by commit");
const backup=readFileSync(resolve(ROOT,"deploy/backup.sh"),"utf8");
const vaultSnapshot=readFileSync(resolve(ROOT,"deploy/release-vault-snapshot.mjs"),"utf8");
ok(backup.includes("s3-snapshot.mjs\" backup")
  && backup.includes("object-store/manifest.json")
  && restoreDrill.includes("s3-snapshot.mjs\" restore"),
  "production and disposable recovery independently snapshot and restore the remote LFS object store");
ok(backup.includes("release-vault-snapshot.mjs backup")
  && backup.includes("release-vault/manifest.json")
  && backup.includes("--source /app/vault")
  && backup.includes('$vault_volume_name:/app/vault:ro')
  && backup.includes('"$gateway_image_id"'),
  "synchronized production backup snapshots and checksums the dedicated release-artifact vault");
ok(backup.includes("backup_lock_dir=") && backup.includes("services_stop_attempted=1")
  && backup.indexOf("services_stop_attempted=1") < backup.indexOf('"${compose[@]}" stop gateway forgejo')
  && vaultSnapshot.includes("createReleaseVault({ root }).audit()")
  && vaultSnapshot.includes('assertSemanticVault(output, "restored output")'),
  "backup outage is exclusively locked, restart is armed first, and vault semantics are audited on backup/restore");
ok(restoreDrill.includes('source_vault_volume="$prefix-source-release-vault"')
  && restoreDrill.includes('restore_vault_volume="$prefix-restore-release-vault"')
  && restoreDrill.includes("release-vault-snapshot.mjs\" backup")
  && restoreDrill.includes("release-vault-snapshot.mjs\" restore")
  && restoreDrill.includes("release-vault/manifest.json")
  && restoreDrill.includes("RELEASE_VAULT_DIR=/app/vault")
  && restoreDrill.includes("FORGE_RESTORE_CACHE_WAS_EMPTY=1")
  && restoreDrill.includes("--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add DAC_READ_SEARCH")
  && restoreRunbook.includes('docker volume create "$FORGE_RELEASE_VAULT_VOLUME"')
  && restoreRunbook.includes("--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add DAC_READ_SEARCH"),
  "disposable recovery restores the checksummed durable vault into a fresh target and verifies it with Store 3 empty");

console.log(`\nPRODUCTION CONFIG GREEN — ${checks} deployability and isolation checks passed.`);
