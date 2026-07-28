-- 002: pull requests — the PROPOSAL is conversation (Store 2, this table);
-- the MERGE is content (a commit in Store 1). Snapshots let us do card-level
-- three-way merges + honest staleness/conflict detection at merge time.
CREATE TABLE IF NOT EXISTS prs (
  id         TEXT PRIMARY KEY,
  to_slug    TEXT NOT NULL REFERENCES games(slug),
  from_slug  TEXT NOT NULL REFERENCES games(slug),
  title      TEXT NOT NULL,
  body       TEXT,
  author_id  TEXT NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL,        -- open | merged | closed
  base       TEXT NOT NULL,        -- target cards.json at PR creation (merge base)
  proposed   TEXT NOT NULL,        -- source cards.json at PR creation
  created_at BIGINT NOT NULL,
  merged_at  BIGINT,
  merge_sha  TEXT
);
CREATE INDEX IF NOT EXISTS idx_prs_to ON prs(to_slug, status);
