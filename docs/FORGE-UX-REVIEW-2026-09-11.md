# Forge creator UX review — September 11, 2026

This pass makes the existing creator workflow easier to navigate and its outcomes more precise. It does not add an editor or export format. Review started from main `4845aed` in the active product checkout.

## What was inspected

- Live narrow-screen Cards, Design, Help, and Download views.
- Source and browser workflows for new-game creation, spreadsheet import, shared design, external file returns, authentication, recovery, collaboration, printing, and releases.
- Connector behavior against its server routes and adapter contracts.
- Generated offline HTML and the full existing browser journey, using disposable game data and accounts.

This is an engineering and interface review, not an independent-user usability study.

## Changes made

| Problem | Change |
| --- | --- |
| Repeated workspace actions and seven primary tabs | Five primary tabs; secondary features remain in More. Download is directly visible. Cards and Rules keep their editing actions in the content area. Jams remains available in the footer. |
| Design began with promotional copy, two process summaries, and technical metadata | Templates appear first, with concise guidance. Shared elements, source details, and adapter internals expand when needed. Artwork, pieces, and print settings remain directly available. |
| Different external-tool capabilities appeared as one connection | Spreadsheet files, CSV-compatible tools, connected Sheets, and bounded SVG/native-editor handoffs have separate descriptions. Studio says Other editors instead of suggesting it launches an application. |
| Sheets creation tried an unreviewed commit, then announced success after failure | Creation attaches only. Review and commit remain explicit. Setup success or partial failure survives navigation with the next action and retry URL. |
| Optional Sheets setup dominated the Cards page | Setup is collapsed until requested or needed for recovery. Server-confirmed write access determines whether connection controls appear. |
| Errors and old setup notices could contradict current connection state | Connect, disconnect, review, and commit failures remain visible and recoverable. Fresh server state replaces contradictory persisted notices. |
| Signing in during a workbook or CSV download lost the chosen file | The selected format survives authentication and retry. Network, response, and job failures show an error instead of leaving a stalled build. |
| Download choices crowded a small modal | Print is first; tabletop and source packages have named expandable groups. The dialog explains saved-version behavior, scrolls on small screens, supports Escape and keyboard focus return, and links to format help. |
| Product guidance lived outside the interface | Creator and connector guides are bundled from maintained Markdown into both the live application and offline HTML. Mobile comparison tables become readable cards. |
| Copy made claims unrelated to the current state | Removed the hardcoded 77-card message, unconditional green print-contract claim, misleading account promise, and unnecessary command-line guidance from the overview. Keeping an older draft is now the primary recovery choice. |

## Verification

- 207 functional checks passed with no failures.
- The complete browser journey passed: import, authoring, shared-design changes, recovery, collaboration, rights, releases, and narrow screens. It reported no browser errors and left the source checkout unchanged.
- Focused export browser checks cover workbook and CSV selection through sign-in, failed responses, retries, and queued completion.
- Focused Sheets browser checks cover optional setup, write access, attachment without commit, failed/interrupted actions, exact reviewed candidates, partial creation outcomes, and stale-notice reconciliation.
- Existing preview checks decode public and private artwork, symbols, fonts, and CSS images, including injected missing/corrupt resources.
- Offline Help was opened at 320px with working guide links, contained layout, and no browser errors.

The Sheets UI tests use controlled responses. They do not certify a deployed Google add-on or a live Google account journey. No user's game data was modified for these checks.

## Next bounded UX work

1. **Shorten first-run creation.** Today the idea path requires an idea, intended feeling, and smallest playable slice before the workspace opens. Separate creating the project from developing its design brief; preserve existing brief data and make required fields explicit.
2. **Make older drafts recoverable in practice.** Preservation is safer, but there is still no built-in comparison/export/reapply flow for an older Studio draft. Add a discoverable recovery view and conflict-aware application before calling this complete.
3. **Complete interrupted-release discovery.** Publication recovery exists through an exact retry; creators still need to find and resume interrupted releases from the interface. Keep this paired with complete DB/Git/vault reconciliation.
4. **Audit remaining dense editors.** Piece, print-profile, assets, and rulebook screens still expose advanced concepts early. Simplify one real creator task at a time, keeping technical details available when necessary.
5. **Observe unfamiliar creators.** Measure first correct proof, assistance, and a successful second iteration. Passing checks establishes behavior, not whether a newcomer understands it.

Avoid another general redesign or a new connector until the next slice has a clear creator task and observable acceptance criteria. Public deployment and native/printer qualification remain separate work.
