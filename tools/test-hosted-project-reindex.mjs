#!/usr/bin/env node
import assert from "node:assert/strict";
import { hostedProjectReindexPlan, hostedRepositoryIdentityMatches,
  quarantineHostedProject } from "../platform/project-reindex.mjs";

const row = { slug: "stable-key", project_id: "p_stable", project_kind: "owned",
  namespace: "alice", repo_slug: "old-name", repo_id: "42" };

let plan = hostedProjectReindexPlan("bob~new-name", {
  repoId: "42", projectId: "p_tampered", namespace: "bob", repoSlug: "new-name"
}, { byRepoId: row, byProjectId: null, byStorageKey: null });
assert.deepEqual(plan, { action: "index", storageKey: "stable-key", projectId: "p_stable",
  projectKind: "owned", renamed: true },
"stable Forgejo repo id preserves the internal key and project id across rename/transfer");

plan = hostedProjectReindexPlan("mallory~copy", {
  repoId: "99", projectId: "p_stable", namespace: "mallory", repoSlug: "copy"
}, { byRepoId: null, byProjectId: row, byStorageKey: null });
assert.equal(plan.action, "quarantine");
assert.match(plan.reason, /project id belongs/,
  "a different physical repository cannot claim an existing project id");

plan = hostedProjectReindexPlan("stable-key", {
  repoId: "99", projectId: "p_other", namespace: "mallory", repoSlug: "copy"
}, { byRepoId: null, byProjectId: null, byStorageKey: row });
assert.equal(plan.action, "quarantine",
  "a different physical repository cannot claim an existing storage key");

const legacy = { ...row, repo_id: null };
plan = hostedProjectReindexPlan("alice~old-name", {
  repoId: "42", projectId: "p_stable", namespace: "alice", repoSlug: "old-name",
  projectKind: "owned"
}, { byRepoId: null, byProjectId: legacy, byStorageKey: null });
assert.equal(plan.action, "index");
assert.equal(plan.storageKey, "stable-key");
assert.equal(plan.adoptedLegacy, true,
  "a precisely matching pre-repo-id row can be adopted once");

assert.equal(hostedProjectReindexPlan("broken", { repoId: null }, {}).action, "quarantine",
  "hosted discovery fails closed without a stable repository id");

const physical = { repoId: "42", namespace: "alice", repoSlug: "old-name" };
assert.equal(hostedRepositoryIdentityMatches(row, physical), true,
  "an unchanged physical repository may use its indexed access grants");
assert.equal(hostedRepositoryIdentityMatches(row, { ...physical, namespace: "bob" }), false,
  "a native transfer revokes indexed access while reindex is in flight");
assert.equal(hostedRepositoryIdentityMatches(row, { ...physical, repoSlug: "new-name" }), false,
  "a native rename revokes indexed access while reindex is in flight");
assert.equal(hostedRepositoryIdentityMatches(row, { ...physical, repoId: "99" }), false,
  "a different physical repository cannot inherit indexed access");
assert.equal(hostedRepositoryIdentityMatches({ ...row, repo_id: null }, physical), false,
  "missing stable identity fails closed for hosted authorization");

let suppressed = false;
await assert.rejects(() => quarantineHostedProject({
  setVisibility: async () => { throw new Error("native privacy unavailable"); },
  quarantineProject: () => { suppressed = true; return true; },
}, "mallory~copy", "duplicate project id"), error =>
  error?.code === "FORGE_REPOSITORY_ISOLATION_FAILED" && /cannot isolate/.test(error.message));
assert.equal(suppressed, false,
  "a repository remains retryable when native private isolation is not proven");

const isolated = [];
assert.deepEqual(await quarantineHostedProject({
  setVisibility: async key => ({ visibility: "private", key }),
  quarantineProject: key => { isolated.push(key); return true; },
}, "mallory~copy", "duplicate project id"), {
  key: "mallory~copy", reason: "duplicate project id", visibility: "private",
});
assert.deepEqual(isolated, ["mallory~copy"],
  "a repository leaves discovery only after native privacy is confirmed");

console.log("HOSTED PROJECT REINDEX GREEN — renames transfer safely and identity collisions quarantine.");
