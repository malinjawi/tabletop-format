# decktet

A full port of P.D. Magnus's **the Decktet** — a 45-card, six-suited,
multi-suit card system — plus two of its catalog games, **Magnate** and
**Quincunx**. Unlike the proprietary IP fixtures under `examples/_fixtures/`
(Netrunner, Hearthstone), this is a real, openly-licensed public game and
lives under `examples/` on purpose: it can be attributed and shared under
the terms below without a "do not publish" carve-out.

## License

Two license grants are in play, both Creative Commons Attribution
NonCommercial ShareAlike, but different **versions**, from different pages
on different sites:

**The deck itself + the print-and-play version — CC BY-NC-SA 4.0.**
Source: https://www.decktet.com/ (fetched directly). Exact quote from the
site footer:

> © 2010-19 P.D. Magnus. Some rights reserved. The text on this page and
> the print-and-play version of the deck are offered as open content under
> a Creative Commons Attribution NonCommercial ShareAlike 4.0 License.

The same license badge and text repeats on every decktet.com page fetched
for this port, including the "Get the Decktet" (print-your-own) and "Games"
pages.

**The wiki's game rules (Magnate, Quincunx, and the rest of the catalog) —
CC BY-NC-SA 3.0.** Source: http://wiki.decktet.com/ (fetched directly).
Every wiki.decktet.com page fetched for this port carries this footer:

> Unless otherwise stated, the content of this page is licensed under
> Creative Commons Attribution-NonCommercial-ShareAlike 3.0 License.

`game.yaml`'s top-level `license: CC-BY-NC-SA-4.0` reflects the deck itself
(the majority of what's modeled here — 45 of the port's components are
cards, and only 2 are catalog-game rules text). The 3.0-vs-4.0 split is
called out explicitly here and in `rules/rules.md`'s Sources section so
nobody assumes the whole port is under one single license version.
**Correction to the source brief**: this port's task brief suggested
`CC-BY-NC-SA-3.0` as a placeholder "or exact as found" — the exact license
this port actually fetched and verified for the deck itself is **4.0**, not
3.0. Use 4.0 for the deck; 3.0 only applies to the wiki-hosted game rules.

Both versions require attribution, forbid commercial use, and require
share-alike (any derivative must carry the same CC BY-NC-SA terms) — this
port satisfies all three: this README + `game.yaml` attribute the original
creators, nothing here is sold, and the port itself remains CC BY-NC-SA.

## Attribution

- **P.D. Magnus** — deck design, illustration, and rules text (decktet.com,
  wiki.decktet.com, fecundity.com/pmagnus/decktet/).
- **Cristyn Magnus** — designed Magnate; P.D. Magnus did additional
  development.
- **Chris DeLeo** — designed Quincunx; rules text by P.D. Magnus.

## Provenance — how this data was produced

- **Deck structure (all 45 cards' rank, suits, and name)**: extracted
  directly from the text layer of the official print-and-play PDF,
  https://www.decktet.com/download/decktet.pdf, fetched via `web_fetch`.
  That PDF is built from vector/text content, not scanned images, so every
  card's rank, suit codes, and printed name came back as real text. This
  was cross-checked against https://www.decktet.com/download/decktet-rules.pdf
  (the "complete rules" PDF, which independently confirms the 11 personality
  cards' rank+suit+name and the deck totals) and against
  wiki.decktet.com/structure and wiki.decktet.com/lexicon for the suit
  order (Moons, Suns, Waves, Leaves, Wyrms, Knots) and deck totals (36
  basic + 9 extended = 45).
  **Self-check**: with all 45 cards transcribed, every one of the six
  suits appears in exactly 14 of the deck's 84 total suit-slots (1 ace +
  1 crown + suits across 24 two-suited number cards + suits across 4
  three-suited Pawns + 4 three-suited Courts) — a perfectly even split
  that a transcription error would almost certainly have broken. This is
  not itself a cited source, just this port's own arithmetic sanity check
  on the sourced data above.
- **Magnate and Quincunx rules**: fetched directly from
  http://wiki.decktet.com/game:magnate and
  http://wiki.decktet.com/game:quincunx. `rules/rules.md` is this port's
  own condensed restatement of both, not a verbatim copy. The Magnate URL
  named in decktet.com's own "Games" page
  (fecundity.com/pmagnus/decktet/magnate.php) returned no content when
  fetched directly for this port; the wiki.decktet.com mirror (linked from
  that same games page) did, and is the source actually used.
- **Card flavor text** (the short line in each card's `text` field):
  condensed/paraphrased from wiki.decktet.com/fortunes (P.D. Magnus's own
  card-by-card interpretation guide, CC BY-NC-SA 3.0) for the 38 named
  cards, and from that same page's "Six Suits" section for the six Aces
  (which have no individual name of their own — "each ace has the
  significance of its suit"). These are short, reworded lines, not
  verbatim paragraphs.

## What's sourced vs. reconstructed

**Directly sourced, high confidence:**
- All 45 cards' rank, suit(s), and printed name (from the official PnP
  PDF's text layer; see Provenance above).
- The 6-suit structure, canonical suit order, and 36+9=45 deck total.
- The 11 personality-marked cards specifically (`attributes.mark:
  "personality"`) — confirmed both by the PnP PDF and independently by the
  scoring text in the "complete rules" PDF's Adaman example ("the ranks of
  the eleven personalities in the basic deck add up to 66").
- Full Magnate and Quincunx rules (condensed from the wiki pages).
- Both licenses (exact quotes above).

**This port's own reconstruction, disclosed:**
- `attributes.rank_value` — the deck's own text says Crown is rank 10 in
  *basic-deck-only* play, and separately that Pawns/Courts insert between
  9 and Crown when the extended deck is added. Since this port models all
  45 cards together, `rank_value` uses a single monotonic scale (Ace=1,
  2-9, Pawn=10, Court=11, Crown=12) built on those two documented facts,
  not copied from a single source table. Games that score Aces=1/Crowns=10
  literally (Adaman, Quincunx, Magnate) do so in their own rules text in
  `rules/rules.md`, independent of this field.
- `attributes.faction` — a derived "primary suit" (first suit in canonical
  order) added only so the platform's `faction_colors` renderer hook can
  give each card a suit-tinted color. `subtypes` (the full suit list) is
  the authoritative data; `faction` is a rendering convenience, not a
  separate sourced fact.
- `attributes.mark` — only records `"personality"` where sourced (11
  cards). This port does **not** attempt to assign location vs. event
  marks to the other 34 cards individually; that finer distinction exists
  in the source material but was not confirmed per-card with enough
  confidence to encode as data. Three cards are explicitly documented as
  carrying *both* marks (the Market, the Origin, the End) per
  wiki.decktet.com/fortunes, but that nuance also isn't encoded as a
  separate field here.
- Card `text` fields are condensed paraphrases (see Provenance), not
  official rulebook text.
- Glyphs in `game.yaml`'s `symbols` block (☾ ☀ ≈ ✤ ϟ ⌘) are this port's own
  pick of Unicode dingbats for a quick visual fallback — not official
  Decktet iconography (the real suit icons are illustrated art assets this
  port doesn't include).

## Scope

- **Full deck**: all 45 cards (36 basic + 9 extended) — not a subset.
- **Two sets**: `basic` (36) and `extended` (9), matching the deck's own
  structure, so a format/game can restrict itself to `card_pool: [basic]`
  the way most catalog games do by default.
- **Two catalog games** fully written out in `rules/rules.md`: Magnate
  (2-player, needs dice + tokens beyond the cards) and Quincunx (2-4
  players + solitaire, cards only). Dozens more exist at
  wiki.decktet.com/all-the-games; only these two are modeled here.
- No physical art assets (`printings.json` entries are template-only, no
  `art` field) — this port is card *data*, not scanned/illustrated card
  images.
