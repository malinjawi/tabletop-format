# Excel and LibreOffice workbook adapter

Status: working file adapter. Tested with standards-based `.xlsx` files. Native
Microsoft Excel and LibreOffice automation is intentionally outside Forge.

Forge exports one version-pinned workbook with visible `cards`, `printings`,
and `tokens` sheets. The hidden `_forge_manifest` sheet records the game and
exact Git source ref. On return, Forge does **not** trust an editable copy of the
baseline: it materializes that ref from Store 1, rebuilds the canonical table
contract, and applies the returned values through the same atomic three-way
merge, full-game validation, rendered-impact review, commit, fork, and pull
request flow as the Forge design project.

For an existing ordinary workbook, **Bring or start a game → Import CSV / XLSX**
inspects its visible tabs, suggests the card-like tab, and sends that tab into
the same explicit column mapper used by CSV onboarding. The user's workbook is
not rewritten. Once the game exists, the traced Forge workbook is the
multi-table collaboration surface for cards, printings, and pieces.

## Round trip

1. In a game's Design workspace, download **Excel / LibreOffice workbook**.
2. Edit table values. Keep stable `id` values and the hidden Forge sheet.
3. Return the same `.xlsx` file.
4. Review all card, printing, and token changes together. Nothing is written
   during this dry run.
5. Commit directly when authorized, or commit to a credited fork and open a PR.

Formatting, comments, charts, and unrelated worksheets remain workbook-only.
Canonical table values enter Forge. Layout and art stay in their declared
design/source adapters.

## Safety and explicit boundaries

- `.xlsx` only; legacy `.xls` is not accepted.
- 10 MB compressed / 64 MB expanded, at most 32 sheets, 5,000 data rows per
  table, 256 columns, and 250,000 table cells.
- Macros, external workbook links, formulas, spreadsheet errors, unsafe ZIP
  paths, and suspicious compression ratios are rejected rather than evaluated.
- `cards` and `printings` are required. `tokens` is part of every new export and
  may be empty.
- Stable IDs are mandatory. Unknown columns must use `attributes.<key>`.
- This adapter exchanges values; it does not claim a native bidirectional
  layout round trip with Excel or LibreOffice.
