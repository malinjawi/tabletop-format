# Designed rulebook publications

Forge treats a published rulebook as a first-class game asset. Rules prose,
page composition, diagrams, linked cards, native publishing files, export
settings, and the final PDF can move through forks and pull requests together.

This is separate from `rules/pipeline.yaml`, which connects a comprehensive
rules source to its native formatter. A game may have both:

```text
rules/pipeline.yaml                     comprehensive reference rules
rules/publications/manifest.json        publication registry
rules/publications/learn-to-play/
  publication.json                     portable page composition
  native/                              optional .afpub/.indd/.idml/.sla files
  assets/                              book-only linked art and diagrams
```

## Portable document

`publication.json` uses percentage geometry within a declared physical trim
size. A block therefore has the same basic contract as a card layout region:

```json
{
  "id": "run-example",
  "type": "scene",
  "x": 43,
  "y": 19,
  "w": 52,
  "h": 67,
  "placements": [
    {
      "id": "outer-ice",
      "kind": "card",
      "card_id": "palisade",
      "x": 46,
      "y": 38,
      "w": 26,
      "h": 36,
      "rotate": 90
    }
  ]
}
```

The page points to `card:palisade`; it does not contain a pasted card image.
When that card changes, the publication rebuild uses the exact face from the
same game commit. Forge can also identify which pages depend on the changed
object.

Supported portable blocks in version 1 are headings, prose, callouts, cards,
card grids, stateful scenes, numbered steps, component lists, rule references,
images, and footers. Native publishing packages remain valid source assets for
features the portable model does not yet express.

## Editor adapters

`rules/publications/manifest.json` declares every supported authoring surface:

- `forge-layout`: Forge's direct page and content editor.
- `html-css`: deterministic portable web output.
- `affinity-publisher`: an optional native `.afpub` package.
- `indesign`: an optional InDesign/IDML package.
- `scribus`: an optional open Scribus package.

The registry records whether an adapter is native, import-only, export-only,
or non-roundtripping. Forge does not claim a lossless round trip when the
external format cannot provide one.

## Build and preflight

Build a publication directly:

```bash
node tools/build-rulebook-publication.mjs GAME_DIR OUTPUT_DIR
```

For the System Gateway proof:

```bash
npm run build:rulebook-publication
```

The immutable build contains:

- a print PDF with MediaBox, BleedBox, TrimBox, and CropBox values;
- a self-contained web publication;
- a JSON preflight receipt;
- a deterministic portable source package.

Preflight checks page geometry, card references, linked files, rendered text
overflow, page count, trim, bleed, and PDF boxes. The server caches these files
under the exact game commit, just like card and tabletop exports.

## Visual review and commits

The Rules tab shows designed pages and their object dependencies. The visual
designer supports page selection, direct block dragging, geometry controls,
live text changes, linked-card selection, block creation and duplication, and
raw JSON access. **Commit publication** validates the candidate game tree and
writes one Git commit. A contributor without write access makes the changes in
their edition and proposes the source files through the normal pull-request
flow.

The comprehensive rules generator remains available from **Reference rules**.
It is a different publication with a different job, not a fallback rendering of
the learn-to-play book.
