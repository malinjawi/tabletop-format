# duelyst (internal test fixture)

**This is an internal test fixture for the tabletop-format platform, not a
game published or hosted by this project.** It exists to stress-test the
platform's schema and tooling (`tools/validate.py`, `tools/render_cards.py`)
against a real digital CCG whose core loop is inseparable from a positional
battlefield — see `WHAT-BROKE.md`.

## License verification (done first, per this port's brief — record, don't assume)

Duelyst was developed by Counterplay Games, released 2016, shut down 2020,
and open-sourced in full on **2023-01-10** ("OpenDuelyst"). This port
checked CODE and ART/ASSET licensing **separately**, against primary
sources fetched directly (not secondhand summaries):

### Code license

- **File**: [`LICENSE`](https://github.com/open-duelyst/duelyst/blob/main/LICENSE)
  at the root of `open-duelyst/duelyst` (the official, canonical continuation
  repo — confirmed via `github.com/open-duelyst`, the org that published the
  original announcement). Full text is the standard **"Creative Commons
  Legal Code — CC0 1.0 Universal"** legal code.
- **README quote** ([`README.md`](https://github.com/open-duelyst/duelyst/blob/main/README.md)):
  > "OpenDuelyst is licensed under the Creative Commons Zero v1.0 Universal
  > license. You can see a copy of the license [here](LICENSE)."
- **package.json** ([`package.json`](https://github.com/open-duelyst/duelyst/blob/main/package.json)):
  `"license": "CC0-1.0"` (machine-readable SPDX confirmation, third
  independent source in the same repo).

**Verdict: CODE = `CC0-1.0`.** Three primary sources in the repo itself
(LICENSE file text, README prose statement, package.json SPDX field) agree,
with no ambiguity.

### Art / asset license

- The **same single `LICENSE` file, at the repo root, with no carve-out**,
  covers the whole repository as committed — there is no separate
  `ASSETS-LICENSE`, `art/LICENSE`, or similar file anywhere this port could
  find. The README's own illustrative image
  (`![Duelyst Logo](app/resources/ui/brand_duelyst.png)`) is versioned
  inside this same repo, under this same blanket license, which is direct
  evidence the license is not scoped to code-only.
- Secondary reporting from the time of the release is unanimous that art
  was explicitly included, not just code — e.g. GamingOnLinux: *"the
  release includes everything: the server component, the art assets, and
  more... both private and commercial use of all the components is
  permitted, and you can use the Duelyst sprite art in your own game."*
  (Consistent coverage from PC Gamer, GameDeveloper.com, and the
  OpenGameArt.org community forum thread on the release.)
- **What this port could NOT independently verify this session**: the exact
  in-repo file paths/filenames for individual card art (e.g. whether
  per-card sprites live under `app/resources/units/...` with a specific
  naming convention). GitHub's REST API (`api.github.com/repos/.../contents`)
  was rate-limited to zero remaining requests for the duration of this
  session, which blocked directory-listing the `app/resources/` tree
  directly from the official repo. See `docs/art-library.md` for exactly
  what is and isn't confirmed as a result, and why this fixture does not
  hot-link any card art.

**Verdict: ART = `CC0-1.0`** (same blanket grant as code — high confidence
from the primary README/LICENSE/package.json evidence above, corroborated
by independent contemporaneous reporting), **but exact asset file paths in
the official repo are unverified** — see `docs/art-library.md`.

### What this means for this fixture

Because both code and art are CC0-1.0 — the most permissive license that
exists (public-domain-equivalent; no attribution legally required) — this
fixture:

- Sets `license: CC0-1.0` in `game.yaml` for real (not the `Proprietary`
  placeholder used in `netrunner-sg`/`hearthstone-classic`, whose underlying
  IP is NOT openly licensed).
- Still lives under `examples/_fixtures/` rather than `examples/`, per this
  platform's own convention that this directory is for interop/format
  test data, not a showcase of an original game this repo's contributors
  designed.
- Does **not** hot-link any card art (see `docs/art-library.md` for why —
  it's a verification gap, not a licensing one).

## Provenance: where the card DATA in this fixture came from

- **Card names, factions, types, mana costs, Attack/Health, rarities, and
  rules text**: Counterplay Games' original game design, released CC0-1.0
  as part of the OpenDuelyst open-sourcing above.
- **How this port actually obtained that data**: GitHub's REST API
  (`api.github.com`) was rate-limited to zero remaining core requests for
  this entire session, which made directory-listing/browsing
  `open-duelyst/duelyst`'s CoffeeScript SDK source tree (`app/sdk/...`)
  infeasible — only exact, guessed file paths could be fetched directly via
  `raw.githubusercontent.com`, and none of several educated guesses at the
  SDK's card-definition file layout resolved. Given that constraint, this
  port instead sourced card data from two CC0-covered community mirrors of
  the same underlying game data, both of which extract directly from the
  live Duelyst client's own `GameDataManager` (not independent
  transcription):
  - [`willroberts/decklyst`](https://github.com/willroberts/decklyst) (MIT-licensed
    API *wrapper*; the bundled card-data JSON itself is Counterplay's game
    content, extracted via a documented browser-console script credited to
    "im_useful_to_society on r/duelyst") — used for Lyonar/Songhai/Vetruvian
    minion data and all 6 Generals' real Bloodbound/Bloodborn Spell text.
  - [`creatures/duelyst`](https://github.com/creatures/duelyst) (a card-viewer
    app whose `scrapers/cards.js` pulls the same `GameDataManager` collection
    from `beta.duelyst.com`) — used for full 6-faction + Neutral minion
    coverage (this source's snapshot only contains unit-type cards, not
    spells/artifacts — see below).
  - The [Duelyst Wiki](https://duelyst.fandom.com/wiki/Core) (Fandom,
    community-maintained, structured card tables by faction) — used for all
    Spell and Artifact card data, since neither scraper above captured those
    card types (see `WHAT-BROKE.md` is not the place for this — it's a data-
    source limitation, not a format limitation: both community scrapers only
    read from the client's `cardsCollection`, which empirically contains
    Minions/Generals only, not Spells/Artifacts).
- **None of this fixture's card data was invented or hand-transcribed from
  memory.** Every card in `components/cards.json` traces to at least one of
  the sources above. Spell/Artifact vs. two other candidate categorizations
  (e.g. whether a specific "no Attack/Health" card is a one-time Spell or a
  persistent Artifact) were inferred from each card's own ability text
  (persistent "each turn"/equipment-style effects on the caster's own
  General = Artifact; one-time targeted/AOE effects = Spell) since the wiki
  table itself doesn't carry a separate Spell-vs-Artifact column — this is
  the one interpretive judgment call in an otherwise directly-sourced
  dataset.

## Scope

- **118 cards**: 6 Generals (one per faction, each with real Bloodbound/
  Bloodborn Spell text), 67 Minions, 40 Spells, 5 Artifacts. Spread across
  all 6 factions (14-20 cards each) plus 18 Neutral cards.
- One set (`core`), one format (`standard`), Basic through Legendary rarity,
  16 distinct keywords represented (see `rules/rules.md`).
- **Not included**: card art/images (see `docs/art-library.md`), the
  hundreds of cards outside this hand-picked spread, errata/balance-patch
  history, and — most importantly — any board/positional state at all (see
  `WHAT-BROKE.md` #1, the dominant finding of this port).

## Do not

- Do **not** host, publish, or distribute this fixture as a playable
  product, on this platform or elsewhere — it is scoped to `_fixtures/`
  specifically because it is test/interop data, not an original game this
  repo's contributors designed (even though, unusually among this
  directory's siblings, the underlying IP genuinely is openly licensed).
- Do **not** treat this fixture, or `docs/art-library.md`, as a substitute
  for reading Counterplay's own `LICENSE`/README if you plan to build
  something real on top of Duelyst's assets — verify against the primary
  repo yourself.

## What to read next

- `rules/rules.md` — condensed rules (board, Generals, mana, Replace,
  keywords, deck-building) needed to make sense of the card pool.
- `WHAT-BROKE.md` — everything about Duelyst this platform's schema cannot
  express, headlined by the board/positional gap.
- `docs/art-library.md` — what CC0 art exists, and exactly what is/isn't
  verified about it from this session.

## Validating this fixture

From the repo root:

```
python3 tools/validate.py examples/_fixtures/duelyst
python3 tools/render_cards.py examples/_fixtures/duelyst
```
