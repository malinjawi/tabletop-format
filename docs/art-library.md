# Art library: Duelyst (CC0-1.0) — a future prototype art source for community games

Counterplay Games open-sourced Duelyst's full engine **and art assets** under
**CC0-1.0** on 2023-01-10 (see `examples/_fixtures/duelyst/README.md` for the
full license verification — three primary sources in
[`open-duelyst/duelyst`](https://github.com/open-duelyst/duelyst) agree:
`LICENSE`, `README.md`, `package.json`). This makes it, on paper, the single
largest permissively-licensed digital-CCG art corpus this platform has
touched — hundreds of card portraits/sprite animations, UI chrome, and
faction iconography, royalty-free for any use including commercial.

This document indexes what is **known** and flags what is **not yet
verified**, so a future community game (a physical/print-and-play spin on
Duelyst's factions, or any project wanting placeholder tactical-CCG art)
knows exactly what it's starting from.

## License

- **CC0-1.0** ("Creative Commons Zero v1.0 Universal") — the strongest
  public-domain-equivalent grant that exists. Legally, **no attribution is
  required** for any use, commercial or otherwise.
- **Practical courtesy, not a legal requirement**: credit "Counterplay
  Games / OpenDuelyst" when using this art, the way this platform's own
  `provenance` blocks do for every other imported dataset — CC0 waives the
  legal requirement, not the norm.

## What is confirmed

- The repository's own `README.md` embeds and versions an image
  (`app/resources/ui/brand_duelyst.png`) directly inside the same repo, under
  the same blanket `LICENSE` — i.e. art assets are committed to
  `open-duelyst/duelyst` itself, not merely "the license also covers art in
  spirit."
- Independent reporting from the release (GamingOnLinux, PC Gamer,
  GameDeveloper.com, an OpenGameArt.org community thread) is unanimous that
  full art assets — not just code — were included, e.g. GamingOnLinux:
  *"the release includes everything: the server component, the art assets,
  and more... you can use the Duelyst sprite art in your own game."*
- The game covers **6 factions** (Lyonar Kingdoms, Songhai Empire, Vetruvian
  Imperium, Abyssian Host, Magmar Aspects, Vanar Kindred) plus a Neutral
  pool, each with a General, unit, spell, and artifact card frame per the
  Duelyst Wiki's own card tables (`duelyst.fandom.com/wiki/Core` and
  per-faction pages) — confirming board-game-relevant asset *categories*
  even where individual file paths are not confirmed (below).

## URL / naming pattern — observed, but from a third-party export, not the GitHub repo directly

Community tooling that predates the 2023 open-sourcing (e.g.
[`willroberts/decklyst`](https://github.com/willroberts/decklyst)'s bundled
card-data JSON, itself extracted from the live client's own
`GameDataManager`) records a real, consistent naming convention for every
card's sprite/animation assets:

```
frame:  f<factionId>_<unit_slug>_idle_
plist:  https://assets-counterplaygames.netdna-ssl.com/production/resources/units/f<factionId>_<unit_slug>.plist
sprite: https://assets-counterplaygames.netdna-ssl.com/production/resources/units/f<factionId>_<unit_slug>.png
```

(e.g. `f1_general` for the Lyonar General, `f3_obelyskduskwind` for
Vetruvian's Windstorm Obelysk, `f6_general` for the Vanar General — `1`
through `6` map onto the same 6 factions as `game.yaml faction_colors` in
`examples/_fixtures/duelyst/`.)

**This pattern is real and directly observed in exported client data — but
two things about it are NOT independently verified in this session:**

1. Whether `assets-counterplaygames.netdna-ssl.com` (Counterplay's
   pre-shutdown production CDN) is still live. It predates the 2020
   shutdown and 2023 open-sourcing and should be assumed dead/unreliable
   without checking first.
2. Whether the **GitHub repo's own** `app/resources/` tree (the actual
   CC0-licensed source of truth) uses this exact same `f<N>_<slug>` naming
   for the files it ships. `api.github.com`'s REST API was rate-limited to
   zero remaining requests for the entire session this fixture was built
   in, which blocked directory-listing `app/resources/` directly from the
   official repo to confirm.

**Consequence**: `examples/_fixtures/duelyst/components/printings.json` in
this port does **not** set an `image` field on any printing, and does not
hot-link the CDN pattern above. This is a verification gap, not a licensing
one — re-running the directory listing (`api.github.com/repos/open-duelyst/
duelyst/contents/app/resources`) once rate limits allow, or cloning the repo
directly, would very likely confirm real per-card asset paths ready to wire
into `printing.art`/`printing.image`.

## Counts

- **Factions**: 6, plus Neutral (7 groups total, matching this repo's
  `faction_colors` keys in `examples/_fixtures/duelyst/game.yaml`).
- **Cards with art**: Duelyst's full released card pool is several hundred
  cards (well beyond this fixture's 118-card representative slice — see
  `examples/_fixtures/duelyst/README.md` for why only a subset was ported as
  *data*). An exact total card/asset count was not independently verified
  in this session and should not be assumed from the above — only the
  naming *pattern* and its per-faction prefix scheme are confirmed.

## Suggested next step for a real integration

1. Clone (or re-attempt an API directory listing of) `open-duelyst/duelyst`
   when not rate-limited, and confirm the real path/filename convention
   under `app/resources/`.
2. Cross-reference against `examples/_fixtures/duelyst/components/cards.json`
   `id` values (already `snake_case` card names) to build a `card_id ->
   asset path` map.
3. Populate `printing.art` (local, if assets are vendored into this repo)
   or `printing.image` (if hot-linking a maintained mirror) plus
   `printing.provenance` (`source: human`, `license: CC0-1.0`, `source_url:
   https://github.com/open-duelyst/duelyst`) per the pattern already used by
   `examples/_fixtures/netrunner-sg/components/printings.json` — with the
   caveat documented there too: hot-linking is test-fixture convenience,
   not a production pattern.
