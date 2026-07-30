-- 005: PR review verdicts (Store 2). A maintainer's approve / request-changes
-- sign-off on a PR — the human layer above the automatic diff/conflict check.
-- One (latest) verdict per reviewer per PR; re-reviewing replaces it.
-- Losing this DB never loses a game (DA-9): reviews are conversation, not content.
CREATE TABLE IF NOT EXISTS reviews (
  pr_id       TEXT NOT NULL REFERENCES prs(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  verdict     TEXT NOT NULL,             -- 'approve' | 'request_changes'
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (pr_id, reviewer_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_id);
