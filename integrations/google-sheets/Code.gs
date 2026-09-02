/**
 * Forge for Google Sheets — bound Apps Script proof of concept.
 *
 * The Sheet remains the live collaborative document. This script only marks
 * the document dirty, asks Forge for a semantic/visual candidate diff, and
 * commits the exact reviewed snapshot when the editor explicitly requests it.
 */

const FORGE_DOC_KEYS = {
  origin: "FORGE_ORIGIN",
  game: "FORGE_GAME_SLUG",
  source: "FORGE_SOURCE_ID",
  dirty: "FORGE_DIRTY_AT",
  mapping: "FORGE_TAB_MAPPING",
};
const FORGE_TOKEN_KEY = "FORGE_ACCESS_TOKEN";
const FORGE_TOKEN_ORIGIN_KEY = "FORGE_ACCESS_TOKEN_ORIGIN";
const FORGE_HANDLE_KEY = "FORGE_HANDLE";
const FORGE_USER_KEYS = [FORGE_TOKEN_KEY, FORGE_TOKEN_ORIGIN_KEY, FORGE_HANDLE_KEY];

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Forge")
    .addItem("Open candidate panel", "showForgeSidebar")
    .addSeparator()
    .addItem("Mark draft for review", "markForgeDraft")
    .addToUi();
}

function onInstall() {
  onOpen();
}

function onEdit(event) {
  const edited = event && event.range && event.range.getSheet ? event.range.getSheet().getSheetId() : null;
  const mapping = forgeTabMapping_();
  if (edited == null || edited === mapping.cards || edited === mapping.printings) markForgeDraft();
}

function markForgeDraft() {
  PropertiesService.getDocumentProperties().setProperty(FORGE_DOC_KEYS.dirty, new Date().toISOString());
}

function showForgeSidebar() {
  const html = HtmlService.createHtmlOutputFromFile("Sidebar")
    .setTitle("Forge candidate");
  SpreadsheetApp.getUi().showSidebar(html);
}

function forgeSheetIdentity_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const mapping = forgeTabMapping_();
  return `${book.getId()}:cards=${mapping.cards};printings=${mapping.printings || "-"}`;
}

function forgeSheets_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = book.getSheets ? book.getSheets() : [book.getActiveSheet()];
  return sheets.map(sheet => ({ id: sheet.getSheetId(), name: sheet.getName(), sheet }));
}

function forgeTabMapping_() {
  const doc = PropertiesService.getDocumentProperties();
  let saved = {};
  try { saved = JSON.parse(doc.getProperty(FORGE_DOC_KEYS.mapping) || "{}"); } catch (_) {}
  const ids = forgeSheets_().map(entry => entry.id), active = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getSheetId();
  return { cards: ids.indexOf(Number(saved.cards)) >= 0 ? Number(saved.cards) : active,
    printings: ids.indexOf(Number(saved.printings)) >= 0 ? Number(saved.printings) : null };
}

function forgeSheetById_(id) {
  const found = forgeSheets_().find(entry => entry.id === Number(id));
  if (!found) throw new Error(`Mapped Sheet tab ${id} no longer exists. Open Connection and choose it again.`);
  return found.sheet;
}

function forgeCsv_(sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  return values.map(row => row.map(value => {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\n") + "\n";
}

function forgeSettings_() {
  const doc = PropertiesService.getDocumentProperties();
  const user = PropertiesService.getUserProperties();
  const mapping = forgeTabMapping_(), tabs = forgeSheets_().map(entry => ({ id: entry.id, name: entry.name }));
  return {
    origin: doc.getProperty(FORGE_DOC_KEYS.origin) || "",
    game: doc.getProperty(FORGE_DOC_KEYS.game) || "",
    source_id: forgeSheetIdentity_(),
    configured_source_id: doc.getProperty(FORGE_DOC_KEYS.source) || "",
    dirty_at: doc.getProperty(FORGE_DOC_KEYS.dirty) || "",
    has_token: !!user.getProperty(FORGE_TOKEN_KEY),
    user_handle: user.getProperty(FORGE_HANDLE_KEY) || "",
    sheet_name: SpreadsheetApp.getActiveSheet().getName(),
    spreadsheet_name: SpreadsheetApp.getActiveSpreadsheet().getName(),
    tabs,
    tab_mapping: mapping,
  };
}

function getForgeState() {
  return forgeSettings_();
}

/** Cheap sidebar heartbeat. It deliberately does not contact Forge or serialize
 * the card table; the sidebar polls this shared edit marker, then requests one
 * authoritative candidate after the edit burst settles. */
function getForgePulse() {
  const state = forgeSettings_();
  return {
    dirty_at: state.dirty_at,
    source_id: state.source_id,
    configured_source_id: state.configured_source_id,
    has_token: state.has_token,
  };
}

/** Delete only the marker represented by the snapshot we just processed. An
 * onEdit that lands during a Forge request writes a newer marker which must
 * remain dirty and trigger another candidate check. */
function clearForgeDirtyRevision_(revision) {
  const doc = PropertiesService.getDocumentProperties();
  if (revision && doc.getProperty(FORGE_DOC_KEYS.dirty) === revision)
    doc.deleteProperty(FORGE_DOC_KEYS.dirty);
}

function saveForgeSettings(input) {
  input = input || {};
  const origin = String(input.origin || "").trim().replace(/\/+$/, "");
  const game = String(input.game || "").trim();
  const handle = String(input.handle || "").trim();
  const password = String(input.password || "");
  const tabs = forgeSheets_(), tabIds = tabs.map(tab => tab.id);
  const cardsTab = Number(input.cards_tab || SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getSheetId());
  const printingsTab = input.printings_tab === "" || input.printings_tab == null ? null : Number(input.printings_tab);
  const secureOrigin = /^https:\/\//i.test(origin);
  const localDevOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (!secureOrigin && !localDevOrigin) throw new Error("Forge URL must use https:// (loopback http:// is accepted only by the local test harness).");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(game)) throw new Error("Enter the Forge game slug, such as netrunner-sg.");
  if (tabIds.indexOf(cardsTab) < 0) throw new Error("Choose an existing Cards tab.");
  if (printingsTab != null && tabIds.indexOf(printingsTab) < 0) throw new Error("Choose an existing Printings tab.");
  if (printingsTab === cardsTab) throw new Error("Cards and Printings must use different tabs, or leave Printings blank.");
  const user = PropertiesService.getUserProperties();
  const tokenMatchesOrigin = user.getProperty(FORGE_TOKEN_KEY) && user.getProperty(FORGE_TOKEN_ORIGIN_KEY) === origin;
  if (password || !tokenMatchesOrigin) {
    if (!handle || !password) throw new Error("Enter your Forge handle/email and password. The password is sent only to Forge login and is never stored in the Sheet or script properties.");
    const login = forgeLogin_(origin, handle, password);
    user.setProperties({
      [FORGE_TOKEN_KEY]: login.token,
      [FORGE_TOKEN_ORIGIN_KEY]: origin,
      [FORGE_HANDLE_KEY]: login.user && login.user.handle ? login.user.handle : handle,
    });
  }
  const doc = PropertiesService.getDocumentProperties();
  doc.setProperty(FORGE_DOC_KEYS.mapping, JSON.stringify({ cards: cardsTab, printings: printingsTab }));
  doc.setProperties({
    [FORGE_DOC_KEYS.origin]: origin,
    [FORGE_DOC_KEYS.game]: game,
    [FORGE_DOC_KEYS.source]: forgeSheetIdentity_(),
    [FORGE_DOC_KEYS.dirty]: new Date().toISOString(),
  });
  return attachForgeWorkingCopy();
}

function clearForgeCredentials_() {
  const user = PropertiesService.getUserProperties();
  FORGE_USER_KEYS.forEach(key => user.deleteProperty(key));
}

function signOutForge() {
  try { forgeRequest_("/api/auth/logout", "post", {}); } catch (_) {}
  clearForgeCredentials_();
  return forgeSettings_();
}

function forgeLogin_(origin, handle, password) {
  const response = UrlFetchApp.fetch(`${origin}/api/auth/login`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ handle, password, api_token: true }),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  let body;
  try { body = JSON.parse(response.getContentText() || "{}"); }
  catch (_) { body = {}; }
  if (status !== 200 || !body.token) throw new Error(body.error || `Forge login returned HTTP ${status}`);
  return body;
}

function forgeRequest_(path, method, payload) {
  const state = forgeSettings_();
  const token = PropertiesService.getUserProperties().getProperty(FORGE_TOKEN_KEY);
  if (!state.origin || !state.game) throw new Error("Configure this Sheet for a Forge game first.");
  if (!token) throw new Error("Add your personal Forge access token in Settings.");
  const options = {
    method: method || "get",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true,
  };
  if (payload !== undefined) options.payload = JSON.stringify(payload);
  const response = UrlFetchApp.fetch(`${state.origin}${path}`, options);
  const status = response.getResponseCode();
  let body;
  try { body = JSON.parse(response.getContentText() || "{}"); }
  catch (_) { body = { error: response.getContentText() || `Forge returned HTTP ${status}` }; }
  if (status < 200 || status >= 300) {
    if (status === 401) {
      clearForgeCredentials_();
      throw new Error("Your Forge sign-in expired. Open Connection and sign in again.");
    }
    const error = new Error(body.error || `Forge returned HTTP ${status}`);
    error.forge = body;
    throw error;
  }
  return body;
}

function forgeSnapshot_() {
  const book = SpreadsheetApp.getActiveSpreadsheet(), mapping = forgeTabMapping_();
  const cards = forgeSheetById_(mapping.cards), tables = {
    cards: { source_id: `${book.getId()}:${mapping.cards}`, snapshot_csv: forgeCsv_(cards) },
  };
  if (mapping.printings) {
    const printings = forgeSheetById_(mapping.printings);
    tables.printings = { source_id: `${book.getId()}:${mapping.printings}`, snapshot_csv: forgeCsv_(printings) };
  }
  return {
    source_id: forgeSheetIdentity_(),
    source_revision: PropertiesService.getDocumentProperties().getProperty(FORGE_DOC_KEYS.dirty) || new Date().toISOString(),
    tables,
  };
}

function attachForgeWorkingCopy() {
  const state = forgeSettings_();
  const snapshot = forgeSnapshot_();
  const result = forgeRequest_(`/api/games/${encodeURIComponent(state.game)}/sync/sheet`, "put", snapshot);
  if (result.connected) clearForgeDirtyRevision_(snapshot.source_revision);
  const nextState = forgeSettings_();
  return { state: nextState, result,
    stale_local: !!nextState.dirty_at && nextState.dirty_at !== snapshot.source_revision };
}

function checkForgeCandidate() {
  const state = forgeSettings_();
  if (state.configured_source_id && state.configured_source_id !== state.source_id)
    throw new Error("This Forge connection belongs to another tab. Open that tab or configure this one separately.");
  const snapshot = forgeSnapshot_();
  const result = forgeRequest_(`/api/games/${encodeURIComponent(state.game)}/sync/pull?dry=1`, "post", snapshot);
  if (result.status === "clean") clearForgeDirtyRevision_(snapshot.source_revision);
  const nextState = forgeSettings_();
  return { state: nextState, result,
    stale_local: !!nextState.dirty_at && nextState.dirty_at !== snapshot.source_revision };
}

function commitForgeCandidate(input) {
  input = input || {};
  const message = String(input.commit_message || "").trim();
  if (!message) throw new Error("Write a short commit message describing the intent of this candidate.");
  if (!input.preview || !input.preview.source_hash || !input.preview.head_sha)
    throw new Error("Check the candidate again before committing it.");
  const contributors = String(input.contributors || "").split(",").map(v => v.trim()).filter(Boolean);
  const state = forgeSettings_();
  const snapshot = forgeSnapshot_();
  const payload = Object.assign(snapshot, {
    preview: input.preview,
    commit_message: message,
    contributors,
  });
  const result = forgeRequest_(`/api/games/${encodeURIComponent(state.game)}/sync/pull`, "post", payload);
  if (result.saved) clearForgeDirtyRevision_(snapshot.source_revision);
  const nextState = forgeSettings_();
  return { state: nextState, result,
    stale_local: !!nextState.dirty_at && nextState.dirty_at !== snapshot.source_revision };
}

function detachForgeWorkingCopy() {
  const state = forgeSettings_();
  const result = forgeRequest_(`/api/games/${encodeURIComponent(state.game)}/sync/sheet`, "delete");
  const doc = PropertiesService.getDocumentProperties();
  Object.keys(FORGE_DOC_KEYS).forEach(name => doc.deleteProperty(FORGE_DOC_KEYS[name]));
  return { state: forgeSettings_(), result };
}
