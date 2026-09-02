#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeForgeProject, loadForgeProject } from "./lib/forge-project.mjs";
import { deterministicZip, readZip } from "./lib/deterministic-zip.mjs";
import { csvToTable } from "./lib/interchange-table.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), "forge-project-server-test-"));
const games = join(temp, "games"), dbPath = join(temp, "platform.db"), cacheDir = join(temp, "cache");
const port = 36000 + Math.floor(Math.random() * 2000), origin = `http://127.0.0.1:${port}`;
let server, serverLog = "";
const git = args => {
  const run = spawnSync("git", args, { cwd: temp, encoding: "utf8" });
  if (run.status) throw new Error(run.stderr || `git ${args.join(" ")} failed`);
};
const api = async (path, { token, method = "GET", json, body } = {}) => {
  const response = await fetch(`${origin}${path}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(json ? { "content-type": "application/json" } : {}),
  }, body: json ? JSON.stringify(json) : body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}\n${serverLog}`);
  return data;
};

try {
  mkdirSync(games, { recursive: true });
  cpSync(join(ROOT, "examples", "ember"), join(games, "ember"), { recursive: true,
    filter: source => !source.split(/[\\/]/).includes("exports") });
  mkdirSync(join(games, "ember", "templates"), { recursive: true });
  writeFileSync(join(games, "ember", "templates", "layout.yaml"), `card:\n  w_mm: 63\n  h_mm: 88\n  bleed_mm: 3\nfonts:\n  - { id: title, family: Arial, weight: 700, style: normal }\nregions:\n  - { id: title, type: text, src: card.name, x: 3, y: 3, w: 45, h: 8, font: title, size_pt: 9, align: left, valign: middle, color: \"#000000\" }\n`);
  git(["init", "-q"]); git(["config", "user.name", "Forge test"]); git(["config", "user.email", "forge-test@example.invalid"]);
  git(["add", "."]); git(["commit", "-qm", "fixture"]);
  server = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port), "--games", games], {
    cwd: ROOT, env: { ...process.env, LOCAL_STORE_ROOT: temp, DB_PATH: dbPath, CACHE_DIR: cacheDir,
      FORGE_HUB_PATH: join(ROOT, "hub.html"), FORGE_PUBLIC_ORIGIN: origin }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { serverLog += chunk; }); server.stderr.on("data", chunk => { serverLog += chunk; });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    if (i === 79) throw new Error(`server did not start\n${serverLog}`);
  }
  const owner = await api("/api/auth/register", { method: "POST", json: { handle: "project-owner", email: "owner@example.invalid", password: "password123" } });
  const outsider = await api("/api/auth/register", { method: "POST", json: { handle: "project-editor", email: "editor@example.invalid", password: "password123" } });
  const db = new DatabaseSync(dbPath); db.prepare("UPDATE games SET owner_id = ? WHERE slug = 'ember'").run(owner.user.id); db.close();

  const exported = await api("/api/games/ember/export/project?wait=1", { method: "POST", token: owner.token });
  const archiveResponse = await fetch(`${origin}${exported.urls[0]}`);
  const loaded = loadForgeProject(Buffer.from(await archiveResponse.arrayBuffer()));

  const nandeckExport = await api("/api/games/ember/export/nandeck?wait=1", { method: "POST", token: owner.token });
  assert.match(nandeckExport.urls[0], /ember-nandeck-v1\.zip$/);
  const nandeckArchiveResponse = await fetch(`${origin}${nandeckExport.urls[0]}`);
  const nandeckEntries = readZip(Buffer.from(await nandeckArchiveResponse.arrayBuffer()));
  assert(nandeckEntries.has("manifest.json"));
  assert(nandeckEntries.has("README.md"));
  assert(nandeckEntries.has("ember.txt"));
  assert(nandeckEntries.has("ember.csv"));
  assert.equal(JSON.parse(nandeckEntries.get("manifest.json")).unit, "MM");
  const nandeckCached = await api("/api/games/ember/export/nandeck?wait=1", { method: "POST", token: owner.token });
  assert.equal(nandeckCached.cached, true);
  assert.deepEqual(nandeckCached.urls, nandeckExport.urls);
  const clean = analyzeForgeProject(join(games, "ember"), loaded.entries);
  assert.equal(clean.conflicts.length, 0, JSON.stringify(clean.conflicts)); assert.equal(clean.files.length, 0);
  const cardsPath = loaded.manifest.tables.cards.project_path, printingsPath = loaded.manifest.tables.printings.project_path;
  const cards = JSON.parse(loaded.entries.get(cardsPath)), printings = JSON.parse(loaded.entries.get(printingsPath));
  cards[0].name = `${cards[0].name} Community`; printings[0].quantity = (printings[0].quantity || 1) + 1;
  loaded.entries.set(cardsPath, Buffer.from(`${JSON.stringify(cards, null, 2)}\n`));
  loaded.entries.set(printingsPath, Buffer.from(`${JSON.stringify(printings, null, 2)}\n`));
  for (const [kind, table] of Object.entries(loaded.manifest.tables)) {
    const base = JSON.parse(loaded.entries.get(table.base_path));
    const csv = csvToTable(loaded.entries.get(table.editable_path).toString(), table, kind, base);
    assert.deepEqual(csv, base, `${kind} CSV must remain the unedited baseline`);
  }
  const editedArchive = deterministicZip(loaded.entries);
  const localEdited = analyzeForgeProject(join(games, "ember"), editedArchive);
  assert.equal(localEdited.conflicts.length, 0, JSON.stringify(localEdited.conflicts));

  const dry = await api("/api/games/ember/design/import", { method: "POST", token: outsider.token, body: editedArchive });
  assert.equal(dry.mode, "dry-run"); assert.equal(dry.propose, true); assert.equal(dry.conflicts.length, 0, JSON.stringify(dry.conflicts));
  assert.deepEqual(dry.changes.cards.changed, [cards[0].id]); assert.deepEqual(dry.changes.printings.changed, [printings[0].id]);
  const proposed = await api("/api/games/ember/design/import?commit=1", { method: "POST", token: outsider.token, body: editedArchive });
  assert.equal(proposed.proposed, true); assert.equal(proposed.fork, "ember-project-editor"); assert(proposed.pr);
  const detail = await api(`/api/games/ember/prs/${proposed.pr}`);
  assert(detail.changes.some(change => change.card === cards[0].id));
  assert(detail.printing_changes.changed.includes(printings[0].id));
  await api(`/api/games/ember/prs/${proposed.pr}/review`, { method: "POST", token: owner.token, json: { verdict: "approve" } });

  const nandeckScript = loaded.entries.get("adapters/nandeck/ember.txt").toString();
  const editedNandeck = nandeckScript.replace('TEXT=,"[name]",3,3,45,8', 'TEXT=,"[name]",4,3,45,8');
  assert.notEqual(editedNandeck, nandeckScript);
  const nandeckDry = await api("/api/games/ember/design/import/nandeck", { method: "POST", token: outsider.token, body: editedNandeck });
  assert.equal(nandeckDry.mode, "dry-run"); assert.equal(nandeckDry.propose, true); assert.equal(nandeckDry.conflicts.length, 0);
  assert.deepEqual(nandeckDry.affected_families, ["default"]);
  assert.deepEqual(nandeckDry.changes.map(change => [change.id, change.path, change.before, change.after]), [["title", "x", 3, 4]]);
  const nandeckProposed = await api("/api/games/ember/design/import/nandeck?commit=1", { method: "POST", token: outsider.token, body: editedNandeck });
  assert.equal(nandeckProposed.proposed, true); assert.equal(nandeckProposed.pr, proposed.pr);
  const nandeckDetail = await api(`/api/games/ember/prs/${nandeckProposed.pr}`);
  assert(nandeckDetail.file_changes.some(change => change.path === "templates/layout.yaml"));
  assert.equal(nandeckDetail.reviews.length, 0, "refreshing a proposal must dismiss stale reviews");
  assert.equal(nandeckDetail.mergeable, false);
  const thirdParty = await api("/api/games/ember/design/import/nandeck", { method: "POST", token: outsider.token,
    body: 'UNIT=MM\nCARDSIZE=63,88\nFONT=Arial,9,T,#000000\nTEXT=,"[name]",3,3,45,8,left,center\n' });
  assert.equal(thirdParty.candidate_only, true); assert.equal(thirdParty.recovered.regions, 1); assert.equal(thirdParty.mode, "candidate");

  const venvPython = process.platform === "win32" ? join(ROOT, ".venv", "Scripts", "python.exe") : join(ROOT, ".venv", "bin", "python");
  const testPython = process.env.FORGE_PYTHON || (existsSync(venvPython) ? venvPython : "python3");
  const hasYaml = spawnSync(testPython, ["-c", "import yaml"], { env: process.env }).status === 0;
  if (hasYaml) {
    await api(`/api/games/ember/prs/${proposed.pr}/review`, { method: "POST", token: owner.token, json: { verdict: "approve" } });
    const merged = await api(`/api/games/ember/prs/${proposed.pr}/merge`, { method: "POST", token: owner.token, json: {} });
    assert.equal(merged.merged, true); assert(merged.printing_changes.changed.includes(printings[0].id));
    const landedCards = JSON.parse(readFileSync(join(games, "ember", "components", "cards.json")));
    const landedPrintings = JSON.parse(readFileSync(join(games, "ember", "components", "printings.json")));
    assert.equal(landedCards[0].name, cards[0].name); assert.equal(landedPrintings[0].quantity, printings[0].quantity);
    assert.match(readFileSync(join(games, "ember", "templates", "layout.yaml"), "utf8"), /x: 4\b/);
  }
  console.log(`forge-project-server: HTTP project + nanDECK export → dry-run → fork/commit/PR${hasYaml ? " → merge" : " (merge skipped: PyYAML unavailable)"} verified`);
} finally {
  if (server && server.exitCode == null) server.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}
