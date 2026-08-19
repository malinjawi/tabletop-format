# Mindbug — Condensed Rulebook

*A 2-player creature-dueling card game designed by Richard Garfield,
Christian Kudahl, Marvin Hegen, and Skaff Elias. This is a condensed
rulebook written for the tabletop-format platform from primary-source
research (mindbug.me's official rules sheet and FAQ) plus general
knowledge — not a copy of the official rulebook. Wording is original.
See `README.md` for exactly which mechanics below are sourced from
official material vs. reconstructed.*

> **License status: unconfirmed.** This is a data/rules fixture, not a
> hosted game — see `README.md` "Provenance & license" before treating any
> of this as cleared for redistribution.

## 1. Overview

You and your opponent each command hybrid creatures pulled from the same
shared deck. On your turn you either **play a creature** from your hand or
**attack** with one already on your side of the table — there is no other
option, no resource cost, and no deck you built yourself going in.

The twist: whenever you play a creature, your opponent may spend a
**Mindbug** to steal it before it ever reaches your side of the table. You
each start with two. Bluff, read your opponent, and time your biggest
threats for when their Mindbugs are gone.

Reduce your opponent's life to 0 and you win.

## 2. Components

- **48 creature cards** — one shared deck; every card is a singleton (no
  duplicates).
- **4 Mindbug cards** — 2 per player.
- No board, no dice, no resource tokens. Life is tracked by setting aside
  spare creature cards face down (see Setup).

## 3. Setup

1. Give each player **2 Mindbugs**, face up in front of them.
2. Shuffle all 48 creature cards into a single deck. Deal each player a
   **10-card draw pile**, face down.
3. Each player draws **5 cards** from their own draw pile as their opening
   hand.
4. Each player takes **3 cards from the leftover, undealt pile** (28 cards
   remain after the two 10-card draw piles and two 5-card hands are dealt)
   and sets them face down as their **life total** — 3 life points to
   start. Turning them sideways helps tell them apart from playable cards.
   (Dice or spare tokens work fine too if you'd rather not spend cards on
   it.)
5. **Determine the first player:** each player reveals one card from the
   remaining leftover pile. Higher power goes first; re-reveal on a tie.
   Set those revealed cards aside out of the game (or shuffle them back in
   before play, by house agreement — the source material does not specify,
   see `README.md`).

## 4. Life

You start at 3. Losing a life point means discarding one of your face-down
life cards from the game. There is no maximum — some effects can raise
your life above 3. Reach 0 and you lose immediately.

## 5. Turn structure

Players alternate turns. On your turn you must do **exactly one** of the
following two things. If you can do neither, you lose the game immediately.

### 5a. Play a creature

Choose a card from your hand and place it face up on the table. Your
opponent now decides:

- **Let it through:** the creature enters your play area. If it has a
  **Play:** ability, resolve it for you. Your turn ends.
- **Mindbug it:** your opponent may spend one of their two Mindbugs
  (turning it face down) to seize the creature instead. It enters *their*
  play area, and if it has a **Play:** ability, *they* resolve it, not you.
  Your turn still ends, but you immediately take another turn afterward —
  effectively, stealing a creature costs your opponent a full turn's worth
  of tempo.

Either way, immediately after a creature leaves your hand (by playing it,
discarding it, or any other way), draw back up to **5 cards** from your
draw pile before anything else happens — before the Mindbug decision's
consequences, before a Play ability, before anything. If your draw pile is
empty, you simply don't draw; there is no reshuffling of your discard pile
back into your deck.

A Mindbug can only be used the instant a card is played from hand. It
cannot be used on a creature that enters play any other way (an effect
that puts a card into play, for instance), and a creature that has already
been Mindbugged this play cannot be Mindbugged again by the other player.

### 5b. Attack with a creature

Choose one creature you control to attack with. Your opponent chooses
whether to block:

- **No block:** your opponent loses 1 life.
- **Block:** your opponent picks one of their creatures to block with
  (subject to Sneaky, below). Compare power: the lower-power creature is
  **defeated** (sent to its controller's discard pile). On a tie, **both**
  are defeated. Poisonous and Tough change this — see §7.

Attacking does not draw you a card (only losing a card from hand does).

## 6. Triggered and constant abilities

Ability text on a card is written as a **trigger word** followed by an
effect, or with no trigger word at all:

- **Play:** — resolves the instant the creature enters play, however it
  got there (played from hand, Mindbugged, or put into play by another
  effect). If your opponent Mindbugs your creature, *they* get the Play
  trigger, not you.
- **Attack:** — resolves when the creature attacks, before the opponent
  decides whether to block.
- **Defeated:** — resolves when the creature is sent from play to a
  discard pile, whether from combat or another effect. It does *not*
  trigger if the creature instead changes hands (Mindbugged), returns to
  a hand, or is discarded straight from a hand.
- **No trigger word** — a constant ability, always active while the
  creature is in play and its conditions are met (Elephantopus's blocking
  restriction, for example).

When an effect can't fully resolve (e.g. "discard two cards" with only one
card in hand), resolve as much as you can and ignore the rest. When two
effects would happen at the same time, the active player chooses the
order.

## 7. Keywords

Keywords are shorthand for a rules effect and are printed on a line below
the creature's name.

- **[frenzy] Frenzy** — if this creature survives combat the first time it
  attacks in a turn, it may attack a second time that same turn.
- **[hunter] Hunter** — when this attacks, its controller may name which
  enemy creature has to block it (instead of the defender choosing).
  Using Hunter is optional even for a Hunter creature; if you choose not
  to force a block, the attack proceeds as a normal one that can be
  blocked freely or left unblocked. A Sneaky creature can be forced to
  block by Hunter even though it normally could only be blocked by other
  Sneaky creatures — Hunter overrides the defender's choice, not the
  attacker's own restrictions.
- **[poisonous] Poisonous** — in addition to normal combat math, this
  creature always defeats whatever it fights, even if that creature has
  higher power. (If the enemy also has equal or higher power, the
  Poisonous creature can still be defeated in return by the normal power
  comparison — Poisonous adds a kill, it doesn't grant immunity.)
- **[sneaky] Sneaky** — can only be blocked by a creature that also has
  Sneaky. It can still block normally itself.
- **[tough] Tough** — the first time this creature would be defeated, it
  is **exhausted** instead (rotate it 90° to mark this) and stays in
  play, undefeated. Exhausted just means "already used its Tough save
  this game" — it doesn't stop the creature from attacking, blocking, or
  using abilities. If a Tough creature is exhausted and would be defeated
  again, it is defeated for real this time. Gaining control of an already
  exhausted Tough creature keeps it exhausted.

## 8. The Mindbug

Both players start with 2 Mindbugs (4 total in the box). A Mindbug is
spent, not drawn or bought — see §5a for the full sequence. Once both of
a player's Mindbugs are spent, every creature that player's opponent plays
resolves normally; that's often the turning point of a game, and reading
when your opponent is "out" is a core skill.

## 9. Win condition

Reduce your opponent to 0 life and you win immediately. You also win if
your opponent is ever unable to take a legal turn (they have no cards in
hand to play and no creatures in play to attack with).

## 10. Game terms

- **Allied / enemy creature** — creatures in your own play area vs. your
  opponent's. In hand or a discard pile, cards are just "cards."
- **Discard** — move a card from a hand to that player's discard pile.
- **Steal** (as worded on some cards) — take a card directly from an
  opponent's hand into your own.
- **Take control** — an effect that moves a card into your play area
  keeps it in its current state (e.g. still exhausted) and does not
  trigger its Play ability, unlike a Mindbug steal (which does trigger
  Play, per §5a).

## Symbols

- [frenzy] [hunter] [poisonous] [sneaky] [tough] — the five base-game
  keywords, §7.
- [mindbug] — the Mindbug mechanic itself, §5a and §8.

## Scope of this fixture

This rulebook describes the base game only. The official line has since
grown (an "Ambition"/"Mindbug Beyond" expansion layer with mechanics like
Boost, Evolve, and 4-player Tag Team rules exists per mindbug.me/rules/)
— none of that is ported here. `components/cards.json` holds 48 creatures
using only the five keywords above; see `README.md` for exactly which of
those 48 are sourced from official material, which are this build's
best-effort recollection of real card names, and which are original
placeholders invented to round the pool out to 48.
