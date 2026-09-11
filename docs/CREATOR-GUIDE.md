# Make your first playable version in Forge

Start with a few cards you can test. Edit their content and shared design, review the result, then save a version before downloading it.

## Start a project

Sign in and choose **New game**. Give it a working title and choose how to begin:

| Starting point | What to do |
| --- | --- |
| An idea | Choose **Start from an idea**. Describe the idea, how players should feel, and the smallest version you can play. |
| A spreadsheet | Choose **Import CSV / XLSX**. Upload a file or paste CSV. For a workbook, select its card tab. Choose **Review columns**, check the field mapping and preview, and fix any errors before creating the game. |
| A published Google Sheet | Choose **Connect Google Sheet** and supply the published tab URL. This creates the project and attaches the Sheet; the cards remain pending until you review and commit them from **Cards**. For a private Sheet, create the project first and use the separately installed Sheets add-on. See [Connectors](CONNECTORS.md). |

The default license choice is **Private draft — no reuse permission**. Choose sharing permissions deliberately; uploading someone else's artwork does not grant permission to publish it.

For a first spreadsheet, useful columns are `id`, `name`, `type`, and `text`, followed by fields your game needs, such as cost. Check how those extra columns are mapped. After import, keep each card's permanent ID when renaming it or moving rows.

## Build and edit cards

1. Open **Design**. For an empty project, choose **Build the first card system**. Select a starting layout, physical card size, copies, fields, and a few card names. Choose **Review first component**, inspect the fronts and shared back, then **Commit first component**.
2. Open **Forge Studio** and select a card. **Content** changes that card's words and values. **Design** changes the shared layout used by its card family. Check **Affected cards** when moving or styling a shared element.
3. Use **Table** for several rows at once. Paste cells from a spreadsheet, duplicate a card, or add a card. Keep permanent IDs intact; use a new card when you intend a new identity.
4. Add artwork through the art picker and record its creator and rights. Inspect the crop on the card. Use **Front / Back** to inspect both faces.
5. Use **Longest** to inspect long rules text, **Original** to compare with the saved version, and **Proof** to inspect the family. Check readable text, symbols, art, card edges, and the shared back.

Projects with different card types can use several families. Start with one family unless the cards need different layouts. Non-card components have their own **Piece Studio** for quantities, dimensions, shared styling, and cut sheets.

## Review and save

Choose **Review changes**. The review shows the before-and-after preview and the card, artwork, and shared design changes together. Resolve conflicts, missing symbols, or text-fit errors before continuing.

Choose **Commit reviewed candidate** to save the reviewed version to project history. If you cannot edit the original project, Forge can offer **Commit to my edition + open PR**. That saves an independent edition and asks the original project's maintainers to review it. The original changes only if they accept the proposal.

Confirm the save succeeded and the new version appears in **More → Commits**. A preview or a green validation result alone has not saved anything. The **More** menu also contains Releases, Assets, Pull requests, Playtests, and other project tools; its label shows the current tool while you are using one.

| State | What it means |
| --- | --- |
| **Draft** | Changes in your open editor or external working copy. Studio can keep a recovery copy in this browser. They have not entered shared project history. |
| **Repository version / committed** | A saved version in project history. Other authorized collaborators and normal downloads can use it. Saving does not by itself create a release. |
| **Released** | A named, fixed version with its generated files. Later edits do not replace the files belonging to that release. |

## Download, print, and release

Save the changes you want to export first. **Download** builds from the saved project version; an unsaved Studio draft is not included.

For a home test, open **Configure print**, choose the card selection, fronts/backs, and crop settings, then review and commit the print profile. Download a **Print-ready package** or **Forge PnP PDF**. Open the supplied instructions and print one page at 100% scale to check size and duplex alignment before printing the full set.

For a virtual tabletop, expand **Virtual tabletops** in **Download**, choose the matching package, and follow its included installation instructions. Open it in the target app and check the actual cards, backs, quantities, and table setup before inviting players. An exported package has not been uploaded to that app's community or publishing account.

When you need a named version to share, open **More → Releases**. Address the **Release readiness** blockers, then choose **Cut this exact release** and give it a tag such as `v0.1`. Share that release's downloads so everyone tests the same version. A professional printer must approve the exact delivered files; Forge's print checks do not replace that approval.

Use **Other editors** in Studio, or expand **Use another editor** on the Design page, to download editable working copies. Use the corresponding **Return** action, inspect its proposed changes, and commit them. See [Connectors and file handoffs](CONNECTORS.md) for what each editor can return.

## When something interrupts the work

| What you see | What to do |
| --- | --- |
| **Restore local Studio draft?** | Reopen the same project and family in the same browser and account. Restore the offered draft, inspect it, and review before committing. Restoring does not save a shared version. |
| **Local draft belongs to an older version** | Choose **Keep for later** to preserve it in this browser. Forge currently has no built-in comparison, export, or reapply flow for an older local recovery copy. Contact the host operator for help preserving the work; do not clear site data or discard it while you still need it. |
| **Local recovery unavailable** | Keep the editor open and save through review when the connection is available. Browser recovery is not a backup; another browser, cleared site data, or unavailable browser storage cannot restore it. |
| A conflict or stale return | Keep the external file. Compare the conflicting fields with the current version. For a stale file handoff, download a fresh working copy and reapply the intended edits, then return and review it. |
| A save or download fails | Check the displayed error and project history before retrying. Reconnect or sign in if requested. A failed request is not evidence that a new version was saved. |
| Missing artwork, symbols, or unexpected fonts | Stop the proof there. Check the affected asset and its rights/access in **More → Assets** or **Design → Artwork & fonts**. If the saved file exists but still will not display, report the project, version, card, and visible error to the host operator. |

For a portable copy of saved work, choose **Download → Source and rulebook files → Portable source project**. Retain the package and its manifest when editing outside Forge. It carries saved source; it does not capture unsaved browser drafts.

Open **Help** to return to this guide. The Creator guide and Connectors pages are included in an offline preview too; live saving, connections, and generated downloads require a running Forge host.
