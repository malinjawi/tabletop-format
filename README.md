# An Open Format for Living Card Games
### v0.1.0 — working draft

Card games deserve source code. Today a living card game's truth is scattered across
spreadsheets, PDFs, Discord pins, and one volunteer's hard drive. Communities like
Null Signal Games, the ArkhamDB family, and BSData already maintain their games as
version-controlled data — on raw GitHub, with tooling they had to invent themselves.

This format makes that workflow a standard: **a game is a directory of diffable,
forkable, renderable files.** Cards diff like code. Ban lists are dated documents.
Errata is a commit. A fork is a fan expansion with its attribution chain intact.

## Design principles

1. **Stable IDs, never positions.** Every card, printing, and set has an opaque ID
   that survives renames and reorders. IDs are what diffs, banlists, and rulings reference.
2. **Two-tier identity** (the Scryfall/NRDB-v2/MTGJSON consensus): a **card** is a
   rules identity; a **printing** is one physical appearance of it in a set. Reprints,
   alt-art, and promos come free.
3. **Data is rows; prose is markdown; binaries are assets.** Card data imports from and
   exports to CSV/spreadsheets losslessly — nobody is locked in, in either direction.
4. **Restrictions are dated, immutable documents.** New ban wave = new file. Formats
   point at the active one. History is never rewritten.
5. **Provenance is first-class.** Every asset declares how it was made (human/AI/mixed)
   and under what license. Required, not retrofitted.
6. **Genre-agnostic core.** `attributes` + `attribute_definitions` mean the same
   machinery describes a duel deck, an LCG — and later, non-card components.

## Layout

```
game.yaml                  # identity, license, authors, attribute defs, symbols
design/brief.json          # optional idea, intended experience, smallest playable slice
design/prototype.json      # optional runnable low-fidelity test and materials list
rules/rules.md             # rulebook as diffable prose
rules/publications/        # designed books: pages, scenes, native sources, output recipe
components/cards.json      # rules identities
components/printings.json  # physical appearances
sets/                      # released groups of printings
formats/                   # ways to play: card pool + active restriction
restrictions/              # dated banlists (immutable once published)
rulings/rulings.json       # dated clarifications with sources
decks/                     # versioned decklists
setups/                    # seats, zones, stacks, placements, counters
templates/                 # layouts + production field maps (versioned rendering)
assets/                    # art & icons (large files via LFS)
```

## Tools (reference implementation, v0.1)

Bootstrap the pinned local toolchain once, then verify it at any time:

```sh
npm run setup:dev   # .venv + pinned PDF/image/schema libraries + npm lockfile install
npm run doctor      # Node, Python, Git, Chromium, and adapter readiness
```

Forge automatically prefers `.venv/bin/python` (or `FORGE_PYTHON`) so browser
exports and CLI exports use the same dependency set.

The current invite-only alpha decision, evidence, operating limits, and
deployment stop conditions are recorded in
[`docs/CONTROLLED-ALPHA-LAUNCH-GATE-2026-09-01.md`](docs/CONTROLLED-ALPHA-LAUNCH-GATE-2026-09-01.md).
The latest requirement-by-requirement beta audit and exact remaining external
inputs are recorded in
[`docs/CONTROLLED-BETA-READINESS-2026-09-02.md`](docs/CONTROLLED-BETA-READINESS-2026-09-02.md).

```
./e2e.sh                                             # 172-check functional integration gate
./journey.sh                                         # 85-assertion two-user golden path
./perf.sh                                            # bounded scale + concurrent-write smoke
./launch-gate.sh                                     # all mandatory controlled-alpha gates
./demo.sh                                            # the whole loop, one command, narrated
node tools/new-game.mjs my-game --title "My Game" --license proprietary --brief brief.json  # idea -> valid game dir
node tools/import-csv.mjs cards.csv my-game --title "My Game"   # spreadsheet -> valid game dir, zero deps
node tools/import-nrdb.mjs nrdb-data my-game --title "My Game"  # NRDB/Alsciende-family JSON -> valid game dir, zero deps
node tools/validate.mjs examples/ember               # schema + referential integrity (needs: npm i ajv ajv-formats js-yaml)
python3 tools/validate.py examples/ember             # identical checks, Python twin
node tools/diff.mjs old-cards.json new-cards.json    # semantic card diff, zero deps
node tools/render_cards.mjs examples/ember           # card faces @300dpi (the exact browser renderer; Chrome required)
python3 tools/export_pnp.py examples/ember           # print-and-play PDF, 3x3 US Letter, crop marks
python3 tools/export_pnp.py examples/_fixtures/netrunner-sg --card sure_gamble --no-back  # one-card source-backed proof
python3 tools/export_tts.py examples/ember           # TTS sheet(s) + save JSON (auto-splits after 70 faces)
node tools/fmt.mjs export vtt examples/my-game       # staged VirtualTabletop.io state + self-contained .vtt
npm run vtt:up                                       # start the pinned local open-source tabletop runtime
node tools/fmt.mjs import decklist examples/ember list.txt --name "Burn Rush" --format standard   # "3 Kindling" lines -> deck.json
node tools/fmt.mjs export nandeck examples/_fixtures/netrunner-sg   # one MM-accurate script + CSV per card family
node tools/fmt.mjs import nandeck-layout examples/_fixtures/netrunner-sg program.txt  # safe dry-run; add --write after review
node tools/fmt.mjs check-deck examples/ember examples/ember/decks/burn-rush.json                  # legality: pool, size, deck limits, BANLIST
```

The deck checker closes the stewardship loop: publish a dated restriction
document and every deck in the community can re-verify itself —
`'Wildfire' is RESTRICTED to 1 copy; deck has 2 → ILLEGAL`.

## Game-aware collaboration over Git

Forge does not compete with GitHub or Forgejo at storing arbitrary repositories.
It keeps standard Git underneath and adds the tabletop-specific layer: semantic
card and component diffs, visual review, rights-aware release gates, reproducible
print/tabletop builds, and browser workflows for collaborators who do not use a
Git client. A complete portable source project can leave Forge at any time.

Your game is a repo, and the tools speak designer, not git:

```
fmt save examples/ember          # commit — THE MESSAGE WRITES ITSELF:
#   Saved: cards: changed 2 cards (Ash Cloak, Bellows)
#     * Ash Cloak: cost 1 -> 2
#     * Bellows: text "...then discard Bellows." -> "..."
fmt history examples/ember       # git log rendered as card changes
fmt changelog examples/ember     # CHANGELOG.md generated from history
fmt release examples/ember 0.3.0 # tag with card changes since last release
fmt fork src.git dst.git         # server-side fork — the Remix primitive
fmt setup                        # plain `git diff` becomes a semantic card diff
./fork-demo.sh                   # full loop: publish → fork → PR review → merge
```

Real git underneath — clone, branch, push anywhere. The porcelain just makes
the history read like a designer's changelog instead of a hash pile.

## The platform server (v0)

```
node server.mjs            # http://localhost:8420 — zero dependencies
```

A live HTTP server over the game repos: the hub UI at `/`, a REST API at
`/api/games/...` (cards, history, stats, validation, credits, exports), and
the part that makes it a platform — **`PUT /api/games/:slug/cards` validates,
then commits, with the message auto-written from the semantic diff.** Invalid
writes get a 422 and a rollback; history is served as card changes. Games are
discovered by scanning for `game.yaml` — drop a new game dir in, it's live.
These are the exact verbs the production backend (headless Forgejo) will
speak; the contracts are proven here against plain git first.

`demo.sh` runs: import a designer's CSV → validate → render → PnP PDF + TTS mod →
apply a balance patch → semantic diff. Spreadsheet to playable-and-printable in
under a minute, with version control semantics at the end.

The validator enforces what schemas alone can't: every printing points at a real card
and set, banned cards exist, attributes match their declared types, symbols in card
text are declared, set sizes match their printings.

### Google Sheets as a working copy

Forge does not replace Sheets collaboration or version history. A published Sheet
can be attached from a game's Cards page, and a bound Apps Script proof of concept
in [`integrations/google-sheets`](integrations/google-sheets) adds the same status
inside private Sheets. **Check draft changes** compares playable objects with the
last Forge candidate, renders semantic and visual diffs, validates the complete
game tree, and then commits only the exact reviewed snapshot. Stable `id` columns
keep renamed cards attached to their histories. See
[`docs/google-sheets-sync.md`](docs/google-sheets-sync.md) for the boundary and
installation instructions. The connector contract, real `Code.gs` harness, and
a Google-hosted private-Sheet OAuth → attributed commit smoke test are green.
A stable HTTPS deployment and packaged Workspace add-on remain production gates.

### Production templates

`templates/production.json` maps canonical card fields to named objects in a
portable SVG once. The live editor, visual diffs, PNG/PnP exports, and optional
native-editor adapters consume that same contract, so a field cannot be
"editable in Affinity" but unsupported in Forge. Unmapped changes fail closed
and name the exact missing path. See
[`docs/production-templates.md`](docs/production-templates.md).

### Designed rulebook publications

`rules/publications/manifest.json` registers learn-to-play books, references,
scenario books, and player aids as versioned production assets. The portable
page model links cards and setup scenes rather than pasting screenshots; Forge's
visual editor can move blocks and edit content, while Affinity Publisher,
InDesign, Scribus, and HTML/CSS remain explicit adapter surfaces. Builds freeze
a print PDF, web book, preflight receipt, and deterministic source package at
the exact game commit. See
[`docs/rulebook-publications.md`](docs/rulebook-publications.md).

### Production source packages

`assets/manifest.json` groups the actual editable inputs behind a game—card
families, native 2D documents, rulebook publications, boards, audio, fonts,
table setups, and optional 3D models. Forge verifies every declared path,
hashes the package inputs, shows the owning editor and import/export direction,
and carries declared source bytes through the portable project format. Native
files remain byte-preserved rather than falsely “converted.” Distribution is
still enforced per file by `forge/rights.json`. See
[`docs/source-asset-packages.md`](docs/source-asset-packages.md).

### Source-backed PnP faces

When a community publishes composed PnP faces but not editable production files,
`templates/source-overlay.yaml` can map semantic fields onto immutable scans.
Verified per-card numeric patches preserve the source treatment instead of
approximating the original typography; uninspected cards, unsupported fields,
and unavailable values fall back visibly to the distinct community frame. The
System Gateway private proof includes card-specific examples for cost, memory,
strength, trash, advancement, and agenda-point fields. See
[`docs/source-backed-pnp.md`](docs/source-backed-pnp.md).

The diff tool matches cards by stable ID and reports *meaning*, not JSON noise:

```
Wildfire  (wildfire)
  ~ attributes.cost: 4 → 3
  ~ attributes.power: 5 → 4
Smoke Veil  (smoke_veil)
  + added
```

## Examples

- `examples/ember/` — a complete 2-player microgame (CC0) exercising every part of the
  format: 8 cards, 10 printings across 2 sets (including an alt-art reprint), a format
  with a card pool, a dated restriction list with designer notes, and sourced rulings.
- `examples/harbor-nine/` — born entirely from `examples/harbor-nine.csv` via the CSV
  importer; regenerate it with `demo.sh`.
- `examples/netrunner-urbp/` — **real Null Signal Games data** (a 7-card pack from
  [netrunner-cards-json](https://github.com/Null-Signal-Games/netrunner-cards-json))
  imported losslessly via `import-nrdb.mjs`: NRDB's `[credit]`-style symbol tags,
  " - "-joined keywords, and per-pack card entries map directly onto our symbols,
  subtypes, and two-tier card/printing model. Existing stewardship communities can
  migrate without touching their data. (Card text/names belong to NSG — fixture
  included for interoperability testing; the importer sets `license:
  imported-see-source` to force a deliberate licensing decision before publishing.)

## Spec notes (learned the hard way)

- YAML dates MUST be quoted strings (`"2026-07-01"`) — YAML loaders otherwise coerce
  them to native date objects and break interchange.
- `subtypes`/`keywords` are arrays, never joined strings (NRDB v1's lesson).
- `collector_number` is a string (`"042a"` exists).

## Status & license

Format spec + schemas: **v0.1.0, draft** — breaking changes possible until v1.0;
`format_version` in every game.yaml and a migration policy from day one.
License: schemas and tools Apache-2.0; this spec text CC0; example game CC0.
Game content made *with* the format is licensed per-project by its authors.
