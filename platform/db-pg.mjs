// @ts-check
/**
 * db-pg.mjs — Store-2 PRODUCTION driver: Postgres behind the exact same `q`
 * surface as db.mjs (node:sqlite dev driver). Selected with DB=postgres;
 * connection from PG_URL (postgres://user:pass@host:5432/dbname).
 *
 * Same migrations (migrations/*.sql — written in the compatible subset,
 * BIGINT epoch-ms timestamps), same call shapes: q.fn(db, ...args). The only
 * driver-visible differences live HERE: $n placeholders, COUNT(*)::int casts
 * (pg counts are bigint→string otherwise), and a Pool instead of a file.
 *
 * Dependency: `npm i pg` at deploy time (the one production npm dep; dev and
 * tests stay zero-dep on node:sqlite). Conformance: tools/store2-conformance.mjs
 * runs the identical operation script against BOTH drivers.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { validPolicySet } from "./policy-acceptance.mjs";
import { normalizePersonalData, personalDataQueries } from "./personal-data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function openDb(url = process.env.PG_URL) {
  if (!url && !process.env.PGHOST) throw new Error("DB=postgres requires PG_URL or libpq PGHOST/PGUSER/PGDATABASE credentials");
  const { default: pg } = await import("pg"); // deploy-time dep, loaded lazily
  const pool = new pg.Pool(url ? { connectionString: url } : {});
  try { await migrate(pool); }
  catch (error) { await pool.end(); throw error; }
  return pool;
}

const advisoryKey = value => createHash("sha256").update(value).digest().readBigInt64BE(0).toString();
const MIGRATION_ADVISORY_KEY = advisoryKey("forge:store-2-schema-migrations:v1");
const releasePublicationAdvisoryKey = (gameSlug, tag) => advisoryKey(
  `forge:release-publication:v1:${JSON.stringify([String(gameSlug), String(tag)])}`);
const releasePublicationEventAdvisoryKey = eventId => advisoryKey(
  `forge:release-publication-event:v1:${String(eventId)}`);

async function lockReleasePublication(client, gameSlug, tag) {
  // A row lock cannot protect the "neither release nor journal row exists"
  // state. Every writer for this identity takes the same transaction lock so a
  // legacy caller and the journal path cannot publish it at once.
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)",
    [releasePublicationAdvisoryKey(gameSlug, tag)]);
}

async function lockReleasePublicationEvent(client, eventId) {
  // Publication identities differ across games and tags, so reserve the event
  // namespace separately before checking the cross-publication uniqueness.
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)",
    [releasePublicationEventAdvisoryKey(eventId)]);
}

async function rejectOpenPendingPublication(client, gameSlug, tag) {
  const pending = (await client.query(
    `SELECT 1 FROM pending_release_publications
     WHERE game_slug = $1 AND release_tag = $2 AND finalized_at IS NULL`,
    [gameSlug, tag])).rows[0];
  if (pending) throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
    `release ${tag} already has a prepared publication`);
}

async function migrate(pool) {
  // Session-level (rather than transaction-level) because every migration is
  // deliberately committed separately. Keeping one checked-out connection for
  // the whole pass also makes the applied-migration re-read authoritative.
  const client = await pool.connect();
  let locked = false, operationError = null;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_ADVISORY_KEY]);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
    const applied = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
    const dir = join(ROOT, "migrations");
    for (const f of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
      if (applied.has(f)) continue;
      let began = false;
      try {
        await client.query("BEGIN"); began = true;
        await client.query(readFileSync(join(dir, f), "utf8"));
        await client.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [f, Date.now()]);
        await client.query("COMMIT"); began = false;
      } catch (error) {
        if (began) await client.query("ROLLBACK");
        throw error;
      }
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let unlockError = null;
    if (locked) {
      try {
        const unlocked = await client.query("SELECT pg_advisory_unlock($1::bigint) AS unlocked",
          [MIGRATION_ADVISORY_KEY]);
        if (unlocked.rows[0]?.unlocked !== true)
          throw new Error("PostgreSQL migration advisory lock was not held by this session");
      }
      catch (error) { unlockError = error; }
    }
    // Passing an error destroys a connection whose session lock could not be
    // explicitly released, so it cannot return to the pool while still locked.
    client.release(unlockError || undefined);
    if (!operationError && unlockError) throw unlockError;
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

const one = async (db, sql, args) => (await db.query(sql, args)).rows[0];
const all = async (db, sql, args) => (await db.query(sql, args)).rows;

async function recordPolicyAcceptance(db, userId, acceptance, now) {
  const set = acceptance?.policy_set;
  if (!validPolicySet(set) || !acceptance?.id || !String(acceptance.application_build || "").trim())
    throw Object.assign(new Error("exact policy acceptance is required"), { code: "FORGE_POLICY_REQUIRED" });
  await db.query(
    `INSERT INTO policy_sets (id, terms_text, privacy_text, community_text, notice_text,
       terms_sha256, privacy_sha256, community_sha256, notice_sha256, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`, [set.id, set.terms_text, set.privacy_text, set.community_text,
      set.notice_text, set.terms_sha256, set.privacy_sha256, set.community_sha256, set.notice_sha256, now]);
  await db.query(
    `INSERT INTO policy_acceptances (id, user_id, policy_set_id, accepted_at, method, application_build)
     VALUES ($1, $2, $3, $4, 'clickwrap', $5)`,
    [acceptance.id, userId, set.id, now, acceptance.application_build]);
}

/* ---- the q surface — 1:1 with db.mjs ---- */
export const q = {
  createUser: (db, u) => db.query(
    `INSERT INTO users (id, handle, email, display_name, pass_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [u.id, u.handle, u.email, u.display_name ?? u.handle, u.pass_hash, Date.now()]),
  createUserWithPolicyAcceptance: async (db, u, acceptance, now = Date.now()) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO users (id, handle, email, display_name, pass_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [u.id, u.handle, u.email, u.display_name ?? u.handle, u.pass_hash, now]);
      await recordPolicyAcceptance(client, u.id, acceptance, now);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  createPilotInvite: (db, invite) => db.query(
    `INSERT INTO pilot_invites (id, token_hash, label, cohort_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [invite.id, invite.token_hash, invite.label ?? null, invite.cohort_id ?? null,
      invite.created_at, invite.expires_at]),
  pilotInvites: (db, now = Date.now()) => all(db,
    `SELECT i.id, i.label, i.cohort_id, i.created_at, i.expires_at, i.revoked_at,
            i.redeemed_at, u.handle AS redeemed_handle,
            CASE WHEN i.redeemed_at IS NOT NULL THEN 'redeemed'
                 WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN i.expires_at <= $1 THEN 'expired' ELSE 'available' END AS status
     FROM pilot_invites i LEFT JOIN users u ON u.id = i.redeemed_by
     ORDER BY i.created_at DESC`, [now]),
  revokePilotInvite: (db, id, now = Date.now()) => db.query(
    `UPDATE pilot_invites SET revoked_at = $1
     WHERE id = $2 AND revoked_at IS NULL AND redeemed_at IS NULL`, [now, id]),
  registerUserWithInvite: async (db, u, tokenHash, acceptance, now = Date.now()) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT id FROM pilot_invites
         WHERE token_hash = $1 AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > $2
         FOR UPDATE`, [tokenHash, now]);
      const invite = selected.rows[0];
      if (!invite) {
        throw Object.assign(new Error("invite is invalid or no longer available"),
          { code: "FORGE_INVITE_INVALID" });
      }
      await client.query(
        `INSERT INTO users (id, handle, email, display_name, pass_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [u.id, u.handle, u.email, u.display_name ?? u.handle, u.pass_hash, now]);
      await recordPolicyAcceptance(client, u.id, acceptance, now);
      const claimed = await client.query(
        `UPDATE pilot_invites SET redeemed_at = $1, redeemed_by = $2
         WHERE id = $3 AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > $4`,
        [now, u.id, invite.id, now]);
      if (claimed.rowCount !== 1) {
        throw Object.assign(new Error("invite is invalid or no longer available"),
          { code: "FORGE_INVITE_INVALID" });
      }
      await client.query("COMMIT");
      return { id: invite.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  issuePasswordReset: async (db, reset, now = Date.now()) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const active = await client.query(
        "SELECT id FROM users WHERE id = $1 AND suspended_at IS NULL FOR UPDATE", [reset.user_id]);
      if (!active.rows[0]) throw Object.assign(new Error("account is suspended or unavailable"),
        { code: "FORGE_ACCOUNT_SUSPENDED" });
      await client.query(
        `UPDATE password_reset_tokens SET revoked_at = $1
         WHERE user_id = $2 AND revoked_at IS NULL AND redeemed_at IS NULL`, [now, reset.user_id]);
      await client.query(
        `INSERT INTO password_reset_tokens (id, token_hash, user_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [reset.id, reset.token_hash, reset.user_id, reset.created_at, reset.expires_at]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  passwordResets: (db, now = Date.now()) => all(db,
    `SELECT r.id, r.created_at, r.expires_at, r.revoked_at, r.redeemed_at, u.handle,
            CASE WHEN r.redeemed_at IS NOT NULL THEN 'redeemed'
                 WHEN r.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN r.expires_at <= $1 THEN 'expired' ELSE 'available' END AS status
     FROM password_reset_tokens r JOIN users u ON u.id = r.user_id
     ORDER BY r.created_at DESC`, [now]),
  revokePasswordReset: (db, id, now = Date.now()) => db.query(
    `UPDATE password_reset_tokens SET revoked_at = $1
     WHERE id = $2 AND revoked_at IS NULL AND redeemed_at IS NULL`, [now, id]),
  resetPasswordWithToken: async (db, tokenHash, passHash, now = Date.now()) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT r.id, r.user_id FROM password_reset_tokens r
         JOIN users u ON u.id = r.user_id
         WHERE r.token_hash = $1 AND r.revoked_at IS NULL AND r.redeemed_at IS NULL
           AND r.expires_at > $2 AND u.suspended_at IS NULL
         FOR UPDATE OF r, u`, [tokenHash, now]);
      const reset = selected.rows[0];
      if (!reset) throw Object.assign(new Error("reset is invalid or no longer available"),
        { code: "FORGE_RESET_INVALID" });
      await client.query("UPDATE users SET pass_hash = $1 WHERE id = $2", [passHash, reset.user_id]);
      await client.query("DELETE FROM sessions WHERE user_id = $1", [reset.user_id]);
      const claimed = await client.query(
        `UPDATE password_reset_tokens SET redeemed_at = $1
         WHERE id = $2 AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > $3`,
        [now, reset.id, now]);
      if (claimed.rowCount !== 1) throw Object.assign(new Error("reset is invalid or no longer available"),
        { code: "FORGE_RESET_INVALID" });
      await client.query("COMMIT");
      return { id: reset.id, user_id: reset.user_id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  userByHandle: (db, h) => one(db, "SELECT * FROM users WHERE handle = $1", [h]),
  userByEmail:  (db, e) => one(db, "SELECT * FROM users WHERE email = $1", [e]),
  userById:     (db, id) => one(db, "SELECT * FROM users WHERE id = $1", [id]),
  policyAcceptancesByUser: (db, userId) => all(db,
    `SELECT a.id, a.policy_set_id, a.accepted_at, a.method, a.application_build,
            s.terms_sha256, s.privacy_sha256, s.community_sha256, s.notice_sha256
     FROM policy_acceptances a JOIN policy_sets s ON s.id = a.policy_set_id
     WHERE a.user_id = $1 ORDER BY a.accepted_at DESC`, [userId]),
  policyAcceptanceEvidenceByUser: (db, userId) => all(db,
    `SELECT a.id, a.policy_set_id, a.accepted_at, a.method, a.application_build,
            s.terms_text, s.privacy_text, s.community_text, s.notice_text,
            s.terms_sha256, s.privacy_sha256, s.community_sha256, s.notice_sha256
     FROM policy_acceptances a JOIN policy_sets s ON s.id = a.policy_set_id
     WHERE a.user_id = $1 ORDER BY a.accepted_at DESC`, [userId]),
  personalDataExport: async (db, userId) => normalizePersonalData(Object.fromEntries(
    await Promise.all(Object.entries(personalDataQueries("$1")).map(async ([key, query]) => [key,
      query.one ? await one(db, query.sql, [userId]) : await all(db, query.sql, [userId])])))),

  accountAccessByHandle: (db, handle) => one(db,
    `SELECT id, handle, created_at, suspended_at, suspension_reason,
            CASE WHEN suspended_at IS NULL THEN 'active' ELSE 'suspended' END AS status
     FROM users WHERE handle = $1`, [handle]),
  accountAccessEvents: (db, userId) => all(db,
    `SELECT id, action, operator_name, reason, created_at
     FROM account_access_events WHERE user_id = $1 ORDER BY created_at DESC`, [userId]),
  setAccountSuspended: async (db, change, now = Date.now()) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = change.suspended
        ? await client.query(
          `UPDATE users SET suspended_at = $1, suspension_reason = $2
           WHERE id = $3 AND suspended_at IS NULL`, [now, change.reason, change.user_id])
        : await client.query(
          `UPDATE users SET suspended_at = NULL, suspension_reason = NULL
           WHERE id = $1 AND suspended_at IS NOT NULL`, [change.user_id]);
      if (result.rowCount !== 1) throw Object.assign(new Error("account is already in the requested state"),
        { code: "FORGE_ACCOUNT_STATE" });
      if (change.suspended) {
        await client.query("DELETE FROM sessions WHERE user_id = $1", [change.user_id]);
        await client.query(
          `UPDATE password_reset_tokens SET revoked_at = $1
           WHERE user_id = $2 AND revoked_at IS NULL AND redeemed_at IS NULL`, [now, change.user_id]);
      }
      await client.query(
        `INSERT INTO account_access_events (id, user_id, action, operator_name, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`, [change.id, change.user_id,
          change.suspended ? "suspend" : "restore", change.operator_name, change.reason, now]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  createSession: async (db, token, userId, ttlMs) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const active = await client.query(
        "SELECT id FROM users WHERE id = $1 AND suspended_at IS NULL FOR UPDATE", [userId]);
      if (!active.rows[0]) throw Object.assign(new Error("account is suspended or unavailable"),
        { code: "FORGE_ACCOUNT_SUSPENDED" });
      const now = Date.now();
      await client.query(
        `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
        [token, userId, now, now + ttlMs]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  sessionUser: (db, token) => one(db,
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > $2 AND u.suspended_at IS NULL`, [token, Date.now()]),
  sessionsFor: (db, userId) => all(db,
    "SELECT left(token, 16) AS id, created_at, expires_at FROM sessions WHERE user_id = $1 AND expires_at > $2 ORDER BY created_at DESC",
    [userId, Date.now()]),
  revokeSession: (db, userId, tokenPrefix) => db.query(
    "DELETE FROM sessions WHERE user_id = $1 AND left(token, 16) = $2", [userId, tokenPrefix]),
  revokeAllSessions: (db, userId) => db.query("DELETE FROM sessions WHERE user_id = $1", [userId]),
  pruneSessions: (db) => db.query("DELETE FROM sessions WHERE expires_at <= $1", [Date.now()]),

  upsertGame: (db, g) => db.query(
    `INSERT INTO games (slug, project_id, namespace, repo_slug, repo_id, title, license, card_count, description, topics_json, players_min, players_max, visibility, owner_id, project_kind, updated_at, indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (slug) DO UPDATE SET title=EXCLUDED.title, license=EXCLUDED.license,
       project_id=EXCLUDED.project_id, namespace=EXCLUDED.namespace, repo_slug=EXCLUDED.repo_slug,
       repo_id=EXCLUDED.repo_id, card_count=EXCLUDED.card_count, description=EXCLUDED.description,
       topics_json=EXCLUDED.topics_json, players_min=EXCLUDED.players_min, players_max=EXCLUDED.players_max,
       visibility=EXCLUDED.visibility,
       project_kind=CASE WHEN games.owner_id IS NOT NULL OR EXCLUDED.owner_id IS NOT NULL
                         THEN 'owned' ELSE EXCLUDED.project_kind END,
       owner_id=COALESCE(games.owner_id, EXCLUDED.owner_id),
       updated_at=EXCLUDED.updated_at, indexed_at=EXCLUDED.indexed_at`,
    [g.slug, g.project_id, g.namespace, g.repo_slug, g.repo_id ?? null,
      g.title, g.license ?? null, g.card_count ?? null, g.description ?? "", g.topics_json ?? "[]",
      g.players_min ?? null, g.players_max ?? null, g.visibility ?? "public", g.owner_id ?? null,
      !g.owner_id && g.project_kind === "public-sandbox" ? "public-sandbox" : "owned", Date.now(), Date.now()]),
  // Keep the Forgejo repository metadata, authoritative owner, and
  // transfer-sensitive collaborator revocation in one visible transaction.
  reindexHostedGame: async (db, g) => {
    const nextOwner = g.owner_id ?? null;
    const nextKind = nextOwner == null && g.project_kind === "public-sandbox"
      ? "public-sandbox" : "owned";
    const now = Date.now();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        "SELECT owner_id FROM games WHERE slug = $1 FOR UPDATE", [g.slug]);
      const before = selected.rows[0];
      const changedOwner = !!before && (before.owner_id ?? null) !== nextOwner;
      await client.query(
        `INSERT INTO games (slug, project_id, namespace, repo_slug, repo_id, title, license, card_count, description, topics_json, players_min, players_max, visibility, owner_id, project_kind, updated_at, indexed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (slug) DO UPDATE SET title=EXCLUDED.title, license=EXCLUDED.license,
           project_id=EXCLUDED.project_id, namespace=EXCLUDED.namespace, repo_slug=EXCLUDED.repo_slug,
           repo_id=EXCLUDED.repo_id, card_count=EXCLUDED.card_count, description=EXCLUDED.description,
           topics_json=EXCLUDED.topics_json, players_min=EXCLUDED.players_min, players_max=EXCLUDED.players_max,
           visibility=EXCLUDED.visibility, owner_id=EXCLUDED.owner_id, project_kind=EXCLUDED.project_kind,
           updated_at=EXCLUDED.updated_at, indexed_at=EXCLUDED.indexed_at`,
        [g.slug, g.project_id, g.namespace, g.repo_slug, g.repo_id ?? null,
          g.title, g.license ?? null, g.card_count ?? null, g.description ?? "", g.topics_json ?? "[]",
          g.players_min ?? null, g.players_max ?? null, g.visibility ?? "public", nextOwner,
          nextKind, now, now]);
      if (changedOwner)
        await client.query("DELETE FROM collaborators WHERE game_slug = $1", [g.slug]);
      await client.query("COMMIT");
      return { changedOwner, owner_id: nextOwner, project_kind: nextKind };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  tombstoneGameIndex: (db, slug) => db.query(
    `UPDATE games SET visibility = 'private', card_count = 0,
       description = '', topics_json = '[]', players_min = NULL,
       players_max = NULL, indexed_at = $1 WHERE slug = $2`, [Date.now(), slug]),
  listGames: (db) => all(db,
    `SELECT g.*, u.handle AS owner_handle,
            (SELECT COUNT(*)::int FROM stars s WHERE s.game_slug = g.slug) AS stars
     FROM games g LEFT JOIN users u ON u.id = g.owner_id
     ORDER BY stars DESC, g.updated_at DESC`),
  gamesOwnedBy: async (db, userId) => (await all(db,
    "SELECT slug FROM games WHERE owner_id = $1 ORDER BY updated_at DESC", [userId])).map(r => r.slug),
  setForkMeta: (db, slug, forkedFrom, ownerId) => db.query(
    "UPDATE games SET forked_from = $1, owner_id = $2, project_kind = 'owned' WHERE slug = $3", [forkedFrom, ownerId, slug]),

  star: (db, userId, slug) => db.query(
    `INSERT INTO stars (user_id, game_slug, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, game_slug) DO NOTHING`, [userId, slug, Date.now()]),
  unstar: (db, userId, slug) => db.query(
    "DELETE FROM stars WHERE user_id = $1 AND game_slug = $2", [userId, slug]),
  starCount: async (db, slug) =>
    (await one(db, "SELECT COUNT(*)::int AS n FROM stars WHERE game_slug = $1", [slug])).n,
  starredBy: (db, userId) => all(db,
    "SELECT game_slug FROM stars WHERE user_id = $1 ORDER BY created_at DESC", [userId]),

  gameBySlug: (db, slug) => one(db, "SELECT * FROM games WHERE slug = $1", [slug]),
  gameByProject: (db, namespace, repoSlug) => one(db,
    "SELECT * FROM games WHERE namespace = $1 AND repo_slug = $2", [namespace, repoSlug]),
  gameByProjectId: (db, projectId) => one(db,
    "SELECT * FROM games WHERE project_id = $1", [projectId]),
  gameByRepoId: (db, repoId) => one(db,
    "SELECT * FROM games WHERE repo_id = $1", [repoId]),
  reconcileIndexedOwner: async (db, { slug, owner_id, project_kind = "owned" }) => {
    const nextOwner = owner_id ?? null;
    const nextKind = nextOwner == null && project_kind === "public-sandbox" ? "public-sandbox" : "owned";
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query("SELECT owner_id FROM games WHERE slug = $1 FOR UPDATE", [slug]);
      const before = selected.rows[0];
      if (!before) throw new Error(`cannot reconcile owner for missing project '${slug}'`);
      const changed = (before.owner_id ?? null) !== nextOwner;
      await client.query("UPDATE games SET owner_id = $1, project_kind = $2 WHERE slug = $3",
        [nextOwner, nextKind, slug]);
      if (changed) await client.query("DELETE FROM collaborators WHERE game_slug = $1", [slug]);
      await client.query("COMMIT");
      return { changed, owner_id: nextOwner, project_kind: nextKind };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  createPr: (db, pr) => db.query(
    `INSERT INTO prs (id, to_slug, from_slug, title, body, author_id, status, base, proposed, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9)`,
    [pr.id, pr.to_slug, pr.from_slug, pr.title, pr.body ?? null, pr.author_id, pr.base, pr.proposed, Date.now()]),
  refreshPr: (db, id, title, base, proposed) => db.query(
    "UPDATE prs SET title = $1, base = $2, proposed = $3 WHERE id = $4 AND status = 'open'",
    [title, base, proposed, id]),
  prById: (db, id) => one(db,
    `SELECT p.*, u.handle AS author_handle, u.email AS author_email FROM prs p JOIN users u ON u.id = p.author_id
     WHERE p.id = $1`, [id]),
  prsFor: (db, slug) => all(db,
    `SELECT p.id, p.from_slug, p.title, p.status, p.created_at, p.merged_at, u.handle AS author_handle
     FROM prs p JOIN users u ON u.id = p.author_id
     WHERE p.to_slug = $1 ORDER BY p.created_at DESC`, [slug]),
  setPrStatus: (db, id, status, mergeSha) => db.query(
    "UPDATE prs SET status = $1, merged_at = $2, merge_sha = $3 WHERE id = $4",
    [status, status === "merged" ? Date.now() : null, mergeSha ?? null, id]),

  addCollaborator: (db, slug, userId, addedBy, role = "maintainer") => db.query(
    `INSERT INTO collaborators (game_slug, user_id, role, added_by, added_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (game_slug, user_id)
     DO UPDATE SET role=EXCLUDED.role, added_by=EXCLUDED.added_by, added_at=EXCLUDED.added_at`,
    [slug, userId, role, addedBy, Date.now()]),
  removeCollaborator: (db, slug, userId) => db.query(
    "DELETE FROM collaborators WHERE game_slug = $1 AND user_id = $2", [slug, userId]),
  isCollaborator: (db, slug, userId) => one(db,
    "SELECT 1 AS y FROM collaborators WHERE game_slug = $1 AND user_id = $2", [slug, userId]),
  collaboratorRole: async (db, slug, userId) => (await one(db,
    "SELECT role FROM collaborators WHERE game_slug = $1 AND user_id = $2", [slug, userId]))?.role ?? null,
  collaboratorsOf: (db, slug) => all(db,
    `SELECT u.handle, c.role, c.added_at FROM collaborators c JOIN users u ON u.id = c.user_id
     WHERE c.game_slug = $1 ORDER BY c.added_at`, [slug]),

  nextIssueNumber: async (db, slug) => (await one(db,
    "SELECT COALESCE(MAX(number),0)+1 AS n FROM issues WHERE game_slug = $1", [slug])).n,
  createIssue: (db, i) => db.query(
    `INSERT INTO issues (id, game_slug, number, title, body, author_id, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)`,
    [i.id, i.game_slug, i.number, i.title, i.body ?? null, i.author_id, Date.now()]),
  issuesFor: (db, slug) => all(db,
    `SELECT i.*, u.handle AS author_handle,
            (SELECT COUNT(*)::int FROM comments c WHERE c.target_type='issue' AND c.target_id=i.id) AS comment_count
     FROM issues i JOIN users u ON u.id = i.author_id
     WHERE i.game_slug = $1 ORDER BY i.number DESC`, [slug]),
  issueByNumber: (db, slug, number) => one(db,
    `SELECT i.*, u.handle AS author_handle FROM issues i JOIN users u ON u.id = i.author_id
     WHERE i.game_slug = $1 AND i.number = $2`, [slug, number]),
  setIssueStatus: (db, id, status) => db.query(
    "UPDATE issues SET status = $1, closed_at = $2 WHERE id = $3", [status, status === "closed" ? Date.now() : null, id]),

  addComment: (db, c) => db.query(
    `INSERT INTO comments (id, target_type, target_id, author_id, body, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`, [c.id, c.target_type, c.target_id, c.author_id, c.body, Date.now()]),
  commentsFor: (db, targetType, targetId) => all(db,
    `SELECT c.body, c.created_at, u.handle AS author_handle FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.target_type = $1 AND c.target_id = $2 ORDER BY c.created_at`, [targetType, targetId]),

  addReview: (db, r) => db.query(
    `INSERT INTO reviews (pr_id, reviewer_id, verdict, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (pr_id, reviewer_id) DO UPDATE SET verdict = EXCLUDED.verdict, created_at = EXCLUDED.created_at`,
    [r.pr_id, r.reviewer_id, r.verdict, Date.now()]),
  reviewsFor: (db, prId) => all(db,
    `SELECT rv.verdict, rv.created_at, u.handle AS reviewer_handle FROM reviews rv JOIN users u ON u.id = rv.reviewer_id
     WHERE rv.pr_id = $1 ORDER BY rv.created_at`, [prId]),
  clearReviews: (db, prId) => db.query("DELETE FROM reviews WHERE pr_id = $1", [prId]),

  enterJam: (db, e) => db.query(
    `INSERT INTO jam_entries (jam_id, game_slug, user_id, submitted_at, qualified, award, state, release_tag, release_sha, receipt_json, team_json, replaced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (jam_id, game_slug) DO UPDATE SET user_id = EXCLUDED.user_id, submitted_at = EXCLUDED.submitted_at,
       qualified = EXCLUDED.qualified, state = EXCLUDED.state, release_tag = EXCLUDED.release_tag,
       release_sha = EXCLUDED.release_sha, receipt_json = EXCLUDED.receipt_json, team_json = EXCLUDED.team_json,
       replaced_at = EXCLUDED.replaced_at`,
    [e.jam_id, e.game_slug, e.user_id ?? null, Date.now(), e.qualified ? 1 : 0, e.award ?? null,
      e.state ?? "draft", e.release_tag ?? null, e.release_sha ?? null, e.receipt_json ?? null,
      e.team_json ?? null, e.replaced_at ?? null]),
  jamEntriesFor: (db, jamId) => all(db,
    `SELECT je.jam_id, je.game_slug, je.user_id, je.submitted_at, je.qualified, je.award, je.state,
            je.release_tag, je.release_sha, je.receipt_json, je.team_json, je.replaced_at, je.disqualified_reason,
            g.title, g.forked_from, u.handle AS author_handle
     FROM jam_entries je LEFT JOIN games g ON g.slug = je.game_slug LEFT JOIN users u ON u.id = je.user_id
     WHERE je.jam_id = $1 ORDER BY je.submitted_at`, [jamId]),
  jamEntryOf: (db, jamId, slug) => one(db,
    "SELECT * FROM jam_entries WHERE jam_id = $1 AND game_slug = $2", [jamId, slug]),
  recordJamSubmission: (db, entry) => db.query(
    `INSERT INTO jam_submission_history (id, jam_id, game_slug, user_id, release_tag, release_sha, receipt_json, action, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [entry.id, entry.jam_id, entry.game_slug, entry.user_id ?? null, entry.release_tag, entry.release_sha,
      entry.receipt_json, entry.action, Date.now()]),
  jamSubmissionHistory: (db, jamId, slug) => all(db,
    "SELECT id, release_tag, release_sha, receipt_json, action, created_at FROM jam_submission_history WHERE jam_id = $1 AND game_slug = $2 ORDER BY created_at",
    [jamId, slug]),
  recordJamAudit: (db, event) => db.query(
    `INSERT INTO jam_audit_events (id, jam_id, actor_id, action, target, detail_json, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [event.id, event.jam_id, event.actor_id ?? null, event.action, event.target ?? null, event.detail_json ?? null, Date.now()]),

  prepareReleasePublication: async (db, publication) => {
    const identity = pendingPublicationIdentity(publication);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockReleasePublication(client, identity.game_slug, identity.release_tag);
      let existing = (await client.query(
        `SELECT * FROM pending_release_publications
         WHERE game_slug = $1 AND release_tag = $2 FOR UPDATE`,
        [identity.game_slug, identity.release_tag])).rows[0];
      if (existing) {
        const pending = normalizedPendingPublication(publication, existing);
        if (!samePendingPublication(existing, pending))
          throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
            `release ${identity.release_tag} already has different pending publication evidence`);
        await lockReleasePublicationEvent(client, pending.event_id);
        if (existing.finalized_at == null && (await client.query(
          "SELECT 1 FROM events WHERE id = $1", [pending.event_id])).rows[0])
          throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
            `release event ${pending.event_id} is already recorded`);
        await client.query("COMMIT");
        return { prepared: false, ...existing };
      }
      if ((await client.query(
        "SELECT 1 FROM releases WHERE game_slug = $1 AND tag = $2",
        [identity.game_slug, identity.release_tag])).rows[0])
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
          `release ${identity.release_tag} is already published`);
      let pending = normalizedPendingPublication(publication);
      await lockReleasePublicationEvent(client, pending.event_id);
      if ((await client.query(
        "SELECT 1 FROM events WHERE id = $1", [pending.event_id])).rows[0])
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
          `release event ${pending.event_id} is already recorded`);
      const eventReservation = (await client.query(
        `SELECT game_slug, release_tag FROM pending_release_publications
         WHERE event_id = $1 FOR UPDATE`, [pending.event_id])).rows[0];
      if (eventReservation)
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
          `release event ${pending.event_id} is already reserved by another publication`);
      const inserted = await client.query(
        `INSERT INTO pending_release_publications
           (game_slug, release_tag, source_sha, title, notes, author_id,
            artifacts_json, rights_json, build_json, vault_format_version,
            vault_binding_kind, vault_manifest_sha256, vault_sealed_at, event_id,
            event_kind, event_actor_id, created_at, finalized_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NULL)
         ON CONFLICT (game_slug, release_tag) DO NOTHING RETURNING *`,
        [pending.game_slug, pending.release_tag, pending.source_sha, pending.title,
          pending.notes, pending.author_id, pending.artifacts_json, pending.rights_json,
          pending.build_json, pending.vault_format_version, pending.vault_binding_kind,
          pending.vault_manifest_sha256, pending.vault_sealed_at, pending.event_id, pending.event_kind,
          pending.event_actor_id, pending.created_at]);
      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return { prepared: true, ...inserted.rows[0] };
      }
      existing = (await client.query(
        `SELECT * FROM pending_release_publications
         WHERE game_slug = $1 AND release_tag = $2 FOR UPDATE`,
        [identity.game_slug, identity.release_tag])).rows[0];
      pending = normalizedPendingPublication(publication, existing);
      if (!samePendingPublication(existing, pending))
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
          `release ${identity.release_tag} already has different pending publication evidence`);
      await client.query("COMMIT");
      return { prepared: false, ...existing };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  },
  pendingReleasePublication: (db, slug, tag) => one(db,
    `SELECT * FROM pending_release_publications
     WHERE game_slug = $1 AND release_tag = $2 AND finalized_at IS NULL`, [slug, tag]),
  releasePublicationEvent: async (db, slug, tag) => {
    const row = await one(db,
      `SELECT e.id, e.kind, e.actor_id, e.game_slug, e.target, e.created_at
       FROM pending_release_publications p
       JOIN events e ON e.id = p.event_id
       WHERE p.game_slug = $1 AND p.release_tag = $2 AND p.finalized_at IS NOT NULL`,
      [slug, tag]);
    return row ? { ...row, created_at: Number(row.created_at) } : null;
  },
  finalizeReleasePublication: async (db, input) => {
    const evidence = normalizedTagPublicationEvidence(input);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockReleasePublication(client, evidence.game_slug, evidence.tag);
      const pending = (await client.query(
        `SELECT * FROM pending_release_publications
         WHERE game_slug = $1 AND release_tag = $2 FOR UPDATE`,
        [evidence.game_slug, evidence.tag])).rows[0];
      if (!pending)
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_NOT_FOUND",
          `release ${evidence.tag} has no prepared publication`);
      await lockReleasePublicationEvent(client, pending.event_id);
      const releaseRow = (await client.query(
        "SELECT * FROM releases WHERE game_slug = $1 AND tag = $2 FOR UPDATE",
        [evidence.game_slug, evidence.tag])).rows[0];
      const vaultRow = (await client.query(
        `SELECT * FROM release_artifact_vaults
         WHERE game_slug = $1 AND release_tag = $2 FOR UPDATE`,
        [evidence.game_slug, evidence.tag])).rows[0];
      const eventRow = (await client.query(
        "SELECT * FROM events WHERE id = $1 FOR UPDATE", [pending.event_id])).rows[0];
      if (pending.finalized_at != null) {
        if (!sameFinalizedPublication(releaseRow, vaultRow, eventRow, pending, evidence))
          throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
            `release ${evidence.tag} finalization evidence does not match`);
        await client.query("COMMIT");
        return { finalized: false, release: releaseRow, vault: vaultRow, pending };
      }
      if (releaseRow || vaultRow || eventRow)
        throw releasePublicationError("FORGE_RELEASE_PUBLICATION_CONFLICT",
          `release ${evidence.tag} collides with existing publication state`);
      const parts = finalizedPublicationParts(pending, evidence);
      await client.query(
        `INSERT INTO releases (game_slug, tag, sha, title, notes, author_id, created_at,
           tag_object_sha, tag_annotated, tag_protected, artifacts_json, rights_json, build_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 1, $9, $10, $11)`,
        [parts.release.game_slug, parts.release.tag, parts.release.sha, parts.release.title,
          parts.release.notes, parts.release.author_id, Number(pending.created_at),
          parts.release.tag_object_sha, parts.release.artifacts_json,
          parts.release.rights_json, parts.release.build_json]);
      await client.query(
        `INSERT INTO release_artifact_vaults
           (game_slug, release_tag, format_version, binding_kind, manifest_sha256, sealed_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [parts.vault.game_slug, parts.vault.release_tag, parts.vault.format_version, parts.vault.binding_kind,
          parts.vault.manifest_sha256, parts.vault.sealed_at]);
      await client.query(
        `INSERT INTO events (id, kind, actor_id, game_slug, target, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [parts.event.id, parts.event.kind, parts.event.actor_id, parts.event.game_slug,
          parts.event.target, Number(pending.created_at)]);
      const finalizedAt = Date.now();
      await client.query(
        `UPDATE pending_release_publications SET finalized_at = $1
         WHERE game_slug = $2 AND release_tag = $3 AND finalized_at IS NULL`,
        [finalizedAt, evidence.game_slug, evidence.tag]);
      await client.query("COMMIT");
      return {
        finalized: true,
        release: { ...parts.release, created_at: Number(pending.created_at) },
        vault: parts.vault,
        pending: { ...pending, finalized_at: finalizedAt },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  },
  createRelease: async (db, r) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockReleasePublication(client, r.game_slug, r.tag);
      await rejectOpenPendingPublication(client, r.game_slug, r.tag);
      const result = await client.query(
        `INSERT INTO releases (game_slug, tag, sha, title, notes, author_id, created_at,
           tag_object_sha, tag_annotated, tag_protected, artifacts_json, rights_json, build_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [r.game_slug, r.tag, r.sha, r.title ?? null, r.notes ?? null, r.author_id ?? null, Date.now(),
          r.tag_object_sha ?? null, r.tag_annotated ? 1 : 0, r.tag_protected ? 1 : 0,
          r.artifacts_json ?? null, r.rights_json ?? null, r.build_json ?? null]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  },
  attachReleaseVault: async (db, association) => {
    const release = { game_slug: association.game_slug, tag: association.release_tag };
    const vault = normalizedLegacyVault(association, release);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockReleasePublication(client, release.game_slug, release.tag);
      await rejectOpenPendingPublication(client, release.game_slug, release.tag);
      const inserted = await client.query(
        `INSERT INTO release_artifact_vaults
           (game_slug, release_tag, format_version, binding_kind, manifest_sha256, sealed_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (game_slug, release_tag) DO NOTHING RETURNING *`,
        [vault.game_slug, vault.release_tag, vault.format_version, vault.binding_kind,
          vault.manifest_sha256, vault.sealed_at]);
      const row = inserted.rows[0] || (await client.query(
        "SELECT * FROM release_artifact_vaults WHERE game_slug = $1 AND release_tag = $2",
        [vault.game_slug, vault.release_tag])).rows[0];
      if (!sameVault(row, vault))
        throw releaseVaultError("FORGE_RELEASE_VAULT_CONFLICT",
          `release ${vault.release_tag} already has a different vault manifest`);
      await client.query("COMMIT");
      return { attached: inserted.rowCount === 1, ...row };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  },
  publishRelease: async (db, publication) => {
    const release = publication?.release || {};
    const event = publication?.event || {};
    if (!event.id) throw releaseVaultError("FORGE_RELEASE_VAULT_INVALID",
      "release publication requires an event id");
    const now = Date.now(), vault = normalizedVault(publication?.vault, release, now);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockReleasePublication(client, release.game_slug, release.tag);
      await lockReleasePublicationEvent(client, event.id);
      await rejectOpenPendingPublication(client, release.game_slug, release.tag);
      const inserted = await client.query(
        `INSERT INTO releases (game_slug, tag, sha, title, notes, author_id, created_at,
           tag_object_sha, tag_annotated, tag_protected, artifacts_json, rights_json, build_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (game_slug, tag) DO NOTHING RETURNING *`,
        [release.game_slug, release.tag, release.sha, release.title ?? null, release.notes ?? null,
          release.author_id ?? null, now, release.tag_object_sha ?? null,
          release.tag_annotated ? 1 : 0, release.tag_protected ? 1 : 0,
          release.artifacts_json ?? null, release.rights_json ?? null, release.build_json ?? null]);
      if (!inserted.rows[0]) {
        const existingRelease = (await client.query(
          "SELECT * FROM releases WHERE game_slug = $1 AND tag = $2 FOR UPDATE",
          [release.game_slug, release.tag])).rows[0];
        const existingVault = (await client.query(
          "SELECT * FROM release_artifact_vaults WHERE game_slug = $1 AND release_tag = $2",
          [release.game_slug, release.tag])).rows[0];
        const existingEvent = (await client.query("SELECT * FROM events WHERE id = $1", [event.id])).rows[0];
        if (!sameRelease(existingRelease, release) || !sameVault(existingVault, vault)
          || !sameReleaseEvent(existingEvent, event, release))
          throw releaseVaultError("FORGE_RELEASE_VAULT_CONFLICT",
            `release ${release.tag} is already published with different immutable evidence`);
        await client.query("COMMIT");
        return { published: false, release: existingRelease, vault: existingVault };
      }
      if ((await client.query("SELECT 1 FROM events WHERE id = $1", [event.id])).rows[0])
        throw releaseVaultError("FORGE_RELEASE_VAULT_CONFLICT", "release event id is already in use");
      await client.query(
        `INSERT INTO release_artifact_vaults
           (game_slug, release_tag, format_version, binding_kind, manifest_sha256, sealed_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [vault.game_slug, vault.release_tag, vault.format_version, vault.binding_kind,
          vault.manifest_sha256, vault.sealed_at]);
      await client.query(
        `INSERT INTO events (id, kind, actor_id, game_slug, target, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [event.id, event.kind || "release", event.actor_id ?? release.author_id ?? null,
          release.game_slug, release.tag, now]);
      await client.query("COMMIT");
      return { published: true, release: { ...release, created_at: now }, vault };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  },
  releasesFor: (db, slug) => all(db,
    `SELECT rl.tag, rl.sha, rl.title, rl.created_at, rl.tag_object_sha,
            rl.tag_annotated, rl.tag_protected, rl.artifacts_json, rl.rights_json, rl.build_json,
            v.format_version AS vault_format_version, v.binding_kind AS vault_binding_kind,
            v.manifest_sha256 AS vault_manifest_sha256,
            v.sealed_at AS vault_sealed_at, u.handle AS author_handle
     FROM releases rl LEFT JOIN users u ON u.id = rl.author_id
     LEFT JOIN release_artifact_vaults v ON v.game_slug = rl.game_slug AND v.release_tag = rl.tag
     WHERE rl.game_slug = $1 ORDER BY rl.created_at DESC`, [slug]),
  releaseByTag: (db, slug, tag) => one(db,
    `SELECT rl.*, v.format_version AS vault_format_version, v.binding_kind AS vault_binding_kind,
            v.manifest_sha256 AS vault_manifest_sha256,
            v.sealed_at AS vault_sealed_at, u.handle AS author_handle
     FROM releases rl LEFT JOIN users u ON u.id = rl.author_id
     LEFT JOIN release_artifact_vaults v ON v.game_slug = rl.game_slug AND v.release_tag = rl.tag
     WHERE rl.game_slug = $1 AND rl.tag = $2`, [slug, tag]),

  createPrintDelivery: (db, d) => db.query(
    `INSERT INTO print_deliveries
       (id, game_slug, release_tag, release_sha, artifact_name, artifact_sha256, artifact_bytes,
        printer_name, job_reference, submission_evidence_url, submission_evidence_sha256,
        note, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [d.id, d.game_slug, d.release_tag, d.release_sha, d.artifact_name, d.artifact_sha256,
      d.artifact_bytes, d.printer_name, d.job_reference, d.submission_evidence_url ?? null,
      d.submission_evidence_sha256 ?? null, d.note ?? null, d.created_by ?? null, Date.now()]),
  printDeliveriesForRelease: (db, slug, tag) => all(db,
    `SELECT d.*, creator.handle AS created_by_handle,
            x.id AS decision_id, x.decision, x.reviewer_name, x.organization,
            x.evidence_url, x.evidence_sha256, x.note AS decision_note,
            x.created_at AS decided_at, recorder.handle AS recorded_by_handle
     FROM print_deliveries d
     LEFT JOIN users creator ON creator.id = d.created_by
     LEFT JOIN print_delivery_decisions x ON x.delivery_id = d.id
     LEFT JOIN users recorder ON recorder.id = x.recorded_by
     WHERE d.game_slug = $1 AND d.release_tag = $2 ORDER BY d.created_at DESC`, [slug, tag]),
  printDeliveryById: (db, id) => one(db,
    `SELECT d.*, creator.handle AS created_by_handle,
            x.id AS decision_id, x.decision, x.reviewer_name, x.organization,
            x.evidence_url, x.evidence_sha256, x.note AS decision_note,
            x.created_at AS decided_at, recorder.handle AS recorded_by_handle
     FROM print_deliveries d
     LEFT JOIN users creator ON creator.id = d.created_by
     LEFT JOIN print_delivery_decisions x ON x.delivery_id = d.id
     LEFT JOIN users recorder ON recorder.id = x.recorded_by
     WHERE d.id = $1`, [id]),
  decidePrintDelivery: (db, d) => db.query(
    `INSERT INTO print_delivery_decisions
       (id, delivery_id, decision, reviewer_name, organization, evidence_url,
        evidence_sha256, note, recorded_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [d.id, d.delivery_id, d.decision, d.reviewer_name, d.organization,
      d.evidence_url ?? null, d.evidence_sha256, d.note ?? null, d.recorded_by ?? null, Date.now()]),

  createExportJob: (db, job) => db.query(
    `INSERT INTO export_jobs (id, game_slug, ref, kind, exporter_version, status, progress, attempt,
       input_hash, created_by, budget_json, created_at)
     VALUES ($1, $2, $3, $4, $5, 'queued', 0, 1, $6, $7, $8, $9)`,
    [job.id, job.game_slug, job.ref, job.kind, job.exporter_version, job.input_hash,
      job.created_by ?? null, job.budget_json, Date.now()]),
  exportJobById: (db, id) => one(db, "SELECT * FROM export_jobs WHERE id = $1", [id]),
  exportJobByKey: (db, slug, ref, kind, version) => one(db,
    "SELECT * FROM export_jobs WHERE game_slug = $1 AND ref = $2 AND kind = $3 AND exporter_version = $4",
    [slug, ref, kind, version]),
  succeededExportJobsForRef: (db, slug, ref) => all(db,
    `SELECT * FROM export_jobs
     WHERE game_slug = $1 AND ref = $2 AND status = 'succeeded'
     ORDER BY finished_at DESC`, [slug, ref]),
  retryExportJob: (db, id) => db.query(
    "UPDATE export_jobs SET status = 'queued', progress = 0, attempt = attempt + 1, output_json = NULL, error = NULL, started_at = NULL, finished_at = NULL WHERE id = $1", [id]),
  startExportJob: (db, id) => db.query(
    "UPDATE export_jobs SET status = 'running', progress = 10, started_at = $1 WHERE id = $2", [Date.now(), id]),
  finishExportJob: (db, id, status, output, error) => db.query(
    "UPDATE export_jobs SET status = $1, progress = $2, output_json = $3, error = $4, finished_at = $5 WHERE id = $6",
    [status, status === "succeeded" ? 100 : 0, output ?? null, error ?? null, Date.now(), id]),

  recordEvent: (db, e) => db.query(
    `INSERT INTO events (id, kind, actor_id, game_slug, target, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.id, e.kind, e.actor_id ?? null, e.game_slug ?? null, e.target ?? null, Date.now()]),
  recentEvents: (db, limit = 30) => all(db,
    `SELECT e.kind, e.game_slug, e.target, e.created_at, u.handle AS actor_handle
     FROM events e LEFT JOIN users u ON u.id = e.actor_id ORDER BY e.created_at DESC LIMIT $1`, [limit]),
  eventsByActor: (db, actorId, limit = 30) => all(db,
    `SELECT e.kind, e.game_slug, e.target, e.created_at, u.handle AS actor_handle
     FROM events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.actor_id = $1 ORDER BY e.created_at DESC LIMIT $2`, [actorId, limit]),

  notify: (db, n) => db.query(
    `INSERT INTO notifications (id, user_id, kind, actor_handle, game_slug, target, read, created_at) VALUES ($1, $2, $3, $4, $5, $6, 0, $7)`,
    [n.id, n.user_id, n.kind, n.actor_handle ?? null, n.game_slug ?? null, n.target ?? null, Date.now()]),
  notificationsFor: (db, userId, limit = 30) => all(db,
    `SELECT id, kind, actor_handle, game_slug, target, read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]),
  unreadCount: async (db, userId) => (await one(db,
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read = 0`, [userId])).n,
  markAllRead: (db, userId) => db.query(`UPDATE notifications SET read = 1 WHERE user_id = $1`, [userId]),

  connectSource: (db, s) => db.query(
    `INSERT INTO sync_sources (game_slug, kind, url, connected_by, last_sha, created_at, adapter_id, adapter_version, mapping_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (game_slug, kind) DO UPDATE SET url = EXCLUDED.url, connected_by = EXCLUDED.connected_by,
       last_sync = NULL, last_sha = EXCLUDED.last_sha, source_hash = NULL, source_revision = NULL,
       adapter_id = EXCLUDED.adapter_id, adapter_version = EXCLUDED.adapter_version, mapping_json = EXCLUDED.mapping_json, last_receipt_sha = NULL`,
    [s.game_slug, s.kind, s.url, s.connected_by ?? null, s.last_sha ?? null, Date.now(),
      s.adapter_id ?? null, s.adapter_version ?? null, s.mapping_json ?? null]),
  sourceFor: (db, slug, kind) => one(db,
    "SELECT * FROM sync_sources WHERE game_slug = $1 AND kind = $2", [slug, kind]),
  recordSync: (db, slug, kind, sha, sourceHash = null, sourceRevision = null, receiptSha = null) => db.query(
    "UPDATE sync_sources SET last_sync = $1, last_sha = $2, source_hash = $3, source_revision = $4, last_receipt_sha = $5 WHERE game_slug = $6 AND kind = $7",
    [Date.now(), sha, sourceHash, sourceRevision, receiptSha, slug, kind]),
  disconnectSource: (db, slug, kind) => db.query(
    "DELETE FROM sync_sources WHERE game_slug = $1 AND kind = $2", [slug, kind]),

  claim: (db, userId, author) => db.query(
    `INSERT INTO claims (user_id, author_string, claimed_at) VALUES ($1, $2, $3)`,
    [userId, author, Date.now()]),
  claimsOf: async (db, userId) => (await all(db,
    "SELECT author_string FROM claims WHERE user_id = $1", [userId])).map(r => r.author_string),
  claimOwner: (db, author) => one(db,
    "SELECT user_id FROM claims WHERE author_string = $1", [author]),
};
