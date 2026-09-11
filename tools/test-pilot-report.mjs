#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "forge-pilot-report-"));
try {
  const base = JSON.parse(readFileSync(join(root, "deploy/pilot-cohort.example.json"), "utf8"));
  base.candidate.preflight_evidence = "preflight.json";
  base.candidate.sheets_connector.package_receipt = "sheets/forge-deployment.json";
  const preflight = {
    format: "forge-production-preflight", version: 1, checked_at: new Date().toISOString(), online: true,
    commit: base.candidate.commit,
    origins: { forge: base.candidate.origin, forgejo: "https://git.forge.example", r2_bucket: "forge-lfs" },
    images: { gateway: base.candidate.gateway_image, forgejo: base.candidate.forgejo_image, postgres: base.candidate.postgres_image },
    checks: [{ ok: true, name: "Forge HTTPS health", detail: "HTTP 200" },
      { ok: true, name: "public card-preview assets", detail: "4/4 assets checked" }],
    preview_assets: { slug: "ember", ref: "a".repeat(40), checked: 4, total: 4 },
  };
  writeFileSync(join(temp, "preflight.json"), JSON.stringify(preflight));
  const sheetsDir = join(temp, "sheets"), sourceDir = join(sheetsDir, "src");
  mkdirSync(sourceDir, { recursive: true });
  const source = "function onOpen() {}\n", sourcePath = join(sourceDir, "Code.gs");
  writeFileSync(sourcePath, source);
  const packageReceipt = {
    format: "forge-google-sheets-addon-package", version: 1,
    forge_origin: base.candidate.origin, source_revision: base.candidate.commit, source_dirty: false,
    url_fetch_allowlist: [`${base.candidate.origin}/`],
    files: [{ path: "src/Code.gs", bytes: Buffer.byteLength(source), sha256: createHash("sha256").update(source).digest("hex") }],
  };
  writeFileSync(join(sheetsDir, "forge-deployment.json"), JSON.stringify(packageReceipt));
  base.candidate.restore_drill_passed = true;
  base.operator.on_call_confirmed = true;
  base.participants.forEach((item, index) => {
    item.journey_complete = index < 4;
    item.unassisted = index < 3;
    item.would_reuse = index < 3 ? "yes" : "no";
  });
  const milestones = ["import-committed", "proof-downloaded", "edition-proposed", "proposal-merged", "release-downloaded", "release-reproduced"]
    .map(name => ({ name, status: "complete", help_required: false, error_category: "none" }));
  base.runs.forEach(run => { run.status = "completed"; run.milestones = milestones; run.integrity.release_reproduced = true; });
  const run = path => spawnSync(process.execPath, ["tools/pilot-report.mjs", path, "--json"], { cwd: root, encoding: "utf8" });
  const missingSheets = join(temp, "missing-sheets.json"); writeFileSync(missingSheets, JSON.stringify(base));
  const sheetsHold = run(missingSheets); assert.notEqual(sheetsHold.status, 0); assert.match(sheetsHold.stdout, /Sheets connector live/);
  base.candidate.sheets_connector.live_journey_passed = true;
  base.candidate.sheets_connector.resulting_commit = "1234567890abcdef";
  const green = join(temp, "green.json"); writeFileSync(green, JSON.stringify(base));
  const passed = run(green); assert.equal(passed.status, 0, passed.stderr); assert.equal(JSON.parse(passed.stdout).decision, "PROCEED");
  const healthOnly = structuredClone(preflight);
  delete healthOnly.preview_assets;
  healthOnly.checks = healthOnly.checks.filter(item => item.name !== "public card-preview assets");
  writeFileSync(join(temp, "preflight.json"), JSON.stringify(healthOnly));
  const missingPreview = run(green); assert.notEqual(missingPreview.status, 0);
  assert.match(missingPreview.stdout, /missing public card-preview asset evidence/);
  writeFileSync(join(temp, "preflight.json"), JSON.stringify(preflight));
  const wrongCandidate = structuredClone(base);
  wrongCandidate.candidate.origin = "https://different.forge.example";
  const mismatched = join(temp, "mismatched.json"); writeFileSync(mismatched, JSON.stringify(wrongCandidate));
  const mismatchResult = run(mismatched); assert.notEqual(mismatchResult.status, 0);
  assert.match(mismatchResult.stdout, /candidate evidence binding/);
  assert.match(mismatchResult.stdout, /origin does not match/);
  writeFileSync(sourcePath, "function tampered() {}\n");
  const tampered = run(green); assert.notEqual(tampered.status, 0);
  assert.match(tampered.stdout, /source hash does not match/);
  writeFileSync(sourcePath, source);
  base.runs[0].integrity.credit_lost = true;
  const stopped = join(temp, "stopped.json"); writeFileSync(stopped, JSON.stringify(base));
  const failed = run(stopped); assert.notEqual(failed.status, 0); assert.equal(JSON.parse(failed.stdout).decision, "HOLD");
  assert.match(failed.stdout, /credit_lost/);
  console.log("PILOT REPORT GREEN — exact preflight/package evidence plus five-person thresholds proceed; mismatch, tampering, or integrity failure forces HOLD.");
} finally { rmSync(temp, { recursive: true, force: true }); }
