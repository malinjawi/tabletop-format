/**
 * Explicit personal-data export allowlist. Every query is scoped to one user;
 * credentials, bearer-token hashes, repository snapshots, and derived artifact
 * bodies are intentionally absent. The same SQL works in SQLite and Postgres
 * once the single bind placeholder is supplied by the driver.
 */
export function personalDataQueries(bind) {
  const p = bind;
  return {
    account: { one: true, sql:
      `SELECT id, handle, email, display_name, created_at, suspended_at, suspension_reason
       FROM users WHERE id = ${p}` },
    sessions: { sql:
      `SELECT created_at, expires_at FROM sessions WHERE user_id = ${p} ORDER BY created_at DESC` },
    author_claims: { sql:
      `SELECT author_string, claimed_at FROM claims WHERE user_id = ${p} ORDER BY claimed_at DESC` },
    owned_projects: { sql:
      `SELECT slug, project_id, namespace, repo_slug, repo_id, title, license, forked_from,
              head_sha, card_count, description, players_min, players_max,
              visibility, updated_at, indexed_at
       FROM games WHERE owner_id = ${p} ORDER BY updated_at DESC` },
    stars: { sql:
      `SELECT game_slug, created_at FROM stars WHERE user_id = ${p} ORDER BY created_at DESC` },
    collaborations: { sql:
      `SELECT c.game_slug, c.role, c.added_at, u.handle AS added_by_handle
       FROM collaborators c LEFT JOIN users u ON u.id = c.added_by
       WHERE c.user_id = ${p} ORDER BY c.added_at DESC` },
    collaboration_grants: { sql:
      `SELECT c.game_slug, c.role, c.added_at, u.handle AS member_handle
       FROM collaborators c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.added_by = ${p} ORDER BY c.added_at DESC` },
    authored_proposals: { sql:
      `SELECT id, to_slug, from_slug, title, body, status, created_at, merged_at, merge_sha
       FROM prs WHERE author_id = ${p} ORDER BY created_at DESC` },
    authored_issues: { sql:
      `SELECT id, game_slug, number, title, body, status, created_at, closed_at
       FROM issues WHERE author_id = ${p} ORDER BY created_at DESC` },
    authored_comments: { sql:
      `SELECT id, target_type, target_id, body, created_at
       FROM comments WHERE author_id = ${p} ORDER BY created_at DESC` },
    reviews: { sql:
      `SELECT pr_id, verdict, created_at FROM reviews
       WHERE reviewer_id = ${p} ORDER BY created_at DESC` },
    authored_releases: { sql:
      `SELECT game_slug, tag, sha, title, notes, created_at
       FROM releases WHERE author_id = ${p} ORDER BY created_at DESC` },
    activity: { sql:
      `SELECT id, kind, game_slug, target, created_at
       FROM events WHERE actor_id = ${p} ORDER BY created_at DESC` },
    notifications: { sql:
      `SELECT id, kind, actor_handle, game_slug, target, read, created_at
       FROM notifications WHERE user_id = ${p} ORDER BY created_at DESC` },
    connected_sources: { sql:
      `SELECT game_slug, kind, url, last_sync, last_sha, created_at, source_hash,
              source_revision, adapter_id, adapter_version, last_receipt_sha
       FROM sync_sources WHERE connected_by = ${p} ORDER BY created_at DESC` },
    export_jobs: { sql:
      `SELECT id, game_slug, ref, kind, exporter_version, status, progress, attempt,
              input_hash, created_at, started_at, finished_at,
              CASE WHEN error IS NULL THEN 0 ELSE 1 END AS had_error
       FROM export_jobs WHERE created_by = ${p} ORDER BY created_at DESC` },
    jam_entries: { sql:
      `SELECT jam_id, game_slug, submitted_at, qualified, award, state, release_tag,
              release_sha, replaced_at, disqualified_reason
       FROM jam_entries WHERE user_id = ${p} ORDER BY submitted_at DESC` },
    jam_submission_history: { sql:
      `SELECT id, jam_id, game_slug, release_tag, release_sha, action, created_at
       FROM jam_submission_history WHERE user_id = ${p} ORDER BY created_at DESC` },
    jam_audit_activity: { sql:
      `SELECT id, jam_id, action, target, created_at
       FROM jam_audit_events WHERE actor_id = ${p} ORDER BY created_at DESC` },
    invitation: { sql:
      `SELECT id, label, cohort_id, created_at, expires_at, revoked_at, redeemed_at
       FROM pilot_invites WHERE redeemed_by = ${p} ORDER BY created_at DESC` },
    password_recovery: { sql:
      `SELECT id, created_at, expires_at, revoked_at, redeemed_at
       FROM password_reset_tokens WHERE user_id = ${p} ORDER BY created_at DESC` },
    access_events: { sql:
      `SELECT id, action, operator_name, reason, created_at
       FROM account_access_events WHERE user_id = ${p} ORDER BY created_at DESC` },
    policy_acceptances: { sql:
      `SELECT a.id, a.policy_set_id, a.accepted_at, a.method, a.application_build,
              s.terms_text, s.privacy_text, s.community_text, s.notice_text,
              s.terms_sha256, s.privacy_sha256, s.community_sha256, s.notice_sha256
       FROM policy_acceptances a JOIN policy_sets s ON s.id = a.policy_set_id
       WHERE a.user_id = ${p} ORDER BY a.accepted_at DESC` },
  };
}

export function normalizePersonalData(value) {
  if (Array.isArray(value)) return value.map(normalizePersonalData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if ((key.endsWith("_at") || key === "number") && typeof item === "string" && /^\d+$/.test(item))
      return [key, Number(item)];
    return [key, normalizePersonalData(item)];
  }));
}

export function assertPersonalDataSafe(value) {
  const forbidden = new Set(["pass_hash", "token", "token_hash", "base", "proposed",
    "output_json", "artifacts_json", "rights_json", "build_json"]);
  const visit = item => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) throw new Error(`personal-data export contains forbidden field: ${key}`);
      visit(child);
    }
  };
  visit(value);
  return value;
}
