# Google Sheets working-copy connector

Google Sheets owns live drafting, comments, presence, cell history, and document
restoration. Forge does not continuously synchronize or replace any of those
features. It owns the deliberate boundary where a saved Sheet draft becomes a
validated, rendered, reproducible game candidate.

> Sheets says whether the document is saved. Forge says whether its playable
> changes have entered accepted game history.

## Decision locked

The production model is a **working-copy promotion boundary**, not continuous
two-way synchronization:

- Sheets remains the editor of choice and owns draft collaboration/history.
- A Sheet edit never changes the accepted Forge game by itself.
- While the sidebar is open, **Live diff** polls the shared edit marker every two
  seconds. After an edit burst settles it automatically recomputes the same
  authoritative semantic, visual, conflict, and validation candidate.
- **Check draft changes** creates an authoritative semantic, visual, and
  validation candidate from the active tab.
- **Commit this exact candidate** is the only promotion step. Forge rechecks the
  reviewed snapshot token before writing history.
- The authenticated Forge user is the submitter; collaborators are added
  explicitly. Forge does not guess authorship from Google edit events.
- Forge does not write card data back into the Sheet.

This boundary is the feature. It lets a team use Sheets, a Forge editor, CSV, or
another future adapter without weakening reviewable game history.

## Verification status — 2026-09-03

- The real `Code.gs` connector passes the disposable-server harness, including
  public-origin validation, health and write-access checks, resumable setup,
  transactional attachment rollback, login, explicit Cards + optional
  Printings tab mapping, unrelated-tab isolation, clean/dirty detection, visual
  candidate data, exact-token commit, credit, session expiry, server-side
  sign-out revocation, and detach behavior.
- A headless Chrome journey executes the actual sidebar client. It proves that
  attachment stays disabled until verification, localhost gets an actionable
  recovery path, the password field clears after sign-in, the exact Forge game
  link opens after attachment, and Connection always returns to the candidate.
- A real bound Google Apps Script project loaded the three integration files,
  produced the custom **Forge** menu, completed Google's OAuth flow in Chrome,
  and opened the candidate sidebar in a real Sheet.
- The real Google-hosted Sheet attached its private tab through an HTTPS tunnel,
  reviewed a candidate, and created attributed Forge commit `c40b809` while
  recording the exact Sheet fingerprint and repository base SHA.

The connector boundary is therefore proven end to end. The earlier live smoke
used a disposable tunnel and does not qualify the current candidate or a durable
beta deployment. A controlled beta can use the bound-script package only after
the final stable HTTPS origin exists and the live journey is repeated. Open
distribution still requires a packaged and verified Google Workspace add-on;
manual script copying remains an operator-assisted installer, not a consumer
release path.

Two surfaces use the same backend contract:

- The Cards page accepts a published Google Sheet/HTTPS CSV URL.
- [`integrations/google-sheets`](../integrations/google-sheets) is a bound Apps
  Script proof of concept for private Sheets. Its sidebar marks edits in mapped
  tabs as possibly dirty, then always recomputes the authoritative diff from the
  configured Cards and optional Printings tabs.

## Safety contract

Every candidate check compares three states:

1. the last commit built from this working copy (`base_sha`),
2. the current Forge commit (`head_sha`), and
3. the current Sheet snapshot (`source_hash` and `source_revision`).

Independent field changes merge. If Forge and the Sheet changed the same field
differently, or one side deleted a card the other side edited, Forge returns an
explicit conflict containing the last-sync, Forge, and Sheet values. Nothing is
committed while conflicts exist.

Check returns an optimistic candidate token containing `head_sha` and
`source_hash`. Commit re-reads both sides. If either changed after review, Forge
returns HTTP 409 and requires another check.

The check reads the mapped tables as one atomic workbook snapshot and validates
the complete cards + printings tree before enabling Commit
and returns affected cards for visual review. A successful commit is attributed
to the authenticated Forge user; optional collaborators are recorded explicitly
in its message. PnP, Tabletop Club, TTS, playtests, diffs, and releases can then
consume that exact commit.

The connector never infers authorship from Apps Script triggers. Google triggers
are useful only as a quick dirty hint; the person authenticated to Forge and
pressing Commit is the verified submitter. Google remains the audit trail for
draft-level coworker activity.

Live diff does not send every keystroke to Forge. The sidebar cheaply polls the
document's dirty timestamp, debounces an edit burst, and then sends one current
Sheet snapshot for an authoritative dry run. The watcher can be paused. If a
new edit arrives while a check or commit is in flight, revision-aware clearing
keeps the newer marker dirty and schedules another check; it never labels that
newer edit reviewed or committed.

## Stable row identity

Use permanent, unique `id` values in Cards and Printings, plus a stable `card_id`
in each printing. Names can change; IDs cannot. The CSV importer still derives
IDs from names for one-off imports, but connected Sheets require explicit IDs so
renames remain edits rather than deletion/addition pairs.

Columns present in the Sheet are working-copy-managed. Forge-only card metadata and
printing fields not represented by a Sheet column are preserved. Artwork,
scans, asset provenance, and extra printings therefore survive candidate builds.

## API

```text
PUT    /api/games/:slug/sync/sheet       attach and establish a merge base
GET    /api/games/:slug/sync             connection/base/fingerprint status
POST   /api/games/:slug/sync/pull?dry=1  check diff, conflicts and validation
POST   /api/games/:slug/sync/pull         commit an exact preview token
DELETE /api/games/:slug/sync/sheet       detach
```

The naming of these compatibility endpoints predates the working-copy model;
their behavior is intentionally push/commit, not continuous synchronization.

For a published source, the server fetches CSV. The add-on sends an atomic
`snapshot` containing the mapped Cards and optional Printings tables, a stable
`source_id` for the spreadsheet plus its tab-role mapping, and the preview token
in JSON. Snapshots are limited to 5 MB and never store Google credentials.

Every successful promotion commits `forge/imports/google-sheets.json` beside the
game data. The receipt pins the adapter id/version, workbook and tab identities,
source hash/revision, repository base and resulting commit, submitter, and change
counts. That makes the external-editor boundary reproducible and reviewable even
after the Sheet has changed again.

## Install the bound-script proof of concept

1. Open the target Sheet and choose **Extensions → Apps Script**.
2. Copy `Code.gs`, `Sidebar.html`, and `appsscript.json` from
   `integrations/google-sheets` into the bound project.
3. Reload the Sheet, then choose **Forge → Open candidate panel**.
4. Complete Google's first-run consent in a regular browser. The manifest asks
   only for this spreadsheet, container UI, and outbound HTTPS request scopes.
5. Enter a stable public HTTPS Forge origin and game slug, then choose the Cards
   tab and an optional Printings tab. Apps Script runs on Google's servers and
   cannot reach `localhost` or a private LAN address. For local Forge, use the
   Cards-page published Sheet/CSV importer instead. Short-lived tunnels are
   suitable only for disposable tests.
6. Choose **Test & sign in**. Forge checks `/healthz`, authenticates without
   storing the password, and verifies commit access to the exact game. A green
   check can be resumed after closing and reopening the sidebar.
7. Choose **Attach working copy**. The initial private snapshot establishes the
   merge baseline atomically; if attachment fails, the Sheet's previous shared
   connection is restored.
8. Check draft changes, review validation/diffs, add a commit message and
   contributors, then commit the exact candidate. Use **Open this game in
   Forge** to continue into cards, releases, or playtests.

The game/source identity lives in document properties shared with Sheet editors.
The password is sent directly to Forge's login endpoint and never stored; the
resulting session token lives in Google user properties and is not shared in the
Sheet. A valid token can be reused when connection settings change, so editors
are not asked to resend their password unnecessarily. HTTP 401 clears the stale
personal session and asks the editor to sign in again. **Sign out** first revokes
that editor's Forge session and then removes the local credential. **Detach** removes the shared Forge
working-copy connection without deleting accepted commits or unrelated script
properties.

The manual-copy installation is for the proof of concept; a production Workspace
add-on should use Forge OAuth and be distributed privately before Marketplace
review.

## Automated connector test

`tools/sheets-addon-check.mjs` executes the real `Code.gs` against a disposable
Forge server with a small mock of the Apps Script host. Its 37 assertions run in
the main `e2e.sh` suite and cover public-origin rejection, reachability, write
access, sign-in, resumable verification, attachment rollback, private-tab
attachment, password/token storage boundaries, password-free token reuse, clean
and dirty status, polled live-diff hints, edit-during-check race protection,
validation/preview data, exact candidate commit, resulting cards and printings,
committed import receipt, attribution, unrelated-tab isolation, expired-session
cleanup, safe detach, and server-side sign-out revocation. `tools/ui-smoke.mjs`
separately runs the actual sidebar HTML and state transitions in Chrome.

Sources are limited to 5 MB. Production sources must use HTTPS; redirect targets
are checked as well. The shipped connector rejects loopback before sending
credentials or changing document state. Its disposable harness enables loopback
explicitly so it can exercise the complete server contract in isolation.

## Product boundary

Forge never writes back into the Sheet, snapshots every keystroke, or claims to
replace Google version history. The first production add-on should keep this
one-way promotion boundary. Forge OAuth, installer/distribution work, and richer
candidate render links can be added without changing the merge contract.
