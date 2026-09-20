#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openDb, q } from "../platform/db.mjs";
import { tokenDigest } from "../platform/auth.mjs";
import { PROJECT_KIND_OWNED, PROJECT_META, projectMetaBytes } from "../platform/project-ref.mjs";
import { rightsManifestBytes } from "../platform/rights.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-repository-file."));
const games = join(scratch, "examples"), dbPath = join(scratch, "platform.db");
const guardDir = join(scratch, "guard"), archiveTrace = join(scratch, "archive-attempts");
const rawToken = "b".repeat(64);
const auth = { Authorization: `Bearer ${rawToken}` };
const git = (...args) => execFileSync("git", ["-C", scratch, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const png = readFileSync(join(ROOT, "examples/ember/assets/art/kindling.png"));
// Larger than child_process's default buffer and deliberately non-UTF-8.
const oldImage = Buffer.concat([png, Buffer.alloc(1100 * 1024, 0xff)]);
const newImage = Buffer.concat([png, Buffer.from([0, 0xfe, 0xfd, 0x80])]);
const oldLfs = Buffer.concat([png, Buffer.from("historical LFS artwork")]);
const newLfs = Buffer.concat([png, Buffer.from("replacement LFS artwork")]);
const pointer = bytes => {
  const oid = createHash("sha256").update(bytes).digest("hex");
  write(join(scratch, ".git/lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid), bytes);
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`;
};
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close(error => error ? reject(error) : resolvePort(port));
  });
});
let server, output = "", checks = 0;

try {
  git("init", "-q");
  git("config", "user.name", "Repository File Test");
  git("config", "user.email", "repository@example.test");
  for (const slug of ["public-files", "private-files"]) {
    const privateGame = slug === "private-files", dir = join(games, slug);
    write(join(dir, "game.yaml"), `id: ${slug}\ntitle: ${slug}\nlicense: ${privateGame ? "proprietary" : "CC0-1.0"}\n`);
    write(join(dir, "forge/rights.json"), rightsManifestBytes({
      license: privateGame ? "proprietary" : "CC0-1.0", owner: "alice", status: privateGame ? "unknown" : "original",
    }));
    write(join(dir, PROJECT_META), projectMetaBytes({ storageKey: slug,
      projectId: privateGame ? "p_1111111111111111" : "p_2222222222222222",
      namespace: "alice", slug, projectKind: PROJECT_KIND_OWNED }));
    write(join(dir, "rules/rules.md"), "Historical rules\n");
    write(join(dir, "assets/art/original.png"), oldImage);
    write(join(dir, "assets/art/lfs.png"), pointer(oldLfs));
    write(join(dir, "assets/art/empty.svg"), "");
    write(join(dir, "assets/art/folder.png/nested.txt"), "A directory is not an image\n");
  }
  git("add", "examples"); git("commit", "-qm", "original source files");
  const oldRef = git("rev-parse", "HEAD");
  for (const slug of ["public-files", "private-files"])
    git("tag", `forge/${slug}/v1.0`, oldRef);
  for (const slug of ["public-files", "private-files"]) {
    write(join(games, slug, "rules/rules.md"), "Current rules\n");
    write(join(games, slug, "assets/art/original.png"), newImage);
    write(join(games, slug, "assets/art/lfs.png"), pointer(newLfs));
  }
  git("add", "examples"); git("commit", "-qm", "replace source files");
  const currentRef = git("rev-parse", "HEAD");
  write(join(scratch, "unrelated.txt"), "Not a project revision\n");
  git("add", "unrelated.txt"); git("commit", "-qm", "unrelated repository change");
  const unrelatedRef = git("rev-parse", "HEAD");

  const seed = openDb(dbPath);
  await q.createUser(seed, { id: "u_1111111111111111", handle: "alice", email: "alice@example.test", pass_hash: "unused" });
  await q.createSession(seed, tokenDigest(rawToken), "u_1111111111111111", 600_000);
  seed.close();

  // Exercise the actual server and Store1 implementation while making whole
  // project materialization impossible. No production injection hook is needed.
  const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  write(join(guardDir, "git"), `#!/bin/sh\nfor argument do\n  if [ "$argument" = "archive" ]; then\n    printf '%s\\n' archive >> ${quote(archiveTrace)}\n    exit 91\n  fi\ndone\nexec ${quote(actualGit)} "$@"\n`);
  chmodSync(join(guardDir, "git"), 0o755);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port), "--games", games], {
    cwd: ROOT, env: { ...process.env, NODE_ENV: "development", STORE1: "local", DB: "sqlite",
      LOCAL_STORE_ROOT: scratch, DB_PATH: dbPath, CACHE_DIR: join(scratch, "cache"),
      RELEASE_VAULT_DIR: join(scratch, "release-vault"), FORGE_HUB_PATH: join(scratch, "hub.html"),
      FORGE_INCLUDE_TEST_FIXTURES: "0", FORGE_PREVIEW_PRIVATE_FIXTURES: "0", LFS_URL: "",
      FORGE_PUBLIC_ORIGIN: origin, FORGE_LISTEN_HOST: "127.0.0.1", FORGE_RATE_MAX: "1000",
      PATH: `${guardDir}:${process.env.PATH || ""}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { output += chunk; });
  server.stderr.on("data", chunk => { output += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  assert.ok(ready, `server did not start:\n${output}`);
  const fileUrl = (slug, path, ref) => `${origin}/api/games/${slug}/repository/file/${path.split("/").map(encodeURIComponent).join("/")}${ref == null ? "" : `?ref=${encodeURIComponent(ref)}`}`;
  const expectFile = async (slug, path, ref, expected, type, headers = {}) => {
    const response = await fetch(fileUrl(slug, path, ref), { headers });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${slug}/${path}@${ref}: ${bytes.toString().slice(0, 300)}\n${output}`);
    assert.deepEqual(bytes, Buffer.from(expected), `${slug}/${path}@${ref} returns exact bytes`);
    assert.equal(response.headers.get("content-type"), type);
    assert.equal(response.headers.get("cache-control"), slug === "private-files" ? "private, no-store" : "public, no-cache, must-revalidate");
    assert.equal(response.headers.get("content-disposition"), `inline; filename="${path.split("/").pop()}"`);
    checks++;
  };

  for (const slug of ["public-files", "private-files"]) {
    const headers = slug === "private-files" ? auth : {};
    for (const ref of [oldRef, oldRef.slice(0, 7), "v1.0"]) {
      await expectFile(slug, "assets/art/original.png", ref, oldImage, "image/png", headers);
      await expectFile(slug, "assets/art/lfs.png", ref, oldLfs, "image/png", headers);
      await expectFile(slug, "rules/rules.md", ref, "Historical rules\n", "text/markdown", headers);
    }
    for (const ref of [currentRef, "HEAD", null]) {
      await expectFile(slug, "assets/art/original.png", ref, newImage, "image/png", headers);
      await expectFile(slug, "assets/art/lfs.png", ref, newLfs, "image/png", headers);
      await expectFile(slug, "rules/rules.md", ref, "Current rules\n", "text/markdown", headers);
    }
    await expectFile(slug, "assets/art/empty.svg", oldRef, "", "image/svg+xml", headers);
    for (const path of ["assets/art/missing.png", "assets/art/folder.png"])
      assert.equal((await fetch(fileUrl(slug, path, oldRef), { headers })).status, 404, `${path} is not a file`), checks++;
    for (const ref of [unrelatedRef, "not-a-ref", "HEAD;echo unsafe"])
      assert.equal((await fetch(fileUrl(slug, "assets/art/original.png", ref), { headers })).status, 422, `${ref} cannot bypass project version validation`), checks++;
  }
  for (const ref of [oldRef, "HEAD", null]) {
    assert.equal((await fetch(fileUrl("private-files", "assets/art/original.png", ref))).status, 404, "anonymous users cannot read private files"); checks++;
    assert.equal((await fetch(fileUrl("private-files", "assets/art/original.png", ref), { headers: { Authorization: "Bearer invalid" } })).status, 404, "invalid sessions cannot read private files"); checks++;
  }
  const inventoryResponse = await fetch(`${origin}/api/games/public-files/repository/assets`);
  assert.equal(inventoryResponse.status, 200);
  const inventory = await inventoryResponse.json();
  const emittedImage = inventory.items.find(item => item.path === "assets/art/original.png");
  assert.equal(new URL(emittedImage.url, origin).searchParams.get("ref"), currentRef);
  // A cold grid issues several requests together; every response must remain a
  // single-file read, rather than independently archiving the project.
  const grid = await Promise.all(Array.from({ length: 12 }, () => fetch(new URL(emittedImage.url, origin))));
  for (const response of grid) { assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), newImage); checks++; }
  assert.equal(existsSync(archiveTrace), false, "repository inventory and file reads never invoke whole-project materialization"); checks++;
  console.log(`REPOSITORY FILE GREEN — ${checks} checks cover exact history, tag/short refs, binary/LFS bytes, private access/cache, missing files, and concurrent grid reads with materialization forbidden.`);
} finally {
  if (server && server.exitCode == null) { const closed = once(server, "exit"); server.kill("SIGTERM"); await closed; }
  rmSync(scratch, { recursive: true, force: true });
}
