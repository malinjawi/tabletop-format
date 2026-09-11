#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, q } from "../platform/db.mjs";
import { tokenDigest } from "../platform/auth.mjs";
import { DATA_EXPORT_VERSION, RENDER_COMPLETION_FILE, releaseArtifactReceipts } from "../platform/cache.mjs";
import { PROJECT_KIND_OWNED, PROJECT_META, projectMetaBytes } from "../platform/project-ref.mjs";
import { readZip } from "./lib/deterministic-zip.mjs";

const ROOT = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "forge-private-cache-"));
const games = join(temp, "examples");
const dbPath = join(temp, "platform.db");
const cacheDir = join(temp, "cache");
const hubPath = join(temp, "hub.html");
const browserTrace = join(temp, "browser-calls.log"), customChrome = join(temp, "custom chrome");
const actualChrome = process.env.CHROME_PATH || process.env.FMT_CHROME_BIN || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync);
assert.ok(actualChrome, "Install Chrome/Chromium or set CHROME_PATH");
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
// An actual browser behind a nonstandard path proves that both direct renders
// and isolated export workers preserve the developer's browser selection.
writeFileSync(customChrome, `#!/bin/sh\nprintf '%s\\n' browser >> ${shellQuote(browserTrace)}\nexec ${shellQuote(actualChrome)} "$@"\n`);
chmodSync(customChrome, 0o755);
const browserCalls = () => existsSync(browserTrace) ? readFileSync(browserTrace, "utf8").trim().split("\n").length : 0;
const json = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};
const copyGame = (name, destination = name) => cpSync(join(ROOT, "examples", name), join(games, destination), {
  recursive: true,
  filter: source => !source.split(/[\\/]/).includes("exports"),
});
const command = (args) => execFileSync(args[0], args.slice(1), { cwd: temp, stdio: "pipe" }).toString().trim();
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(error => error ? reject(error) : resolve(address.port));
  });
});

mkdirSync(games, { recursive: true });
copyGame("ember");
copyGame("harbor-nine");
copyGame("ember", "private-cache");

const privateDir = join(games, "private-cache");
const privateYaml = readFileSync(join(privateDir, "game.yaml"), "utf8")
  .replace(/^id:\s*ember$/m, "id: private-cache")
  .replace(/^title:\s*Ember$/m, "title: Private Cache")
  .replace(/^license:\s*CC0-1\.0$/m, "license: proprietary");
writeFileSync(join(privateDir, "game.yaml"), privateYaml);
writeFileSync(join(privateDir, PROJECT_META), projectMetaBytes({ storageKey: "private-cache",
  projectId: "p_1111111111111111", namespace: "alice", slug: "private-cache",
  projectKind: PROJECT_KIND_OWNED }));
json(join(privateDir, "forge", "rights.json"), {
  format: "forge-rights", version: 1,
  project: { license: "proprietary", owner: "alice", release_permission: "unverified" },
  default: { license: "proprietary", status: "unknown", copyright: ["alice"],
    redistribution: "private-only" },
  files: [],
});
mkdirSync(join(privateDir,"setups"),{recursive:true});
writeFileSync(join(privateDir,"setups","private-table.yaml"),`schema_version: 1
id: private-table
name: Private table
board: { width: 800, height: 600, background: "#222222" }
zones:
  - { id: draw, name: Draw, kind: draw, position: { x: 100, y: 100 }, size: { width: 125, height: 175 }, layout: stack, card_face: down }
stacks:
  - { id: deck, name: Deck, deck_id: burn-rush, zone_id: draw, face: down, shuffle: true }
`);

for (const gameDir of [join(games, "ember"), privateDir])
  json(join(gameDir, "templates", "affinity", "forge-affinity.json"), {
    format: "forge-affinity-binding", version: 1, bridge_dir: ".forge/affinity",
  });

command(["git", "init", "-q"]);
command(["git", "config", "user.name", "Cache Test"]);
command(["git", "config", "user.email", "cache@example.test"]);
command(["git", "add", "."]);
command(["git", "commit", "-qm", "cache fixtures"]);
const fullRef = command(["git", "rev-parse", "HEAD"]);
const shortRef = fullRef.slice(0, 7);
command(["git", "tag", "-a", "forge/ember/v1.0", fullRef, "-m", "render alias fixture"]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const inputHash = (slug, kind, version) => sha256(`${slug}\0${fullRef}\0${kind}\0${version}`);
const jobOutput = (slug, files) => {
  const kind = "data", exporter_version = DATA_EXPORT_VERSION;
  const hash = inputHash(slug, kind, exporter_version);
  return { ok: true, ref: fullRef, cached: false, urls: [], manifest: {
    format: "forge-export-attempt", version: 1, kind, exporter_version, slug, ref: fullRef,
    files, totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
    budget: {}, published_at: Date.now(), input_hash: hash,
  } };
};
const affinityUrls={};

for (const slug of ["ember", "private-cache"]) {
  // A nonempty render directory without the completion manifest is a crash
  // remnant, not a cache hit. The first request must atomically replace it.
  const render = join(cacheDir, "renders", slug, fullRef, "partial.png");
  const exported = join(cacheDir, "exports", slug, fullRef, "proof.bin");
  const bridge=join(games,slug,".forge","affinity");
  const affinity = join(bridge, "renders", fullRef, "proof.png");
  mkdirSync(dirname(render), { recursive: true });
  mkdirSync(dirname(exported), { recursive: true });
  mkdirSync(dirname(affinity), { recursive: true });
  writeFileSync(render, Buffer.from(`render:${slug}`));
  writeFileSync(exported, Buffer.from(`export:${slug}`));
  const preview=Buffer.from(`affinity:${slug}`),renderer=Buffer.from(`renderer:${slug}`);
  writeFileSync(affinity,preview);
  writeFileSync(join(bridge,"forge-affinity-sync.js"),renderer);
  const receiptInputHash=sha256(`affinity-input:${slug}`),rendererHash=sha256(renderer),outputHash=sha256(preview);
  json(join(bridge,"input.json"),{schema_version:1,kind:"forge-affinity-input",game:slug,
    commit_sha:fullRef,commit_short:fullRef.slice(0,12),input_hash:receiptInputHash,
    card:{id:"proof_card",name:"Proof"},printing_id:"proof_printing",
    render:{absolute_path:affinity,file:"proof.png"}});
  json(join(bridge,"status.json"),{schema_version:1,state:"ready",game:slug,card_id:"proof_card",
    printing_id:"proof_printing",commit_sha:fullRef,commit_short:fullRef.slice(0,12),
    input_hash:receiptInputHash,preview_file:"proof.png",renderer_sha256:rendererHash,
    preview_sha256:outputHash,preview_bytes:preview.length,updated_at:new Date().toISOString()});
  affinityUrls[slug]=`/api/games/${slug}/affinity/previews/${fullRef}/proof.png?input=${receiptInputHash}&renderer=${rendererHash}&output=${outputHash}`;
}

// Pure release-receipt regression: a file that happens to share the cache
// directory must not be promoted into a release.
const receiptDir = join(cacheDir, "receipt-proof");
mkdirSync(receiptDir, { recursive: true });
const declaredBytes = Buffer.from("declared release output");
writeFileSync(join(receiptDir, "declared.bin"), declaredBytes);
writeFileSync(join(receiptDir, "unrelated-prior-export.bin"), "must not publish");
const declaredOutput = jobOutput("ember", [{ name: "declared.bin", bytes: declaredBytes.length,
  sha256: sha256(declaredBytes) }]);
assert.deepEqual(releaseArtifactReceipts(receiptDir, [declaredOutput], "ember", fullRef)
  .map(item => item.name), ["declared.bin"], "release receipt includes exact job outputs only");

const alice = { id: "u_1111111111111111", handle: "alice", email: "alice@example.test", pass_hash: "hash" };
const rawToken = "a".repeat(64);
const seed = openDb(dbPath);
await q.createUser(seed, alice);
await q.upsertGame(seed, { slug: "ember", project_id: "p_3333333333333333",
  namespace: "community", repo_slug: "ember", title: "Ember", license: "CC0-1.0",
  visibility: "public", owner_id: null, project_kind: "public-sandbox" });
await q.upsertGame(seed, { slug: "private-cache", project_id: "p_1111111111111111",
  namespace: "alice", repo_slug: "private-cache", title: "Private Cache", license: "proprietary",
  visibility: "private", owner_id: alice.id, project_kind: PROJECT_KIND_OWNED });
for (const slug of ["ember", "private-cache"]) {
  const proof = Buffer.from(`export:${slug}`);
  const output = jobOutput(slug, [{ name: "proof.bin", bytes: proof.length, sha256: sha256(proof) }]);
  await q.createExportJob(seed, { id: `job_${slug.replace("-", "_")}`, game_slug: slug, ref: fullRef,
    kind: "data", exporter_version: DATA_EXPORT_VERSION,
    input_hash: inputHash(slug, "data", DATA_EXPORT_VERSION), created_by: alice.id, budget_json: "{}" });
  await q.finishExportJob(seed, `job_${slug.replace("-", "_")}`, "succeeded", JSON.stringify(output), null);
}
const releasedBytes=Buffer.from("released exact bytes"), corruptExpected=Buffer.from("expected release bytes");
const emberExportDir=join(cacheDir,"exports","ember",fullRef);
writeFileSync(join(emberExportDir,"released.bin"),releasedBytes);
writeFileSync(join(emberExportDir,"corrupt.bin"),"tampered release bytes");
writeFileSync(join(emberExportDir,"orphan.bin"),"orphan bytes");
writeFileSync(join(emberExportDir,"forge-export-manifest.json"),"internal evidence");
writeFileSync(join(emberExportDir,".complete-data-v3.json"),"internal marker");
await q.createRelease(seed,{game_slug:"ember",tag:"v-cache-test",sha:fullRef,title:"Cache receipt",
  artifacts_json:JSON.stringify([
    {status:"ready",name:"released.bin",bytes:releasedBytes.length,sha256:sha256(releasedBytes)},
    {status:"ready",name:"corrupt.bin",bytes:corruptExpected.length,sha256:sha256(corruptExpected)},
  ])});
await q.upsertGame(seed, { slug: "stale-owned", project_id: "p_2222222222222222",
  namespace: "alice", repo_slug: "stale-owned", title: "Removed private draft",
  license: "CC0-1.0", card_count: 9, description: "must disappear", topics_json: '["secret"]',
  players_min: 1, players_max: 2, visibility: "public", owner_id: alice.id,
  project_kind: PROJECT_KIND_OWNED });
await q.star(seed, alice.id, "stale-owned");
await q.createSession(seed, tokenDigest(rawToken), alice.id, 60_000);
seed.close();

const port = await freePort();
let serverOutput = "";
const server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port), "--games", games], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", STORE1: "local", LOCAL_STORE_ROOT: temp,
    DB_PATH: dbPath, CACHE_DIR: cacheDir, FORGE_HUB_PATH: hubPath,
    CHROME_PATH: customChrome,
    FORGE_INCLUDE_TEST_FIXTURES: "0", FORGE_PUBLIC_ORIGIN: "https://forge.example" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", chunk => { serverOutput += chunk; });
server.stderr.on("data", chunk => { serverOutput += chunk; });

const base = `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${rawToken}` };
const get = async (path, headers = {}) => {
  const response = await fetch(base + path, { headers });
  const type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { response, body };
};
const post = async (path, headers = {}) => {
  const response = await fetch(base + path, { method:"POST", headers });
  const body = await response.json();
  return { response, body };
};
const assertCache = async (path, expected, headers = {}) => {
  const result = await get(path, headers);
  assert.equal(result.response.status, 200, `${path} should respond; body=${JSON.stringify(result.body)}:\n${serverOutput}`);
  assert.equal(result.response.headers.get("cache-control"), expected, `${path} cache policy`);
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(ready, true, `server did not start:\n${serverOutput}`);

  const indexed = new DatabaseSync(dbPath);
  const stale = indexed.prepare("SELECT * FROM games WHERE slug = 'stale-owned'").get();
  indexed.close();
  assert.equal(stale.visibility, "private", "removed Store-1 repository is tombstoned private");
  assert.equal(stale.card_count, 0, "removed Store-1 repository loses catalog metadata");
  assert.equal(stale.description, "", "removed Store-1 repository loses searchable description");

  const staleDirect = await get("/api/games/stale-owned/cards", auth);
  assert.equal(staleDirect.response.status, 404, "stale Store-2 rows never authorize direct project reads");
  const me = await get("/api/me", auth);
  assert.equal(me.response.status, 200);
  assert.equal(me.response.headers.get("cache-control"), "private, no-store");
  assert.ok(!me.body.games.includes("stale-owned"), "/api/me excludes stale owned repositories");
  assert.ok(!me.body.starred.includes("stale-owned"), "/api/me excludes stars whose repository is gone");

  const privatePaths = [
    `/cache/renders/private-cache/${fullRef}/p_kindling_core.png`,
    `/cache/exports/private-cache/${fullRef}/proof.bin`,
    `/api/games/private-cache/repository/file/game.yaml?ref=${fullRef}`,
    "/api/games/private-cache/repository/file/game.yaml?ref=HEAD",
    "/api/games/private-cache/assets/art/kindling.png",
    affinityUrls["private-cache"],
    "/api/games/private-cache/components/svg/ember-token",
  ];
  for (const path of privatePaths) await assertCache(path, "private, no-store", auth);
  const privateAnonymous=await get(`/cache/exports/private-cache/${fullRef}/proof.bin`);
  assert.equal(privateAnonymous.response.status,404,"private job-backed exports require project read access");
  const privateTts=await post("/api/games/private-cache/export/tts?wait=1",auth);
  assert.equal(privateTts.response.status,422,"private TTS fails before creating a hosted export");
  assert.equal(privateTts.body.code,"private_tts_hosting_unsupported");
  const beforeWorkerBrowser = browserCalls();
  assert.ok(beforeWorkerBrowser > 0, "Direct card rendering uses CHROME_PATH even when its executable has a nonstandard name and spaces");
  const privateVtt=await post("/api/games/private-cache/export/vtt?wait=1",auth);
  assert.equal(privateVtt.response.status,200,JSON.stringify(privateVtt.body));
  assert.ok(browserCalls() > beforeWorkerBrowser, "The isolated export worker retains CHROME_PATH for its own rendering");
  assert.deepEqual(privateVtt.body.urls,[`/cache/exports/private-cache/${fullRef}/table-v3.vtt`],
    "private VTT advertises only its self-contained package");
  const vttPackage=await get(privateVtt.body.urls[0],auth),vttEntries=readZip(vttPackage.body);
  assert.equal(vttPackage.response.status,200);
  assert.ok(vttEntries.has("0.json")&&[...vttEntries].some(([name])=>name.startsWith("assets/")));
  assert.equal([...vttEntries.values()].some(bytes=>bytes.includes(Buffer.from("forge.example"))),false,
    "private VTT package contains no hosted private URL");
  assert.equal((await get(`/cache/exports/private-cache/${fullRef}/table-v3.json`,auth)).response.status,404,
    "private raw VTT state is never downloadable");
  const privatePlay=await post("/api/games/private-cache/play",auth);
  assert.equal(privatePlay.response.status,422);
  assert.equal(privatePlay.body.code,"private_vtt_live_staging_unsupported");
  assert.equal(privatePlay.body.download,privateVtt.body.urls[0]);

  const publicPaths = [
    `/cache/renders/ember/${fullRef}/p_kindling_core.png`,
    `/cache/exports/ember/${fullRef}/proof.bin`,
    `/cache/exports/ember/${fullRef}/released.bin`,
    `/api/games/ember/repository/file/game.yaml?ref=${fullRef}`,
    affinityUrls.ember,
  ];
  for (const path of publicPaths)
    await assertCache(path, "public, no-cache, must-revalidate");
  for(const slug of ["ember","private-cache"]){
    const headers=slug==="private-cache"?auth:{};
    const missingReceipt=await get(`/api/games/${slug}/affinity/previews/${fullRef}/proof.png`,headers);
    assert.equal(missingReceipt.response.status,404,"Affinity previews require complete URL identity");
    const affinityState=await get(`/api/games/${slug}/affinity`,headers);
    assert.equal(affinityState.response.status,200);
    assert.equal(affinityState.body.current,true,"Affinity status verifies input, renderer, and output receipts");
    assert.equal(affinityState.body.preview_url,affinityUrls[slug]);
  }
  for (const ref of [shortRef, "v1.0"])
    await assertCache(`/cache/renders/ember/${ref}/p_kindling_core.png`, "public, no-cache, must-revalidate");
  assert.equal(existsSync(join(cacheDir, "renders", "ember", shortRef)), false,
    "short render aliases never create noncanonical cache keys");
  assert.equal(existsSync(join(cacheDir, "renders", "ember", "v1.0")), false,
    "release-tag render aliases never create noncanonical cache keys");
  for (const path of [
    "/api/games/ember/repository/file/game.yaml?ref=HEAD",
    "/api/games/ember/assets/art/kindling.png",
    "/api/games/ember/components/svg/ember-token",
  ]) await assertCache(path, "public, no-cache, must-revalidate");

  for(const file of ["orphan.bin","forge-export-manifest.json",".complete-data-v3.json"]){
    const result=await get(`/cache/exports/ember/${fullRef}/${file}`);
    assert.equal(result.response.status,404,`${file} is not a downloadable declared artifact`);
  }
  const corrupt=await get(`/cache/exports/ember/${fullRef}/corrupt.bin`);
  assert.equal(corrupt.response.status,503,"tampered published bytes fail closed instead of being served");
  assert.notDeepEqual(corrupt.body,Buffer.from("tampered release bytes"),"tampered bytes never reach the client");
  const affinityPath=join(games,"ember",".forge","affinity","renders",fullRef,"proof.png");
  writeFileSync(affinityPath,"tampered affinity preview");
  const corruptAffinity=await get(affinityUrls.ember);
  assert.equal(corruptAffinity.response.status,503,"tampered Affinity output fails its byte receipt");

  for(const slug of ["ember","private-cache"]){
    const renderDir=join(cacheDir,"renders",slug,fullRef);
    assert.equal(existsSync(join(renderDir,"partial.png")),false,"partial render output is replaced");
    const manifest=JSON.parse(readFileSync(join(renderDir,RENDER_COMPLETION_FILE),"utf8"));
    assert.equal(manifest.format,"forge-render-cache");
    assert.ok(manifest.files.some(file=>file.name==="p_kindling_core.png"),"completed render manifest declares the served face");
  }

  // A shared cache that saw this URL while public must revalidate. Once the
  // project becomes private, the same anonymous URL immediately fails closed.
  const transitionDb=new DatabaseSync(dbPath);
  transitionDb.prepare("UPDATE games SET visibility = 'private' WHERE slug = 'ember'").run();
  transitionDb.close();
  const afterPrivate=await get(`/cache/exports/ember/${fullRef}/proof.bin`);
  assert.equal(afterPrivate.response.status,404,"public-to-private transition revokes the same exact artifact URL");

  console.log("CACHE INTEGRITY + STALE INDEX GREEN — revalidation, evidence-bound exports, atomic renders, and removed repositories fail closed.");
} finally {
  server.kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 50));
  rmSync(temp, { recursive: true, force: true });
}
