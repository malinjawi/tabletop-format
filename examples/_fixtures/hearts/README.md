# Hearts (fixture)

Classic 4-player trick-taking card game, played with a standard 52-card
deck. Public domain — no known single author, roughly 150 years old,
nothing to license. This fixture is a **safe example**: unlike some other
fixtures under `examples/_fixtures/`, which port real commercial games for
interoperability testing and carry someone else's IP, Hearts' rules and
card data are free to copy, fork, remix, or ship — including as a genuine
starter/example game in production later, with zero rights clearance.

It also doubles as the format's **control case**. Hearts predates trading
card games, deck-building, boosters, and card rarity by a century, so
porting it deliberately stress-tests whether this schema — designed and
proven against TCG-shaped examples (Ember, Harbor Nine, Netrunner) — holds
up for a traditional game it was never designed around. Short answer:
mostly yes, with real friction. See `WHAT-BROKE.md` for the specifics.

## Contents

- `game.yaml` — attribute_definitions for suit/rank/rank_value/penalty,
  one flat `playing-card` type, 4 unicode suit symbols.
- `components/cards.json` — all 52 cards, generated (not hand-typed).
- `components/printings.json` — 52 printings, 1:1 with cards, one set.
- `sets/sets.yaml` — the single `standard-52` set.
- `formats/standard.yaml` — the single legal way to play (4 players).
- `rules/rules.md` — complete rules: deal, passing, play, scoring,
  shooting the moon, common variants.
- No `decks/` — intentional; see `WHAT-BROKE.md`.

## Try it

```
python3 tools/validate.py examples/_fixtures/hearts
python3 tools/render_cards.py examples/_fixtures/hearts
```

License: **CC0-1.0** (public domain), matching the underlying game.
