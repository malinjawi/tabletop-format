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

## Card layout: derived from Arcmage's OWN official template, not a guess

`examples/arcmage/templates/layout.yaml` is a full card layout spec (see
`docs/layout-engine.md` and `schemas/layout.schema.json`, and that doc's
"Importing an official template (case study: Arcmage)" section for the
full method). `layoutCard()` (`tools/hub_template.html`) renders it — the
cards grid, the card modal, the live card editor preview, the PR visual
diff, and the true-size print sheet all draw the SAME spec. Before this,
every card here rendered through the generic `cardFrame()` template like
every other game; this port's *first* layout (still visible in git
history) was a plausible-looking faction-colored frame invented for this
project, with no real connection to Arcmage's own card design. This
version replaces that with one derived from **Arcmage's own
card-generation source and live API** — `wtactics/arcmage`'s
`Arcmage.Server.Api/Layout/CardGenerator.cs`, `Styles.cs`, and
`Arcmage.DAL/Repository.cs`, plus 55+ live card records fetched from
`aminduna.arcmage.org` while building it. What that changed, and what's
confirmed vs. still an estimate:

**Confirmed directly from Arcmage's own code/API** (not inferred from a
rendered image):
- **Card size: 65mm x 92mm** (not the 63.5mm x 88.9mm "poker" trim size
  this port's first layout assumed) — a European trading-card size,
  consistent with the wtactics.org team. `CardGenerator.cs`'s SVG-merge
  step forces every card's content to `230.31496 x 325.98425` SVG
  user-units inside a `244.48819 x 340.15747` print-bordered canvas; at
  `1 unit = 1/90 inch` (the `7.0866184`-unit margin resolves to an exact
  2.0mm at that ratio, confirming the unit system) that's exactly 65mm x
  92mm content in a 69mm x 96mm bordered canvas — `card.w_mm`/`h_mm`/
  `bleed_mm` in the layout below.
- **The rules-text box is 53.62mm x 29.63mm on EVERY card type**
  (`190 x 105` units — `Repository.cs`'s `FillPredefinedCartTypes()`),
  used verbatim as the `text` region's `w`/`h`.
- **Body font: Liberation Serif** (regular/bold/italic/bold-italic,
  11.25pt, 1.25x line spacing — `Styles.cs`), plus a **Nimbus Roman No9
  L** drop-cap for paragraphs that open with a `:X:`-style illuminated
  capital letter (`CardGenerator.cs`'s `case "c":` text-layout branch) —
  this layout doesn't attempt the drop-cap effect (see "Not replicated"
  below). Neither font ships on Google Fonts (confirmed: `google/fonts`
  issue #180, open, unresolved) — **Tinos**, Google's own metric-
  compatible Times New Roman clone (same lineage/purpose as both official
  faces), is substituted for both `title`/`body` in `fonts:`, not a
  decorative pick — this port's first layout used "Cinzel" + "EB
  Garamond" for looks alone, with no tie to Arcmage's actual design.
- **Attack and Defense are real, separate printed stats** — Creature
  cards print both, City cards print Defense alone (as the city's total
  defense, distinct from and usually much larger than its loyalty pip
  count), everything else prints neither (`ShowAttack`/`ShowDefense` per
  card type in `Repository.cs`, cross-checked against every Creature/City
  card's live API record). **This corrects an earlier, wrong claim in
  this port's `game.yaml`** that Arcmage has no separate attack/defense —
  it does; only Loyalty is the single combined-looking stat, and even
  that isn't quite what it looks like (next point). `attack`/`defense`
  were backfilled from the live API for all 40 Creature + 12 City cards
  in this port (see `game.yaml`'s `attribute_definitions` for the fetch
  details).
- **Loyalty renders as up to 3 pip icons** (element ids `L1`/`L2`/`L3`,
  lit when loyalty > 0/1/2 — `SetLoyalty()`), not a printed number. This
  layout still renders it as a numeric badge — a disclosed
  simplification, not a claim that Arcmage prints a digit there.
- **The card's "type line" is the SubType, not the primary type** —
  element id `cardtypetext` is set from `Card.SubType` alone
  (`SetType()`); the primary type (Creature/Event/City/...) is NEVER
  printed as text anywhere, only expressed via the frame art. Arcmage's
  own SubType is never blank (it repeats the primary type name, e.g.
  "Event", when a card has no more specific flavor subtype like "Imp") —
  this port's `subtypes` field follows the same convention (empty exactly
  when Arcmage's subType would repeat the type name). The layout
  reproduces "show exactly one such string" with two regions and
  complementary `show_if: "subtypes"` / `show_if: "!subtypes"`; the first
  layout wrongly showed a primary-type label AND a subtype as two
  separate strings, which the real card never does.
- **No faction-name text is printed anywhere on the card** — faction
  reads purely through frame color/art. Confirmed two ways: `Styles.cs`/
  `CardGenerator.cs` never set any faction-name text element, and
  `CardsController.cs`'s `Patch` action's `hasLayoutChanges` field list
  (everything a card edit can change on the rendered card) never includes
  Faction, only Name/SubType/Cost/Loyalty/Attack/Defense/Info/
  MarkdownText. This layout accordingly has no faction-name text region
  (the first layout did).
- **Every real card carries a fixed `"arcmage.org - join us!"` info
  line** (element id `infotext`, default baked into `Repository.
  CreateCard`'s `JoinUsText`) — confirmed on every one of 55+ sampled
  live cards across all 5 factions. Written as a literal in the layout
  (not per-card data) since it never varies.
- **`backgroundPng` is a reusable per-faction+card-type frame texture,
  looked up by faction+type ALONE** — confirmed in
  `CardsController.cs`'s `Export` action:
  `Repository.GetBackgroundPngFile(faction.Name, type.Name)`, which never
  reads the card guid in the URL. `overlaySvg` is genuinely per-card
  (`Repository.GetOverlaySvgFile(id)`), the dynamic text/art overlay.
  Both URL shapes (`.../export?format=BackgroundPng&faction={guid}&
  type={guid}`, `.../export?format=OverlaySvg`) were confirmed against
  live card JSON records across all 5 factions and 5 ported card types.

**Approximated** (the actual per-faction/per-card-type template SVG
files — `CardTemplates/{faction}/{type}.svg` — live only on Arcmage's
server, are not in the `wtactics/arcmage` git repo, and this session's
tools could not read raw SVG/PNG bytes over the network — see
`docs/layout-engine.md`'s case study for why): the exact `x`/`y` of the
title, cost badge, art window, type line, and Attack/Defense/Loyalty
badges below. These are placed using the CONFIRMED card size and
rules-text-box size as anchors (this layout's 5.7mm side margins are
chosen so the rules-text region comes out exactly 53.6mm wide, matching
the confirmed 53.62mm) — a reasoned estimate, not a traced measurement.
Every text region also carries a translucent backing plate that is
**not** part of the official design either, added specifically because
this session could never visually inspect the real `backgroundPng`/
`card.jpg` pixels (no tool here can render remote binary images), so
text legibility against the real frame art is unverified without it.

**Not replicated** (disclosed gaps, not attempted): the illuminated
drop-cap first letter some rules text uses; Arcmage's private "WTactics
Symbols" icon font (real, confirmed via `Styles.cs`, but not a freely
obtainable asset, unlike the fonts above) — this project's own
`[symbol]` chip glyphs are used instead; Loyalty's pip-icon rendering
(numeric badge instead, see above).

## Artwork and frame: hot-linked directly from Arcmage's own exports

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

Every printing also carries `art_url` (the raw artwork layer,
`.../export?format=Art`, credited to the card's `artist` field — CC-BY-
SA-4.0 for original Arcmage/wtactics.org art, GPL-2.0 for the Battle for
Wesnoth-sourced subset, exactly as tracked per-printing in `provenance`)
and, new in this version, `background_url` (the official per-faction+
card-type frame texture, `.../export?format=BackgroundPng&faction=
{guid}&type={guid}`, computed for all 70 printings from the live
`/api/Factions` and `/api/CardTypes` GUID tables plus each printing's own
card GUID). Both are genuinely confirmed URL shapes (see "Confirmed"
above), not guesses — but **the actual pixels behind either URL were
never visually verified** by this session, since its tools can fetch and
render *text* (`text/html`, `application/json`) but not binary/image
responses (confirmed against `image/svg+xml`, `image/png`, and even a
plain `text/plain` `robots.txt` — all came back empty on every host
tried, including Wikimedia, ruling out an Arcmage-specific block). Every
`background`/`image` region in `layoutCard()` always paints a tinted
placeholder (a flat faction-palette color for `background`; that plus an
artist-credited icon for `image`) *underneath* the `<img>` tag, shown
automatically if a URL ever 404s or isn't what's expected — so a card
never goes visually blank or silently shows the wrong thing either way.
The frame texture's own license isn't separately declared by the API the
way per-card `artworkLicense` is; it's hot-linked (not redistributed)
directly from Arcmage's own server with attribution to the project as a
whole, the same low-risk approach this port already used for `image` and
`art_url`. If you can verify the pixels behind either URL (or the frame
texture's specific license), please update this note.

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
- **`attack`/`defense` were backfilled for all 40 Creature + 12 City
  cards** while building the official card layout (see "Card layout"
  above) — this port's `game.yaml` previously and incorrectly claimed
  Arcmage has no such stats. **`flavorText`** (a separate field the live
  API also returns — an italicized closing line, e.g. Foul Imps: "United
  we stand.") was noticed during that same fetch but was NOT backfilled
  into `components/cards.json`'s `text` field — out of scope for a
  layout pass, left as a follow-up. Neither gap was silently patched over
  the other way either: cards without a backfilled stat simply don't
  render that stat's badge (`show_if`-guarded), same honest-degrade
  contract as everything else in this port.

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
