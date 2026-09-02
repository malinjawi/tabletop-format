#!/usr/bin/env node
/**
 * Execute the real integrations/google-sheets/Code.gs against a disposable
 * Forge server while providing small mocks for the Google Apps Script host.
 * This catches drift between the sidebar client and Forge API without needing
 * to publish an add-on or touch a real Google account.
 *
 * Usage: node tools/sheets-addon-check.mjs http://127.0.0.1:8420
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const origin = String(process.argv[2] || "").replace(/\/+$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin)) {
  console.error("pass a disposable loopback Forge origin, e.g. http://127.0.0.1:8420");
  process.exit(2);
}

let checks = 0;
const ok = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${String(++checks).padStart(2, "0")}  ${message}`);
};

const sidebar = readFileSync(join(ROOT, "integrations/google-sheets/Sidebar.html"), "utf8");
ok(sidebar.includes('id="settings-back"') && sidebar.includes("← Back to candidate") &&
  sidebar.includes('onclick="hideSettings()"'), "connection settings always provide a return to the candidate");
ok(sidebar.includes("getForgePulse()") && sidebar.includes("POLL_MS=2000") &&
  sidebar.includes("scheduleCandidateCheck") && sidebar.includes("diffValue(c.from)"),
  "sidebar polls the cheap edit marker and renders field-level live diffs");
ok(sidebar.includes('id="cards-tab"') && sidebar.includes('id="printings-tab"'),
  "connection maps Cards and optional Printings tabs explicitly");

const api = async (path, options = {}) => {
  const response = await fetch(origin + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path}: ${response.status} ${body.error || ""}`);
  return body;
};

const password = "addon-test-password";
const account = await api("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ handle: "addon-tester", email: "addon-tester@example.test", password }) });
const initialCsv = "id,name,type,text,cost\nseed,Seed,unit,Grow.,1\n";
const game = await api("/api/games", { method: "POST",
  headers: { Authorization: `Bearer ${account.token}`, "content-type": "application/json" },
  body: JSON.stringify({ title: "Sheets Addon Harness", csv: initialCsv }) });
ok(game.slug === "sheets-addon-harness", "disposable Forge game created");

const docValues = new Map();
const userValues = new Map();
const propertyStore = (map) => ({
  getProperty: (key) => map.has(key) ? map.get(key) : null,
  setProperty: (key, value) => { map.set(key, String(value)); },
  setProperties: (values) => { for (const [key, value] of Object.entries(values)) map.set(key, String(value)); },
  deleteProperty: (key) => { map.delete(key); },
  deleteAllProperties: () => { map.clear(); },
});

let sheetId = 73;
let sheetRows = [
  ["id", "name", "type", "text", "cost"],
  ["seed", "Seed", "unit", "Grow.", "1"],
];
let printingRows = [
  ["id", "card_id", "set_id", "collector_number", "quantity", "template_id"],
  ["p_seed_core", "seed", "core", "001", "1", "standard_face"],
];
const cardsSheet = {
  getSheetId: () => 73,
  getName: () => "Cards",
  getDataRange: () => ({ getDisplayValues: () => sheetRows.map(row => [...row]) }),
};
const printingsSheet = {
  getSheetId: () => 74,
  getName: () => "Printings",
  getDataRange: () => ({ getDisplayValues: () => printingRows.map(row => [...row]) }),
};
const notesSheet = { getSheetId: () => 99, getName: () => "Notes",
  getDataRange: () => ({ getDisplayValues: () => [["notes"], ["not game data"]] }) };
const allSheets = [cardsSheet, printingsSheet, notesSheet];
const spreadsheet = {
  getId: () => "spreadsheet-addon-e2e",
  getName: () => "Forge Add-on Test",
  getActiveSheet: () => allSheets.find(sheet => sheet.getSheetId() === sheetId),
  getSheets: () => allSheets,
};

const urlFetch = (url, options = {}) => {
  const args = ["--silent", "--show-error", "--request", String(options.method || "get").toUpperCase()];
  for (const [name, value] of Object.entries(options.headers || {})) args.push("--header", `${name}: ${value}`);
  if (options.contentType) args.push("--header", `content-type: ${options.contentType}`);
  if (options.payload !== undefined) args.push("--data-binary", String(options.payload));
  args.push("--write-out", "\n%{http_code}", url);
  const result = spawnSync("curl", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `curl exited ${result.status}`);
  const cut = result.stdout.lastIndexOf("\n");
  const text = result.stdout.slice(0, cut);
  const status = Number(result.stdout.slice(cut + 1));
  return { getResponseCode: () => status, getContentText: () => text };
};

const context = vm.createContext({
  console,
  Date,
  JSON,
  Object,
  Array,
  String,
  RegExp,
  Error,
  encodeURIComponent,
  PropertiesService: {
    getDocumentProperties: () => propertyStore(docValues),
    getUserProperties: () => propertyStore(userValues),
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => spreadsheet,
    getActiveSheet: () => spreadsheet.getActiveSheet(),
  },
  UrlFetchApp: { fetch: urlFetch },
});
vm.runInContext(readFileSync(join(ROOT, "integrations/google-sheets/Code.gs"), "utf8"), context,
  { filename: "integrations/google-sheets/Code.gs" });

const attached = context.saveForgeSettings({ origin, game: game.slug, handle: "addon-tester", password });
ok(attached.result.connected && attached.result.source_mode === "addon", "real Code.gs signs in and attaches the active private tab");
ok(![...docValues.values(), ...userValues.values()].includes(password), "Forge password is never stored in document or user properties");
ok(userValues.has("FORGE_ACCESS_TOKEN") && !docValues.has("FORGE_ACCESS_TOKEN"), "session token is user-private, not shared in the Sheet");
ok(!docValues.has("FORGE_DIRTY_AT"), "establishing the working-copy baseline clears the dirty hint");

const firstToken = userValues.get("FORGE_ACCESS_TOKEN");
const reattached = context.saveForgeSettings({ origin, game: game.slug, handle: "addon-tester", password: "" });
ok(reattached.result.connected && userValues.get("FORGE_ACCESS_TOKEN") === firstToken,
  "connection settings can be saved again without resending a password when the personal session is valid");

const clean = context.checkForgeCandidate();
ok(clean.result.status === "clean" && clean.result.validation.ok, "unchanged Sheet is clean and valid");

const mapped = context.saveForgeSettings({ origin, game: game.slug, handle: "addon-tester", password: "",
  cards_tab: 73, printings_tab: 74 });
ok(mapped.result.tables.includes("cards") && mapped.result.tables.includes("printings") && mapped.result.printings === 1,
  "the same connector attaches explicit Cards + Printings working-copy tables");

sheetRows = [
  ["id", "name", "type", "text", "cost"],
  ["seed", "Seed", "unit", "Grow twice.", "1"],
  ["bloom", "Bloom", "unit", "Flower.", "2"],
];
printingRows = [
  ["id", "card_id", "set_id", "collector_number", "quantity", "template_id"],
  ["p_seed_core", "seed", "core", "001", "2", "standard_face"],
  ["p_bloom_core", "bloom", "core", "002", "1", "standard_face"],
];
context.onEdit();
ok(docValues.has("FORGE_DIRTY_AT"), "onEdit marks the shared working copy possibly dirty");
const markedRevision = docValues.get("FORGE_DIRTY_AT");
const pulse = context.getForgePulse();
ok(pulse.dirty_at === markedRevision && pulse.source_id === pulse.configured_source_id,
  "live-diff heartbeat exposes the shared edit marker without contacting Forge");
docValues.set("FORGE_DIRTY_AT", "newer-edit-during-request");
context.clearForgeDirtyRevision_(markedRevision);
ok(docValues.get("FORGE_DIRTY_AT") === "newer-edit-during-request",
  "an older candidate response cannot erase a newer Sheet edit marker");
context.onEdit();
const candidate = context.checkForgeCandidate();
ok(candidate.result.status === "changes" && candidate.result.can_commit && candidate.result.counts.cards === 2 &&
  candidate.result.counts.printings === 2 && candidate.result.candidate_cards.length === 2,
  "authoritative check merges Cards + Printings changes with validation and visual-preview data");

const committed = context.commitForgeCandidate({ preview: candidate.result.preview,
  commit_message: "Try the Bloom package", contributors: "sheet-coworker" });
ok(committed.result.saved && committed.result.commit && !docValues.has("FORGE_DIRTY_AT"), "exact reviewed candidate commits and clears the dirty hint");
ok(committed.result.adapter?.version === 2 && committed.result.import_receipt === "forge/imports/google-sheets.json",
  "promotion identifies the versioned connector contract and committed receipt");
const cards = await api(`/api/games/${game.slug}/cards`);
ok(cards.length === 2 && cards.find(card => card.id === "seed")?.text === "Grow twice." && cards.some(card => card.id === "bloom"),
  "committed Forge game contains the edited and added Sheet cards");
const printings = await api(`/api/games/${game.slug}/printings`);
ok(printings.length === 2 && printings.find(printing => printing.id === "p_seed_core")?.quantity === 2,
  "the exact reviewed Printings tab enters the same atomic Forge commit");
const receipt = await api(`/api/games/${game.slug}/repository/file/forge/imports/google-sheets.json`);
ok(receipt.format === "forge-import-receipt" && receipt.source.sha256 === committed.result.preview.source_hash &&
  receipt.source.tables.cards && receipt.source.tables.printings,
  "Git preserves the exact multi-table source fingerprint and mapping as an import receipt");
const history = await api(`/api/games/${game.slug}/history`);
ok(history.some(entry => entry.author === "addon-tester" && entry.subject === "Try the Bloom package"),
  "Forge history credits the authenticated submitter and preserves intent");

sheetId = 99;
const beforeUnrelated = docValues.get("FORGE_DIRTY_AT") || "";
context.onEdit({ range: { getSheet: () => notesSheet } });
ok((docValues.get("FORGE_DIRTY_AT") || "") === beforeUnrelated && context.checkForgeCandidate().result.status === "clean",
  "unmapped notes/calculation tabs neither dirty nor replace the mapped game tables");

sheetId = 73;
userValues.set("FORGE_ACCESS_TOKEN", "expired-test-token");
let rejectedExpiredSession = false;
try { context.checkForgeCandidate(); } catch (error) { rejectedExpiredSession = /sign-in expired/i.test(error.message); }
ok(rejectedExpiredSession && !userValues.has("FORGE_ACCESS_TOKEN") && !userValues.has("FORGE_HANDLE"),
  "an expired Forge session is cleared and asks the editor to sign in again");

context.saveForgeSettings({ origin, game: game.slug, handle: "addon-tester", password });
docValues.set("UNRELATED_SCRIPT_SETTING", "preserve-me");
const detached = context.detachForgeWorkingCopy();
ok(detached.result.connected === false && !docValues.has("FORGE_ORIGIN") && !docValues.has("FORGE_GAME_SLUG") &&
  docValues.get("UNRELATED_SCRIPT_SETTING") === "preserve-me", "detach removes only Forge connection properties");
const signedOut = context.signOutForge();
ok(!signedOut.has_token && !userValues.has("FORGE_ACCESS_TOKEN") && !userValues.has("FORGE_HANDLE"),
  "sign out removes the editor's personal Forge credentials");

console.log(`\nADD-ON GREEN — ${checks} checks executed through the real Code.gs connector.`);
