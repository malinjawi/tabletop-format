# What broke porting Hearthstone: Classic into this format

Notes from porting a ~45-card hand-transcribed subset of Hearthstone's
Classic set into `examples/_fixtures/hearthstone-classic/`. The fixture
validates clean (`tools/validate.py` → 0 errors, 0 warnings) and both
`tools/render_cards.py` and `tools/check_deck.py` run successfully against
it — but several real Hearthstone rules don't have a home in the schema and
had to be represented as prose, comments, or per-card workarounds instead of
structured, validated data. Specifics below.

## 1. Per-rarity deck copy limits aren't expressible in `deck_rules`

Real rule: max 2 copies of any card, **except Legendary rarity, which is
capped at 1**. `format.schema.json`'s `deck_rules` only has `min_size` /
`max_size` (total deck size) — there's no `max_copies` field, let alone one
that varies by an arbitrary card attribute like `rarity`.

**Workaround:** set `card.deck_limit` per card (2, or 1 for the five
Legendaries) in `components/cards.json`. `tools/check_deck.py` does enforce
`deck_limit` correctly (step 4 of its checklist) — so legality checking
still works — but the *rule* "Legendary → 1 copy" is nowhere in the data as
a rule; it's baked into 45 individual hardcoded numbers. A designer adding
card #46 must remember the convention themselves; nothing derives
`deck_limit` from `rarity` automatically, and nothing would catch a
Legendary accidentally shipped with `deck_limit: 2`.

## 2. Class-restricted card pools aren't expressible at all — confirmed empirically

Real rule: a deck may only contain cards from **one class, plus Neutral**.
`format.card_pool` is a list of legal **sets**, not classes, and
`deck.schema.json` has no `class`/`hero` field whatsoever — a deck is just
`{id, name, format_id, cards, ...}`. There is no data path from "this deck"
to "this hero class" to "these cards are illegal for that class."

I confirmed this is a real, not theoretical, gap: I built a deck mixing
Mage + Shaman (Hex, Lightning Bolt, Doomhammer) + Warrior (Shield Slam,
Whirlwind, Execute) cards — completely illegal in Hearthstone — and ran it
through `tools/check_deck.py --format standard`. It printed **`LEGAL`**.
`check_deck.py`'s five checks (cards exist, in-pool, size, deck_limit,
restriction list) never look at the `class` attribute at all, because
nothing in the schema associates a deck with a class to check it against.

**Workaround:** none, structurally. `decks/classic-control-mage.json` is
single-class-clean only because I built it carefully by hand, not because
anything would have stopped me from doing otherwise.

## 3. Hero powers have no home

Real rule: each of the 9 classes has one signature ability (e.g. Mage's
Fireblast, 2 mana, deal 1 damage), usable once per turn — not a card, not
drawn, not deckbuilt, but as central to play as any card. There is no
schema entity for "an ability the hero itself always has." It isn't a
`card` (never in a deck or hand), isn't a `token` (not a physical
component), and doesn't fit `keywords` (it's a whole action, not a
modifier).

**Workaround:** documented only as a markdown table in `rules/rules.md`,
entirely outside the structured/validated data model. Consequence: none of
the tooling knows hero powers exist — `render_cards.py` can't render one,
`check_deck.py` can't reference one, and a future balance-patch tool that
diffs `cards.json` (per this repo's `tools/diff.mjs`) would silently miss a
hero power text change, because there's nothing there to diff.

## 4. `attribute_definitions.required` is global, not per-type — a silent-gap risk

`mana`, `class`, and `rarity` apply to every card, so marking them
`required: true` works cleanly. But `attack`/`health` only make sense on
minions, and `durability` only on weapons — the schema has no way to say
"required if `type == minion`." I left all three optional game-wide, which
validates fine here, but it means a data-entry mistake (e.g. a minion
accidentally missing `health`) would **not** be caught by
`tools/validate.py` — it would just silently render/behave oddly
downstream. Worth flagging since it's the kind of bug that survives CI.

## 5. Tribes-as-subtypes: fine, no issues

Beast (Savannah Highmane), Demon (Void Terror), Dragon (Azure Drake) all
mapped cleanly onto `card.subtypes` (a plain string array) exactly as
intended by the schema's NRDB-derived design. No workaround needed here.

## 6. Digital/random effects: fine as free text, but not machine-executable

Ragnaros ("deal 8 damage to a **random** enemy"), Animal Companion
("summon a **random** Animal Companion"), Soulfire ("discard a **random**
card"), Sylvanas ("take control of a **random** enemy minion") all encode
fine as plain prose in `card.text` — the format doesn't need a structured
RNG primitive because it isn't a rules engine, only a data/interchange
format (consistent with how `examples/ember` also just writes effects as
text). Worth flagging anyway: nothing here is simulatable. A tabletop
adaptation of these cards would need a human (or an actual game client) to
adjudicate "random," same as it would for hidden information — the format
captures card *identity*, not card *behavior*.

**Secrets** are a sharper version of the same gap: they combine hidden
information (played face-down) with a conditional trigger ("when the
opponent does X"). No card in this fixture is a Secret, but the format has
no field for "trigger condition" or "hidden until triggered" — a real
Secret would also just be prose in `text`, same as everything else.

## 7. Set rotation vs. static format pools

Real Hearthstone: **Standard** rotates to roughly the last ~2 years of
expansions (and, since August 2021, does not include Classic at all —
Classic became a separate static/eternal format); **Wild** includes every
set ever released, no rotation. `format.card_pool` is just a flat list of
set IDs with no time dimension — a format is whatever's in the list, full
stop.

**Workaround:** none possible with one set. `formats/standard.yaml` and
`formats/wild.yaml` both list `card_pool: [classic]` and are therefore
identical in this fixture — the comments in both files say so explicitly.
`set.schema.json` does have optional `cycle_id`/`position` fields that
*could* support rotation-aware tooling later (group sets into cycles, then
have a format's pool reference "the last N cycles"), but nothing computes
that automatically today — a format's `card_pool` is still hand-maintained.

## 8. `printing.quantity`'s meaning gets stretched

`printing.schema.json` documents `quantity` as "physical copies of this
printing included in the set" — i.e. print-run/box count, which makes
sense for `examples/ember` (a fixed 14-card physical microgame where
"3 copies of Kindling exist in the box" is literally true). Hearthstone has
no such concept: it's a digital collectible game with an unbounded
per-player collection; nothing caps how many copies of Fireball *exist*.
Per the task spec, I set `quantity` = `deck_limit` (2, or 1 for Legendary)
to mirror what Ember's own example already does (`p_kindling_core.quantity
3` mirrors `kindling.deck_limit 3`), but that's re-purposing a
"how-many-exist" field to mean "how-many-are-legal-in-a-deck" — the two
concepts happen to collide by convention, not by anything the schema
enforces or documents.

## Not broken / worked cleanly

- `deck_rules.min_size`/`max_size` = 30/30 mapped exactly onto "decks are
  exactly 30 cards" — no workaround needed.
- `type_colors` accepted `minion`/`spell`/`weapon`/`hero` as declared even
  though no card in this fixture has `type: hero` (heroes aren't cards,
  per #3) — harmless, but it's dead palette data with nothing to color.
- `symbols: []` was fine — Hearthstone card text doesn't use inline icon
  tags the way Ember's `[spark]`/`[ash]` do, so there was nothing to
  declare.
- Referential integrity (card_id/set_id/format_id cross-references) caught
  nothing wrong here, but only because the fixture was built from a single
  generator script; see #2 and #4 for the checks it does *not* do.
