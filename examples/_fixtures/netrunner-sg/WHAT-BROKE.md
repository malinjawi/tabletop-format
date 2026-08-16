# WHAT-BROKE.md — where the platform format could not express Netrunner faithfully

This is the actual deliverable of this port, not the JSON. Everything below
was hit hands-on while porting all 77 System Gateway cards, two sample
decks, and the live banlist into `tools/validate.py` / `tools/check_deck.py`
/ `tools/render_cards.py`. All three tools run clean (0 validation errors,
77/77 renders, both sample decks LEGAL) — the gaps below are things the
*tooling silently doesn't check* or *the schema has no slot for*, not things
that threw errors.

## 1. Influence-limit deckbuilding is not expressible in `deck_rules`

Netrunner's core deckbuilding constraint — "out-of-faction cards cost
influence equal to their printed value; total influence across the deck
cannot exceed your identity's influence limit" — has no home anywhere in
`format.schema.json`. `deck_rules` only has `min_size` / `max_size` / `notes`.
There is no "sum of (attribute × count) must not exceed N" concept at all,
generically or Netrunner-specifically.

I stored the raw numbers faithfully (`attributes.influence` per card,
`attributes.influence_limit` per identity), so the *data* survived the port.
But `tools/check_deck.py` never reads either field — it checks card pool,
size, `deck_limit`, and the restriction list, and nothing else. I could build
a legal-by-real-rules deck (hand-verified: 6 influence of 15 spent on the
Corp deck, 3 of 15 on the Runner deck) and an illegal one (say, 20 influence
of 15) and the tool would call **both** `LEGAL`. Demonstrated, not just
theorized: neither sample deck's influence total is checked by anything that
ran in this fixture.

## 2. Agenda density ("2 points per 5 cards, rounded up") is inexpressible

`deck_rules` has no formula slot — only static integers. Netrunner's
Corp-only requirement, `min_agenda_points = 2 × ceil(deck_size / 5)`, can't
be encoded as data at all; it would require code specific to this one game,
which the format explicitly avoids (design data, not tool code, is the
platform's whole philosophy — see `game.schema.json`'s `type_colors` comment
for the same principle applied elsewhere). I hand-verified the Corp sample
deck clears it (43 non-identity cards need ≥18 points; it runs 20), but
nothing in this repo checks that automatically, and there's no way to make
`check_deck.py` check it without a Netrunner-specific code path.

## 3. Identity cards are structurally special; the schema doesn't know that

`deck.schema.json` has exactly one content field: `cards` (`card_id` →
count). There is no `identity` field. Consequences, all real, all hit:

- The identity has to be smuggled into the same `cards` map as every other
  card, at `deck_limit: 1`. Nothing distinguishes "this card defines your
  faction and deckbuilding limits" from "this is a copy of a card in your
  deck" — a deck with zero identities or three identities would validate
  fine against every schema and pass `check_deck.py`.
- `deck_rules.min_size` therefore silently counts the identity as one of the
  N cards. Real Netrunner's `minimum_deck_size` (40, or 30 for the two
  starter identities) refers to the deck *excluding* the identity. I built
  both sample decks to the *real* standard (40/43 non-identity cards, so 41
  and 44 rows respectively once the identity is added) rather than the
  boundary the tool would have accepted (40 total including identity), and
  documented the discrepancy in each deck's `notes` — but a careless deck
  author would have no signal from the tool that they're one card short of
  real legality.
- Each identity individually sets its own `minimum_deck_size` /
  `influence_limit` / `base_link` (stored as `attributes` on the identity
  card, per the task's own instruction) — but no code path anywhere reads
  *which identity is in a given deck* to apply that identity's personal
  numbers. `deck_rules.min_size` is one fixed global number (I used 40, the
  common case) for the whole format, silently wrong for any deck using
  "The Catalyst" or "The Syndicate" (minimum 30).

## 4. Nothing enforces two-sided deckbuilding (Corp deck ≠ Runner cards)

Every card carries `attributes.side` ("corp" or "runner"), because the task
asked for faction/influence as attributes and side is the same shape of
fact — but `side` is a free-text string the platform has zero opinion about.
Nothing stops a "deck" from mixing Corp and Runner cards, or from using a
Runner identity with a deck full of Corp assets. `check_deck.py` would call
it `LEGAL` as long as pool/size/limit/restriction checks pass. This is the
single biggest asymmetric-game assumption the schema doesn't hold: it was
built for one shared card pool per deck, and Netrunner's two pools sharing
one set is only held together by convention in this port, not by anything
enforced.

## 5. `[click]`-style symbols work, but the glyphs are invented, not real

The `symbols` mechanism itself is a genuine fit — all bracket-tag references
in the fetched card text (`[credit]`, `[click]`, `[mu]`, `[subroutine]`,
`[trash]`) matched the platform's `[key]` convention with zero rewriting
needed, and `validate.py` confirms 0 "undeclared symbol" warnings across all
77 cards. But `glyph` is a single Unicode fallback character per symbol, and
there is obviously no bundled Netrunner/NISEI icon font shipped with the
platform (nor could there be — that font is the rights holder's IP). The
seven glyphs in `game.yaml` (▸ ¢ ⇒ ↺ ◇ 🗑 🔗) are my own inventions, chosen
to be *suggestive*, not the real icons — any renderer using this fixture
displays cosmetically-wrong-but-legible symbols. `recurring_credit` is
declared but never actually appears in SG card text (no card in this set
uses that mechanic); it's included because the task asked for it.

## 6. Faction has no first-class representation, only free-text + no visuals

Card **type** gets a dedicated concept in `game.yaml` (`type_colors`, keyed
by the same strings used as `card.type`). Faction gets nothing equivalent:
it's `attributes.faction`, an arbitrary string (I used NRDB's raw codes —
`haas-bioroid`, `weyland-consortium`, `neutral-runner`, etc. — since there's
no faction display-name field to fill in either). In the real game, faction
is arguably *more* visually load-bearing than type (every card frame is
faction-colored; the Netrunner community identifies factions by color first,
name second). There is no `faction_colors`, no faction display name, no
faction icon slot anywhere in `game.schema.json`. `validate.py` never
complains because it has no idea "faction" is supposed to mean anything.

## 7. MWL/banlist history doesn't fit as one-wave-per-file at fixture scope

`restriction.schema.json`'s "dated, immutable, one document per wave" model
is directionally *right* for how NetrunnerDB actually works — I confirmed
this by fetching the live MWL endpoint, which returns 41 dated waves back to
2016, each immutable and superseded by the next. The concrete problems:

- The live schema for a wave is richer than `banned[]` / `restricted[]`:
  historical entries use `is_restricted`, `universal_faction_cost`,
  `global_penalty`, and `deck_limit: 0` as four *different* penalty
  mechanisms across the format's history. `restriction.schema.json` only
  models two tiers (full ban, or capped at exactly 1 copy). The current
  active wave happens to use `deck_limit: 0` uniformly for every card it
  touches, which maps cleanly onto `banned[]` — but a wave using
  `deck_limit: 2` (reduce the cap without fully banning) is real NRDB shape
  and has **no** representation in this schema at all. Didn't hit it this
  time; would break the next MWL update that uses it.
- Porting the full 41-wave history as 41 separate immutable files (which the
  schema's own philosophy calls for) was out of scope for a fixture; only
  the currently-active wave was ported (`restrictions/standard-2026-08.yaml`).
  That means this fixture demonstrates the *shape* of dated restrictions but
  not the actual "history that never gets rewritten" story the schema is
  designed around.
- The brief assumed "probably none [are] banned in SG." That assumption was
  wrong — the live fetch shows three SG cards currently banned in Standard
  (`cleaver`, `luminal_transubstantiation`, `offworld_office`). Worth noting
  since it's a reminder that "probably" assumptions about live, community-run
  banlists should always be verified, not assumed — which is exactly what
  happened here.

## 8. Two different "keywords" concepts collide

`card.schema.json` documents `subtypes[]` as the fix for "the NRDB v1
lesson" of joined subtype strings — and that's exactly what NRDB's own
`keywords` field is (`"Icebreaker - Decoder"` etc.), so the mapping
`keywords string → subtypes[]` the task specified is a clean, correct fit.
But the platform *also* has a separate `keywords[]` field on every card,
whose meaning is undocumented in `card.schema.json` beyond "array of
strings" (`examples/ember` uses it for ad hoc mechanical tags like `mirror`/
`guard`/`burn`, unrelated to Ember's own `subtypes`). Netrunner has no
equivalent second taxonomy, so `keywords[]` is `[]` on all 77 cards here —
one of the four fields the task's target shape names is simply unused for
this game, because the schema offers two "keyword-shaped" slots for the one
concept NRDB actually has.

## 9. Uniqueness (◆) has a data home but no rendering or rules-enforcement path

`attributes.unique` (boolean) stores the fact faithfully for every card. But:

- The real ◆ diamond is printed *next to the card name*, not inside rules
  text — and the `symbols` mechanism is explicitly scoped to "inline text
  symbols usable in card text as `[key]` tags." There's no title-adjacent
  glyph slot, so `attributes.unique` can't drive a renderer to actually draw
  the marker the way `[click]` drives inline glyph substitution.
- The rule the marker represents ("only one copy of this card may be in
  play/scored at a time") is a runtime game-state rule, not a deckbuilding
  one — reasonably out of scope for `check_deck.py`, but worth naming since
  nothing in this repo enforces it anywhere, including in play (the platform
  has no play-state engine at all, which is a much larger, expected gap).

## 10. `deck_limit` (copies in deck) and in-play limits are different rules, only one is structured

Some cards carry BOTH constraints and they are not the same number. Example
hit directly: Carnivore / Pennyshaver / Pantograph each have `deck_limit: 3`
(you may own three) *and* the printed text "Limit 1 console per player" (you
may only ever have one installed at once) — two independent limits, only the
first is structured data; the second exists solely as unstructured prose
inside `text` with no field backing it. Conversely the four singleton
agendas (`luminal_transubstantiation`, `longevity_serum`,
`tomorrows_headline`, `above_the_law`) print "Limit 1 per deck" as flavor
text that is fully redundant with their structural `deck_limit: 1` — so this
gap is inconsistent in practice: sometimes prose duplicates structured data,
sometimes it's the only place a real constraint lives.

## 11. The reference PNG renderer only has badge slots for two attributes

`tools/render_cards.py` ran to completion on all 77 cards with zero code
changes (a genuine positive result) — but reading its source shows it only
special-cases two numeric attributes: `attributes.cost` (top-left circular
badge) and `attributes.power` (bottom-right circular badge, inherited from
Ember's vocabulary). Netrunner cards routinely carry up to five *more*
numeric attributes that want visual prominence — `strength`,
`memory_cost`, `trash_cost`, `advancement_cost`, `agenda_points`,
`influence` — and none of them have a badge slot. They aren't dropped
silently in the sense of an error; they just never appear anywhere on the
rendered card face, because they live in `attributes` and the renderer only
looks at two specific keys by name. A piece of ice's strength, or an
agenda's point value, is present in the data and invisible on the card.

## 12. Turn structure, actions, and win conditions are prose only — by design, but worth stating

Everything in `rules/rules.md` (3 clicks vs 4 clicks, the run sequence,
access rules, damage types, tags) has no structured representation anywhere
in the schema, and this is consistent with every other game on this
platform (`examples/ember` is the same) rather than a Netrunner-specific
gap — the format models *card/deck/set/format/restriction data*, not game
logic or turn state. Flagging it here anyway because Netrunner's rules are
unusually procedural (a run is a multi-step state machine) compared to
Ember's, so the gap between "what's portable as data" and "what makes the
game actually playable" is much more visible here than on the reference
example.
