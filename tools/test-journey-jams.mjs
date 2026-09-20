import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createJourneyJams } from "./journey-jams.mjs";
import yaml from "js-yaml";

const source = resolve(import.meta.dirname, "../jams"), scratch = mkdtempSync(join(tmpdir(), "forge-jam-fixtures-"));
const original = readFileSync(join(source, "spark-jam.yaml"));
try {
  for (const date of ["2026-09-20T23:59:59Z", "2035-01-01T00:00:00Z"]) {
    const at = Date.parse(date), destination = join(scratch, String(at));
    const previousMask = process.umask(0o077);
    let jam;
    try { jam = createJourneyJams(destination, at); }
    finally { process.umask(previousMask); }
    assert.equal(statSync(destination).mode & 0o777, 0o755);
    assert.equal(statSync(join(destination, "spark-jam.yaml")).mode & 0o777, 0o644);
    assert.equal(statSync(join(destination, "spark-jam-starter.csv")).mode & 0o777, 0o644);
    assert.ok(Date.parse(jam.starts_at) < at);
    assert.ok(Date.parse(jam.submissions_close_at) > at + 86_400_000);
    assert.ok(Date.parse(jam.judging_ends_at) > Date.parse(jam.submissions_close_at));
    assert.ok(Date.parse(jam.results_at) > Date.parse(jam.judging_ends_at));
    assert.deepEqual(jam.constraints, yaml.load(original.toString()).constraints);
    assert.deepEqual(readFileSync(join(destination, "spark-jam-starter.csv")), readFileSync(join(source, "spark-jam-starter.csv")));
    assert.throws(() => createJourneyJams(destination, at), /must be new/);
  }
  assert.deepEqual(readFileSync(join(source, "spark-jam.yaml")), original, "actual event content never changes");
  assert.throws(() => createJourneyJams(join(scratch, "invalid"), NaN), /finite/);
  console.log("JOURNEY JAM FIXTURES GREEN — isolated current windows, preserved constraints/content, no clock override.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
