#!/usr/bin/env node
/**
 * store2-conformance.mjs — the SAME operation script against whichever Store-2
 * driver is selected, asserting identical observable semantics. This is what
 * "the Postgres swap is a driver change, not a behavior change" means as code.
 *
 *   node tools/store2-conformance.mjs                     # dev driver (node:sqlite, :memory:)
 *   DB=postgres PG_URL=postgres://… node tools/store2-conformance.mjs
 */
const PG = process.env.DB === "postgres";
import { createHash } from "node:crypto";
import { makePolicySet, validPolicySet } from "../platform/policy-acceptance.mjs";
import { assertPersonalDataSafe } from "../platform/personal-data.mjs";
const { openDb, q, newId } = PG
  ? await import("../platform/db-pg.mjs")
  : await import("../platform/db.mjs");

let step = 0;
const ok = (m) => console.log(`  ✓ ${String(++step).padStart(2)}  ${m}`);
const die = (m, d) => { console.error(`  ✗ FAIL @${step + 1}: ${m}`, d ?? ""); process.exit(1); };
const assert = (c, m, d) => c ? ok(m) : die(m, d);

const db = await openDb(PG ? undefined : ":memory:");
const T = Date.now(); // unique-ify for reruns against a persistent pg
const h = (s) => `${s}-${T % 100000}`;
const policySet = makePolicySet({ terms: "Test terms v1", privacy: "Test privacy v1",
  community: "Test community rules v1" });
const acceptance = () => ({ id: newId("pa"), policy_set: policySet, application_build: `test-${T}` });
assert(validPolicySet(makePolicySet({ terms: "Historic terms", privacy: "Historic privacy",
  community: "Historic community", notice: "Historic registration notice." })),
  "stored policy integrity does not depend on the notice text in the current application build");

// users
const ana = { id: newId("u"), handle: h("ana"), email: `${h("ana")}@x.io`, pass_hash: "hash1" };
await q.createUser(db, ana);
assert((await q.userByHandle(db, ana.handle)).email === ana.email, "createUser → userByHandle roundtrip");
let duped = false;
try { await q.createUser(db, { ...ana, id: newId("u") }); } catch { duped = true; }
assert(duped, "duplicate handle throws (unique constraint, both engines)");
assert((await q.userByEmail(db, ana.email)).id === ana.id, "userByEmail");

// controlled-beta invitations (019) — bearer secrets stay hashed, expire,
// revoke independently, and are consumed atomically with account creation.
const digest = value => createHash("sha256").update(value).digest("hex");
const inviteAt = T + 1000;
const invite = { id: newId("inv"), token_hash: digest(`valid:${T}`), label: "Pilot Ana",
  cohort_id: h("beta"), created_at: inviteAt, expires_at: inviteAt + 60_000 };
await q.createPilotInvite(db, invite);
let invitations = await q.pilotInvites(db, inviteAt);
assert(invitations.some(row => row.id === invite.id && row.status === "available"
  && !("token_hash" in row)), "pilot invite listing is available and never exposes its token digest");
const invited = { id: newId("u"), handle: h("invited"), email: `${h("invited")}@x.io`, pass_hash: "invite-hash" };
const redemption = await q.registerUserWithInvite(db, invited, invite.token_hash, acceptance(), inviteAt + 1);
assert(redemption.id === invite.id && (await q.userById(db, invited.id)).handle === invited.handle,
  "valid pilot invite atomically creates its account");
invitations = await q.pilotInvites(db, inviteAt + 2);
assert(invitations.find(row => row.id === invite.id)?.status === "redeemed"
  && invitations.find(row => row.id === invite.id)?.redeemed_handle === invited.handle,
  "redeemed invitation records the account without retaining its raw token");
const invitedPolicies = await q.policyAcceptancesByUser(db, invited.id);
assert(invitedPolicies.length === 1 && invitedPolicies[0].policy_set_id === policySet.id
  && invitedPolicies[0].method === "clickwrap" && invitedPolicies[0].application_build === `test-${T}`,
  "invited account atomically records the exact policy set and acceptance method");
const invitedEvidence = await q.policyAcceptanceEvidenceByUser(db, invited.id);
assert(invitedEvidence.length === 1 && validPolicySet({ id: invitedEvidence[0].policy_set_id,
  terms_text: invitedEvidence[0].terms_text, privacy_text: invitedEvidence[0].privacy_text,
  community_text: invitedEvidence[0].community_text, notice_text: invitedEvidence[0].notice_text,
  terms_sha256: invitedEvidence[0].terms_sha256, privacy_sha256: invitedEvidence[0].privacy_sha256,
  community_sha256: invitedEvidence[0].community_sha256, notice_sha256: invitedEvidence[0].notice_sha256 }),
  "operator evidence surface can cryptographically verify the stored policy snapshot");
const invitedExport = assertPersonalDataSafe(await q.personalDataExport(db, invited.id));
assert(invitedExport.account.handle === invited.handle && invitedExport.invitation.length === 1
  && invitedExport.policy_acceptances[0].policy_set_id === policySet.id,
  "participant export includes admission and exact policy evidence without bearer secrets");
let replayed = false;
try {
  await q.registerUserWithInvite(db,
    { id: newId("u"), handle: h("replay"), email: `${h("replay")}@x.io`, pass_hash: "hash" },
    invite.token_hash, acceptance(), inviteAt + 3);
} catch (error) { replayed = error?.code === "FORGE_INVITE_INVALID"; }
assert(replayed && !(await q.userByHandle(db, h("replay"))), "an invite cannot be replayed and creates no partial account");
const expired = { id: newId("inv"), token_hash: digest(`expired:${T}`), label: null, cohort_id: h("beta"),
  created_at: inviteAt - 20, expires_at: inviteAt - 10 };
await q.createPilotInvite(db, expired);
let expiryRejected = false;
try {
  await q.registerUserWithInvite(db,
    { id: newId("u"), handle: h("expired"), email: `${h("expired")}@x.io`, pass_hash: "hash" },
    expired.token_hash, acceptance(), inviteAt);
} catch (error) { expiryRejected = error?.code === "FORGE_INVITE_INVALID"; }
assert(expiryRejected && (await q.pilotInvites(db, inviteAt)).find(row => row.id === expired.id)?.status === "expired",
  "expired invite is rejected and reported as expired");
const revoked = { id: newId("inv"), token_hash: digest(`revoked:${T}`), label: null, cohort_id: h("beta"),
  created_at: inviteAt, expires_at: inviteAt + 60_000 };
await q.createPilotInvite(db, revoked);
await q.revokePilotInvite(db, revoked.id, inviteAt + 1);
let revocationRejected = false;
try {
  await q.registerUserWithInvite(db,
    { id: newId("u"), handle: h("revoked"), email: `${h("revoked")}@x.io`, pass_hash: "hash" },
    revoked.token_hash, acceptance(), inviteAt + 2);
} catch (error) { revocationRejected = error?.code === "FORGE_INVITE_INVALID"; }
assert(revocationRejected && (await q.pilotInvites(db, inviteAt + 2)).find(row => row.id === revoked.id)?.status === "revoked",
  "revoked invite is rejected and reported as revoked");
const raced = { id: newId("inv"), token_hash: digest(`race:${T}`), label: null, cohort_id: h("beta"),
  created_at: inviteAt, expires_at: inviteAt + 60_000 };
await q.createPilotInvite(db, raced);
const racers = [1, 2].map(number => ({ id: newId("u"), handle: h(`racer${number}`),
  email: `${h(`racer${number}`)}@x.io`, pass_hash: "hash" }));
const raceResults = await Promise.allSettled(racers.map(user =>
  Promise.resolve().then(() => q.registerUserWithInvite(db, user, raced.token_hash, acceptance(), inviteAt + 3))));
assert(raceResults.filter(result => result.status === "fulfilled").length === 1
  && raceResults.filter(result => result.status === "rejected" && result.reason?.code === "FORGE_INVITE_INVALID").length === 1
  && (await Promise.all(racers.map(user => q.userById(db, user.id)))).filter(Boolean).length === 1,
  "two simultaneous redemptions produce exactly one account");

// sessions
const tok = "t".repeat(64);
await q.createSession(db, tok, ana.id, 60_000);
assert((await q.sessionUser(db, tok))?.handle === ana.handle, "session resolves to user");
const dead = "d".repeat(64);
await q.createSession(db, dead, ana.id, -1000);
assert(!(await q.sessionUser(db, dead)), "expired session resolves to nothing");

// operator-assisted password recovery (020) — only the newest reset works,
// redemption changes the password and revokes every existing session.
const resetAt = T + 2000;
const reset1 = { id: newId("rst"), token_hash: digest(`reset-old:${T}`), user_id: ana.id,
  created_at: resetAt, expires_at: resetAt + 60_000 };
await q.issuePasswordReset(db, reset1, resetAt);
let resets = await q.passwordResets(db, resetAt + 1);
assert(resets.some(row => row.id === reset1.id && row.status === "available" && !("token_hash" in row)),
  "password-reset audit is available without exposing its token digest");
const reset2 = { id: newId("rst"), token_hash: digest(`reset-new:${T}`), user_id: ana.id,
  created_at: resetAt + 2, expires_at: resetAt + 60_000 };
await q.issuePasswordReset(db, reset2, resetAt + 2);
resets = await q.passwordResets(db, resetAt + 3);
assert(resets.find(row => row.id === reset1.id)?.status === "revoked"
  && resets.find(row => row.id === reset2.id)?.status === "available",
  "issuing a newer recovery token revokes the older outstanding token");
let oldResetRejected = false;
try { await q.resetPasswordWithToken(db, reset1.token_hash, "old-should-not-land", resetAt + 4); }
catch (error) { oldResetRejected = error?.code === "FORGE_RESET_INVALID"; }
assert(oldResetRejected && (await q.userById(db, ana.id)).pass_hash === "hash1",
  "superseded recovery token cannot change the password");
await q.resetPasswordWithToken(db, reset2.token_hash, "new-pass-hash", resetAt + 5);
assert((await q.userById(db, ana.id)).pass_hash === "new-pass-hash" && !(await q.sessionUser(db, tok)),
  "valid recovery atomically changes the password and revokes every session");
let resetReplay = false;
try { await q.resetPasswordWithToken(db, reset2.token_hash, "replay-hash", resetAt + 6); }
catch (error) { resetReplay = error?.code === "FORGE_RESET_INVALID"; }
assert(resetReplay && (await q.userById(db, ana.id)).pass_hash === "new-pass-hash",
  "recovery token cannot be replayed");
const expiredReset = { id: newId("rst"), token_hash: digest(`reset-expired:${T}`), user_id: ana.id,
  created_at: resetAt + 7, expires_at: resetAt + 8 };
await q.issuePasswordReset(db, expiredReset, resetAt + 7);
let expiredResetRejected = false;
try { await q.resetPasswordWithToken(db, expiredReset.token_hash, "expired-hash", resetAt + 9); }
catch (error) { expiredResetRejected = error?.code === "FORGE_RESET_INVALID"; }
assert(expiredResetRejected && (await q.passwordResets(db, resetAt + 9)).find(row => row.id === expiredReset.id)?.status === "expired",
  "expired recovery token is rejected");
const revokedReset = { id: newId("rst"), token_hash: digest(`reset-revoked:${T}`), user_id: ana.id,
  created_at: resetAt + 10, expires_at: resetAt + 60_000 };
await q.issuePasswordReset(db, revokedReset, resetAt + 10);
await q.revokePasswordReset(db, revokedReset.id, resetAt + 11);
let revokedResetRejected = false;
try { await q.resetPasswordWithToken(db, revokedReset.token_hash, "revoked-hash", resetAt + 12); }
catch (error) { revokedResetRejected = error?.code === "FORGE_RESET_INVALID"; }
assert(revokedResetRejected && (await q.passwordResets(db, resetAt + 12)).find(row => row.id === revokedReset.id)?.status === "revoked",
  "revoked recovery token is rejected");

// controlled-beta access control (021) — suspension is an auditable, reversible
// authentication decision. It preserves the user and their authored work.
const suspensionSession = "s".repeat(64);
await q.createSession(db, suspensionSession, ana.id, 60_000);
const suspensionReset = { id: newId("rst"), token_hash: digest(`reset-suspended:${T}`), user_id: ana.id,
  created_at: resetAt + 13, expires_at: resetAt + 60_000 };
await q.issuePasswordReset(db, suspensionReset, resetAt + 13);
const suspendEvent = newId("aae");
await q.setAccountSuspended(db, { id: suspendEvent, user_id: ana.id, suspended: true,
  operator_name: "Pilot Operator", reason: "participant requested access pause" }, resetAt + 14);
const suspendedAccess = await q.accountAccessByHandle(db, ana.handle);
assert(suspendedAccess.status === "suspended" && suspendedAccess.suspension_reason === "participant requested access pause"
  && !("email" in suspendedAccess) && !("pass_hash" in suspendedAccess),
  "suspension status is inspectable without exposing account credentials");
assert(!(await q.sessionUser(db, suspensionSession))
  && (await q.passwordResets(db, resetAt + 15)).find(row => row.id === suspensionReset.id)?.status === "revoked",
  "suspension atomically revokes every session and outstanding recovery token");
let suspendedSessionRejected = false, suspendedIssueRejected = false;
try { await q.createSession(db, "x".repeat(64), ana.id, 60_000); }
catch (error) { suspendedSessionRejected = error?.code === "FORGE_ACCOUNT_SUSPENDED"; }
try { await q.issuePasswordReset(db, { id: newId("rst"), token_hash: digest(`reset-blocked:${T}`),
  user_id: ana.id, created_at: resetAt + 15, expires_at: resetAt + 60_000 }, resetAt + 15); }
catch (error) { suspendedIssueRejected = error?.code === "FORGE_ACCOUNT_SUSPENDED"; }
assert(suspendedSessionRejected && suspendedIssueRejected,
  "suspension prevents new sessions and new recovery tokens at the database boundary");
let suspendedResetRejected = false;
try { await q.resetPasswordWithToken(db, suspensionReset.token_hash, "suspended-hash", resetAt + 15); }
catch (error) { suspendedResetRejected = error?.code === "FORGE_RESET_INVALID"; }
assert(suspendedResetRejected && (await q.userById(db, ana.id)).pass_hash === "new-pass-hash",
  "a suspended account cannot redeem password recovery");
const suspendedEvents = await q.accountAccessEvents(db, ana.id);
assert(suspendedEvents.length === 1 && suspendedEvents[0].id === suspendEvent
  && suspendedEvents[0].action === "suspend" && suspendedEvents[0].operator_name === "Pilot Operator",
  "suspension records an immutable operator action without deleting identity");
let duplicateSuspensionRejected = false;
try { await q.setAccountSuspended(db, { id: newId("aae"), user_id: ana.id, suspended: true,
  operator_name: "Pilot Operator", reason: "duplicate" }, resetAt + 16); }
catch (error) { duplicateSuspensionRejected = error?.code === "FORGE_ACCOUNT_STATE"; }
assert(duplicateSuspensionRejected && (await q.accountAccessEvents(db, ana.id)).length === 1,
  "repeating the same access state is rejected without a false audit event");
const restoreEvent = newId("aae");
await q.setAccountSuspended(db, { id: restoreEvent, user_id: ana.id, suspended: false,
  operator_name: "Pilot Operator", reason: "participant confirmed return" }, resetAt + 17);
await q.createSession(db, suspensionSession, ana.id, 60_000);
const restoredEvents = await q.accountAccessEvents(db, ana.id);
assert((await q.accountAccessByHandle(db, ana.handle)).status === "active"
  && (await q.sessionUser(db, suspensionSession))?.id === ana.id
  && restoredEvents.length === 2 && restoredEvents[0].action === "restore",
  "restoration re-enables future authentication and preserves both audit events");
const accessRaceToken = "q".repeat(64), raceSuspendEvent = newId("aae");
const accessRace = await Promise.allSettled([
  Promise.resolve().then(() => q.createSession(db, accessRaceToken, ana.id, 60_000)),
  Promise.resolve().then(() => q.setAccountSuspended(db, { id: raceSuspendEvent, user_id: ana.id,
    suspended: true, operator_name: "Pilot Operator", reason: "race safety proof" }, resetAt + 18)),
]);
assert(accessRace[1].status === "fulfilled"
  && (accessRace[0].status === "fulfilled" || accessRace[0].reason?.code === "FORGE_ACCOUNT_SUSPENDED")
  && (await q.accountAccessByHandle(db, ana.handle)).status === "suspended"
  && !(await q.sessionUser(db, accessRaceToken)),
  "a concurrent login/suspension race always ends suspended with no live session");
await q.setAccountSuspended(db, { id: newId("aae"), user_id: ana.id, suspended: false,
  operator_name: "Pilot Operator", reason: "finish race safety proof" }, resetAt + 19);

// games index (DA-3) + ownership
const slug = h("game");
const projectId = newId("p");
const repoId = h("repo");
const project = { slug, project_id: projectId, namespace: ana.handle, repo_slug: slug, repo_id: repoId };
await q.upsertGame(db, { ...project, title: "Game", license: "CC-BY-4.0", card_count: 6,
  owner_id: ana.id, project_kind: "owned" });
await q.upsertGame(db, { ...project, title: "Game v2", license: "CC-BY-4.0", card_count: 7,
  owner_id: null, project_kind: "owned" });
let g = (await q.listGames(db)).find(x => x.slug === slug);
assert(g.title === "Game v2" && g.card_count === 7, "upsert takes the update path");
assert(g.project_id === projectId && g.namespace === ana.handle && g.repo_slug === slug,
  "upsert preserves immutable project identity and owner/slug namespace");
assert(g.owner_handle === ana.handle && g.project_kind === "owned",
  "reindex fills an owned project's owner and a later null cannot erase it");
assert(typeof g.stars === "number" && g.stars === 0, "stars is a NUMBER zero (pg ::int cast)", typeof g.stars);
assert((await q.gamesOwnedBy(db, ana.id)).includes(slug), "gamesOwnedBy");
assert((await q.gameByProjectId(db, projectId)).slug === slug
  && (await q.gameByRepoId(db, repoId)).slug === slug,
"stable project and physical repository identities resolve the same index row");

await q.upsertGame(db, { ...project, title: "Game v2", license: "CC-BY-4.0", card_count: 7,
  visibility: "public", owner_id: null, project_kind: "public-sandbox" });
g = await q.gameBySlug(db, slug);
assert(g.owner_id === ana.id && g.project_kind === "owned",
  "a sandbox marker cannot erase an existing owner or reclassify that owned project");
await q.upsertGame(db, { ...project, title: "Game v2", license: "CC-BY-4.0", card_count: 7,
  owner_id: ana.id, project_kind: "owned" });

const transferOwner = { id: newId("u"), handle: h("bob"), email: `${h("bob")}@x.io`, pass_hash: "hash" };
await q.createUser(db, transferOwner);
await q.addCollaborator(db, slug, invited.id, ana.id);
let hosted = await q.reindexHostedGame(db, { ...project, namespace: transferOwner.handle,
  repo_slug: h("renamed-game"), title: "Transferred game", license: "CC-BY-4.0", card_count: 8,
  owner_id: transferOwner.id, project_kind: "owned" });
g = await q.gameBySlug(db, slug);
assert(hosted.changedOwner && g.owner_id === transferOwner.id && g.namespace === transferOwner.handle
  && (await q.collaboratorsOf(db, slug)).length === 0,
"hosted transfer atomically replaces ownership and clears prior collaborator grants");

await q.addCollaborator(db, slug, invited.id, transferOwner.id);
hosted = await q.reindexHostedGame(db, { ...project, namespace: transferOwner.handle,
  repo_slug: h("renamed-again"), title: "Same owner", license: "CC-BY-4.0", card_count: 9,
  owner_id: transferOwner.id, project_kind: "owned" });
assert(!hosted.changedOwner && (await q.collaboratorsOf(db, slug)).length === 1,
"metadata-only hosted reindex preserves grants inside the same ownership boundary");

hosted = await q.reindexHostedGame(db, { ...project, namespace: h("unknown-owner"),
  repo_slug: h("unknown-game"), title: "Unknown owner", license: "CC-BY-4.0", card_count: 9,
  owner_id: null, project_kind: "owned" });
g = await q.gameBySlug(db, slug);
assert(hosted.changedOwner && g.owner_id == null && g.project_kind === "owned"
  && (await q.collaboratorsOf(db, slug)).length === 0,
"unresolved Forgejo owner fails closed and clears every stale collaborator grant");

await q.reindexHostedGame(db, { ...project, title: "Restored", license: "CC-BY-4.0", card_count: 9,
  owner_id: ana.id, project_kind: "owned" });

const conflictSlug = h("identity-conflict"), conflictProjectId = newId("p"), conflictRepoId = h("repo-conflict");
await q.reindexHostedGame(db, { slug: conflictSlug, project_id: conflictProjectId,
  namespace: ana.handle, repo_slug: conflictSlug, repo_id: conflictRepoId,
  title: "Conflict anchor", license: "CC0-1.0", owner_id: ana.id, project_kind: "owned" });
await q.addCollaborator(db, conflictSlug, invited.id, ana.id);
let identityConflictRejected = false;
try {
  await q.reindexHostedGame(db, { slug: conflictSlug, project_id: projectId,
    namespace: transferOwner.handle, repo_slug: conflictSlug, repo_id: conflictRepoId,
    title: "Collision", license: "CC0-1.0", owner_id: transferOwner.id, project_kind: "owned" });
} catch { identityConflictRejected = true; }
const conflictAfter = await q.gameBySlug(db, conflictSlug);
assert(identityConflictRejected && conflictAfter.owner_id === ana.id
  && conflictAfter.project_id === conflictProjectId
  && (await q.collaboratorsOf(db, conflictSlug)).length === 1,
"duplicate project id rolls back metadata, ownership, and grant changes as one transaction");

let duplicateRepoRejected = false;
try {
  await q.reindexHostedGame(db, { slug: h("repo-copy"), project_id: newId("p"),
    namespace: transferOwner.handle, repo_slug: h("repo-copy"), repo_id: repoId,
    title: "Physical duplicate", license: "CC0-1.0", owner_id: transferOwner.id, project_kind: "owned" });
} catch { duplicateRepoRejected = true; }
assert(duplicateRepoRejected, "a physical Forgejo repo id can anchor only one Store-2 project");

const sandboxSlug = h("sandbox");
await q.upsertGame(db, { slug: sandboxSlug, project_id: newId("p"), namespace: "community",
  repo_slug: sandboxSlug, title: "Disposable demo", license: "CC0-1.0", visibility: "public",
  owner_id: null, project_kind: "public-sandbox" });
const sandbox = await q.gameBySlug(db, sandboxSlug);
assert(sandbox.owner_id == null && sandbox.project_kind === "public-sandbox",
  "an explicitly indexed sandbox remains ownerless and durably classified");
let invalidProjectKindRejected = false;
try {
  if (PG) await db.query("UPDATE games SET project_kind = 'implicit-open' WHERE slug = $1", [sandboxSlug]);
  else db.prepare("UPDATE games SET project_kind = 'implicit-open' WHERE slug = ?").run(sandboxSlug);
} catch { invalidProjectKindRejected = true; }
assert(invalidProjectKindRejected, "the database rejects unknown project kinds");

const staleSlug = h("stale");
await q.upsertGame(db, { slug: staleSlug, project_id: newId("p"), namespace: ana.handle,
  repo_slug: staleSlug, title: "Removed repository", license: "CC0-1.0", card_count: 12,
  description: "searchable before removal", topics_json: '["secret"]', players_min: 2,
  players_max: 4, visibility: "public", owner_id: ana.id, project_kind: "owned" });
await q.tombstoneGameIndex(db, staleSlug);
const tombstone = await q.gameBySlug(db, staleSlug);
assert(tombstone.visibility === "private" && tombstone.card_count === 0
  && tombstone.description === "" && tombstone.topics_json === "[]"
  && tombstone.players_min == null && tombstone.players_max == null,
  "a removed Store-1 repository retains its relational anchor but loses readable catalog metadata");

// stars
await q.star(db, ana.id, slug);
await q.star(db, ana.id, slug); // idempotent
const n = await q.starCount(db, slug);
assert(n === 1 && typeof n === "number", "double star counts once, as a number");
assert((await q.starredBy(db, ana.id)).some(r => r.game_slug === slug), "starredBy");
await q.unstar(db, ana.id, slug);
assert(await q.starCount(db, slug) === 0, "unstar → 0");

// fork lineage
const fork = h("game-fork");
await q.upsertGame(db, { slug: fork, project_id: newId("p"), namespace: ana.handle,
  repo_slug: fork, title: "Fork", license: null, card_count: 7 });
await q.setForkMeta(db, fork, slug, ana.id);
g = (await q.listGames(db)).find(x => x.slug === fork);
assert(g.forked_from === slug, "fork lineage recorded");

// claims (DA-7)
const author = h("Sam Author");
await q.claim(db, ana.id, author);
assert((await q.claimOwner(db, author)).user_id === ana.id, "claimOwner");
assert((await q.claimsOf(db, ana.id)).includes(author), "claimsOf");

const n1 = await q.nextIssueNumber(db, slug);
assert(n1 === 1, "first issue number is 1");
const iid = newId("i");
await q.createIssue(db, { id: iid, game_slug: slug, number: n1, title: "Bolt too cheap", body: "1/1", author_id: ana.id });
const ilist = await q.issuesFor(db, slug);
assert(ilist.length === 1 && ilist[0].author_handle === ana.handle, "issuesFor joins author");
assert(ilist[0].comment_count === 0 && typeof ilist[0].comment_count === "number", "comment_count is a number (pg ::int)");
assert(await q.nextIssueNumber(db, slug) === 2, "next issue number increments per game");
await q.addComment(db, { id: newId("c"), target_type: "issue", target_id: iid, author_id: ana.id, body: "agreed" });
await q.addComment(db, { id: newId("c"), target_type: "pr", target_id: "pr_x", author_id: ana.id, body: "on a PR" });
assert((await q.commentsFor(db, "issue", iid)).length === 1, "commentsFor filters by target (issue)");
assert((await q.commentsFor(db, "pr", "pr_x")).length === 1, "commentsFor filters by target (pr)");
assert((await q.issuesFor(db, slug))[0].comment_count === 1, "comment_count reflects added comment");
await q.setIssueStatus(db, iid, "closed");
assert((await q.issueByNumber(db, slug, n1)).status === "closed", "setIssueStatus closes");

// reviews (005) — maintainer approve / request-changes on a PR
const prId = newId("pr");
await q.createPr(db, { id: prId, to_slug: slug, from_slug: fork, title: "buff", body: null,
  author_id: ana.id, base: "[]", proposed: "[]" });
const rev = { id: newId("u"), handle: h("rev"), email: `${h("rev")}@x.io`, pass_hash: "hash" };
await q.createUser(db, rev);
await q.addReview(db, { pr_id: prId, reviewer_id: rev.id, verdict: "approve" });
let rl = await q.reviewsFor(db, prId);
assert(rl.length === 1 && rl[0].verdict === "approve" && rl[0].reviewer_handle === rev.handle,
  "addReview → reviewsFor joins reviewer handle");
await q.addReview(db, { pr_id: prId, reviewer_id: rev.id, verdict: "request_changes" });
rl = await q.reviewsFor(db, prId);
assert(rl.length === 1 && rl[0].verdict === "request_changes", "re-review replaces the verdict (one per reviewer, upsert)");

// jam entries (001 table, now wired) — live join/submit backing
await q.enterJam(db, { jam_id: "jam1", game_slug: slug, user_id: ana.id, qualified: 1 });
await q.enterJam(db, { jam_id: "jam1", game_slug: fork, user_id: ana.id, qualified: 0 });
let je = await q.jamEntriesFor(db, "jam1");
assert(je.length === 2 && je.every(e => "title" in e), "jamEntriesFor lists entries joined to games");
assert(je.find(e => e.game_slug === slug).author_handle === ana.handle, "jam entry joins the author handle");
await q.enterJam(db, { jam_id: "jam1", game_slug: slug, user_id: ana.id, qualified: 0 });
je = await q.jamEntriesFor(db, "jam1");
assert(je.length === 2 && Number(je.find(e => e.game_slug === slug).qualified) === 0, "re-enter updates qualification (upsert: one row per game per jam)");

// releases (006) — citable immutable versions, including the non-tree build
// inputs needed to reproduce externally linked packages after cache loss.
const releaseBuild = JSON.stringify({ format: "forge-release-build", version: 1,
  public_origin: "https://play.example.invalid", build_id: "image@sha256:abc" });
await q.createRelease(db, { game_slug: slug, tag: "v1.0", sha: "abc1234", title: "First cut",
  notes: "initial", author_id: ana.id, build_json: releaseBuild });
let rels = await q.releasesFor(db, slug);
assert(rels.length === 1 && rels[0].tag === "v1.0" && rels[0].author_handle === ana.handle, "releasesFor lists tagged releases with author");
assert(rels[0].build_json === releaseBuild, "releasesFor preserves the frozen release build identity");
const releaseByTag = await q.releaseByTag(db, slug, "v1.0");
assert(releaseByTag.sha === "abc1234" && releaseByTag.build_json === releaseBuild,
  "releaseByTag resolves the pinned sha and build identity");
const exportJobId = newId("job"), exportInput = digest(`${slug}\0abc1234\0data\0${3}`);
await q.createExportJob(db, { id: exportJobId, game_slug: slug, ref: "abc1234", kind: "data",
  exporter_version: 3, input_hash: exportInput, created_by: ana.id, budget_json: "{}" });
await q.finishExportJob(db, exportJobId, "succeeded", JSON.stringify({ ok: true }), null);
const successfulExports = await q.succeededExportJobsForRef(db, slug, "abc1234");
assert(successfulExports.length === 1 && successfulExports[0].id === exportJobId,
  "succeededExportJobsForRef exposes only successful Store-2 artifact evidence");
let dupRel = false;
try { await q.createRelease(db, { game_slug: slug, tag: "v1.0", sha: "z", author_id: ana.id }); } catch { dupRel = true; }
assert(dupRel, "duplicate tag rejected (one release per tag per game)");
const deliveryId = newId("pd"), artifactHash = "a".repeat(64), evidenceHash = "b".repeat(64);
await q.createPrintDelivery(db, { id: deliveryId, game_slug: slug, release_tag: "v1.0",
  release_sha: "abc1234", artifact_name: "print-ready.zip", artifact_sha256: artifactHash,
  artifact_bytes: 1234, printer_name: "Example Press", job_reference: "JOB-42",
  submission_evidence_url: "https://press.example.invalid/jobs/JOB-42", submission_evidence_sha256: evidenceHash,
  note: "submitted proof", created_by: ana.id });
let deliveries = await q.printDeliveriesForRelease(db, slug, "v1.0");
assert(deliveries.length === 1 && deliveries[0].release_sha === "abc1234"
  && deliveries[0].artifact_sha256 === artifactHash && !deliveries[0].decision,
"print delivery freezes release sha, artifact hash, printer, and submission evidence");
await q.decidePrintDelivery(db, { id: newId("pdd"), delivery_id: deliveryId, decision: "approved",
  reviewer_name: "Printer QA", organization: "Example Press", evidence_url: null,
  evidence_sha256: "c".repeat(64), note: "approved for manufacture", recorded_by: ana.id });
deliveries = await q.printDeliveriesForRelease(db, slug, "v1.0");
assert(deliveries[0].decision === "approved" && deliveries[0].reviewer_name === "Printer QA"
  && (await q.printDeliveryById(db, deliveryId)).evidence_sha256 === "c".repeat(64),
"one printer decision joins its named reviewer and hashed evidence to the exact delivery");
let duplicateDecision = false;
try { await q.decidePrintDelivery(db, { id: newId("pdd"), delivery_id: deliveryId, decision: "rejected",
  reviewer_name: "Other", organization: "Example Press", evidence_sha256: "d".repeat(64), recorded_by: ana.id }); }
catch { duplicateDecision = true; }
assert(duplicateDecision, "printer decision is immutable (one terminal decision per exact delivery)");

// events (007) — the activity feed backing
await q.recordEvent(db, { id: newId("ev"), kind: "fork", actor_id: ana.id, game_slug: fork, target: slug });
await new Promise(r => setTimeout(r, 2));   // distinct ms so newest-first is deterministic
await q.recordEvent(db, { id: newId("ev"), kind: "release", actor_id: ana.id, game_slug: slug, target: "v1.0" });
const ev = await q.recentEvents(db, 10);
assert(ev.length >= 2 && ev[0].actor_handle === ana.handle && ev[0].kind === "release", "recentEvents newest-first, joined to actor");
assert((await q.eventsByActor(db, ana.id, 10)).length >= 2, "eventsByActor filters to one user's activity");

// notifications (008) — per-user inbox
const rcv = { id: newId("u"), handle: h("rcv"), email: `${h("rcv")}@x.io`, pass_hash: "h" };
await q.createUser(db, rcv);
await q.notify(db, { id: newId("n"), user_id: rcv.id, kind: "fork", actor_handle: ana.handle, game_slug: slug, target: fork });
await q.notify(db, { id: newId("n"), user_id: rcv.id, kind: "pr_comment", actor_handle: ana.handle, game_slug: slug, target: "pr_x" });
assert(await q.unreadCount(db, rcv.id) === 2, "unreadCount counts unread notifications");
const nl = await q.notificationsFor(db, rcv.id, 10);
assert(nl.length === 2 && nl[0].actor_handle === ana.handle, "notificationsFor newest-first with actor");
await q.markAllRead(db, rcv.id);
assert(await q.unreadCount(db, rcv.id) === 0, "markAllRead clears the unread count");

// Sheet sync contract (009 + 010) — both drivers persist the same merge base
// and exact remote fingerprint, and reconnecting resets stale sync metadata.
await q.connectSource(db, { game_slug: slug, kind: "sheet", url: "https://example.com/cards.csv",
  connected_by: ana.id, last_sha: "base123" });
let src = await q.sourceFor(db, slug, "sheet");
assert(src.last_sha === "base123" && src.source_hash == null, "connectSource establishes a merge base without claiming a completed sync");
await q.recordSync(db, slug, "sheet", "sync456", "hash789", "etag-1");
src = await q.sourceFor(db, slug, "sheet");
assert(src.last_sha === "sync456" && src.source_hash === "hash789" && src.source_revision === "etag-1" && src.last_sync,
  "recordSync persists repository base + remote fingerprint");
await q.connectSource(db, { game_slug: slug, kind: "sheet", url: "https://example.com/new.csv",
  connected_by: ana.id, last_sha: "base999" });
src = await q.sourceFor(db, slug, "sheet");
assert(src.last_sha === "base999" && src.source_hash == null && src.last_sync == null,
  "reconnecting resets stale synchronization metadata");
const personalExport = assertPersonalDataSafe(await q.personalDataExport(db, ana.id));
assert(personalExport.account.email === ana.email && personalExport.author_claims.length === 1
  && personalExport.owned_projects.some(project => project.slug === slug)
  && personalExport.authored_proposals.some(proposal => proposal.id === prId)
  && personalExport.authored_issues.some(issue => issue.id === iid)
  && personalExport.authored_comments.length === 2
  && personalExport.authored_releases.some(release => release.tag === "v1.0")
  && personalExport.print_deliveries.some(delivery => delivery.id === deliveryId)
  && personalExport.print_delivery_decisions.some(decision => decision.delivery_id === deliveryId)
  && personalExport.activity.length >= 2 && personalExport.connected_sources.length === 1,
  "allowlisted export covers the participant's account, authorship, activity, and connector record");
await q.disconnectSource(db, slug, "sheet");
assert(!(await q.sourceFor(db, slug, "sheet")), "disconnectSource removes the connector");

console.log(`\nSTORE-2 CONFORMANCE GREEN — ${step} checks on the ${PG ? "POSTGRES" : "node:sqlite"} driver.`);
