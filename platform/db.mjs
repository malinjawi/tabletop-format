/**
 * db.mjs — Store-2 database adapter (DATA-ARCHITECTURE.md, Slice 1).
 *
 * Dev engine: node:sqlite (zero deps, real SQL). Prod engine: Postgres —
 * the migrations are written in the compatible subset, so the swap is a
 * driver change behind this module, not a schema change. Losing this DB
 * must never lose a game (DA-9): it holds people & conversation only,
 * and `games` is a rebuildable index (DA-3 — see reindexGames in server).
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { validPolicySet } from "./policy-acceptance.mjs";
import { normalizePersonalData, personalDataQueries } from "./personal-data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function openDb(path = process.env.DB_PATH ?? join(ROOT, "data", "platform.db")) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(db.prepare("SELECT name FROM schema_migrations").all().map(r => r.name));
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    if (applied.has(f)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(join(dir, f), "utf8"));
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, Date.now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export const newId = (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`;

function releaseVaultError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizedVault(vault, release, now = Date.now(), defaultBindingKind = "tag-manifest") {
  const formatVersion = Number(vault?.format_version);
  const bindingKind = String(vault?.binding_kind || defaultBindingKind);
  const manifestSha256 = String(vault?.manifest_sha256 || "").toLowerCase();
  if (!Number.isSafeInteger(formatVersion) || formatVersion < 1
    || !["tag-manifest", "db-receipt"].includes(bindingKind)
    || !/^[0-9a-f]{64}$/.test(manifestSha256))
    throw releaseVaultError("FORGE_RELEASE_VAULT_INVALID", "invalid release vault association");
  return { game_slug: release.game_slug, release_tag: release.tag,
    format_version: formatVersion, binding_kind: bindingKind, manifest_sha256: manifestSha256,
    sealed_at: Number.isSafeInteger(vault?.sealed_at) ? vault.sealed_at : now };
}

function normalizedLegacyVault(vault, release, now = Date.now()) {
  if (vault?.binding_kind != null && vault.binding_kind !== "db-receipt")
    throw releaseVaultError("FORGE_RELEASE_VAULT_INVALID",
      "legacy release vault attachments must use database-receipt evidence");
  return normalizedVault({ ...vault, binding_kind: "db-receipt" }, release, now, "db-receipt");
}

function sameRelease(row, release) {
  const expected = {
    sha: release.sha, title: release.title ?? null, notes: release.notes ?? null,
    author_id: release.author_id ?? null, tag_object_sha: release.tag_object_sha ?? null,
    tag_annotated: release.tag_annotated ? 1 : 0, tag_protected: release.tag_protected ? 1 : 0,
    artifacts_json: release.artifacts_json ?? null, rights_json: release.rights_json ?? null,
    build_json: release.build_json ?? null,
  };
  return !!row && Object.entries(expected).every(([key, value]) =>
    key === "tag_annotated" || key === "tag_protected"
      ? Number(row[key]) === value
      : (row[key] ?? null) === value);
}

function sameVault(row, vault) {
  return !!row && Number(row.format_version) === vault.format_version
    && row.binding_kind === vault.binding_kind
    && row.manifest_sha256 === vault.manifest_sha256;
}

function sameReleaseEvent(row, event, release) {
  return !!row && row.kind === (event.kind || "release")
    && (row.actor_id ?? null) === (event.actor_id ?? release.author_id ?? null)
    && row.game_slug === release.game_slug && row.target === release.tag;
}

function releasePublicationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function rejectOpenPendingPublication(db, gameSlug, tag) {
  const pending = db.prepare(
    `SELECT 1 FROM pending_release_publications
     WHERE game_slug = ? AND release_tag = ? AND finalized_at IS NULL`)
    .get(gameSlug, tag);
  if (pending) throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
    `release ${tag} already has a prepared publication`);
}

function requiredPublicationText(value, name, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw releasePublicationError("FORGE_RELEASE_PUBLICATION_INVALID", `invalid ${name}`);
  return value;
}

function optionalPublicationText(value, name, max = 100_000) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > max)
    throw releasePublicationError("FORGE_RELEASE_PUBLICATION_INVALID", `invalid ${name}`);
  return value;
}

function publicationJson(value, name) {
  const text = optionalPublicationText(value, name, 5_000_000);
  if (text != null) {
    try { JSON.parse(text); }
    catch { throw releasePublicationError("FORGE_RELEASE_PUBLICATION_INVALID", `invalid ${name}`); }
  }
  return text;
}

function publicationTimestamp(value, fallback, name) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw releasePublicationError("FORGE_RELEASE_PUBLICATION_INVALID", `invalid ${name}`);
  return number;
}

function pendingPublicationIdentity(publication) {
  const release = publication?.release || publication || {};
  return {
    game_slug: requiredPublicationText(release.game_slug ?? publication?.game_slug, "game slug", 256),
    release_tag: requiredPublicationText(release.tag ?? publication?.release_tag ?? publication?.tag,
      "release tag", 256),
  };
}

function normalizedPendingPublication(publication, existing = null, now = Date.now()) {
  const release = publication?.release || publication || {};
  const vault = publication?.vault || publication || {};
  const event = publication?.event || publication || {};
  const identity = pendingPublicationIdentity(publication);
  const sourceSha = requiredPublicationText(
    release.sha ?? publication?.source_sha ?? publication?.sha, "source sha", 64).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceSha))
    throw releasePublicationError("FORGE_RELEASE_PUBLICATION_INVALID", "invalid source sha");
  const formatVersion = Number(vault.format_version ?? publication?.vault_format_version);
  const bindingKind = vault.binding_kind ?? publication?.vault_binding_kind ?? "tag-manifest";
  const manifestSha256 = requiredPublicationText(
    vault.manifest_sha256 ?? publication?.vault_manifest_sha256, "vault manifest digest", 64).toLowerCase();
  if (!Number.isSafeInteger(formatVersion) || formatVersion < 1
    || bindingKind !== "tag-manifest"
    || !/^[0-9a-f]{64}$/.test(manifestSha256))
    throw releasePublicationError("FORGE_RELEASE_PUBLICATION_INVALID", "invalid release vault evidence");
  const createdAt = publicationTimestamp(publication?.created_at,
    existing ? Number(existing.created_at) : now, "publication creation time");
  const sealedAt = publicationTimestamp(vault.sealed_at ?? publication?.vault_sealed_at,
    existing ? Number(existing.vault_sealed_at) : createdAt, "vault seal time");
  const authorId = optionalPublicationText(release.author_id ?? publication?.author_id,
    "release author", 256);
  return {
    ...identity,
    source_sha: sourceSha,
    title: optionalPublicationText(release.title ?? publication?.title, "release title", 2_000),
    notes: optionalPublicationText(release.notes ?? publication?.notes, "release notes"),
    author_id: authorId,
    artifacts_json: publicationJson(release.artifacts_json ?? publication?.artifacts_json, "artifacts json"),
    rights_json: publicationJson(release.rights_json ?? publication?.rights_json, "rights json"),
    build_json: publicationJson(release.build_json ?? publication?.build_json, "build json"),
    vault_format_version: formatVersion,
    vault_binding_kind: bindingKind,
    vault_manifest_sha256: manifestSha256,
    vault_sealed_at: sealedAt,
    event_id: requiredPublicationText(event.id ?? publication?.event_id, "release event id", 256),
    event_kind: requiredPublicationText(event.kind ?? publication?.event_kind ?? "release",
      "release event kind", 128),
    event_actor_id: optionalPublicationText(
      event.actor_id ?? publication?.event_actor_id ?? authorId, "release event actor", 256),
    created_at: createdAt,
  };
}

function samePendingPublication(row, pending) {
  if (!row) return false;
  const textFields = ["game_slug", "release_tag", "source_sha", "title", "notes", "author_id",
    "artifacts_json", "rights_json", "build_json", "vault_binding_kind", "vault_manifest_sha256", "event_id",
    "event_kind", "event_actor_id"];
  return textFields.every(key => (row[key] ?? null) === (pending[key] ?? null))
    && Number(row.vault_format_version) === pending.vault_format_version
    && Number(row.vault_sealed_at) === pending.vault_sealed_at
    && Number(row.created_at) === pending.created_at;
}

function normalizedTagPublicationEvidence(input) {
  const gameSlug = requiredPublicationText(input?.game_slug, "game slug", 256);
  const tag = requiredPublicationText(input?.tag ?? input?.release_tag, "release tag", 256);
  const tagObjectSha = requiredPublicationText(input?.tag_object_sha, "tag object sha", 64).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tagObjectSha)
    || input?.tag_annotated !== true || input?.tag_protected !== true)
    throw releasePublicationError("FORGE_RELEASE_PUBLICATION_INVALID",
      "finalization requires an exact protected annotated tag");
  return { game_slug: gameSlug, tag, tag_object_sha: tagObjectSha,
    tag_annotated: true, tag_protected: true };
}

function finalizedPublicationParts(pending, tagEvidence) {
  return {
    release: {
      game_slug: pending.game_slug, tag: pending.release_tag, sha: pending.source_sha,
      title: pending.title, notes: pending.notes, author_id: pending.author_id,
      tag_object_sha: tagEvidence.tag_object_sha, tag_annotated: true, tag_protected: true,
      artifacts_json: pending.artifacts_json, rights_json: pending.rights_json,
      build_json: pending.build_json,
    },
    vault: {
      game_slug: pending.game_slug, release_tag: pending.release_tag,
      format_version: Number(pending.vault_format_version),
      binding_kind: pending.vault_binding_kind,
      manifest_sha256: pending.vault_manifest_sha256, sealed_at: Number(pending.vault_sealed_at),
    },
    event: {
      id: pending.event_id, kind: pending.event_kind, actor_id: pending.event_actor_id,
      game_slug: pending.game_slug, target: pending.release_tag,
    },
  };
}

function sameFinalizedPublication(releaseRow, vaultRow, eventRow, pending, evidence) {
  const parts = finalizedPublicationParts(pending, evidence);
  return sameRelease(releaseRow, parts.release)
    && Number(releaseRow?.created_at) === Number(pending.created_at)
    && sameVault(vaultRow, parts.vault)
    && Number(vaultRow?.sealed_at) === Number(pending.vault_sealed_at)
    && sameReleaseEvent(eventRow, parts.event, parts.release)
    && Number(eventRow?.created_at) === Number(pending.created_at);
}

function recordPolicyAcceptance(db, userId, acceptance, now) {
  const set = acceptance?.policy_set;
  if (!validPolicySet(set) || !acceptance?.id || !String(acceptance.application_build || "").trim())
    throw Object.assign(new Error("exact policy acceptance is required"), { code: "FORGE_POLICY_REQUIRED" });
  db.prepare(
    `INSERT INTO policy_sets (id, terms_text, privacy_text, community_text, notice_text,
       terms_sha256, privacy_sha256, community_sha256, notice_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`).run(set.id, set.terms_text, set.privacy_text, set.community_text,
      set.notice_text, set.terms_sha256, set.privacy_sha256, set.community_sha256, set.notice_sha256, now);
  db.prepare(
    `INSERT INTO policy_acceptances (id, user_id, policy_set_id, accepted_at, method, application_build)
     VALUES (?, ?, ?, ?, 'clickwrap', ?)`).run(acceptance.id, userId, set.id, now, acceptance.application_build);
}

/* ---- typed helpers (the only SQL surface the routes may touch) ---- */
export const q = {
  createUser: (db, u) => db.prepare(
    `INSERT INTO users (id, handle, email, display_name, pass_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`).run(u.id, u.handle, u.email, u.display_name ?? u.handle, u.pass_hash, Date.now()),
  createUserWithPolicyAcceptance: (db, u, acceptance, now = Date.now()) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO users (id, handle, email, display_name, pass_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`).run(u.id, u.handle, u.email, u.display_name ?? u.handle, u.pass_hash, now);
      recordPolicyAcceptance(db, u.id, acceptance, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  createPilotInvite: (db, invite) => db.prepare(
    `INSERT INTO pilot_invites (id, token_hash, label, cohort_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`).run(invite.id, invite.token_hash, invite.label ?? null,
      invite.cohort_id ?? null, invite.created_at, invite.expires_at),
  pilotInvites: (db, now = Date.now()) => db.prepare(
    `SELECT i.id, i.label, i.cohort_id, i.created_at, i.expires_at, i.revoked_at,
            i.redeemed_at, u.handle AS redeemed_handle,
            CASE WHEN i.redeemed_at IS NOT NULL THEN 'redeemed'
                 WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN i.expires_at <= ? THEN 'expired' ELSE 'available' END AS status
     FROM pilot_invites i LEFT JOIN users u ON u.id = i.redeemed_by
     ORDER BY i.created_at DESC`).all(now),
  revokePilotInvite: (db, id, now = Date.now()) => db.prepare(
    `UPDATE pilot_invites SET revoked_at = ?
     WHERE id = ? AND revoked_at IS NULL AND redeemed_at IS NULL`).run(now, id),
  registerUserWithInvite: (db, u, tokenHash, acceptance, now = Date.now()) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const invite = db.prepare(
        `SELECT id FROM pilot_invites
         WHERE token_hash = ? AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?`).get(tokenHash, now);
      if (!invite) {
        throw Object.assign(new Error("invite is invalid or no longer available"),
          { code: "FORGE_INVITE_INVALID" });
      }
      db.prepare(
        `INSERT INTO users (id, handle, email, display_name, pass_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`).run(u.id, u.handle, u.email, u.display_name ?? u.handle, u.pass_hash, now);
      recordPolicyAcceptance(db, u.id, acceptance, now);
      const claimed = db.prepare(
        `UPDATE pilot_invites SET redeemed_at = ?, redeemed_by = ?
         WHERE id = ? AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?`)
        .run(now, u.id, invite.id, now);
      if (claimed.changes !== 1) {
        throw Object.assign(new Error("invite is invalid or no longer available"),
          { code: "FORGE_INVITE_INVALID" });
      }
      db.exec("COMMIT");
      return { id: invite.id };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  issuePasswordReset: (db, reset, now = Date.now()) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const active = db.prepare("SELECT id FROM users WHERE id = ? AND suspended_at IS NULL").get(reset.user_id);
      if (!active) throw Object.assign(new Error("account is suspended or unavailable"),
        { code: "FORGE_ACCOUNT_SUSPENDED" });
      db.prepare(
        `UPDATE password_reset_tokens SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL AND redeemed_at IS NULL`).run(now, reset.user_id);
      db.prepare(
        `INSERT INTO password_reset_tokens (id, token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`).run(reset.id, reset.token_hash, reset.user_id, reset.created_at, reset.expires_at);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  passwordResets: (db, now = Date.now()) => db.prepare(
    `SELECT r.id, r.created_at, r.expires_at, r.revoked_at, r.redeemed_at, u.handle,
            CASE WHEN r.redeemed_at IS NOT NULL THEN 'redeemed'
                 WHEN r.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN r.expires_at <= ? THEN 'expired' ELSE 'available' END AS status
     FROM password_reset_tokens r JOIN users u ON u.id = r.user_id
     ORDER BY r.created_at DESC`).all(now),
  revokePasswordReset: (db, id, now = Date.now()) => db.prepare(
    `UPDATE password_reset_tokens SET revoked_at = ?
     WHERE id = ? AND revoked_at IS NULL AND redeemed_at IS NULL`).run(now, id),
  resetPasswordWithToken: (db, tokenHash, passHash, now = Date.now()) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const reset = db.prepare(
        `SELECT r.id, r.user_id FROM password_reset_tokens r
         JOIN users u ON u.id = r.user_id
         WHERE r.token_hash = ? AND r.revoked_at IS NULL AND r.redeemed_at IS NULL
           AND r.expires_at > ? AND u.suspended_at IS NULL`).get(tokenHash, now);
      if (!reset) throw Object.assign(new Error("reset is invalid or no longer available"),
        { code: "FORGE_RESET_INVALID" });
      db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(passHash, reset.user_id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(reset.user_id);
      const claimed = db.prepare(
        `UPDATE password_reset_tokens SET redeemed_at = ?
         WHERE id = ? AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?`)
        .run(now, reset.id, now);
      if (claimed.changes !== 1) throw Object.assign(new Error("reset is invalid or no longer available"),
        { code: "FORGE_RESET_INVALID" });
      db.exec("COMMIT");
      return { id: reset.id, user_id: reset.user_id };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  userByHandle: (db, h) => db.prepare("SELECT * FROM users WHERE handle = ?").get(h),
  userByEmail:  (db, e) => db.prepare("SELECT * FROM users WHERE email = ?").get(e),
  userById:     (db, id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id),
  policyAcceptancesByUser: (db, userId) => db.prepare(
    `SELECT a.id, a.policy_set_id, a.accepted_at, a.method, a.application_build,
            s.terms_sha256, s.privacy_sha256, s.community_sha256, s.notice_sha256
     FROM policy_acceptances a JOIN policy_sets s ON s.id = a.policy_set_id
     WHERE a.user_id = ? ORDER BY a.accepted_at DESC`).all(userId),
  policyAcceptanceEvidenceByUser: (db, userId) => db.prepare(
    `SELECT a.id, a.policy_set_id, a.accepted_at, a.method, a.application_build,
            s.terms_text, s.privacy_text, s.community_text, s.notice_text,
            s.terms_sha256, s.privacy_sha256, s.community_sha256, s.notice_sha256
     FROM policy_acceptances a JOIN policy_sets s ON s.id = a.policy_set_id
     WHERE a.user_id = ? ORDER BY a.accepted_at DESC`).all(userId),
  personalDataExport: (db, userId) => normalizePersonalData(Object.fromEntries(
    Object.entries(personalDataQueries("?")).map(([key, query]) => [key,
      query.one ? db.prepare(query.sql).get(userId) : db.prepare(query.sql).all(userId)]))),

  accountAccessByHandle: (db, handle) => db.prepare(
    `SELECT id, handle, created_at, suspended_at, suspension_reason,
            CASE WHEN suspended_at IS NULL THEN 'active' ELSE 'suspended' END AS status
     FROM users WHERE handle = ?`).get(handle),
  accountAccessEvents: (db, userId) => db.prepare(
    `SELECT id, action, operator_name, reason, created_at
     FROM account_access_events WHERE user_id = ? ORDER BY created_at DESC`).all(userId),
  setAccountSuspended: (db, change, now = Date.now()) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = change.suspended
        ? db.prepare(
          `UPDATE users SET suspended_at = ?, suspension_reason = ?
           WHERE id = ? AND suspended_at IS NULL`).run(now, change.reason, change.user_id)
        : db.prepare(
          `UPDATE users SET suspended_at = NULL, suspension_reason = NULL
           WHERE id = ? AND suspended_at IS NOT NULL`).run(change.user_id);
      if (result.changes !== 1) throw Object.assign(new Error("account is already in the requested state"),
        { code: "FORGE_ACCOUNT_STATE" });
      if (change.suspended) {
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(change.user_id);
        db.prepare(
          `UPDATE password_reset_tokens SET revoked_at = ?
           WHERE user_id = ? AND revoked_at IS NULL AND redeemed_at IS NULL`).run(now, change.user_id);
      }
      db.prepare(
        `INSERT INTO account_access_events (id, user_id, action, operator_name, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`).run(change.id, change.user_id,
          change.suspended ? "suspend" : "restore", change.operator_name, change.reason, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },

  createSession: (db, token, userId, ttlMs) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const active = db.prepare("SELECT id FROM users WHERE id = ? AND suspended_at IS NULL").get(userId);
      if (!active) throw Object.assign(new Error("account is suspended or unavailable"),
        { code: "FORGE_ACCOUNT_SUSPENDED" });
      const now = Date.now();
      db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run(token, userId, now, now + ttlMs);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  sessionUser: (db, token) => db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.suspended_at IS NULL`).get(token, Date.now()),
  sessionsFor: (db, userId) => db.prepare(
    "SELECT substr(token, 1, 16) AS id, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC")
    .all(userId, Date.now()),
  revokeSession: (db, userId, tokenPrefix) => db.prepare(
    "DELETE FROM sessions WHERE user_id = ? AND substr(token, 1, 16) = ?").run(userId, tokenPrefix),
  revokeAllSessions: (db, userId) => db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId),
  pruneSessions: (db) => db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now()),

  upsertGame: (db, g) => db.prepare(
    `INSERT INTO games (slug, project_id, namespace, repo_slug, repo_id, title, license, card_count, description, topics_json, players_min, players_max, visibility, owner_id, project_kind, updated_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET title=excluded.title, license=excluded.license,
       project_id=excluded.project_id, namespace=excluded.namespace, repo_slug=excluded.repo_slug,
       repo_id=excluded.repo_id, card_count=excluded.card_count, description=excluded.description,
       topics_json=excluded.topics_json, players_min=excluded.players_min, players_max=excluded.players_max,
       visibility=excluded.visibility,
       project_kind=CASE WHEN games.owner_id IS NOT NULL OR excluded.owner_id IS NOT NULL
                         THEN 'owned' ELSE excluded.project_kind END,
       owner_id=COALESCE(games.owner_id, excluded.owner_id),
       updated_at=excluded.updated_at, indexed_at=excluded.indexed_at`)
    .run(g.slug, g.project_id, g.namespace, g.repo_slug, g.repo_id ?? null,
      g.title, g.license ?? null, g.card_count ?? null, g.description ?? "", g.topics_json ?? "[]",
      g.players_min ?? null, g.players_max ?? null, g.visibility ?? "public", g.owner_id ?? null,
      !g.owner_id && g.project_kind === "public-sandbox" ? "public-sandbox" : "owned", Date.now(), Date.now()),
  // Forgejo discovery is an authoritative ownership boundary. Update the
  // searchable metadata, exact owner, and transfer-sensitive grants in one
  // transaction so no request can observe new repository metadata with the
  // prior owner's access still attached.
  reindexHostedGame: (db, g) => {
    const nextOwner = g.owner_id ?? null;
    const nextKind = nextOwner == null && g.project_kind === "public-sandbox"
      ? "public-sandbox" : "owned";
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const before = db.prepare("SELECT owner_id FROM games WHERE slug = ?").get(g.slug);
      const changedOwner = !!before && (before.owner_id ?? null) !== nextOwner;
      db.prepare(
        `INSERT INTO games (slug, project_id, namespace, repo_slug, repo_id, title, license, card_count, description, topics_json, players_min, players_max, visibility, owner_id, project_kind, updated_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET title=excluded.title, license=excluded.license,
           project_id=excluded.project_id, namespace=excluded.namespace, repo_slug=excluded.repo_slug,
           repo_id=excluded.repo_id, card_count=excluded.card_count, description=excluded.description,
           topics_json=excluded.topics_json, players_min=excluded.players_min, players_max=excluded.players_max,
           visibility=excluded.visibility, owner_id=excluded.owner_id, project_kind=excluded.project_kind,
           updated_at=excluded.updated_at, indexed_at=excluded.indexed_at`)
        .run(g.slug, g.project_id, g.namespace, g.repo_slug, g.repo_id ?? null,
          g.title, g.license ?? null, g.card_count ?? null, g.description ?? "", g.topics_json ?? "[]",
          g.players_min ?? null, g.players_max ?? null, g.visibility ?? "public", nextOwner,
          nextKind, now, now);
      if (changedOwner) db.prepare("DELETE FROM collaborators WHERE game_slug = ?").run(g.slug);
      db.exec("COMMIT");
      return { changedOwner, owner_id: nextOwner, project_kind: nextKind };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  tombstoneGameIndex: (db, slug) => db.prepare(
    `UPDATE games SET visibility = 'private', card_count = 0,
       description = '', topics_json = '[]', players_min = NULL,
       players_max = NULL, indexed_at = ? WHERE slug = ?`).run(Date.now(), slug),
  listGames: (db) => db.prepare(
    `SELECT g.*, u.handle AS owner_handle,
            (SELECT COUNT(*) FROM stars s WHERE s.game_slug = g.slug) AS stars
     FROM games g LEFT JOIN users u ON u.id = g.owner_id
     ORDER BY stars DESC, g.updated_at DESC`).all(),
  gamesOwnedBy: (db, userId) => db.prepare(
    "SELECT slug FROM games WHERE owner_id = ? ORDER BY updated_at DESC").all(userId).map(r => r.slug),
  setForkMeta: (db, slug, forkedFrom, ownerId) => db.prepare(
    "UPDATE games SET forked_from = ?, owner_id = ?, project_kind = 'owned' WHERE slug = ?").run(forkedFrom, ownerId, slug),

  star:   (db, userId, slug) => db.prepare(
    `INSERT INTO stars (user_id, game_slug, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, game_slug) DO NOTHING`).run(userId, slug, Date.now()),
  unstar: (db, userId, slug) => db.prepare(
    "DELETE FROM stars WHERE user_id = ? AND game_slug = ?").run(userId, slug),
  starCount: (db, slug) => db.prepare(
    "SELECT COUNT(*) AS n FROM stars WHERE game_slug = ?").get(slug).n,
  starredBy: (db, userId) => db.prepare(
    "SELECT game_slug FROM stars WHERE user_id = ? ORDER BY created_at DESC").all(userId),

  gameBySlug: (db, slug) => db.prepare("SELECT * FROM games WHERE slug = ?").get(slug),
  gameByProject: (db, namespace, repoSlug) => db.prepare(
    "SELECT * FROM games WHERE namespace = ? AND repo_slug = ?").get(namespace, repoSlug),
  gameByProjectId: (db, projectId) => db.prepare(
    "SELECT * FROM games WHERE project_id = ?").get(projectId),
  gameByRepoId: (db, repoId) => db.prepare(
    "SELECT * FROM games WHERE repo_id = ?").get(repoId),
  reconcileIndexedOwner: (db, { slug, owner_id, project_kind = "owned" }) => {
    const nextOwner = owner_id ?? null;
    const nextKind = nextOwner == null && project_kind === "public-sandbox" ? "public-sandbox" : "owned";
    db.exec("BEGIN IMMEDIATE");
    try {
      const before = db.prepare("SELECT owner_id FROM games WHERE slug = ?").get(slug);
      if (!before) throw new Error(`cannot reconcile owner for missing project '${slug}'`);
      const changed = (before.owner_id ?? null) !== nextOwner;
      db.prepare("UPDATE games SET owner_id = ?, project_kind = ? WHERE slug = ?")
        .run(nextOwner, nextKind, slug);
      // Collaborator grants belong to the prior ownership boundary. A transfer
      // or an unresolved new Forgejo owner must not carry them forward.
      if (changed) db.prepare("DELETE FROM collaborators WHERE game_slug = ?").run(slug);
      db.exec("COMMIT");
      return { changed, owner_id: nextOwner, project_kind: nextKind };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },

  createPr: (db, pr) => db.prepare(
    `INSERT INTO prs (id, to_slug, from_slug, title, body, author_id, status, base, proposed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(pr.id, pr.to_slug, pr.from_slug, pr.title, pr.body ?? null, pr.author_id, pr.base, pr.proposed, Date.now()),
  refreshPr: (db, id, title, base, proposed) => db.prepare(
    "UPDATE prs SET title = ?, base = ?, proposed = ? WHERE id = ? AND status = 'open'")
    .run(title, base, proposed, id),
  prById: (db, id) => db.prepare(
    `SELECT p.*, u.handle AS author_handle, u.email AS author_email FROM prs p JOIN users u ON u.id = p.author_id
     WHERE p.id = ?`).get(id),
  prsFor: (db, slug) => db.prepare(
    `SELECT p.id, p.from_slug, p.title, p.status, p.created_at, p.merged_at, u.handle AS author_handle
     FROM prs p JOIN users u ON u.id = p.author_id
     WHERE p.to_slug = ? ORDER BY p.created_at DESC`).all(slug),
  setPrStatus: (db, id, status, mergeSha) => db.prepare(
    "UPDATE prs SET status = ?, merged_at = ?, merge_sha = ? WHERE id = ?")
    .run(status, status === "merged" ? Date.now() : null, mergeSha ?? null, id),

  addCollaborator: (db, slug, userId, addedBy, role = "maintainer") => db.prepare(
    `INSERT INTO collaborators (game_slug, user_id, role, added_by, added_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(game_slug, user_id) DO UPDATE SET role=excluded.role, added_by=excluded.added_by, added_at=excluded.added_at`)
    .run(slug, userId, role, addedBy, Date.now()),
  removeCollaborator: (db, slug, userId) => db.prepare(
    "DELETE FROM collaborators WHERE game_slug = ? AND user_id = ?").run(slug, userId),
  isCollaborator: (db, slug, userId) => db.prepare(
    "SELECT 1 AS y FROM collaborators WHERE game_slug = ? AND user_id = ?").get(slug, userId),
  collaboratorRole: (db, slug, userId) => db.prepare(
    "SELECT role FROM collaborators WHERE game_slug = ? AND user_id = ?").get(slug, userId)?.role ?? null,
  collaboratorsOf: (db, slug) => db.prepare(
    `SELECT u.handle, c.role, c.added_at FROM collaborators c JOIN users u ON u.id = c.user_id
     WHERE c.game_slug = ? ORDER BY c.added_at`).all(slug),

  nextIssueNumber: (db, slug) => (db.prepare(
    "SELECT COALESCE(MAX(number),0)+1 AS n FROM issues WHERE game_slug = ?").get(slug)).n,
  createIssue: (db, i) => db.prepare(
    `INSERT INTO issues (id, game_slug, number, title, body, author_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`).run(i.id, i.game_slug, i.number, i.title, i.body ?? null, i.author_id, Date.now()),
  issuesFor: (db, slug) => db.prepare(
    `SELECT i.*, u.handle AS author_handle,
            (SELECT COUNT(*) FROM comments c WHERE c.target_type='issue' AND c.target_id=i.id) AS comment_count
     FROM issues i JOIN users u ON u.id = i.author_id
     WHERE i.game_slug = ? ORDER BY i.number DESC`).all(slug),
  issueByNumber: (db, slug, number) => db.prepare(
    `SELECT i.*, u.handle AS author_handle FROM issues i JOIN users u ON u.id = i.author_id
     WHERE i.game_slug = ? AND i.number = ?`).get(slug, number),
  setIssueStatus: (db, id, status) => db.prepare(
    "UPDATE issues SET status = ?, closed_at = ? WHERE id = ?").run(status, status === "closed" ? Date.now() : null, id),

  addComment: (db, c) => db.prepare(
    `INSERT INTO comments (id, target_type, target_id, author_id, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`).run(c.id, c.target_type, c.target_id, c.author_id, c.body, Date.now()),
  commentsFor: (db, targetType, targetId) => db.prepare(
    `SELECT c.body, c.created_at, u.handle AS author_handle FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.target_type = ? AND c.target_id = ? ORDER BY c.created_at`).all(targetType, targetId),

  addReview: (db, r) => db.prepare(
    `INSERT INTO reviews (pr_id, reviewer_id, verdict, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (pr_id, reviewer_id) DO UPDATE SET verdict = excluded.verdict, created_at = excluded.created_at`)
    .run(r.pr_id, r.reviewer_id, r.verdict, Date.now()),
  reviewsFor: (db, prId) => db.prepare(
    `SELECT rv.verdict, rv.created_at, u.handle AS reviewer_handle FROM reviews rv JOIN users u ON u.id = rv.reviewer_id
     WHERE rv.pr_id = ? ORDER BY rv.created_at`).all(prId),
  clearReviews: (db, prId) => db.prepare("DELETE FROM reviews WHERE pr_id = ?").run(prId),

  enterJam: (db, e) => db.prepare(
    `INSERT INTO jam_entries (jam_id, game_slug, user_id, submitted_at, qualified, award, state, release_tag, release_sha, receipt_json, team_json, replaced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (jam_id, game_slug) DO UPDATE SET user_id = excluded.user_id, submitted_at = excluded.submitted_at,
       qualified = excluded.qualified, state = excluded.state, release_tag = excluded.release_tag,
       release_sha = excluded.release_sha, receipt_json = excluded.receipt_json, team_json = excluded.team_json,
       replaced_at = excluded.replaced_at`)
    .run(e.jam_id, e.game_slug, e.user_id ?? null, Date.now(), e.qualified ? 1 : 0, e.award ?? null,
      e.state ?? "draft", e.release_tag ?? null, e.release_sha ?? null, e.receipt_json ?? null,
      e.team_json ?? null, e.replaced_at ?? null),
  jamEntriesFor: (db, jamId) => db.prepare(
    `SELECT je.jam_id, je.game_slug, je.user_id, je.submitted_at, je.qualified, je.award, je.state,
            je.release_tag, je.release_sha, je.receipt_json, je.team_json, je.replaced_at, je.disqualified_reason,
            g.title, g.forked_from, u.handle AS author_handle
     FROM jam_entries je LEFT JOIN games g ON g.slug = je.game_slug LEFT JOIN users u ON u.id = je.user_id
     WHERE je.jam_id = ? ORDER BY je.submitted_at`).all(jamId),
  jamEntryOf: (db, jamId, slug) => db.prepare(
    "SELECT * FROM jam_entries WHERE jam_id = ? AND game_slug = ?").get(jamId, slug),
  recordJamSubmission: (db, entry) => db.prepare(
    `INSERT INTO jam_submission_history (id, jam_id, game_slug, user_id, release_tag, release_sha, receipt_json, action, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entry.id, entry.jam_id, entry.game_slug, entry.user_id ?? null, entry.release_tag, entry.release_sha,
      entry.receipt_json, entry.action, Date.now()),
  jamSubmissionHistory: (db, jamId, slug) => db.prepare(
    "SELECT id, release_tag, release_sha, receipt_json, action, created_at FROM jam_submission_history WHERE jam_id = ? AND game_slug = ? ORDER BY created_at")
    .all(jamId, slug),
  recordJamAudit: (db, event) => db.prepare(
    `INSERT INTO jam_audit_events (id, jam_id, actor_id, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(event.id, event.jam_id, event.actor_id ?? null, event.action, event.target ?? null, event.detail_json ?? null, Date.now()),

  prepareReleasePublication: (db, publication) => {
    const identity = pendingPublicationIdentity(publication);
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare(
        `SELECT * FROM pending_release_publications
         WHERE game_slug = ? AND release_tag = ?`).get(identity.game_slug, identity.release_tag);
      const pending = normalizedPendingPublication(publication, existing);
      if (existing) {
        if (!samePendingPublication(existing, pending))
          throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
            `release ${identity.release_tag} already has different pending publication evidence`);
        if (existing.finalized_at == null
          && db.prepare("SELECT 1 FROM events WHERE id = ?").get(pending.event_id))
          throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
            `release event ${pending.event_id} is already recorded`);
        db.exec("COMMIT");
        return { prepared: false, ...existing };
      }
      if (db.prepare("SELECT 1 FROM releases WHERE game_slug = ? AND tag = ?")
        .get(identity.game_slug, identity.release_tag))
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
          `release ${identity.release_tag} is already published`);
      if (db.prepare("SELECT 1 FROM events WHERE id = ?").get(pending.event_id))
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
          `release event ${pending.event_id} is already recorded`);
      const eventReservation = db.prepare(
        "SELECT game_slug, release_tag FROM pending_release_publications WHERE event_id = ?")
        .get(pending.event_id);
      if (eventReservation)
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
          `release event ${pending.event_id} is already reserved by another publication`);
      db.prepare(
        `INSERT INTO pending_release_publications
           (game_slug, release_tag, source_sha, title, notes, author_id,
            artifacts_json, rights_json, build_json, vault_format_version,
            vault_binding_kind, vault_manifest_sha256, vault_sealed_at, event_id,
            event_kind, event_actor_id, created_at, finalized_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
          pending.game_slug, pending.release_tag, pending.source_sha, pending.title,
          pending.notes, pending.author_id, pending.artifacts_json, pending.rights_json,
          pending.build_json, pending.vault_format_version, pending.vault_binding_kind,
          pending.vault_manifest_sha256, pending.vault_sealed_at, pending.event_id, pending.event_kind,
          pending.event_actor_id, pending.created_at);
      db.exec("COMMIT");
      return { prepared: true, ...pending, finalized_at: null };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  pendingReleasePublication: (db, slug, tag) => db.prepare(
    `SELECT * FROM pending_release_publications
     WHERE game_slug = ? AND release_tag = ? AND finalized_at IS NULL`).get(slug, tag),
  releasePublicationEvent: (db, slug, tag) => db.prepare(
    `SELECT e.id, e.kind, e.actor_id, e.game_slug, e.target, e.created_at
     FROM pending_release_publications p
     JOIN events e ON e.id = p.event_id
     WHERE p.game_slug = ? AND p.release_tag = ? AND p.finalized_at IS NOT NULL`)
    .get(slug, tag) ?? null,
  finalizeReleasePublication: (db, input) => {
    const evidence = normalizedTagPublicationEvidence(input);
    db.exec("BEGIN IMMEDIATE");
    try {
      const pending = db.prepare(
        `SELECT * FROM pending_release_publications
         WHERE game_slug = ? AND release_tag = ?`).get(evidence.game_slug, evidence.tag);
      if (!pending)
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_NOT_FOUND",
          `release ${evidence.tag} has no prepared publication`);
      const releaseRow = db.prepare(
        "SELECT * FROM releases WHERE game_slug = ? AND tag = ?")
        .get(evidence.game_slug, evidence.tag);
      const vaultRow = db.prepare(
        "SELECT * FROM release_artifact_vaults WHERE game_slug = ? AND release_tag = ?")
        .get(evidence.game_slug, evidence.tag);
      const eventRow = db.prepare("SELECT * FROM events WHERE id = ?").get(pending.event_id);
      if (pending.finalized_at != null) {
        if (!sameFinalizedPublication(releaseRow, vaultRow, eventRow, pending, evidence))
          throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
            `release ${evidence.tag} finalization evidence does not match`);
        db.exec("COMMIT");
        return { finalized: false, release: releaseRow, vault: vaultRow, pending };
      }
      if (releaseRow || vaultRow || eventRow)
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
          `release ${evidence.tag} collides with existing publication state`);
      const parts = finalizedPublicationParts(pending, evidence);
      db.prepare(
        `INSERT INTO releases (game_slug, tag, sha, title, notes, author_id, created_at,
           tag_object_sha, tag_annotated, tag_protected, artifacts_json, rights_json, build_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`).run(
          parts.release.game_slug, parts.release.tag, parts.release.sha, parts.release.title,
          parts.release.notes, parts.release.author_id, pending.created_at,
          parts.release.tag_object_sha, parts.release.artifacts_json,
          parts.release.rights_json, parts.release.build_json);
      db.prepare(
        `INSERT INTO release_artifact_vaults
           (game_slug, release_tag, format_version, binding_kind, manifest_sha256, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?)`).run(parts.vault.game_slug, parts.vault.release_tag,
          parts.vault.format_version, parts.vault.binding_kind,
          parts.vault.manifest_sha256, parts.vault.sealed_at);
      db.prepare(
        `INSERT INTO events (id, kind, actor_id, game_slug, target, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`).run(parts.event.id, parts.event.kind,
          parts.event.actor_id, parts.event.game_slug, parts.event.target, pending.created_at);
      const finalizedAt = Date.now();
      db.prepare(
        `UPDATE pending_release_publications SET finalized_at = ?
         WHERE game_slug = ? AND release_tag = ? AND finalized_at IS NULL`)
        .run(finalizedAt, evidence.game_slug, evidence.tag);
      db.exec("COMMIT");
      return {
        finalized: true,
        release: { ...parts.release, created_at: Number(pending.created_at) },
        vault: parts.vault,
        pending: { ...pending, finalized_at: finalizedAt },
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  createRelease: (db, r) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      rejectOpenPendingPublication(db, r.game_slug, r.tag);
      const result = db.prepare(
        `INSERT INTO releases (game_slug, tag, sha, title, notes, author_id, created_at,
           tag_object_sha, tag_annotated, tag_protected, artifacts_json, rights_json, build_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.game_slug, r.tag, r.sha, r.title ?? null, r.notes ?? null, r.author_id ?? null, Date.now(),
          r.tag_object_sha ?? null, r.tag_annotated ? 1 : 0, r.tag_protected ? 1 : 0,
          r.artifacts_json ?? null, r.rights_json ?? null, r.build_json ?? null);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  attachReleaseVault: (db, association) => {
    const release = { game_slug: association.game_slug, tag: association.release_tag };
    const vault = normalizedLegacyVault(association, release);
    db.exec("BEGIN IMMEDIATE");
    try {
      rejectOpenPendingPublication(db, release.game_slug, release.tag);
      const existing = db.prepare(
        "SELECT * FROM release_artifact_vaults WHERE game_slug = ? AND release_tag = ?")
        .get(vault.game_slug, vault.release_tag);
      if (existing) {
        if (!sameVault(existing, vault))
          throw releaseVaultError("FORGE_RELEASE_VAULT_CONFLICT",
            `release ${vault.release_tag} already has a different vault manifest`);
        db.exec("COMMIT");
        return { attached: false, ...existing };
      }
      db.prepare(
        `INSERT INTO release_artifact_vaults
           (game_slug, release_tag, format_version, binding_kind, manifest_sha256, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?)`).run(vault.game_slug, vault.release_tag,
          vault.format_version, vault.binding_kind, vault.manifest_sha256, vault.sealed_at);
      db.exec("COMMIT");
      return { attached: true, ...vault };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  publishRelease: (db, publication) => {
    const release = publication?.release || {};
    const event = publication?.event || {};
    if (!event.id) throw releaseVaultError("FORGE_RELEASE_VAULT_INVALID",
      "release publication requires an event id");
    const now = Date.now(), vault = normalizedVault(publication?.vault, release, now);
    db.exec("BEGIN IMMEDIATE");
    try {
      rejectOpenPendingPublication(db, release.game_slug, release.tag);
      const existingRelease = db.prepare(
        "SELECT * FROM releases WHERE game_slug = ? AND tag = ?").get(release.game_slug, release.tag);
      if (existingRelease) {
        const existingVault = db.prepare(
          "SELECT * FROM release_artifact_vaults WHERE game_slug = ? AND release_tag = ?")
          .get(release.game_slug, release.tag);
        const existingEvent = db.prepare("SELECT * FROM events WHERE id = ?").get(event.id);
        if (!sameRelease(existingRelease, release) || !sameVault(existingVault, vault)
          || !sameReleaseEvent(existingEvent, event, release))
          throw releaseVaultError("FORGE_RELEASE_VAULT_CONFLICT",
            `release ${release.tag} is already published with different immutable evidence`);
        db.exec("COMMIT");
        return { published: false, release: existingRelease, vault: existingVault };
      }
      if (db.prepare("SELECT 1 FROM events WHERE id = ?").get(event.id))
        throw releaseVaultError("FORGE_RELEASE_VAULT_CONFLICT", "release event id is already in use");
      db.prepare(
        `INSERT INTO releases (game_slug, tag, sha, title, notes, author_id, created_at,
           tag_object_sha, tag_annotated, tag_protected, artifacts_json, rights_json, build_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          release.game_slug, release.tag, release.sha, release.title ?? null, release.notes ?? null,
          release.author_id ?? null, now, release.tag_object_sha ?? null,
          release.tag_annotated ? 1 : 0, release.tag_protected ? 1 : 0,
          release.artifacts_json ?? null, release.rights_json ?? null, release.build_json ?? null);
      db.prepare(
        `INSERT INTO release_artifact_vaults
           (game_slug, release_tag, format_version, binding_kind, manifest_sha256, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?)`).run(vault.game_slug, vault.release_tag,
          vault.format_version, vault.binding_kind, vault.manifest_sha256, vault.sealed_at);
      db.prepare(
        `INSERT INTO events (id, kind, actor_id, game_slug, target, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`).run(event.id, event.kind || "release",
          event.actor_id ?? release.author_id ?? null, release.game_slug, release.tag, now);
      db.exec("COMMIT");
      return { published: true, release: { ...release, created_at: now }, vault };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  releasesFor: (db, slug) => db.prepare(
    `SELECT rl.tag, rl.sha, rl.title, rl.created_at, rl.tag_object_sha,
            rl.tag_annotated, rl.tag_protected, rl.artifacts_json, rl.rights_json, rl.build_json,
            v.format_version AS vault_format_version, v.binding_kind AS vault_binding_kind,
            v.manifest_sha256 AS vault_manifest_sha256,
            v.sealed_at AS vault_sealed_at, u.handle AS author_handle
     FROM releases rl LEFT JOIN users u ON u.id = rl.author_id
     LEFT JOIN release_artifact_vaults v ON v.game_slug = rl.game_slug AND v.release_tag = rl.tag
     WHERE rl.game_slug = ? ORDER BY rl.created_at DESC`).all(slug),
  releaseByTag: (db, slug, tag) => db.prepare(
    `SELECT rl.*, v.format_version AS vault_format_version, v.binding_kind AS vault_binding_kind,
            v.manifest_sha256 AS vault_manifest_sha256,
            v.sealed_at AS vault_sealed_at, u.handle AS author_handle
     FROM releases rl LEFT JOIN users u ON u.id = rl.author_id
     LEFT JOIN release_artifact_vaults v ON v.game_slug = rl.game_slug AND v.release_tag = rl.tag
     WHERE rl.game_slug = ? AND rl.tag = ?`).get(slug, tag),

  createPrintDelivery: (db, d) => db.prepare(
    `INSERT INTO print_deliveries
       (id, game_slug, release_tag, release_sha, artifact_name, artifact_sha256, artifact_bytes,
        printer_name, job_reference, submission_evidence_url, submission_evidence_sha256,
        note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      d.id, d.game_slug, d.release_tag, d.release_sha, d.artifact_name, d.artifact_sha256,
      d.artifact_bytes, d.printer_name, d.job_reference, d.submission_evidence_url ?? null,
      d.submission_evidence_sha256 ?? null, d.note ?? null, d.created_by ?? null, Date.now()),
  printDeliveriesForRelease: (db, slug, tag) => db.prepare(
    `SELECT d.*, creator.handle AS created_by_handle,
            x.id AS decision_id, x.decision, x.reviewer_name, x.organization,
            x.evidence_url, x.evidence_sha256, x.note AS decision_note,
            x.created_at AS decided_at, recorder.handle AS recorded_by_handle
     FROM print_deliveries d
     LEFT JOIN users creator ON creator.id = d.created_by
     LEFT JOIN print_delivery_decisions x ON x.delivery_id = d.id
     LEFT JOIN users recorder ON recorder.id = x.recorded_by
     WHERE d.game_slug = ? AND d.release_tag = ? ORDER BY d.created_at DESC`).all(slug, tag),
  printDeliveryById: (db, id) => db.prepare(
    `SELECT d.*, creator.handle AS created_by_handle,
            x.id AS decision_id, x.decision, x.reviewer_name, x.organization,
            x.evidence_url, x.evidence_sha256, x.note AS decision_note,
            x.created_at AS decided_at, recorder.handle AS recorded_by_handle
     FROM print_deliveries d
     LEFT JOIN users creator ON creator.id = d.created_by
     LEFT JOIN print_delivery_decisions x ON x.delivery_id = d.id
     LEFT JOIN users recorder ON recorder.id = x.recorded_by
     WHERE d.id = ?`).get(id),
  decidePrintDelivery: (db, d) => db.prepare(
    `INSERT INTO print_delivery_decisions
       (id, delivery_id, decision, reviewer_name, organization, evidence_url,
        evidence_sha256, note, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      d.id, d.delivery_id, d.decision, d.reviewer_name, d.organization,
      d.evidence_url ?? null, d.evidence_sha256, d.note ?? null, d.recorded_by ?? null, Date.now()),

  createExportJob: (db, job) => db.prepare(
    `INSERT INTO export_jobs (id, game_slug, ref, kind, exporter_version, status, progress, attempt,
       input_hash, created_by, budget_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, 1, ?, ?, ?, ?)`)
    .run(job.id, job.game_slug, job.ref, job.kind, job.exporter_version, job.input_hash,
      job.created_by ?? null, job.budget_json, Date.now()),
  exportJobById: (db, id) => db.prepare("SELECT * FROM export_jobs WHERE id = ?").get(id),
  exportJobByKey: (db, slug, ref, kind, version) => db.prepare(
    "SELECT * FROM export_jobs WHERE game_slug = ? AND ref = ? AND kind = ? AND exporter_version = ?")
    .get(slug, ref, kind, version),
  succeededExportJobsForRef: (db, slug, ref) => db.prepare(
    `SELECT * FROM export_jobs
     WHERE game_slug = ? AND ref = ? AND status = 'succeeded'
     ORDER BY finished_at DESC`).all(slug, ref),
  retryExportJob: (db, id) => db.prepare(
    "UPDATE export_jobs SET status = 'queued', progress = 0, attempt = attempt + 1, output_json = NULL, error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?")
    .run(id),
  startExportJob: (db, id) => db.prepare(
    "UPDATE export_jobs SET status = 'running', progress = 10, started_at = ? WHERE id = ?").run(Date.now(), id),
  finishExportJob: (db, id, status, output, error) => db.prepare(
    "UPDATE export_jobs SET status = ?, progress = ?, output_json = ?, error = ?, finished_at = ? WHERE id = ?")
    .run(status, status === "succeeded" ? 100 : 0, output ?? null, error ?? null, Date.now(), id),

  recordEvent: (db, e) => db.prepare(
    `INSERT INTO events (id, kind, actor_id, game_slug, target, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(e.id, e.kind, e.actor_id ?? null, e.game_slug ?? null, e.target ?? null, Date.now()),
  recentEvents: (db, limit = 30) => db.prepare(
    `SELECT e.kind, e.game_slug, e.target, e.created_at, u.handle AS actor_handle
     FROM events e LEFT JOIN users u ON u.id = e.actor_id ORDER BY e.created_at DESC LIMIT ?`).all(limit),
  eventsByActor: (db, actorId, limit = 30) => db.prepare(
    `SELECT e.kind, e.game_slug, e.target, e.created_at, u.handle AS actor_handle
     FROM events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.actor_id = ? ORDER BY e.created_at DESC LIMIT ?`).all(actorId, limit),

  notify: (db, n) => db.prepare(
    `INSERT INTO notifications (id, user_id, kind, actor_handle, game_slug, target, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(n.id, n.user_id, n.kind, n.actor_handle ?? null, n.game_slug ?? null, n.target ?? null, Date.now()),
  notificationsFor: (db, userId, limit = 30) => db.prepare(
    `SELECT id, kind, actor_handle, game_slug, target, read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all(userId, limit),
  unreadCount: (db, userId) => db.prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0`).get(userId).n,
  markAllRead: (db, userId) => db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ?`).run(userId),

  connectSource: (db, s) => db.prepare(
    `INSERT INTO sync_sources (game_slug, kind, url, connected_by, last_sha, created_at, adapter_id, adapter_version, mapping_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (game_slug, kind) DO UPDATE SET url = excluded.url, connected_by = excluded.connected_by,
       last_sync = NULL, last_sha = excluded.last_sha, source_hash = NULL, source_revision = NULL,
       adapter_id = excluded.adapter_id, adapter_version = excluded.adapter_version, mapping_json = excluded.mapping_json, last_receipt_sha = NULL`)
    .run(s.game_slug, s.kind, s.url, s.connected_by ?? null, s.last_sha ?? null, Date.now(),
      s.adapter_id ?? null, s.adapter_version ?? null, s.mapping_json ?? null),
  sourceFor: (db, slug, kind) => db.prepare(
    "SELECT * FROM sync_sources WHERE game_slug = ? AND kind = ?").get(slug, kind),
  recordSync: (db, slug, kind, sha, sourceHash = null, sourceRevision = null, receiptSha = null) => db.prepare(
    "UPDATE sync_sources SET last_sync = ?, last_sha = ?, source_hash = ?, source_revision = ?, last_receipt_sha = ? WHERE game_slug = ? AND kind = ?")
    .run(Date.now(), sha, sourceHash, sourceRevision, receiptSha, slug, kind),
  disconnectSource: (db, slug, kind) => db.prepare(
    "DELETE FROM sync_sources WHERE game_slug = ? AND kind = ?").run(slug, kind),

  claim: (db, userId, author) => db.prepare(
    `INSERT INTO claims (user_id, author_string, claimed_at) VALUES (?, ?, ?)`)
    .run(userId, author, Date.now()),
  claimsOf: (db, userId) => db.prepare(
    "SELECT author_string FROM claims WHERE user_id = ?").all(userId).map(r => r.author_string),
  claimOwner: (db, author) => db.prepare(
    "SELECT user_id FROM claims WHERE author_string = ?").get(author),
};
