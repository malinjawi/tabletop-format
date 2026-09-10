-- 023: append-only evidence that an exact frozen print artifact was delivered
-- to a named printer and either approved or rejected. Forge records the
-- maintainer's attestation; it does not impersonate or certify the printer.
CREATE TABLE IF NOT EXISTS print_deliveries (
  id                         TEXT PRIMARY KEY,
  game_slug                  TEXT NOT NULL,
  release_tag                TEXT NOT NULL,
  release_sha                TEXT NOT NULL,
  artifact_name              TEXT NOT NULL,
  artifact_sha256            TEXT NOT NULL,
  artifact_bytes             BIGINT NOT NULL,
  printer_name               TEXT NOT NULL,
  job_reference              TEXT NOT NULL,
  submission_evidence_url    TEXT,
  submission_evidence_sha256 TEXT,
  note                       TEXT,
  created_by                 TEXT REFERENCES users(id),
  created_at                 BIGINT NOT NULL,
  FOREIGN KEY (game_slug, release_tag) REFERENCES releases(game_slug, tag)
);
CREATE INDEX IF NOT EXISTS idx_print_deliveries_release
  ON print_deliveries(game_slug, release_tag, created_at);

-- One immutable terminal decision per delivery. If a printer asks for a new
-- file, the creator cuts a new release and records a new delivery instead of
-- rewriting the evidence attached to the old bytes.
CREATE TABLE IF NOT EXISTS print_delivery_decisions (
  id              TEXT PRIMARY KEY,
  delivery_id     TEXT NOT NULL UNIQUE REFERENCES print_deliveries(id),
  decision        TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reviewer_name   TEXT NOT NULL,
  organization    TEXT NOT NULL,
  evidence_url    TEXT,
  evidence_sha256 TEXT NOT NULL,
  note            TEXT,
  recorded_by     TEXT REFERENCES users(id),
  created_at      BIGINT NOT NULL
);
