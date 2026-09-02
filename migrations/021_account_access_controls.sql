-- Controlled-beta participant offboarding. Suspension never deletes authored
-- work or identity; it only denies authentication and revokes bearer access.

ALTER TABLE users ADD COLUMN suspended_at BIGINT;
ALTER TABLE users ADD COLUMN suspension_reason TEXT;

CREATE TABLE IF NOT EXISTS account_access_events (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL CHECK (action IN ('suspend', 'restore')),
  operator_name TEXT NOT NULL,
  reason        TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_access_events_user
  ON account_access_events(user_id, created_at);
