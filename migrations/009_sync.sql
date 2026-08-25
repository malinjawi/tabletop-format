-- 009: external working-copy connections (Store 2). A game can attach a Sheet
-- or CSV authoring surface without making it the accepted source of history.
-- The value is a public URL or a credential-free add-on source identity.
CREATE TABLE IF NOT EXISTS sync_sources (
  game_slug   TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- 'sheet'
  url         TEXT NOT NULL,
  connected_by TEXT REFERENCES users(id),
  last_sync   BIGINT,
  last_sha    TEXT,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (game_slug, kind)
);
