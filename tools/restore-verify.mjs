#!/usr/bin/env node
/**
 * Verify a restored Forge installation from the user-facing boundary.
 * The source journey has already populated Store 1 (Forgejo), Store 2
 * (PostgreSQL), and the durable release vault. Store 3 starts empty; exact
 * published bytes must come from the independently restored vault.
 */
import { createHash } from "node:crypto";

const BASE=(process.argv[2]||"").replace(/\/$/,"");
const EXPECTED_REPOSITORY_ORIGIN=String(process.env.FORGE_EXPECTED_REPOSITORY_ORIGIN||"").replace(/\/$/,"");
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE)){
  console.error("usage: node tools/restore-verify.mjs http://127.0.0.1:<disposable-port>");
  process.exit(2);
}
if(process.env.FORGE_RESTORE_CACHE_WAS_EMPTY!=="1"){
  console.error("restore verification requires the caller to prove Store 3 began empty");
  process.exit(2);
}
let checks=0;
const pass=message=>console.log(`  ✓ ${String(++checks).padStart(2,"0")}  ${message}`);
const assert=(condition,message,detail)=>{
  if(!condition){console.error(`  ✗ ${message}`,detail??"");process.exit(1);}
  pass(message);
};
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
const request=async(method,path,{token,body,rawResponse=false}={})=>{
  const response=await fetch(BASE+path,{method,headers:{
    ...(token?{authorization:`Bearer ${token}`}:{ }),
    ...(body?{"content-type":"application/json"}:{ }),
  },body:body?JSON.stringify(body):undefined});
  const type=response.headers.get("content-type")||"";
  const data=!rawResponse&&type.includes("json")?await response.json():Buffer.from(await response.arrayBuffer());
  return {response,data};
};

const health=await request("GET","/healthz");
assert(health.response.ok&&health.data.ok,"restored gateway, PostgreSQL, and Forgejo report healthy",health.data);

const aliceLogin=await request("POST","/api/auth/login",{body:{handle:"alice",password:"correct-horse-1"}});
const bobLogin=await request("POST","/api/auth/login",{body:{handle:"bob",password:"correct-horse-2"}});
assert(aliceLogin.response.status===200&&aliceLogin.data.token,"Alice can authenticate from restored identity state");
assert(bobLogin.response.status===200&&bobLogin.data.token,"Bob can authenticate from restored identity state");
const A=aliceLogin.data.token,B=bobLogin.data.token;
const restoredAlice=(await request("GET","/api/me",{token:A})).data;
const restoredBob=(await request("GET","/api/me",{token:B})).data;
assert(restoredAlice.policy_acceptances?.length===1&&restoredBob.policy_acceptances?.length===1
  &&restoredAlice.policy_acceptances[0].policy_set_id===health.data.policy_set
  &&restoredBob.policy_acceptances[0].policy_set_id===health.data.policy_set
  &&restoredAlice.policy_acceptances[0].method==="clickwrap"
  &&/^[a-f0-9]{64}$/.test(restoredAlice.policy_acceptances[0].terms_sha256||""),
  "exact account-policy receipts survived PostgreSQL backup and restore",
  {alice:restoredAlice.policy_acceptances,bob:restoredBob.policy_acceptances});
const restoredExport=await request("GET","/api/me/export",{token:A});
const restoredExportText=JSON.stringify(restoredExport.data);
assert(restoredExport.response.ok
  &&restoredExport.response.headers.get("cache-control")?.includes("no-store")
  &&restoredExport.data.account?.email==="alice@tidepool.games"
  &&restoredExport.data.policy_acceptances?.[0]?.policy_set_id===health.data.policy_set
  &&restoredExport.data.authored_proposals?.length===0
  &&!/pass_hash|token_hash|\"token\"|\"base\"|\"proposed\"/.test(restoredExportText),
  "allowlisted participant data export survived restore without credential or repository snapshots");

const catalog=(await request("GET","/api/games")).data;
const original=catalog.find(game=>game.slug==="tidepool");
const fork=catalog.find(game=>game.slug==="tidepool-bob");
assert(original?.owner_handle==="alice"&&original.stars===1,"original ownership and star count survived");
assert(fork?.owner_handle==="bob"&&fork.forked_from==="tidepool","fork ownership and lineage survived");
const projectView=(await request("GET","/api/games/tidepool/ui")).data;
assert(!EXPECTED_REPOSITORY_ORIGIN || projectView.repository?.clone_url===`${EXPECTED_REPOSITORY_ORIGIN}/alice/tidepool.git`,
  "restored project exposes its real standard Git remote, not a placeholder",projectView.repository);

const cards=(await request("GET","/api/games/tidepool/cards")).data;
assert(cards.find(card=>card.id==="riptide")?.attributes?.cost===4,"Alice's semantic card edit survived in Git");
assert(/copy any current in play/i.test(cards.find(card=>card.id==="moon_jelly")?.text||""),
  "Bob's merged proposal survived in the original game");
const history=(await request("GET","/api/games/tidepool/history")).data;
assert(history.some(commit=>commit.author==="bob"),"Git history still credits Bob for accepted work");

const asset=await request("GET","/api/games/tidepool/assets/art/riptide.png",{token:A});
assert(asset.response.ok&&Buffer.isBuffer(asset.data)&&asset.data.length>200,
  "LFS-backed artwork materializes after restore",{
    status:asset.response.status,
    type:asset.response.headers.get("content-type"),
    body:Buffer.isBuffer(asset.data)?asset.data.toString("utf8",0,300):asset.data,
  });

const prs=(await request("GET","/api/games/tidepool/prs",{token:A})).data;
assert(prs.length===1&&prs[0].status==="merged"&&prs[0].author_handle==="bob",
  "merged proposal record survived PostgreSQL restore",prs);
const proposal=(await request("GET",`/api/games/tidepool/prs/${prs[0].id}`,{token:A})).data;
assert(proposal.reviews?.some(review=>review.reviewer_handle==="alice"&&review.verdict==="approve"),
  "maintainer approval survived with the proposal");

const issues=(await request("GET","/api/games/tidepool/issues",{token:B})).data;
assert(issues.length===1&&issues[0].status==="closed"&&issues[0].comment_count===1,
  "issue, discussion, and closure state survived");

const releases=(await request("GET","/api/games/tidepool/releases")).data;
assert(releases.length===1&&releases[0].tag==="v0.1"&&releases[0].rights?.publishable
  &&releases[0].vault?.durable===true&&releases[0].vault?.format_version===2
  &&releases[0].vault?.binding==="tag-manifest"
  &&/^[a-f0-9]{64}$/.test(releases[0].vault?.manifest_sha256||"")
  &&Number.isSafeInteger(releases[0].vault?.sealed_at),
  "rights-gated native release and sealed publication binding survived",releases);
const release=(await request("GET","/api/games/tidepool/releases/v0.1")).data;
assert(release.repository_tag?.verified_now===true,"release tag re-verifies against restored Git truth");
assert(release.build?.format==="forge-release-build"&&release.build?.public_origin
  &&release.vault?.durable===true&&release.vault?.format_version===2
  &&release.vault?.binding==="tag-manifest"
  &&release.vault?.manifest_sha256===releases[0].vault.manifest_sha256
  &&release.author==="alice"
  &&release.title==="First cut"
  &&release.downloads?.ttc?.startsWith("/cache/releases/tidepool/v0.1/"),
  "release retains its sealed publisher metadata, build provenance, and tag-addressed vault",release);
assert(release.print_deliveries?.length===1
  &&release.print_deliveries[0].status==="approved"
  &&release.print_deliveries[0].release.sha===release.sha
  &&/^(?:v[1-9][0-9]*-)?print-ready\.zip$/.test(release.print_deliveries[0].artifact.name)
  &&release.print_deliveries[0].decision.evidence_sha256==="2".repeat(64)
  &&release.print_deliveries[0].trust.independently_verified===false,
  "exact printer delivery and immutable approval evidence survived PostgreSQL restore",
  release.print_deliveries);

const verifiedArtifacts=[];
const verifyArtifact=async(name,label=name)=>{
  const expected=release.artifacts.find(item=>item.name===name&&item.status==="ready");
  assert(!!expected,`${label} remains declared in the frozen release`);
  const artifactPath=name.split("/").map(encodeURIComponent).join("/");
  const result=await request("GET",`/cache/releases/tidepool/v0.1/${artifactPath}`,{rawResponse:true});
  assert(result.response.ok&&result.response.headers.get("cache-control")==="public, no-cache, must-revalidate",
    `${label} is served from the restored vault with visibility revalidation`);
  const actual={bytes:Buffer.isBuffer(result.data)?result.data.length:-1,
    sha256:Buffer.isBuffer(result.data)?sha256(result.data):null};
  assert(Buffer.isBuffer(result.data)&&actual.bytes===expected.bytes&&actual.sha256===expected.sha256,
    `${label} bytes match the pre-backup release receipt exactly`,{expected,actual,status:result.response.status});
  verifiedArtifacts.push({name,...actual});
};
const projectName=release.artifacts.find(item=>item.name.endsWith(".forge-project.zip"))?.name;
assert(release.artifacts.some(item=>item.name==="tidepool-ttc.zip")&&projectName
  &&release.artifacts.some(item=>item.name==="forge-rights-receipt.json"),
  "release still declares its playable pack, portable source, and rights receipt");
assert(!release.artifacts.some(item=>item.name?.startsWith(".complete-")||item.name==="forge-export-manifest.json"),
  "internal worker markers are not exposed as release downloads");
for(const artifact of release.artifacts.filter(item=>item.status==="ready"))
  await verifyArtifact(artifact.name);

const meAlice=(await request("GET","/api/me",{token:A})).data;
const meBob=(await request("GET","/api/me",{token:B})).data;
assert(meAlice.games.includes("tidepool")&&meBob.games.includes("tidepool-bob")
  &&meBob.starred.includes("tidepool"),"restored per-user views agree with ownership and social state",
  {alice:meAlice,bob:meBob});

console.log(`\nRESTORE VERIFIED — ${checks} checks, exact released artifacts recovered from the durable vault with Store 3 empty.`);

// Public disposable fixture evidence only: no session tokens or user records.
console.log("FORGE_RESTORE_ARTIFACT_RECEIPT "+JSON.stringify({
  format:"forge-restore-artifact-receipt",version:1,game:"tidepool",tag:release.tag,
  source_sha:release.sha,manifest_sha256:release.vault.manifest_sha256,
  artifacts:verifiedArtifacts,
}));
