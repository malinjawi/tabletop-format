#!/usr/bin/env node
/**
 * Issue and manage controlled-beta registration invitations.
 *
 * Local:
 *   node tools/pilot-invite.mjs create --db data/platform.db --label "Amina" --cohort beta-01
 * Production (inside the gateway container, which already has DB credentials):
 *   node tools/pilot-invite.mjs create --label "Amina" --cohort beta-01
 *   node tools/pilot-invite.mjs list
 *   node tools/pilot-invite.mjs revoke inv_...
 *
 * The raw bearer token is shown exactly once. The database stores only its
 * SHA-256 digest; list output never exposes the token or digest.
 */
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0];
const option = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const fail = message => { console.error(`pilot-invite: ${message}`); process.exit(2); };
if (!new Set(["create", "list", "revoke"]).has(command))
  fail("use create, list, or revoke");

const pgUrl = option("--pg-url", process.env.PG_URL || null);
const dbPath = option("--db", process.env.DB_PATH || null);
const postgres = !!pgUrl || process.env.DB === "postgres";
if (postgres && dbPath) fail("choose PostgreSQL or --db, not both");
if (pgUrl) process.env.PG_URL = pgUrl;
if (dbPath) process.env.DB_PATH = resolve(dbPath);

const { openDb, q, newId } = postgres
  ? await import("../platform/db-pg.mjs")
  : await import("../platform/db.mjs");
const db = await openDb(postgres ? pgUrl || undefined : dbPath ? resolve(dbPath) : undefined);

const close = async () => {
  if (typeof db.end === "function") await db.end();
  else if (typeof db.close === "function") db.close();
};
const iso = value => value == null ? "—" : new Date(Number(value)).toISOString();

try {
  if (command === "create") {
    const label = String(option("--label", "") || "").trim() || null;
    const cohort = String(option("--cohort", "") || "").trim() || null;
    const hours = Number(option("--hours", "168"));
    const count = Number(option("--count", "1"));
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30)
      fail("--hours must be between 1 and 720");
    if (!Number.isInteger(count) || count < 1 || count > 50)
      fail("--count must be an integer between 1 and 50");
    if (label && label.length > 120) fail("--label must be 120 characters or fewer");
    if (cohort && cohort.length > 80) fail("--cohort must be 80 characters or fewer");
    if (/[\u0000-\u001f\u007f]/.test(label || "") || /[\u0000-\u001f\u007f]/.test(cohort || ""))
      fail("--label and --cohort cannot contain control characters");

    console.log("Sensitive: each token below is a single-use bearer secret. It cannot be recovered later.");
    for (let index = 0; index < count; index += 1) {
      const token = `fpi_${randomBytes(24).toString("base64url")}`;
      const now = Date.now(), id = newId("inv");
      await q.createPilotInvite(db, { id,
        token_hash: createHash("sha256").update(token).digest("hex"),
        label: count === 1 ? label : label ? `${label} ${index + 1}` : null,
        cohort_id: cohort, created_at: now, expires_at: now + hours * 3600 * 1000 });
      console.log(`${id}\t${token}\texpires ${iso(now + hours * 3600 * 1000)}`);
    }
  } else if (command === "list") {
    const rows = await q.pilotInvites(db);
    if (!rows.length) console.log("No pilot invitations.");
    else {
      console.log("id\tstatus\texpires\tcohort\tlabel\tredeemed by");
      for (const row of rows) console.log([
        row.id, row.status, iso(row.expires_at), row.cohort_id || "—",
        row.label || "—", row.redeemed_handle || "—",
      ].join("\t"));
    }
  } else {
    const id = String(args[1] || "").trim();
    if (!/^inv_[a-f0-9]{16}$/.test(id)) fail("revoke requires an exact invitation id (inv_…)");
    const result = await q.revokePilotInvite(db, id);
    const changed = Number(result?.changes ?? result?.rowCount ?? 0);
    if (changed !== 1) fail("invitation was not found, or is already redeemed/revoked");
    console.log(`Revoked ${id}.`);
  }
} finally {
  await close();
}
