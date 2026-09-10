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
import { randomBytes } from "node:crypto";
import { validPolicySet } from "./policy-acceptance.mjs";
import { normalizePersonalData, personalDataQueries } from "./personal-data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function openDb(url = process.env.PG_URL) {
  if (!url && !process.env.PGHOST) throw new Error("DB=postgres requires PG_URL or libpq PGHOST/PGUSER/PGDATABASE credentials");
  const { default: pg } = await import("pg"); // deploy-time dep, loaded lazily
  const pool = new pg.Pool(url ? { connectionString: url } : {});
  await migrate(pool);
  return pool;
}

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
  const applied = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    if (applied.has(f)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(join(dir, f), "utf8"));
      await client.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [f, Date.now()]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  }
}

export const newId = (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`;

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

  createRelease: (db, r) => db.query(
    `INSERT INTO releases (game_slug, tag, sha, title, notes, author_id, created_at,
       tag_object_sha, tag_annotated, tag_protected, artifacts_json, rights_json, build_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [r.game_slug, r.tag, r.sha, r.title ?? null, r.notes ?? null, r.author_id ?? null, Date.now(),
      r.tag_object_sha ?? null, r.tag_annotated ? 1 : 0, r.tag_protected ? 1 : 0,
      r.artifacts_json ?? null, r.rights_json ?? null, r.build_json ?? null]),
  releasesFor: (db, slug) => all(db,
    `SELECT rl.tag, rl.sha, rl.title, rl.created_at, rl.tag_object_sha,
            rl.tag_annotated, rl.tag_protected, rl.artifacts_json, rl.rights_json, rl.build_json, u.handle AS author_handle
     FROM releases rl LEFT JOIN users u ON u.id = rl.author_id WHERE rl.game_slug = $1 ORDER BY rl.created_at DESC`, [slug]),
  releaseByTag: (db, slug, tag) => one(db,
    `SELECT rl.*, u.handle AS author_handle FROM releases rl LEFT JOIN users u ON u.id = rl.author_id
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
