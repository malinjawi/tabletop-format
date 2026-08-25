-- 010: safe Sheet working-copy candidate metadata.
-- last_sha is the Forge commit built from the previous Sheet candidate (the
-- three-way merge base). source_hash/source_revision identify its exact draft
-- snapshot so a later commit cannot differ from what the editor reviewed.
ALTER TABLE sync_sources ADD COLUMN source_hash TEXT;
ALTER TABLE sync_sources ADD COLUMN source_revision TEXT;
