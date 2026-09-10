// @ts-check

/**
 * Decide which durable Store-2 row a hosted Forgejo repository may update.
 * Repository id is the physical identity; project id is the durable Forge
 * identity. A new physical repository may not claim either an existing storage
 * key or another repository's project id.
 *
 * A pre-Forgejo row with no repo_id may be adopted exactly once, but only when
 * both its public owner/name and project id match. This is the migration path
 * from the local Store-1 driver; every other collision is quarantined.
 */
export function hostedProjectReindexPlan(discoveredKey, meta,
  { byRepoId = null, byProjectId = null, byStorageKey = null } = {}) {
  const repoId = meta?.repoId == null ? null : String(meta.repoId);
  if (!repoId) return { action: "quarantine", reason: "missing stable Forgejo repository id" };

  if (byRepoId) {
    return { action: "index", storageKey: byRepoId.slug,
      projectId: byRepoId.project_id, projectKind: byRepoId.project_kind || "owned",
      renamed: byRepoId.slug !== discoveredKey };
  }

  const samePublicIdentity = row => row?.namespace === meta.namespace
    && row?.repo_slug === meta.repoSlug;
  const adoptableLegacy = row => !!row && row.repo_id == null
    && row.project_id === meta.projectId && samePublicIdentity(row);

  if (byProjectId) {
    if (adoptableLegacy(byProjectId)) {
      return { action: "index", storageKey: byProjectId.slug,
        projectId: byProjectId.project_id,
        projectKind: byProjectId.project_kind || meta.projectKind || "owned",
        renamed: byProjectId.slug !== discoveredKey, adoptedLegacy: true };
    }
    return { action: "quarantine", reason: "project id belongs to another Forgejo repository" };
  }

  if (byStorageKey) {
    if (adoptableLegacy(byStorageKey)) {
      return { action: "index", storageKey: byStorageKey.slug,
        projectId: byStorageKey.project_id,
        projectKind: byStorageKey.project_kind || meta.projectKind || "owned",
        renamed: false, adoptedLegacy: true };
    }
    return { action: "quarantine", reason: "storage key belongs to another Forgejo repository" };
  }

  return { action: "index", storageKey: discoveredKey,
    projectId: meta.projectId, projectKind: meta.projectKind || "owned", renamed: false };
}

/**
 * Authorization may run while a live reindex is waiting on network or DB I/O.
 * The Store-2 row is usable only while it still describes the physical
 * Forgejo repository currently bound to the Store-1 key. A native transfer or
 * rename therefore fails closed until the authoritative transaction lands.
 */
export function hostedRepositoryIdentityMatches(indexed, physical) {
  if (!indexed || !physical || indexed.repo_id == null || physical.repoId == null) return false;
  return String(indexed.repo_id) === String(physical.repoId)
    && indexed.namespace === physical.namespace
    && indexed.repo_slug === physical.repoSlug;
}

/**
 * Hide an identity-conflicting repository only after Forgejo proves that its
 * native source is private. Removing it from the in-process registry first
 * would stop future retries while a directly routed Forgejo repository could
 * remain anonymously cloneable.
 */
export async function quarantineHostedProject(store, key, reason) {
  let result;
  try { result = await store.setVisibility(key, "private"); }
  catch (cause) {
    throw Object.assign(new Error(`cannot isolate Forgejo repository '${key}': ${cause.message}`), {
      code: "FORGE_REPOSITORY_ISOLATION_FAILED", cause,
    });
  }
  if (result?.visibility !== "private") {
    throw Object.assign(new Error(`Forgejo did not confirm private isolation for '${key}'`), {
      code: "FORGE_REPOSITORY_ISOLATION_FAILED",
    });
  }
  if (store.quarantineProject?.(key) !== true) {
    throw Object.assign(new Error(`cannot quarantine unknown Forgejo repository '${key}'`), {
      code: "FORGE_REPOSITORY_ISOLATION_FAILED",
    });
  }
  return { key, reason, visibility: "private" };
}

/**
 * Suppress a conflicting hosted repository only after Store 1 has re-read and
 * confirmed its native private flag. Removing it from Forge discovery first
 * could conceal an anonymously clonable Git repository from the operator.
 */
export async function quarantineHostedRepository(store, key) {
  const privacy = await store.ensurePrivate(key);
  if (privacy?.visibility !== "private" || privacy?.confirmed !== true)
    throw Object.assign(new Error(`repository '${key}' privacy was not confirmed`),
      { code: "FORGE_STORAGE_ISOLATION_FAILED" });
  if (!store.quarantineProject(key))
    throw Object.assign(new Error(`repository '${key}' disappeared before quarantine`),
      { code: "FORGE_STORAGE_ISOLATION_FAILED" });
  return { private: true, quarantined: true };
}
