# Netrunner: System Gateway — Condensed Rulebook

*A test-fixture rulebook for the asymmetric cyberpunk card game. Condensed from
the public rules of Android: Netrunner / Null Signal Games' Netrunner, covering
only what is needed to play with the 77-card System Gateway set. Not the
official rulebook; written from general knowledge for platform testing.*

## 1. Overview

Netrunner is a two-player, perpetually asymmetric card game. One player is the
**Corp** (a megacorporation), the other is the **Runner** (a hacker). Each side
has entirely different cards, win conditions framing, and turn actions:

- The **Corp** installs assets, ice (defenses), and agendas face-down inside
  **servers**, and tries to advance and score agendas before the Runner can
  steal them.
- The **Runner** makes **runs** on the Corp's servers, fighting through ice
  with installed programs (icebreakers) to reach and access cards.

Each player builds a deck around a single **identity** card, which fixes their
faction, starting resources, and deckbuilding limits.

## 2. Win conditions

- **Score/steal 7 agenda points.** The first player (Corp or Runner) whose
  scored/stolen agendas total 7+ **agenda points** wins immediately.
- **Flatline.** If the Runner is dealt damage and has fewer cards in the Grip
  (hand) than the damage requires them to discard, the Runner is *flatlined*
  and the Corp wins immediately.
- **Deck-out.** If the Runner is required to draw a card from an empty Stack
  (deck), the Runner loses immediately. The Corp does **not** lose this way —
  a mandatory draw from an empty R&D simply does nothing.

## 3. Zones

| Corp                | Runner            | Contents |
|----------------------|--------------------|----------|
| HQ                   | Grip               | Hand |
| R&D                  | Stack              | Deck |
| Archives             | Heap               | Discard pile |
| Servers (remote/central) | Rig            | Installed cards |

Central servers are **HQ**, **R&D**, and **Archives** themselves (they can be
protected by ice and have upgrades installed in their "root"). **Remote
servers** are new servers the Corp creates by installing a card into them.

## 4. Setup

1. Each player picks one identity and builds a legal deck for it (§10).
2. Shuffle decks. Corp draws an opening hand of 5 cards; Runner draws 5.
3. Each player may take **one mulligan**: shuffle your opening hand back into
   your deck and draw a fresh 5-card hand. Decided independently/simultaneously.
4. Corp takes the first turn.

## 5. Turn structure

### Corp turn
1. **Turn begins:** draw 1 card automatically (mandatory, does not cost a click).
2. Gain **3 [click]**.
3. Spend clicks on actions (§6), in any order, until out of clicks or passing.
4. **Turn ends:** if HQ has more than the Corp's maximum hand size (5, unless
   modified), discard down to it.

### Runner turn
1. **Turn begins:** no mandatory draw.
2. Gain **4 [click]**.
3. Spend clicks on actions (§6).
4. **Turn ends:** if the Grip has more than the Runner's maximum hand size (5,
   unless modified), discard down to it.

Both players may pass remaining clicks without using them; nothing carries
over to the next turn.

## 6. Basic actions

Each action costs 1 [click] unless noted otherwise. Some also cost credits.

**Corp basic actions**
- Gain 1 [credit].
- Draw 1 card.
- Play an operation from HQ, paying its cost.
- Install a card from HQ: an agenda, asset, or upgrade into a server (a new
  remote, or the root of an existing server); or a piece of ice, added as the
  new outermost protection on any server. Installing is free — only [click] is
  spent; the printed cost is paid later to **rez** it.
- Advance a card ([click] + 1[credit]): place 1 advancement counter on an
  installed card that can be advanced (agendas always can; some assets/ice say
  "You can advance this").
- Score an agenda: if an installed agenda has advancement counters ≥ its
  advancement requirement, spend 1 [click] to move it to the score area,
  face-up. Its agenda points are added to the Corp's total.
- Trash 1 installed resource ([click] + 2[credit]) — only while the Runner is
  tagged.
- Purge virus counters ([click]): remove every virus counter from every card.

**Runner basic actions**
- Gain 1 [credit].
- Draw 1 card.
- Play an event from the Grip, paying its cost.
- Install a card from the Grip (program, hardware, or resource), paying its
  cost immediately. Runner cards install face-up and are active at once —
  there is no separate rez step.
- Run: declare a server (HQ, R&D, Archives, or a remote) and begin a run (§8).
- Remove 1 tag ([click] + 2[credit]).

Both sides also take actions printed on their own installed/in-hand cards,
which may cost clicks, credits, or both, as printed.

## 7. Ice and rezzing

Ice is installed face-down protecting a server, ordered outermost (installed
first / met first) to innermost (closest to the server). Corp cards
(ice, assets, upgrades) do nothing and show no text until **rezzed** — paid
for in credits (the printed cost) — which flips them face-up. Agendas are
never rezzed; they are simply advanced and scored.

## 8. The run, step by step

1. **Initiation:** Runner spends 1 [click], names a server.
2. **Approach ice:** the Runner approaches the outermost *unpassed* ice on
   that server (skip to step 5 if there is none left).
3. **Rez window:** the Corp may rez the approached ice now, if not already rezzed.
4. **Encounter** (only if the ice is rezzed): the Runner may use icebreaker
   programs (paying their break costs) to break some or all of the ice's
   subroutines. Every subroutine that is **not** broken resolves, top to
   bottom, automatically. A Fracter breaks **barrier** subroutines, a Decoder
   breaks **code gate** subroutines, a Killer breaks **sentry** subroutines;
   an **AI** icebreaker can break any type.
5. If the run has not been ended, the Runner **passes** the ice (or, if
   unrezzed, simply passes through it) and may voluntarily **jack out**
   (end the run) unless something prevents it. Otherwise return to step 2 for
   the next ice inward.
6. **Approach the server:** once all ice is passed, the Runner approaches the
   server itself (one last rez window for the Corp — upgrades, ambushes, etc).
7. **Access** (§9) — the run is now successful.

## 9. Accessing cards

What gets accessed depends on the server:
- **HQ:** access N cards (default 1) picked at random from the Corp's hand.
- **R&D:** access the top N cards (default 1) of the Corp's deck.
- **Archives:** access **every** card in Archives, face-up or face-down.
- **Remote server:** access every card installed in that remote.

For each accessed card:
- **Agenda:** the Runner steals it for free — it moves to the Runner's score
  area and its agenda points count toward the Runner's total.
- **Anything else (asset/upgrade):** the Runner may pay its trash cost to
  trash it, or leave it. Some cards trigger an effect simply from being
  accessed ("ambush" cards), whether or not they are then trashed.

## 10. Deckbuilding

- Exactly one identity per deck; its `side` fixes which cards you may use.
- **Minimum deck size** is set by the identity (`attributes.minimum_deck_size`
  — 40 for the seven faction identities in this set, 30 for the two neutral
  starters). No deck has a maximum size.
- **Influence.** A card whose faction matches your identity, or a neutral
  card, costs 0 influence regardless of its printed value. An out-of-faction
  card costs influence equal to its printed `influence` value. Total influence
  spent across the whole deck cannot exceed the identity's
  `attributes.influence_limit` (15 for the seven faction identities; the two
  neutral starter identities have **no** influence limit at all — they cannot
  splash any out-of-faction card).
- **Agenda density (Corp only).** The deck's total printed agenda points must
  be at least 2 points for every 5 cards in the deck, rounded up:
  `min_agenda_points = 2 × ceil(deck_size ÷ 5)`. A 45-card deck therefore
  needs at least 18 agenda points; a 49-card deck needs at least 20.
- Respect each card's `deck_limit` (usually 3; identities and a few singleton
  agendas are 1).
- A deck is also subject to whatever **restriction** (banlist) document its
  format currently points at (see `restrictions/`) — banned cards may not be
  included at all; restricted cards are capped at 1 copy.

## 11. Tags

A **tag** marks the Runner as identified/traced. Tags do not expire on their
own — they persist until removed (Runner's "Remove 1 tag" basic action, or a
card effect). While tagged, the Runner is vulnerable to Corp effects that key
off tags (e.g. the Corp's "trash a resource" basic action, or cards that give
meat damage or trash installed cards specifically "if the Runner is tagged").

## 12. Damage

- **Net damage** and **meat damage** each cause the Runner to discard that
  many cards at random from the Grip. (They differ only in which card
  abilities can prevent them — net damage represents virtual/brain interface
  attacks, meat damage represents physical harm.)
- **Core damage** (brain damage) does the same, **and** permanently reduces
  the Runner's maximum hand size by 1 per point, in addition to the discard.
- If a discard would require more cards than the Grip contains, the Runner is
  flatlined and loses immediately (§2).

## 13. Memory units (MU)

The Runner has 4 memory units (MU) by default (some hardware adds more, noted
via a card's own `+1[mu]` text). Every installed program's `memory_cost`
counts against this pool; a program cannot be installed if doing so would
exceed available MU.

## 14. Trash costs

An asset or upgrade's `trash_cost` is what the Runner pays, during access, to
trash it. Ice has no trash cost — it is never "accessed", only passed — and
can normally only be removed from a server by specific card effects.

## 15. Glossary

- **Rez** — pay a Corp card's cost to flip it face-up and activate it.
- **Advance** — add an advancement counter (Corp).
- **Breach** — begin accessing cards at a server after a successful run.
- **Jack out** — voluntarily end a run early.
- **Persistent** — an ability that keeps applying even after the source card
  is trashed, for the stated duration.
- **[subroutine]** — marks an ice ability that resolves automatically unless
  broken during an encounter.
