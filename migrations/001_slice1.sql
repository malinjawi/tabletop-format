-- STORE 2, SLICE 1 — identity + social + games index (DATA-ARCHITECTURE.md)
-- Canonical migration. Written in the SQLite/Postgres-compatible subset:
-- TEXT ids (generated app-side), INTEGER epoch-ms timestamps, no engine
-- extensions. Dev engine: node:sqlite. Prod engine: Postgres (same SQL).
-- RULE (DA-9): nothing in this database is needed to play or print a game.
-- games is a DERIVED index (DA-3): rebuildable from git at any time.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,          -- 'u_' + random
  handle       TEXT NOT NULL UNIQUE,      -- kebab, 2-32 chars
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT,
  pass_hash    TEXT NOT NULL,             -- scrypt: salthex:hashhex
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,            -- random 32 bytes hex
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

-- links git/playtest author strings ("Sam") to accounts -> claimed profiles (DA-7)
CREATE TABLE IF NOT EXISTS claims (
  user_id       TEXT NOT NULL REFERENCES users(id),
  author_string TEXT NOT NULL UNIQUE,
  claimed_at    BIGINT NOT NULL,
  PRIMARY KEY (user_id, author_string)
);

-- derived catalog index; source of truth stays git (DA-3)
CREATE TABLE IF NOT EXISTS games (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  license     TEXT,
  owner_id    TEXT REFERENCES users(id), -- null until claimed/created via platform
  forked_from TEXT,
  head_sha    TEXT,
  card_count  INTEGER,
  updated_at  BIGINT,
  indexed_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS stars (
  user_id    TEXT NOT NULL REFERENCES users(id),
  game_slug  TEXT NOT NULL REFERENCES games(slug),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, game_slug)
);

CREATE TABLE IF NOT EXISTS jam_entries (
  jam_id       TEXT NOT NULL,
  game_slug    TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id),
  submitted_at BIGINT NOT NULL,
  qualified    INTEGER,                   -- 0/1 (bool)
  award        TEXT,
  PRIMARY KEY (jam_id, game_slug)
);

CREATE INDEX IF NOT EXISTS idx_stars_game    ON stars(game_slug);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_games_updated ON games(updated_at);
