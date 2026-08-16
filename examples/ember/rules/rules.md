# Ember — Rulebook

*A 14-card dueling microgame for 2 players, 10–15 minutes. Version 0.3.*

## Overview

You and your rival each tend a flame. Play embers, wards, tools, and figures to
stoke your own fire and smother theirs. When a player's **flame** reaches 0,
they are **extinguished** and lose. If the deck runs out first, the higher
flame wins.

## Components

- 14 cards (shared deck, drafted at setup)
- 10 [spark] tokens per player (sparks are money)
- 6 [ash] tokens (a shared pool)
- 2 flame dials (each starts at 5)

## Setup

1. Shuffle all 14 cards into one deck.
2. Deal 3 cards to each player; set both flame dials to 5.
3. Each player starts with 2 [spark]. The remaining cards form the draw pile.
4. The player who most recently lit a real fire goes first.

## Turn structure

Turns alternate. On your turn, in order:

1. **Dawn** — draw 1 card, gain 1 [spark]. Resolve any "Dawn:" effects you control.
2. **Act** — play up to 2 cards, paying each card's cost in [spark].
   Figures and tools stay in play; embers and wards resolve, then go to the ash pile.
3. **Clash** (optional) — commit one card from your hand face down; your rival
   may commit one in response. Reveal simultaneously. The higher **power** wins:
   the loser's flame drops by the difference. Committed cards go to the ash pile.
4. **Dusk** — if you hold more than 5 cards, discard down to 5.

::: example A full turn, start to finish
You begin your turn with 3 [spark] and a flame of 4.

1. **Dawn** — draw a card and gain 1 [spark] (now 4 [spark]).
2. **Act** — play a figure costing 2 [spark] (2 left), then play an ember
   costing 1 [spark] (1 left). The ember resolves its effect and goes to
   the ash pile — you take 1 [ash] token from the pool.
3. **Clash** — you commit a card face down; your rival commits one too.
   Revealed: yours is power 3, theirs is power 2. Their flame drops by 1.
   Both cards go to the ash pile; yours going to ash on your own turn earns
   you another [ash] token, if you're under the 3-token cap.
4. **Dusk** — your hand is under the 5-card limit, so nothing is discarded.

Turn passes to your rival.
:::

## Ash

Whenever one of your cards enters the ash pile during your own turn, you may
take 1 [ash] token from the pool (max 3 held). Some cards spend or count [ash].

> The ash *pile* (where spent cards go) and the [ash] *token* pool you hold
> are different things sharing a name — the pile has no limit, only the
> token pool is capped at 3.

## Extinguishing

A flame at 0 is out — that player loses immediately. Effects that prevent
damage (like **guard** cards) apply before the flame drops.

## Keyword glossary

- **guard** — this card may be revealed from hand to reduce incoming clash
  damage by its power, then goes to the ash pile.
- **burn** — after resolving, this card forces the stated additional cost.
- **mirror** — copies a value from the opposing clashing card, as stated.
- **scurry** — this figure may return to your hand at Dusk instead of staying in play.

## Symbols

- [spark] — the spark token (currency)
- [ash] — the ash token

## Card clarifications

Rulings live in `rulings/rulings.json` with dates and sources — check there
before house-ruling. Text on a card always beats this rulebook.

## Variants

**Long burn (best of 3):** flames reset between rounds; ash carries over.
**Draft duel:** deal the whole deck 7/7; each player picks their own 7-card duel deck.
