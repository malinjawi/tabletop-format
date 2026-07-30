#!/usr/bin/env node
/**
 * import-playtest.mjs — ingest a play-session's results into a game (v0.1).
 * ZERO dependencies.
 *
 * Usage: node tools/import-playtest.mjs <game-dir> <session.json> [--ref SHA] [--date YYYY-MM-DD]
 *
 * INTEROP / the "test" pillar: external playtest tools, TTS/Screentop tables,
 * and spreadsheets all produce loose result data. This normalizes ANY such
 * JSON into a schema-valid playtests/*.json, whitelisting fields and — the
 * whole point — PINNING it to the exact game version on the table (version_ref:
 * --ref, or the session's own, or the game repo's current HEAD). Feedback can
 * never drift off the version it was about. tools/stats.py then aggregates it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const gameDir = args[0], sessionPath = args[1];
if (!sessionPath) { console.error("Usage: node tools/import-playtest.mjs <game-dir> <session.json> [--ref SHA] [--date YYYY-MM-DD]"); process.exit(2); }
const opt = (n) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : null; };

const RESULTS = new Set(["win", "loss", "draw"]);
const TAGS = new Set(["balance", "confusing", "fun", "bug", "art", "timing"]);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined && o[k] !== null && o[k] !== "").map(k => [k, o[k]]));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const today = () => new Date().toISOString().slice(0, 10);

const raw = JSON.parse(readFileSync(sessionPath, "utf8"));
const warn = [];

// version_ref: the pin. explicit flag → session's own → game repo HEAD → unknown.
let ref = opt("--ref") || raw.version_ref;
if (!ref) { try { ref = execFileSync("git", ["-C", gameDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* not a repo */ } }
if (!ref) { ref = "unknown"; warn.push("no version_ref — pass --ref <sha> to pin feedback to the tested version"); }

const date = opt("--date") || raw.date || today();
let id = raw.id ? slug(raw.id) : `${date}-${slug(raw.location || "session")}`;
if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) id = `${date}-session`;

const players = (Array.isArray(raw.players) ? raw.players : []).map(p => {
  const q = pick(p, ["name", "deck_id", "result", "score", "first_game"]);
  if (q.result) { q.result = String(q.result).toLowerCase(); if (!RESULTS.has(q.result)) { warn.push(`player '${q.name}': dropped invalid result '${q.result}'`); delete q.result; } }
  return q;
}).filter(p => p.name);
if (!players.length) { console.error("A session needs at least one named player (schema: players minItems 1)."); process.exit(1); }

const cardNotes = (Array.isArray(raw.card_notes) ? raw.card_notes : []).map(c => {
  const q = pick(c, ["card_id", "tag", "note", "suggestion"]);
  if (q.tag) q.tag = String(q.tag).toLowerCase();
  return q;
}).filter(c => { const ok = c.card_id && c.note && TAGS.has(c.tag); if (!ok) warn.push(`dropped card_note (needs card_id + note + valid tag ${[...TAGS].join("/")})`); return ok; });

const decisions = (Array.isArray(raw.decisions) ? raw.decisions : [])
  .map(d => pick(d, ["action", "card_id", "rationale"])).filter(d => d.action);

const session = {
  id, date, version_ref: ref,
  ...pick(raw, ["format_id", "location"]),
  ...(raw.duration_minutes ? { duration_minutes: parseInt(raw.duration_minutes, 10) } : {}),
  players,
  ...(raw.notes ? { notes: raw.notes } : {}),
  ...(cardNotes.length ? { card_notes: cardNotes } : {}),
  ...(decisions.length ? { decisions } : {}),
};

const ptDir = join(gameDir, "playtests");
if (!existsSync(ptDir)) mkdirSync(ptDir, { recursive: true });
const out = join(ptDir, `${id}.json`);
writeFileSync(out, JSON.stringify(session, null, 2) + "\n");
console.log(`Ingested playtest '${id}' → ${out}`);
console.log(`  version pinned: ${ref}  ·  ${players.length} player(s), ${cardNotes.length} card note(s), ${decisions.length} decision(s)`);
for (const w of warn) console.warn(`  warn  ${w}`);
