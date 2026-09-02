#!/usr/bin/env node
/** Evaluate a five-person controlled-alpha record without collecting game text. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const input = process.argv.slice(2).find(arg => !arg.startsWith("--"));
if (!input) { console.error("usage: node tools/pilot-report.mjs <cohort.json> [--json]"); process.exit(2); }
const document = JSON.parse(readFileSync(resolve(input), "utf8"));
const schema = JSON.parse(readFileSync(resolve(ROOT, "schemas/pilot-cohort.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(document)) {
  for (const error of validate.errors || []) console.error(`ERROR ${error.instancePath || "/"} ${error.message}`);
  process.exit(1);
}

const failures = [], stop = [];
const unique = (values, label) => {
  const seen = new Set();
  for (const value of values) { if (seen.has(value)) failures.push(`duplicate ${label}: ${value}`); seen.add(value); }
};
unique(document.participants.map(item => item.id), "participant id");
unique(document.runs.map(item => item.id), "run id");
const participantIds = new Set(document.participants.map(item => item.id));
for (const run of document.runs) {
  for (const id of run.participant_ids) if (!participantIds.has(id)) failures.push(`${run.id} references unknown participant ${id}`);
  const names = run.milestones.map(item => item.name); unique(names.map(name => `${run.id}/${name}`), "milestone");
  if (run.status === "completed") {
    for (const expected of ["import-committed", "proof-downloaded", "edition-proposed", "proposal-merged", "release-downloaded", "release-reproduced"])
      if (!run.milestones.some(item => item.name === expected && item.status === "complete")) failures.push(`${run.id} is missing completed milestone ${expected}`);
    if (!run.integrity.release_reproduced) failures.push(`${run.id} release was not reproduced`);
  }
  for (const [name, triggered] of Object.entries(run.integrity))
    if (name !== "release_reproduced" && triggered) stop.push(`${run.id}: ${name}`);
}
for (const item of document.stop_conditions) if (item.triggered) stop.push(item.detail ? `${item.condition}: ${item.detail}` : item.condition);

const participants = document.participants.length;
const complete = document.participants.filter(item => item.journey_complete).length;
const unassisted = document.participants.filter(item => item.journey_complete && item.unassisted).length;
const reuse = document.participants.filter(item => item.would_reuse === "yes").length;
const completedRuns = document.runs.filter(item => item.status === "completed").length;
const thresholds = [
  { name: "cohort size", ok: participants >= 5, result: `${participants}/5 people` },
  { name: "assigned journey complete", ok: complete >= 4, result: `${complete}/5; need 4` },
  { name: "unassisted completion", ok: unassisted >= 3, result: `${unassisted}/5; need 3` },
  { name: "complete paired runs", ok: completedRuns >= 2, result: `${completedRuns}/2` },
  { name: "would reuse Forge", ok: reuse >= Math.ceil(participants / 2), result: `${reuse}/${participants}; need ${Math.ceil(participants / 2)}` },
  { name: "restore drill", ok: document.candidate.restore_drill_passed, result: document.candidate.restore_drill_passed ? "passed" : "not passed" },
  { name: "operator on call", ok: document.operator.on_call_confirmed, result: document.operator.on_call_confirmed ? "confirmed" : "not confirmed" },
  { name: "integrity stop conditions", ok: stop.length === 0, result: stop.length ? stop.join("; ") : "none triggered" },
  { name: "record integrity", ok: failures.length === 0, result: failures.length ? failures.join("; ") : "valid" },
];
const passed = thresholds.every(item => item.ok);
const report = { cohort_id: document.cohort_id, candidate: document.candidate.commit, decision: passed ? "PROCEED" : "HOLD",
  participants: { total: participants, complete, unassisted, would_reuse: reuse }, completed_runs: completedRuns,
  thresholds, stop_conditions: stop };
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Forge pilot ${document.cohort_id} — ${report.decision}\n`);
  for (const row of thresholds) console.log(`${row.ok ? "✓" : "✗"} ${row.name}: ${row.result}`);
}
if (!passed) process.exit(1);
