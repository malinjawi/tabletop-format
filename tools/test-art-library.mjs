#!/usr/bin/env node
import assert from "node:assert/strict";
import { artLibraryBytes, diffArtLibrary, emptyArtLibrary, mergeArtLibrary, parseArtLibrary } from "./lib/art-library.mjs";

const base = { format: "forge-art-library", version: 1, assets: [
  { path: "assets/card-art/a.png", tags: ["portrait"] },
  { path: "assets/card-art/b.png", tags: ["location"] },
] };
const proposed = structuredClone(base);
proposed.assets[0].tags.push("runner");
const current = structuredClone(base);
current.assets[1].tags.push("night");
const clean = mergeArtLibrary(base, proposed, current);
assert.deepEqual(clean.conflicts, []);
assert.deepEqual(clean.merged.assets, [
  { path: "assets/card-art/a.png", tags: ["portrait", "runner"] },
  { path: "assets/card-art/b.png", tags: ["location", "night"] },
]);
assert.deepEqual(diffArtLibrary(base, clean.merged).map(change => [change.path, change.kind]), [
  ["assets/card-art/a.png", "changed"], ["assets/card-art/b.png", "changed"],
]);

const competing = structuredClone(base);
competing.assets[0].tags = ["corp"];
const conflicted = mergeArtLibrary(base, proposed, competing);
assert.equal(conflicted.conflicts.length, 1);
assert.equal(conflicted.conflicts[0].path, "assets/card-art/a.png");
assert.deepEqual(conflicted.merged.assets[0], competing.assets[0], "conflicts keep current HEAD until a person resolves them");

const bytes = artLibraryBytes({ format: "forge-art-library", version: 1, assets: [
  { path: "assets/card-art/z.png", tags: ["zeta", "alpha"] },
] });
assert.deepEqual(parseArtLibrary(bytes), { format: "forge-art-library", version: 1,
  assets: [{ path: "assets/card-art/z.png", tags: ["alpha", "zeta"] }] });
assert.deepEqual(parseArtLibrary(null), emptyArtLibrary());
assert.throws(() => parseArtLibrary(Buffer.from('{"format":"wrong"}')), /unsupported/);
assert.throws(() => parseArtLibrary(Buffer.from(JSON.stringify({ ...base, assets: [base.assets[0], base.assets[0]] }))), /repeats/);
assert.throws(() => parseArtLibrary(Buffer.from(JSON.stringify({ ...base,
  assets: [{ path: "assets/card-art/a.png", tags: ["Not portable"] }] }))), /invalid tags/);
assert.throws(() => parseArtLibrary(Buffer.from(JSON.stringify({ ...base,
  assets: [{ path: "assets/../secret.png", tags: ["secret"] }] }))), /unsafe/);

console.log("art library: versioned metadata, deterministic bytes, record merge, and conflicts OK");
