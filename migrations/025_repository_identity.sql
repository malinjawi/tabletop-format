-- 025: a Forgejo repository id is stable across owner/name changes. Keep one
-- Store-2 project anchor per physical repository so a native rename or transfer
-- cannot duplicate or take over another project's conversation/access rows.
-- Older development builds could index the same repo id more than once. Retain
-- the most recently indexed row as the migration anchor and detach the stale
-- rows before installing the invariant; reindex will tombstone them normally.
UPDATE games AS candidate SET repo_id = NULL
WHERE candidate.repo_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM games AS preferred
  WHERE preferred.repo_id = candidate.repo_id
    AND (preferred.indexed_at > candidate.indexed_at
      OR (preferred.indexed_at = candidate.indexed_at AND preferred.slug < candidate.slug))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_games_repo_id
  ON games(repo_id) WHERE repo_id IS NOT NULL;
