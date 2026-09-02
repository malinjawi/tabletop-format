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
const redemption = await q.registerUserWithInvite(db, invited, invite.token_hash, inviteAt + 1);
assert(redemption.id === invite.id && (await q.userById(db, invited.id)).handle === invited.handle,
  "valid pilot invite atomically creates its account");
invitations = await q.pilotInvites(db, inviteAt + 2);
assert(invitations.find(row => row.id === invite.id)?.status === "redeemed"
  && invitations.find(row => row.id === invite.id)?.redeemed_handle === invited.handle,
  "redeemed invitation records the account without retaining its raw token");
let replayed = false;
try {
  await q.registerUserWithInvite(db,
    { id: newId("u"), handle: h("replay"), email: `${h("replay")}@x.io`, pass_hash: "hash" },
    invite.token_hash, inviteAt + 3);
} catch (error) { replayed = error?.code === "FORGE_INVITE_INVALID"; }
assert(replayed && !(await q.userByHandle(db, h("replay"))), "an invite cannot be replayed and creates no partial account");
const expired = { id: newId("inv"), token_hash: digest(`expired:${T}`), label: null, cohort_id: h("beta"),
  created_at: inviteAt - 20, expires_at: inviteAt - 10 };
await q.createPilotInvite(db, expired);
let expiryRejected = false;
try {
  await q.registerUserWithInvite(db,
    { id: newId("u"), handle: h("expired"), email: `${h("expired")}@x.io`, pass_hash: "hash" },
    expired.token_hash, inviteAt);
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
    revoked.token_hash, inviteAt + 2);
} catch (error) { revocationRejected = error?.code === "FORGE_INVITE_INVALID"; }
assert(revocationRejected && (await q.pilotInvites(db, inviteAt + 2)).find(row => row.id === revoked.id)?.status === "revoked",
  "revoked invite is rejected and reported as revoked");
const raced = { id: newId("inv"), token_hash: digest(`race:${T}`), label: null, cohort_id: h("beta"),
  created_at: inviteAt, expires_at: inviteAt + 60_000 };
await q.createPilotInvite(db, raced);
const racers = [1, 2].map(number => ({ id: newId("u"), handle: h(`racer${number}`),
  email: `${h(`racer${number}`)}@x.io`, pass_hash: "hash" }));
const raceResults = await Promise.allSettled(racers.map(user =>
  Promise.resolve().then(() => q.registerUserWithInvite(db, user, raced.token_hash, inviteAt + 3))));
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

// games index (DA-3) + ownership
const slug = h("game");
const projectId = newId("p");
const project = { slug, project_id: projectId, namespace: ana.handle, repo_slug: slug };
await q.upsertGame(db, { ...project, title: "Game", license: "CC-BY-4.0", card_count: 6 });
await q.upsertGame(db, { ...project, title: "Game v2", license: "CC-BY-4.0", card_count: 7 });
await q.setForkMeta(db, slug, null, ana.id);
let g = (await q.listGames(db)).find(x => x.slug === slug);
assert(g.title === "Game v2" && g.card_count === 7, "upsert takes the update path");
assert(g.project_id === projectId && g.namespace === ana.handle && g.repo_slug === slug,
  "upsert preserves immutable project identity and owner/slug namespace");
assert(g.owner_handle === ana.handle, "listGames joins owner_handle");
assert(typeof g.stars === "number" && g.stars === 0, "stars is a NUMBER zero (pg ::int cast)", typeof g.stars);
assert((await q.gamesOwnedBy(db, ana.id)).includes(slug), "gamesOwnedBy");

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
let dupRel = false;
try { await q.createRelease(db, { game_slug: slug, tag: "v1.0", sha: "z", author_id: ana.id }); } catch { dupRel = true; }
assert(dupRel, "duplicate tag rejected (one release per tag per game)");

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
await q.disconnectSource(db, slug, "sheet");
assert(!(await q.sourceFor(db, slug, "sheet")), "disconnectSource removes the connector");

console.log(`\nSTORE-2 CONFORMANCE GREEN — ${step} checks on the ${PG ? "POSTGRES" : "node:sqlite"} driver.`);
