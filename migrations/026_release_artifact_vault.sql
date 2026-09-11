-- 026: durable, write-once release artifact vault association.
--
-- Store 3 remains a disposable render/export cache.  This table binds a
-- published Store-2 release to the canonical manifest in the durable release
-- vault without changing the legacy releases table or its import path.
CREATE TABLE IF NOT EXISTS release_artifact_vaults (
  game_slug       TEXT NOT NULL,
  release_tag     TEXT NOT NULL,
  format_version  INTEGER NOT NULL CHECK (format_version >= 1),
  binding_kind    TEXT NOT NULL CHECK (binding_kind IN ('tag-manifest', 'db-receipt')),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  sealed_at       BIGINT NOT NULL,
  PRIMARY KEY (game_slug, release_tag),
  FOREIGN KEY (game_slug, release_tag) REFERENCES releases(game_slug, tag)
);

CREATE INDEX IF NOT EXISTS idx_release_artifact_vault_manifest
  ON release_artifact_vaults(manifest_sha256);
