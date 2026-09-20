#!/usr/bin/env node
/** Operator inventory. Reads existing stores without migrations or repairs. */
import {DatabaseSync} from "node:sqlite";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {createReleaseVault} from "../platform/release-vault.mjs";
import {createLocalStore} from "../platform/store1-local.mjs";
import {createForgejoStore} from "../platform/store1-forgejo.mjs";
import {hostedProjectReindexPlan} from "../platform/project-reindex.mjs";
import {createOfflineForgejoPublicationStore} from "../platform/publication-offline-forgejo.mjs";
import {auditPublicationInventory,readPublicationInventorySqlite,readPublicationInventoryPostgres} from "../platform/publication-inventory.mjs";

function required(value,label){if(!value)throw new Error(`${label} is required`);return value;}
function mountedSecret(envValue,path){return envValue||(existsSync(path)?readFileSync(path,"utf8").trim():undefined);}

export async function runPublicationAudit(env=process.env){
  const postgres=env.DB==="postgres",vaultRoot=required(env.RELEASE_VAULT_DIR,"RELEASE_VAULT_DIR");
  if(!existsSync(vaultRoot))throw new Error("The configured release vault does not exist");
  if(!["sqlite","postgres"].includes(env.DB||"sqlite"))throw new Error("Unsupported DB driver");
  if(!["local","forgejo","forgejo-offline"].includes(env.STORE1||"local"))throw new Error("Unsupported Store 1 driver");
  let db,forgeDb;
  if(postgres){
    if(!env.PG_URL&&!env.PGHOST)throw new Error("PostgreSQL connection settings are required");
    const {default:pg}=await import("pg");
    db=new pg.Pool({...(env.PG_URL?{connectionString:env.PG_URL}:{host:env.PGHOST,port:env.PGPORT?Number(env.PGPORT):undefined,
      database:env.PGDATABASE,user:env.PGUSER,password:mountedSecret(env.PGPASSWORD,"/run/secrets/platform_db_password")}),
      options:"-c default_transaction_read_only=on",connectionTimeoutMillis:10000});
  }else db=new DatabaseSync(required(env.DB_PATH,"DB_PATH"),{readOnly:true});
  try{
    const inventory=await(postgres?readPublicationInventoryPostgres(db):readPublicationInventorySqlite(db));
    const hosted=env.STORE1==="forgejo";
    let store;
    if(env.STORE1==="forgejo-offline"){
      if(!env.FORGEJO_PG_URL&&!env.FORGEJO_PGHOST)throw new Error("Offline inventory needs the stopped Forgejo service's PostgreSQL settings");
      const {default:pg}=await import("pg");
      forgeDb=new pg.Pool({...(env.FORGEJO_PG_URL?{connectionString:env.FORGEJO_PG_URL}:{
        host:env.FORGEJO_PGHOST,port:env.FORGEJO_PGPORT?Number(env.FORGEJO_PGPORT):undefined,
        database:env.FORGEJO_PGDATABASE||"forgejo",user:env.FORGEJO_PGUSER||"forgejo",
        password:mountedSecret(env.FORGEJO_PGPASSWORD,"/run/secrets/forge_db_password")}),
        options:"-c default_transaction_read_only=on",connectionTimeoutMillis:10000});
      store=await createOfflineForgejoPublicationStore({root:required(env.FORGE_GIT_ROOT,"FORGE_GIT_ROOT"),db:forgeDb,games:inventory.games});
    }else store=hosted?createForgejoStore({root:resolve("."),forgeUrl:required(env.FORGE_URL,"FORGE_URL"),
      token:required(mountedSecret(env.FORGE_TOKEN,"/run/secrets/forge_token"),"FORGE_TOKEN")}):
      createLocalStore({root:required(env.LOCAL_STORE_ROOT,"LOCAL_STORE_ROOT"),gamesDir:required(env.GAMES_DIR,"GAMES_DIR")});
    const identityConflicts=[];
    if(hosted){
      for(const discovered of await store.list()){
        const meta=await store.readMeta(discovered),rows=inventory.games;
        const plan=hostedProjectReindexPlan(discovered,meta,{
          byRepoId:rows.find(row=>row.repo_id!=null&&String(row.repo_id)===String(meta.repoId)),
          byProjectId:rows.find(row=>row.project_id===meta.projectId),byStorageKey:rows.find(row=>row.slug===discovered)});
        if(plan.action==="quarantine"){
          // This removes only the audit process's in-memory binding. Never use
          // the server's quarantine helper: that changes repository visibility.
          store.quarantineProject(discovered);identityConflicts.push({slug:discovered,reason:plan.reason});
        }else if(plan.storageKey!==discovered)store.bindProjectKey(discovered,plan.storageKey);
      }
    }
    const report=await auditPublicationInventory({inventory,vault:createReleaseVault({root:vaultRoot}),store});
    return {...report,ok:report.ok&&identityConflicts.length===0,repository_identity_conflicts:identityConflicts};
  }finally{if(forgeDb)await forgeDb.end();if(postgres)await db.end();else db.close();}
}

if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
  try{
    const args=process.argv.slice(2);
    if(args.length&&!(args.length===2&&args[0]==="--output"))throw new Error("usage: node tools/publication-audit.mjs [--output new-report.json]");
    const report=await runPublicationAudit(),encoded=JSON.stringify(report,null,2)+"\n";
    if(args.length)writeFileSync(resolve(args[1]),encoded,{flag:"wx",mode:0o600});
    else process.stdout.write(encoded);
    if(!report.ok)process.exitCode=1;
  }catch(error){console.error(`Publication inventory could not complete: ${error.code||error.name||"error"}. No repair was attempted.`);process.exitCode=2;}
}
