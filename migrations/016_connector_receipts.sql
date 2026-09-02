-- Version every working-copy adapter contract and index the last exact
-- promotion receipt. The full receipt lives in Git beside the game source.
ALTER TABLE sync_sources ADD COLUMN adapter_id TEXT;
ALTER TABLE sync_sources ADD COLUMN adapter_version INTEGER;
ALTER TABLE sync_sources ADD COLUMN mapping_json TEXT;
ALTER TABLE sync_sources ADD COLUMN last_receipt_sha TEXT;
