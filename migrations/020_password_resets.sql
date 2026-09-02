-- Operator-assisted account recovery for the controlled beta. Raw reset
-- bearer tokens are never persisted. Issuing a newer token revokes older
-- outstanding tokens for the same account.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  revoked_at   BIGINT,
  redeemed_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_reset_tokens(expires_at);
