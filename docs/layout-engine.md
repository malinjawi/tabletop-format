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
the actual card. It is the only face renderer in the hub: the cards grid,
card modal, live editor preview, PR visual diff, and physical-size print
sheet all call it. `tools/render_cards.mjs` extracts that exact source into
headless Chrome and captures the 300dpi faces consumed by PnP, Tabletop Club,
TTS, releases, and the immutable render cache. Edit a card once and every
surface regenerates from the same markup and layout rules.

A game with no `templates/layout.yaml` is unaffected: `layoutCard()`
detects there's no spec and falls straight through to the original
data-driven `cardFrame()`. Adding a layout is opt-in per game.

See `schemas/layout.schema.json` for the formal schema, and
`examples/arcmage/templates/layout.yaml` for a complete, real example --
now derived from Arcmage's OWN official card template (true 65mm x 92mm
card size, official fonts/frame texture/field rules), not an invented
default. See "Importing an official template (case study: Arcmage)"
below for exactly how, and what's confirmed vs. estimated.

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
  w_mm: 65           # trim (finished) size -- Arcmage's OWN card size, not the
  h_mm: 92           # 63.5x88.9mm "poker" size printSheet() falls back to by
  bleed_mm: 2         # default for games with no layout.yaml at all
  radius_mm: 2.5
  bg: "#1c1c1c"       # hex, or "palette" (see below)

fonts:
  - { id: title, family: "Tinos", weight: 700 }
  - { id: body,  family: "Tinos", weight: 400 }

palette:
  by: "attributes.faction"      # dot path read off the card
  map: { "Gaian": "#2e7d32", "Dark Legion": "#1a1a1a" }
  default: "#4a4a4a"
  motifs:                       # optional reusable surface language
    Gaian:
      shell: "repeating-linear-gradient(45deg,transparent 0 5mm,rgba(255,255,255,.2) 5.1mm 5.4mm,transparent 5.5mm 10mm)"
      panel: "radial-gradient(circle at 0 70%,transparent 0 4mm,color-mix(in srgb,{palette} 30%,transparent) 4.1mm 4.4mm,transparent 4.5mm)"

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
| `richtext` | multi-line body text or a licensed/vector symbol | adds `symbols` ([key] -> versioned glyph assets), `icon_only`, `autoshrink`, `min_size_pt`, `no_wrap`, `char_width_em`; every region can also use `opacity` and a CSS `filter` |
| `image` | printing/card artwork | `src`, `fit` (`cover`/`contain`), `source_crop`, `source_size`, `source_crop_fit`, `credit` (artist caption, also shown on the placeholder) |
| `badge` | circular/square numeric chip | `d` (diameter) instead of `w`/`h`, `shape` |
| `pips` | repeated glyphs (for influence, loyalty, etc.) | `src`, `glyph`, `max`, plus the shared text styling fields |
| `row` | evenly-spaced inline cells | `of: [{key, label, ...}]`, each cell independently `show_if`-able |
| `rect` | undecorated frame/bar/divider | `fill`, `stroke`, `stroke_w_mm`, `radius_mm` — no data, pure decoration |
| `background` | full-bleed (or partial) decorative texture — a reusable frame/border image, not credited artwork | same fields as `image` (`src`, `fit`) minus the artist-credit chrome; meant to be the FIRST region so everything else paints on top |

Every region (and every `row` cell) accepts `show_if`: a bare path (shown
when truthy/non-empty), `!path` (shown when falsy/absent), or `path ==
value` / `path != value`. `examples/arcmage/templates/layout.yaml` uses
this to only draw its subtypes line when a card actually has subtypes
(`show_if: "subtypes"` — true for "Cutpurse Imp" which has `["Imp"]`, false
for "Abduction" which has `[]`), and to guard its loyalty badge with
`show_if: "attributes.loyalty"` the same way a split attack/defense stat
row would guard on `attributes.attack` in a game that has one.

Any region may also provide `map`, an object that converts the resolved
value into a display label or asset URL before rendering. This keeps source
data stable while a layout supplies presentation-specific names.

For source-backed artwork, `source_crop: [x, y, width, height]` and
`source_size: [width, height]` select a rectangle from a complete source
face. Crops retain the historical stretch-to-fill behavior unless
`source_crop_fit: cover` is set. `cover` trims the selected rectangle around
its center to the target region's aspect ratio before scaling, preserving
the artwork's proportions.

Symbols declared in `game.yaml` may provide both a fallback `glyph` and an
`asset` path. Rich-text `[symbol]` tokens use the SVG/image asset when one is
available and keep the glyph fallback for portable data-only games.
Set `icon_only: true` on a rich-text region containing one `[symbol]` token to
center and scale the original asset inside its physical box. This lets a game
version its faction, set, currency, point, and stat language without baking
those marks into a flattened card frame.
`opacity`, `filter`, and `blend_mode` apply to the whole region, including its
symbol image, so the same versioned asset can be a quiet watermark, an inverted
footer mark, or a multiply-blended print emblem without modifying the SVG.

## Color: literal or data-driven

Any color field (`color`, `bg`, `fill`, `stroke`, and `card.bg`) accepts
either a literal CSS color/background or a palette token. `"palette"`
resolves through the top-level `palette` block for that card; derived tokens
include `palette-dark`, `palette-light`, `palette-paper`,
`palette-metallic`, and `palette-gradient`.

Color alone is not enough for many production designs. An optional
`palette.motifs` map gives each selected value reusable `shell` and `panel`
CSS background slots. A motif can use `{palette}` as a placeholder for its
resolved color. Regions consume those slots with `palette-shell-motif` and
`palette-panel-motif`, so one shared card family can render different faction
textures without duplicating regions or hardcoding game-specific faction names
inside the renderer. Missing motif entries fall back to
`palette.default_motif`, then transparent.

## Art that isn't there yet

`image` regions always paint a tinted placeholder (using the resolved
palette color, or `bg`) *underneath* the `<img>`, with the `credit` text
(when set) shown on it. If `src` resolves to nothing, or the browser's
`onerror` fires because the URL 404s, the placeholder shows through
instead of a blank box. A layout never assumes an art URL is good — it
degrades honestly.

## Production text fitting

`text`, `richtext`, and `body` regions can choose `autoshrink: true`. Forge
first makes a deterministic line-count estimate for a stable first paint, then
measures the loaded font in the browser and canonical Chromium exporter. It
restarts at `size_pt` on every render and shrinks in 0.25pt steps — never below
`min_size_pt` (default `size_pt - 4`, floor 5). `line_height`, paragraph gaps,
one-line text, rich symbols, and a body's separately scaled flavor text all
participate in that measurement.

The same `layMeasureAndFit()` routine runs in Studio previews, normal card
views, and exact PNG/PDF production rendering. If content still clips at the
minimum size, the face preflight reports it, family review disables Commit,
and strict production rendering fails. Designers can instead choose a fixed
size; fixed text is never silently shrunk and overflow remains an error.

## Writing a layout for another game

### Groups, borders, and shadows

Every region may carry a `group` id. Forge Studio treats regions with the same
id as one persistent selection for moving and keyboard nudging, while leaving
their array positions untouched so grouping can never silently change paint
order. Alt-click isolates one member. The group id is stored in the family
YAML, included in SVG working-copy metadata, three-way merged, and shown in the
review like any other layout field.

`rect` regions retain their native `stroke`, `stroke_w_mm`, and `radius_mm`
properties. Any positioned region can additionally use a structured border:

```yaml
border: { color: "#18242D", width_mm: 0.35, style: solid }
```

Forge Studio also authors a portable millimetre-based shadow instead of asking
a beginner to write browser CSS:

```yaml
shadow_spec: { x_mm: 0, y_mm: 0.75, blur_mm: 1.5, spread_mm: 0, color: "#000000", opacity: 0.3, inset: false }
```

Both structures feed the same card renderer used by the browser proof and the
exact-version raster/print pipeline. The older raw `shadow` CSS property stays
supported for existing expert-authored layouts, but the structured form takes
precedence. Generic SVG editors preserve these fields in Forge metadata; Forge
does not claim that another application's proprietary effect stack can be
translated losslessly.

### Reusable named text styles

Project-wide typography belongs in the design system rather than being copied
across dozens of regions:

```yaml
text_styles:
  card_title:
    font: title
    size_pt: 11.5
    color: "#18242D"
    uppercase: true

regions:
  - id: title
    type: text
    text_style: card_title
    src: card.name
    x: 8
    y: 4
    w: 46
    h: 7
```

While attached, keys declared by the named style are authoritative; the
region still owns its binding, geometry, visibility, grouping, and effects.
Forge Studio shows how many layers, families, and cards use the style before a
change is reviewed. Detaching materializes the currently resolved typography
onto the region so its appearance does not jump.

The SVG family bridge carries both the complete style map on the document root
and each region's style ID, then three-way merges both back to canonical YAML.
nanDECK cannot represent a shared style relationship, so its working copy
receives the resolved appearance and an explicit flattening warning; returning
that file never silently deletes the Forge relationship. Typography edits on
an attached layer are ignored with a clear import warning; detach the style in
Forge first when the intended change is deliberately local.

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
6. Rasterize the exact same renderer with `node tools/render_cards.mjs
   examples/<game>`. Set `FMT_RENDER_STRICT=1` to fail if any text-bearing
   region clips; this is the release check for dense or unusually long cards.

## Raster exports and requirements

The canonical rasterizer needs Node dependencies (`npm install`) and a local
Chrome/Chromium executable. Set `FMT_CHROME_BIN` if it is not installed in a
standard location. `tools/render_cards.py` remains as a compatibility wrapper
for older scripts; it dispatches to the Node renderer and does not contain a
second drawing implementation. Exporters always regenerate faces before
packaging, so stale PNGs cannot silently disagree with the browser preview.

Fronts and the shared card back are unified. `back.regions` accepts the same
declarative region objects as `regions`; Studio's **Front / Back** switch edits
that project-wide surface, and `layoutBackCard()` is used by the browser,
headless face rasterizer, home-print sheets, VTT packages, and frozen releases.
Older projects with only `back: {text, bg, color, ...}` keep their legacy
centered-title rendering until a designer chooses **Make back editable**. That
promotion is an ordinary reviewed design-system change, not an implicit
migration. Once promoted, **Choose back artwork** reuses a versioned library
asset or **Upload back art** stages new bytes plus creator, license, rights
status, source, and redistribution metadata. The artwork binding and rights
receipt are reviewed in the same candidate as the back geometry.

The SVG family bridge preserves and three-way merges the whole back contract as
project metadata. Its family SVG exposes front regions as editable SVG objects;
back layers remain visually editable in Forge Studio and are not falsely
advertised as arbitrary external-editor objects. Native files can still be
stored byte-for-byte in a full Forge project package.

## Importing an official template (case study: Arcmage)

Every other game's `templates/layout.yaml` up to this point (including
Arcmage's own first version) was an invented default: a plausible-looking
faction-colored frame, picked for taste, with no connection to how the
source game's own software actually renders its cards. That's fine for a
game with no such software to check against -- but Arcmage is real,
currently-developed, and **open source** (game/rules text CC-BY-SA-4.0,
server code GPL-3.0, most art CC-BY-SA-4.0), which means its actual
template is legally obtainable, not just approximable. This section is
the method used to replace Arcmage's invented default with one derived
from Arcmage's own renderer -- written up as a repeatable recipe for
"bring your formatter": any open card game with a live card database
and/or an open-source rendering codebase can go through the same steps.

### The method

1. **Find the game's own renderer.** Two independent sources, and you
   often only need one: (a) a **live card database API** that exposes
   per-card export formats (Arcmage's `aminduna.arcmage.org/api/Cards/
   {guid}/export?format=...` -- `OverlaySvg`, `BackgroundPng`, `Svg`,
   `Art`, ...), and (b) the **open-source server code** that builds those
   exports (`github.com/wtactics/arcmage`, specifically
   `Arcmage.Server.Api/Layout/CardGenerator.cs` and `Styles.cs`).
2. **Extract geometry from code, not pixels.** A rendered card image only
   shows you *an* answer; the code that generates it shows you the *rule*
   -- true for every card, not just the one you happened to look at.
   `CardGenerator.cs`'s SVG-merge step revealed the exact card canvas
   size (`230.31496 x 325.98425` SVG user-units) and print-border margin
   (`7.0866184` units) as literal numbers; `Repository.cs`'s
   `FillPredefinedCartTypes()` revealed the rules-text box's max size
   (`190 x 105` units) and, critically, *which fields each card type even
   shows* (only Creature cards print Attack; City cards print Defense but
   not Attack; nothing but Loyalty/Cost/Text/Art/Info is universal) --
   the kind of per-type rule you'd have to reverse-engineer from dozens
   of card images otherwise, and might still get wrong.
3. **Work out the unit system.** `230.31496` isn't a self-explanatory
   number. Divide two related quantities to find the conversion: the
   margin (`7.0866184` units) turned out to be exactly `2.0mm` at
   `1 unit = 1/90 inch` (Inkscape's legacy DPI convention) --
   `7.0866184 / 90 * 25.4 = 2.0000...` -- which then made the card canvas
   an exact `65mm x 92mm` and the text box an exact `53.62mm x 29.63mm`.
   Once you have one confirmed conversion factor, every other number in
   the same coordinate space becomes trustworthy too.
4. **Get the live per-instance asset URLs and confirm their
   parameters.** Fetching one real card's full JSON record
   (`/api/Cards/{guid}`) exposed `backgroundPng` and `overlaySvg` as
   fields with their exact query-string shape already filled in
   (`...&faction={guid}&type={guid}`); cross-checking the SAME URL
   pattern against several cards across different factions/types (not
   just one) is what turns "looks like a pattern" into "confirmed
   parameterization" -- and reading the export controller's source
   (`CardsController.cs`'s `Export` action) confirmed `BackgroundPng` is
   looked up by faction+type ALONE (the card guid in the URL is unused
   for that specific export), i.e. genuinely a reusable frame texture,
   not a per-card render.
5. **Map the confirmed geometry onto `layout.yaml`'s regions**, using
   every hard number as an anchor and everything else as a clearly-labeled
   estimate. `examples/arcmage/templates/layout.yaml`'s regions keep the
   confirmed `card.w_mm`/`h_mm` and the rules-text region's `w`/`h`
   verbatim; the exact `x`/`y` of the title, art window, and badges are
   estimates *constrained* by those confirmed numbers (e.g. this layout's
   5.7mm side margins were chosen specifically so the rules-text region
   comes out exactly 53.6mm wide, matching the confirmed 53.62mm) rather
   than invented independently.
6. **Extend the engine only for what the schema genuinely can't
   express yet.** Here that was ONE thing: a full-bleed, non-artwork,
   non-credited decorative image layered under everything else. Rather
   than misuse `image` (which always paints an artist-credit strip -- the
   wrong chrome for a reusable border texture), a new `background` region
   type was added to `schemas/layout.schema.json` and
   `layRegionBackground()` to `tools/hub_template.html` -- reusing
   `image`'s existing CSS and honest-degrade-to-a-flat-tint behavior,
   since `layoutCard()` already paints regions in array order (no new
   z-order mechanism was needed, just a region type with the right
   chrome).
7. **Verify against real, varied data** -- not one hand-picked card.
   The Arcmage smoke test renders a Creature (both Attack and Defense), a
   City (Defense only, no Attack), and an Event (neither) through the
   SAME `layoutCard()` and asserts the official font, the official
   background URL, the confirmed 53.6mm x 29.63mm text-box size, and that
   each type-specific region shows/hides exactly per the source's
   `ShowAttack`/`ShowDefense` rules -- a single good-looking card
   screenshot can't catch a per-type field-visibility bug the way
   rendering three structurally different cards can.
8. **Write down what's confirmed vs. approximated, separately, and
   don't blur them.** See `examples/arcmage/README.md`'s "Card layout"
   section for the full list this project produced for Arcmage. The
   honest version of "we imported the official template" is "we imported
   the parts we could confirm, and clearly marked the rest as our best
   estimate anchored to those confirmed parts" -- not a blanket claim of
   pixel-perfect fidelity nobody actually checked.

### What this session's tools could (and couldn't) do

Worth recording plainly, since it shaped which parts of the above ended
up CONFIRMED vs. APPROXIMATED: this session's web-fetch tool reliably
returns `text/html` and `application/json` bodies but silently returns
nothing for other content types (`image/svg+xml`, `image/png`,
`text/plain` all came back empty, confirmed against multiple unrelated
hosts) -- so the live `overlaySvg`/`BackgroundPng` exports (and even a
plain `robots.txt`) could never be read directly, and the composed card
JPEGs could never be visually inspected either. What rescued this port
from being stuck at "the API returns some XML/PNG, presumably" was that
`github.com/<owner>/<repo>/blob/<ref>/<path>` (the syntax-highlighted
HTML file-view page, as opposed to `raw.githubusercontent.com` or the
`api.github.com` Contents API, both of which hit the same content-type
or rate-limit problems here) renders the full file as part of the page's
HTML -- readable by the exact same tool that couldn't read the raw SVG.
If you're doing this for another game and hit the same wall: check
whether the *source code* that builds the official asset is available
even when the *asset itself* isn't fetchable, and reach for the host's
own human-readable code-browsing page over its raw/API endpoints.

### Applying this to another open game

The same shape of investigation -- a live export API with a discoverable
URL/parameter pattern, plus (if available) open server source for the
generation logic -- is worth checking for before writing a from-scratch
`layout.yaml`. Start with: does the game have a public card
database/deckbuilder with per-card export endpoints? Does its rendering
code live in a public repo, even if the *card data* doesn't (Arcmage's
own README says exactly that -- "this software stack comes with no
cards or artwork")? If either is true, steps 1-8 above apply directly.
If neither is true, fall back to the generic "Writing a layout for
another game" section above -- an invented-but-honestly-labeled default,
same as this project's other layouts.

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
