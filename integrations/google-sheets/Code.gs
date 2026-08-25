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

function onEdit() {
  markForgeDraft();
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
  const tab = book.getActiveSheet();
  return `${book.getId()}:${tab.getSheetId()}`;
}

function forgeCsv_() {
  const values = SpreadsheetApp.getActiveSheet().getDataRange().getDisplayValues();
  return values.map(row => row.map(value => {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\n") + "\n";
}

function forgeSettings_() {
  const doc = PropertiesService.getDocumentProperties();
  const user = PropertiesService.getUserProperties();
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
  };
}

function getForgeState() {
  return forgeSettings_();
}

function saveForgeSettings(input) {
  input = input || {};
  const origin = String(input.origin || "").trim().replace(/\/+$/, "");
  const game = String(input.game || "").trim();
  const handle = String(input.handle || "").trim();
  const password = String(input.password || "");
  const secureOrigin = /^https:\/\//i.test(origin);
  const localDevOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (!secureOrigin && !localDevOrigin) throw new Error("Forge URL must use https:// (loopback http:// is accepted only by the local test harness).");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(game)) throw new Error("Enter the Forge game slug, such as netrunner-sg.");
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
  clearForgeCredentials_();
  return forgeSettings_();
}

function forgeLogin_(origin, handle, password) {
  const response = UrlFetchApp.fetch(`${origin}/api/auth/login`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ handle, password }),
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
  return {
    source_id: forgeSheetIdentity_(),
    source_revision: PropertiesService.getDocumentProperties().getProperty(FORGE_DOC_KEYS.dirty) || new Date().toISOString(),
    snapshot_csv: forgeCsv_(),
  };
}

function attachForgeWorkingCopy() {
  const state = forgeSettings_();
  const result = forgeRequest_(`/api/games/${encodeURIComponent(state.game)}/sync/sheet`, "put", forgeSnapshot_());
  if (result.connected) PropertiesService.getDocumentProperties().deleteProperty(FORGE_DOC_KEYS.dirty);
  return { state: forgeSettings_(), result };
}

function checkForgeCandidate() {
  const state = forgeSettings_();
  if (state.configured_source_id && state.configured_source_id !== state.source_id)
    throw new Error("This Forge connection belongs to another tab. Open that tab or configure this one separately.");
  const result = forgeRequest_(`/api/games/${encodeURIComponent(state.game)}/sync/pull?dry=1`, "post", forgeSnapshot_());
  if (result.status === "clean") PropertiesService.getDocumentProperties().deleteProperty(FORGE_DOC_KEYS.dirty);
  return { state: forgeSettings_(), result };
}

function commitForgeCandidate(input) {
  input = input || {};
  const message = String(input.commit_message || "").trim();
  if (!message) throw new Error("Write a short commit message describing the intent of this candidate.");
  if (!input.preview || !input.preview.source_hash || !input.preview.head_sha)
    throw new Error("Check the candidate again before committing it.");
  const contributors = String(input.contributors || "").split(",").map(v => v.trim()).filter(Boolean);
  const state = forgeSettings_();
  const payload = Object.assign(forgeSnapshot_(), {
    preview: input.preview,
    commit_message: message,
    contributors,
  });
  const result = forgeRequest_(`/api/games/${encodeURIComponent(state.game)}/sync/pull`, "post", payload);
  if (result.saved) PropertiesService.getDocumentProperties().deleteProperty(FORGE_DOC_KEYS.dirty);
  return { state: forgeSettings_(), result };
}

function detachForgeWorkingCopy() {
  const state = forgeSettings_();
  const result = forgeRequest_(`/api/games/${encodeURIComponent(state.game)}/sync/sheet`, "delete");
  const doc = PropertiesService.getDocumentProperties();
  Object.keys(FORGE_DOC_KEYS).forEach(name => doc.deleteProperty(FORGE_DOC_KEYS[name]));
  return { state: forgeSettings_(), result };
}
