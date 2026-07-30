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

// sessions
const tok = "t".repeat(64);
await q.createSession(db, tok, ana.id, 60_000);
assert((await q.sessionUser(db, tok))?.handle === ana.handle, "session resolves to user");
const dead = "d".repeat(64);
await q.createSession(db, dead, ana.id, -1000);
assert(!(await q.sessionUser(db, dead)), "expired session resolves to nothing");

// games index (DA-3) + ownership
const slug = h("game");
await q.upsertGame(db, { slug, title: "Game", license: "CC-BY-4.0", card_count: 6 });
await q.upsertGame(db, { slug, title: "Game v2", license: "CC-BY-4.0", card_count: 7 });
await q.setForkMeta(db, slug, null, ana.id);
let g = (await q.listGames(db)).find(x => x.slug === slug);
assert(g.title === "Game v2" && g.card_count === 7, "upsert takes the update path");
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
await q.upsertGame(db, { slug: fork, title: "Fork", license: null, card_count: 7 });
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

console.log(`\nSTORE-2 CONFORMANCE GREEN — ${step} checks on the ${PG ? "POSTGRES" : "node:sqlite"} driver.`);
