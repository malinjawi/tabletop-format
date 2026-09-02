-- 013: freeze the complete per-file rights audit alongside every release.
ALTER TABLE releases ADD COLUMN rights_json TEXT;
