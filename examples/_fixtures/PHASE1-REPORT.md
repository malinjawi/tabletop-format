# Phase 1 port report — what real games broke

Three full games ported as test fixtures (rules, formats, decks, banlists — not just cards).
All three validate 0-errors and render; both TCG sample decks pass check_deck. Netrunner is
REAL data: all 77 System Gateway cards + the live MWL banlist fetched from NetrunnerDB.
Hearthstone: 45 accurate hand-transcribed Classic cards. Hearts: complete 52-card game.

## Headline: the pipeline held; the RULES layer didn't
Real card data flowed through import→validate→render→deck-check with zero importer changes.
Every serious break is in one place: **the format can describe cards, but not the LAWS of a
game** — deckbuilding constraints, ownership structure, procedure.

## The RFC list (priority order, with evidence)

**RFC-1 · Deck-rules expression vocabulary** (hit by all three)
check_deck passed an illegal tri-class Hearthstone deck and would pass an over-influence
Netrunner deck. Needed: per-rarity copy limits, influence budgets (spend per off-faction card),
agenda-density formulas (2 per 5 cards), class/side pool restrictions, singleton rules.
Static min/max size is all we have today.

**RFC-2 · Deck anatomy: modes + identity slot**
Netrunner identities smuggled in as regular cards (off-by-one sizes, nothing enforces exactly-one).
Hearthstone heroes/hero-powers have NO schema home at all. Hearts has no deck concept whatsoever.
Decks need modes (constructed / sealed-identity / none-shared) + a first-class identity/hero slot.
(KeyForge in Phase 3 will demand the sealed mode — already proven needed.)

**RFC-3 · Attribute system v2**
No enums/ranges (suit:"haert" validates silently). `required` is global, not per-type (a minion
without health validates). Magic/Pokémon (Phase 2) will add symbol-string costs and structured
sub-objects (attacks) on top of this.

**RFC-4 · Renderer honesty** (+1 real bug found)
The reference renderer shows only 2 of Netrunner's 8 numeric attributes — silent data loss on
faces. All 52 Hearts cards render 98.3% pixel-identical (color only follows type, never suit).
BUG: render_back() ignores game type_colors and hardcodes Ember's palette — masked until now
because the constant equaled Ember's own color. Badges must be driven by attribute_definitions.

**RFC-5 · Faction/class as first-class** — factions have no colors/pools; type_colors is the
only display driver. Netrunner factions and HS classes both landed as bare string attributes.

**RFC-6 · Restrictions v2** — live MWL disproved "SG has no bans" (Cleaver, Luminal
Transubstantiation, Offworld Office are banned today). Real banlist history also uses partial
deck-limit reductions and point systems; our model only knows ban / restrict-to-1.

**RFC-7 · Procedure has no home** — Hearts' entire game (tricks, passing, breaking hearts) is
100% prose; a tool reading the data cannot lay out or run the game. This is the same `setup`/
turn-structure spec the Play-in-browser port needs. One spec serves both.

**RFC-8 · Schema hygiene** — keywords[] vs subtypes[] overlap (keywords empty on all 77 NRDB
cards); printing.quantity means "copies in set" but is used as deck limit (Ember's own precedent).

## Meta-findings
- Fixtures live in examples/_fixtures/, test-only, never in a public deploy.
- Each fixture carries its own WHAT-BROKE.md with full evidence.
- Phase 2 (Magic, Pokémon, Yu-Gi-Oh) stresses RFC-3 hardest; recommend landing RFC-1/-3/-4
  before Phase 2 so the next ports test fixes, not re-find known gaps.
