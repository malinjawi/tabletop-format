import {parentPort,workerData} from "node:worker_threads";
import {createReleaseVault} from "./release-vault.mjs";
try{
  const {root,action,input}=workerData;
  if(!["readRelease","publishNativeRelease","publicationRecovery"].includes(action))throw new Error("Unsupported vault operation");
  if(action==="publicationRecovery"){
    const {runPublicationAudit}=await import("../tools/publication-audit.mjs");
    const report=await runPublicationAudit(input.env),vault=createReleaseVault({root});
    const items=report.publications.filter(item=>item.slug===input.slug&&item.classification!=="healthy").map(item=>{
      let preserved;try{preserved=vault.readManifest({slug:item.slug,tag:item.tag});}catch{}
      const publication=preserved?.manifest.publication;
      return {tag:item.tag,source_sha:item.source_sha,classification:item.classification,
        findings:item.findings.map(finding=>finding.code),title:publication?.release.title||"",
        manifest_sha256:preserved?.manifestSha256||null,
        can_resume:item.classification==="recoverable"&&publication?.release.author_id===input.actorId};
    });
    const projectStorageIssue=report.vault.corruption.some(issue=>issue.path.startsWith(`manifests/${input.slug}/`)
      ||[".","root","manifests","blobs","blobs/sha256","staging"].includes(issue.path));
    parentPort.postMessage({result:{items,storage_attention:report.vault.staging.length>0,project_storage_issue:projectStorageIssue,
      observation:"Live observation. A publication still in progress may appear here; reopening this page rechecks its state."}});
  }else parentPort.postMessage({result:createReleaseVault({root})[action](input)});
}catch(error){parentPort.postMessage({error:{code:String(error.code||"VAULT_OPERATION_FAILED"),message:String(error.message).slice(0,2000)}});}
