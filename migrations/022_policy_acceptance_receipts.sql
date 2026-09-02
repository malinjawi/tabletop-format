-- Exact clickwrap evidence. Policy text is intentionally snapshotted: a hash
-- alone cannot later show what a participant actually accepted.

CREATE TABLE IF NOT EXISTS policy_sets (
  id               TEXT PRIMARY KEY,
  terms_text       TEXT NOT NULL,
  privacy_text     TEXT NOT NULL,
  community_text   TEXT NOT NULL,
  notice_text      TEXT NOT NULL,
  terms_sha256     TEXT NOT NULL,
  privacy_sha256   TEXT NOT NULL,
  community_sha256 TEXT NOT NULL,
  notice_sha256    TEXT NOT NULL,
  created_at       BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_acceptances (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  policy_set_id     TEXT NOT NULL REFERENCES policy_sets(id),
  accepted_at       BIGINT NOT NULL,
  method            TEXT NOT NULL CHECK (method = 'clickwrap'),
  application_build TEXT NOT NULL,
  UNIQUE (user_id, policy_set_id)
);

CREATE INDEX IF NOT EXISTS idx_policy_acceptances_user
  ON policy_acceptances(user_id, accepted_at);
