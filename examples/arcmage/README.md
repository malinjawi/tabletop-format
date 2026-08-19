# Arcmage

**This is a public, hostable port of a real, currently-developed open-source
card game.** Unlike the ported games under `examples/_fixtures/` (Netrunner,
Hearthstone, Hearts), Arcmage's own license explicitly permits exactly this:
redistributing, hosting, and even selling the game, provided the same
license carries forward. That's why this directory lives under `examples/`
directly — it's a flagship, not a test fixture.

## What Arcmage is

Arcmage is a fantasy trading card game developed since 2013 by the
wtactics.org open-source card-game community. Players summon creatures and
cast spells from one of five factions to defend their own cities while
besieging their opponents'. It ships as physical print-and-play/retail
card sets and as a free browser card database + online play client at
<https://aminduna.arcmage.org/>.

## Data source (what actually worked)

The data-hunting plan for this port tried, in order: (1) the `wtactics/
arcmage` GitHub repo's card/data directories, (2) the live Aminduna card
database API, (3) the legacy `wtactics/arcmage_legacy` repo. **Source #2
worked** and is what this port is built from:

- The `wtactics/arcmage` repo's own README confirms it ships with **no**
  card data ("You'll notice that http://localhost:5000 doesn't show any
  cards/decks. This software stack comes with no cards or artwork.") — real
  cards live only in the production database behind aminduna.arcmage.org.
  The GitHub REST API (`api.github.com/repos/.../contents`, `/git/trees`,
  etc.) was also unreachable from this build sandbox for anything beyond
  the bare repo-metadata endpoint (empty responses on every sub-path
  tried — plausibly anonymous rate-limiting on a shared egress IP).
- **`https://aminduna.arcmage.org/api/Cards/{guid}`** and
  **`https://aminduna.arcmage.org/api/Decks/{guid}`** (note: capitalized
  routes — the lowercase `/api/card` shapes suggested by convention 404)
  are live, unauthenticated, real endpoints returning full card JSON
  (name, artist, artwork license, rules text, type, faction, cost,
  loyalty, set). No bulk `/api/Cards` list/search endpoint could be found
  (every shape tried 404'd), so this port fetched four complete
  **preconstructed decks** by GUID — each deck response embeds full card
  records for every card in it — rather than cards one at a time:
  - *Rebirth: Uneasy Alliance* (Dark Legion + Red Banner, 17 cards)
  - *Rebirth: Gaian Love for Life* (Gaian, 18 cards)
  - *Enchanted Realm: The Empire's Thugs* (The Empire, 18 cards)
  - *Enchanted Realm: Merfolk* (House of Nobles, 17 cards)
  - `/api/Factions`, `/api/CardTypes`, and `/api/Series` (lookup tables)
    confirmed the full faction, card-type, and set enumerations.
- This yields **70 real cards** — all fully-owned card records from
  Arcmage's live database, not reconstructed from memory — covering
  **all five playable factions** and 5 of Arcmage's 7 card types
  (Creature, Event, Enchantment, Magic, City; no Equipment or faction-less
  card happened to be in these four decks).
- Rules content (turn structure, resource system, city defense, win
  conditions, faction colors) was pulled from arcmage.org's own "Rules"
  page (<https://arcmage.org/rules/>) and condensed — not copied verbatim —
  into `rules/rules.md`, which also flags every point that page didn't
  cover.
- Nothing in this port is reconstructed-from-memory filler. Where the
  source data was incomplete (two card texts were truncated mid-sentence
  by the fetch), that is marked inline in `components/cards.json` rather
  than silently patched over — see "Known gaps" below.

## License — read this before reusing

Arcmage's license page (<https://arcmage.org/license/>) splits licensing
three ways, and this port only touches two of them:

1. **Game license** (rules text + card rules text): **CC-BY-SA-4.0**. This
   is `game.yaml`'s top-level `license`.
2. **Artwork**: mixed, tracked **per card** in `components/printings.json`
   (`provenance.license`), taken from the exact `artworkLicense` value the
   live API returned for that card:
   - **CC-BY-SA-4.0** for original Arcmage/wtactics.org art (49 of 70
     cards here, principally illustrated by **Santiago Iborra**).
   - **GPL-2.0** for the 21 cards whose art was reused from the *Battle
     for Wesnoth* project under a sharing agreement with wtactics.org
     (recorded by Arcmage's own database as `"GNU GPLv2"`; artists Kathrin
     Polikeit, Chris Wilson, Emilien Rotival, Phil Barber, Christian
     Sirviö, and Justin Nichols). Arcmage's license page notes any BfW-art
     licensing questions should go to the Wesnoth maintainers, not Arcmage.
3. **Software** (the `wtactics/arcmage` codebase itself): GPL-3.0. This
   port does not use or copy any of that software — only game/card data —
   so it isn't relevant here.

Both licenses used in this port are share-alike copyleft: **if you fork or
redistribute this directory, it (and anything derived from it) must stay
under the same terms** (CC-BY-SA-4.0 for the game text; GPL-2.0/CC-BY-SA-4.0
per the original art license for each card's art, per
`components/printings.json`). Full license texts:
<https://creativecommons.org/licenses/by-sa/4.0/> and
<https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

## Card layout: this is a real, editable, print-ready card now

`examples/arcmage/templates/layout.yaml` is a full card layout spec (see
`docs/layout-engine.md` and `schemas/layout.schema.json`) — a
faction-colored frame, a title bar, an art window, a type line, a rules
text box with `[symbol]` chips and shrink-to-fit, and cost/loyalty badges,
positioned in real millimeters at the true 63.5mm x 88.9mm trading-card
trim size. `layoutCard()` (`tools/hub_template.html`) renders it — the
cards grid, the card modal, the live card editor preview, the PR visual
diff, and the true-size print sheet all draw the SAME spec. Before this,
every card here rendered through the generic `cardFrame()` template like
every other game; now editing a card's name/cost/text in the editor
reformats the actual print-ready card, live, and `🖨 Print` on the Cards
tab produces that same card at true size with cut lines.

## Artwork: hot-linked, and now (probably) the RAW art layer, not the composed card

`components/printings.json`'s `image` field points at
`https://aminduna.arcmage.org/arcmage/Cards/{card-guid}/card.jpg` — the
live Arcmage database's own fully-composed, rendered-card image (frame +
art + text baked together) for that exact card. This port hot-links that
URL and never downloaded or re-hosted the binary image itself; it's kept
as the `original_print` reference shown alongside the live-rendered card
everywhere in the hub. Every card's GUID was recovered from the live API
responses fetched while building this port (either directly, for
individually-fetched cards, or by position from the deck-listing JSON,
where each card's own GUID reliably appears immediately after its
`language` field — cross-checked against directly-fetched cards to confirm
the pattern before trusting it for all 70).

Every printing now **also** carries `art_url`, pointed at
`https://aminduna.arcmage.org/api/Cards/{card-guid}/export?format=Art` —
what `templates/layout.yaml`'s `art` region actually composites into the
rendered card, instead of the composed image above. What's confirmed and
what isn't:

- **Confirmed**: fetching a card's full JSON record from the live API
  (`https://aminduna.arcmage.org/api/Cards/{guid}`) returns an `artwork`
  field with exactly this URL shape, distinctly named and separate from
  the composed-card exports on the same record (`png`/`svg`/`jpeg`/`pdf`/
  `webp`, `format=Png`/`format=Svg`/etc. — `jpeg` is the same URL as this
  port's `image` field). The same record also exposes `backgroundPng`
  (`format=BackgroundPng`, parameterized by `faction`+`type`, not by
  card — clearly the reusable frame texture) and `overlaySvg`
  (`format=OverlaySvg` — clearly the name/cost/text overlay). Put
  together, this is strong structural evidence that Aminduna's own card
  renderer is itself layered (art + frame + text overlay, composited into
  the `png`/`jpeg`/etc. exports) exactly the way this platform's own
  `layoutCard()` now is, and that `format=Art` is the dedicated raw-art
  export. This pattern was checked against two different cards (Abduction,
  Cutpurse Imp) and is consistent between them. The independent, official
  `wtactics/art` GitHub repository (CC-BY-SA-4.0, linked from arcmage.org's
  own site nav as "Artwork → Repository") further corroborates that raw,
  uncomposed artwork is a real, separately-maintained asset category for
  this project — organized by art-piece name rather than card GUID, which
  is why this port uses the API's GUID-keyed `format=Art` URLs instead of
  trying to fuzzy-match 70 card names against that repo's folder names.
- **NOT confirmed**: this session's sandbox can fetch and render *text*
  responses but not binary/image ones, so the actual pixels behind
  `format=Art` were never visually compared against the composed card —
  the case above is structural/circumstantial, from the API's own
  self-description, not a pixel diff. `art_url` is wired in because the
  evidence is real and specific, but every `image` region in
  `layoutCard()` also always paints a tinted (faction-palette-colored)
  placeholder with the artist's credit *underneath* the `<img>` tag, shown
  automatically if the URL ever 404s or turns out to be something other
  than expected — so a card never goes visually blank or silently shows
  the wrong thing either way. If you can verify the pixels (or find they
  match the composed card after all), please update this note.

## What was ported vs. what wasn't

- **70 of Arcmage's ~362 total cards** (per the live site's own "362
  unique cards" counter): the complete contents of four official
  preconstructed decks, chosen to cover every faction rather than an
  arbitrary sample.
- **2 of Arcmage's 5 released sets** (Rebirth, Enchanted Realm — Set 3 New
  Horizons, Set 4 Shadow Waves, and Set 5 Changing Winds exist and are for
  sale at arcmage.org/shop/ but weren't part of the four decks fetched).
- Collector numbers are **this port's own** sequential assignment
  (Arcmage's database keys cards by GUID, not print position) — noted in
  `sets/sets.yaml`.
- `deck_limit: 3` on every card is this port's own default, not a
  confirmed Arcmage rule.
- No official banlist/restriction list was found or ported — `formats/
  standard.yaml` accordingly declares no `active_restriction_id`.
- No sample decks are included in `decks/` — the four source
  preconstructed decks could be reconstructed from this data but weren't
  built out as `decks/*.json` files for this initial port.

## Known gaps (marked, not silently patched)

- **Two card texts were cut short by the fetch**: *Farmland* ("Level 2:
  Put a 0/1 crop token into play as my resident.") and *Poison Ivy*
  ("...it gets an additional counter.") both had a trailing clause
  truncated at an internal quote in the source JSON. Rather than invent
  the missing words, `components/cards.json` keeps the confirmed portion
  and appends an explicit `[...not captured in source fetch]`-style note
  in the card text itself.
- **Set release dates are approximate** (see `sets/sets.yaml`) — derived
  from the earliest card-record creation timestamps seen per set, not an
  official product-launch date.
- **Deck construction rules, starting setup, hand size, and the Aminduna
  team-format details** were not found in the rules content fetched — see
  the "What this document does not cover" section of `rules/rules.md`.

## Attribution

Arcmage is designed, developed, and illustrated by the **wtactics.org /
Arcmage open-source community** — see <https://arcmage.org/credits/> for
the full contributor list. This port packages a slice of their published
game data into this platform's format; it makes no claim of authorship
over the game, its rules, or its art. If you build on this port, the
underlying attribution (and the CC-BY-SA-4.0 / GPL-2.0 licenses above)
must travel with it.

- Project: <https://arcmage.org/>
- Card database / play online: <https://aminduna.arcmage.org/>
- Source repository: <https://github.com/wtactics/arcmage>
- Artwork repository: <https://github.com/wtactics/art>
- Community: Matrix (`#wtactics:matrix.org`), Discord
  (<https://discord.gg/VqTDwSq>), Mastodon (`@arcmage@mastodon.social`)
