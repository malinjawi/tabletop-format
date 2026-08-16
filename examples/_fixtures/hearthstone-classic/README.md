# Hearthstone: Classic — format test fixture

**This is a TEST FIXTURE, not a published game.** It exists to exercise
this repo's tabletop format (schemas + `tools/validate.py`,
`tools/render_cards.py`, `tools/check_deck.py`) against a real, well-known
digital CCG whose mechanics none of the other example games cover:
per-card mana curves, class-restricted card pools, hero powers (which
aren't cards), weapons/durability, and heavy use of random/digital-only
effects. It lives under `examples/_fixtures/` rather than `examples/` to
flag it as interop/test data rather than a showcase game — the same
convention already used for `examples/nrdb-fixture/`.

## Provenance

- **Card names, stats, and rules text belong to Blizzard Entertainment**
  (Hearthstone, "Classic" set). Nothing in this directory is original
  creative work by this repo's contributors.
- The ~45 cards in `components/cards.json` were **hand-transcribed from
  public game knowledge**, not parsed from Blizzard's or any third
  party's card database. Fetching
  `https://api.hearthstonejson.com/v1/latest/enUS/cards.collectible.json`
  was attempted once while building this fixture. It was not network-
  blocked — it returned HTTP 200 with real JSON — but the payload is every
  collectible card from every set ever released (thousands of cards) as a
  single minified JSON line, tens of thousands of tokens, unworkable to
  pull inline and impractical to reliably parse/cross-reference down to an
  accurate ~45-card Classic-only subset within this task's scope. Per the
  brief's fallback instruction ("if it fails or is unwieldy, author from
  knowledge"), this subset is hand-transcribed from public game knowledge
  instead of parsed from that feed.
- Because these are hand-transcribed rather than sourced from an
  authoritative feed, treat stats and wording as **best-effort accurate,
  not verified against the live game or a card database**. Spot-check
  anything load-bearing before relying on it.
- `game.yaml` deliberately sets `license: Proprietary` — unlike
  `examples/ember` (CC0), this content is not cleared for redistribution
  or publishing as a playable product. It exists solely to validate that
  the format can represent this game's data shape.

## Scope

- Only **~45 of the real Classic set's ~240 cards** are included: a
  hand-picked spread across all nine classes plus Neutral, chosen for
  mechanical variety (minions/spells/weapons; Taunt, Charge, Battlecry,
  Deathrattle, Freeze, Windfury, Divine Shield, Combo, Overload, Spell
  Damage; Free through Legendary rarity). It is not tournament-balanced
  and not a complete set — see `rules/rules.md` "Scope of this fixture".
- One sample deck ships in `decks/classic-control-mage.json`: a 30-card
  Mage list built entirely from cards in this fixture.
- `formats/standard.yaml` and `formats/wild.yaml` both point at the single
  `classic` set. Real Hearthstone Standard/Wild differ by *set rotation*
  (Standard = last ~2 years of sets, no Classic since 2021; Wild = every
  set ever released) — with only one set in this fixture, that distinction
  can't be demonstrated. See the comments in those two files and
  `WHAT-BROKE.md`.

## What to read next

- `rules/rules.md` — condensed rules (hero powers, mana, combat, keywords,
  deck-building) needed to make sense of the card pool.
- `WHAT-BROKE.md` — where this repo's format schema didn't map cleanly
  onto Hearthstone's rules, and the workarounds used to port it anyway.

## Validating this fixture

From the repo root:

```
python3 tools/validate.py examples/_fixtures/hearthstone-classic
python3 tools/render_cards.py examples/_fixtures/hearthstone-classic
python3 tools/check_deck.py examples/_fixtures/hearthstone-classic \
  examples/_fixtures/hearthstone-classic/decks/classic-control-mage.json \
  --format standard
```
