#!/usr/bin/env node
/** Operator-assisted account recovery and access control for a controlled beta. */
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

const args = process.argv.slice(2), command = args[0];
const option = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : fallback;
};
const fail = message => { throw new Error(message); };
const iso = value => value == null ? "—" : new Date(Number(value)).toISOString();

async function main() {
  if (!new Set(["reset", "resets", "revoke", "suspend", "restore", "status"]).has(command))
    fail("use reset --handle HANDLE, resets, revoke rst_…, suspend --handle HANDLE --reason TEXT, restore --handle HANDLE --reason TEXT, or status --handle HANDLE");
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
  try {
  if (command === "reset") {
    const handle = String(option("--handle", "") || "").trim();
    const hours = Number(option("--hours", "1"));
    if (!handle) fail("reset requires --handle");
    if (!Number.isFinite(hours) || hours < 0.25 || hours > 24)
      fail("--hours must be between 0.25 and 24");
    const user = await q.userByHandle(db, handle);
    if (!user) fail("account not found");
    if (user.suspended_at != null) fail("account is suspended; restore access before issuing recovery");
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
  } else if (command === "revoke") {
    const id = String(args[1] || "").trim();
    if (!/^rst_[a-f0-9]{16}$/.test(id)) fail("revoke requires an exact reset id (rst_…)");
    const result = await q.revokePasswordReset(db, id);
    const changed = Number(result?.changes ?? result?.rowCount ?? 0);
    if (changed !== 1) fail("reset was not found, or is already redeemed/revoked");
    console.log(`Revoked ${id}.`);
  } else if (command === "status") {
    const handle = String(option("--handle", "") || "").trim();
    if (!handle) fail("status requires --handle");
    const account = await q.accountAccessByHandle(db, handle);
    if (!account) fail("account not found");
    console.log("handle\tstatus\tsince\treason");
    console.log([account.handle, account.status, iso(account.suspended_at), account.suspension_reason || "—"].join("\t"));
    const events = await q.accountAccessEvents(db, account.id);
    if (events.length) {
      console.log("\nevent\taction\tat\toperator\treason");
      for (const event of events)
        console.log([event.id, event.action, iso(event.created_at), event.operator_name, event.reason].join("\t"));
    }
  } else {
    const handle = String(option("--handle", "") || "").trim();
    const reason = String(option("--reason", "") || "").trim();
    const operator = String(option("--operator", process.env.FORGE_OPERATOR_NAME || "") || "").trim();
    if (!handle) fail(`${command} requires --handle`);
    if (reason.length < 3 || reason.length > 240 || /[\r\n\t]/.test(reason))
      fail("--reason must be one line of 3-240 characters; do not include sensitive personal data");
    if (operator.length < 2 || operator.length > 120 || /[\r\n\t]/.test(operator))
      fail("declare a one-line --operator or FORGE_OPERATOR_NAME (2-120 characters)");
    const account = await q.accountAccessByHandle(db, handle);
    if (!account) fail("account not found");
    const suspended = command === "suspend";
    await q.setAccountSuspended(db, { id: newId("aae"), user_id: account.id,
      suspended, operator_name: operator, reason });
    if (suspended)
      console.log(`Suspended ${handle}; every session and outstanding recovery token was revoked. Authored work was preserved.`);
    else console.log(`Restored ${handle}; no session or password was created.`);
  }
  } finally {
    await close();
  }
}

try { await main(); }
catch (error) { console.error(`pilot-account: ${error.message}`); process.exitCode = 2; }
