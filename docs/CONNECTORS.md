# Connectors and file handoffs

Choose the tool you want to edit in, then use the matching download and return path. Most connections exchange files. A returned file becomes a proposed change that you review and commit; editing it elsewhere does not automatically change Forge.

## Choose a path

| Tool or destination | Connection | What you can do | What stays outside Forge |
| --- | --- | --- | --- |
| **Forge Studio** | Built-in browser editor | Edit card content, artwork, and shared layouts; review and save them together. | No external editor is needed. |
| **Excel / LibreOffice** | Traced `.xlsx` file exchange | Download a workbook, edit the `cards`, `printings`, and `tokens` tables, and return it for review. | Workbook formatting, comments, charts, and unrelated tabs. Formulas, macros, and external workbook links are rejected. |
| **CSV / Dextrous / Component Studio** | Table file exchange | Export card tables or the complete data package, edit values, then return the CSV or ZIP. | Dextrous and Component Studio layouts, styles, and native projects. Forge does not connect to their publishing accounts. |
| **Published Google Sheet** | Public URL importer in Forge | Attach a published tab, review its card changes, and commit a candidate from the Cards page. Connecting alone does not import the cards. | Google document history and comments. Forge never writes changes back to the Sheet. |
| **Private Google Sheet** | Separately installed beta add-on | Attach mapped tabs, inspect live draft differences, and commit an exact reviewed candidate from Sheets. | Installation and availability depend on the Forge operator's Google deployment. This is not an automatically installed or universally Marketplace-listed connector. |
| **Affinity / Illustrator / Inkscape SVG** | SVG file exchange | Download a Forge family SVG and return supported geometry, flat color, stroke, radius, and opacity edits. | Native editor documents and unsupported effects. Arbitrary SVGs need mapping; they do not automatically replace a family. |
| **Affinity production bridge** | Separately configured local desktop worker | Use a bound native template for a committed card/printing and produce a native render. | Requires Affinity and local setup. The bridge is a single-job workflow, not general batch production or reverse synchronization of native documents. |
| **Inkscape + PnPInk** | Beta `.pnp` / CSV handoff | Where configured, download family projects, edit their data or SVG source, and return them for review. | Inkscape/PnPInk rendering is not bundled. The returned external template does not silently become Forge's active release renderer. |
| **nanDECK** | Beta script and CSV handoff | Download family scripts; return supported layout edits and inspect their effect. | Unsupported commands and visual features remain outside the supported Forge layout subset. Check the package's limitations. |
| **Squib** | Beta ZIP handoff | Edit card CSV and supported YAML layout fields; return the ZIP for a combined review. | Forge does not execute returned Ruby or import edits to `deck.rb`. Its local Squib preview can differ from Forge release output. |
| **Full Forge project / native source assets** | Versioned file package | Download saved cards, templates, rules, declared assets, and editor handoffs. Return supported project changes for review. | Carrying an Affinity, IDML, Scribus, or Blender file does not mean Forge can edit or merge its internal objects. |
| **Print, publishers, and virtual tabletops** | Output file handoff | Download print files or the selected tabletop package from a saved version or release. | Import, upload, account publishing, printer approval, and physical/native-app proof happen in the receiving tool or service. |

An editor name in Studio's **Other editors** menu means a compatible handoff is available. It does not mean Forge can launch that editor, install it, or control its account. The same file options appear under **Design → Use another editor**.

## Return an external working copy

1. Save your Forge work, then download a fresh working copy from **Design → Use another editor** or Studio's **Other editors** menu.
2. Keep the package's manifest and permanent IDs. For an XLSX file, keep the hidden Forge manifest sheet. For a ZIP, preserve its declared file paths.
3. Edit the supported fields in your chosen tool. Keep a copy of that file until Forge confirms the save.
4. Choose the matching **Return** action in Forge. Inspect the changes, rendered impact, warnings, and conflicts. This first review writes nothing.
5. Commit the reviewed result, or use the offered edition and pull-request path if you do not have direct write access. Confirm the new version in **More → Commits**.

A standalone returned CSV may depend on the baseline recorded when you downloaded it in that browser. If Forge cannot find the baseline, download a fresh CSV there, or use the traced workbook or complete ZIP. Do not remove metadata to get around a stale-version or conflict error.

## Connect a published Google Sheet

Use this when the selected tab may be retrieved without signing in to Google. Publishing a tab makes its data available at that URL; use the private add-on for a Sheet that must remain private.

For a new project, choose **Connect Google Sheet** in **New game**. For an existing project you can edit, expand **Connect Google Sheets** on **Cards**, supply the published tab URL, and choose **Connect Sheet**. A new project stays empty until you review and commit the Sheet's cards. If attachment fails, the project still exists: correct the URL and reconnect there instead of creating another project.

Keep stable, unique `id` values. Choose **Review Sheet changes**, inspect the candidate and any conflicts, then **Commit reviewed changes**. The first import and later Sheet edits use this same review step. If Forge or the Sheet changed during review, check again. Use **Connection details → Disconnect Sheet** to detach; this does not delete already committed game versions.

## Connect a private Google Sheet

Your host operator must provide an installed beta connector for the correct Forge deployment. The Sheets code runs on Google's servers: it requires a stable, publicly reachable HTTPS Forge address and cannot connect to `localhost` or a private LAN address. If your operator has not deployed the connector, use a downloaded workbook/CSV instead.

1. Open the installed **Forge → Open candidate panel** menu in Sheets. Confirm it points to your Forge host.
2. Choose the target game and map the Cards tab and, if needed, a Printings tab. Printing rows need their own `id` and a `card_id` that matches a card.
3. Choose **Test & sign in** and sign in with a Forge account allowed to commit to that game. Then choose **Attach working copy**.
4. Edit the mapped tabs. **Live diff** checks for draft changes while the sidebar is open; it does not commit them. You can also choose **Check draft changes**.
5. Review the exact candidate, enter a message and any collaborator credit, and choose **Commit this exact candidate**. Open the game in Forge and confirm the saved version.

The connected spreadsheet identity is shared with its editors; each editor signs in to Forge separately. Your Forge password is not stored by the connector. **Sign out** revokes your connector session. **Detach** removes the shared working-copy connection without deleting accepted commits. Neither action deletes the Google Sheet.

If sign-in expires, sign in again. If a mapped tab was removed, reopen **Connection** and select the intended tab. If a candidate changes or conflicts, resolve the conflicting cells and run a new check; an old preview cannot authorize a newer Sheet snapshot.

## Print and tabletop outputs

Use **Design → Configure print** to select the saved print profile. The Game Crafter preset produces a checked file handoff; it does not submit an order or publish to an account. Custom CMYK/PDF-X work requires a printer-supplied or approved ICC profile and approval of the delivered files. Other publishers may require adjustments in their own tools.

Find print outputs in **Download**, tabletop packages under its **Virtual tabletops** section, and the complete saved project under **Source and rulebook files → Portable source project**. Release downloads are under **More → Releases**.

**Tabletop Playground** packages include local textures and a staged state. Follow the included README, open the state in the app, and check it there. Forge does not upload it to mod.io. **Tabletop Simulator** exports can reference Forge-hosted textures; verify those textures are accessible to the people loading the save. Private assets may require authentication that the target app cannot provide. **Tabletop Club** and **VirtualTabletop** also receive packages, not an account publication.

These outputs still need a practical proof: inspect a physical printed page or import the package into the actual target app. The package passing Forge checks does not establish that every native editor, printer, or tabletop client has been certified.

## Detailed setup and limits

- [Excel and LibreOffice workbook contract](workbook-adapter.md)
- [Google Sheets behavior and recovery](google-sheets-sync.md)
- [Private Sheets deployment for host operators](google-sheets-deployment.md)
- [SVG/PnPInk/nanDECK design adapters](design-engine-adapters.md)
- [Squib supported return fields](squib-adapter.md)
- [Affinity local bridge setup](../integrations/affinity/README.md)
- [Tabletop Playground package instructions](tabletop-playground-adapter.md)
- [Tabletop Simulator package instructions](tabletop-simulator-adapter.md)

For the complete first-project workflow, see the [Creator guide](CREATOR-GUIDE.md).
