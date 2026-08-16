# Hearthstone: Classic — Condensed Rules (fixture)

*A condensed, self-contained rules reference for the ~45-card test fixture
in this directory. This is NOT Blizzard's official rulebook — it is a
compact summary, written from public game knowledge, that exists so the
card pool in `components/cards.json` is checkable in context without an
external reference. See `../README.md` for provenance and `WHAT-BROKE.md`
for where this repo's format schema doesn't map cleanly onto these rules.*

## Overview

Two players duel, each playing one of nine hero classes with a 30-card
deck. Reduce your opponent's hero from 30 Health to 0 (or lower) to win.

## Components (per player)

- A hero (one of Warrior, Shaman, Rogue, Paladin, Hunter, Druid, Mage,
  Priest, Warlock), starting at **30 Health**, 0 Armor.
- A 30-card deck (see **Deck rules** below).
- Mana Crystals: 0 at game start, gained over time (see **Mana**).

## Setup

1. Each player picks a class and brings a legal 30-card deck.
2. Both heroes start at 30 Health, 0 Armor, 0 Mana Crystals.
3. Shuffle decks. Randomly determine who goes first.
4. Draw opening hands: 3 cards for the player going first, 4 for the player
   going second.
5. **Mulligan** (see below), then the game begins.

## Mulligan

Before turn 1, each player privately looks at their opening hand and may
put back any number of those cards, shuffling them into their deck and
drawing that many new replacement cards. This happens once, simultaneously,
for both players, before the first turn.

## The Coin

The player who goes second starts with an extra card in hand: **The
Coin** — "Gain 1 Mana Crystal this turn only." It is not part of any
decklist and does not count against deck-building limits; it exists only
to offset the tempo lost by not going first.

## Turn structure

Turns alternate; there is no passing priority mid-turn. On your turn:

1. **Gain 1 Mana Crystal** (maximum 10 total), and all your Mana Crystals
   refill to full (unspent mana does not carry over between turns).
2. **Draw 1 card.** If your deck is empty, you take **Fatigue** damage
   instead of drawing (see below).
3. **Play cards, use your Hero Power, and attack** with your minions/hero,
   in any order, any number of times, limited only by available mana,
   once-per-turn effects (Hero Power, Combo state), and how many attacks
   your minions/weapon have available.
4. **End your turn.**

## Mana

- Mana Crystals start at 0 and increase by 1 at the start of each of your
  turns, capped at 10.
- Crystals fully refill at the start of each of your turns.
- A card's printed cost (the `mana` attribute in `cards.json`) is the
  crystals spent to play it.
- **Overload** (see Keywords) locks that many crystals on your *next* turn
  only, then releases.

## Hero Powers

Every class has one signature Hero Power: usable **once per turn**, and
(for all nine Basic powers) it costs **2 mana**.

| Class    | Hero Power     | Effect                                          |
|----------|----------------|--------------------------------------------------|
| Warrior  | Armor Up!      | Gain 2 Armor.                                    |
| Shaman   | Totemic Call   | Summon a random Basic Totem.                     |
| Rogue    | Dagger Mastery | Equip a 1/2 dagger.                              |
| Paladin  | Reinforce      | Summon a 1/1 Silver Hand Recruit.                |
| Hunter   | Steady Shot    | Deal 2 damage to the enemy hero.                 |
| Druid    | Shapeshift     | Gain +1 Attack this turn and 1 Armor.            |
| Mage     | Fireblast      | Deal 1 damage.                                   |
| Priest   | Lesser Heal    | Restore 2 Health.                                |
| Warlock  | Life Tap       | Draw a card and take 2 damage.                   |

Hero Powers are not cards, do not go in a decklist, and have no
`components/cards.json` entry — see `WHAT-BROKE.md`. A Neutral card can be
played by any class; it has no Hero Power of its own (Neutral isn't a
playable hero).

## Card draw & Fatigue

- Drawing from an empty deck deals **Fatigue** damage to your hero instead
  of drawing a card: 1 damage the first time it happens to you, 2 the
  next, 3 the next, and so on (increasing by 1 each time), and you get no
  card. Fatigue damage is reduced by Armor like any other damage.

## Combat

- Minions have **Attack** and **Health**. A minion at 0 or less Health
  dies and is moved to the graveyard.
- A freshly-played minion can't attack the turn it enters play unless it
  has **Charge** ("summoning sickness").
- A minion (or hero with a weapon equipped) may attack once per turn
  (twice with **Windfury**).
- When A attacks B: A deals damage equal to its Attack to B, and B deals
  damage equal to its Attack back to A, simultaneously.
- Damage **persists** on a minion — it does not heal back on its own —
  until the minion dies or is explicitly healed by an effect.
- If any enemy minion has **Taunt**, you must attack a Taunt minion before
  you can attack anything else on that side.

## Keywords

- **Taunt** — enemies must attack this minion before your hero or your
  other minions.
- **Charge** — can attack the same turn it is played.
- **Windfury** — can attack twice per turn instead of once.
- **Divine Shield** — ignores the next instance of damage entirely, then
  the Shield is consumed (one-time damage prevention).
- **Stealth** — can't be targeted or attacked by the opponent until this
  minion attacks or uses an ability.
- **Freeze** — a frozen character can't attack on its controller's next
  turn. Freezing, by itself, deals no damage.
- **Spell Damage** — while this minion is in play, your damage-dealing
  spells deal that much extra damage.
- **Battlecry** — an effect that triggers when the card is played from
  hand.
- **Deathrattle** — an effect that triggers when the card dies (moves from
  play to the graveyard), regardless of how it died.
- **Combo** — grants a bonus effect if this is not the first card you've
  played this turn.
- **Overload (N)** — this card costs you N locked Mana Crystals on your
  *next* turn only.
- **Secret** — a hidden Mage/Hunter/Paladin spell, played face-down, that
  triggers automatically once its condition is met. None of this fixture's
  45 cards are Secrets; listed here because it's core to the full game.

## Weapons

- Equipping a weapon lets your hero attack using the weapon's Attack
  value, as if the hero were a minion with that much Attack.
- Weapons have **Durability** instead of Health: each attack made with
  the weapon reduces its Durability by 1. At 0 Durability the weapon
  breaks and is discarded.
- A hero can have only one weapon equipped at a time; equipping a new one
  destroys the old one first.

## Win condition

- A hero reduced to 0 Health or less is destroyed; that player loses
  immediately.
- If both heroes are destroyed at the same time, the game is a draw.

## Deck rules

- Exactly **30 cards**.
- Choose exactly **one class**; your deck may contain that class's cards
  plus any number of **Neutral** cards — cards restricted to a different
  class cannot be included.
- **Maximum 2 copies** of any given card, except **Legendary**-rarity
  cards, which are limited to **1 copy**.

This fixture encodes the last rule as a flat `deck_limit` on each card in
`components/cards.json` (2, or 1 for Legendary) rather than a rarity-aware
formula, and encodes "one class plus Neutral" only informally via the
`class` attribute (nothing in the schema enforces it at validation time).
See `WHAT-BROKE.md` for details.

## Scope of this fixture

Only ~45 of the real Classic set's ~240 cards are transcribed here — a
hand-picked spread chosen for mechanical variety, not a tournament-legal or
balanced pool. See `../README.md` for full provenance and `WHAT-BROKE.md`
for format-conformance notes.
