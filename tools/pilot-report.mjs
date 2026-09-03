#!/usr/bin/env node
/** Evaluate a five-person controlled-beta record without collecting game text. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const input = process.argv.slice(2).find(arg => !arg.startsWith("--"));
if (!input) { console.error("usage: node tools/pilot-report.mjs <cohort.json> [--json]"); process.exit(2); }
const inputPath = resolve(input);
const evidenceRoot = dirname(inputPath);
const document = JSON.parse(readFileSync(inputPath, "utf8"));
const schema = JSON.parse(readFileSync(resolve(ROOT, "schemas/pilot-cohort.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(document)) {
  for (const error of validate.errors || []) console.error(`ERROR ${error.instancePath || "/"} ${error.message}`);
  process.exit(1);
}

const failures = [], stop = [], evidenceFailures = [];
const sameRevision = (left, right) => {
  left = String(left || "").toLowerCase(); right = String(right || "").toLowerCase();
  return left.length >= 7 && right.length >= 7 && (left === right || left.startsWith(right) || right.startsWith(left));
};
const evidencePath = value => isAbsolute(value) ? resolve(value) : resolve(evidenceRoot, value);
const readEvidence = (label, value) => {
  const path = evidencePath(value);
  if (!existsSync(path) || !statSync(path).isFile()) {
    evidenceFailures.push(`${label} is missing or not a file`);
    return null;
  }
  try { return { path, value: JSON.parse(readFileSync(path, "utf8")) }; }
  catch { evidenceFailures.push(`${label} is not valid JSON`); return null; }
};

const preflightRecord = readEvidence("production preflight evidence", document.candidate.preflight_evidence);
if (preflightRecord) {
  const evidence = preflightRecord.value;
  if (evidence.format !== "forge-production-preflight" || evidence.version !== 1)
    evidenceFailures.push("production preflight evidence has an unsupported format");
  if (evidence.online !== true) evidenceFailures.push("production preflight did not include online DNS/TLS/R2 checks");
  if (!sameRevision(evidence.commit, document.candidate.commit))
    evidenceFailures.push("production preflight commit does not match the pilot candidate");
  if (evidence.origins?.forge !== document.candidate.origin)
    evidenceFailures.push("production preflight Forge origin does not match the pilot candidate");
  for (const [field, expected] of [["gateway", document.candidate.gateway_image], ["forgejo", document.candidate.forgejo_image], ["postgres", document.candidate.postgres_image]])
    if (evidence.images?.[field] !== expected) evidenceFailures.push(`production preflight ${field} image does not match the pilot candidate`);
  if (!Array.isArray(evidence.checks) || !evidence.checks.length || evidence.checks.some(item => item?.ok !== true))
    evidenceFailures.push("production preflight evidence does not contain an all-green check set");
}

const packageRecord = readEvidence("Sheets package receipt", document.candidate.sheets_connector.package_receipt);
if (packageRecord) {
  const receipt = packageRecord.value;
  if (receipt.format !== "forge-google-sheets-addon-package" || receipt.version !== 1)
    evidenceFailures.push("Sheets package receipt has an unsupported format");
  if (receipt.forge_origin !== document.candidate.origin)
    evidenceFailures.push("Sheets package origin does not match the pilot candidate");
  if (!sameRevision(receipt.source_revision, document.candidate.commit))
    evidenceFailures.push("Sheets package source revision does not match the pilot candidate");
  if (receipt.source_dirty !== false) evidenceFailures.push("Sheets package was built from dirty connector sources");
  if (!Array.isArray(receipt.url_fetch_allowlist) || receipt.url_fetch_allowlist.length !== 1
    || receipt.url_fetch_allowlist[0] !== `${document.candidate.origin}/`)
    evidenceFailures.push("Sheets package URL allowlist does not match the pilot origin");
  if (!Array.isArray(receipt.files) || !receipt.files.length) {
    evidenceFailures.push("Sheets package receipt contains no source-file hashes");
  } else {
    const packageRoot = dirname(packageRecord.path);
    for (const file of receipt.files) {
      const relative = typeof file?.path === "string" ? file.path : "";
      const path = resolve(packageRoot, relative);
      if (!relative || isAbsolute(relative) || path === packageRoot || !path.startsWith(packageRoot + sep)) {
        evidenceFailures.push("Sheets package receipt contains an unsafe source path");
        continue;
      }
      if (!existsSync(path) || !statSync(path).isFile()) {
        evidenceFailures.push(`Sheets package source is missing: ${relative || "unknown"}`);
        continue;
      }
      const bytes = readFileSync(path);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== file.bytes || digest !== file.sha256)
        evidenceFailures.push(`Sheets package source hash does not match its receipt: ${relative}`);
    }
  }
}
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
  { name: "candidate evidence binding", ok: evidenceFailures.length === 0,
    result: evidenceFailures.length ? evidenceFailures.join("; ") : "preflight and Sheets package match the exact candidate" },
  { name: "cohort size", ok: participants >= 5, result: `${participants}/5 people` },
  { name: "assigned journey complete", ok: complete >= 4, result: `${complete}/5; need 4` },
  { name: "unassisted completion", ok: unassisted >= 3, result: `${unassisted}/5; need 3` },
  { name: "complete paired runs", ok: completedRuns >= 2, result: `${completedRuns}/2` },
  { name: "would reuse Forge", ok: reuse >= Math.ceil(participants / 2), result: `${reuse}/${participants}; need ${Math.ceil(participants / 2)}` },
  { name: "restore drill", ok: document.candidate.restore_drill_passed, result: document.candidate.restore_drill_passed ? "passed" : "not passed" },
  { name: "Sheets connector live", ok: document.candidate.sheets_connector.live_journey_passed && !!document.candidate.sheets_connector.resulting_commit,
    result: document.candidate.sheets_connector.live_journey_passed && document.candidate.sheets_connector.resulting_commit
      ? `${document.candidate.sheets_connector.distribution} v${document.candidate.sheets_connector.script_version} → ${document.candidate.sheets_connector.resulting_commit}`
      : "no qualified private-Sheet commit" },
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
