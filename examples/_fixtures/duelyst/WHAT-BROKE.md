# WHAT-BROKE.md — where the platform format could not express Duelyst faithfully

Notes from porting a 118-card representative slice of Duelyst (6 Generals, 67
Minions, 40 Spells, 5 Artifacts across all 6 factions + Neutral) into
`examples/_fixtures/duelyst/`. `tools/validate.py` runs clean (0 errors) and
`tools/render_cards.py` renders all 118 printings — the gaps below are things
the schema has **no slot for at all**, not things that threw errors. Duelyst
is the first port in this repo whose core game loop (a 5x9 positional
battlefield) is structurally outside what a card/deck/set/format data model
can represent — this is the headline finding, more than any single field gap.

## 1. The board is the biggest gap in this repo so far — no schema, no fields, nothing

Duelyst is played on a 5-row by 9-column grid. Which space a unit occupies,
how far it can move, whether an attack is in range, whether a target is
"nearby" (adjacent) — this is not a peripheral detail, it is roughly half of
what makes a Duelyst card's text meaningful. `Provoke`, `Zeal`, `Infiltrate`,
`Backstab`, `Frenzy`, `Blast`, `Ranged`, `Flying`, `Airdrop`, and the "nearby"
qualifier used throughout this fixture's card text are **all** positional —
none of them resolve to anything without a board.

This platform's schema has **zero** representation for any of it: no board
entity, no grid, no coordinates, no adjacency, no unit-placement state
anywhere in `schemas/`. Every keyword above is captured here only as prose
inside `card.text` and a same-named string in `card.keywords[]` — identical
in kind to how `examples/_fixtures/hearthstone-classic`/`netrunner-sg` store
"random" and "trigger condition" effects, but Duelyst hits this wall on a
**majority** of its cards, not a handful.

This is not a surprise gap — it's the exact, named Bucket 2 item in
`FUTURE-GENRES.md` ("`boards/*.json` — grid (`hex-odd-r|hex-axial|square|
graph|none`...), per-cell features... zones... slots/snap-points"), written
before this port existed, for board/wargame genres. Duelyst is concrete,
first-hand confirmation that **digital tactics-CCGs belong in the same
bucket as physical board/wargames**, not in the card-only bucket this
platform ships today: a 5x9 `grid: square` board file, unit-placement state
on top of the existing `token`/deck concepts, and a `nearby(a, b)` adjacency
primitive would be the minimum to make Duelyst's own card text
machine-meaningful rather than descriptive prose. None of that exists yet;
Bucket 2 is still "reserved paths," not shipped schema.

## 2. Generals are three unrelated things at once; the schema has a slot for none of them

A Duelyst General is simultaneously:

- **A deck-adjacent identity** (which faction's cards you may play) — the
  same shape of gap as Netrunner's identity problem
  (`netrunner-sg/WHAT-BROKE.md` #3): `deck.schema.json` has no `general`/
  `identity` field, so the General has to be smuggled into the same `cards`
  map as everything else, at `deck_limit: 1`, with nothing distinguishing
  "this defines your faction" from "a copy of a card in your deck." This
  fixture's `formats/standard.yaml` documents the convention (General not
  counted in the 40) entirely in prose; nothing enforces it.
- **The player's health pool** — General Health (25 baseline) IS that
  player's life total, not a creature stat that happens to matter. There is
  no "this card's health attribute doubles as a win-condition counter"
  concept anywhere in the schema; `attributes.health` on a General card in
  this fixture looks identical, structurally, to `attributes.health` on a
  Minion, even though losing track of one ends the game and losing track of
  the other does not.
- **A source of one reusable ability** (the Bloodbound/Bloodborn Spell) —
  the same gap as Hearthstone's Hero Powers
  (`hearthstone-classic/WHAT-BROKE.md` #3): not a card, never drawn, never
  deckbuilt, but as central to play as any card in the deck. This fixture
  folds a General's Bloodbound/Bloodborn Spell into that General card's own
  `text` field (e.g. `argeon_highmayne`: "Bloodbound Spell: Give a friendly
  minion nearby your General +2 Attack.") because there is nowhere else to
  put it — but that conflates "what this card's rules-text says" with "an
  ability the player has independent of any specific card being in play,"
  which are different facts in the real game.

All three gaps compound: `type: general` (per this task's own instruction)
gets these cards *classified* correctly, but classification isn't
representation — nothing downstream (`check_deck.py`, `render_cards.py`,
the schema itself) knows a General is deck-exempt, life-total-bearing, and
ability-granting all at once.

## 3. The Replace mechanic has no home at all

Once per turn, a player may discard a card from hand and draw a random
replacement, at an increasing mana cost each time used. This is a core,
constant hand-economy decision in every real game of Duelyst — and it maps
to **no field in any schema in this repo**. It isn't a card (nothing is
gained or played), isn't a keyword on a card (it's a general player action,
available regardless of hand contents), and isn't a deck rule (it doesn't
affect legality). It exists in this fixture only as prose in `rules/rules.md`
— exactly the kind of "code-like, permanently out of scope" turn-action
logic `FUTURE-GENRES.md` already carves out for rules engines generally, but
worth naming specifically since it's not a rare edge case here — it's a
mechanic a Duelyst player uses almost every turn.

## 4. Per-rarity deck copy limits + General exclusion, same shape as two prior fixtures

Real rule: max 3 copies of any card, **except Legendary, capped at 1**, and
the General is not one of the deck's 40 cards at all.
`format.schema.json`'s `deck_rules` is still just `min_size`/`max_size` — no
`max_copies`, let alone a rarity-conditional one, and no concept of a
deck-exempt identity card. This is the same finding as
`hearthstone-classic/WHAT-BROKE.md` #1 (rarity-conditional copy limits) and
`netrunner-sg/WHAT-BROKE.md` #3 (identity cards structurally special) landing
on Duelyst simultaneously. **Workaround** (same as both prior fixtures):
`card.deck_limit` set per-card (3, or 1 for Legendary/General) — enforced
correctly by `tools/check_deck.py`, but the *rule* "Legendary/General → 1"
is nowhere as data, just baked into 118 individual numbers.

## 5. `attributes.attack`/`attributes.health` required-ness is type-conditional; the schema can't say that

Every card in this fixture has `mana` (even Generals: 0). Only Minions and
Generals have `attack`/`health` — Spells and Artifacts have neither, by the
real game's own rules (they're never in combat). `game.yaml
attribute_definitions[].required` is a single global boolean per attribute
key, so `attack`/`health` had to be left optional game-wide rather than
"required if type is minion or general." A data-entry mistake (a Minion
missing `health`) would validate fine — silently — identical to
`hearthstone-classic/WHAT-BROKE.md` #4, now confirmed on a second game with
a *cleaner* type/stat correlation than Hearthstone's (Duelyst's split is
exactly `type ∈ {minion, general}` vs not, no exceptions), which makes the
absence of a per-type required rule even more visibly a gap here.

## 6. The reference PNG renderer's badge slots don't know Duelyst's attribute names

Consistent with `netrunner-sg/WHAT-BROKE.md` #11: `tools/render_cards.py`
only special-cases two hardcoded attribute keys for its corner badges —
`attributes.cost` and `attributes.power` (Ember's vocabulary). This fixture's
cards use `mana`, `attack`, `health` — none of those three names match, so
`render_cards.py` runs to completion with zero errors on all 118 printings,
but **every rendered card face shows no cost badge and no attack/health
badge at all**. The data is present and correct in `components/cards.json`;
it's simply invisible on the reference render because the renderer's badge
logic is keyed to two specific strings rather than reading
`game.yaml attribute_definitions`. Confirmed by inspection of the renderer
source, same root cause as the Netrunner finding, now hit by a second game.

## 7. Digital/random effects: fine as prose, same conclusion as both prior CCG fixtures

"Summon a random Egg in 4 random spaces" (Chrysalis Burst), "summon a
1/1 Wraithling on that space" combined with a positional target, "restore
this minion to full Health and switch its Attack and Health" — all encode
fine as plain prose in `card.text`, per the same reasoning already recorded
in `netrunner-sg/WHAT-BROKE.md` #6 and `hearthstone-classic/WHAT-BROKE.md`
#6: this is a data/interchange format, not a rules engine, so nothing here
needs to be machine-executable. Flagged for completeness, not because it's a
new finding.

## 8. Keywords vocabulary: clean fit, no issues

Zeal, Celerity, Rush, Ranged, Flying, Frenzy, Provoke, Airdrop, Blast,
Opening Gambit, Dying Wish, Deathwatch, Backstab, Infiltrate, Grow, Rebirth
all mapped cleanly onto `card.keywords[]` as plain strings, extracted
directly from the `<b>...</b>` markup in the source data with no
restructuring needed. `card.subtypes[]` held the race/tribe layer (Vespyr,
Arcanyst, Golem, Dervish, Structure) exactly as designed — no workaround
needed for either field.

## Not broken / worked cleanly

- `mana`/`attack`/`health`/`faction`/`rarity` as `attribute_definitions` —
  a clean, direct fit; every value round-tripped from source data with no
  transformation beyond typing.
- `type: general | minion | spell | artifact` as the four-way split this
  task asked for — Duelyst's own card taxonomy maps onto it exactly once
  spells/artifacts are told apart by "does it have Attack/Health," which
  the Duelyst Wiki's own card table already encodes structurally (blank
  Attack/Health columns), not something this port had to infer.
  `type_colors` and `faction_colors` both accepted the resulting vocabulary
  with no changes to either schema.
  See `README.md`. Referential integrity (`card_id`/`set_id` cross-refs) and
  `tools/validate.py`'s two-pass check caught nothing wrong — the fixture
  was generated from one script, so this mostly confirms the generator was
  self-consistent rather than stress-testing the checker.
