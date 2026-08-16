# Hearts — Rulebook

*A trick-taking card game for exactly 4 players, using a standard 52-card
deck. No trump suit. Traditional / public domain — this text is an
original restatement of the classic rules, released CC0-1.0. Playtime:
20-45 minutes.*

## Objective

Hearts is a game you try to lose politely. Each hand, avoid collecting
"penalty cards": every heart is worth 1 point against you, and the queen
of spades is worth 13. When any player's cumulative score reaches 100
points, the game ends and the player with the FEWEST points wins.

## Components

- One standard 52-card French deck: 4 suits (clubs, diamonds, hearts,
  spades), ranks 2 through 10, Jack, Queen, King, Ace. No jokers.
- Paper and pencil (or any counter) to track cumulative scores across
  hands.

## Setup

1. Choose a first dealer at random. The deal passes to the left after
   every hand.
2. Shuffle all 52 cards and deal them out one at a time, clockwise, until
   every player holds 13 cards. With exactly 4 players the deck divides
   evenly — no kitty, no widow, nothing left over.

## Passing

Before play begins each hand, every player chooses 3 cards from their
hand and passes them face-down to another player. The direction rotates
on a fixed 4-hand cycle:

1. Hand 1 — pass to the player on your left.
2. Hand 2 — pass to the player on your right.
3. Hand 3 — pass across the table.
4. Hand 4 — hold: no passing at all.

Repeat the cycle for hand 5 and onward. All players choose and pass their
3 cards simultaneously, before seeing what they will receive. Once
received, passed cards are simply part of your hand for the rest of that
hand — there is no way to tell where a specific card came from, and no
further trading once tricks begin.

## The opening lead

Whoever holds the 2 of clubs, after passing, leads it to the very first
trick of the hand. This is mandatory: if you hold the 2 of clubs, you
must lead it — it cannot be held back.

## Playing a trick

Play passes clockwise. Each player, in turn, must follow suit — play a
card of the same suit as the card led — if they hold one. A player with
no card of the led suit may play any card from their hand, including a
heart or the queen of spades ("sluffing" or "discarding off").

The trick is won by whoever played the highest-ranked card of the SUIT
LED. Off-suit cards, however high, never win a trick — there is no trump
suit in Hearts. The winner of a trick collects it face-down and leads the
next one.

## The first trick

No hearts, and not the queen of spades, may be played on the first trick
— even by a player who is void in clubs — UNLESS that player's entire
hand is nothing but hearts and/or the queen of spades, in which case they
must play one (they have no legal alternative). No points should ever
change hands on trick one.

## Breaking hearts

Hearts cannot be LED (played as the first card of a trick) until a heart
has already landed on some earlier trick, discarded by a player who was
void in the led suit. This is called "breaking hearts." The restriction
applies only to leading — a player may always play a heart when following
suit, or when void and discarding off. Exception: if hearts is the only
suit left in a player's hand, they may lead a heart even if hearts have
not yet been broken; they have no other legal play. The queen of spades
may be led at any time after the first trick — only hearts require
breaking.

## Scoring a hand

When all 13 tricks have been played, each player counts the penalty cards
sitting in the tricks they won:

- Each heart taken: 1 point.
- The queen of spades taken: 13 points.
- All other cards: 0 points.

Exactly 26 penalty points exist in the deck every hand (13 hearts + the
13-point queen of spades). Add each player's total to their running game
score and re-deal.

## Shooting the moon

If a single player takes ALL 26 penalty points in one hand — every heart
and the queen of spades — they may score it in reverse: instead of adding
26 to their own total, they add 0, and every OTHER player adds 26 to
theirs. This is "shooting the moon," the game's signature comeback play.
A near-miss (25 points, or 26 split across two players) gets no special
treatment — it is just a very bad hand for whoever holds it.

## End of the game

Play continues hand after hand — dealer and pass direction rotating as
above — until at least one player's cumulative score reaches 100 points
at the end of a hand. The player with the LOWEST total score at that
moment wins. Ties for lowest are rare; playing one further hand is the
common house fix.

## Common variants

- **Jack of Diamonds ("Omnibus Hearts")** — the jack of diamonds is worth
  -10 points to whoever takes it, on top of the usual 26 penalty points.
  Shooting the moon then swings 36 points instead of 26.
- **No passing** — skip the passing phase every hand. Favors a more
  defensive, predictable game.
- **Two-card pass** — some groups shrink the pass from 3 cards to 2, to
  keep more of a player's original hand intact.
- **Spot Hearts** — hearts score their face value (2-10, ace high) instead
  of a flat 1 point each; the queen of spades usually still scores a flat
  13.
- **Black Maria (British)** — adds the ace and king of spades as extra
  penalty cards (7 and 10 points) alongside the queen.

This fixture models only the classic 4-player, 52-card game described
above (standard heart/queen-of-spades scoring, four-hand passing cycle).
The variants are listed for reference, not implemented as separate cards
or rules data — there is nowhere in the schema to represent "an optional
rule," so a variant would need its own game.yaml fork today.

## Quick reference

| Situation              | Rule                                       |
|-------------------------|---------------------------------------------|
| First card of the hand  | Holder of the 2 of clubs must lead it      |
| First trick             | No hearts, no queen of spades, unless forced |
| Leading a new trick     | Hearts only legal to lead once "broken"    |
| Following suit          | Mandatory if able                          |
| Void in the led suit    | Play anything, including penalty cards     |
| Winning a trick         | Highest card of the suit led               |
| Game end                | Someone's score reaches 100+               |
| Winning the game        | Lowest score when it ends                  |
