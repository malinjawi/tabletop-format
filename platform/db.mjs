/**
 * db.mjs — Store-2 database adapter (DATA-ARCHITECTURE.md, Slice 1).
 *
 * Dev engine: node:sqlite (zero deps, real SQL). Prod engine: Postgres —
 * the migrations are written in the compatible subset, so the swap is a
 * driver change behind this module, not a schema change. Losing this DB
 * must never lose a game (DA-9): it holds people & conversation only,
 * and `games` is a rebuildable index (DA-3 — see reindexGames in server).
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function openDb(path = process.env.DB_PATH ?? join(ROOT, "data", "platform.db")) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(db.prepare("SELECT name FROM schema_migrations").all().map(r => r.name));
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    if (applied.has(f)) continue;
    db.exec(readFileSync(join(dir, f), "utf8"));
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, Date.now());
  }
}

export const newId = (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`;

/* ---- typed helpers (the only SQL surface the routes may touch) ---- */
export const q = {
  createUser: (db, u) => db.prepare(
    `INSERT INTO users (id, handle, email, display_name, pass_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`).run(u.id, u.handle, u.email, u.display_name ?? u.handle, u.pass_hash, Date.now()),
  userByHandle: (db, h) => db.prepare("SELECT * FROM users WHERE handle = ?").get(h),
  userByEmail:  (db, e) => db.prepare("SELECT * FROM users WHERE email = ?").get(e),
  userById:     (db, id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id),

  createSession: (db, token, userId, ttlMs) => db.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId, Date.now(), Date.now() + ttlMs),
  sessionUser: (db, token) => db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now()),

  upsertGame: (db, g) => db.prepare(
    `INSERT INTO games (slug, title, license, card_count, updated_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET title=excluded.title, license=excluded.license,
       card_count=excluded.card_count, updated_at=excluded.updated_at, indexed_at=excluded.indexed_at`)
    .run(g.slug, g.title, g.license ?? null, g.card_count ?? null, Date.now(), Date.now()),
  listGames: (db) => db.prepare(
    `SELECT g.*, u.handle AS owner_handle,
            (SELECT COUNT(*) FROM stars s WHERE s.game_slug = g.slug) AS stars
     FROM games g LEFT JOIN users u ON u.id = g.owner_id
     ORDER BY stars DESC, g.updated_at DESC`).all(),
  gamesOwnedBy: (db, userId) => db.prepare(
    "SELECT slug FROM games WHERE owner_id = ? ORDER BY updated_at DESC").all(userId).map(r => r.slug),
  setForkMeta: (db, slug, forkedFrom, ownerId) => db.prepare(
    "UPDATE games SET forked_from = ?, owner_id = ? WHERE slug = ?").run(forkedFrom, ownerId, slug),

  star:   (db, userId, slug) => db.prepare(
    `INSERT INTO stars (user_id, game_slug, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, game_slug) DO NOTHING`).run(userId, slug, Date.now()),
  unstar: (db, userId, slug) => db.prepare(
    "DELETE FROM stars WHERE user_id = ? AND game_slug = ?").run(userId, slug),
  starCount: (db, slug) => db.prepare(
    "SELECT COUNT(*) AS n FROM stars WHERE game_slug = ?").get(slug).n,
  starredBy: (db, userId) => db.prepare(
    "SELECT game_slug FROM stars WHERE user_id = ? ORDER BY created_at DESC").all(userId),

  gameBySlug: (db, slug) => db.prepare("SELECT * FROM games WHERE slug = ?").get(slug),

  createPr: (db, pr) => db.prepare(
    `INSERT INTO prs (id, to_slug, from_slug, title, body, author_id, status, base, proposed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(pr.id, pr.to_slug, pr.from_slug, pr.title, pr.body ?? null, pr.author_id, pr.base, pr.proposed, Date.now()),
  prById: (db, id) => db.prepare(
    `SELECT p.*, u.handle AS author_handle, u.email AS author_email FROM prs p JOIN users u ON u.id = p.author_id
     WHERE p.id = ?`).get(id),
  prsFor: (db, slug) => db.prepare(
    `SELECT p.id, p.from_slug, p.title, p.status, p.created_at, p.merged_at, u.handle AS author_handle
     FROM prs p JOIN users u ON u.id = p.author_id
     WHERE p.to_slug = ? ORDER BY p.created_at DESC`).all(slug),
  setPrStatus: (db, id, status, mergeSha) => db.prepare(
    "UPDATE prs SET status = ?, merged_at = ?, merge_sha = ? WHERE id = ?")
    .run(status, status === "merged" ? Date.now() : null, mergeSha ?? null, id),

  addCollaborator: (db, slug, userId, addedBy) => db.prepare(
    `INSERT INTO collaborators (game_slug, user_id, role, added_by, added_at)
     VALUES (?, ?, 'maintainer', ?, ?) ON CONFLICT(game_slug, user_id) DO NOTHING`)
    .run(slug, userId, addedBy, Date.now()),
  removeCollaborator: (db, slug, userId) => db.prepare(
    "DELETE FROM collaborators WHERE game_slug = ? AND user_id = ?").run(slug, userId),
  isCollaborator: (db, slug, userId) => db.prepare(
    "SELECT 1 AS y FROM collaborators WHERE game_slug = ? AND user_id = ?").get(slug, userId),
  collaboratorsOf: (db, slug) => db.prepare(
    `SELECT u.handle, c.role, c.added_at FROM collaborators c JOIN users u ON u.id = c.user_id
     WHERE c.game_slug = ? ORDER BY c.added_at`).all(slug),

  nextIssueNumber: (db, slug) => (db.prepare(
    "SELECT COALESCE(MAX(number),0)+1 AS n FROM issues WHERE game_slug = ?").get(slug)).n,
  createIssue: (db, i) => db.prepare(
    `INSERT INTO issues (id, game_slug, number, title, body, author_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`).run(i.id, i.game_slug, i.number, i.title, i.body ?? null, i.author_id, Date.now()),
  issuesFor: (db, slug) => db.prepare(
    `SELECT i.*, u.handle AS author_handle,
            (SELECT COUNT(*) FROM comments c WHERE c.target_type='issue' AND c.target_id=i.id) AS comment_count
     FROM issues i JOIN users u ON u.id = i.author_id
     WHERE i.game_slug = ? ORDER BY i.number DESC`).all(slug),
  issueByNumber: (db, slug, number) => db.prepare(
    `SELECT i.*, u.handle AS author_handle FROM issues i JOIN users u ON u.id = i.author_id
     WHERE i.game_slug = ? AND i.number = ?`).get(slug, number),
  setIssueStatus: (db, id, status) => db.prepare(
    "UPDATE issues SET status = ?, closed_at = ? WHERE id = ?").run(status, status === "closed" ? Date.now() : null, id),

  addComment: (db, c) => db.prepare(
    `INSERT INTO comments (id, target_type, target_id, author_id, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`).run(c.id, c.target_type, c.target_id, c.author_id, c.body, Date.now()),
  commentsFor: (db, targetType, targetId) => db.prepare(
    `SELECT c.body, c.created_at, u.handle AS author_handle FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.target_type = ? AND c.target_id = ? ORDER BY c.created_at`).all(targetType, targetId),

  addReview: (db, r) => db.prepare(
    `INSERT INTO reviews (pr_id, reviewer_id, verdict, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (pr_id, reviewer_id) DO UPDATE SET verdict = excluded.verdict, created_at = excluded.created_at`)
    .run(r.pr_id, r.reviewer_id, r.verdict, Date.now()),
  reviewsFor: (db, prId) => db.prepare(
    `SELECT rv.verdict, rv.created_at, u.handle AS reviewer_handle FROM reviews rv JOIN users u ON u.id = rv.reviewer_id
     WHERE rv.pr_id = ? ORDER BY rv.created_at`).all(prId),

  enterJam: (db, e) => db.prepare(
    `INSERT INTO jam_entries (jam_id, game_slug, user_id, submitted_at, qualified, award)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (jam_id, game_slug) DO UPDATE SET user_id = excluded.user_id, submitted_at = excluded.submitted_at, qualified = excluded.qualified`)
    .run(e.jam_id, e.game_slug, e.user_id ?? null, Date.now(), e.qualified ? 1 : 0, e.award ?? null),
  jamEntriesFor: (db, jamId) => db.prepare(
    `SELECT je.jam_id, je.game_slug, je.submitted_at, je.qualified, je.award,
            g.title, g.forked_from, u.handle AS author_handle
     FROM jam_entries je LEFT JOIN games g ON g.slug = je.game_slug LEFT JOIN users u ON u.id = je.user_id
     WHERE je.jam_id = ? ORDER BY je.submitted_at`).all(jamId),
  jamEntryOf: (db, jamId, slug) => db.prepare(
    "SELECT * FROM jam_entries WHERE jam_id = ? AND game_slug = ?").get(jamId, slug),

  createRelease: (db, r) => db.prepare(
    `INSERT INTO releases (game_slug, tag, sha, title, notes, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(r.game_slug, r.tag, r.sha, r.title ?? null, r.notes ?? null, r.author_id ?? null, Date.now()),
  releasesFor: (db, slug) => db.prepare(
    `SELECT rl.tag, rl.sha, rl.title, rl.created_at, u.handle AS author_handle
     FROM releases rl LEFT JOIN users u ON u.id = rl.author_id WHERE rl.game_slug = ? ORDER BY rl.created_at DESC`).all(slug),
  releaseByTag: (db, slug, tag) => db.prepare(
    `SELECT rl.*, u.handle AS author_handle FROM releases rl LEFT JOIN users u ON u.id = rl.author_id
     WHERE rl.game_slug = ? AND rl.tag = ?`).get(slug, tag),

  recordEvent: (db, e) => db.prepare(
    `INSERT INTO events (id, kind, actor_id, game_slug, target, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(e.id, e.kind, e.actor_id ?? null, e.game_slug ?? null, e.target ?? null, Date.now()),
  recentEvents: (db, limit = 30) => db.prepare(
    `SELECT e.kind, e.game_slug, e.target, e.created_at, u.handle AS actor_handle
     FROM events e LEFT JOIN users u ON u.id = e.actor_id ORDER BY e.created_at DESC LIMIT ?`).all(limit),
  eventsByActor: (db, actorId, limit = 30) => db.prepare(
    `SELECT e.kind, e.game_slug, e.target, e.created_at, u.handle AS actor_handle
     FROM events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.actor_id = ? ORDER BY e.created_at DESC LIMIT ?`).all(actorId, limit),

  notify: (db, n) => db.prepare(
    `INSERT INTO notifications (id, user_id, kind, actor_handle, game_slug, target, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(n.id, n.user_id, n.kind, n.actor_handle ?? null, n.game_slug ?? null, n.target ?? null, Date.now()),
  notificationsFor: (db, userId, limit = 30) => db.prepare(
    `SELECT id, kind, actor_handle, game_slug, target, read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all(userId, limit),
  unreadCount: (db, userId) => db.prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0`).get(userId).n,
  markAllRead: (db, userId) => db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ?`).run(userId),

  claim: (db, userId, author) => db.prepare(
    `INSERT INTO claims (user_id, author_string, claimed_at) VALUES (?, ?, ?)`)
    .run(userId, author, Date.now()),
  claimsOf: (db, userId) => db.prepare(
    "SELECT author_string FROM claims WHERE user_id = ?").all(userId).map(r => r.author_string),
  claimOwner: (db, author) => db.prepare(
    "SELECT user_id FROM claims WHERE author_string = ?").get(author),
};
