-- A jam submission is an immutable release selection. Replacements remain in
-- history and the current entry never follows mutable project HEAD.
ALTER TABLE jam_entries ADD COLUMN state TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE jam_entries ADD COLUMN release_tag TEXT;
ALTER TABLE jam_entries ADD COLUMN release_sha TEXT;
ALTER TABLE jam_entries ADD COLUMN receipt_json TEXT;
ALTER TABLE jam_entries ADD COLUMN team_json TEXT;
ALTER TABLE jam_entries ADD COLUMN replaced_at BIGINT;
ALTER TABLE jam_entries ADD COLUMN disqualified_reason TEXT;

CREATE TABLE IF NOT EXISTS jam_submission_history (
  id           TEXT PRIMARY KEY,
  jam_id       TEXT NOT NULL,
  game_slug    TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id),
  release_tag  TEXT NOT NULL,
  release_sha  TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  action       TEXT NOT NULL,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS jam_audit_events (
  id         TEXT PRIMARY KEY,
  jam_id     TEXT NOT NULL,
  actor_id   TEXT REFERENCES users(id),
  action     TEXT NOT NULL,
  target     TEXT,
  detail_json TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jam_history_entry ON jam_submission_history(jam_id, game_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_jam_entries_release ON jam_entries(jam_id, release_sha);
