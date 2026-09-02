// @ts-check
export const COLLABORATOR_ROLES = ["commenter", "contributor", "maintainer"];

export function validCollaboratorRole(role) {
  return COLLABORATOR_ROLES.includes(role);
}

export function roleCapabilities(role) {
  return { can_comment: !!role, can_write: ["contributor", "maintainer"].includes(role),
    can_review: role === "maintainer", can_merge: role === "maintainer", can_release: false };
}

export function collaborationFiles(owner, maintainers = []) {
  const reviewers = [...new Set([owner, ...maintainers])].sort().map(handle => `@${handle}`).join(" ");
  const codeowners = `# Forge review ownership — generated from repository roles.\n`
    + `components/.* ${reviewers}\n`
    + `templates/.* ${reviewers}\n`
    + `rules/.* ${reviewers}\n`
    + `assets/.* ${reviewers}\n`
    + `forge/.* ${reviewers}\n`;
  const policy = { format: "forge-collaboration", version: 1, required_approvals: 1,
    dismiss_stale_reviews: true, require_validation: true,
    roles: { commenter: ["comment"], contributor: ["comment", "commit"],
      maintainer: ["comment", "commit", "review", "merge"], owner: ["admin", "release"] } };
  return [{ path: "CODEOWNERS", content: codeowners },
    { path: "forge/collaboration.json", content: JSON.stringify(policy, null, 2) + "\n" }];
}

export function collaborationPolicy(bytes) {
  try {
    const value = JSON.parse(Buffer.from(bytes ?? "").toString("utf8"));
    return { required_approvals: Math.max(1, Math.min(5, Number(value.required_approvals) || 1)),
      dismiss_stale_reviews: value.dismiss_stale_reviews !== false,
      require_validation: value.require_validation !== false };
  } catch { return { required_approvals: 1, dismiss_stale_reviews: true, require_validation: true }; }
}
