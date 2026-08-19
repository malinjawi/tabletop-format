# Secret Hitler — Rulebook

*A social deduction game for 5-10 players. The year is 1932, pre-WWII
Germany: players are German politicians trying to hold a fragile Liberal
government together against a rising Fascist tide -- while one player,
secretly, is Hitler. Created by Mike Boxleiter, Tommy Maranges, Max Temkin,
and Mackenzie "Mac" Schubert. CC BY-NC-SA 4.0 — see README.md.*

## Overview

Every player is secretly Liberal or Fascist. Liberals have a numeric
majority but don't know who anyone is; Fascists know each other (and know
Hitler) from the start, but must hide and manipulate to get their agenda
through. Hitler plays for the Fascist team but does **not** know who the
other Fascists are, and must work the room like a Liberal until it's safe
to reveal himself.

Whenever a Fascist Policy is enacted, the government gains power: the
President is granted a one-time Presidential Power that must be used
before the next round begins. Anyone might be tempted to enact a Fascist
Policy for the power it grants -- that tension is the whole game.

## Win conditions

**Liberals win if:**
- Five Liberal Policies are enacted, **or**
- Hitler is executed.

**Fascists win if:**
- Six Fascist Policies are enacted, **or**
- **Hitler is elected Chancellor at any point after the third Fascist
  Policy has already been enacted.** This is usually how Fascists actually
  win -- see Strategy notes.

## Components

- **17 Policy tiles** (6 Liberal, 11 Fascist) — `type: policy`.
- **10 Secret Role cards** (6 Liberal, 3 Fascist, 1 Hitler) — `type: role`.
  Kept private in an envelope; this is your real team.
- **10 Party Membership cards** (6 Liberal, 4 Fascist) — `type: party`.
  Shown to the table when investigated. Hitler's card is a plain Fascist
  card, identical to an ordinary Fascist's -- investigating Hitler never
  reveals that he's Hitler, only that he's Fascist.
- **10 Ja! + 10 Nein! Ballot cards** — `type: ballot`. One of each per
  player, used to vote on every proposed government.
- **President and Chancellor placards** — `type: placard`. Mark the
  current officeholders.
- **Election Tracker** — `type: placard`. Advances on every failed vote
  and every Veto; resets on every enacted Policy.
- *Not modeled as cards in this port*: 10 card envelopes, a draw-pile and
  discard-pile reference card, and three different Liberal/Fascist boards
  (the Fascist track's layout differs by player count -- see Setup below).

## Setup

1. **Pick the Fascist track for your player count** (see the table below)
   and lay it next to the Liberal track.
2. **Shuffle all 17 Policy tiles** into one face-down Policy deck.
3. **Build one envelope per player**: a Secret Role card, the matching
   Party Membership card (Liberal role -> Liberal party card; Fascist or
   Hitler role -> Fascist party card), one Ja! and one Nein! Ballot card.
   Shuffle the envelopes and deal one to each player at random.
4. Everyone privately checks their own Secret Role card only.
5. Pick a first Presidential Candidate at random and hand them both
   placards.
6. **Identify each other, secretly.** With 5-6 players: everyone closes
   their eyes, then Fascists and Hitler open their eyes together to see
   who's on the team (Hitler learns nothing extra). With 7-10 players:
   everyone closes their eyes and makes a fist; ordinary Fascists open
   their eyes to see each other, while Hitler keeps his eyes shut but
   raises a thumb so the *other* Fascists can identify him -- Hitler still
   never learns who they are.

### Role distribution by player count

| Players | Liberal | Fascist (non-Hitler) | Hitler | Fascist team total |
|---|---|---|---|---|
| 5 | 3 | 1 | 1 | 2 |
| 6 | 4 | 1 | 1 | 2 |
| 7 | 4 | 2 | 1 | 3 |
| 8 | 5 | 2 | 1 | 3 |
| 9 | 5 | 3 | 1 | 4 |
| 10 | 6 | 3 | 1 | 4 |

Liberals always outnumber the Fascist team, which is exactly why Fascists
must win through deception and Hitler's election rather than a headcount.

## A round: Election → Legislative Session → Executive Action

### 1. Election

1. **Pass the Presidency.** The President placard moves clockwise to the
   next player -- the new Presidential Candidate.
2. **Nominate a Chancellor.** The Presidential Candidate publicly hands the
   Chancellor placard to any other player they consider eligible, after as
   much table discussion as the group wants.
   - **Term limits**: the most recently *elected* President and Chancellor
     (not just nominated) are ineligible to be nominated Chancellor. With
     only 5 players left, just the last elected Chancellor is ineligible
     (the last President may be renominated). Term limits only ever
     restrict the Chancellor slot -- anyone, including a just-outgoing
     Chancellor, can become President.
3. **Vote.** Every player, including both candidates, votes Ja! or Nein!
   simultaneously, then all ballots are revealed at once.
   - **Majority Ja!** — the candidates become the sitting President and
     Chancellor. If three or more Fascist Policies are already enacted,
     the table must ask the new Chancellor point-blank whether they are
     Hitler, and Hitler must answer truthfully (this is one of the only
     two moments in the game where lying is forbidden -- see "On lying"
     below). If yes, Fascists win immediately. If no, proceed to the
     Legislative Session.
   - **Tie, or majority Nein!** — the vote fails. The Presidency simply
     passes to the next player next round, and the Election Tracker
     advances by one.
   - **Election Tracker at 3** ("chaos"): the top Policy tile is revealed
     and enacted automatically, with any Presidential Power it would have
     granted skipped entirely. The tracker resets and every term limit is
     forgotten -- everyone becomes eligible again. (If fewer than 3 tiles
     remain in the deck at this point, reshuffle the discards into a new
     deck first.) Enacting a Policy this way still resets the tracker, the
     same as a normally-enacted one.

### 2. Legislative Session

The President secretly draws the **top 3** Policy tiles, discards **1**
face down (into a discard pile the table never sees), and hands the other
**2** to the Chancellor. The Chancellor secretly discards **1** of those
and enacts the remaining tile face-up on the matching track.

- **No communication** about the tiles between President and Chancellor is
  allowed, verbal or otherwise, and neither may pick discards by chance
  (shuffling, random draws, or any other trick to dodge responsibility for
  the choice) -- they must each deliberately choose. The President must
  hand over both remaining tiles at once, not one at a time.
- **Discarded tiles are never revealed.** The table only has the President
  and Chancellor's word for what happened -- and either of them may lie
  about it freely (see "On lying").
- If fewer than 3 tiles remain in the deck at the end of a session,
  reshuffle the discard pile into a new deck (never reveal the unused
  tiles, and never simply place them on top of the fresh deck).
- Enacting **any** Policy resets the Election Tracker to zero, whether
  it happened through a normal session or through chaos.
- If the enacted tile is a Fascist Policy that grants a power (see the
  track tables below), go to **Executive Action**. Otherwise, start a new
  round with a new Election.

### 3. Executive Action

If the just-enacted Fascist Policy grants a power, the sitting President
**must** use it before the next round can begin (after as much table
discussion as they like). Powers are used exactly once and never carry
over.

## Presidential Powers by Fascist track

The Fascist track differs by player count -- more players means more
"cover" for a Fascist Policy to slip through, so bigger tables unlock
powers earlier.

**5-6 players**

| Fascist Policy # | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Power | — | — | Policy Peek | Execution | Execution | *(Fascists win)* |

**7-8 players**

| Fascist Policy # | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Power | — | Investigate Loyalty | Special Election | Execution | Execution | *(Fascists win)* |

**9-10 players**

| Fascist Policy # | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Power | Investigate Loyalty | Investigate Loyalty | Special Election | Execution | Execution | *(Fascists win)* |

> These per-player-count power slots are standard, widely published
> Secret Hitler content (printed on the physical Fascist track boards
> shipped in the box). This port's rules text for the four powers below
> is condensed from the official rules PDF; the exact slot table above
> was reconstructed from well-established public knowledge of the boards
> rather than machine-extracted from the print-and-play PDF, which renders
> its board art as images rather than text -- see README.md.

### Investigate Loyalty

The President picks a player, who privately hands over their **Party
Membership card only** (never the Secret Role card) for the President to
inspect and return. The President may report the result honestly, lie
about it, or say nothing -- their choice. No player may be investigated
twice in one game.

### Call Special Election

The President hands the President placard to any other player at the
table (even a term-limited one) to be the *next* Presidential Candidate,
out of turn. Play resumes as a normal Election from there and doesn't skip
anyone -- afterward, the Presidency returns to the player immediately to
the left of whoever called the Special Election, so that seat may end up
running for President twice in a row (once by the special election, once
in the normal rotation).

### Policy Peek

The President privately looks at the **top 3** tiles of the Policy deck
and puts them back in the same order. No other effect.

### Execution

The President names one player at the table to execute. If that player is
Hitler, the game ends immediately in a Liberal victory (Hitler must admit
it -- the other moment where lying is forbidden). Otherwise, the table
does **not** learn whether a Liberal or a Fascist was just killed; everyone
has to reason it out. Executed players are out of the game entirely: no
more speaking, voting, or holding office.

## Veto Power

Once the **fifth** Fascist Policy has been enacted, every subsequent
Legislative Session gains a standing option: after the President hands
over 2 tiles as usual, the Chancellor may announce a veto instead of
discarding/enacting. If the President agrees, both tiles are discarded
and no Policy is enacted this round (the Presidency still passes normally
next round). If the President refuses, the Chancellor must enact a Policy
as normal after all. Every completed veto still advances the Election
Tracker by one, the same as a failed vote.

## On lying

Hidden information is everywhere in Secret Hitler -- who saw which Policy
tiles, what an investigation actually turned up -- and players may lie
about any of it, freely, at any time. The **only** exception: a player who
is revealed to be Hitler, either by execution or by the mandatory
Chancellor question after the third Fascist Policy, must truthfully admit
it. Every other statement in the game, including "I'm a Liberal," may be
a lie.

## Strategy notes (condensed)

- Every player, Liberal or not, should generally *claim* to be Liberal --
  the Liberal majority can shut out anyone who claims otherwise, so
  outing yourself as Fascist rarely helps the Fascist team.
- Liberals are solving a puzzle and usually benefit from telling the
  truth and slowing the table down to actually discuss; Fascists usually
  benefit from rushing votes and manufacturing confusion.
- **Fascists win far more often by electing Hitler than by enacting six
  Policies.** Hitler should play like an ideal Liberal -- calm, honest,
  non-confrontational -- right up until the Fascists can maneuver him into
  the Chancellorship after the third Fascist Policy.
- When a Fascist Policy appears, only three things could have caused it:
  the President, the Chancellor, or bad luck in the deck. Working out
  which is most of the Liberal game.

## Win conditions (recap)

| Team | Wins by |
|---|---|
| Liberal | 5 Liberal Policies enacted, **or** Hitler executed |
| Fascist | 6 Fascist Policies enacted, **or** Hitler elected Chancellor after 3+ Fascist Policies are enacted |

## Sources

Rules content above is this port's own condensed restatement of the
official rules PDF at secrethitler.com (CC BY-NC-SA 4.0), with the
Fascist-track power-slot table reconstructed from well-established public
knowledge of the physical boards (not machine-extracted text -- see
README.md). Not copied verbatim from the official rulebook's wording or
layout.
