# The card layout engine: `templates/layout.yaml`

Every game in this project has always had card **data** (`components/
cards.json`, `components/printings.json`). Some games have **art**
(printings' `image`/`art` fields). What was missing was the layer in
between: a **layout** — where the title goes, how big the rules text box
is, what color the frame is for a red-faction card vs a blue one — the
thing that actually turns "a card record" into "the printed card." Without
it, every game rendered through one generic template (`cardFrame()`), and
scanned/composed card images could never be *edited*, only replaced —
they're baked pixels.

`templates/layout.yaml` is that missing layer: an **optional**, declarative,
per-game file that positions every visual element of a physical card in
real millimeters. One renderer, `layoutCard(g, c, printing, opts)` in
`tools/hub_template.html`, turns `{card data, printing, layout spec}` into
the actual card — and it's the *only* card renderer in the hub: the cards
grid, the card modal, the live card editor preview (re-rendered on every
keystroke), the PR visual diff, and the true-physical-size print sheet all
call it. Edit a card's name/cost/text in the editor and the same function
that draws the grid tile redraws the print-ready card, live.

A game with no `templates/layout.yaml` is unaffected: `layoutCard()`
detects there's no spec and falls straight through to the original
data-driven `cardFrame()`. Adding a layout is opt-in per game.

See `schemas/layout.schema.json` for the formal schema, and
`examples/arcmage/templates/layout.yaml` for a complete, real example
(a faction-colored TCG frame at true 63.5mm x 88.9mm trading-card size).

## Why millimeters

Every coordinate, size, and font in a layout is in **mm** (positions/sizes)
or **pt** (font sizes) — real physical print units, not pixels. That's what
makes "the card you edit" and "the card that prints" the same card: the
renderer builds an unscaled card-sized box in real mm/pt units, and only
the *outer* wrapper — sized to whatever pixel width a grid tile or preview
pane wants — shrinks it with a single CSS `transform:scale()`. A 150px grid
thumbnail and a 63.5mm print-sheet cell are the exact same markup, just
scaled; nothing is measured or laid out differently between preview and
print.

## Top-level shape

```yaml
card:
  w_mm: 63.5        # trim (finished) size
  h_mm: 88.9
  bleed_mm: 3        # documentation only today -- not yet drawn
  radius_mm: 2.8
  bg: "#f7f1e3"       # hex, or "palette" (see below)

fonts:
  - { id: title, family: "Cinzel",      weight: 700 }
  - { id: body,  family: "EB Garamond", weight: 400 }

palette:
  by: "attributes.faction"      # dot path read off the card
  map: { "Gaian": "#2e7d32", "Dark Legion": "#1a1a1a" }
  default: "#4a4a4a"

regions:
  - { id: title, type: text, src: "card.name", x: 3, y: 1.6, w: 47, h: 8.2,
      font: title, size_pt: 10, align: left, color: "#ffffff" }
  # ... more regions
```

`fonts` and `palette` are both optional. `card` and `regions` are required.
`regions` paints **in array order** — later regions draw on top of earlier
ones, so background/frame rects go first, art next, text and badges last.

## Data paths

Most fields that reference card data (`src`, `palette.by`, a badge's/row
cell's `key`, `show_if`) are **dot paths** resolved against the card,
printing, and game:

- `card.name`, `card.text`, `card.attributes.cost` — explicit root.
- `printing.art_url`, `printing.artist` — explicit root.
- A **bare** path with no prefix (`attributes.faction`, `name`) tries the
  card first, then the printing — covers both styles you'll see in the
  wild (`palette.by` is usually written bare; region `src` is usually
  written with an explicit `card.`/`printing.` prefix for clarity).
- `{card.type} — {card.subtypes}` — a **template string**: any `{path}`
  token inside is resolved and interpolated; anything without `{` is
  treated as a single plain path instead. Arrays (like `subtypes`) join
  with `, `.

## Region types

| type | what it draws | key fields |
|---|---|---|
| `text` | one line/short field | `src`/`text`, `font`, `size_pt`, `align`, `valign`, `color`, `bg`, `uppercase` |
| `richtext` | multi-line body text | adds `symbols` ([key] -> glyph chips, same convention as `cardFrame()`), `autoshrink`, `min_size_pt` |
| `image` | printing/card artwork | `src`, `fit` (`cover`/`contain`), `credit` (artist caption, also shown on the placeholder) |
| `badge` | circular/square numeric chip | `d` (diameter) instead of `w`/`h`, `shape` |
| `row` | evenly-spaced inline cells | `of: [{key, label, ...}]`, each cell independently `show_if`-able |
| `rect` | undecorated frame/bar/divider | `fill`, `stroke`, `stroke_w_mm`, `radius_mm` — no data, pure decoration |

Every region (and every `row` cell) accepts `show_if`: a bare path (shown
when truthy/non-empty), `!path` (shown when falsy/absent), or `path ==
value` / `path != value`. `examples/arcmage/templates/layout.yaml` uses
this to only draw its subtypes line when a card actually has subtypes
(`show_if: "subtypes"` — true for "Cutpurse Imp" which has `["Imp"]`, false
for "Abduction" which has `[]`), and to guard its loyalty badge with
`show_if: "attributes.loyalty"` the same way a split attack/defense stat
row would guard on `attributes.attack` in a game that has one.

## Color: literal or data-driven

Any color field (`color`, `bg`, `fill`, `stroke`, and `card.bg`) accepts
either a literal hex string, or the literal value `"palette"`, which
resolves through the top-level `palette` block for that card — e.g. a
faction-colored frame without writing one region per faction.

## Art that isn't there yet

`image` regions always paint a tinted placeholder (using the resolved
palette color, or `bg`) *underneath* the `<img>`, with the `credit` text
(when set) shown on it. If `src` resolves to nothing, or the browser's
`onerror` fires because the URL 404s, the placeholder shows through
instead of a blank box. A layout never assumes an art URL is good — it
degrades honestly.

## Autoshrink

`richtext` regions with `autoshrink: true` estimate how many lines their
text will wrap to at a given point size (average character width for that
font size vs. the box's mm width) and step `size_pt` down — never below
`min_size_pt` (default `size_pt - 4`, floor 5) — until the estimate fits
the box height. This is a deterministic heuristic, not a real text
measurement: the renderer is a plain string-building function (like every
other renderer in this file), called identically in the browser and in a
headless Node smoke test, so it can't depend on `getBoundingClientRect()`
or a canvas. In practice this comfortably fits real card text (see the
Arcmage layout, tuned against its longest rules text) without ever
needing to.

## Writing a layout for another game

1. Look at what the game already has: `game.yaml`'s `type_colors` /
   `faction_colors` (great source for a `palette.map`), and
   `attribute_definitions` (what fields exist to put on the card).
2. Create `examples/<game>/templates/layout.yaml`. Start from `card` +
   one `rect` background + one `text` title region; add the rest
   incrementally.
3. Validate: `python3 tools/validate.py examples/<game>` (or `node tools/
   validate.mjs examples/<game>`) checks it against `schemas/
   layout.schema.json` alongside everything else, when the file is
   present.
4. Rebuild the hub (`python3 tools/build_hub.py`) and open the game's
   Cards tab, a card's modal, and the card editor — `layoutCard()` picks
   the spec up automatically (`build_hub.py` reads `templates/layout.yaml`
   into `g.layout` if the file exists; nothing else to wire).
5. Try `🖨 Print` on the game's Cards tab — that's the same spec at true
   physical size, cut lines included.

## What this doesn't do (yet)

- `bleed_mm` is recorded but not currently painted as an actual bleed
  margin outside the trim box — `layoutCard()` renders the trim size.
- `row`/`of` cells are evenly distributed with CSS flexbox, not
  individually positioned in mm — fine for a compact stat line, not a
  replacement for laying out arbitrary repeating regions.
- No rotation, skew, or non-rectangular clipping paths for regions.
- Font loading is best-effort Google Fonts (with a generic serif
  fallback) — there's no build-time font embedding the way rulebook
  figures get base64-embedded.
