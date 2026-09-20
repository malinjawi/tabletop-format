#!/usr/bin/env node
/** Filesystem contract. The pinned-image restore drill separately exercises
 * these SQL reads against Forgejo's real PostgreSQL schema. */
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createOfflineForgejoPublicationStore} from "../platform/publication-offline-forgejo.mjs";

const scratch=mkdtempSync(join(tmpdir(),"forge-offline-inventory."));
try{
  const source=join(scratch,"source"),root=join(scratch,"repositories"),owner=join(root,"owner");
  mkdirSync(source);mkdirSync(owner,{recursive:true});
  const git=(...args)=>execFileSync("git",args,{cwd:source,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trimEnd();
  git("init","-q");git("config","user.name","Inventory");git("config","user.email","inventory@example.invalid");
  writeFileSync(join(source,"game.yaml"),"title: Frozen game\n");git("add",".");git("commit","-qm","Source");
  const sha=git("rev-parse","HEAD"),message="Frozen title\n\nFrozen notes";
  git("tag","-a","v1.0","-m",message);git("clone","--bare",".",join(owner,"renamed.git"));
  const queries=[];let released=false;
  const db={connect:async()=>({query:async sql=>{
    queries.push(sql);
    if(sql.includes("FROM repository"))return {rows:[{id:"17",owner_name:"Owner",lower_name:"renamed"}]};
    if(sql.includes("FROM protected_tag"))return {rows:[{repo_id:"17",name_pattern:"v*"}]};
    assert.ok(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY","COMMIT","ROLLBACK"].includes(sql));
    return {rows:[]};
  },release:()=>{released=true;}})};
  const store=await createOfflineForgejoPublicationStore({root,db,games:[{slug:"old-name",repo_id:17}]});
  assert.ok(released&&queries[0].endsWith("READ ONLY")&&queries.at(-1)==="COMMIT");
  assert.equal(store.resolveRef("old-name",sha),sha,"physical repository ID survives a rename");
  assert.deepEqual(store.releaseTagInfo("old-name","v1.0"),{tag:"v1.0",target:sha,
    tagObject:git("rev-parse","v1.0"),annotated:true,protected:true,message});
  assert.equal(store.releaseTagInfo("old-name","v2.0"),null);
  assert.throws(()=>store.releaseTagInfo("missing","v1.0"));
  assert.throws(()=>store.releaseTagInfo("old-name","../v1.0"));
  assert.throws(()=>store.resolveRef("old-name","HEAD"));
  rmSync(join(owner,"renamed.git"),{recursive:true});symlinkSync(source,join(owner,"renamed.git"),"dir");
  assert.throws(()=>store.resolveRef("old-name",sha),/real directory/);
  console.log("OFFLINE FORGEJO INVENTORY: exact Git identity, readonly schema reads, rename binding and path guards passed.");
}finally{rmSync(scratch,{recursive:true,force:true});}
