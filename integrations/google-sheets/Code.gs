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
const FORGE_PENDING_CONNECTION_KEY = "FORGE_PENDING_CONNECTION";
// The packaging tool replaces this empty value in an operator-owned beta
// bundle. Keeping it blank preserves the developer/bound-script workflow.
const FORGE_DEPLOYMENT_ORIGIN = "";
const FORGE_USER_KEYS = [FORGE_TOKEN_KEY, FORGE_TOKEN_ORIGIN_KEY, FORGE_HANDLE_KEY, FORGE_PENDING_CONNECTION_KEY];

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
  let pendingConnection = null;
  try { pendingConnection = JSON.parse(user.getProperty(FORGE_PENDING_CONNECTION_KEY) || "null"); } catch (_) {}
  return {
    origin: doc.getProperty(FORGE_DOC_KEYS.origin) || "",
    game: doc.getProperty(FORGE_DOC_KEYS.game) || "",
    source_id: forgeSheetIdentity_(),
    configured_source_id: doc.getProperty(FORGE_DOC_KEYS.source) || "",
    dirty_at: doc.getProperty(FORGE_DOC_KEYS.dirty) || "",
    has_token: !!user.getProperty(FORGE_TOKEN_KEY),
    user_handle: user.getProperty(FORGE_HANDLE_KEY) || "",
    default_origin: FORGE_DEPLOYMENT_ORIGIN,
    origin_locked: !!FORGE_DEPLOYMENT_ORIGIN,
    sheet_name: SpreadsheetApp.getActiveSheet().getName(),
    spreadsheet_name: SpreadsheetApp.getActiveSpreadsheet().getName(),
    tabs,
    tab_mapping: mapping,
    pending_connection: pendingConnection,
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

function forgeAllowsLoopbackForTests_() {
  return typeof FORGE_TEST_ALLOW_LOOPBACK !== "undefined" && FORGE_TEST_ALLOW_LOOPBACK === true;
}

function forgeOrigin_(value) {
  const origin = String(value || "").trim().replace(/\/+$/, "");
  const secure = /^https:\/\/[^/]+/i.test(origin);
  const loopback = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (loopback && !forgeAllowsLoopbackForTests_())
    throw new Error("Google Sheets runs this connector on Google's servers, so it cannot reach localhost. Use a stable public HTTPS Forge URL. For local development, import a published Sheet or CSV from Forge instead.");
  if (!secure && !(loopback && forgeAllowsLoopbackForTests_()))
    throw new Error("Forge URL must be a public https:// address that Google Sheets can reach.");
  return origin;
}

function forgeGameSlug_(value) {
  const game = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(game))
    throw new Error("Enter the Forge game slug, such as netrunner-sg.");
  return game;
}

function forgeNetworkError_(origin, error) {
  const detail = String(error && error.message ? error.message : error || "Network request failed");
  if (/dns|resolve|host not found|address unavailable|timed?\s*out|connection refused|network|fetch failed/i.test(detail))
    return new Error(`Forge could not be reached from Google at ${origin}. Apps Script runs on Google's servers: localhost, private-network addresses, and expired tunnel URLs will not work. Use a stable public HTTPS Forge URL, then try again.`);
  return new Error(`Forge could not be reached at ${origin}. ${detail}`);
}

function forgeFetch_(origin, path, options) {
  try { return UrlFetchApp.fetch(`${origin}${path}`, Object.assign({ muteHttpExceptions: true }, options || {})); }
  catch (error) { throw forgeNetworkError_(origin, error); }
}

function forgeResponseJson_(response) {
  const status = response.getResponseCode();
  let body;
  try { body = JSON.parse(response.getContentText() || "{}"); }
  catch (_) { body = { error: response.getContentText() || `Forge returned HTTP ${status}` }; }
  return { status, body };
}

function forgeAccessAt_(origin, game, token) {
  const parsed = forgeResponseJson_(forgeFetch_(origin, `/api/games/${encodeURIComponent(game)}/access`, {
    method: "get", headers: { Authorization: `Bearer ${token}` },
  }));
  if (parsed.status === 401) {
    clearForgeCredentials_();
    throw new Error("Your Forge sign-in expired. Sign in again, then retry the connection check.");
  }
  if (parsed.status < 200 || parsed.status >= 300)
    throw new Error(parsed.body.error || `Forge access check returned HTTP ${parsed.status}`);
  if (!parsed.body.canWrite)
    throw new Error("This Forge account does not have commit access to that game. Create your own edition in Forge, or ask the game owner for editor access, then try again.");
  return parsed.body;
}

/** Verify the exact endpoint, account, game, and editor permission before any
 * document connection is changed. A successful proof is user-private and lets
 * setup resume after the sidebar is closed; no password is retained. */
function testForgeConnection(input) {
  input = input || {};
  const origin = forgeOrigin_(input.origin);
  const game = forgeGameSlug_(input.game);
  const user = PropertiesService.getUserProperties();
  user.deleteProperty(FORGE_PENDING_CONNECTION_KEY);
  const health = forgeResponseJson_(forgeFetch_(origin, "/healthz", { method: "get" }));
  if (health.status < 200 || health.status >= 300 || !health.body.ok)
    throw new Error(health.body.error || `Forge health check returned HTTP ${health.status}`);

  const handle = String(input.handle || "").trim();
  const password = String(input.password || "");
  let token = user.getProperty(FORGE_TOKEN_KEY);
  if (!token || user.getProperty(FORGE_TOKEN_ORIGIN_KEY) !== origin) {
    if (!handle || !password)
      throw new Error("Forge is reachable. Enter your Forge handle/email and password to verify commit access. The password is never stored.");
    const login = forgeLogin_(origin, handle, password);
    token = login.token;
    user.setProperties({
      [FORGE_TOKEN_KEY]: token,
      [FORGE_TOKEN_ORIGIN_KEY]: origin,
      [FORGE_HANDLE_KEY]: login.user && login.user.handle ? login.user.handle : handle,
    });
  }
  const access = forgeAccessAt_(origin, game, token);
  const cardsTab = Number(input.cards_tab || SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getSheetId());
  const printingsTab = input.printings_tab === "" || input.printings_tab == null ? null : Number(input.printings_tab);
  const tabIds = forgeSheets_().map(tab => tab.id);
  if (tabIds.indexOf(cardsTab) < 0) throw new Error("Choose an existing Cards tab.");
  if (printingsTab != null && tabIds.indexOf(printingsTab) < 0) throw new Error("Choose an existing Printings tab.");
  if (printingsTab === cardsTab) throw new Error("Cards and Printings must use different tabs, or leave Printings blank.");
  const pending = { origin, game, cards_tab: cardsTab, printings_tab: printingsTab,
    verified_at: new Date().toISOString() };
  user.setProperty(FORGE_PENDING_CONNECTION_KEY, JSON.stringify(pending));
  return { state: forgeSettings_(), connection: { ok: true, origin, game,
    version: health.body.version || "", role: access.role || (access.isOwner ? "owner" : "editor"),
    can_write: true, can_release: !!access.canRelease } };
}

function forgePendingMatches_(origin, game, cardsTab, printingsTab) {
  let pending = null;
  try { pending = JSON.parse(PropertiesService.getUserProperties().getProperty(FORGE_PENDING_CONNECTION_KEY) || "null"); }
  catch (_) {}
  return !!pending && pending.origin === origin && pending.game === game && Number(pending.cards_tab) === Number(cardsTab)
    && (pending.printings_tab == null ? null : Number(pending.printings_tab)) === (printingsTab == null ? null : Number(printingsTab));
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
  const origin = forgeOrigin_(input.origin);
  const game = forgeGameSlug_(input.game);
  const handle = String(input.handle || "").trim();
  const password = String(input.password || "");
  const tabs = forgeSheets_(), tabIds = tabs.map(tab => tab.id);
  const cardsTab = Number(input.cards_tab || SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getSheetId());
  const printingsTab = input.printings_tab === "" || input.printings_tab == null ? null : Number(input.printings_tab);
  if (tabIds.indexOf(cardsTab) < 0) throw new Error("Choose an existing Cards tab.");
  if (printingsTab != null && tabIds.indexOf(printingsTab) < 0) throw new Error("Choose an existing Printings tab.");
  if (printingsTab === cardsTab) throw new Error("Cards and Printings must use different tabs, or leave Printings blank.");
  if (!forgePendingMatches_(origin, game, cardsTab, printingsTab))
    testForgeConnection({ origin, game, cards_tab: cardsTab, printings_tab: printingsTab, handle, password });
  const user = PropertiesService.getUserProperties();
  const tokenMatchesOrigin = user.getProperty(FORGE_TOKEN_KEY) && user.getProperty(FORGE_TOKEN_ORIGIN_KEY) === origin;
  if (!tokenMatchesOrigin) {
    if (!handle || !password) throw new Error("Enter your Forge handle/email and password. The password is sent only to Forge login and is never stored in the Sheet or script properties.");
    const login = forgeLogin_(origin, handle, password);
    user.setProperties({
      [FORGE_TOKEN_KEY]: login.token,
      [FORGE_TOKEN_ORIGIN_KEY]: origin,
      [FORGE_HANDLE_KEY]: login.user && login.user.handle ? login.user.handle : handle,
    });
  }
  const doc = PropertiesService.getDocumentProperties();
  const previous = {};
  Object.keys(FORGE_DOC_KEYS).forEach(name => { previous[name] = doc.getProperty(FORGE_DOC_KEYS[name]); });
  doc.setProperty(FORGE_DOC_KEYS.mapping, JSON.stringify({ cards: cardsTab, printings: printingsTab }));
  doc.setProperties({
    [FORGE_DOC_KEYS.origin]: origin,
    [FORGE_DOC_KEYS.game]: game,
    [FORGE_DOC_KEYS.source]: forgeSheetIdentity_(),
    [FORGE_DOC_KEYS.dirty]: new Date().toISOString(),
  });
  try {
    const attached = attachForgeWorkingCopy();
    user.deleteProperty(FORGE_PENDING_CONNECTION_KEY);
    return attached;
  } catch (error) {
    Object.keys(FORGE_DOC_KEYS).forEach(name => {
      const key = FORGE_DOC_KEYS[name];
      if (previous[name] == null) doc.deleteProperty(key);
      else doc.setProperty(key, previous[name]);
    });
    throw error;
  }
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
  const response = forgeFetch_(origin, "/api/auth/login", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ handle, password, api_token: true }),
  });
  const { status, body } = forgeResponseJson_(response);
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
  const response = forgeFetch_(state.origin, path, options);
  const { status, body } = forgeResponseJson_(response);
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
