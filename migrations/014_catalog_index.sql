-- 014: repository-derived discovery fields. Store 1 remains canonical; this
-- table is the bounded query index used by the public catalog.
ALTER TABLE games ADD COLUMN description TEXT;
ALTER TABLE games ADD COLUMN topics_json TEXT;
ALTER TABLE games ADD COLUMN players_min INTEGER;
ALTER TABLE games ADD COLUMN players_max INTEGER;
ALTER TABLE games ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
CREATE INDEX IF NOT EXISTS idx_games_license ON games(license);
CREATE INDEX IF NOT EXISTS idx_games_visibility ON games(visibility);
