# Mindbug (reconstructed fixture — license unconfirmed)

**This directory lives under `examples/_fixtures/`, not `examples/`, because
this build could NOT confirm a free/Creative-Commons license for Mindbug
from any primary source, despite a thorough live research pass.** Read this
whole file before reusing, hosting, or publishing anything here.

## TL;DR

- **License: UNCONFIRMED.** `game.yaml` sets `license: "Unconfirmed — verify
  before hosting"`, not a real SPDX/CC code. See "Provenance & license"
  below for the research trail and why the evidence actually points *away*
  from Creative Commons.
- **Placement: `examples/_fixtures/mindbug/`**, per this task's own
  fallback instruction for an unconfirmed license. Do **not** move this
  into `examples/` (the public/showcase surface) without independently
  re-clearing rights with the rights holder.
- **Cards: 48 total.** 15 have names/keywords/ability-text corroborated by
  official primary sources fetched live during this build; 15 more are
  this build's best-effort recollection of real base-set card names with
  reconstructed stats/text; 18 are original placeholder creatures invented
  to round the shared deck out to 48 and are **not real Mindbug cards**.
  Every card's `notes` field states which of these three tiers it's in —
  see "Card data honesty" below.

## Provenance & license

Mindbug is a 2-player creature-dueling card game designed by **Richard
Garfield, Christian Kudahl, Marvin Hegen, and Skaff Elias**. This task was
briefed as porting a game by "Richard Garfield / Nevermore Games...
released free as print-and-play under a Creative Commons license." Live
research on 2026-08-19 could not corroborate either the publisher name or
the license claim:

- **Publisher of record:** per mindbug.me's own `/legal/` page, Mindbug is
  published by **Nerdlab Games (Tagnition GmbH)**, Alzenau, Germany,
  together with **Kissaki Studios GmbH**, Aschaffenburg, Germany. No
  entity named "Nevermore Games" appears on the publisher's site, in its
  Legal/Press/ToS pages, or in the official rulebook's credits. This may
  be a mix-up with a different publisher — treat "Nevermore Games" in the
  original brief as unconfirmed.
- **License:** every official page checked was read directly, live, during
  this build:
  - `https://mindbug.me/` — no license/PnP statement.
  - `https://mindbug.me/rules/` — links to official rulebook PDFs and an
    FAQ; no license statement. (This page also reveals the line has since
    grown an "Ambition"/"Mindbug Beyond" expansion layer with a Boost/
    Evolve/Tag-Team ruleset — out of scope for this base-game fixture.)
  - `https://mindbug.me/legal/` — states: *"Reproduction for sale or other
    commercial use is not permitted. For private personal use as well as
    for other, non-commercial purposes, the complete or partial
    reproduction of these Internet pages is permitted, provided that no
    changes are made to the content."* This is a bespoke website-reuse
    clause, not a Creative Commons license — and it explicitly forbids
    **any** modification/derivative use, which no standard CC license
    does (even CC BY-NC-ND permits verbatim redistribution without this
    kind of "no changes" restriction worded this way, and every other CC
    variant permits derivatives outright). It also only covers "these
    Internet pages," not the game's rules or card data.
  - `https://mindbug.me/press/`, `/game-overview/`, `/faq/` — no license
    statement. `/game-overview/` links a "Download PDF Rulebook"
    (`mindbug_rulebook-V6.pdf`) — fetched and read in full; it is the
    Rules Sheet (component list, setup, turn structure, keywords,
    triggers, credits) with **no license or copyright-terms text at all**.
  - `https://mindbug.me/mindbug-online-terms-of-service/` — states
    plainly: *"All intellectual property rights in the Game, including
    design, artwork, and underlying code, are owned by Kissaki Studios."*
    Direct evidence the IP is proprietary, not Creative-Commons-licensed.
  - No "print and play" page, download, or CC badge was found anywhere on
    the publisher's site.
- **Other sources attempted, per this task's suggested list:**
  Wikipedia (`en.wikipedia.org/wiki/Mindbug`,
  `/wiki/Mindbug_(game)`/`_(card_game)`, the REST summary API, and the
  action API search endpoint) returned no article/results through this
  build's fetch tool. BoardGameGeek (`boardgamegeek.com/boardgame/352515/`
  and a guessed `/350933/` ID, the XML API's `search`/`thing` endpoints,
  and the `api.geekdo.com` search backend) either redirected to unrelated
  games (wrong guessed IDs) or returned nothing — this build does not have
  Mindbug's real BGG ID and could not obtain it through the tools
  available. `api.github.com/search/repositories?q=mindbug+cards` (as
  suggested) found exactly one small repo, **jerome-bienaime/mindbug-cards**
  (a card-filtering viewer app, `license: null` on the GitHub API,
  no bundled card-data license file); following it further (repo contents,
  code search) was blocked by GitHub's unauthenticated rate limit being
  already exhausted in this sandbox. General web search
  (DuckDuckGo, Bing) returned no usable results through this build's fetch
  tool (likely bot-walled). The Wayback Machine was on this tool's URL
  blocklist and could not be tried.
- **Conclusion:** the CC-license claim in the original brief is
  **unconfirmed**, and the best available primary-source evidence (the
  publisher's own Legal page and Mindbug Online ToS) actively suggests the
  opposite — Mindbug is conventional proprietary IP with no publicly
  documented free/CC print-and-play release. Per this task's own fallback
  instruction, this port is therefore placed under `examples/_fixtures/`
  with `license: "Unconfirmed — verify before hosting"` rather than under
  `examples/` with a real CC code. **If you can independently confirm a
  specific CC license from Nerdlab Games / Kissaki Studios directly,
  update `game.yaml`'s `license` field and this file, and only then
  consider moving the directory to `examples/`.**

## What's genuinely sourced from mindbug.me

Fetched and read directly during this build (2026-08-19):

- `https://mindbug.me/` — publisher/product overview.
- `https://mindbug.me/rules/` — links to rulebook PDFs, FAQ, and reveals
  the base game vs. "Beyond" expansion split.
- `https://mindbug.me/wp-content/uploads/2021/09/mindbug_rulebook-V6.pdf`
  — the official "Rules (Base Game)" PDF, read in full: component list,
  setup steps, turn structure, the Mindbug mechanic, combat/blocking, all
  five base-game keywords (Frenzy, Hunter, Poisonous, Sneaky, Tough) with
  worked examples, trigger types (Play/Attack/Defeated/constant), and game
  terms. **`rules/rules.md` in this fixture is an original condensation
  written from this material in this build's own words — it is not a copy
  of the PDF text.**
- `https://mindbug.me/faq/` — the official FAQ, read in full; several
  entries name and quote specific cards (Elephantopus, Sluggernaut,
  Sharky-Crab-Dog-Mummypus) verbatim or near-verbatim. These became
  `rulings/rulings.json` entries and the three most-confidently-sourced
  cards in `components/cards.json`.
- `https://mindbug.me/legal/`, `/press/`, `/game-overview/`,
  `/mindbug-online-terms-of-service/` — publisher identity, credits, and
  the license research documented above.

Confirmed **game design credits** (from the official rulebook PDF):
Christian Kudahl, Marvin Hegen, Richard Garfield, Skaff Elias (design);
Denis Martynets (illustrations); Maximilian Gotthold (graphic design).
`game.yaml` credits the four designers; the illustrator/graphic designer
are listed too but explicitly marked as *not reproduced* in this fixture —
**this fixture contains no card art, and none was sourced from anywhere.**

Confirmed **mechanics** (independently corroborated by the fetched
rulebook PDF and matching the task brief): 2 players, 3 starting life
each, a shared 48-card creature deck, creatures with POWER plus the five
keywords above, 2 Mindbugs per player (4 total) letting a player steal an
opponent's just-played creature instead of a normal resolution, unblocked
attacks cost 1 life, 0 life loses.

## Card data honesty

`components/cards.json` has exactly 48 creature cards. Every single one
carries a `notes` field and a `tags: ["provenance:<tier>"]` marker stating
which of three tiers it's in — **read a card's own `notes` field before
trusting its stat line:**

1. **`provenance:verified` (15 cards)** — Gorillion, Bee Bear, Luchataur,
   Tusked Extorter, Spider Owl, Tiger Squirrel, Kangasaurus Rex,
   Elephantopus, Compost Dragon, Killer Bee, Sluggernaut,
   Sharky-Crab-Dog-Mummypus, Axolotl Healer, Strange Barrel, Rhino Turtle.
   Each of these has its **name**, and usually a **keyword, an exact
   relative/absolute power value, or ability text**, directly corroborated
   by the official rules-sheet PDF or FAQ quoted above. This does *not*
   mean every field on these 15 cards is verified — where the source gave
   a keyword but not a power number (for example), the number is still
   this build's reconstruction, and the card's own `notes` field says
   exactly what is and isn't confirmed.
2. **`provenance:reconstructed-known` (15 cards)** — Shark Dog, Turbo Bug,
   Lone Yeti, Witch Hazel, Grave Robber, Deathweaver, Shrewd Rat, Snail
   Thrower, Tough Chicken, Urchin Hurler, Chameleon Sniper, Harpy Mother,
   Bulwark Beetle, Ferret Bomber, Goblin Werewolf. This build's best-effort
   recollection that these are genuine Mindbug base-set creature names;
   power, keywords, and ability text are reconstructed from general
   knowledge and were **not** independently re-verified against an
   official source or card database during this build.
3. **`provenance:placeholder` (18 cards)** — Pangolin Juggler, Ember Newt,
   Cathedral Moose, Whisper Vole, Iron Cricket, Velvet Jackal, Marsh Auger,
   Copper Heron, Static Opossum, Driftwood Crab, Quartz Beetle, Nettle Fox,
   Thistle Ram, Sable Wren, Gravel Toad, Ashen Lynx, Brindle Ox, Hollow
   Kite. **Original creatures invented for this fixture. They are not real
   Mindbug cards** — they exist only so `components/cards.json` reaches a
   realistic 48-card shared-deck size for schema/tooling testing (deck
   math, singleton enforcement, keyword distribution, render smoke tests).

Do not treat tiers 2 or 3 as an authoritative Mindbug card list. If you
need the real 48, buy the game or find its official/legal print-and-play
(neither of which this build was able to locate — see "Provenance &
license" above) and re-port from that.

Every card is a strict singleton: `deck_limit: 1` on every card,
`quantity: 1` on every printing in `components/printings.json` — matching
the real game's "no duplicates in the shared deck" design, which the task
brief also called out.

## Do not

- Do **not** host, publish, or distribute this fixture as a playable
  product, on this platform or elsewhere, until the license question above
  is actually resolved.
- Do **not** treat `license: "Unconfirmed — verify before hosting"` as a
  real license grant — it is a placeholder that says exactly what it says.
- Do **not** treat tier-2 or tier-3 cards (see above) as accurate
  reproductions of real Mindbug cards.
- Do **not** copy this directory into `examples/` (non-`_fixtures`) or any
  discovery/hub surface without independently re-clearing the license.

## Validating this fixture

From the repo root:

```
python3 tools/validate.py examples/_fixtures/mindbug
python3 tools/render_cards.py examples/_fixtures/mindbug
```

There are no `decks/` or `restrictions/` in this fixture: Mindbug has no
deck construction (the entire 48-card set is always the shared deck) and
no banlist in this port (only the base set was ported, no expansions).
