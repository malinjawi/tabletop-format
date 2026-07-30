-- 006: releases — a citable, immutable version of a game (Store 2).
-- A release pins a human tag (v1.0) to an exact commit sha; exports at that sha
-- are frozen forever by the content-addressed cache (Store 3). Notes = changelog.
CREATE TABLE IF NOT EXISTS releases (
  game_slug  TEXT NOT NULL REFERENCES games(slug),
  tag        TEXT NOT NULL,
  sha        TEXT NOT NULL,
  title      TEXT,
  notes      TEXT,
  author_id  TEXT REFERENCES users(id),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (game_slug, tag)
);
CREATE INDEX IF NOT EXISTS idx_releases_game ON releases(game_slug, created_at);
