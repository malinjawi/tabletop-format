-- 011: public project identity is namespace/slug; storage slug remains the
-- compatibility key used by existing Store-2 relationships. project_id is
-- immutable and survives future repository renames.
ALTER TABLE games ADD COLUMN project_id TEXT;
ALTER TABLE games ADD COLUMN namespace TEXT;
ALTER TABLE games ADD COLUMN repo_slug TEXT;
ALTER TABLE games ADD COLUMN repo_id TEXT;

UPDATE games SET project_id = 'legacy:' || slug WHERE project_id IS NULL;
UPDATE games SET namespace = 'community' WHERE namespace IS NULL;
UPDATE games SET repo_slug = slug WHERE repo_slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_games_project_id ON games(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_namespace_slug ON games(namespace, repo_slug);
