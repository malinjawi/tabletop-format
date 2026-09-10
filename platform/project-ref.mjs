// @ts-check
/** Stable repository identity helpers. `storageKey` is an implementation key;
 * public identity is always namespace/repoSlug and projectId never changes. */
export const PROJECT_META = "forge/project.json";
export const PROJECT_KIND_OWNED = "owned";
export const PROJECT_KIND_SANDBOX = "public-sandbox";
const PART = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function validProjectPart(value) {
  return PART.test(String(value ?? ""));
}

export function fallbackProject(storageKey, namespace = "community", slug = null) {
  const split = String(storageKey).indexOf("~");
  const fallback = split > 0
    ? { storage_key: storageKey, project_id: `legacy:${storageKey}`, namespace: storageKey.slice(0, split), slug: storageKey.slice(split + 1) }
    : { storage_key: storageKey, project_id: `legacy:${storageKey}`, namespace, slug: storageKey };
  return { ...fallback, ...(slug ? { namespace, slug } : {}),
    project_kind: PROJECT_KIND_OWNED, metadata_valid: false };
}

/**
 * Parse protected repository identity. Version-1 and missing metadata remain
 * ordinary owned projects. Only a valid version-2 declaration can opt into an
 * open sandbox. When a repository backend supplies its actual owner/name, a
 * conflicting declaration is rejected and normalized to that real identity.
 */
export function parseProjectMeta(bytes, storageKey, namespace = "community",
  { storedKey = false, expectedNamespace = null, expectedSlug = null } = {}) {
  const boundNamespace = expectedNamespace || namespace;
  const fallback = fallbackProject(storageKey, boundNamespace, expectedSlug);
  if (!bytes) return fallback;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (value.format !== "forge-project-identity" || ![1, 2].includes(value.version)) return fallback;
    if (!validProjectPart(value.namespace) || !validProjectPart(value.slug)) return fallback;
    if (typeof value.project_id !== "string" || !/^p_[a-f0-9]{16}$/.test(value.project_id)) return fallback;
    if ((expectedNamespace && value.namespace !== expectedNamespace)
      || (expectedSlug && value.slug !== expectedSlug)) return fallback;
    if (storedKey && expectedNamespace && expectedSlug
      && ![expectedSlug, `${expectedNamespace}~${expectedSlug}`].includes(value.storage_key)) return fallback;
    const key = storedKey && /^[a-z0-9][a-z0-9~-]{1,129}$/.test(value.storage_key ?? "")
      ? value.storage_key : storageKey;
    const projectKind = value.version === 2 && value.project_kind === PROJECT_KIND_SANDBOX
      ? PROJECT_KIND_SANDBOX : PROJECT_KIND_OWNED;
    return { storage_key: key, project_id: value.project_id, namespace: value.namespace,
      slug: value.slug, project_kind: projectKind, metadata_valid: true };
  } catch { return fallback; }
}

export function projectMetaBytes({ storageKey, projectId, namespace, slug,
  projectKind = PROJECT_KIND_OWNED }) {
  if (!validProjectPart(namespace) || !validProjectPart(slug)) throw new Error("invalid project namespace or slug");
  if (!/^p_[a-f0-9]{16}$/.test(projectId)) throw new Error("invalid stable project id");
  if (![PROJECT_KIND_OWNED, PROJECT_KIND_SANDBOX].includes(projectKind))
    throw new Error("project kind must be owned or public-sandbox");
  return Buffer.from(JSON.stringify({ format: "forge-project-identity", version: 2,
    project_id: projectId, namespace, slug, storage_key: storageKey,
    project_kind: projectKind }, null, 2) + "\n");
}

export function publicProjectPath(project) {
  return `/g/${encodeURIComponent(project.namespace)}/${encodeURIComponent(project.slug)}`;
}
