-- 008: notifications — per-user inbox (Store 2). Someone commented on your PR,
-- forked your game, reviewed or merged your work. Denormalized actor_handle so
-- the inbox reads without extra joins. Derived signal, never content (DA-9).
CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL,        -- pr_comment | fork | pr_review | pr_merge
  actor_handle TEXT,
  game_slug    TEXT,
  target       TEXT,
  read         INTEGER NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at DESC);
