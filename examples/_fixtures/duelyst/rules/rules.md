# Duelyst — Condensed Rules (fixture)

*A condensed, self-contained rules reference for the 118-card test fixture in
this directory. This is NOT Counterplay Games' official rulebook — it is a
compact summary, written from the game's CC0-licensed open-source release and
public game knowledge, that exists so the card pool in `components/cards.json`
is checkable in context. See `../README.md` for provenance and
`WHAT-BROKE.md` for where this platform's card-only schema does not map onto
Duelyst's rules.*

## Overview

Duelyst is a 1v1 digital collectible card game and tactical-positioning
hybrid: each player commands a **General** — simultaneously their hero, their
health pool, and (via a reusable **Bloodbound/Bloodborn Spell**) their one
signature ability — and battles across a **5-row by 9-column** grid
battlefield. Reduce the enemy General's Health to 0 to win.

> **NOTE.** Everything in this section (the board, unit placement/movement,
> the General as a persistent piece, positional keywords) is core to how
> Duelyst is actually played, but has **no representation anywhere in this
> platform's schema**, which models card/deck/set/format data, not board
> state. See `WHAT-BROKE.md` for the specifics.

## Components (per player)

- A **General** (one per faction — see `components/cards.json`, `type:
  general`), starting at 2 Attack / 25 Health, always in play from turn 1
  (never drawn, never deckbuilt).
- A 40-card deck of Minions, Spells, and Artifacts (see **Deck rules**).
- **Mana Crystals**: start at 0, grow by 1 each of your turns (capped at 9),
  and fully refill each of your turns — the `mana` attribute on a card is
  the crystals spent to play it.

## The battlefield

- A grid **5 spaces tall, 9 spaces wide** (45 spaces total). Each player's
  General starts on their own back-row edge.
- Minions and Generals occupy exactly one space each and move across the
  grid (most minions 2 spaces per turn, unless a keyword changes this).
  Terrain, obstruction, and "space to space" range all matter for whether an
  attack, spell, or summon is legal.
- **Replace Zone**: the mana-cost-adjacent economy for hand refinement — see
  **Replace**, below.

## Setup

1. Each player picks a General (one per faction) and a legal 40-card deck.
2. Both Generals start at 2 Attack / 25 Health, 0 Mana Crystals, placed on
   opposite starting edges of the battlefield.
3. Shuffle decks; randomly determine who goes first. Draw an opening hand
   (fewer cards for the player going first — the exact count and any "extra
   card for going second" compensation follows the same shape as
   `examples/_fixtures/hearthstone-classic`'s Coin, but Duelyst's live rules
   for this were not independently re-verified for this fixture).

## Turn structure

1. **Gain 1 Mana Crystal** (max 9); Crystals fully refill.
2. **Draw 1 card.**
3. **Replace** (optional, see below), **summon minions**, **cast spells**,
   **equip artifacts**, **move and attack** with your General and minions —
   in any order, limited by mana, board position, and each unit's one
   move + one action per turn.
4. **End your turn.**

## Replace

Once per turn, before or between other actions, a player may **discard one
card from hand and draw a random replacement** from their deck. Replacing
costs mana, starting cheap and increasing (by the game's own convention)
each time it's used in the same game. This is a digital, hand-refinement
mechanic with **no equivalent in this platform's schema** — see
`WHAT-BROKE.md`.

## Combat & positioning keywords

Keywords appearing on cards in this fixture (`card.text` inline, `<b>...</b>`
in the original source, plain text + `card.keywords[]` here):

- **Zeal** — this minion's bonus applies only while it is nearby (adjacent
  to) your General.
- **Celerity** — may move and attack twice in the same turn.
- **Rush** — may move and attack the same turn it is summoned.
- **Ranged** — may attack any enemy on the battlefield, not just adjacent
  ones.
- **Flying** — may move to any open space on the battlefield, ignoring
  terrain/obstruction.
- **Frenzy** — when attacking a target directly (melee range), also strikes
  every other enemy nearby simultaneously.
- **Provoke** — nearby enemies must attack this minion before anything else
  nearby.
- **Airdrop** — may be summoned to any open space on the battlefield, not
  just spaces near your General.
- **Blast** — attacks every enemy in a straight line, not just the one
  target.
- **Opening Gambit** — a one-time effect that triggers the instant this
  card is played from the action bar.
- **Dying Wish** — an effect that triggers when this minion dies.
- **Deathwatch** — an effect that triggers whenever any minion dies.
- **Backstab: (N)** — deals N bonus damage when attacking an enemy from
  the unoccupied space directly behind it.
- **Infiltrate** — this minion's bonus applies only while on the enemy's
  side of the battlefield.
- **Grow** — this minion gets permanently bigger at the start of each of
  your turns.
- **Rebirth** — when this minion dies, it leaves behind an Egg that hatches
  back into it.
- **Bloodbound Spell / Bloodborn Spell** — every General's single, reusable,
  once-available (per that General's own rules) signature ability. Not a
  card — see `WHAT-BROKE.md` #2.

> **NOTE.** "Nearby" means the (up to) 8 adjacent spaces around a unit —
> another positional concept this format has no field for. Card text in
> this fixture keeps the word "nearby" as flavor-accurate prose; nothing
> validates or computes it.

## Card types in this fixture

| `type`     | Has `attack`/`health`? | Deck slot?                         |
|------------|:-----------------------:|-------------------------------------|
| `general`  | Yes (2 / 25 baseline)   | No — always in play, not in the 40  |
| `minion`   | Yes                      | Yes                                  |
| `spell`    | No                       | Yes                                  |
| `artifact` | No (equips to General)   | Yes                                  |

## Win condition

- Reduce the enemy General's Health to 0 (or below) — that player loses
  immediately.
- Simultaneous double-KO is a draw.

## Deck rules

- Exactly **40 cards**, not counting the General (which is not a deck
  card — see `WHAT-BROKE.md` #2).
- **Maximum 3 copies** of any card, except **Legendary** rarity, which is
  limited to **1 copy** — mirrored here as `card.deck_limit` (3, or 1 for
  Legendary and for the General itself).

## Scope of this fixture

Only 118 of Duelyst's real card pool (several hundred cards across a Core
set and many later releases) are included here — a hand-picked spread
across all 6 factions plus Neutral, chosen for type/keyword/rarity variety,
not a tournament-legal or balanced pool. See `../README.md` for full
provenance and `WHAT-BROKE.md` for format-conformance notes, especially
around the board/positional gap that dominates this port.
