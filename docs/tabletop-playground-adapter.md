# Tabletop Playground adapter

Forge adapter version 1 turns one exact game ref into a native local Tabletop
Playground package. The repository remains authoritative; templates, textures,
and the saved state are deterministic derived outputs.

## Verified package contract

The adapter follows Tabletop Playground's documented package layout: a package
`Manifest.json` and object-template JSON files at the root, local textures under
`Textures/`, a 16:9 thumbnail, and game states under `States/`. Object templates
target the official schema at commit
`6ec22130a465096b3ae0808e746a9634fd92f0ca` of
[`plasticity-studios/tabletop-playground-schemas`](https://github.com/plasticity-studios/tabletop-playground-schemas).
The folder layout and editor-managed upload boundary follow the
[official package documentation](https://tabletop-playground.com/knowledge-base/packages/).

The ZIP contains:

- `Manifest.json`, with a stable 32-hex package GUID and no invented mod.io ID;
- one schema-shaped card template for each capped card atlas;
- reusable templates and local front/back textures for Forge components;
- visible initial-value templates for committed setup counters;
- `States/<game>.vts`, with exact deck quantities and setup placements;
- `forge-ttpg-receipt.json`, binding ref, setup, package GUID, schema revision,
  rights, object counts, texture hashes, and explicit limitations;
- `README.txt`, with local installation and editor-review instructions.

Forge's export worker also publishes `ttpg-manifest.json` next to the ZIP. A
release records both files' sizes and SHA-256 values at the immutable source
commit, using the same derived-cache recovery rules as other adapters.

## Mapping

| Forge source | Tabletop Playground output |
|---|---|
| card printings | JPEG atlases capped at 4096 px plus `Card` templates |
| exact deck quantities | a native card stack with per-card template/index serialization |
| explicit setup cards | individual native cards at the committed zone centers |
| tokens, tiles, boards, dials, standees | reusable flat `Card` templates with physical centimetre dimensions and matching built-in shape |
| remaining component inventory | deterministic supply stacks or individual non-stackable objects |
| setup counters | round initial-value markers with bounds preserved in metadata |
| setup instructions and seats | saved-state notes and twenty player-slot labels/colors |

Shuffle order is deterministic from game, setup, stack, and source ref. A setup
cannot consume more card or component copies than its versioned inventory.

## Install and publish boundary

Download and unzip the package folder into Tabletop Playground's configured
package location (`TabletopPlayground/PersistentDownloadDir` in the standard
editor workflow), then open the included state. Review it in the editor before
sharing. Uploading or updating on mod.io is an external side effect performed
through Tabletop Playground; Forge's file adapter neither requests credentials
nor claims that upload occurred.

## Honest limitations

- CI verifies deterministic bytes, package structure, texture bounds,
  template fields, exact stack quantities, placement metadata, and the pinned
  official object-template schema contract. Tabletop Playground is proprietary,
  so an actual in-app import remains a human release qualification.
- Counter bounds are metadata, not scripted enforcement. The initial value is
  visible and staged.
- Generic flat components use TTPG's card models. Native 3D figures, dials, and
  custom dice need committed models/rotation maps. Custom dice fail closed
  rather than becoming the wrong object.
- The adapter produces a package, not a mod.io publication receipt. A future
  publisher connector must be separately authorized and must bind the external
  result to the exact release artifact hash.
