# cards-against-humanity (internal fixture)

A ~55-card subset of Cards Against Humanity's Base Set, used as a test
fixture for the tabletop-format platform's `card_style: "cah"` exact-look
card renderer (`cardFrame()` in `tools/hub_template.html`) and its
true-physical-size print sheet. Unlike the other `examples/_fixtures/*`
real-game ports next to it (Netrunner, Hearthstone — proprietary IP
reproduced for testing only, "do not publish"), **this one is
legitimately shareable**: Cards Against Humanity LLC releases the game's
design and text under a Creative Commons license, so this fixture can be
attributed and shared non-commercially without a special carve-out.

## License

**© Cards Against Humanity LLC. Licensed CC BY-NC-SA 2.0** (Creative
Commons Attribution-NonCommercial-ShareAlike 2.0) — see
https://creativecommons.org/licenses/by-nc-sa/2.0/ and Cards Against
Humanity's own site (cardsagainsthumanity.com), which states the game's
content is released under this license.

> © Cards Against Humanity LLC, CC BY-NC-SA 2.0 — design and text used
> under license.

In practice: keep this attribution on any copy or derivative, don't sell
it or otherwise use it commercially, and license any remix of it the
same way. `game.yaml`'s `license: CC-BY-NC-SA-2.0` and
`default_provenance.notes` carry the same note machine-readably.

## Provenance — how this data was produced

- **Attempted**: `web_fetch` against
  `https://raw.githubusercontent.com/crhallberg/json-against-humanity/latest/cah-all-compact.json`
  (a community-maintained JSON mirror of CAH's card data). The request
  itself succeeded — HTTP 200, real card JSON came back, confirmed by
  inspecting a slice of the raw response (a flat `"white": [...]` array
  of card strings) — but the full payload is every card from every CAH
  pack ever released, as one ~95,000-character minified JSON line: too
  large to pull inline, and with no JSON/array parser reachable from
  that fetch's output in this environment, not reliably reducible to an
  accurate, pack-scoped ("Base Set only") ~40/15 subset within this
  task's scope.
- **Fallback used** (per this task's own instruction: "if too big/failed,
  author ~50 well-known base-set cards from knowledge verbatim"): the 40
  White and 15 Black cards in `components/cards.json` were hand-authored
  from public knowledge of the widely-published, widely-quoted Base Set.
  This mirrors the same fallback already used by
  `examples/_fixtures/hearthstone-classic` in this repo for an analogous
  "feed reachable but unworkably large" situation — see that fixture's
  README for the precedent.
- **Accuracy**: treat card text as best-effort recall of very widely
  circulated content, not a byte-verified dump from an official
  database. Spot-check anything load-bearing before relying on it.
- **Not sanitized, on purpose**: CAH's whole premise is deliberately
  crude, offensive party humor. This fixture reproduces that tone as
  written rather than softening it — a sanitized version would
  misrepresent the real game and would undertest the renderer against
  realistic content (long prompts, dark subject matter, PICK 2 combos).

## Scope

- 40 White Cards, 15 Black Cards (2 of the Black cards are PICK 2) — a
  small slice of the real Base Set (~500 White / ~90 Black across the
  full game as sold). Enough to play a short real hand and to exercise
  `card_style: "cah"` end to end; not a complete or purchasable product.
- One set, `base`, with a 1:1 card:printing mapping (no alternate art,
  no expansions modeled here).
- `rules/rules.md` is a condensed rules summary written from general
  knowledge of how the game is played, not copied verbatim from the
  physical rulebook.

## What this fixture is for

Exercises the platform's "exact physical look" card rendering
(`card_style: "cah"` in `cardFrame()`, `tools/hub_template.html`) and its
true-size print sheet against a real, recognizable, non-CCG card game
shape: two card types with no shared numeric stats, blank-fill text, and
a PICK-2 variant — deliberately different from the stat-heavy
Netrunner/Hearthstone/Ember/Hearts fixtures next to it.
