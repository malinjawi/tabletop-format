#!/usr/bin/env node
/**
 * journey.mjs — THE SYSTEM CONFIRMATION. One continuous two-user story with
 * real data, asserting correct data transfer, metadata, auth, and ownership
 * across ALL THREE STORES at every hop. This is what "working" means:
 *
 *   ALICE hosts a brand-new game from her CSV → owns it → uploads art (LFS)
 *   → edits a card → exports to the immutable cache — every commit AUTHORED
 *   AS ALICE. BOB arrives → sees her game (with owner) → stars it → forks it
 *   → edits HIS fork — authored as Bob — while Alice's original is proven
 *   byte-for-byte untouched, and every ledger (git, SQL, cache) agrees.
 *
 * Run via journey.sh (sets up scratch repo + LFS mock + server).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:8420";
const SHARED_INVITE = process.env.FORGE_JOURNEY_INVITE_CODE || undefined;
const INVITES = {
  alice: process.env.FORGE_JOURNEY_INVITE_ALICE || SHARED_INVITE,
  bob: process.env.FORGE_JOURNEY_INVITE_BOB || SHARED_INVITE,
  charlie: process.env.FORGE_JOURNEY_INVITE_CHARLIE || SHARED_INVITE,
};
let step = 0, failed = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2)}  ${msg}`);
const die = (msg, detail) => { console.error(`  ✗ FAIL @${step + 1}: ${msg}`, detail ?? ""); process.exit(1); };
const assert = (cond, msg, detail) => cond ? ok(msg) : die(msg, detail);
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

/* ---- the LEDGER: where commits actually live. Local mode reads the scratch
 * repo with git; forge mode (FORGE_URL set) asks the forge's API — the SAME
 * assertions then confirm the PRODUCTION Store-1 backend. ---- */
const FORGE = process.env.FORGE_URL
  ? { url: process.env.FORGE_URL.replace(/\/$/, ""), token: process.env.FORGE_TOKEN } : null;
const OWNERS = { "tidepool": "alice", "tidepool-bob": "bob" };
const fapi = async (p) => fetch(`${FORGE.url}/api/v1${p}`, { headers: { Authorization: `token ${FORGE.token}` } });
const lastCommit = async (slug) => {
  if (!FORGE) { const [an, ae, ...s] = git("log", "-1", "--format=%an|%ae|%s").split("|");
                return { an, ae, s: s.join("|") }; }
  const r = await fapi(`/repos/${OWNERS[slug]}/${slug}/commits?limit=1&stat=false&verification=false&files=false`);
  const c = (await r.json())[0];
  return { an: c.commit.author.name, ae: c.commit.author.email, s: c.commit.message.split("\n")[0] };
};
const repoRead = async (slug, rel) => {
  if (!FORGE) return readFileSync(`examples/${slug}/${rel}`, "utf8");
  const r = await fapi(`/repos/${OWNERS[slug]}/${slug}/raw/${rel}?ref=main`);
  return r.ok ? await r.text() : null;
};
const releaseTag = async (slug, tag) => {
  if (!FORGE) {
    const ref = `refs/tags/forge/${slug}/${tag}`;
    return { annotated: git("cat-file", "-t", ref) === "tag",
      object: git("rev-parse", ref), target: git("rev-parse", `${ref}^{}`) };
  }
  const listed = await fapi(`/repos/${OWNERS[slug]}/${slug}/tags/${tag}`), value = await listed.json();
  const annotated = await fapi(`/repos/${OWNERS[slug]}/${slug}/git/tags/${value.id}`), object = await annotated.json();
  return { annotated: annotated.ok, object: value.id, target: object.object?.sha };
};
const api = async (method, path, { token, body, raw } = {}) => {
  const r = await fetch(BASE + path, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
               ...(body && !raw ? { "content-type": "application/json" } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const ct = r.headers.get("content-type") ?? "";
  return { status: r.status, headers: r.headers,
           data: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};

const ALICE_CSV = `name,type,text,cost,pull,deck_limit
Riptide,current,"Pull 2. If you're leading, pull 3.",3,2,2
Hermit Crab,dweller,"Shelters: ignore the next current.",1,0,3
Moon Jelly,dweller,"Drifts: copy the last current played.",2,1,2
Anchor,relic,"Your dwellers can't be pulled this tide.",2,0,1
Spring Tide,current,"Everyone pulls 1. You pull 2.",4,2,1
Tidepool Guide,dweller,"Peek at the top 3 tide cards.",1,0,2`;

// a minimal valid PNG (1x1) padded past pointer-size heuristics
const PNG = Buffer.concat([Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"), Buffer.alloc(300, 0)]);

console.log("== ACT 1: Alice hosts a game ==");
const aliceReg = await api("POST", "/api/auth/register",
  { body: { handle: "alice", email: "alice@tidepool.games", password: "correct-horse-1", invite_code: INVITES.alice } });
assert(aliceReg.status === 201 && aliceReg.data.token, "alice registers");
const A = aliceReg.data.token;

const created = await api("POST", "/api/games", { token: A, body: { title: "Tidepool", csv: ALICE_CSV } });
assert(created.status === 201 && created.data.slug === "tidepool" && created.data.cards === 6,
  "POST /api/games → 'tidepool' hosted: 6 cards from her CSV", created.data);
assert(created.data.owner === "alice", "ownership recorded at creation");
{ const c = await lastCommit("tidepool");
  assert(c.an === "alice" && c.ae === "alice@tidepool.games", "creation commit AUTHORED AS ALICE (git ledger)"); }

const noAuth = await api("POST", "/api/games", { body: { title: "Sneaky" } });
assert(noAuth.status === 401, "anonymous cannot host games (401)");

const me1 = await api("GET", "/api/me", { token: A });
assert(me1.data.games.includes("tidepool"), "/api/me lists alice's game (SQL ledger)");

console.log("== ACT 2: Alice works on it ==");
const art = await api("POST", "/api/games/tidepool/assets?path=assets/art/riptide.png",
  { token: A, raw: PNG });
assert(art.status === 200 && art.data.mode === "lfs" && art.data.oid,
  "art uploaded via LFS batch → pointer committed", art.data);
assert((await repoRead("tidepool", "assets/art/riptide.png")).startsWith("version https://git-lfs"),
  "git holds the 3-line pointer, not the binary (Store 1)");
assert(/alice/.test((await lastCommit("tidepool")).an), "asset commit authored as alice");

const artBack = await api("GET", "/api/games/tidepool/assets/art/riptide.png", { token: A });
assert(artBack.status === 200 && Buffer.compare(artBack.data, PNG) === 0,
  "GET asset materializes from LFS — bytes identical round-trip");
const artAssign = await api("PUT", "/api/games/tidepool/art", { token: A,
  body: { printing_id: "p_riptide_core", art: "assets/art/riptide.png", artist: "Alice",
    license: "CC-BY-4.0", rights_status: "original", redistribution: "allowed" } });
assert(artAssign.status === 200 && artAssign.data.art === "assets/art/riptide.png",
  "alice assigns the uploaded art to the riptide printing with credit", artAssign.data);
const pj = JSON.parse(await repoRead("tidepool", "components/printings.json"));
const rp = pj.find(p => p.id === "p_riptide_core");
assert(rp && rp.art === "assets/art/riptide.png" && rp.provenance && rp.provenance.creator === "Alice",
  "the printing carries the art + provenance — credit follows the work (SPEC §9)");

const cards = (await api("GET", "/api/games/tidepool/cards")).data;
cards.find(c => c.id === "riptide").attributes.cost = 4;
const edit = await api("PUT", "/api/games/tidepool/cards", { token: A, body: cards });
assert(edit.status === 200 && edit.data.saved && /Riptide/.test(edit.data.message),
  `edit committed: "${edit.data.message}"`);
assert(/alice/.test((await lastCommit("tidepool")).an), "edit commit authored as alice (not 'web editor')");

const hist = (await api("GET", "/api/games/tidepool/history")).data;
assert(hist[0].author === "alice" && hist[0].changes.some(c => c.card === "riptide"),
  "history endpoint: alice's semantic change on record");

const exp = await api("POST", "/api/games/tidepool/export/tts?wait=1", { token: A });
assert(exp.status === 200 && exp.data.urls[0].includes(exp.data.ref)
  && exp.data.job?.status === "succeeded" && exp.data.manifest?.files?.length > 0,
  `isolated export job succeeded and froze sha ${exp.data.ref} with a checked manifest (Store 3)`);
const cached = await api("GET", exp.data.urls[0]);
assert(cached.status === 200 && cached.headers.get("cache-control").includes("immutable"),
  "cache URL serves with immutable headers");
const tts = Buffer.isBuffer(cached.data) ? JSON.parse(cached.data.toString()) : cached.data;
assert(tts.ObjectStates[0].DeckIDs.length === 6 && tts.SaveName === "Tidepool",
  "cached TTS save is HER game: 6 cards, correct name");

console.log("== ACT 3: Bob arrives ==");
const bobReg = await api("POST", "/api/auth/register",
  { body: { handle: "bob", email: "bob@example.com", password: "correct-horse-2", invite_code: INVITES.bob } });
const B = bobReg.data.token;
assert(bobReg.status === 201, "bob registers");

const listing = (await api("GET", "/api/games")).data;
const tp = listing.find(g => g.slug === "tidepool");
assert(tp && tp.owner_handle === "alice" && tp.cards === 6,
  "bob sees tidepool in the catalog, owner visible (SQL index)");

const star = await api("PUT", "/api/stars/tidepool", { token: B });
assert(star.status === 200 && star.data.stars === 1, "bob stars it → count 1");

const fork = await api("POST", "/api/games/tidepool/fork", { token: B });
assert(fork.status === 201 && fork.data.slug === "tidepool-bob" && fork.data.forked_from === "tidepool",
  "bob forks → tidepool-bob");
{ const c = await lastCommit("tidepool-bob");
  assert(c.an === "bob" && /fork: tidepool/.test(c.s), "fork commit authored by bob"); }
const forkYaml = await repoRead("tidepool-bob", "game.yaml");
assert(/attribution:/.test(forkYaml) && /source_id: tidepool/.test(forkYaml),
  "SPEC §9 attribution block committed into the fork");

console.log("== ACT 4: parallel work, no bleed ==");
const anonEdit = await api("PUT", "/api/games/tidepool/cards", { body: [] });
assert(anonEdit.status === 401, "anonymous cannot commit to ANY game (401)");
const bobEdit0 = await api("PUT", "/api/games/tidepool/cards", { token: B, body: [] });
assert(bobEdit0.status === 403 && bobEdit0.data.propose === true,
  "bob cannot commit to ALICE's game (403) — but is pointed at the PR path");
const before = await repoRead("tidepool", "components/cards.json");
const bobCards = (await api("GET", "/api/games/tidepool-bob/cards")).data;
bobCards.find(c => c.id === "moon_jelly").text = "Drifts: copy any current in play.";
const bobEdit = await api("PUT", "/api/games/tidepool-bob/cards", { token: B, body: bobCards });
assert(bobEdit.status === 200 && /Moon Jelly/.test(bobEdit.data.message), "bob edits HIS fork");
assert(/bob/.test((await lastCommit("tidepool-bob")).an), "bob's edit authored as bob");
assert(await repoRead("tidepool", "components/cards.json") === before,
  "alice's ORIGINAL byte-for-byte untouched by bob's work");
const aliceHist = (await api("GET", "/api/games/tidepool/history")).data;
assert(aliceHist.every(h => h.author !== "bob"), "no bob commits in alice's history");
const forkValid = (await api("GET", "/api/games/tidepool-bob/validate")).data;
assert(forkValid.ok, "bob's fork validates as a complete game");

console.log("== ACT 5: the remix loop closes — bob proposes, alice merges ==");
const prOpen = await api("POST", "/api/games/tidepool/prs", { token: B,
  body: { from: "tidepool-bob", title: "Moon Jelly drift buff", body: "playtested in my fork" } });
assert(prOpen.status === 201 && prOpen.data.changes.some(c => c.card === "moon_jelly"),
  "bob opens a PR back to tidepool — semantic diff names Moon Jelly", prOpen.data);
const prId = prOpen.data.id;
const noMerge = await api("POST", `/api/games/tidepool/prs/${prId}/merge`, { token: B });
assert(noMerge.status === 403, "bob CANNOT merge into alice's game (owner-only rule)");
const bobPrView = (await api("GET", `/api/games/tidepool/prs/${prId}`, { token: B })).data;
assert(bobPrView.access?.is_author && bobPrView.access.can_close && !bobPrView.access.can_review && !bobPrView.access.can_merge,
  "the proposal contract gives bob only the actions he can actually take");
const prView = (await api("GET", `/api/games/tidepool/prs/${prId}`, { token: A })).data;
assert(prView.author === "bob" && prView.status === "open" && prView.conflicts.length === 0
  && prView.mergeable === false && prView.required_approvals === 1
  && prView.access?.can_review && prView.access.can_merge && prView.access.can_close,
  "alice reviews: bob's PR is conflict-free but protected until one approval");
const bobReview = await api("POST", `/api/games/tidepool/prs/${prId}/review`, { token: B, body: { verdict: "approve" } });
assert(bobReview.status === 403, "bob can't review — he's the proposer, not a maintainer (403)");
const aliceApprove = await api("POST", `/api/games/tidepool/prs/${prId}/review`, { token: A, body: { verdict: "approve" } });
assert(aliceApprove.status === 201 && aliceApprove.data.reviews.some(r => r.verdict === "approve" && r.reviewer_handle === "alice"),
  "alice approves the PR — maintainer sign-off recorded before merge");
const approvedView = (await api("GET", `/api/games/tidepool/prs/${prId}`, { token: A })).data;
assert(approvedView.mergeable === true && approvedView.checks.find(check => check.key === "approvals")?.pass === true,
  "the repository policy now reports the exact proposal mergeable");
const prMerged = await api("POST", `/api/games/tidepool/prs/${prId}/merge`, { token: A });
assert(prMerged.status === 200 && prMerged.data.merged, "alice merges bob's PR", prMerged.data);
const tpCards = (await api("GET", "/api/games/tidepool/cards")).data;
assert(/copy any current in play/.test(tpCards.find(c => c.id === "moon_jelly").text),
  "tidepool now carries bob's change — the remix loop is CLOSED");
assert(/bob/.test((await lastCommit("tidepool")).an), "merge commit authored as BOB (credit follows the work)");
const prAfter = (await api("GET", `/api/games/tidepool/prs/${prId}`)).data;
assert(prAfter.status === "merged" && prAfter.merge_sha, "PR recorded as merged with the commit sha");

console.log("== ACT 6: the community layer — issues & discussion ==");
const iss = await api("POST", "/api/games/tidepool/issues", { token: B,
  body: { title: "Riptide swingy at 3 cost", body: "pull 3 while leading ends games early" } });
assert(iss.status === 201 && iss.data.number === 1 && iss.data.status === "open",
  "bob opens issue #1 on tidepool", iss.data);
const anonIss = await api("POST", "/api/games/tidepool/issues", { body: { title: "spam" } });
assert(anonIss.status === 401, "anonymous cannot open issues (401)");
const cmt = await api("POST", "/api/games/tidepool/issues/1/comments", { token: A,
  body: { body: "Agreed - capping the lead bonus. Thanks for flagging." } });
assert(cmt.status === 201 && cmt.data.comments.length === 1 && cmt.data.comments[0].author_handle === "alice",
  "alice replies on the thread (comment recorded, authored)");
const idet = (await api("GET", "/api/games/tidepool/issues/1")).data;
assert(idet.comments.length === 1 && idet.author === "bob" && idet.status === "open",
  "issue detail: bob's issue, alice's comment, still open");
const badClose = await api("POST", "/api/games/tidepool/issues/1/close", { token: B });
assert(badClose.status === 200 && badClose.data.status === "closed",
  "bob (issue author) closes his own issue");
const ilist = (await api("GET", "/api/games/tidepool/issues")).data;
assert(ilist.length === 1 && ilist[0].comment_count === 1 && ilist[0].status === "closed",
  "issues index: 1 issue, 1 comment, closed - conversation persisted in SQL (DA-9)");

console.log("== FINAL LEDGER CHECK: all three stores agree ==");
const finalList = (await api("GET", "/api/games")).data;
const ftp = finalList.find(g => g.slug === "tidepool");
const ffk = finalList.find(g => g.slug === "tidepool-bob");
assert(ftp.stars === 1 && !ftp.forked_from && ffk.forked_from === "tidepool" && ffk.owner_handle === "bob",
  "SQL: stars/ownership/lineage all correct");
const meA = (await api("GET", "/api/me", { token: A })).data;
const meB = (await api("GET", "/api/me", { token: B })).data;
assert(meA.games.includes("tidepool") && !meA.starred.length &&
       meB.games.includes("tidepool-bob") && meB.starred.includes("tidepool"),
  "per-user views coherent (alice owns, bob owns fork + starred original)");
const recheck = await api("GET", exp.data.urls[0]);
assert(recheck.status === 200, "alice's frozen export URL still serves after all subsequent commits");

console.log("== ACT 7: game jams — the co-creation front door (live) ==");
const jamAnon = await api("POST", "/api/jams/spark-jam/join", {});
assert(jamAnon.status === 401, "anonymous cannot join a jam (401)");
const jamJoin = await api("POST", "/api/jams/spark-jam/join", { token: A });
assert(jamJoin.status === 201 && jamJoin.data.entered && jamJoin.data.slug,
  "alice one-click joins Spark Jam → a licensed draft starter is created in her account", jamJoin.data);
const jamView = (await api("GET", "/api/jams/spark-jam")).data;
assert(jamView.status === "open" && jamView.entries.some(e => e.game_slug === jamJoin.data.slug && e.state === "draft" && e.author === "alice"),
  "the server-derived jam clock is open and her starter remains an attributed draft");
const offTheme = await api("POST", "/api/jams/spark-jam/submit", { token: B, body: { game: "tidepool-bob" } });
assert(offTheme.status === 422 && (offTheme.data.reasons || []).some(r => /theme word/.test(r)),
  "an off-theme game is refused — qualification is a machine check, not a mod ruling");

console.log("== ACT 8: the test pillar — log a playtest, read live analytics ==");
const anonPt = await api("POST", "/api/games/tidepool/playtests", { body: { players: [{ name: "x" }] } });
assert(anonPt.status === 401, "anonymous cannot log a playtest (401)");
const ptLog = await api("POST", "/api/games/tidepool/playtests", { token: A,
  body: { location: "tts", duration_minutes: 30, players: [{ name: "Alice", result: "WIN" }, { name: "Bob", result: "loss" }],
          card_notes: [{ card_id: "riptide", tag: "Balance", note: "swingy at 3 cost" }] } });
assert(ptLog.status === 201 && ptLog.data.pinned, "alice logs a playtest → validated commit, pinned to a version", ptLog.data);
const an = (await api("GET", "/api/games/tidepool/analytics")).data;
assert(an.sessions === 1 && an.table_minutes === 30 && an.results.win === 1 && an.results.loss === 1,
  "live analytics aggregate it: 1 session, 30 min, 1W/1L (result normalized server-side)");
assert(an.flagged && an.flagged.riptide, "card note flagged riptide (tag normalized)");
const bd = (await api("GET", "/api/games/tidepool/diff")).data;
assert(Array.isArray(bd.changes) && bd.from && bd.to && bd.from !== bd.to, "balance-diff compares two versions of the cards (from/to pinned)");

console.log("== ACT 9: releases — cut a citable, immutable version ==");
const releaseReady = await api("GET", "/api/games/tidepool/releases/preflight", { token: A });
assert(releaseReady.status === 200 && releaseReady.data.ready && releaseReady.data.access.can_release
  && releaseReady.data.checks.every(check => check.pass),
  "release preflight tells alice this exact version is ready before render work starts");
const releaseBob = await api("GET", "/api/games/tidepool/releases/preflight", { token: B });
assert(releaseBob.status === 200 && releaseBob.data.candidate_ready && !releaseBob.data.ready
  && !releaseBob.data.access.can_release,
  "the same preflight explains that a contributor cannot publish the owner's release");
const relBad = await api("POST", "/api/games/tidepool/releases", { token: A, body: { tag: "not a tag!" } });
assert(relBad.status === 422, "a malformed tag is rejected (422)");
const relBob = await api("POST", "/api/games/tidepool/releases", { token: B, body: { tag: "v0.1" } });
assert(relBob.status === 403, "only the owner can cut a release (403)");
const unknownAsset = await api("POST", "/api/games/tidepool/assets?path=assets/art/unclassified.png", { token: A, raw: PNG });
assert(unknownAsset.status === 200 && unknownAsset.data.rights_status === "unknown",
  "an upload without a rights declaration is committed as private-only/unknown");
const releaseBlockedPreview = await api("GET", "/api/games/tidepool/releases/preflight", { token: A });
assert(releaseBlockedPreview.status === 200 && !releaseBlockedPreview.data.ready
  && releaseBlockedPreview.data.rights.blockers.some(value => /unclassified/.test(value)),
  "release preflight names the exact file that needs a declaration");
const rightsBlocked = await api("POST", "/api/games/tidepool/releases", { token: A, body: { tag: "v0.1" } });
assert(rightsBlocked.status === 422 && rightsBlocked.data.rights?.blockers?.some(value => /unclassified/.test(value)),
  "unknown file rights block release before exports or a Git tag are created");
const incompleteRights = await api("PUT", "/api/games/tidepool/rights", { token: A, body: {
  path: "assets/art/unclassified.png", status: "licensed", license: "CC-BY-4.0",
  copyright: ["Someone Else"], redistribution: "allowed" } });
assert(incompleteRights.status === 422 && /source or permission/.test(incompleteRights.data.error),
  "a licensed-file claim cannot omit its source or permission record");
const declareRights = await api("PUT", "/api/games/tidepool/rights", { token: A, body: {
  path: "assets/art/unclassified.png", status: "original", license: "CC-BY-4.0",
  copyright: ["Alice"], redistribution: "allowed" } });
assert(declareRights.status === 200 && declareRights.data.rights.publishable,
  "the owner records an auditable per-file declaration and clears the gate");
const releaseReadyAgain = await api("GET", "/api/games/tidepool/releases/preflight", { token: A });
assert(releaseReadyAgain.status === 200 && releaseReadyAgain.data.ready,
  "release readiness turns green immediately after the rights commit");
const rel = await api("POST", "/api/games/tidepool/releases", { token: A, body: { tag: "v0.1", title: "First cut" } });
assert(rel.status === 201 && rel.data.sha && String(rel.data.notes || "").startsWith("- ")
  && rel.data.repository_tag?.annotated && rel.data.repository_tag?.protected
  && rel.data.artifacts?.some(item => item.name === "forge-rights-receipt.json")
  && rel.data.build?.format === "forge-release-build"
  && rel.data.build?.public_origin === BASE
  && rel.data.rights?.publishable && rel.data.rights?.source_sha === rel.data.sha,
  "alice cuts v0.1 → required artifacts, protected tag, and a per-file rights receipt", rel.data);
const actualTag = await releaseTag("tidepool", "v0.1");
assert(actualTag.annotated && actualTag.target.startsWith(rel.data.sha),
  "the release exists as a real annotated Git tag pointing at the exact source commit");
const relList = (await api("GET", "/api/games/tidepool/releases")).data;
assert(relList.length === 1 && relList[0].tag === "v0.1" && relList[0].sha === rel.data.sha
  && relList[0].tag_annotated && relList[0].tag_protected && relList[0].artifacts.length >= 6
  && relList[0].rights?.publishable && relList[0].rights?.file_count > 0
  && relList[0].build?.public_origin === BASE,
  "releases list shows the pinned version and its immutable receipt");
const relDet = (await api("GET", "/api/games/tidepool/releases/v0.1")).data;
assert(relDet.repository_tag.verified_now, "release detail re-verifies the protected annotated tag against Store 1");
assert(relDet.rights?.publishable && relDet.rights.files.some(file => file.path === "assets/art/unclassified.png"),
  "release detail preserves the exact rights and hash of every shipped source file");
const frozen = await api("GET", relDet.downloads.ttc);
assert(frozen.status === 200, "the frozen TTC download serves at the pinned sha — a citable, immutable version");
if(process.env.FORGE_ALLOW_CACHE_LOSS_TEST==="1"){
  const cacheRoot=resolve(process.env.FORGE_TEST_CACHE_DIR||"");
  if(!cacheRoot||cacheRoot==="/")die("cache-loss test requires a narrow FORGE_TEST_CACHE_DIR");
  rmSync(join(cacheRoot,"exports","tidepool",rel.data.sha),{recursive:true,force:true});
  const rebuilt=await api("GET",relDet.downloads.ttc);
  assert(rebuilt.status===200&&rebuilt.headers.get("cache-control")?.includes("immutable"),
    "losing derived Store 3 triggers an exact released-artifact rebuild from the pinned Git SHA");
}

const jamRel = await api("POST", `/api/games/${jamJoin.data.slug}/releases`, { token: A,
  body: { tag: "v0.1", title: "Spark Jam submission" } });
assert(jamRel.status === 201 && jamRel.data.sha, "a jam candidate is packaged as a rights-checked immutable release");
const jamSubmit = await api("POST", "/api/jams/spark-jam/submit", { token: A,
  body: { game: jamJoin.data.slug, release: "v0.1", team: ["alice"] } });
assert(jamSubmit.status === 201 && jamSubmit.data.release.sha === jamRel.data.sha && jamSubmit.data.receipt.sha256,
  "jam submission pins the reviewed release and returns an immutable qualification receipt");
const jamDraftCards = (await api("GET", `/api/games/${jamJoin.data.slug}/cards`)).data;
jamDraftCards[0].text += " Later draft edit.";
const jamLater = await api("PUT", `/api/games/${jamJoin.data.slug}/cards`, { token: A, body: jamDraftCards });
const pinnedEntry = (await api("GET", "/api/jams/spark-jam")).data.entries.find(e => e.game_slug === jamJoin.data.slug);
assert(jamLater.status === 200 && pinnedEntry.release.sha === jamRel.data.sha && jamLater.data.commit !== jamRel.data.sha,
  "later project edits cannot move the submitted jam release");
const jamHistory = await api("GET", `/api/jams/spark-jam/entries/${jamJoin.data.slug}/history`, { token: A });
assert(jamHistory.status === 200 && jamHistory.data.length === 1 && jamHistory.data[0].release_sha === jamRel.data.sha,
  "submission history preserves the exact release selection independently of mutable HEAD");

console.log("== ACT 10: discovery & the activity feed — the front door ==");
const disc = (await api("GET", "/api/discover?q=tidepool")).data;
assert(Array.isArray(disc) && disc.some(x => x.slug === "tidepool"), "discover/search finds tidepool by text");
const feed = (await api("GET", "/api/activity")).data;
assert(feed.length >= 3 && feed[0].actor_handle && feed.some(e => e.kind === "release") && feed.some(e => e.kind === "pr_merge"),
  "activity feed records the story — release, merge, fork… newest first, attributed");
const aliceFeed = (await api("GET", "/api/activity?user=alice")).data;
assert(aliceFeed.length >= 1 && aliceFeed.every(e => e.actor_handle === "alice"), "personal feed ?user=alice filters to her activity");

console.log("== ACT 11: notifications — your inbox ==");
const anonN = await api("GET", "/api/notifications");
assert(anonN.status === 401, "notifications require auth (401)");
const aliceN = (await api("GET", "/api/notifications", { token: A })).data;
assert(aliceN.items.some(n => n.kind === "fork" && n.actor_handle === "bob"), "alice was notified that bob forked her game");
const bobN = (await api("GET", "/api/notifications", { token: B })).data;
assert(bobN.items.some(n => n.kind === "pr_merge" && n.actor_handle === "alice") && bobN.unread >= 1,
  "bob was notified that alice merged his PR (unread inbox)");
assert((await api("POST", "/api/notifications/read", { token: B })).status === 200, "bob marks all read");
assert((await api("GET", "/api/notifications", { token: B })).data.unread === 0, "bob's unread count is now zero");

console.log("== ACT 12: namespaced repository identity ==");
const charlieReg = await api("POST", "/api/auth/register",
  { body: { handle: "charlie", email: "charlie@tidepool.games", password: "correct-horse-3", invite_code: INVITES.charlie } });
assert(charlieReg.status === 201 && charlieReg.data.token, "charlie registers");
const sameName = await api("POST", "/api/games", { token: charlieReg.data.token,
  body: { title: "Tidepool", csv: ALICE_CSV } });
assert(sameName.status === 201 && sameName.data.slug !== "tidepool"
  && sameName.data.namespace === "charlie" && sameName.data.repo_slug === "tidepool"
  && /^p_[a-f0-9]{16}$/.test(sameName.data.project_id),
  "a second owner can host the same repository slug under a distinct stable project id", sameName.data);
const aliceProject = await api("GET", "/api/projects/alice/tidepool");
const charlieProject = await api("GET", "/api/projects/charlie/tidepool");
assert(aliceProject.status === 200 && charlieProject.status === 200
  && aliceProject.data.project_id !== charlieProject.data.project_id
  && aliceProject.data.storage_key !== charlieProject.data.storage_key,
  "owner/slug routes resolve unambiguously to two different repositories");

console.log(`\nJOURNEY COMPLETE — ${step} assertions, 0 failures.`);
console.log("The system is confirmed: host → own → author → fork → isolate → propose → merge → agree.");
