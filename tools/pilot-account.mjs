#!/usr/bin/env node
/** Operator-assisted account recovery for a small controlled beta. */
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

const args = process.argv.slice(2), command = args[0];
const option = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const fail = message => { console.error(`pilot-account: ${message}`); process.exit(2); };
if (!new Set(["reset", "resets", "revoke"]).has(command)) {
  console.error("pilot-account: use reset --handle HANDLE, resets, or revoke rst_…");
  process.exit(2);
}

const pgUrl = option("--pg-url", process.env.PG_URL || null);
const dbPath = option("--db", process.env.DB_PATH || null);
const postgres = !!pgUrl || process.env.DB === "postgres";
if (postgres && dbPath) fail("choose PostgreSQL or --db, not both");
if (pgUrl) process.env.PG_URL = pgUrl;
if (dbPath) process.env.DB_PATH = resolve(dbPath);
const { openDb, q, newId } = postgres
  ? await import("../platform/db-pg.mjs") : await import("../platform/db.mjs");
const db = await openDb(postgres ? pgUrl || undefined : dbPath ? resolve(dbPath) : undefined);
const close = async () => {
  if (typeof db.end === "function") await db.end();
  else if (typeof db.close === "function") db.close();
};
const iso = value => value == null ? "—" : new Date(Number(value)).toISOString();

try {
  if (command === "reset") {
    const handle = String(option("--handle", "") || "").trim();
    const hours = Number(option("--hours", "1"));
    if (!handle) fail("reset requires --handle");
    if (!Number.isFinite(hours) || hours < 0.25 || hours > 24)
      fail("--hours must be between 0.25 and 24");
    const user = await q.userByHandle(db, handle);
    if (!user) fail("account not found");
    const token = `fpr_${randomBytes(24).toString("base64url")}`;
    const now = Date.now(), id = newId("rst");
    await q.issuePasswordReset(db, { id, user_id: user.id,
      token_hash: createHash("sha256").update(token).digest("hex"),
      created_at: now, expires_at: now + hours * 3600 * 1000 }, now);
    console.log("Sensitive: this one-use recovery token cannot be recovered later; a newer token revokes it.");
    console.log(`${id}\t${token}\t${handle}\texpires ${iso(now + hours * 3600 * 1000)}`);
  } else if (command === "resets") {
    const rows = await q.passwordResets(db);
    if (!rows.length) console.log("No password reset records.");
    else {
      console.log("id\tstatus\texpires\thandle");
      for (const row of rows) console.log([row.id, row.status, iso(row.expires_at), row.handle].join("\t"));
    }
  } else {
    const id = String(args[1] || "").trim();
    if (!/^rst_[a-f0-9]{16}$/.test(id)) fail("revoke requires an exact reset id (rst_…)");
    const result = await q.revokePasswordReset(db, id);
    const changed = Number(result?.changes ?? result?.rowCount ?? 0);
    if (changed !== 1) fail("reset was not found, or is already redeemed/revoked");
    console.log(`Revoked ${id}.`);
  }
} finally {
  await close();
}
