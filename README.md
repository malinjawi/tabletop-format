# An Open Format for Living Card Games

Using the Forge app? Start with the [Creator guide](docs/CREATOR-GUIDE.md) or [Connectors and file handoffs](docs/CONNECTORS.md). Both are available from **Help** inside Forge.
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
./e2e.sh                                             # 186-check functional integration gate
./journey.sh                                         # 96-assertion two-user golden path
./perf.sh                                            # bounded scale + concurrent-write smoke
./launch-gate.sh                                     # all mandatory controlled-beta gates
./demo.sh                                            # the whole loop, one command, narrated
node tools/pilot-invite.mjs create --db data/platform.db --label "Pilot creator" --cohort beta-01  # expiring single-use admission
node tools/pilot-account.mjs reset --db data/platform.db --handle pilot-creator  # one-use assisted password recovery
node tools/pilot-account.mjs suspend --db data/platform.db --handle pilot-creator --operator "Pilot operator" --reason "participant requested access pause"  # reversible offboarding
node tools/pilot-account.mjs policy --db data/platform.db --handle pilot-creator --require-current  # verify the stored registration receipt
node tools/new-game.mjs my-game --title "My Game" --license proprietary --brief brief.json  # idea -> valid game dir
node tools/import-csv.mjs cards.csv my-game --title "My Game"   # spreadsheet -> valid game dir, zero deps
node tools/import-nrdb.mjs nrdb-data my-game --title "My Game"  # NRDB/Alsciende-family JSON -> valid game dir, zero deps
node tools/validate.mjs examples/ember               # schema + referential integrity (needs: npm i ajv ajv-formats js-yaml)
python3 tools/validate.py examples/ember             # identical checks, Python twin
node tools/diff.mjs old-cards.json new-cards.json    # semantic card diff, zero deps
node tools/render_cards.mjs examples/ember           # card faces @300dpi (the exact browser renderer; Chrome required)
python3 tools/export_pnp.py examples/ember           # print-and-play PDF, 3x3 US Letter, crop marks
python3 tools/export_pnp.py examples/_fixtures/netrunner-sg --card sure_gamble --no-back  # one-card source-backed proof
python3 tools/export_tts.py examples/ember           # staged TTS save + card sheets + versioned component textures/receipt
node tools/fmt.mjs export vtt examples/my-game       # staged VirtualTabletop.io state + self-contained .vtt
npm run vtt:up                                       # start the pinned local open-source tabletop runtime
node tools/fmt.mjs import decklist examples/ember list.txt --name "Burn Rush" --format standard   # "3 Kindling" lines -> deck.json
node tools/fmt.mjs export nandeck examples/_fixtures/netrunner-sg   # one MM-accurate script + CSV per card family
node tools/fmt.mjs import nandeck-layout examples/_fixtures/netrunner-sg program.txt  # safe dry-run; add --write after review
node tools/fmt.mjs export pnpink examples/_fixtures/netrunner-sg /tmp/netrunner-pnpink # pinned Inkscape/PnPInk .pnp per family
node tools/fmt.mjs import pnpink examples/_fixtures/netrunner-sg /tmp/netrunner-pnpink/families/program/netrunner-sg-program.pnp # dry-run; add --write after review
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

The browser CSV path accepts ordinary designer headers rather than demanding a
Forge-shaped file. Before project creation it shows every source-column mapping,
three representative normalized cards, inferred custom-field types, ignored
columns, and whether permanent IDs can survive renames. The create action stays
disabled until that exact mapping validates. Forge then commits the normalized
snapshot and a receipt containing the original source hash, original headers,
reviewed mapping, normalization hash, warnings, and identity result. Mapping
choices are remembered by header shape without retaining unpublished CSV rows.

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
The sidebar now verifies the public endpoint and commit access before attachment,
preserves a resumable setup without storing the password, rolls back a failed
attachment, and gives dead localhost/tunnel connections an explicit recovery
path. A stable HTTPS deployment, current live-Sheet qualification, and packaged
Workspace installation remain production gates. Operators build the pinned,
checksummed private-beta source with `npm run package:sheets-addon`; see
[`docs/google-sheets-deployment.md`](docs/google-sheets-deployment.md).

### Production templates

`templates/production.json` maps canonical card fields to named objects in a
portable SVG once. The live editor, visual diffs, PNG/PnP exports, and optional
native-editor adapters consume that same contract, so a field cannot be
"editable in Affinity" but unsupported in Forge. Unmapped changes fail closed
and name the exact missing path. See
[`docs/production-templates.md`](docs/production-templates.md).

The Design workspace now starts with the actual production path: edit a shared
family in Forge, or take a commit-pinned working copy to Dextrous, Component
Studio, Sheets, PnPInk/Inkscape, Affinity/Illustrator/Inkscape, nanDECK, or a
version-pinned Squib CSV/YAML/Ruby kit whose returned code Forge never executes. The
first-component wizard turns an empty idea into stable card rows, typed fields,
a reusable front, a shared back, and trim/bleed geometry as one reviewed commit.
The deck-scale table keeps those IDs read-only while supporting multi-row
selection, typed matrix paste from Sheets, fill-down, and keyboard navigation;
invalid pasted cells reject the complete matrix before the local draft changes.
The artwork picker stores searchable project tags in
`design/art-library.json`, can explicitly target multiple printing IDs, and
reviews those assignments beside the asset bytes, artist credit, rights, crop,
card data, and shared layout. Library records merge independently by asset path;
same-asset concurrent edits stop for review. See
[`docs/versioned-artwork-library.md`](docs/versioned-artwork-library.md).
The small table package carries card, printing, and piece data because CSV cannot
preserve an external application's layout; the full project carries every declared
portable source. Both return through a three-way dry run before one commit or
credited pull request. The product contract and acceptance gate are in
[`docs/CARD-DESIGN-PRODUCTION-MILESTONE.md`](docs/CARD-DESIGN-PRODUCTION-MILESTONE.md).

### Versioned card print profiles

`templates/print.yaml` makes output choices part of the game instead of hidden
export-time state. The Design workspace can select all cards or permanent card
IDs, resolve their physical printings and quantities, choose fronts-only or
mirrored-duplex A4/Letter sheets, set a gutter and crop-mark style, fit Japanese
opaque-sleeve inserts, and include or omit the shared back in the one-face-per-page
press candidate. Review validates the entire candidate without writing; commit
checks the reviewed base ref again. A contributor receives an attributed edition
commit and a pull request rather than a permission error. New card systems receive
the balanced duplex profile in their first atomic commit.

### Versioned playable builds

The Decks workspace is now an actual authoring surface rather than a read-only
legality report. A creator can compose a deck visually, select the exact
printing or alt-art face for every card, see format legality before writing,
and commit either a legal build or an explicitly marked work in progress.
Permanent card IDs and physical printing IDs remain separate, and their counts
must reconcile. **Plan exact print run** carries that build into the versioned
print profile so no unselected face or source quantity leaks into the release.
See [`docs/playable-builds.md`](docs/playable-builds.md).

The first named service target is **The Game Crafter Poker Deck**. Forge checks
63.5 × 88.9 mm trim, emits individual 825 × 1125 pixel RGB PNG fronts and back,
and records each file's dimensions, DPI, and hash in the release preflight. It
is a specification-checked file handoff, not a claimed account integration or
printer certification. See [`docs/print-targets.md`](docs/print-targets.md).

`tools/export_print_ready.py` consumes that profile and puts it, the exact source
ref, and `preflight.json` in the frozen ZIP. Preflight reopens each PDF to check
page counts, embedded PDF-owned text fonts, and press TrimBox/BleedBox; it also
records 300 DPI sRGB face mode and 100% K vector crop marks/notices. Forge does
not turn generic RGB into an unlabeled “press ready” claim. A maintainer can
instead upload the receiving printer's CMYK output ICC as a rights-tracked asset
and commit its condition identifier, rendering intent, and total-ink limit. Forge
then converts every face through that exact profile, measures every pixel, embeds
the profile once as the output intent, and creates a structurally preflighted
PDF/X-1a:2003 candidate. It still requires receiving-printer or independent
prepress approval. The same versioned profile can add a printer-named spot-color
cut path derived from committed trim/radius geometry; Forge verifies that every
requested page contains a full-tint Separation stroke with stroke overprint.
Printer-specific templates and approval still remain external evidence.

After a release, the owner can record which frozen PDF or print ZIP was sent to
which printer/job. Forge copies the artifact SHA-256 and byte count from the
immutable release receipt, hashes private submission/approval evidence locally
in the browser, and allows one append-only approved or rejected decision. The
downloadable receipt always identifies this as creator-recorded evidence—not
printer identity verification or independent certification.

Published bytes are sealed before the protected Git tag is created into a
separate content-addressed release vault; they are never served from the
disposable render cache once sealed. Release downloads are tag-addressed, so
two releases made from the same source commit can retain different, independently
verified output bytes. Native v2 manifests also seal the release title, notes,
publisher credit, rights, build recipe, artifact report, activity event, and
timestamps. That envelope lets Forge resume a crash immediately after sealing
without consulting a newer project HEAD or exporter. `publisher` is the human
Forge identity receiving credit; Forgejo may record its authenticated repository
actor as the Git tagger, so Forge binds the live tag object, target, protection,
message, and manifest marker without claiming those identities are the same.
Missing, mixed, or corrupt evidence fails closed instead of silently running a
newer exporter. `npm run release:vault -- audit --vault-dir …`
checks the store, while `migrate` dry-runs receipt-verified preservation of a
legacy release before `--apply`. The filesystem driver is application-enforced
append-only—not storage-provider WORM—and its dedicated backup remains required.

### Component production studio

`components/tokens.json` is the stable inventory for non-card pieces and
`templates/component-design.json` contains reusable visual families. Forge
Piece Studio edits quantities, physical sizes, family bindings, colors,
typography, symbols, and art against a live piece, then reviews and validates
the inventory and shared design in one atomic commit. The `components` export
freezes editable SVG faces, bleed, explicit trim lines, quantity-aware A4 or
Letter cut sheets, hashes, and production boundaries at the exact source ref.
Each reusable family also has a millimetre-native SVG working copy for
Inkscape, Affinity Designer, or Illustrator: moving/resizing named regions and
changing flat family colors returns through a visual dry run and one commit.
Bindings, type, symbols, art, typography, physical sizes, and production
settings remain canonical and cannot be silently replaced by arbitrary SVG.
The versioned Sheet setup controls expose A4/Letter paper, bleed, safe inset,
page margin, piece gap, and poster overlap without editing JSON. The selected
safe inset appears as a green preview guide and preflights text/symbol regions,
but is deliberately absent from printed faces; the remaining values directly
drive cut-sheet packing and oversized-piece tiling.
Review now builds a non-writing manufacturing proof from the complete local
candidate before enabling its commit. The server runs the normal project
validator and the same production renderer used by exports, then returns the
first front sheet, mirrored back sheet, and poster tile with page and quantity
totals. SVG is displayed as an image rather than injected as page markup. A
failed proof keeps the commit disabled, and a successful proof does not advance
Git or dirty the repository. Preview and commit both pin the ref from which the
studio opened, so a concurrent component change is rejected instead of being
silently overwritten.
New pieces begin in a guided picker for tokens, counters, tiles, dial faces,
boards, standees, and player aids. Each preset selects an appropriate family
and useful starting dimensions while keeping every field editable; presets are
authoring conveniences, not manufacturer guarantees or proprietary dielines.
The inspector names every piece affected by a shared family edit. A creator can
detach one piece into a new versioned family before changing its appearance;
explicit family bindings take precedence over kind-based defaults and the new
family lands with the piece change in the same review and commit.
Counter starting values and dial start/maximum/step values are edited as
versioned component data. Forge renders counter faces and up to 36 labelled
dial positions with a center-hole assembly guide in both the live proof and the
exact production SVG; the physical pointer, spindle, or rivet remains external.
Piece Studio also accepts front or reverse artwork directly. Uploading a file
assigns it to the selected piece and records creator, license, rights status,
source, and redistribution permission in one commit; exact component kits pin
the source-asset hash and declaration alongside the rendered face hash.
The first vertical slice covers tokens, counters, tiles, and dials while keeping
boards and other large pieces in the same extensible registry. A piece may also
declare a reverse face, including a distinct same-size family, symbol, and art.
Forge previews both sides and emits paired SVG faces plus horizontally mirrored
back sheets for long-edge duplex printing; the manifest tells the printer to
run a one-page alignment proof because feed variance is outside Forge's control.
For pieces declared per player, Piece Studio records the kit player count as a
versioned production setting. Cut sheets multiply those quantities
deterministically and the manifest keeps both declared and resolved counts;
legacy projects without a selection remain readable and are flagged unresolved.
Boards and other pieces larger than the selected paper size are no longer
dropped from the kit: Forge emits deterministic poster tiles with a versioned
overlap, row/column labels, assembly crosses, and source-coverage coordinates.
When a game has a versioned `setups/*.yaml` document, Piece Studio can stage a
selected component on that table and commit its position, quantity, face, and
rotation atomically with the inventory and design. The production ZIP freezes
a top-down SVG setup map and names the setup source in its manifest. This is an
authoring and release proof: the current VTT adapter does not yet auto-stage
non-card components.
These remain SVG working output and require a 100%-scale printer proof; Forge
does not pretend to correct hardware margins or feed scaling.

The Tabletop Playground adapter emits a self-contained local package from the
same exact ref: stable object-template GUIDs, capped card atlases, reusable
component textures, initial counter markers, and a native `.vts` state with the
committed decks and placements already on the table. The archive includes its
source ref, rights boundary, package GUID, schema revision, hashes, and install
instructions. Forge does not claim or perform a mod.io upload; that remains a
reviewed action in the Tabletop Playground editor. Custom dice fail closed
until a model and face-orientation map are committed. See
[`docs/tabletop-playground-adapter.md`](docs/tabletop-playground-adapter.md).

The Tabletop Simulator adapter does stage them. It uses the first versioned
setup when one exists, creates its deck stacks and explicit card placements,
maps component placements into TTS coordinates, lays out remaining component
inventory as supplies, and emits zone/component snap points. Token, tile,
board, standee, standard-die, and dial behavior is selected from component kind
rather than hard-coded to a game. Every hosted texture uses the immutable
release ref; `tts-manifest.json` records its hash, source setup, placement, and
rights dependencies. Custom-art dice fail closed until a validated atlas and
rotation map exist. See [`docs/tabletop-simulator-adapter.md`](docs/tabletop-simulator-adapter.md).

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
