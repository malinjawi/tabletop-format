# WHAT-BROKE — Hearts fixture

Hearts is the format's control case: a real, complete, 150-year-old
trick-taking game with none of the assumptions the format's other
examples share (Ember, Harbor Nine, Netrunner are all TCG-shaped —
deck-building, boosters, card advantage). This file is the honest
record of what fought back. Validation is clean (0 errors, 0 warnings)
and rendering doesn't crash — but "doesn't crash" and "fits the model"
are different things, and several places below are the format bent to
its will rather than a natural fit.

## What actually worked cleanly

- **`attribute_definitions` + typed `attributes`** — `suit` (string),
  `rank` (string), `rank_value` (int), `penalty` (int) all validate with
  zero friction. `penalty` in particular is a perfect fit: every card
  needed exactly one small integer, the validator enforces the type, and
  the 26-point deck total falls out as a trivial sanity check
  (`sum(penalty) == 26`, confirmed while generating the fixture).
- **JSON as UTF-8** — card text and `game.yaml` freely use em dashes and
  the `[suit_spades]`/`[suit_clubs]` symbol tags; `json.dumps(...,
  ensure_ascii=False)` round-trips through `validate.py` with no escaping
  drama.
- **Unicode suit glyphs actually render.** Declared 4 symbols in
  `game.yaml` (`suit_hearts ♥`, `suit_diamonds ♦`, `suit_clubs ♣`,
  `suit_spades ♠`) and used two of them (`[suit_clubs]`, `[suit_spades]`)
  in card text on the 2 of Clubs and Queen of Spades, the two cards with
  meaningful rules text. Checked the renderer's bundled font directly
  (`fontTools` cmap inspection of `tools/fonts/DejaVuSans.ttf`): all four
  card-suit code points (U+2660/2663/2665/2666) are present as real
  glyphs, not tofu. Unlike Ember's `[spark]`/`[ash]`, which ship bespoke
  PNG icon assets, the suit symbols rode the existing text-glyph path for
  free. One of the few pleasant surprises in this port.
- Did **not** put unicode in `name` or `id` — names are plain text
  ("Queen of Hearts", not "Q♥"), and card/printing `id` patterns
  (`^[a-z0-9][a-z0-9_]{1,63}$`) are ASCII-only anyway, so `hearts_q` /
  `spades_10` was the only option regardless of preference.

## What fought us

**1. No deck-building concept exists, and `decks/` assumes one.**
`deck.schema.json` is `card_id -> copy count` checked against a format's
`card_pool` + `deck_rules` (min/max size) — the Magic/Netrunner
"which cards do I choose to own" model. Hearts has no such choice: the
deck IS the game, all 52 cards, dealt out completely, every hand,
forever. Writing a `decks/all-52.json` with `{card: 1, ...}` for all 52
cards would validate, but it would be a content-free restatement of
`cards.json` wearing a `deck.schema.json` costume — there is no decision
it could represent. **We omitted `decks/` entirely** rather than
manufacture a fake one; it's listed optional in `SPEC.md`, so this is a
valid (if pointed) empty set.

**2. Turn/trick structure has no schema home except prose.**
Nothing in `game.yaml`, `format.schema.json`, or anywhere else can
express "follow suit if able," "highest card of the suit led wins,"
"hearts must be broken before leading," or the 4-hand passing rotation.
All of it lives in `rules/rules.md` as unstructured markdown — which
`SPEC.md` says is deliberate ("markdown only... never sources" for
tooling) but the practical effect is stark: a tool that reads only
`cards.json` cannot reconstruct how to play Hearts. No card's `text`
field says "follow suit" — that rule applies to the game as a whole, not
to any card, and the format has no per-game "procedure" or "rules
engine" document type, only per-card text. For a TCG this is fine because
most of the interesting logic is distributed across card text; for Hearts
it means 100% of the actual game logic is outside every structured file.

**3. The card/printing split is dead weight for a standard deck.**
`printing.schema.json` exists to separate a card's rules identity from
"a specific physical/visual appearance... many printings may point at
one card" (art variants, reprints, alt-art promos — see Ember's
`kindling` with a core printing AND an alt-art promo printing). A
standard 52-card deck has never had that distinction: every Hearts card
has exactly one appearance, forever, by definition of what "a standard
deck" means. Our `printings.json` is a mechanical 1:1 shadow of
`cards.json` (52 in, 52 out) that carries zero information beyond a
`collector_number` nobody will ever use to distinguish two Queens of
Spades. **And it's not optional** — `SPEC.md` §3 lists
`components/printings.json` as REQUIRED (not RECOMMENDED, unlike
`rules.md`/`sets/`), so even a fixture this simple cannot skip it, which
in turn drags in `sets/sets.yaml` (a printing needs a `set_id`) purely so
`standard-52` can exist as a set with no cycle, no release date, and no
sibling sets to be "a set" in contrast to. `formats/standard.yaml`
similarly exists only to hold a `card_pool: [standard-52]` — Hearts has
no banlist, no rotation, no competitive card pool question at all.
None of this was hard to write; all of it is bureaucratic overhead that
exists because the schema assumes it, not because Hearts needs it.

**4. Per-player hands come from one shared, fully-dealt deck — the
format's data doesn't model dealing at all.** `deck_rules.min_size` /
`max_size` (52/52 here) and `printing.quantity` (1 here) both happen to
describe Hearts correctly, but only by coincidence: those fields exist to
answer "how many of this card may a player put in their personal
deck" and "how many physical copies exist in a set," not "this card goes
to exactly one of 4 hands, redealt from scratch every round." There's no
field anywhere for "hand size" or "how the shared pool divides among
seats" — that's rules.md prose again (see #2).

**5. `type_colors` keys off `type`, but the visually meaningful axis in
a card game is an attribute value, not a type.** Chose a single flat
`type: "playing-card"` for all 52 cards (the alternative — per-suit
types — was available and would have been the "TCG-native" answer, but
it's semantically wrong: `type` is supposed to mean gameplay category,
and all 52 cards behave identically at that level; suit is an attribute,
not a category). Consequence, confirmed by actually rendering: with one
`type`, `type_colors` can only supply ONE fg/bg pair for the entire deck.
There is no schema mechanism for "color red when `attributes.suit` is
hearts/diamonds, black otherwise" — the single most basic visual fact
about a physical deck of cards. Rendered a 2 of Clubs and a 2 of Hearts
side by side and diffed them: **98.3% of sampled pixels are identical**
between two cards of different color/suit. A renderer that can't tell
red from black is about as wrong as a playing-card renderer can get.

**6. The reference renderer has no visual language for rank/suit at
all — confirmed by reading `render_cards.py` and running it.** It draws
a name bar, a circular cost badge (skipped: Hearts has no `cost`
attribute), a big art-placeholder box (skipped: no art, so it's a hatched
empty rectangle eating ~40% of every card), wrapped rules text, and a
circular power badge (skipped: no `power` attribute either). There is no
concept of "the two big things every real playing card shows in the
corner" — rank and suit as a dominant pip — because `attributes` is an
arbitrary named bag with no semantic hook for "this is the primary corner
display." Every one of the 52 rendered cards is a near-blank card with a
name and a tiny bit of footer text; see finding 5 for how similar two
different cards actually look.

**7. Found a real, previously-invisible bug in the renderer.**
`render_cards.py`'s `main()` builds `colors` by merging `game.yaml
type_colors` over a hardcoded fallback `PALETTE`, and uses that merged
`colors` dict for every card face — but `render_back(game, PALETTE[0])`
is called with the tool's own hardcoded `PALETTE[0]`, never the merged
`colors`. Rendered `_back.png` and sampled its background pixel:
**`#8c2f1b`** — Ember's ember-red, not Hearts' declared `#f7f5f0` /
`#1a1a1a`. This bug has been invisible until now because `PALETTE[0]` in
the tool source is a byte-for-byte copy of Ember's own `type_colors.ember`
— the one game ever rendered through this tool happens to make the bug
unobservable. Hearts' card backs render in the wrong game's color
entirely.

**8. `deck_limit` means something different here than its name implies.**
Set `deck_limit: 1` on all 52 cards per the task spec, and it validates
(non-negative integer, satisfies the schema) — but the field's stated
purpose is "max copies per deck, if the game has decks" (a deckbuilding
constraint: "you may only run 1 of these"). Hearts has no decks (#1), so
what `deck_limit: 1` actually communicates here is "exactly one physical
copy of this card exists," a different fact entirely. Any UI that
surfaces `deck_limit` as deckbuilding guidance ("max 1 copy") would show
correct-looking but meaningless text for Hearts.

**9. No enum or range support on `attribute_definitions`.** `suit` is
typed `string`, but nothing stops `"haert"` from validating — the
validator only checks `isinstance(v, str)`, not membership in a closed
set. `rank_value` is typed `integer` with no way to declare its 2-14
range in the schema (the task spec's "integer 2-14" is prose-only,
unenforceable). For a TCG's open-ended `cost`/`power` this flexibility is
the point; for a genuinely closed, tiny universe like "the four suits of
a deck," it's exactly the case where a validator *could* catch a typo and
doesn't.

## Verdict

Nothing here made the format unable to represent Hearts — validation is
clean, rendering doesn't crash, and the two-tier card/printing model plus
typed attributes are honestly a fine fit for the DATA (52 rows, 4 typed
fields, done). What the format has no answer for is PROCEDURE: whose
turn it is, what "follow suit" means, when hearts break, how a hand gets
dealt and passed. That's arguably correct scope discipline (`SPEC.md` is
explicit that rules live in markdown, not schema) rather than a bug — but
it means this fixture "validates" while capturing maybe a third of what
makes Hearts Hearts. The rest is sets/printings/formats bureaucracy this
game doesn't need but the spec requires anyway (finding 3), and a
renderer that was never asked to think about a game where color-by-suit
*is* the entire visual identity (findings 5-7).
