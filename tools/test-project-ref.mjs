#!/usr/bin/env node
import assert from "node:assert/strict";
import { PROJECT_KIND_OWNED, PROJECT_KIND_SANDBOX, parseProjectMeta,
  projectMetaBytes } from "../platform/project-ref.mjs";

const identity = { storageKey: "alice~demo", projectId: "p_0123456789abcdef",
  namespace: "alice", slug: "demo" };

for (const [label, bytes] of [["missing", null], ["malformed", Buffer.from("{")]]) {
  const value = parseProjectMeta(bytes, identity.storageKey, identity.namespace);
  assert.equal(value.project_kind, PROJECT_KIND_OWNED, `${label} metadata defaults owned`);
  assert.equal(value.metadata_valid, false, `${label} metadata is not trusted for owner recovery`);
}

const v1 = Buffer.from(JSON.stringify({ format: "forge-project-identity", version: 1,
  project_id: identity.projectId, namespace: identity.namespace, slug: identity.slug,
  storage_key: identity.storageKey }));
const legacy = parseProjectMeta(v1, identity.storageKey, identity.namespace);
assert.equal(legacy.project_kind, PROJECT_KIND_OWNED, "version 1 cannot opt into sandbox mode");
assert.equal(legacy.metadata_valid, true, "valid version 1 identity remains usable for owner recovery");

const serialized = projectMetaBytes({ ...identity, projectKind: PROJECT_KIND_SANDBOX });
const sandbox = parseProjectMeta(serialized, identity.storageKey, identity.namespace,
  { storedKey: true, expectedNamespace: identity.namespace, expectedSlug: identity.slug });
assert.equal(sandbox.project_kind, PROJECT_KIND_SANDBOX, "valid version 2 sandbox marker round-trips");
assert.equal(sandbox.metadata_valid, true);

const unknownKind = JSON.parse(serialized.toString());
unknownKind.project_kind = "open-to-everyone";
assert.equal(parseProjectMeta(Buffer.from(JSON.stringify(unknownKind)), identity.storageKey,
  identity.namespace).project_kind, PROJECT_KIND_OWNED, "unknown project kind fails closed");
assert.throws(() => projectMetaBytes({ ...identity, projectKind: "open-to-everyone" }),
  /project kind/, "serializer rejects unknown project kinds");

const forged = JSON.parse(serialized.toString());
forged.namespace = "victim";
forged.slug = "stolen";
forged.storage_key = "victim~stolen";
const normalized = parseProjectMeta(Buffer.from(JSON.stringify(forged)), identity.storageKey,
  identity.namespace, { storedKey: true, expectedNamespace: identity.namespace, expectedSlug: identity.slug });
assert.deepEqual({ namespace: normalized.namespace, slug: normalized.slug,
  project_kind: normalized.project_kind, metadata_valid: normalized.metadata_valid },
{ namespace: identity.namespace, slug: identity.slug,
  project_kind: PROJECT_KIND_OWNED, metadata_valid: false },
"metadata that disagrees with the physical repository is normalized owned and untrusted");

const aliased = JSON.parse(serialized.toString());
aliased.storage_key = "someone-elses-project";
const aliasResult = parseProjectMeta(Buffer.from(JSON.stringify(aliased)), identity.storageKey,
  identity.namespace, { storedKey: true, expectedNamespace: identity.namespace, expectedSlug: identity.slug });
assert.equal(aliasResult.storage_key, identity.storageKey, "Forgejo metadata cannot alias another repository key");
assert.equal(aliasResult.metadata_valid, false, "a rejected storage-key alias is not trusted");
assert.equal(aliasResult.project_kind, PROJECT_KIND_OWNED, "a rejected alias cannot retain sandbox authority");

console.log("PROJECT IDENTITY GREEN — explicit sandboxes persist; legacy and mismatched metadata fail closed.");
