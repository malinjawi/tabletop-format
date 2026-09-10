// @ts-check

// Store 1 materializes immutable repository snapshots. In addition to mutable
// HEAD and exact/abbreviated object ids, Forge exposes its tightly-scoped v*
// release names in historical-file, diff, rights, jam, and render URLs. Do not
// accept branches, revision expressions, path syntax, or arbitrary Git refs.
const EXACT_GIT_REF = /^[0-9a-f]{7,40}$/i;
const RELEASE_TAG = /^v[0-9][0-9A-Za-z._-]{0,31}$/;
const FULL_GIT_OBJECT_ID = /^[0-9a-f]{40}$/i;

export function store1Ref(value) {
  const ref = String(value ?? "");
  if (ref === "HEAD" || EXACT_GIT_REF.test(ref) || RELEASE_TAG.test(ref)) return ref;
  throw Object.assign(new Error("version reference must be HEAD, a Forge v* release, or a 7–40 character hexadecimal Git object id"),
    { status: 422 });
}

export function localStore1Ref(value, slug) {
  const ref = store1Ref(value);
  // The local monorepo namespaces every game's release tag so two projects can
  // both publish v1.0 without collision. Forgejo gives each game its own repo,
  // therefore its backend can use the validated v* name directly.
  return RELEASE_TAG.test(ref) ? `refs/tags/forge/${slug}/${ref}` : ref;
}

export function fullStore1ObjectId(value, label = "Git object ID") {
  const id = String(value ?? "").trim().toLowerCase();
  if (FULL_GIT_OBJECT_ID.test(id)) return id;
  throw new Error(`${label} must be a full 40-character Git object ID`);
}
