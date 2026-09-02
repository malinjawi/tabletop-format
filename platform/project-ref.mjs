// @ts-check
/** Stable repository identity helpers. `storageKey` is an implementation key;
 * public identity is always namespace/repoSlug and projectId never changes. */
export const PROJECT_META = "forge/project.json";
const PART = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function validProjectPart(value) {
  return PART.test(String(value ?? ""));
}

export function fallbackProject(storageKey, namespace = "community") {
  const split = String(storageKey).indexOf("~");
  return split > 0
    ? { storage_key: storageKey, project_id: `legacy:${storageKey}`, namespace: storageKey.slice(0, split), slug: storageKey.slice(split + 1) }
    : { storage_key: storageKey, project_id: `legacy:${storageKey}`, namespace, slug: storageKey };
}

export function parseProjectMeta(bytes, storageKey, namespace = "community", { storedKey = false } = {}) {
  const fallback = fallbackProject(storageKey, namespace);
  if (!bytes) return fallback;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!validProjectPart(value.namespace) || !validProjectPart(value.slug)) return fallback;
    if (typeof value.project_id !== "string" || !/^p_[a-f0-9]{16}$/.test(value.project_id)) return fallback;
    const key = storedKey && /^[a-z0-9][a-z0-9~-]{1,129}$/.test(value.storage_key ?? "")
      ? value.storage_key : storageKey;
    return { storage_key: key, project_id: value.project_id, namespace: value.namespace, slug: value.slug };
  } catch { return fallback; }
}

export function projectMetaBytes({ storageKey, projectId, namespace, slug }) {
  if (!validProjectPart(namespace) || !validProjectPart(slug)) throw new Error("invalid project namespace or slug");
  if (!/^p_[a-f0-9]{16}$/.test(projectId)) throw new Error("invalid stable project id");
  return Buffer.from(JSON.stringify({ format: "forge-project-identity", version: 1,
    project_id: projectId, namespace, slug, storage_key: storageKey }, null, 2) + "\n");
}

export function publicProjectPath(project) {
  return `/g/${encodeURIComponent(project.namespace)}/${encodeURIComponent(project.slug)}`;
}
