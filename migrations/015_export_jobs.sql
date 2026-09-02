-- 015: observable, deduplicated export work. Artifacts remain regenerable in
-- Store 3; this table is status/progress/failure conversation only.
CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY,
  game_slug TEXT NOT NULL REFERENCES games(slug),
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  exporter_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  output_json TEXT,
  error TEXT,
  created_by TEXT REFERENCES users(id),
  budget_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  UNIQUE (game_slug, ref, kind, exporter_version)
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_game ON export_jobs(game_slug, created_at);
