#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "forge-pilot-report-"));
try {
  const base = JSON.parse(readFileSync(join(root, "deploy/pilot-cohort.example.json"), "utf8"));
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
  base.runs[0].integrity.credit_lost = true;
  const stopped = join(temp, "stopped.json"); writeFileSync(stopped, JSON.stringify(base));
  const failed = run(stopped); assert.notEqual(failed.status, 0); assert.equal(JSON.parse(failed.stdout).decision, "HOLD");
  assert.match(failed.stdout, /credit_lost/);
  console.log("PILOT REPORT GREEN — live Sheets evidence plus five-person thresholds proceed; missing connector or integrity failure forces HOLD.");
} finally { rmSync(temp, { recursive: true, force: true }); }
