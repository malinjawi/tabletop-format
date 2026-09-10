# Card design engine adapters

Forge now treats a card renderer as a version-controlled adapter, not as the
game's source of truth. Canonical card content remains in
`components/cards.json`; a renderer turns that committed snapshot into editable
templates, previews, and print outputs.

Every adapter sits on top of the universal `.forge-project.zip` interchange
described in `docs/forge-design-projects.md`. This keeps editor-specific files
at the edge: a new editor adapter does not redefine cards, printings, merge
semantics, or version history.

`templates/card-design/engines.yaml` selects exactly one active engine. Games
that only have `templates/card-design/manifest.yaml` continue to work through an
inferred `forge-native` engine, so adopting the registry is not a migration.

```yaml
version: 1
active: forge-native
engines:
  - id: forge-native
    type: forge-native
    source: templates/card-design/manifest.yaml
    status: active
  - id: pnpink-working-copy
    type: pnpink
    source: templates/card-design/experiments/pnpink/manifest.yaml
    status: beta
```

The System Gateway fixture includes a PnPInk v0.57 working-copy adapter for all
11 declared card families. It does not replace the production renderer.
Generate the deterministic suite with:

```sh
node tools/export-pnpink.mjs examples/_fixtures/netrunner-sg /tmp/netrunner-pnpink
```

The suite contains one portable `.pnp` project per family, plus inspectable SVG,
CSV, and provenance files. Each CSV is derived from the exact committed cards;
each SVG is a versioned external production source. Open one family project in
PnPInk/Inkscape, edit its linked data or SVG, then return that family `.pnp` and
inspect the proposed Forge change without writing anything:

```sh
node tools/import-pnpink.mjs examples/_fixtures/netrunner-sg /path/to/netrunner-sg-program.pnp
```

Returning CSV alone is supported for a data-only change. Returning `.pnp`
compares both the card fields and SVG source with their embedded baseline.
Card fields use a field-level three-way merge; the SVG uses a byte-level merge.
The hosted Design page shows the same dry run and then either commits directly
or commits to the user's fork and opens a pull request. The CLI `--write` writes
the analyzed files but deliberately does not commit.

## Promotion gate

An experimental engine must not become active until it passes all of these:

1. Every supported card family binds a stable Forge card ID and all editable
   fields without losing types, line breaks, Unicode, or symbols.
2. Exporting the same commit twice produces byte-identical source packages.
3. Export, edit, import, and re-export produce the expected semantic diff only.
4. The SVG reopens in the pinned editor version and produces print output with
   the declared dimensions, bleed, fonts, and color handling.
5. Representative cards pass a visual comparison against the active renderer.
6. Existing releases and the Forge-native renderer remain unchanged behind a
   feature flag during staged migration.

PnPInk is still beta and its package/DSL may change. Pin the tested upstream tag
in the adapter manifest. Generated PDF/PNG output remains an artifact; commit
canonical Forge data, the adapter manifest, external SVG sources, declared
assets, and the tool pin. Forge does not bundle or execute Inkscape/PnPInk on the
server, and an external SVG never becomes the active Forge renderer implicitly.

## nanDECK adapter

nanDECK is the first family-complete text-layout adapter. It is generated for
every game by `fmt export nandeck`; games with composable design systems receive
one script per family, while games without a layout receive an honest generic
candidate rather than a claim of production fidelity. The universal Forge
project includes the same scripts under `adapters/nandeck/`. The hosted Design
page additionally exposes these files as a lightweight, commit-pinned ZIP so a
layout designer does not need to download the complete artwork project.

The exporter declares `UNIT=MM` before `CARDSIZE` and coordinates. This matters:
nanDECK defaults to centimeters when `UNIT` is absent. Text, images, rectangles,
circles/badges, fonts, percent/absolute geometry, and the supported Forge
condition language are translated. CSS gradients, masks/clip paths, symbol
composition, secondary flowing text, and unsupported region types remain in
the Forge renderer and are listed in `manifest.json`; they are never silently
dropped from the canonical source.

`fmt import nandeck-layout <game> <family.txt>` is a dry-run. `--write` applies
only fields changed from the adapter's projected baseline, conflicts if Forge
changed the same source field, and preserves YAML comments through a concrete
syntax tree. In the browser, the identical analyzer commits directly for a
maintainer or commits to a fork and opens/refreshes a pull request. Its dry-run
also renders before/after specimens and expands shared-component changes to all
affected card families.
