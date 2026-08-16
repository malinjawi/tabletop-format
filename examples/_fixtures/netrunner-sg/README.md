# netrunner-sg (internal test fixture)

**This is an internal test fixture for the tabletop-format platform, not a
game published or hosted by this project.** It exists to stress-test the
platform's schema and tooling (`tools/validate.py`, `tools/render_cards.py`,
`tools/check_deck.py`) against a real, structurally rich trading card game.

## Provenance

- **Rules and card data**: Android: Netrunner / Netrunner, designed by
  Fantasy Flight Games and continued by Null Signal Games (NISEI). All card
  names, card text, flavor, faction names, and game rules are the
  intellectual property of their respective rights holders.
- **Source of the data in this directory**: fetched live from
  [NetrunnerDB](https://netrunnerdb.com/)'s public JSON API
  (`https://raw.githubusercontent.com/NetrunnerDB/netrunner-cards-json/master/pack/sg.json`
  for the 77 System Gateway cards, and
  `https://netrunnerdb.com/api/2.0/public/mwl` for the current banlist), on
  2026-08-16. NetrunnerDB's card data is maintained by its community and
  distributed under **CC BY-NC** (non-commercial) terms.
- **What was ported**: all 77 System Gateway cards (`components/cards.json`,
  `components/printings.json`), the current live "Standard Balance Update
  26.08" banlist entries that touch System Gateway cards
  (`restrictions/standard-2026-08.yaml`), one set record, one format, two
  sample decks, and a condensed rulebook written from general knowledge of
  the published rules (not copied from any single rules document).
- **Completeness**: this is essentially the *entire* System Gateway card
  pool (77/77 cards, matching the real 205-card physical print run once
  per-card quantities are counted) — nothing was skipped or abbreviated for
  space. What is *not* included is anything outside System Gateway: no other
  cycles/packs, no errata history beyond the single current banlist
  snapshot, no card images/illustrations (art fields are intentionally
  omitted — see WHAT-BROKE.md), and no official rulebook text verbatim.

## Do not

- Do **not** host, publish, or distribute this fixture as a playable
  product, on this platform or elsewhere.
- Do **not** treat `license: Proprietary` in `game.yaml` as this project's
  claim of ownership over Netrunner. It is a placeholder required because
  the schema's `license` field is mandatory; see the comment directly above
  it in `game.yaml`.
- Do **not** copy this directory into `examples/` (non-`_fixtures`) or any
  discovery/hub surface — it is scoped to `_fixtures/` specifically because
  it is not an original, freely licensed game like the other `examples/*`.

## What this fixture is for

Netrunner exercises corners of the format that a simpler original game
(like `examples/ember`) does not: two structurally different deck "sides"
sharing one card pool, influence-based deckbuilding, per-identity minimum
deck sizes, singleton (1-of) cards mixed with 3-of cards in the same set,
a real banlist with live bans, and rules text dense with inline symbols.
See `WHAT-BROKE.md` in this directory for everything that did not fit
cleanly.
