# The Decktet — Rulebook

*A 45-card deck with six suits, ten ranks, and no fixed game of its own —
cards, not a game, in the way a standard 52-card pack is cards rather than a
game. Created by P.D. Magnus. This booklet covers the deck's own structure,
then two of its best-known catalog games: Magnate and Quincunx. CC
BY-NC-SA — see README.md for the exact license per source.*

## What makes the Decktet different

An ordinary playing card has one suit and one rank. Most Decktet cards have
**two** suits at once, and a few extended-deck cards have three. That
cross-suiting is the whole point of the deck: it is what lets one physical
set of cards support dozens of unrelated games, from trick-taking to
tableau-building to area control.

## The basic deck (36 cards)

- **6 Aces** — one per suit, rank 1, no mark.
- **24 number cards** — ranks 2 through 9. Each carries **two** suits, and
  suits are never repeated at a rank, so there are exactly three cards of
  every number rank.
- **6 Crowns** — one per suit, rank 10 (in basic-deck-only play), no suits
  in common with each other.

### The six suits

Moons (☾), Suns (☀), Waves (≈), Leaves (✤), Wyrms (ϟ), Knots (⌘) —
always listed and printed in that order. Where a tiebreaker
matters (see Quincunx variants and various trick-taking games), the suit
listed first on a card outranks the suit listed second.

### Marks

In addition to rank and suit, most basic-deck cards carry one of three
narrative marks, originally meant for card-based fortune-telling and later
adopted by some game rules:

- **Personality** (face cards) — 11 cards: 9 number cards plus the Bard and
  Huntress Crowns. Drawn as paired faces of the same figure.
  In Adaman, personalities are the cards you are trying to control; their
  printed ranks total 66 across the basic deck.
- **Location** — a place: the Sea, the Castle, the Cave, and so on.
- **Event** — a happening in time: the Journey, the Battle, the Pact, and so
  on. Three cards (the Market, the Origin, the End) are marked as *both* a
  location and an event.
- Aces carry no mark at all.

### Named cards

Every card except the six Aces has a proper name (the Aces just take the
name of their suit — "Ace of Moons," and so on). A handful, to give the
flavor: **the Soldier**, **the Sailor**, **the Diplomat** (personalities);
**the Journey**, **the Market**, **the Sea** (location/event cards). The
full list is in `components/cards.json`; name-to-card assignments in this
port are sourced from the official print-and-play deck (see README.md), not
guessed.

## The extended deck (9 more cards)

Optional add-ons, left out by default the way Jokers are left out of an
ordinary pack — some games ignore them, some make them optional, a few
require them.

- **The Excuse** — no suit, no rank, no mark. A blank, inert "joker."
- **4 Pawns** — a new rank, between 9 and Crown. Each Pawn has **three**
  suits; every suit appears on exactly two of the four Pawns.
- **4 Courts** — another rank, between Pawn and Crown. Also three suits
  each. The Courts cover suit combinations that never occur in the basic
  deck (like Moons+Wyrms), but not the combinations that occur three times
  over in the basic deck (like Moons+Suns).

With the extended deck in play, the full rank order is: Ace, 2, 3, 4, 5, 6,
7, 8, 9, Pawn, Court, Crown.

## How to use this deck

Shuffle the basic 36 (plus whichever extended cards a chosen game calls
for) and follow that game's own rules — there is no single "how to play the
Decktet." What follows are two of the deck's own catalog games. Both are
also catalogued, with many more, at wiki.decktet.com.

---

# Magnate

*A two-player game of city building. Designed by Cristyn Magnus, with
additional development by P.D. Magnus. ~30 minutes. CC BY-NC-SA 3.0 — see
README.md.*

> The Grand Duke, who has no heirs, has decreed that his throne will go to
> whoever does the most to lift up and develop the duchy. You are a
> successful but common merchant, aiming to buy a noble title by impressing
> the Grand Duke. His health is failing, so you need to hurry.

## Extra material

Beyond an **extended** Decktet, Magnate needs:

- **Resource tokens** in six colors, one per suit — about 10 of each.
  (Decktet suit chips are sold separately; poker chips or any six-color
  token set work fine.)
- **Two ten-sided dice (d10)** and **one six-sided die (d6)**.

## Setup

1. Separate the 4 Pawns and 6 Crowns out of the deck.
2. Set the 4 Pawns and the Excuse in the middle of the table — each
   represents one of the duchy's five **districts**.
3. Shuffle the 6 Crowns and deal 3 to each player, face up: these are each
   player's personal resources. Each player starts with 3 resource tokens,
   one matching each of their own Crowns.
4. Shuffle the rest of the deck (Aces + number cards, plus Courts if you
   want a longer game — see below) and deal 3 cards to each player as their
   starting hand. Remaining cards form a face-down draw pile.
5. Pick a first player; turns alternate.

## Turn structure

Each turn has three parts, always in order: **(a)** roll for resources,
**(b)** play exactly one card, **(c)** draw a card.

### a. Roll the dice

Roll both d10s.

- **If either die shows a 1, resolve taxation first:** roll the d6 to see
  which suit is taxed (1 Moons, 2 Suns, 3 Waves, 4 Leaves, 5 Wyrms, 6
  Knots). Any player holding more than one token of that resource discards
  down to one. Tokens already spent developing a property are unaffected.
- **Then collect resources**, based on the *higher* of the two d10s (a
  double still collects only once):
  - **10** — each player collects one token matching each of their own
    Crowns (3 tokens).
  - **2-9** — each player collects from their own properties of that rank
    in play: one token per suit for each *fully developed* property of
    that rank; one token of your choice (matching one of its suits) per
    rank-matching property you only hold a *deed* to. No matching
    properties, no resources that roll.
  - **1** (i.e. a pair of 1s) — each player collects one token per Ace
    property they have in play.

### b. Play a card — exactly one of:

- **Fully develop a new property**: discard resource tokens totaling the
  card's rank, all matching the card's suit(s), with at least one token of
  *each* of its suits represented (an Ace costs exactly 3 tokens of its own
  suit). Place it in a district: if it's your first property there, it
  must share a suit with that district's Pawn (or, for the Excuse's
  district, anything goes first); otherwise it must share a suit with the
  *previous* property you placed in that district. A district can hold only
  one of your properties under active development at a time.
- **Buy a deed** instead, if you can't afford full development yet: pay 2
  tokens (one per suit; an Ace deed costs 1) to the bank, place the card
  under the same district rules as above, and develop it gradually on later
  turns by spending matching tokens against it (it only counts at game end
  if fully developed by then).
- **Sell a card** from your hand for 2 tokens, one per suit (an Ace sells
  for 2 of its own suit).

You may also **trade** with the bank at any point in your turn, before
drawing: 3 tokens of one color for 1 of another, as many times as you like
and can afford.

### c. Draw a card

Draw one card from the pile; your turn ends. When the draw pile empties the
first time, shuffle the discards to form a new one. When it empties a
*second* time, each player gets one final turn and the game ends.

## The extended deck: Courts

If you include the 4 Courts, shuffle them in as extra property cards. A
Court sells for 3 tokens (one per suit), a deed for a Court costs 3 tokens,
and fully developing a Court costs 10 tokens matching its three suits (at
least one of each). A developed Court never provides income on the resource
roll, but counts as rank 10 toward victory.

## Victory

At game end, discard remaining hand cards and any unfinished deeded
properties (with their partial tokens). In each of the five districts,
each player totals the ranks of their own *fully developed* properties
there (an Ace counts once per Ace property you hold of that suit in that
district). Whoever has the higher district total scores 1 point for that
district; a tie scores nobody. Whoever holds more districts becomes Grand
Duke and wins.

**Tiebreakers, in order:** (1) higher total rank of developed properties
across *all* districts; (2) more resource tokens remaining; (3) still tied
— it's a draw, and both players are Grand Duke on alternating days.

---

# Quincunx

*A tableau-filling game for 2-4 players (plus a solitaire variant).
Designed by Chris DeLeo; rules text by P.D. Magnus. No extra material. CC
BY-NC-SA 3.0 — see README.md.*

You build a 5x5 grid one card at a time, scoring for how each new card
relates to its neighbors. Cards left in hand at the end cost you points.

## Setup

Shuffle the basic deck (add the Excuse and/or the Pawns for a spicier game
— see below).

| Players | Face-up starting spread | Starting hand |
|---|---|---|
| 2 | 5 cards: the 4 corners + the center | 10 cards each |
| 3 | 4 cards: the 4 corners only | 7 cards each |
| 4 | 5 cards: the 4 corners + the center | 6 cards each |

(A "Blank Slate" variant below starts from a single face-up card instead.)
Play begins with the player to the dealer's left and proceeds clockwise.

## Playing a turn

Play one card from your hand into any open cell of the 5x5 grid, then score
it (see below). If a scoring rule says to draw, do so — draws can stack if
one play scores against several neighbors at once.

## Scoring a played card

Compare the played card against each **orthogonally adjacent** card,
independently per side (a card at the grid's edge, or next to an empty
cell, doesn't score on that side). Rank values: Ace = 1, Crown = 10,
number cards as printed.

**Basic scoring**, add the two ranks together:

| Sum | Result |
|---|---|
| ≤ 9, one card an Ace, the other sharing the Ace's suit | + (the sum) |
| ≤ 9, no matching Ace | − (the sum) |
| exactly 10 | 0 |
| exactly 11 | draw a card |
| 12-19 | + (sum − 10) |
| exactly 20 | draw a card |

**Pair bonus**: the played card shares a rank with a neighbor → +5 (score
once per matching neighbor).

**Straight bonus**: the played card completes a run of 3+ consecutive
ranks in a line (any of the 8 directions: horizontal, vertical, or
diagonal) → +20 per straight completed. Aces run low (before 2), Crowns
run high (after 9); no wrapping.

**Three-of-a-kind bonus**: the played card completes 3+ cards of the same
rank in a line → +30 per set completed. A card counted toward a
three-of-a-kind in one line can't *also* score a pair bonus for that same
neighbor.

**Power play**: the played card is an Ace or Crown, placed adjacent to
another Ace or Crown of the *same* suit → score the total rank of every
*other* card of that suit already in the spread (0 to 44). Since an Ace +
Crown always sum to 11, a power play always triggers the "draw a card" rule
too.

## End of the round

The round ends when all 25 cells are filled. Any cards still in your hand
cost you points: −1×rank per number card, −10 per Crown, −15 per Ace. A new
round begins with the player to the old dealer's left dealing; a full game
is one round per player as dealer (so every seat deals exactly once).

## The extended deck

- **The Excuse** counts as a total blank: scores nothing when played,
  gives neighbors no basic-scoring bonus/penalty, and costs nothing if
  stuck in your hand at the end.
- **Pawns** count as rank 1 for basic scoring, and behave like a second Ace
  (matching-suit sums of 9-or-less add instead of subtract); for straights
  they sit between 9 and Crown. A Pawn left in hand at round's end costs
  10 points.

## Variants

- **Flush bonus**: +10 for completing a same-suit group of 4+ cards, in a
  line or a 2x2 box (a card may belong to more than one flush at once).
- **Muggins**: players must call out their own score aloud; anyone who
  misses points they were owed can be "mugginsed" by an opponent who
  claims them instead.
- **Blank Slate**: deal 24 cards evenly among players (6/8/12 each at
  4/3/2 players) and only 1 card face up to start. Every play must be
  orthogonally adjacent to a card already on the table. The grid's final 5x5
  shape emerges from play instead of being fixed at setup.

## Solitaire

Play on a 4x4 grid instead, with a starting card dealt in each corner and
an 8-card hand. Score as above, except straights and three-of-a-kinds never
count on diagonals. Running out of cards before the spread fills is a loss.

---

## Sources

- Deck structure, suit/rank/mark reference, and the complete 45-card
  name/suit/rank list: the official print-and-play PDF and rules PDF at
  decktet.com (CC BY-NC-SA 4.0).
- Magnate: wiki.decktet.com/game:magnate (CC BY-NC-SA 3.0). The
  fecundity.com/pmagnus/decktet/magnate.php URL linked from decktet.com's
  own games page did not return content when fetched directly for this
  port; the wiki mirror (linked from the same decktet.com games page) did.
- Quincunx: wiki.decktet.com/game:quincunx (CC BY-NC-SA 3.0).
- All rules text above is this port's own condensed restatement, not a
  verbatim copy of either source.
