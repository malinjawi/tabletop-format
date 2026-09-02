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
ok(env.STORE1==="forgejo" && env.DB==="postgres" && env.FORGE_URL==="http://forgejo:3000",
  "production uses Forgejo and PostgreSQL rather than local stores");
ok(env.FORGE_HUB_PATH==="/app/data/hub.html" && env.CACHE_DIR?.startsWith("/app/data/")
  && env.FARM_DIR?.startsWith("/app/data/"),
  "all gateway-generated files live on its writable data volume");
ok(env.FORGE_HTTPS==="1" && /^https:\/\//.test(env.FORGE_PUBLIC_ORIGIN||"")
  && env.FORGE_ALLOWED_ORIGINS===env.FORGE_PUBLIC_ORIGIN,
  "HTTPS and exact-origin browser writes are enforced");
ok(env.FORGE_REGISTRATION_MODE!=="open" && env.FORGE_INVITE_CODE,
  "controlled-alpha registration is invite-only");
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
  && forgejo.environment?.FORGEJO__security__INSTALL_LOCK==="true",
  "Forgejo cannot become a second uncontrolled account surface");
ok(Array.isArray(gateway.secrets) && gateway.secrets.some(secret=>secret.source==="forge_token")
  && gateway.secrets.some(secret=>secret.source==="platform_db_password"),
  "gateway credentials are file-mounted secrets");

console.log(`\nPRODUCTION CONFIG GREEN — ${checks} deployability and isolation checks passed.`);
