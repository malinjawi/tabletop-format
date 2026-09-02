-- 012: a release records the real annotated/protected repository tag and the
-- immutable artifact receipt created before publication.
ALTER TABLE releases ADD COLUMN tag_object_sha TEXT;
ALTER TABLE releases ADD COLUMN tag_annotated INTEGER;
ALTER TABLE releases ADD COLUMN tag_protected INTEGER;
ALTER TABLE releases ADD COLUMN artifacts_json TEXT;
