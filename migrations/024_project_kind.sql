-- 024: durable repository collaboration classification. Absence or legacy
-- metadata is always an ordinary owned project; only a protected, explicit
-- repository declaration may opt an ownerless public demo into sandbox mode.
ALTER TABLE games ADD COLUMN project_kind TEXT NOT NULL DEFAULT 'owned'
  CHECK (project_kind IN ('owned', 'public-sandbox'));
