-- 007: events — the activity feed (Store 2). Who did what, when: forks, stars,
-- merges, jam joins, releases. Derived signal, never content (DA-9).
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,          -- fork | star | pr_merge | jam_join | release
  actor_id   TEXT REFERENCES users(id),
  game_slug  TEXT,
  target     TEXT,                   -- kind-specific (source slug, tag, jam id…)
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_time  ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id, created_at DESC);
