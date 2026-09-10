// @ts-check
import { roleCapabilities, validCollaboratorRole } from "./collaboration.mjs";
import { PROJECT_KIND_SANDBOX } from "./project-ref.mjs";

/**
 * Open sandboxes must be explicit. `owner_id = null` can also mean an index is
 * being rebuilt, an account has not been restored yet, or a private research
 * fixture was imported. Treating that absence as permission would turn an
 * availability/recovery state into public write and release authority.
 *
 * The grant is versioned in protected `forge/project.json`, then copied into
 * the rebuildable Store-2 index as `project_kind`.
 */
export function isPublicOwnerlessSandbox(game) {
  return !!game && !game.owner_id && game.visibility === "public"
    && game.project_kind === PROJECT_KIND_SANDBOX;
}

/**
 * Compute the complete project permission contract from one indexed game row.
 * Keeping this matrix pure makes read, commit, review, merge, and release
 * policy testable together instead of letting route-specific exceptions drift.
 */
export function projectAccess(game, user, collaboratorRole = null) {
  const signedIn = !!user;
  const ownerless = !!game && !game.owner_id;
  const isOwner = !!(signedIn && game?.owner_id && game.owner_id === user.id);
  const role = signedIn && validCollaboratorRole(collaboratorRole) ? collaboratorRole : null;
  const capabilities = roleCapabilities(role);
  const sandbox = isPublicOwnerlessSandbox(game);

  return {
    signed_in: signedIn,
    // A missing Store-2 index row is not proof of public visibility. Startup
    // rebuilds this index from Git, so an absent row must fail closed.
    can_read: !!game && (game.visibility === "public" || !!(signedIn && (isOwner || role))),
    can_write: !!(signedIn && (sandbox || isOwner || capabilities.can_write)),
    can_review: !!(signedIn && (sandbox || isOwner || capabilities.can_review)),
    can_merge: !!(signedIn && (sandbox || isOwner || capabilities.can_merge)),
    // A disposable sandbox can demonstrate write/review/merge, but publishing
    // a citable release requires an owned edition.
    can_release: !!(signedIn && isOwner),
    role,
    is_owner: isOwner,
    ownerless,
    sandbox,
  };
}
