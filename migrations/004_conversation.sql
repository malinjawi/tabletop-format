-- 004: the conversation layer — issues + threaded comments (Store 2).
-- Community over a game: bug reports, balance debates, review discussion.
-- Losing this DB never loses a game (DA-9); conversation is not content.
CREATE TABLE IF NOT EXISTS issues (
  id         TEXT PRIMARY KEY,
  game_slug  TEXT NOT NULL REFERENCES games(slug),
  number     INTEGER NOT NULL,           -- per-game, human-facing (#1, #2 …)
  title      TEXT NOT NULL,
  body       TEXT,
  author_id  TEXT NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL,              -- open | closed
  created_at BIGINT NOT NULL,
  closed_at  BIGINT,
  UNIQUE (game_slug, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_game ON issues(game_slug, status);

-- comments thread on either an issue or a PR (target_type discriminates)
CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,             -- 'issue' | 'pr'
  target_id   TEXT NOT NULL,             -- issues.id or prs.id
  author_id   TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_type, target_id, created_at);
