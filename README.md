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
rules/rules.md             # rulebook as diffable prose
components/cards.json      # rules identities
components/printings.json  # physical appearances
sets/                      # released groups of printings
formats/                   # ways to play: card pool + active restriction
restrictions/              # dated banlists (immutable once published)
rulings/rulings.json       # dated clarifications with sources
templates/                 # layout templates (rendering, not interchange)
assets/                    # art & icons (large files via LFS)
```

## Tools (reference implementation, v0.1)

```
./e2e.sh                                             # 35-check integration test — ALL GREEN or it doesn't ship
./demo.sh                                            # the whole loop, one command, narrated
node tools/import-csv.mjs cards.csv my-game --title "My Game"   # spreadsheet -> valid game dir, zero deps
node tools/import-nrdb.mjs nrdb-data my-game --title "My Game"  # NRDB/Alsciende-family JSON -> valid game dir, zero deps
node tools/validate.mjs examples/ember               # schema + referential integrity (needs: npm i ajv ajv-formats js-yaml)
python3 tools/validate.py examples/ember             # identical checks, Python twin
node tools/diff.mjs old-cards.json new-cards.json    # semantic card diff, zero deps
python3 tools/render_cards.py examples/ember         # card faces @300dpi (reference renderer; Pillow)
python3 tools/export_pnp.py examples/ember           # print-and-play PDF, 3x3 US Letter, crop marks
python3 tools/export_tts.py examples/ember           # TTS sprite sheet + save JSON (CardID math, quantities)
node tools/fmt.mjs import decklist examples/ember list.txt --name "Burn Rush" --format standard   # "3 Kindling" lines -> deck.json
node tools/fmt.mjs check-deck examples/ember examples/ember/decks/burn-rush.json                  # legality: pool, size, deck limits, BANLIST
```

The deck checker closes the stewardship loop: publish a dated restriction
document and every deck in the community can re-verify itself —
`'Wildfire' is RESTRICTED to 1 copy; deck has 2 → ILLEGAL`.

## Git for board games (the point of all this)

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

`demo.sh` runs: import a designer's CSV → validate → render → PnP PDF + TTS mod →
apply a balance patch → semantic diff. Spreadsheet to playable-and-printable in
under a minute, with version control semantics at the end.

The validator enforces what schemas alone can't: every printing points at a real card
and set, banned cards exist, attributes match their declared types, symbols in card
text are declared, set sizes match their printings.

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
