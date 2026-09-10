#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeForgeProject, loadForgeProject } from "./lib/forge-project.mjs";
import { deterministicZip, readZip } from "./lib/deterministic-zip.mjs";
import { loadDesignEngines } from "./lib/design-engines.mjs";
import { csvToTable, tableToCsv } from "./lib/interchange-table.mjs";
import yaml from "js-yaml";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
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
  cpSync(join(ROOT, "examples", "_fixtures", "netrunner-sg"), join(games, "netrunner-sg"), { recursive: true,
    filter: source => !source.split(/[\\/]/).includes("exports") });
  mkdirSync(join(games, "ember", "templates"), { recursive: true });
  writeFileSync(join(games, "ember", "templates", "layout.yaml"), `card:\n  w_mm: 63.5\n  h_mm: 88.9\n  bleed_mm: 3.175\nfonts:\n  - { id: title, family: Arial, weight: 700, style: normal }\nregions:\n  - { id: title, type: text, src: card.name, x: 3, y: 3, w: 45, h: 8, font: title, size_pt: 9, align: left, valign: middle, color: \"#000000\" }\n`);
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
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE games SET owner_id = ? WHERE slug IN ('ember', 'netrunner-sg')").run(owner.user.id);
  db.close();

  const savedBuilds = await api("/api/games/ember/decks", { token: owner.token });
  assert.equal(savedBuilds.access.can_write, true);
  assert(savedBuilds.decks.some(deck => deck.id === "burn-rush" && deck._legal),
    "the build workspace reports committed format legality");
  assert(savedBuilds.printings.some(printing => printing.id === "p_kindling_promo"),
    "the build workspace exposes physical printing choices separately from card identities");
  const exactBuild = {
    id: "alt-art-burn-rush", name: "Alt-art Burn Rush", format_id: "standard", author: "project-owner",
    notes: "A legal saved build with one deliberately selected alt-art face.",
    cards: { kindling: 3, twin_flame: 2, ash_cloak: 2, bellows: 1, wildfire: 1,
      ember_thief: 2, last_light: 1, cinder_rat: 2 },
    printings: { p_kindling_promo: 3, p_twin_flame_core: 2, p_ash_cloak_core: 2,
      p_bellows_core: 1, p_wildfire_er: 1, p_ember_thief_core: 2,
      p_last_light_core: 1, p_cinder_rat_core: 2 },
  };
  const exactBuildPreview = await api("/api/games/ember/decks/preview", {
    method: "POST", token: owner.token, json: { deck: exactBuild, base_ref: savedBuilds.ref },
  });
  assert.equal(exactBuildPreview.written, false);
  assert.equal(exactBuildPreview.legality.legal, true, JSON.stringify(exactBuildPreview.legality));
  assert.deepEqual(exactBuildPreview.totals, { cards: 14, unique_cards: 8, exact_printings: 8 });
  assert(!existsSync(join(games, "ember", "decks", `${exactBuild.id}.json`)),
    "build preview validates the complete candidate without touching the repository");
  const mismatchedBuild = structuredClone(exactBuild);
  mismatchedBuild.printings.p_kindling_promo = 2;
  const mismatchedBuildResponse = await fetch(`${origin}/api/games/ember/decks/preview`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ deck: mismatchedBuild, base_ref: savedBuilds.ref }),
  });
  assert.equal(mismatchedBuildResponse.status, 422,
    "physical printing counts must exactly reconcile to gameplay card counts");
  const staleBuildResponse = await fetch(`${origin}/api/games/ember/decks/preview`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ deck: exactBuild, base_ref: "deadbeef" }),
  });
  assert.equal(staleBuildResponse.status, 409, "a stale build draft cannot be reviewed as current");
  const exactBuildCommit = await api(`/api/games/ember/decks/${exactBuild.id}`, {
    method: "PUT", token: owner.token,
    json: { deck: exactBuild, base_ref: savedBuilds.ref, create_only: true },
  });
  assert.equal(exactBuildCommit.saved, true);
  assert.equal(exactBuildCommit.legality.legal, true);
  assert.deepEqual(JSON.parse(readFileSync(join(games, "ember", "decks", `${exactBuild.id}.json`), "utf8")).printings,
    exactBuild.printings, "the exact production face choices land in the same Git commit as the playable build");
  const duplicateBuildResponse = await fetch(`${origin}/api/games/ember/decks/${exactBuild.id}`, {
    method: "PUT", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ deck: { ...exactBuild, name: "Accidental overwrite" },
      base_ref: exactBuildCommit.commit, create_only: true }),
  });
  assert.equal(duplicateBuildResponse.status, 409,
    "creating a build cannot silently overwrite an existing stable deck ID");

  const targetProfile = {
    schema_version: 1, preset: "the-game-crafter-poker",
    selection: { card_ids: ["kindling"], printing_quantities: { p_kindling_promo: 3 } },
    home: { fronts_only: false, gutter_mm: 0, crop_marks: "grid", crop_mark_sides: "both", sleeve_profile: "none", sleeve_fit: "contain" },
    press: { target: "the-game-crafter-poker", include_back: true, crop_marks: "none", crop_mark_sides: "both", color_space: "sRGB", pdf_standard: "none" },
  };
  const targetDry = await api("/api/games/ember/design/print-profile", {
    method: "POST", token: owner.token, json: { profile: targetProfile },
  });
  assert.equal(targetDry.validation.ok, true, JSON.stringify(targetDry.validation));
  assert.equal(targetDry.production_target.status, "spec-checked-handoff");
  assert.equal(targetDry.physical_cards, 3);
  assert.deepEqual(targetDry.exact_printing_quantities, { p_kindling_promo: 3 });
  const targetCommit = await api("/api/games/ember/design/print-profile", {
    method: "PUT", token: owner.token, json: { profile: targetProfile, base_ref: targetDry.base_ref },
  });
  assert.equal(targetCommit.saved, true);
  const targetBuild = await api("/api/games/ember/export/print?wait=1", { method: "POST", token: owner.token });
  const targetUrl = targetBuild.urls.find(url => url.endsWith("print-ready.zip"));
  const targetZip = readZip(Buffer.from(await (await fetch(`${origin}${targetUrl}`)).arrayBuffer()));
  const targetFront = targetZip.get("manufacturer/the-game-crafter-poker/fronts/p_kindling_promo.png");
  const targetBack = targetZip.get("manufacturer/the-game-crafter-poker/back.png");
  assert(targetFront && targetBack, "the exact package includes individual named-target front and back files");
  assert(!targetZip.has("manufacturer/the-game-crafter-poker/fronts/p_kindling_core.png"),
    "an exact saved-build production face never leaks an unselected printing into manufacturing output");
  assert.deepEqual([targetFront.readUInt32BE(16), targetFront.readUInt32BE(20)], [825, 1125]);
  assert.deepEqual([targetBack.readUInt32BE(16), targetBack.readUInt32BE(20)], [825, 1125]);
  const targetPreflight = JSON.parse(targetZip.get("preflight.json"));
  assert.equal(targetPreflight.selection.mode, "exact-printings");
  assert.deepEqual(targetPreflight.selection.printing_quantities, { p_kindling_promo: 3 });
  assert.match(targetZip.get("quantities.csv").toString(), /p_kindling_promo,kindling,Kindling,3,/);
  assert.equal(targetPreflight.production_target.status, "pass");
  assert.equal(targetPreflight.production_target.publishing, false);
  assert(targetPreflight.production_target.checks.every(check => check.pass && check.sha256.length === 64),
    "the frozen receipt records every target file's pixels, color mode, DPI, and hash");

  const ttpgExport = await api("/api/games/ember/export/ttpg?wait=1", { method: "POST", token: owner.token });
  assert.match(ttpgExport.urls[0], /ember-ttpg-v1\.zip$/);
  assert(ttpgExport.urls.some(url => url.endsWith("/ttpg-manifest.json")));
  const ttpgArchive = readZip(Buffer.from(await (await fetch(`${origin}${ttpgExport.urls[0]}`)).arrayBuffer()));
  const ttpgManifest = JSON.parse(ttpgArchive.get("Ember/Manifest.json"));
  const ttpgReceipt = JSON.parse(ttpgArchive.get("Ember/forge-ttpg-receipt.json"));
  const ttpgState = JSON.parse(ttpgArchive.get("Ember/States/Ember.vts"));
  assert.match(ttpgManifest.GUID, /^[A-F0-9]{32}$/);
  assert.equal(ttpgReceipt.source_ref, ttpgExport.ref);
  assert.equal(ttpgState.requiredPackages[0].guid, ttpgManifest.GUID);
  assert(ttpgState.objects.some(object => object.objectTags.includes("forge-card-stack")));
  assert(ttpgState.objects.some(object => object.objectTags.includes("forge-component-supply")));
  assert([...ttpgArchive.keys()].some(name => name.startsWith("Ember/Textures/cards/front-")));
  assert([...ttpgArchive.keys()].some(name => name.startsWith("Ember/Textures/components/")));
  const ttpgCached = await api("/api/games/ember/export/ttpg?wait=1", { method: "POST", token: owner.token });
  assert.equal(ttpgCached.cached, true);

  const exported = await api("/api/games/ember/export/project?wait=1", { method: "POST", token: owner.token });
  const archiveResponse = await fetch(`${origin}${exported.urls[0]}`);
  const loaded = loadForgeProject(Buffer.from(await archiveResponse.arrayBuffer()));

  const dataExport = await api("/api/games/ember/export/data?wait=1", { method: "POST", token: owner.token });
  assert.match(dataExport.urls[0], /ember-data-v3\.forge-project\.zip$/);
  assert(dataExport.urls.some(url => url.endsWith("/ember-data-v3.xlsx")));
  assert(dataExport.urls.some(url => url.endsWith("/cards.csv")) && dataExport.urls.some(url => url.endsWith("/tokens.csv")));
  const dataArchiveResponse = await fetch(`${origin}${dataExport.urls[0]}`);
  const dataLoaded = loadForgeProject(Buffer.from(await dataArchiveResponse.arrayBuffer()));
  assert.equal(dataLoaded.manifest.profile, "forge-tabular-working-copy");
  assert.deepEqual(dataLoaded.manifest.files.map(file => file.source_path),
    ["components/cards.json", "components/printings.json", "components/tokens.json"]);
  assert(dataLoaded.entries.has("editable/cards.csv"));
  assert(dataLoaded.entries.has("editable/tokens.csv"));
  assert.match(dataLoaded.entries.get("README.md").toString(), /Dextrous, Component Studio/);
  const workbookUrl=dataExport.urls.find(url=>url.endsWith(".xlsx")),workbookPath=join(temp,"ember-return.xlsx");
  writeFileSync(workbookPath,Buffer.from(await (await fetch(`${origin}${workbookUrl}`)).arrayBuffer()));
  const workbookPython=process.env.FORGE_PYTHON||join(ROOT,".venv","bin","python");
  const workbookEdit=spawnSync(workbookPython,["-c",String.raw`
from openpyxl import load_workbook
import sys
p=sys.argv[1];w=load_workbook(p)
def change(sheet,row_id,column,value):
    ws=w[sheet];headers=[cell.value for cell in ws[1]];i=headers.index("id")+1;j=headers.index(column)+1
    for row in range(2,ws.max_row+1):
        if ws.cell(row,i).value==row_id: ws.cell(row,j).value=value;return
    raise RuntimeError(row_id)
change("cards","kindling","name","Kindling Workbook Return")
change("printings","p_kindling_core","artist","Workbook Artist")
change("tokens","spark_token","name","Spark Workbook Return")
w.save(p)
`,workbookPath],{encoding:"utf8"});
  assert.equal(workbookEdit.status,0,workbookEdit.stderr);
  const convertedResponse=await fetch(`${origin}/api/games/ember/design/import/workbook`,{method:"POST",headers:{authorization:`Bearer ${owner.token}`},body:readFileSync(workbookPath)});
  if(!convertedResponse.ok)throw new Error(`workbook conversion failed: ${convertedResponse.status} ${await convertedResponse.text()}`);
  assert.match(convertedResponse.headers.get("content-type")||"",/application\/zip/);
  const convertedArchive=Buffer.from(await convertedResponse.arrayBuffer());
  const workbookDryRun=await api("/api/games/ember/design/import",{method:"POST",token:owner.token,body:convertedArchive});
  assert.deepEqual(workbookDryRun.changes.cards.changed,["kindling"]);
  assert.deepEqual(workbookDryRun.changes.printings.changed,["p_kindling_core"]);
  assert.deepEqual(workbookDryRun.changes.tokens.changed,["spark_token"]);
  assert.equal(workbookDryRun.preview.cards[0].name,"Kindling Workbook Return");
  assert.equal(workbookDryRun.preview.printings[0].artist,"Workbook Artist");
  assert.equal(workbookDryRun.preview.tokens[0].name,"Spark Workbook Return");
  const directCardsUrl = dataExport.urls.find(url => url.endsWith("/cards.csv"));
  const directCards = await (await fetch(`${origin}${directCardsUrl}`)).text();
  const directCardsDryRun = await api(`/api/games/ember/design/import/table?kind=cards&base_ref=${dataExport.ref}`, {
    method: "POST", token: owner.token, body: directCards.replace(",Kindling,", ",Kindling Direct CSV,") });
  assert.equal(directCardsDryRun.profile, "forge-tabular-working-copy");
  assert.deepEqual(directCardsDryRun.changes.cards.changed, ["kindling"]);
  assert.equal(directCardsDryRun.preview.cards[0].name, "Kindling Direct CSV");
  const directTokensUrl = dataExport.urls.find(url => url.endsWith("/tokens.csv"));
  const directTokens = await (await fetch(`${origin}${directTokensUrl}`)).text();
  const directTokensDryRun = await api(`/api/games/ember/design/import/table?kind=tokens&base_ref=${dataExport.ref}`, {
    method: "POST", token: owner.token, body: directTokens.replace("Spark,token", "Spark marker,token") });
  assert.deepEqual(directTokensDryRun.changes.tokens.changed, ["spark_token"]);
  const returnedDataEntries = new Map(dataLoaded.entries);
  returnedDataEntries.set("editable/cards.csv", Buffer.from(
    returnedDataEntries.get("editable/cards.csv").toString().replace(",Kindling,", ",Kindling Table Edit,")));
  const returnedDataDryRun = await api("/api/games/ember/design/import", {
    method: "POST", token: owner.token, body: deterministicZip(returnedDataEntries),
  });
  assert.deepEqual(returnedDataDryRun.changes.cards.changed, ["kindling"]);
  const dataCached = await api("/api/games/ember/export/data?wait=1", { method: "POST", token: owner.token });
  assert.equal(dataCached.cached, true);
  assert.deepEqual(dataCached.urls, dataExport.urls);

  const componentWorkspace = await api("/api/games/ember/components/pieces", { token: owner.token });
  assert.equal(componentWorkspace.pieces.length, 3);
  assert.equal(componentWorkspace.design.families.length, 2);
  assert.equal(componentWorkspace.access.can_write, true);
  const editedPieces = structuredClone(componentWorkspace.pieces), editedComponentDesign = structuredClone(componentWorkspace.design);
  editedPieces[0].name = "Spark production marker";
  editedComponentDesign.families[0].style.fill = "#33221a";
  const previewHeadBefore = spawnSync("git", ["rev-parse", "HEAD"], { cwd: temp, encoding: "utf8" }).stdout.trim();
  const previewStatusBefore = spawnSync("git", ["status", "--porcelain"], { cwd: temp, encoding: "utf8" }).stdout;
  const componentPreview = await api("/api/games/ember/components/preview", {
    method: "POST", token: owner.token, json: { base_ref: componentWorkspace.ref, pieces: editedPieces, design: editedComponentDesign },
  });
  assert.equal(componentPreview.written, false);
  assert(previewHeadBefore.startsWith(componentPreview.ref));
  assert.equal(componentPreview.manifest.totals.piece_types, 3);
  assert.match(componentPreview.previews[0].file, /cut-sheets\/01-a4\.svg$/);
  assert.match(componentPreview.previews[0].svg, /data-forge-page="1"/);
  assert.match(componentPreview.previews[0].svg, /Spark production marker/);
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: temp, encoding: "utf8" }).stdout.trim(), previewHeadBefore,
    "manufacturing proof does not create a commit");
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: temp, encoding: "utf8" }).stdout, previewStatusBefore,
    "manufacturing proof does not dirty the repository");
  const componentCommit = await api("/api/games/ember/components/pieces", {
    method: "PUT", token: owner.token, json: { base_ref: componentWorkspace.ref, pieces: editedPieces, design: editedComponentDesign },
  });
  assert.equal(componentCommit.saved, true);
  assert.deepEqual(componentCommit.changes.changed, ["spark_token"]);
  assert.deepEqual(componentCommit.families_changed, ["ember-token"]);
  const staleComponentResponse = await fetch(`${origin}/api/games/ember/components/pieces`, { method: "PUT", headers: {
    authorization: `Bearer ${owner.token}`, "content-type": "application/json",
  }, body: JSON.stringify({ base_ref: componentWorkspace.ref, pieces: editedPieces, design: editedComponentDesign }) });
  const staleComponent = await staleComponentResponse.json();
  assert.equal(staleComponentResponse.status, 409);
  assert.match(staleComponent.error, /did not overwrite/);
  const componentArtPath = "assets/components/spark_token-front.png";
  const componentArt = await api(`/api/games/ember/components/pieces/spark_token/art?side=front&path=${encodeURIComponent(componentArtPath)}&creator=Project%20Owner&license=CC0-1.0&rights_status=original&redistribution=allowed`, {
    method: "POST", token: owner.token,
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  });
  assert.equal(componentArt.art, componentArtPath);
  assert.equal(componentArt.rights.status, "original");
  assert.equal(JSON.parse(readFileSync(join(games, "ember", "components", "tokens.json")))
    .find(piece => piece.id === "spark_token").art, componentArtPath);
  assert(JSON.parse(readFileSync(join(games, "ember", "forge", "rights.json"))).files
    .some(rule => rule.paths.includes(componentArtPath) && rule.copyright.includes("Project Owner")));
  const componentSvg = await api("/api/games/ember/components/svg/ember-token", { token: owner.token });
  assert.equal(componentSvg.family, "ember-token");
  assert.match(componentSvg.svg, /data-forge-component-region="name"/);
  const returnedComponentSvg = componentSvg.svg
    .replace('fill="#33221a"', 'fill="#123456"')
    .replace('data-forge-component-region="name"', 'data-forge-component-region="name" transform="translate(1,0)"');
  const componentSvgDry = await api("/api/games/ember/components/import/svg", {
    method: "POST", token: owner.token, body: returnedComponentSvg,
  });
  assert.equal(componentSvgDry.mode, "dry-run");
  assert.equal(componentSvgDry.propose, false);
  assert.deepEqual(componentSvgDry.changes.map(change => change.path), ["style.fill", "regions.name.x"]);
  const componentSvgCommit = await api("/api/games/ember/components/import/svg?commit=1", {
    method: "POST", token: owner.token, body: returnedComponentSvg,
  });
  assert.equal(componentSvgCommit.saved, true);
  assert.equal(JSON.parse(readFileSync(join(games, "ember", "templates", "component-design.json")))
    .families[0].style.fill, "#123456");
  const componentExport = await api("/api/games/ember/export/components?wait=1", { method: "POST", token: owner.token });
  assert.match(componentExport.urls[0], /ember-components-v6\.zip$/);
  assert(componentExport.urls.some(url => /cut-sheets\/01-a4\.svg$/.test(url)));
  const componentArchive = readZip(Buffer.from(await (await fetch(`${origin}${componentExport.urls[0]}`)).arrayBuffer()));
  const componentManifest = JSON.parse(componentArchive.get("manifest.json"));
  assert.equal(componentManifest.source_ref, componentExport.ref);
  assert.equal(componentManifest.totals.piece_types, 3);
  assert.equal(componentManifest.quantity_resolution.status, "resolved");
  assert.equal(componentManifest.quantity_resolution.player_count, 2);
  assert.equal(componentManifest.totals.declared_physical_pieces, 17);
  assert.equal(componentManifest.totals.physical_pieces, 28);
  assert.equal(componentManifest.totals.printed_faces, 34);
  assert.equal(componentManifest.pieces.find(piece => piece.id === "spark_token").artwork[0].rights.status, "original");
  assert(componentManifest.source_files.includes(componentArtPath));
  assert(componentArchive.has("faces/spark_token.svg"));
  assert(componentArchive.has("faces/ash_token-back.svg"));
  assert(componentArchive.has("cut-sheets/01-a4.svg"));
  assert(componentArchive.has("cut-sheets/01-a4-back.svg"));
  assert(componentArchive.has("family-templates/ember-token.svg"));
  assert.equal(componentManifest.family_templates.length, 2);

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
  const squibExport = await api("/api/games/ember/export/squib?wait=1", { method: "POST", token: owner.token });
  assert.match(squibExport.urls[0], /ember-squib-v1\.zip$/);
  const squibArchiveResponse = await fetch(`${origin}${squibExport.urls[0]}`);
  const squibArchiveBytes = Buffer.from(await squibArchiveResponse.arrayBuffer());
  const squibSuite = readZip(squibArchiveBytes);
  assert(squibSuite.has("Gemfile"));
  assert(squibSuite.has("families/default/cards.csv"));
  assert(squibSuite.has("families/default/layout.yml"));
  assert.equal(JSON.parse(squibSuite.get("manifest.json")).security.forge_executes_ruby, false);
  const squibCached = await api("/api/games/ember/export/squib?wait=1", { method: "POST", token: owner.token });
  assert.equal(squibCached.cached, true);
  assert.deepEqual(squibCached.urls, squibExport.urls);
  const svgExport = await api("/api/games/ember/export/svg?wait=1", { method: "POST", token: owner.token });
  assert.match(svgExport.urls[0], /ember-svg-design-v1\.zip$/);
  const svgArchiveResponse = await fetch(`${origin}${svgExport.urls[0]}`);
  const svgEntries = readZip(Buffer.from(await svgArchiveResponse.arrayBuffer()));
  assert(svgEntries.has("manifest.json"));
  assert(svgEntries.has("README.md"));
  assert(svgEntries.has("ember.svg"));
  assert.equal(JSON.parse(svgEntries.get("manifest.json")).unit, "MM");
  const svgCached = await api("/api/games/ember/export/svg?wait=1", { method: "POST", token: owner.token });
  assert.equal(svgCached.cached, true);
  assert.deepEqual(svgCached.urls, svgExport.urls);
  const pnpinkExport = await api("/api/games/netrunner-sg/export/pnpink?wait=1", { method: "POST", token: owner.token });
  assert.match(pnpinkExport.urls[0], /netrunner-sg-pnpink-v1\.zip$/);
  const pnpinkArchiveResponse = await fetch(`${origin}${pnpinkExport.urls[0]}`, {
    headers: { authorization: `Bearer ${owner.token}` },
  });
  const pnpinkArchiveBytes = Buffer.from(await pnpinkArchiveResponse.arrayBuffer());
  assert.equal(pnpinkArchiveResponse.status, 200, pnpinkArchiveBytes.toString("utf8"));
  assert.equal(pnpinkArchiveBytes.subarray(0, 2).toString(), "PK", pnpinkArchiveBytes.toString("utf8"));
  const pnpinkSuite = readZip(pnpinkArchiveBytes);
  const pnpinkManifest = JSON.parse(pnpinkSuite.get("manifest.json"));
  assert.equal(pnpinkManifest.upstream.tested_tag, "v0.57");
  assert.equal(pnpinkManifest.families.length, 11);
  const programPackagePath = pnpinkManifest.families.find(family => family.family === "program").project;
  const programPackage = readZip(pnpinkSuite.get(programPackagePath));
  const programManifest = JSON.parse(programPackage.get("manifest.json"));
  const programCsv = programPackage.get(programManifest.csv).toString();
  const editedProgramCsv = programCsv.replace(",Buzzsaw,", ",Buzzsaw Server Test,");
  assert.notEqual(editedProgramCsv, programCsv);
  programPackage.set(programManifest.csv, Buffer.from(editedProgramCsv));
  const editedProgramPackage = deterministicZip(programPackage);
  const pnpinkDry = await api("/api/games/netrunner-sg/design/import/pnpink", { method: "POST", token: owner.token, body: editedProgramPackage });
  assert.equal(pnpinkDry.mode, "dry-run");
  assert.equal(pnpinkDry.propose, false);
  assert.equal(pnpinkDry.family, "program");
  assert.equal(pnpinkDry.field_count, 1);
  assert.deepEqual(pnpinkDry.changed_files, ["components/cards.json"]);
  assert.deepEqual(pnpinkDry.changes[0].fields.map(field => [field.path, field.before, field.after]),
    [["name", "Buzzsaw", "Buzzsaw Server Test"]]);
  const pnpinkCommitted = await api("/api/games/netrunner-sg/design/import/pnpink?commit=1", { method: "POST", token: owner.token, body: editedProgramPackage });
  assert.equal(pnpinkCommitted.saved, true);
  assert.equal(pnpinkCommitted.proposed, undefined);
  assert.equal(JSON.parse(readFileSync(join(games, "netrunner-sg", "components", "cards.json")))
    .find(card => card.id === "buzzsaw").name, "Buzzsaw Server Test");
  const studioFamily = await api("/api/games/netrunner-sg/design/svg/program", { token: owner.token });
  const studioCards = JSON.parse(readFileSync(join(games, "netrunner-sg", "components", "cards.json")));
  const studioPrintings = JSON.parse(readFileSync(join(games, "netrunner-sg", "components", "printings.json")));
  studioCards.find(card => card.id === "botulus").name = "Botulus Studio Draft";
  const studioPrinting = studioPrintings.find(printing => printing.card_id === "botulus");
  const studioArtPath = "assets/card-art/botulus-studio-test.png";
  studioPrinting.quantity += 1;
  studioPrinting.art = studioArtPath;
  studioPrinting.art_crop = { fit: "cover", focal_x: 0.35, focal_y: 0.6, zoom: 1.25 };
  studioPrinting.artist = "Studio Artist";
  studioPrinting.provenance = { source: "human", creator: "Studio Artist", license: "CC-BY-4.0" };
  const studioAssets = [{ path: studioArtPath,
    content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    creator: "Studio Artist", license: "CC-BY-4.0", status: "original", redistribution: "allowed" }];
  const studioArtLibrary = { format: "forge-art-library", version: 1,
    assets: [...(studioFamily.art_library?.assets || []), { path: studioArtPath, tags: ["cyberpunk", "portrait"] }] };
  const studioBack = { text: "FORGE TEST BACK", bg: "#172335", color: "#F7F3E8", border_color: "#F7F3E8", border_mm: 0.8, art: studioArtPath,
    regions: [{ id: "back_field", type: "rect", x: 0, y: 0, w: 63, h: 87.21, fill: "#172335" },
      { id: "back_art", type: "background", src: "g.layout.back.art", x: 0, y: 0, w: 63, h: 87.21, fit: "cover", bg: "#172335" },
      { id: "back_title", type: "text", src: "g.layout.back.text", x: 7, y: 35, w: 49, h: 17, font: "title", size_pt: 20, align: "center", valign: "middle", color: "#F7F3E8" }] };
  let studioSvg = studioFamily.svg.replace('data-forge-region="program_name"',
    'data-forge-region="program_name" transform="translate(0,0.5)"');
  studioSvg = studioSvg.replace(/(data-forge-back=")[^"]*(")/,
    `$1${Buffer.from(JSON.stringify(studioBack)).toString("base64url")}$2`);
  assert.notEqual(studioSvg, studioFamily.svg);
  const studioDry = await api("/api/games/netrunner-sg/design/studio", { method: "POST", token: owner.token,
    json: { base_ref: studioFamily.ref, cards: studioCards, printings: studioPrintings,
      assets: studioAssets, art_library: studioArtLibrary, svg: studioSvg } });
  assert.equal(studioDry.mode, "dry-run");
  assert.equal(studioDry.ok, true, JSON.stringify(studioDry.validation));
  assert.equal(studioDry.propose, false);
  assert(studioDry.changed_files.includes("components/cards.json"));
  assert(studioDry.changed_files.includes("components/printings.json"));
  assert(studioDry.changed_files.includes(studioArtPath));
  assert(studioDry.changed_files.includes("design/art-library.json"));
  assert(studioDry.changed_files.includes("forge/rights.json"));
  assert.equal(studioDry.printing_changes.changed.length, 1);
  assert.deepEqual(studioDry.asset_changes.map(asset => [asset.path, asset.rights.status]), [[studioArtPath, "original"]]);
  assert.deepEqual(studioDry.art_library_changes.map(change => [change.path, change.kind, change.after.tags]),
    [[studioArtPath, "added", ["cyberpunk", "portrait"]]]);
  assert(studioDry.changed_files.some(path => path.includes("templates/card-design/families/program.yaml")));
  assert(studioDry.changed_files.some(path => path.includes("templates/card-design/system.yaml")));
  assert(studioDry.layout_changes.some(change => change.id === "$back" && change.path === "back"));
  assert.equal(studioDry.candidate_cards[0].candidate.name, "Botulus Studio Draft");
  const studioCommit = await api("/api/games/netrunner-sg/design/studio?commit=1", { method: "POST", token: owner.token,
    json: { base_ref: studioFamily.ref, cards: studioCards, printings: studioPrintings,
      assets: studioAssets, art_library: studioArtLibrary, svg: studioSvg } });
  assert.equal(studioCommit.saved, true);
  assert.equal(studioCommit.proposed, undefined);
  assert.match(studioCommit.message, /1 card \+ 1 printing \+ 1 artwork file \+ 1 artwork tag record \+ 2 layout fields/);
  const studioCommitFiles = spawnSync("git", ["show", "--pretty=", "--name-only", studioCommit.commit],
    { cwd: temp, encoding: "utf8" }).stdout.trim().split("\n");
  assert(studioCommitFiles.includes("games/netrunner-sg/components/cards.json"));
  assert(studioCommitFiles.includes("games/netrunner-sg/components/printings.json"));
  assert(studioCommitFiles.includes(`games/netrunner-sg/${studioArtPath}`));
  assert(studioCommitFiles.includes("games/netrunner-sg/design/art-library.json"));
  assert(studioCommitFiles.includes("games/netrunner-sg/templates/card-design/system.yaml"));
  const committedSystem = readFileSync(join(games, "netrunner-sg", "templates", "card-design", "system.yaml"), "utf8");
  assert.match(committedSystem, /text: FORGE TEST BACK/);
  assert.match(committedSystem, /art: assets\/card-art\/botulus-studio-test\.png/);
  assert.match(committedSystem, /id: back_art/);
  assert(studioCommitFiles.includes("games/netrunner-sg/forge/rights.json"));
  assert(studioCommitFiles.includes("games/netrunner-sg/templates/card-design/families/program.yaml"));
  assert.equal(JSON.parse(readFileSync(join(games, "netrunner-sg", "components", "cards.json")))
    .find(card => card.id === "botulus").name, "Botulus Studio Draft");
  assert.equal(JSON.parse(readFileSync(join(games, "netrunner-sg", "components", "printings.json")))
    .find(printing => printing.card_id === "botulus").quantity, studioPrintings.find(printing => printing.card_id === "botulus").quantity);
  assert.deepEqual(JSON.parse(readFileSync(join(games, "netrunner-sg", "components", "printings.json")))
    .find(printing => printing.card_id === "botulus").art_crop, studioPrinting.art_crop);
  assert(existsSync(join(games, "netrunner-sg", studioArtPath)));
  assert.deepEqual(JSON.parse(readFileSync(join(games, "netrunner-sg", "design", "art-library.json")))
    .assets.find(record => record.path === studioArtPath).tags, ["cyberpunk", "portrait"]);
  assert(JSON.parse(readFileSync(join(games, "netrunner-sg", "forge", "rights.json"))).files
    .some(rule => rule.paths.includes(studioArtPath) && rule.copyright.includes("Studio Artist")));
  const studioFaces = join(temp, "studio-back-faces");
  const renderStudioBack = spawnSync(process.execPath,
    [join(ROOT, "tools", "render_cards.mjs"), join(games, "netrunner-sg"), studioFaces, "--card", "botulus"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, FMT_RENDER_STRICT: "1" } });
  assert.equal(renderStudioBack.status, 0, `${renderStudioBack.stdout}\n${renderStudioBack.stderr}`);
  assert(readFileSync(join(studioFaces, "_back.png")).length > 1000,
    "the committed shared-back art and declarative layers must render into an exact face");
  const studioLibrary = await api("/api/games/netrunner-sg/repository/assets", { token: owner.token });
  const indexedStudioArt = studioLibrary.items.find(item => item.path === studioArtPath);
  assert.deepEqual(indexedStudioArt.tags, ["cyberpunk", "portrait"]);
  assert.match(indexedStudioArt.url, new RegExp(`ref=${studioLibrary.commit}$`));
  const taggedProject = await api("/api/games/netrunner-sg/export/project?wait=1", { method: "POST", token: owner.token });
  const taggedProjectResponse = await fetch(`${origin}${taggedProject.urls[0]}`, {
    headers: { authorization: `Bearer ${owner.token}` },
  });
  const taggedProjectBytes = Buffer.from(await taggedProjectResponse.arrayBuffer());
  assert.equal(taggedProjectResponse.status, 200, taggedProjectBytes.toString("utf8"));
  assert.equal(taggedProjectBytes.subarray(0, 2).toString(), "PK", `${taggedProject.urls[0]} did not return a ZIP`);
  const taggedProjectArchive = loadForgeProject(taggedProjectBytes);
  assert(taggedProjectArchive.entries.has("project/design/art-library.json"));
  assert.deepEqual(JSON.parse(taggedProjectArchive.entries.get("project/design/art-library.json").toString())
    .assets.find(record => record.path === studioArtPath).tags, ["cyberpunk", "portrait"]);
  await api("/api/games/netrunner-sg/collaborators/project-editor", { method: "PUT", token: owner.token,
    json: { role: "commenter" } });
  const contributorFamily = await api("/api/games/netrunner-sg/design/svg/program", { token: outsider.token });
  const contributorCards = JSON.parse(readFileSync(join(games, "netrunner-sg", "components", "cards.json")));
  contributorCards.find(card => card.id === "botulus").name = "Botulus Community Proposal";
  const contributorStudioDry = await api("/api/games/netrunner-sg/design/studio", { method: "POST", token: outsider.token,
    json: { base_ref: contributorFamily.ref, cards: contributorCards } });
  assert.equal(contributorStudioDry.mode, "dry-run");
  assert.equal(contributorStudioDry.propose, true);
  assert.deepEqual(contributorStudioDry.changed_files, ["components/cards.json"]);
  const contributorStudioCommit = await api("/api/games/netrunner-sg/design/studio?commit=1", {
    method: "POST", token: outsider.token, json: { base_ref: contributorFamily.ref, cards: contributorCards } });
  assert.equal(contributorStudioCommit.proposed, true);
  assert.equal(contributorStudioCommit.fork, "netrunner-sg-project-editor");
  assert.equal(JSON.parse(readFileSync(join(games, contributorStudioCommit.fork, "components", "cards.json")))
    .find(card => card.id === "botulus").name, "Botulus Community Proposal");
  assert.equal(spawnSync("git", ["show", "-s", "--format=%an <%ae>", contributorStudioCommit.commit],
    { cwd: temp, encoding: "utf8" }).stdout.trim(), "project-editor <editor@example.invalid>");
  const liveLayoutPath = join(games, "ember", "templates", "layout.yaml");
  const committedLayout = readFileSync(liveLayoutPath, "utf8");
  writeFileSync(liveLayoutPath, committedLayout.replace("x: 3, y: 3", "x: 30, y: 3"));
  const liveSvgFamily = await api("/api/games/ember/design/svg/default", { token: owner.token });
  assert.equal(liveSvgFamily.family, "default");
  assert.equal(liveSvgFamily.ref.length >= 7, true);
  assert.match(liveSvgFamily.svg, /data-forge-region="title"/);
  assert.equal(liveSvgFamily.layout.regions.find(region => region.id === "title").x, 3,
    "the family editor must compile the immutable ref, never a dirty local working tree");
  assert.equal(liveSvgFamily.origins.title, "templates/layout.yaml");
  const dirtyEditedSvg = liveSvgFamily.svg.replace('data-forge-region="title"', 'data-forge-region="title" transform="translate(0,1)"');
  const dirtyCommitResponse = await fetch(`${origin}/api/games/ember/design/import/svg?commit=1`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}` }, body: dirtyEditedSvg,
  });
  const dirtyCommit = await dirtyCommitResponse.json();
  assert.equal(dirtyCommitResponse.status, 409);
  assert.deepEqual(dirtyCommit.dirty_files, ["templates/layout.yaml"]);
  assert.match(dirtyCommit.error, /did not overwrite/);
  assert.match(readFileSync(liveLayoutPath, "utf8"), /x: 30, y: 3/,
    "a commit based on an immutable ref must not overwrite a dirty local design source");
  writeFileSync(liveLayoutPath, committedLayout);
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
  const svgSource = loaded.entries.get("adapters/svg/ember.svg").toString();
  const editedSvg = svgSource.replace('data-forge-region="title"', 'data-forge-region="title" transform="translate(0,1)"');
  assert.notEqual(editedSvg, svgSource);
  const svgDry = await api("/api/games/ember/design/import/svg", { method: "POST", token: outsider.token, body: editedSvg });
  assert.equal(svgDry.mode, "dry-run"); assert.equal(svgDry.propose, true); assert.equal(svgDry.conflicts.length, 0);
  assert.deepEqual(svgDry.affected_families, ["default"]);
  assert.deepEqual(svgDry.changes.map(change => [change.id, change.path, change.before, change.after]), [["title", "y", 3, 4]]);
  const svgProposed = await api("/api/games/ember/design/import/svg?commit=1", { method: "POST", token: outsider.token, body: editedSvg });
  assert.equal(svgProposed.proposed, true); assert.equal(svgProposed.pr, proposed.pr);
  const svgDetail = await api(`/api/games/ember/prs/${svgProposed.pr}`);
  assert(svgDetail.file_changes.some(change => change.path === "templates/layout.yaml"));
  assert.equal(svgDetail.reviews.length, 0);
  const svgCandidate = await api("/api/games/ember/design/import/svg", { method: "POST", token: outsider.token,
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="63mm" height="88mm" viewBox="0 0 63 88"><rect width="63" height="88"/></svg>' });
  assert.equal(svgCandidate.candidate_only, true); assert.equal(svgCandidate.recovered.objects, 1); assert.equal(svgCandidate.mode, "candidate");
  const returnedSquib = new Map(squibSuite), squibMeta = JSON.parse(returnedSquib.get("families/default/forge-source.json"));
  const squibBaseCards = JSON.parse(returnedSquib.get("families/default/base-cards.json"));
  const squibCards = csvToTable(returnedSquib.get("families/default/cards.csv").toString(), { columns: squibMeta.cards.columns }, "cards", squibBaseCards);
  squibCards[2].name += " Squib";
  returnedSquib.set("families/default/cards.csv", Buffer.from(tableToCsv(squibCards, "cards").csv));
  returnedSquib.set("families/default/deck.rb", Buffer.from("raise 'Forge must never run this'\n"));
  const returnedSquibArchive = deterministicZip(returnedSquib);
  const squibDry = await api("/api/games/ember/design/import/squib", { method: "POST", token: outsider.token, body: returnedSquibArchive });
  assert.equal(squibDry.mode, "dry-run"); assert.equal(squibDry.propose, true); assert.equal(squibDry.conflicts.length, 0, JSON.stringify(squibDry.conflicts));
  assert.deepEqual(squibDry.changes.cards.changed, [squibCards[2].id]);
  assert(squibDry.ignored.includes("deck.rb"));
  const squibProposed = await api("/api/games/ember/design/import/squib?commit=1", { method: "POST", token: outsider.token, body: returnedSquibArchive });
  assert.equal(squibProposed.proposed, true); assert.equal(squibProposed.pr, proposed.pr);
  const squibDetail = await api(`/api/games/ember/prs/${squibProposed.pr}`);
  assert(squibDetail.changes.some(change => change.card === squibCards[2].id));
  assert.equal(squibDetail.reviews.length, 0);
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
    assert.match(readFileSync(join(games, "ember", "templates", "layout.yaml"), "utf8"), /y: 4\b/);
  }
  const directTableCommit = await api(`/api/games/ember/design/import/table?kind=cards&base_ref=${dataExport.ref}&commit=1`, {
    method: "POST", token: owner.token, body: directCards.replace(",Twin Flame,", ",Twin Flame from CSV,") });
  assert.equal(directTableCommit.saved, true);
  assert.equal(JSON.parse(readFileSync(join(games, "ember", "components", "cards.json"), "utf8"))
    .find(card => card.id === "twin_flame").name, "Twin Flame from CSV");

  const starterProject = await api("/api/games", { method: "POST", token: owner.token, json: {
    title: "Wizard Smoke", license: "CC0-1.0", brief: {
      schema_version: 1, status: "idea", starting_point: "mechanism",
      spark: "Test the smallest useful card-system bootstrap.",
      design_intent: { player_experience: "Make one clear choice at a time." },
      mvp: { playable_slice: "Draw two cards and choose one." },
    },
  } });
  assert.equal(starterProject.cards, 0);
  const starterDry = await api(`/api/games/${starterProject.slug}/design/card-starter`, {
    method: "POST", token: owner.token, json: { starter: {
      template: "classic", size: "japanese", names: ["Strike", "Guard"],
      fields: ["cost", "power", "category"], back_text: "WIZARD SMOKE", quantity: 2,
    } },
  });
  assert.equal(starterDry.mode, "dry-run");
  assert.equal(starterDry.validation.ok, true, JSON.stringify(starterDry.validation));
  assert.equal(starterDry.cards.length, 2);
  assert.equal(starterDry.layout.card.w_mm, 59);
  assert.equal(starterDry.layout.card.h_mm, 86);
  assert.equal(starterDry.layout.back.text, "WIZARD SMOKE");
  assert.deepEqual(starterDry.layout.back.regions.map(region => region.id), ["back_field", "back_border", "back_title"]);
  assert.match(JSON.stringify(starterDry.layout), /card\.attributes\.category/,
    "every selected starter field must be bound into the visible card template");
  assert.deepEqual(starterDry.changed_files, ["game.yaml", "components/cards.json", "components/printings.json",
    "sets/sets.yaml", "templates/layout.yaml", "templates/card-design/manifest.yaml", "templates/card-design/system.yaml",
    "templates/card-design/families/card.yaml", "templates/print.yaml", "design/card-starter.json"]);
  assert(!existsSync(join(games, starterProject.slug, "templates", "layout.yaml")),
    "reviewing the first component must not touch the working tree");
  const starterCommit = await api(`/api/games/${starterProject.slug}/design/card-starter?commit=1`, {
    method: "POST", token: owner.token, json: { starter: starterDry.starter, base_ref: starterDry.base_ref },
  });
  assert.equal(starterCommit.saved, true);
  assert.equal(JSON.parse(readFileSync(join(games, starterProject.slug, "components", "cards.json"))).length, 2);
  assert.equal(JSON.parse(readFileSync(join(games, starterProject.slug, "components", "printings.json")))[0].quantity, 2);
  assert.match(readFileSync(join(games, starterProject.slug, "templates", "layout.yaml"), "utf8"), /back:/);
  assert.equal(JSON.parse(readFileSync(join(games, starterProject.slug, "design", "card-starter.json"))).size, "japanese");
  const starterRegistry = loadDesignEngines(join(games, starterProject.slug));
  const starterLegacyLayout = yaml.load(readFileSync(join(games, starterProject.slug, "templates", "layout.yaml"), "utf8"));
  assert.equal(starterRegistry.inferred, true);
  assert.equal(starterRegistry.active, "forge-native");
  assert.equal(starterRegistry.card_design.families.length, 1);
  assert.equal(starterRegistry.card_design.families[0].id, "card");
  assert.deepEqual(starterRegistry.card_design.families[0].layout, starterLegacyLayout,
    "the native Studio family and portable legacy layout must compile identically");
  const starterCommitFiles = spawnSync("git", ["show", "--pretty=", "--name-only", starterCommit.commit],
    { cwd: temp, encoding: "utf8" }).stdout.trim().split("\n");
  for (const path of starterDry.changed_files) assert(starterCommitFiles.includes(`games/${starterProject.slug}/${path}`),
    `first-component commit includes ${path}`);
  const cardEditBase = await api(`/api/games/${starterProject.slug}/access`, { token: owner.token });
  const concurrentCards = JSON.parse(readFileSync(join(games, starterProject.slug, "components", "cards.json"), "utf8"));
  concurrentCards[0].text = "A newer Sheet or collaborator change.";
  await api(`/api/games/${starterProject.slug}/cards`, { method: "PUT", token: owner.token, json: concurrentCards });
  const staleCards = structuredClone(concurrentCards);
  staleCards[0].text = "A stale editor must not overwrite the newer change.";
  const staleCardResponse = await fetch(`${origin}/api/games/${starterProject.slug}/cards`, { method: "PUT",
    headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ cards: staleCards, base_ref: cardEditBase.ref }) });
  const staleCardBody = await staleCardResponse.json();
  assert.equal(staleCardResponse.status, 409);
  assert.equal(staleCardBody.written, false);
  assert.equal(JSON.parse(readFileSync(join(games, starterProject.slug, "components", "cards.json"), "utf8"))[0].text,
    "A newer Sheet or collaborator change.", "a stale visual editor cannot overwrite a newer card commit");
  const proposalBase = await api(`/api/games/${starterProject.slug}/access`, { token: outsider.token });
  const newerCards = structuredClone(concurrentCards);
  newerCards[1].text = "A maintainer change after the contributor opened the source.";
  await api(`/api/games/${starterProject.slug}/cards`, { method: "PUT", token: owner.token,
    json: { cards: newerCards, base_ref: proposalBase.ref } });
  const staleProposalCards = structuredClone(newerCards);
  staleProposalCards[0].text = "A stale proposal must not fork an obsolete source version.";
  const staleProposalResponse = await fetch(`${origin}/api/games/${starterProject.slug}/cards/propose`, { method: "POST",
    headers: { authorization: `Bearer ${outsider.token}`, "content-type": "application/json" },
    body: JSON.stringify({ cards: staleProposalCards, title: "Stale card proposal", base_ref: proposalBase.ref }) });
  const staleProposalBody = await staleProposalResponse.json();
  assert.equal(staleProposalResponse.status, 409);
  assert.equal(staleProposalBody.written, false);
  assert.equal(JSON.parse(readFileSync(join(games, starterProject.slug, "components", "cards.json"), "utf8"))[1].text,
    "A maintainer change after the contributor opened the source.",
    "a stale no-write-access proposal cannot branch from an obsolete source version");
  const repeatedStarter = await fetch(`${origin}/api/games/${starterProject.slug}/design/card-starter`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ starter: starterDry.starter }),
  });
  assert.equal(repeatedStarter.status, 409, "the bootstrap cannot overwrite an existing card system");

  const printProfileDefault = await api(`/api/games/${starterProject.slug}/design/print-profile`, { token: owner.token });
  assert.equal(printProfileDefault.source, "templates/print.yaml");
  assert.deepEqual(printProfileDefault.profile.selection.card_ids, []);
  assert.equal(printProfileDefault.capabilities.embedded_pdf_font, true);
  assert.equal(printProfileDefault.capabilities.cmyk, "project-supplied output ICC");
  assert.equal(printProfileDefault.capabilities.pdf_x, "PDF/X-1a:2003 structurally preflighted candidate");
  assert.deepEqual(printProfileDefault.capabilities.crop_mark_sides, ["both", "fronts", "backs"]);
  assert(printProfileDefault.capabilities.production_targets.some(target => target.id === "the-game-crafter-poker"
    && target.status === "spec-checked-handoff" && target.requirements.upload_px.join("x") === "825x1125"),
  "the production planner exposes the checked TGC Poker file contract without claiming publishing");
  assert(printProfileDefault.capabilities.production_targets.some(target => target.id === "custom-cmyk-pdfx1a"
    && target.status === "profile-required"),
  "the production planner exposes profile-driven CMYK without implying a bundled printer profile");
  const exactPrintProfile = {
    schema_version: 1, preset: "opaque-sleeves", selection: { card_ids: ["strike"] },
    home: { fronts_only: true, gutter_mm: 3, crop_marks: "corners", crop_mark_sides: "fronts",
      sleeve_profile: "japanese-62x89", sleeve_fit: "extend" },
    press: { include_back: false, crop_marks: "outside-bleed", crop_mark_sides: "fronts", color_space: "sRGB", pdf_standard: "none" },
  };
  const printProfileDry = await api(`/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", token: owner.token, json: { profile: exactPrintProfile },
  });
  assert.equal(printProfileDry.mode, "dry-run");
  assert.equal(printProfileDry.validation.ok, true, JSON.stringify(printProfileDry.validation));
  assert.deepEqual(printProfileDry.selected_cards.map(card => card.id), ["strike"]);
  assert.equal(printProfileDry.printings, 1);
  assert.equal(printProfileDry.physical_cards, 2);
  const printProfileBeforeCommit = readFileSync(join(games, starterProject.slug, "templates", "print.yaml"), "utf8");
  assert(!/opaque-sleeves/.test(printProfileBeforeCommit),
    "reviewing a print profile must not touch its committed source");
  const printProfileCommit = await api(`/api/games/${starterProject.slug}/design/print-profile`, {
    method: "PUT", token: owner.token,
    json: { profile: exactPrintProfile, base_ref: printProfileDry.base_ref },
  });
  assert.equal(printProfileCommit.saved, true);
  assert.match(readFileSync(join(games, starterProject.slug, "templates", "print.yaml"), "utf8"), /opaque-sleeves/);
  assert(spawnSync("git", ["show", "--pretty=", "--name-only", printProfileCommit.commit],
    { cwd: temp, encoding: "utf8" }).stdout.trim().split("\n")
    .includes(`games/${starterProject.slug}/templates/print.yaml`),
    "the reviewed production profile is its own exact commit");
  const exactPrintBuild = await api(`/api/games/${starterProject.slug}/export/print?wait=1`, {
    method: "POST", token: owner.token,
  });
  const exactPrintUrl = exactPrintBuild.urls.find(url => url.endsWith("print-ready.zip"));
  assert(exactPrintUrl, JSON.stringify(exactPrintBuild.urls));
  const exactPrintZip = readZip(Buffer.from(await (await fetch(`${origin}${exactPrintUrl}`)).arrayBuffer()));
  assert(exactPrintZip.has("fronts-bleed/p_strike_core.png"));
  assert(!exactPrintZip.has("fronts-bleed/p_guard_core.png"),
    "an exact selection must not leak unselected face files into the release ZIP");
  assert(exactPrintZip.has("print-profile.yaml") && exactPrintZip.has("preflight.json"));
  const exactPrintPreflight = JSON.parse(exactPrintZip.get("preflight.json"));
  assert.deepEqual(exactPrintPreflight.selection.card_ids, ["strike"]);
  assert.equal(exactPrintPreflight.press_boundary.cmyk_faces, false);
  assert.deepEqual(exactPrintPreflight.crop_marks.home, { style: "corners", sides: "fronts" });
  assert.deepEqual(exactPrintPreflight.crop_marks.press, { style: "outside-bleed", sides: "fronts" });
  assert(exactPrintPreflight.pdfs.some(pdf => pdf.file.includes("japanese-62x89")
    && pdf.fonts.some(font => font.embedded)),
  "preflight reopens and checks the configured sleeve PDFs, including their embedded PDF-owned font");
  const invalidPrintProfile = structuredClone(exactPrintProfile);
  invalidPrintProfile.selection.card_ids = ["card-that-does-not-exist"];
  const invalidPrintResponse = await fetch(`${origin}/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ profile: invalidPrintProfile }),
  });
  assert.equal(invalidPrintResponse.status, 422, "print selection must reference a stable card ID");
  const incompatibleTarget = structuredClone(exactPrintProfile);
  incompatibleTarget.preset = "the-game-crafter-poker";
  incompatibleTarget.press.target = "the-game-crafter-poker";
  const incompatibleTargetResponse = await fetch(`${origin}/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ profile: incompatibleTarget }),
  });
  assert.equal(incompatibleTargetResponse.status, 422,
    "a Japanese-size project cannot be labelled as a TGC Poker handoff merely by selecting the preset");
  const missingIccProfile = structuredClone(exactPrintProfile);
  Object.assign(missingIccProfile, { preset: "custom-cmyk-pdfx1a" });
  Object.assign(missingIccProfile.press, { target: "custom-cmyk-pdfx1a", color_space: "CMYK",
    pdf_standard: "PDF/X-1a:2003", icc_profile: "assets/color-profiles/missing.icc",
    output_condition_identifier: "TEST", output_condition: "Test printer condition",
    registry_name: "https://registry.color.org/", max_ink_coverage_percent: 300,
    rendering_intent: "relative-colorimetric" });
  const missingIccResponse = await fetch(`${origin}/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ profile: missingIccProfile }),
  });
  assert.equal(missingIccResponse.status, 422,
    "CMYK selection must fail before commit when the exact rights-tracked printer profile is absent");
  const impossibleMarks = structuredClone(exactPrintProfile);
  impossibleMarks.home.gutter_mm = 0;
  const impossibleMarksResponse = await fetch(`${origin}/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ profile: impossibleMarks }),
  });
  assert.equal(impossibleMarksResponse.status, 422,
    "per-card corner marks need positive space and must fail before commit or export");
  const missingBackMarks = structuredClone(exactPrintProfile);
  missingBackMarks.home.crop_mark_sides = "backs";
  const missingBackMarksResponse = await fetch(`${origin}/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ profile: missingBackMarks }),
  });
  assert.equal(missingBackMarksResponse.status, 422,
    "a fronts-only build cannot silently request crop marks on absent back pages");
  const rgbSpotProfile = structuredClone(exactPrintProfile);
  rgbSpotProfile.press.dieline = { enabled: true, shape: "component-trim", spot_name: "CutContour",
    alternate_cmyk: [0, 100, 0, 0], stroke_width_pt: 0.25, offset_mm: 0,
    overprint: true, sides: "fronts" };
  const rgbSpotResponse = await fetch(`${origin}/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ profile: rgbSpotProfile }),
  });
  assert.equal(rgbSpotResponse.status, 422,
    "a named Separation finishing path cannot be attached to an sRGB target");
  const invisibleSpotProfile = structuredClone(missingIccProfile);
  invisibleSpotProfile.press.dieline = { enabled: true, shape: "component-trim", spot_name: "CutContour",
    alternate_cmyk: [0, 0, 0, 0], stroke_width_pt: 0.25, offset_mm: 0,
    overprint: true, sides: "fronts" };
  const invisibleSpotResponse = await fetch(`${origin}/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ profile: invisibleSpotProfile }),
  });
  assert.equal(invisibleSpotResponse.status, 422,
    "a finishing path cannot use an invisible alternate display color");
  const knockoutSpotProfile = structuredClone(missingIccProfile);
  knockoutSpotProfile.press.dieline = { enabled: true, shape: "component-trim", spot_name: "CutContour",
    alternate_cmyk: [0, 100, 0, 0], stroke_width_pt: 0.25, offset_mm: 0,
    overprint: false, sides: "fronts" };
  const knockoutSpotResponse = await fetch(`${origin}/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ profile: knockoutSpotProfile }),
  });
  assert.equal(knockoutSpotResponse.status, 422,
    "a finishing path cannot silently knock out underlying artwork");
  const outsideBleedSpotProfile = structuredClone(missingIccProfile);
  outsideBleedSpotProfile.press.dieline = { enabled: true, shape: "component-trim", spot_name: "CutContour",
    alternate_cmyk: [0, 100, 0, 0], stroke_width_pt: 0.25, offset_mm: 4,
    overprint: true, sides: "fronts" };
  const outsideBleedSpotResponse = await fetch(`${origin}/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ profile: outsideBleedSpotProfile }),
  });
  assert.equal(outsideBleedSpotResponse.status, 422,
    "an outward finishing path cannot exceed the component's committed bleed");
  const proposedPrintProfile = structuredClone(exactPrintProfile);
  proposedPrintProfile.selection.card_ids = ["guard"];
  const contributorPrintDry = await api(`/api/games/${starterProject.slug}/design/print-profile`, {
    method: "POST", token: outsider.token, json: { profile: proposedPrintProfile },
  });
  assert.equal(contributorPrintDry.access.can_write, false);
  assert.equal(contributorPrintDry.access.authenticated, true);
  const contributorPrintCommit = await api(`/api/games/${starterProject.slug}/design/print-profile`, {
    method: "PUT", token: outsider.token,
    json: { profile: proposedPrintProfile, base_ref: contributorPrintDry.base_ref },
  });
  assert.equal(contributorPrintCommit.proposed, true);
  assert.equal(contributorPrintCommit.fork, `${starterProject.slug}-project-editor`);
  const contributorPrintPr = await api(`/api/games/${starterProject.slug}/prs/${contributorPrintCommit.pr}`);
  assert(contributorPrintPr.file_changes.some(change => change.path === "templates/print.yaml"),
    "a contributor's print contract is a reviewable source-file change");
  assert.equal(spawnSync("git", ["show", "-s", "--format=%an <%ae>", contributorPrintCommit.commit],
    { cwd: temp, encoding: "utf8" }).stdout.trim(), "project-editor <editor@example.invalid>");

  const proposalEditor = await api("/api/auth/register", { method: "POST", json: {
    handle: "proposal-editor", email: "proposal-editor@example.invalid", password: "password123",
  } });
  const cardProposalBase = await api(`/api/games/${starterProject.slug}/access`, { token: proposalEditor.token });
  const cardProposalCards = JSON.parse(readFileSync(join(games, starterProject.slug, "components", "cards.json"), "utf8"));
  cardProposalCards[0].text = "A focused proposal keeps its exact source and contributor versions.";
  const cardProposal = await api(`/api/games/${starterProject.slug}/cards/propose`, {
    method: "POST", token: proposalEditor.token, json: {
      cards: cardProposalCards, title: "Keep proposal versions exact", base_ref: cardProposalBase.ref,
    },
  });
  const focusedProposalUrl = `/#/g/${encodeURIComponent(starterProject.namespace)}/${encodeURIComponent(starterProject.repo_slug)}`
    + `/suggestions/${encodeURIComponent(cardProposal.pr)}`;
  assert.equal(cardProposal.base_ref, cardProposalBase.ref,
    "the card proposal returns the exact source version the contributor reviewed");
  assert.equal(cardProposal.proposed_ref, cardProposal.commit,
    "the card proposal returns the exact committed contributor version");
  assert.equal(cardProposal.url, focusedProposalUrl,
    "the card proposal returns its canonical focused review URL");
  const proposalDb = new DatabaseSync(dbPath);
  try {
    const storedCardProposal = proposalDb.prepare("SELECT base, proposed FROM prs WHERE id = ?").get(cardProposal.pr);
    assert(storedCardProposal, "the card proposal is persisted for review");
    assert.equal(JSON.parse(storedCardProposal.base).ref, cardProposal.base_ref,
      "the persisted card-proposal base matches the API contract");
    assert.equal(JSON.parse(storedCardProposal.proposed).ref, cardProposal.proposed_ref,
      "the persisted card-proposal head matches the API contract");
  } finally { proposalDb.close(); }
  const cardProposalNotifications = await api("/api/notifications", { token: owner.token });
  assert(cardProposalNotifications.items.some(notification => notification.kind === "pr_open"
    && notification.actor_handle === "proposal-editor" && notification.game_slug === starterProject.slug
    && notification.target === cardProposal.pr),
  "opening a card proposal notifies the game owner with the focused proposal target");
  const cardProposalActivity = await api("/api/activity?user=proposal-editor", { token: proposalEditor.token });
  assert(cardProposalActivity.some(event => event.kind === "pr_open" && event.game_slug === starterProject.slug
    && event.target === cardProposal.pr),
  "opening a card proposal records attributed pr_open activity");

  await api(`/api/games/${starterProject.slug}/prs/${cardProposal.pr}/close`, {
    method: "POST", token: proposalEditor.token, json: {},
  });
  const editionProposal = await api(`/api/games/${starterProject.slug}/prs`, {
    method: "POST", token: proposalEditor.token, json: {
      from: cardProposal.fork, title: "Propose the exact edition", body: "Review the same exact committed card change.",
    },
  });
  const focusedEditionUrl = `/#/g/${encodeURIComponent(starterProject.namespace)}/${encodeURIComponent(starterProject.repo_slug)}`
    + `/suggestions/${encodeURIComponent(editionProposal.id)}`;
  assert.equal(editionProposal.base_ref, cardProposal.base_ref,
    "an explicit edition proposal preserves the exact version the edition forked from");
  assert.equal(editionProposal.proposed_ref, cardProposal.proposed_ref,
    "an explicit edition proposal identifies the exact contributor commit under review");
  assert.equal(editionProposal.url, focusedEditionUrl,
    "an explicit edition proposal returns its canonical focused review URL");
  const editionProposalDb = new DatabaseSync(dbPath);
  try {
    const storedEditionProposal = editionProposalDb.prepare("SELECT base, proposed FROM prs WHERE id = ?").get(editionProposal.id);
    assert(storedEditionProposal, "the explicit edition proposal is persisted for review");
    assert.equal(JSON.parse(storedEditionProposal.base).ref, editionProposal.base_ref,
      "the persisted edition-proposal base matches the API contract");
    assert.equal(JSON.parse(storedEditionProposal.proposed).ref, editionProposal.proposed_ref,
      "the persisted edition-proposal head matches the API contract");
  } finally { editionProposalDb.close(); }
  const editionProposalNotifications = await api("/api/notifications", { token: owner.token });
  assert(editionProposalNotifications.items.some(notification => notification.kind === "pr_open"
    && notification.actor_handle === "proposal-editor" && notification.game_slug === starterProject.slug
    && notification.target === editionProposal.id),
  "opening an edition proposal notifies the game owner with the focused proposal target");
  const editionProposalActivity = await api("/api/activity?user=proposal-editor", { token: proposalEditor.token });
  assert(editionProposalActivity.some(event => event.kind === "pr_open" && event.game_slug === starterProject.slug
    && event.target === editionProposal.id),
  "opening an edition proposal records attributed pr_open activity");

  console.log(`forge-project-server: HTTP project + first-component wizard + versioned print profile + direct editor CSV + pieces + nanDECK + Squib + SVG + PnPInk + native Tabletop Playground export → dry-run → direct commit or fork/commit/PR${hasYaml ? " → merge" : " (merge skipped: PyYAML unavailable)"} verified`);
} finally {
  if (server && server.exitCode == null) server.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}
