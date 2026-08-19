# Arcmage — Rules

Condensed rules for Arcmage, assembled from arcmage.org's published "Rules"
page and cross-checked against the rules text of the 70 cards in this port.
Sections marked **[inferred]** were not stated outright on the source page;
they are reconstructed from patterns repeated across many cards' rules text
and should be spot-checked against <https://arcmage.org/rules/> (the live,
canonical version) before relying on them for a real game. Nothing below is
copied verbatim from arcmage.org's page — it is a fresh condensation written
from the concepts found there, per the source's own CC-BY-SA-4.0 terms.

## Overview

Arcmage is a two-or-more-player fantasy card game. Each player controls one
or more **cities**, garrisons creatures as **residents** to defend them, and
marches other creatures out into an **army** to besiege an opponent's
cities. Players win by destroying their opponents' cities while keeping
their own standing.

## Factions and resources

Every card belongs to one of five factions, each tied to a resource color:

| Faction         | Color |
|-----------------|-------|
| Gaian           | Green |
| Dark Legion     | Black |
| Red Banner      | Red   |
| House of Nobles | Blue  |
| The Empire      | White |

Cards from your hand can be turned into **resource cards**: place the card
face down/sideways and declare a faction — from then on it produces
resources of that faction's color. A resource card is either **unmarked**
(available) or **marked** (spent this turn). To play a card you must mark
enough unmarked resource cards of the matching color(s) to cover its
**cost**. Marked resource cards untick (unmark) at the start of your next
turn. **[inferred]** Whether a resource card, once declared, can ever change
its declared faction was not confirmed.

## Card cost

The `cost` attribute on a card is the number of resource cards a player
must mark to play it, with three special values seen in this port:

- A plain number (`1`–`6`): mark that many matching resource cards.
- `S`: the card has no resource cost — this appears only on **City** cards,
  which are set up directly rather than cast from hand.
- `X`: a variable cost chosen by the player when the card is played (e.g.
  *Grassroots*, which scales its own effect by the resources spent).

## Loyalty

Arcmage does not print separate attack and defense numbers on a card. Each
creature has one combined **loyalty** value that stands in for both combat
strength and toughness, modified during play by keyword abilities and
`+X/+Y`-style counters named in its own rules text (e.g. *Foul Imps*: "I get
+1/+1 for each other Imp in play"). On City cards, `loyalty` is the city's
starting **defense strength**.

## The city

Each city has a defense strength (its `loyalty`). When an opposing army
attacks, the city's **residents** (creatures stationed in the city) and, if
present, the defending player's own **army** may help defend it. A city
also grants its controller access to that city's own printed abilities
during the Tactics phase (see below) — this is why every City card in this
port carries "Level N: ..." text.

**[inferred] Devotion and city levels.** Several non-City cards reference
adding a creature's loyalty marks to a city's "devotion" (e.g. *Kelp
Forest*, *Nightingale*), and City cards gate their strongest abilities
behind higher "Level" numbers (1 through 7 across this port's cards). The
pattern implies a city accumulates a devotion total — plausibly from
resident/army loyalty — that unlocks its higher-level abilities, but the
exact accumulation rule was not found in the fetched rules content and is
not asserted here as confirmed.

## Turn structure

A turn is made up of the following phases, in order:

1. **Unmark** — untap (unmark) your marked cards.
2. **Draw & Resource** — draw a card; optionally turn a card from your hand
   into a new resource card.
3. **Tactics** — use strategic advantages granted by your cities (their
   printed "Level N" abilities).
4. **Play** — play cards from hand and use creature abilities; creatures
   may also **move** between a city and an army (or between cities).
5. **Attack** — attacking creatures march out; a defending player's
   residents and army may defend.
6. **Play** — a second play window after combat.
7. **Discard** — discard down to the hand-size limit. **[inferred: exact
   hand-size limit not confirmed.]**

The two Play phases and the Attack phase are **optional** — a player may
pass through any of them without acting.

## Marking a card as a cost ("M,")

Many cards' rules text begins with "**M,**" followed by an effect — for
example *Kolibri*: "Flying — ... **M**, Produce 1 Gaian resource...". `M`
is Arcmage's shorthand for "mark this card" as part of the ability's own
cost (the same underlying mark/unmark state used for resources), distinct
from the card's printed `cost` to play it in the first place.

## Combat

Attacking creatures target an opposing city. The defending player may block
with residents of that city and/or their own army, subject to keyword
restrictions printed on the specific creatures involved (for example,
**Ranged** creatures can defend against **Flying** attackers when ordinary
creatures cannot; **Infiltrate** lets a creature attack into a city
directly rather than through its defenders). Unblocked or lost combats
reduce the target city's defense strength.

## Winning the game

A player who loses all of their cities is knocked out of the game. In a
two-player game this ends the match. Arcmage is explicitly designed to
support more than two players at once, and its win conditions are written
so that a knocked-out player isn't excluded for the rest of a long game —
see the **Aminduna Format** team variant below, which arcmage.org
describes as chosen specifically to "not exclude the 'out of the game'
player for too long, while still allowing an all-in/sacrifice/take-one-
for-the-team option."

### Aminduna Format (team variant)

A multiplayer team mode (2v1, 3v1, and similar splits) in which a team
plays together against a single "overlord" opponent. The base rules apply
with team-specific adjustments that were not captured in this port — see
<https://arcmage.org/rules/> ("Aminduna Format" section) for the full
variant text.

## Keyword glossary (as used in this port's cards)

Definitions below are drawn directly from how each keyword is explained
inline the first time a card in this port uses it; Arcmage prints keyword
reminder text on the card itself rather than in a separate rulebook
glossary, so this list is necessarily partial (limited to the 70 cards
ported here, not the full keyword set of the live game).

- **Flying** — creatures without flying (and without Ranged) cannot block
  this creature.
- **Ranged** — this creature can defend against creatures with Flying.
- **Sudden** — this creature can be played directly into your army
  (skipping the city).
- **Infiltrate** — this creature can move directly into an opponent's
  city.
- **Peaceful** — this creature cannot attack.
- **Militia** — this creature may attack a second, alternate city.
- **First Strike** — deals combat damage before the opposing creature; the
  opponent only strikes back if it survives.
- **Bodyguard N** — once per turn, may divert up to N damage from another
  target creature you control onto itself instead.
- **Veteran** — this creature is not marked (tapped) for attacking.
- **Fatigue** — this creature enters play already marked.
- **Sanctuary** — (granted by the *Sanctuary* city) protects the creatures
  that have it; the specific protection was not captured verbatim in this
  port.
- **Deadly** — (granted to Undead creatures by *Nirvana of the Undead* at
  Level 3) implies lethal/deathtouch-style combat damage; exact wording not
  captured verbatim in this port.
- **Overrun** — (granted by *Second Sons' Army Camp* at Level 5) implies
  unblocked damage carries over to the defending city; exact wording not
  captured verbatim in this port.

## What this document does not cover

This is a condensed rules summary assembled for a data port, not a
replacement for the official rulebook. In particular, the following were
**not** confirmed from the sources fetched while building this port, and
should be treated as open questions rather than filled in with invented
numbers:

- Starting hand size, starting resources, and city setup at the start of a
  game.
- Exact hand-size limit enforced at the Discard phase.
- Constructed-deck minimum/maximum size (Arcmage sells fixed
  preconstructed decks; whether an official constructed-format size exists
  was not confirmed — see `formats/standard.yaml`).
- The full "Aminduna Format" team-variant rules text.
- Full reminder text for the Sanctuary, Deadly, and Overrun keywords.

For the authoritative, current rules, see <https://arcmage.org/rules/>.
