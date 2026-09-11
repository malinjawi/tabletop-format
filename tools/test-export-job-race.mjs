#!/usr/bin/env node
import assert from "node:assert/strict";
import { createOrJoinExportJob } from "../platform/export-job-race.mjs";

let winner = null, arrived = 0, releaseBarrier;
const barrier = new Promise(resolve => { releaseBarrier = resolve; });
const find = async () => winner;
const create = async candidate => {
  arrived += 1;
  if (arrived === 2) releaseBarrier();
  await barrier;
  if (winner) throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  winner = candidate;
};
const load = async id => winner?.id === id ? winner : null;
const candidates = [{ id: "job_a", immutable_key: "same" }, { id: "job_b", immutable_key: "same" }];
const results = await Promise.all(candidates.map(candidate => createOrJoinExportJob({ find, create, load, candidate })));
assert.equal(results.filter(result => result.created).length, 1);
assert.equal(results.filter(result => result.raced).length, 1);
assert(results.every(result => result.job.id === winner.id),
  "the PostgreSQL unique-key loser joins the exact winning job");

const existing = await createOrJoinExportJob({ find, create: () => assert.fail("must not insert"), load,
  candidate: { id: "job_c", immutable_key: "same" } });
assert.equal(existing.raced, false);
assert.equal(existing.created, false);
assert.equal(existing.job.id, winner.id);

const ordinaryFailure = Object.assign(new Error("database unavailable"), { code: "ECONNRESET" });
await assert.rejects(createOrJoinExportJob({ find: async () => null, create: async () => { throw ordinaryFailure; },
  load, candidate: { id: "job_d" } }), error => error === ordinaryFailure,
"non-unique Store-2 failures are never mistaken for a winning export job");

const vanishedWinner = Object.assign(new Error("duplicate key"), { code: "23505" });
await assert.rejects(createOrJoinExportJob({ find: async () => null, create: async () => { throw vanishedWinner; },
  load, candidate: { id: "job_e" } }), error => error === vanishedWinner,
"a unique error without an exact winner remains a database failure");

console.log("EXPORT JOB RACE GREEN — one immutable job wins and every unique-key loser joins it.");
