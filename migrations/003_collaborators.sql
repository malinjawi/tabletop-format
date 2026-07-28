-- 003: commit access — a game's owner can grant/revoke direct-commit rights.
-- Everyone else contributes through forks + pull requests.
CREATE TABLE IF NOT EXISTS collaborators (
  game_slug TEXT NOT NULL REFERENCES games(slug),
  user_id   TEXT NOT NULL REFERENCES users(id),
  role      TEXT NOT NULL,        -- 'maintainer' (only role for now)
  added_by  TEXT NOT NULL REFERENCES users(id),
  added_at  BIGINT NOT NULL,
  PRIMARY KEY (game_slug, user_id)
);
