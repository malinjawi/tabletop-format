# Deploy the Forge Google Sheets connector

This is the operator runbook for the controlled beta. Creators should install
one pinned connector and see the operator-managed Forge origin automatically;
they should not copy source files or type infrastructure URLs.

Google treats this as an **Editor add-on**. Editor add-ons can use Apps Script
menus and HTML sidebars, which is the interface Forge already ships. A
versioned deployment that calls Forge must include an HTTPS URL fetch allowlist.
The package command creates that allowlist and pins the same origin into the
runtime UI. See Google's current documentation for [Sheets Editor add-ons](https://developers.google.com/workspace/add-ons/editors/sheets),
[Editor add-on manifests](https://developers.google.com/workspace/add-ons/concepts/editor-manifests),
[URL allowlists](https://developers.google.com/apps-script/manifest/allowlist-url),
and [`clasp`](https://developers.google.com/apps-script/guides/clasp).

## Required operator inputs

- A stable public Forge origin with working DNS and TLS. It cannot be
  `localhost`, a private-network address, or a disposable tunnel.
- An operator-owned Google Cloud project and Apps Script project.
- The Apps Script API enabled for the operator account.
- A regularly monitored privacy/support contact whose URLs match Forge's live
  policy pages.
- An explicit distribution choice: Apps Script test deployment for the closed
  cohort, private Marketplace listing for one Workspace organization, or public
  Marketplace review. Do not describe a test deployment as Marketplace-listed.

The Apps Script ID identifies a project but is not an OAuth credential. The
operator's `.clasprc.json` contains a refresh token and must remain outside Git,
chat, tickets, build artifacts, and the package directory.

## Build an immutable package

From a clean, qualified Forge commit:

```sh
npm ci
npm run package:sheets-addon -- \
  --origin https://forge.example \
  --script-id YOUR_OPERATOR_OWNED_SCRIPT_ID \
  --out /an/operator-controlled/forge-sheets-candidate
```

The command refuses dirty connector sources, an existing non-empty output
directory, HTTP, loopback/private hosts, and origins containing paths, queries,
credentials, or fragments. It writes:

```text
forge-sheets-candidate/
├── .clasp.json
├── README.md
├── forge-deployment.json
└── src/
    ├── Code.gs
    ├── Sidebar.html
    └── appsscript.json
```

`forge-deployment.json` records the Git revision, Forge origin, exact clasp
version, OAuth scopes, URL allowlist, byte count, and SHA-256 of every uploaded
file. Retain it beside the cohort's off-repository evidence.

## Push, version, and install for the cohort

Follow the generated README. In short, authenticate `clasp` as the operator,
push from the package directory, and create an immutable version:

```sh
npx --no-install clasp push
npx --no-install clasp version "Forge COMMIT"
```

Record the resulting Apps Script version. For the closed cohort, install an
Apps Script test deployment and restrict access to the intended testers. A
private or public Marketplace listing additionally requires configuration in
the operator's Google Workspace Marketplace SDK project. Public distribution
can require OAuth verification and Marketplace review; Google requires the
scopes in the manifest, consent screen, and Marketplace SDK to agree. See
[Marketplace configuration](https://developers.google.com/workspace/marketplace/enable-configure-sdk),
[OAuth configuration](https://developers.google.com/workspace/marketplace/configure-oauth-consent-screen),
and [review requirements](https://developers.google.com/workspace/marketplace/about-app-review).

## Live qualification—required before invitations

Use a pilot account, not the operator's own active Forge session:

1. Install the exact Apps Script version and open a private Sheet with stable
   `id` rows.
2. Confirm the sidebar pre-fills and locks the correct Forge origin.
3. Sign in, choose an owned/editable game, map Cards and optional Printings,
   and attach the working copy.
4. Close and reopen the sidebar during setup once to prove resume behavior.
5. Change one field and add one row. Wait for Live diff, inspect the visual and
   semantic candidate, and commit it with a unique message.
6. Verify Forge history credits the pilot account and the committed import
   receipt matches the Sheet fingerprint and Apps Script adapter version.
7. Cut or preflight an exact release from that commit and confirm no undeclared
   file can ship.
8. Record the Apps Script version, SHA-256 of the script ID, package receipt
   location, resulting Forge commit, and pass/fail result in the private pilot
   evidence. Never store the raw script ID or user credentials in public logs.

Any candidate mismatch, lost credit, private-source leak, or inability to
reproduce the exact release is an immediate pilot stop condition.
