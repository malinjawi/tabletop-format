-- 009: external source connections (Store 2). A game can be bound to an
-- external source of truth for its card data — e.g. a published Google Sheet.
-- We store only a PUBLIC url + sync bookkeeping: never credentials.
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
