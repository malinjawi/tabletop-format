-- Controlled-beta admission. Invite tokens are high-entropy bearer secrets;
-- only their SHA-256 digests are stored. Each invitation is single-use,
-- independently expiring, and independently revocable.

CREATE TABLE IF NOT EXISTS pilot_invites (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT,
  cohort_id    TEXT,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  revoked_at   BIGINT,
  redeemed_at  BIGINT,
  redeemed_by  TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_pilot_invites_expires ON pilot_invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_pilot_invites_redeemed ON pilot_invites(redeemed_at);
