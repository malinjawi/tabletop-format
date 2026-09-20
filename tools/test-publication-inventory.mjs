#!/usr/bin/env node
/** Run only against this test's isolated SQLite DB or an explicitly disposable
 * PostgreSQL URL in FORGE_INVENTORY_TEST_PG_URL. Never use a team's database. */
import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {execFileSync} from "node:child_process";
import {createLocalStore} from "../platform/store1-local.mjs";
import {runPublicationAudit} from "./publication-audit.mjs";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,unlinkSync,rmSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createReleaseVault} from "../platform/release-vault.mjs";
import {auditPublicationInventory,readPublicationInventorySqlite,readPublicationInventoryPostgres} from "../platform/publication-inventory.mjs";

let pgUrl=process.env.FORGE_INVENTORY_TEST_PG_URL;
if(pgUrl&&process.env.FORGE_INVENTORY_TEST_DISPOSABLE!=="1")throw new Error("Explicit disposable PostgreSQL acknowledgment is required");
let adminDb,testSchema;
if(pgUrl){
  const {default:pg}=await import("pg");adminDb=new pg.Pool({connectionString:pgUrl});
  testSchema=`inventory_test_${randomBytes(8).toString("hex")}`;
  await adminDb.query(`CREATE SCHEMA ${testSchema}`);
  const url=new URL(pgUrl);url.searchParams.set("options",`-c search_path=${testSchema}`);pgUrl=url.href;
}
const driver=await import(pgUrl?"../platform/db-pg.mjs":"../platform/db.mjs");
const scratch=mkdtempSync(join(realpathSync(tmpdir()),"forge-publication-inventory."));
const db=await driver.openDb(pgUrl||join(scratch,"platform.db")),q=driver.q;
const read=()=>pgUrl?readPublicationInventoryPostgres(db):readPublicationInventorySqlite(db);
const execute=async(sql,values=[])=>pgUrl?db.query(sql.replace(/\?/g,(()=>{let n=0;return()=>`$${++n}`;})()),values):db.prepare(sql).run(...values);
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const slug="inventory-test",author="inventory-owner";
const gitRoot=join(scratch,"repo"),games=join(gitRoot,"examples");mkdirSync(join(games,slug),{recursive:true});
writeFileSync(join(games,slug,"game.yaml"),"title: Inventory test\n");
const git=(...args)=>execFileSync("git",args,{cwd:gitRoot,encoding:"utf8"}).trim();
git("init","-q");git("config","user.name","Inventory test");git("config","user.email","inventory@example.invalid");
git("add",".");git("commit","-qm","Exact source");const source=git("rev-parse","HEAD");
const localStore=createLocalStore({root:gitRoot,gamesDir:games});
const root=join(scratch,"vault"),vault=createReleaseVault({root}),sourceDir=join(scratch,"source");
mkdirSync(sourceDir);writeFileSync(join(sourceDir,"pnp.pdf"),"frozen publication test bytes\n");
const bytes=readFileSync(join(sourceDir,"pnp.pdf"));
const artifacts=[{status:"ready",name:"pnp.pdf",bytes:bytes.length,sha256:hash(bytes)}];
const tags=new Map();
const store={resolveRef:(game,ref)=>localStore.resolveRef(game,ref),releaseTagInfo:async(_slug,tag)=>tags.get(tag)||null};
let checks=0;
const verify=(condition,message)=>{assert.ok(condition,message);checks++;};
const audit=async()=>auditPublicationInventory({inventory:await read(),vault,store});
try{
  const initial=await read();
  assert.ok(Object.values(initial).every(rows=>rows.length===0),"requires an empty disposable publication inventory");
  await execute("INSERT INTO users(id,handle,email,pass_hash,created_at) VALUES(?,?,?,?,?)",[author,author,"owner@example.invalid","not-a-login",1]);
  await execute("INSERT INTO games(slug,title,indexed_at) VALUES(?,?,?)",[slug,"Inventory test",1]);
  vault.initialize();
  verify((await audit()).ok,"an empty initialized installation is consistent");
  const prepare=async(tag,{journal=true,finalize=true,eventId=`event-${tag}`}={})=>{
    const publication={created_at:100,sealed_at:100,publisher:{name:author,email:"owner@example.invalid"},
      release:{artifacts,author_id:author,build:{version:1},notes:"Exact notes",rights:{publishable:true},title:`Release ${tag}`},
      event:{id:eventId,kind:"release",actor_id:author}};
    const sealed=vault.publishNativeRelease({slug,tag,sourceSha:source,sourceDir,artifacts,publication});
    if(journal)await q.prepareReleasePublication(db,{created_at:100,
      release:{game_slug:slug,tag,sha:source,title:publication.release.title,notes:publication.release.notes,author_id:author,
        artifacts_json:JSON.stringify(artifacts),rights_json:JSON.stringify(publication.release.rights),build_json:JSON.stringify(publication.release.build)},
      vault:{format_version:2,binding_kind:"tag-manifest",manifest_sha256:sealed.manifestSha256,sealed_at:100},event:publication.event});
    let live={tag,target:source,tagObject:"2".repeat(40),annotated:true,protected:true,
      message:`Release ${tag}\n\nExact notes\n\nForge project: ${slug}\nExact source: ${source}\nForge artifact vault: sha256:${sealed.manifestSha256}`};
    if(finalize){localStore.createReleaseTag(slug,tag,source,live.message,"Inventory test <inventory@example.invalid>");
      live=localStore.releaseTagInfo(slug,tag);tags.set(tag,live);await q.finalizeReleasePublication(db,{game_slug:slug,tag,tag_object_sha:live.tagObject,tag_annotated:true,tag_protected:true});}
    return {sealed,live};
  };
  const healthy=await prepare("v1.0");
  let report=await audit();verify(report.ok&&report.counts.healthy===1,"complete database, journal, event, bytes and tag agree");
  const cliReport=await runPublicationAudit({DB:pgUrl?"postgres":"sqlite",PG_URL:pgUrl,DB_PATH:join(scratch,"platform.db"),
    RELEASE_VAULT_DIR:root,STORE1:"local",LOCAL_STORE_ROOT:gitRoot,GAMES_DIR:games});
  verify(cliReport.ok&&cliReport.counts.healthy===1,"operator audit opens the existing database read-only and verifies real Git tags");
  const before=JSON.stringify(await read()),manifestBytes=readFileSync(join(root,healthy.sealed.manifestKey));
  await audit();verify(JSON.stringify(await read())===before,"inventory audit writes no database state");
  verify(readFileSync(join(root,healthy.sealed.manifestKey)).equals(manifestBytes),"audit preserves sealed evidence bytes");
  const pending=await prepare("v1.1",{finalize:false});
  report=await audit();verify(report.ok&&report.counts.recoverable===1,"pending sealed publication before tag creation is recoverable");
  tags.set("v1.1",pending.live);
  verify((await audit()).counts.recoverable===1,"pending publication after protected tag creation remains discoverable");
  await prepare("v1.2",{journal:false,finalize:false});
  report=await audit();verify(report.ok&&report.counts.recoverable===2,"native seal before journal is discoverable from vault inventory");
  const blob=join(root,"blobs/sha256",hash(bytes).slice(0,2),hash(bytes));
  unlinkSync(blob);report=await audit();verify(!report.ok&&report.counts.missing===3,"every release sharing a missing blob is identified");
  writeFileSync(blob,bytes);
  const manifestPath=join(root,healthy.sealed.manifestKey);
  unlinkSync(manifestPath);report=await audit();
  verify(!report.ok&&report.publications.find(item=>item.tag==="v1.0").classification==="missing","a missing seal is not invented as contradictory tag evidence");
  writeFileSync(manifestPath,manifestBytes);
  const unavailable=await auditPublicationInventory({inventory:await read(),vault,
    store:{...store,releaseTagInfo:async()=>{throw new Error("service unavailable");}}});
  verify(unavailable.counts.unavailable===3,"an unreachable tag service is unverified, not claimed missing");
  const withoutAccount=await auditPublicationInventory({inventory:{...await read(),users:[]},vault,store});
  verify(!withoutAccount.ok&&withoutAccount.counts.missing===3,"native publication recovery requires its original publisher account");
  writeFileSync(blob,Buffer.from("corrupt"));
  report=await audit();verify(!report.ok&&report.counts.contradictory===3,"changed preserved bytes are corruption, not a rebuild request");
  writeFileSync(blob,bytes);
  tags.set("v1.0",{...healthy.live,protected:false});
  verify(!(await audit()).ok,"the tag must still be protected in Store 1");
  tags.set("v1.0",{...healthy.live,message:"different tag metadata"});
  report=await audit();verify(!report.ok&&report.counts.contradictory===1,"wrong protected tag message fails closed");
  tags.set("v1.0",{...healthy.live,tagObject:"3".repeat(40)});
  verify(!(await audit()).ok,"replacement annotated tag object fails its stored identity");
  tags.set("v1.0",healthy.live);
  await execute("UPDATE releases SET notes=? WHERE game_slug=? AND tag=?",["changed",slug,"v1.0"]);
  verify(!(await audit()).ok,"database publication text must match sealed metadata");
  await execute("UPDATE releases SET notes=? WHERE game_slug=? AND tag=?",["Exact notes",slug,"v1.0"]);
  await execute("UPDATE pending_release_publications SET event_id=? WHERE game_slug=? AND release_tag=?",["wrong-event",slug,"v1.0"]);
  verify(!(await audit()).ok,"finalized journals are checked, not only open journals");
  await execute("UPDATE pending_release_publications SET event_id=? WHERE game_slug=? AND release_tag=?",["event-v1.0",slug,"v1.0"]);
  const legacy=vault.publishRelease({slug,tag:"v0.1",sourceSha:source,sourceDir,artifacts});
  report=await audit();verify(!report.ok&&report.counts.unreferenced===1,"legacy orphan manifest is explicit and never invented into a publication");
  verify(readFileSync(join(root,legacy.manifestKey)).length>0,"unreferenced manifest remains intact");
  await prepare("v1.3",{journal:false,finalize:false,eventId:"event-v1.2"});
  report=await audit();verify(report.publications.filter(item=>["v1.2","v1.3"].includes(item.tag))
    .every(item=>item.classification==="contradictory"&&item.findings.some(f=>f.code==="event-reserved-by-multiple-seals")),
    "two pre-journal seals cannot reserve the same publication event");
  console.log(`PUBLICATION INVENTORY ${pgUrl?"POSTGRES":"SQLITE"}: ${checks} checks passed; integration and backup qualification remain separate.`);
}finally{
  if(pgUrl)await db.end();else db.close();
  if(adminDb){await adminDb.query(`DROP SCHEMA ${testSchema} CASCADE`);await adminDb.end();}
  rmSync(scratch,{recursive:true,force:true});
}
