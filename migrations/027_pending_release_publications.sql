-- 027: durable release-publication journal.
--
-- A release crosses three durability boundaries: Store 3 exports, the
-- write-once artifact vault, and the protected repository tag.  This Store-2
-- row is written after the vault seal and before the tag.  If the process dies
-- after tagging, the exact release can be finalized from this row without
-- consulting HEAD or running an exporter again.
CREATE TABLE IF NOT EXISTS pending_release_publications (
  game_slug             TEXT NOT NULL REFERENCES games(slug),
  release_tag           TEXT NOT NULL,
  source_sha            TEXT NOT NULL CHECK (length(source_sha) IN (40, 64)),
  title                 TEXT,
  notes                 TEXT,
  author_id             TEXT REFERENCES users(id),
  artifacts_json        TEXT,
  rights_json           TEXT,
  build_json            TEXT,
  vault_format_version  INTEGER NOT NULL CHECK (vault_format_version >= 1),
  vault_binding_kind    TEXT NOT NULL CHECK (vault_binding_kind = 'tag-manifest'),
  vault_manifest_sha256 TEXT NOT NULL CHECK (length(vault_manifest_sha256) = 64),
  vault_sealed_at       BIGINT NOT NULL,
  event_id              TEXT NOT NULL,
  event_kind            TEXT NOT NULL,
  event_actor_id        TEXT REFERENCES users(id),
  created_at            BIGINT NOT NULL,
  finalized_at          BIGINT,
  PRIMARY KEY (game_slug, release_tag)
);

CREATE INDEX IF NOT EXISTS idx_pending_release_publications_open
  ON pending_release_publications(game_slug, finalized_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_release_publications_event
  ON pending_release_publications(event_id);
