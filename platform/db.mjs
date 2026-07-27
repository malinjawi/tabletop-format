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
    `SELECT g.*, (SELECT COUNT(*) FROM stars s WHERE s.game_slug = g.slug) AS stars
     FROM games g ORDER BY stars DESC, g.updated_at DESC`).all(),
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

  claim: (db, userId, author) => db.prepare(
    `INSERT INTO claims (user_id, author_string, claimed_at) VALUES (?, ?, ?)`)
    .run(userId, author, Date.now()),
  claimsOf: (db, userId) => db.prepare(
    "SELECT author_string FROM claims WHERE user_id = ?").all(userId).map(r => r.author_string),
  claimOwner: (db, author) => db.prepare(
    "SELECT user_id FROM claims WHERE author_string = ?").get(author),
};
