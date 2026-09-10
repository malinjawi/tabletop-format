# Forge design projects

A `.forge-project.zip` is the editor-neutral handoff between Forge and the
tools a team already uses. It is not a second game format and it is not a pile
of generated print files. The package carries the exact editable inputs needed
to propose a source change back to Forge.

Hosted artifact filenames carry a package revision (currently `-v7`) so adding
new adapter contents never overwrites an older immutable download URL.

The browser also offers a much smaller `<game>-nandeck-v1.zip` when layout work
is the only job. That kit contains only the family scripts, adjacent CSV files,
README, and fidelity manifest. It is frozen at the same Git commit and uses the
same importer as the copy embedded in the full project.

## What is inside

- `editable/cards.csv` and `editable/printings.csv` for Sheets, Excel, scripts,
  or database tools. Rows use stable IDs and preserve declared data types.
- `project/components/*.json`, including non-card component inventories, plus
  `project/decks/**`, `project/formats/**`, `project/restrictions/**`,
  `project/rulings/**`, `project/sets/**`, and `project/setups/**`. These keep
  the playable game and its table setup attached to the card data.
- `project/design/**` and `project/rules/**`: design intent and editable
  rulebook sources.
- `project/templates/**` and their referenced `project/assets/**`: layout
  families, reusable components, SVG/CSS, fonts, symbols, and editor adapters.
- `base/components/*.json` and hashes in `manifest.json`, used only as the
  immutable three-way merge baseline.
- `adapters/nandeck/**`: one adjacent CSV + `UNIT=MM` script per compiled card
  family, an explicit fidelity report, and Forge region/source metadata.
- `adapters/pnpink/**`, when configured: the same pinned PnPInk family suite
  available from the Design page, including portable `.pnp`, CSV, SVG source,
  embedded baseline, and upstream tool version.

Large per-card artwork is omitted by default. Use `--with-art` for an offline
package that also includes artwork referenced by printings.

Rights declarations (`forge/rights.json`), community governance, discussion,
and generated exports are intentionally outside this editor handoff. They stay
in the repository and release receipt, but an external layout editor cannot
silently rewrite them during import.

## Normal pipeline

```sh
fmt export project games/my-game work/my-game
# Edit work/my-game/editable/cards.csv and/or work/my-game/project/templates/**
fmt import project games/my-game work/my-game/my-game.forge-project.zip
fmt import project games/my-game work/my-game/my-game.forge-project.zip --write
fmt save games/my-game
```

Import is a dry-run unless `--write` is present. Forge compares each proposed
field with both the exported baseline and current HEAD. Different fields merge;
the same field changed on both sides becomes a conflict. CSV and canonical JSON
may both be present, but changing them differently is also a conflict.

Deletions require `--allow-delete`. Browser import uses the same analysis,
shows the semantic diff first, validates a temporary candidate tree, and then
creates one atomic Git commit.

## Adapter boundary

An editor-specific bridge consumes this universal package and returns changes
to it. The PnPInk bridge derives every family `.pnp` from the same project source
hash and can return card fields plus its versioned SVG source. Affinity, nanDECK,
Dextrous, Component Studio, or a custom script can each have a thin adapter
without becoming Forge's canonical data model.

The shared card back is a versioned project-level layout asset too. Forge
Studio edits its declarative layers directly and lets a designer choose or
upload the shared artwork through the same rights-aware library used by card
fronts. Artwork bytes, provenance, layout binding, and the all-family visual
impact enter one candidate. The SVG family kit preserves and three-way merges
that back metadata. The current family SVG does not expose shared back layers
as editor objects; this boundary is declared in its manifest instead of
claiming a lossless native-editor round trip.

## PnPInk / Inkscape family round-trip

Download the PnPInk suite from **Card design → Inkscape + PnPInk** and open one
family `.pnp` using the pinned PnPInk version in its manifest. The package keeps
the generated CSV, SVG, stable card IDs, field map, and exact export baseline
together. Return that one `.pnp`; returning the complete suite is rejected to
avoid changing unrelated families accidentally.

Forge dry-runs card fields with a field-level three-way merge and the SVG source
with a byte-level three-way merge. It renders changed card data in the active
Forge engine, calls out an external-template change separately, sanitizes SVG,
validates the full candidate game, and creates either a direct commit or a fork
and pull request. The external SVG remains a source asset until a maintainer
explicitly promotes an adapter to the active release renderer.

The manifest contract is documented by
`schemas/forge-project.schema.json`. The ZIP is deterministic: identical game
source produces identical package bytes, which makes packages cacheable and
auditable by commit.

## nanDECK family round-trip

Open `adapters/nandeck/<game>-<family>.txt` from the exported kit. The script
links the adjacent family CSV and carries `; FORGE_META` / `; FORGE_REGION`
comments. Keep those comments when editing: they identify the source component,
the canonical baseline, and the value the lossy adapter actually displayed.

Return the `.txt` through **Card design → Return edited script**. Before it can
write, Forge shows semantic fields plus before/after cards rendered by the same
engine used for print output. If a shared component or system setting changed,
the review identifies every affected family instead of pretending the edit is
local to the opened script. Forge then performs a field-level three-way merge,
reports every unsupported directive/fidelity fallback, validates the complete
candidate game, and makes either a direct commit or a commit on the user's fork
plus a pull request. A no-op round-trip produces no files and no commit. `LINK`,
`FOLDER`, expressions, and arbitrary nanDECK program features are never executed
server-side; the importer only parses a bounded declarative layout subset and
caps scripts at 2 MB.
