#!/usr/bin/env node
import assert from "node:assert/strict";
import { projectAccess } from "../platform/project-access.mjs";

const owner = { id: "u_owner" };
const stranger = { id: "u_stranger" };

const expect = (label, actual, expected) => {
  for (const [key, value] of Object.entries(expected))
    assert.equal(actual[key], value, `${label}: ${key}`);
};

expect("missing project index", projectAccess(null, owner), {
  can_read: false, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});

const publicOwnerless = { owner_id: null, visibility: "public" };
expect("anonymous public ownerless demo", projectAccess(publicOwnerless, null), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: true, sandbox: false,
});
expect("signed-in public ownerless demo", projectAccess(publicOwnerless, stranger), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: true, sandbox: false,
});
const explicitPublicSandbox = { owner_id: null, visibility: "public", project_kind: "public-sandbox" };
expect("explicit signed-in public sandbox", projectAccess(explicitPublicSandbox, stranger), {
  can_read: true, can_write: true, can_review: true, can_merge: true,
  can_release: false, ownerless: true, sandbox: true,
});
expect("private sandbox marker stays closed", projectAccess({ ...explicitPublicSandbox, visibility: "private" }, stranger), {
  can_read: false, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: true, sandbox: false,
});
expect("owned sandbox marker stays owner-controlled", projectAccess({ ...explicitPublicSandbox, owner_id: owner.id }, stranger), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});

const privateOwnerless = { owner_id: null, visibility: "private" };
for (const [label, user] of [["anonymous", null], ["unrelated user", stranger]])
  expect(`${label} private ownerless fixture`, projectAccess(privateOwnerless, user), {
    can_read: false, can_write: false, can_review: false, can_merge: false,
    can_release: false, ownerless: true, sandbox: false,
  });
expect("explicit contributor on private ownerless fixture",
  projectAccess(privateOwnerless, stranger, "contributor"), {
    can_read: true, can_write: true, can_review: false, can_merge: false,
    can_release: false, ownerless: true, sandbox: false,
  });
expect("explicit maintainer on private ownerless fixture",
  projectAccess(privateOwnerless, stranger, "maintainer"), {
    can_read: true, can_write: true, can_review: true, can_merge: true,
    can_release: false, ownerless: true, sandbox: false,
  });

const privateOwned = { owner_id: owner.id, visibility: "private" };
expect("anonymous private owned project", projectAccess(privateOwned, null), {
  can_read: false, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});
expect("unrelated user on private owned project", projectAccess(privateOwned, stranger), {
  can_read: false, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});
expect("private project owner", projectAccess(privateOwned, owner), {
  can_read: true, can_write: true, can_review: true, can_merge: true,
  can_release: true, ownerless: false, sandbox: false,
});
expect("private project commenter", projectAccess(privateOwned, stranger, "commenter"), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});
expect("private project contributor", projectAccess(privateOwned, stranger, "contributor"), {
  can_read: true, can_write: true, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});
expect("private project maintainer", projectAccess(privateOwned, stranger, "maintainer"), {
  can_read: true, can_write: true, can_review: true, can_merge: true,
  can_release: false, ownerless: false, sandbox: false,
});

const publicOwned = { owner_id: owner.id, visibility: "public" };
expect("anonymous public owned project", projectAccess(publicOwned, null), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});
expect("unrelated user on public owned project", projectAccess(publicOwned, stranger), {
  can_read: true, can_write: false, can_review: false, can_merge: false,
  can_release: false, ownerless: false, sandbox: false,
});

console.log("PROJECT ACCESS GREEN — ownerless projects fail closed; only explicit public sandboxes open.");
