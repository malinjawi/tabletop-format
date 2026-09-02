# Forge ↔ Affinity production bridge

This bridge is game-agnostic. Forge owns committed structured game data;
Affinity owns native layout, typography, and export. Netrunner is one adapter
and the hardest current fidelity test, not a dependency of the core.

```text
Git commit (data + binding + template + resources)
  -> immutable bridge input
  -> named Affinity layers
  -> native .af document
  -> production preflight
  -> commit-pinned PNG
```

By default, all production inputs are read with `git show <commit>:<path>`.
Dirty card edits, template edits, resources, and binding changes cannot alter an
authoritative render. The production hash covers the binding config, template,
and every declared resource; the input hash also covers the selected card,
printing, bound values, and preflight rules.

`layout_source: "working-tree"` exists only for adapter development. Forge marks
that output as a development render, never authoritative.

## Universal binding contract

Every game can add `templates/affinity/forge-affinity.json`:

```json
{
  "schema_version": 2,
  "kind": "forge-affinity-binding",
  "game": "my-game",
  "card_id": "lantern_keeper",
  "printing_id": "lantern_alpha",
  "bridge_dir": "~/Desktop/Forge Affinity/my-game",
  "template": "templates/affinity/card.af",
  "native_document": "lantern-keeper.af",
  "resources": ["assets/fonts/body.ttf"],
  "bindings": [
    { "field": "name", "layer": "forge:name" },
    { "field": "tags", "layer": "forge:tags", "transform": "join", "separator": " · " },
    { "source": "printing", "field": "set", "layer": "forge:set" }
  ]
}
```

The template may be an Affinity document or an SVG that Affinity can import.
Editable objects are found by their stable layer description, such as
`forge:name`. Supported data sources are `card` and `printing`. Supported
transforms are plain text, `uppercase`, `lowercase`, `join`, `json`, and the
legacy `type-label`. `token-text` is an optional adapter behavior for a
template that places a vector token between two text objects; it is not tied to
NSG or to any particular symbol.

Production preflight rejects bound text that leaves the document bounds. It is
deliberately fail-closed: a PNG existing does not make a card print-ready.
Affinity text frames and deliberate template boxes are still the right answer
for wrapping; Forge does not silently shrink unreadable copy.

## Run

```sh
node tools/affinity-bridge.mjs prepare --game path/to/my-game
node tools/affinity-bridge.mjs watch --game path/to/my-game

node tools/affinity-mcp-worker.mjs run \
  --bridge "$HOME/Desktop/Forge Affinity/my-game"
node tools/affinity-mcp-worker.mjs watch \
  --bridge "$HOME/Desktop/Forge Affinity/my-game"
```

Affinity 3.2 restricts script file access to its approved Desktop tree, so the
bridge stages only the committed template and explicitly declared resources in
`~/Desktop/Forge Affinity`. The configured script embeds the immutable payload;
Affinity never polls a mutable sheet or working file.

## Stress tests

```sh
npm run test:affinity       # isolated generic repos; no Affinity required
npm run test:affinity:live  # real local Affinity, native .af, PNG, recovery
```

The isolated suite covers non-NSG data, dirty-versus-committed behavior,
Unicode and JavaScript edge characters, printing fields, optional fields,
oversized payloads, malformed mappings, path traversal, symlink escape, and
production identity changes. The live suite uses a fantasy card to cover
Unicode/RTL/emoji, empty text, overflow preflight, missing layers with an object
inventory, Affinity offline recovery, and repair after a broken config.

## Current boundary

The bridge is universal at the single production-job level. One binding config
currently selects one card/printing/template and exports one PNG. Batch decks,
layout selection by card type, PDF/CMYK/bleed export, multiple inline symbols,
and automatic text-frame fitting are future orchestration work—not capabilities
the current slice pretends to have.

Reverse sync is deliberately excluded. Affinity-originated changes should
become a reviewed Forge proposal, never overwrite canonical card data silently.

The NSG proof lives at
`examples/_fixtures/netrunner-sg/templates/affinity/forge-affinity.json`. Its
source-face patches, fonts, and credit symbol are adapter assets; none are
referenced by the bridge or worker core.
