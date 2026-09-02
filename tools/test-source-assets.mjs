#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { inspectAsset } from "../platform/media-security.mjs";
import { ALLOWED_ASSET_EXT } from "./lib/limits.mjs";
import { buildForgeProject, loadForgeProject } from "./lib/forge-project.mjs";
import { SOURCE_ASSETS_MANIFEST, loadSourceAssets } from "./lib/source-assets.mjs";

const gameDir = resolve("examples/secret-hitler");
const loaded = loadSourceAssets(gameDir);
assert.equal(loaded.manifest_path, SOURCE_ASSETS_MANIFEST);
assert.equal(loaded.summary.total, 4);
assert.equal(loaded.summary.ready, 4);
assert.equal(loaded.summary.issues, 0);
assert(loaded.packages.every(pack => /^sha256:[a-f0-9]{64}$/.test(pack.input_hash)));
assert(loaded.packages.find(pack => pack.id === "card-production").source_files.length >= 9);

const project = buildForgeProject(gameDir, { withArt: false, sourceRef: "test-source-packages" });
assert.equal(project.manifest.source_packages.summary.ready, 4);
assert(project.manifest.files.some(file => file.source_path === SOURCE_ASSETS_MANIFEST));
assert(project.manifest.files.some(file => file.source_path === "assets/official-pnp/source-faces/p_role_hitler.png"));
assert.equal(loadForgeProject(project.archive).manifest.source_packages.summary.total, 4);

for (const ext of ["afdesign", "afpub", "idml", "sla", "kra", "ora", "xcf", "blend", "gltf", "glb", "obj", "stl"])
  assert(ALLOWED_ASSET_EXT.has(ext), `${ext} must be accepted as an opaque or validated production source`);
inspectAsset("assets/models/pawn.stl", Buffer.from("solid pawn\nendsolid pawn\n"));
inspectAsset("assets/models/pawn.obj", Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"));
inspectAsset("assets/models/pawn.gltf", Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scenes: [] })));
assert.throws(() => inspectAsset("assets/models/bad.gltf", Buffer.from(JSON.stringify({
  asset: { version: "2.0" }, images: [{ uri: "https://tracker.example/image.png" }],
}))), /dependencies must be relative/);
assert.throws(() => inspectAsset("assets/models/bad.stl", Buffer.from("not a mesh")), /neither binary STL nor ASCII STL/);

console.log("SOURCE PACKAGES GREEN — manifest, exact inputs, portable project, native formats, and safe 3D admission verified.");
