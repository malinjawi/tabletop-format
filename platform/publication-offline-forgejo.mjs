/** Read frozen Forgejo Git and database state while its service is stopped.
 * Schema qualified against Forgejo v15.0.7:
 * https://codeberg.org/forgejo/forgejo/src/tag/v15.0.7/models/repo/repo.go
 * https://codeberg.org/forgejo/forgejo/src/tag/v15.0.7/models/git/protected_tag.go
 * This adapter has no write, migration, checkout, fetch, or repair methods.
 */
import {execFileSync} from "node:child_process";
import {lstatSync,realpathSync} from "node:fs";
import {join,relative,sep} from "node:path";

export async function createOfflineForgejoPublicationStore({root,db,games}){
  const directory=realpathSync(root),client=await db.connect();let repositories,protections;
  try{
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    repositories=(await client.query("SELECT id, owner_name, lower_name FROM repository ORDER BY id")).rows;
    protections=(await client.query("SELECT repo_id, name_pattern FROM protected_tag ORDER BY id")).rows;
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}
  finally{client.release();}
  const indexed=new Map(games.map(game=>[game.slug,game]));
  const physical=new Map(repositories.map(repo=>[String(repo.id),repo]));
  const repoPath=slug=>{
    const row=indexed.get(slug),repo=row?.repo_id!=null?physical.get(String(row.repo_id)):null;
    if(!repo)throw new Error("The indexed physical Forgejo repository could not be verified");
    const owner=String(repo.owner_name).toLowerCase(),name=String(repo.lower_name);
    if(!/^[a-z0-9][a-z0-9_.-]*$/.test(owner)||! /^[a-z0-9][a-z0-9_.-]*$/.test(name)
      ||owner===".."||name==="..")throw new Error("Unsafe physical repository identity");
    const path=join(directory,owner,`${name}.git`);
    for(const part of [join(directory,owner),path]){
      const stat=lstatSync(part);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("Repository path is not a real directory");
    }
    const resolved=realpathSync(path),inside=relative(directory,resolved);
    if(!inside||inside===".."||inside.startsWith(`..${sep}`))throw new Error("Repository path escaped its configured root");
    return {path:resolved,repo};
  };
  const git=(path,args)=>execFileSync("git",["-c",`safe.directory=${path}`,`--git-dir=${path}`,...args],
    {encoding:"utf8",stdio:["ignore","pipe","pipe"],env:{...process.env,GIT_OPTIONAL_LOCKS:"0"},maxBuffer:4*1024*1024}).trimEnd();
  return Object.freeze({
    resolveRef(slug,ref){
      if(!/^[a-f0-9]{40}$/.test(ref))throw new Error("Expected an exact source commit");
      const {path}=repoPath(slug),sha=git(path,["rev-parse","--verify",`${ref}^{commit}`]);
      git(path,["cat-file","-e",`${sha}:game.yaml`]);return sha;
    },
    releaseTagInfo(slug,tag){
      if(!/^v[0-9][0-9A-Za-z._-]{0,31}$/.test(tag))throw new Error("Invalid release tag");
      const {path,repo}=repoPath(slug),ref=`refs/tags/${tag}`;
      try{git(path,["show-ref","--verify","--quiet",ref]);}
      catch(error){if(error.status===1)return null;throw error;}
      return {tag,target:git(path,["rev-parse",`${ref}^{commit}`]),tagObject:git(path,["rev-parse",ref]),
        annotated:git(path,["cat-file","-t",ref])==="tag",
        protected:protections.some(rule=>String(rule.repo_id)===String(repo.id)&&rule.name_pattern==="v*"),
        message:git(path,["for-each-ref","--format=%(contents)",ref])};
    },
  });
}
