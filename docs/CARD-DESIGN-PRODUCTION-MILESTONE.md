# Forge production design milestone

Status: implementation milestone, September 2026

## Product promise

A creator can bring real card data and real production assets into Forge, edit
in Forge or in a familiar external tool, inspect every affected card, and turn
the reviewed result into one attributed commit or pull request. Print and play
artifacts are then built from that exact commit.

Forge is the source, review, and release layer. It is not a lossy replacement
for every native design application.

## What the surrounding tools teach us

The established workflow is consistent even though the applications differ:

1. A row in a dataset describes one card or component.
2. A reusable layout binds row fields to visual regions or layers.
3. The renderer produces card faces and print or tabletop outputs.
4. Native projects, fonts, images, and effects remain owned by the application
   that can faithfully edit them.

Dextrous calls the combination a component set: a layout plus table or Google
Sheets data. Component Studio uses datasets and variables with a layer-based
renderer, then exports images, print-and-play PDFs, Tabletop Simulator assets,
or directly to The Game Crafter. nanDECK combines spreadsheet data with a
visual or scripted layout and can produce images, PDFs, and virtual-tabletop
outputs.

The useful interoperability boundary is therefore **stable component data,
portable visual geometry where it is honestly supported, and byte-preserved
native source packages**. Forge must never claim that CSV can carry a Dextrous
layout or that generic SVG can preserve every Affinity effect.

References:

- Dextrous overview and component editor:
  <https://docs.dextrous.com.au/>
  <https://docs.dextrous.com.au/p/hQS34FDh4nNK3c/Component-editor>
- Dextrous public roadmap:
  <https://docs.dextrous.com.au/p/ovAhJfC1Qi7drs/Road-Map>
- Component Studio designs, datasets, CSV, and exports:
  <https://help.component.studio/article/687-designs>
  <https://help.component.studio/article/685-datasets>
  <https://help.component.studio/article/686-csv-import-export>
  <https://help.component.studio/article/580-cs2-export-design>
- nanDECK feature contract: <https://nandeck.com/features>

## The production path

### 1. Choose the working surface

- **Forge Studio:** select a real card and edit its content against the live
  production face, then switch to the shared layout to edit geometry,
  typography, color, visibility, or binding. The same workspace distinguishes
  “this card” from “every card in this family” and tests the family against all
  matching cards.
- **Excel / LibreOffice:** download one deterministic `.xlsx` containing
  cards, printings, and pieces. It carries its exact Git ref between devices;
  Forge rebuilds that trusted baseline and returns all tabs through one atomic
  rendered dry run, commit, or pull request.
- **Dextrous / Component Studio / Sheets:** download `cards.csv` directly,
  preserve stable IDs, and return that CSV for review. The browser remembers
  its exact Git baseline. A complete traced ZIP carries cards, printings, and
  non-card pieces when the work moves between devices or involves many tables.
- **Affinity / Illustrator / Inkscape:** use the SVG family bridge for the
  declared portable geometry subset, or preserve the native file as a source
  asset when full fidelity matters.
- **Inkscape + PnPInk / nanDECK:** use their family-specific working copies.
- **Automation or migration:** use the complete Forge design project.

### 2. Review before writing

Every returned working copy is anchored to the Git ref from which it was
exported. Forge performs a three-way comparison against the current game,
reports concurrent conflicts, validates the complete project, and shows both
semantic fields and rendered-card impact. Nothing is written during dry run.
Forge Studio submits card rows and the shared visual family as one candidate,
so a coordinated data-and-layout edit becomes one review rather than two
unrelated saves.

### 3. Commit or propose

A maintainer creates one commit. A contributor without write access receives
an independent fork, an attributed commit, and a pull request. The same visual
and semantic evidence is available to reviewers.

### 4. Release the exact version

Print sheets, individual faces, rulebooks, and tabletop packages are immutable
artifacts keyed by the committed source ref and exporter version.

## Canonical asset model

| Asset | Editable truth | External bridge | Review evidence |
| --- | --- | --- | --- |
| Card content | `components/cards.json` | CSV, Sheets, editor datasets | semantic field diff + faces |
| Printings | `components/printings.json` | CSV, Sheets | quantity/art/set diff + faces |
| Card templates | `templates/production.json` and family sources | Forge Studio, SVG, PnPInk, nanDECK | changed regions + affected families |
| Art, icons, fonts | `assets/` plus rights manifest | native files, portable images/SVG | bytes, previews, provenance, rights |
| Rules | Markdown plus publication manifests | text editors, layout source packages | prose diff + page proof |
| Pieces | component registry plus kind-specific source | CSV and visual family templates | semantic diff + cut-sheet/table proof |
| Setup | `setups/` | tabletop adapters | zones, stacks, quantities, placements |

Cards are the first complete vertical slice. Tokens, tiles, boards, dials,
standees, dice, trackers, and player aids should reuse the same stable-ID,
layout-family, source-package, dry-run, commit, and release model rather than
becoming a second special-case editor.

## Acceptance gate

The milestone is ready for creator testing only when all of these are true:

- a new creator can identify the first action without documentation;
- a Forge Studio edit is visibly local until review and commit;
- a shared family can be proofed against every matching card;
- the data working copy survives a Dextrous or Component Studio CSV edit;
- returned work produces a three-way dry run and cannot silently overwrite a
  concurrent Forge edit;
- a non-maintainer can create the same change as a credited fork and PR;
- print and virtual-tabletop output records the exact source ref;
- the 320 px and 390 px workflows have no horizontal overflow and keep 44 px
  touch targets;
- unsupported native-editor features are named rather than silently dropped;
- rights and redistribution status block release when unknown.

## Editor convergence roadmap

Forge should close the beginner-facing gap without copying another product's
internal format or giving up its stronger collaboration model.

### Now implemented

- an empty idea can become its first real card system without YAML: the wizard
  reviews and atomically commits permanent card IDs, typed fields, a reusable
  front, a shared back, trim, bleed, quantities, and a versioned A4/Letter
  print profile;
- one component workspace for per-card content, physical printings, artwork,
  and shared family layout;
- a deck-scale table with read-only permanent IDs, direct typed field editing,
  explicit multi-row selection, atomic Sheets-style matrix paste, fill-down,
  vertical keyboard navigation, card creation, duplicate/remove actions, and
  production-printing duplication; ordinary multiline rules paste remains one
  cell unless the designer explicitly selects multiple rows;
- a versioned art-library picker with portable searchable tags, explicit
  multi-printing target sets, staged rights-aware uploads, artist credit, and
  non-destructive per-printing fit, focal point, and zoom controls; metadata
  merges independently by asset path and conflicts fail closed; the same
  library and rights form can bind one shared artwork surface to every card
  back without exposing repository paths or YAML;
- a portable rules-text toolbar for bold, italic, paragraph breaks, and
  game-declared inline symbols; the stored source remains plain text that
  survives JSON, CSV, Sheets, external adapters, and Git review;
- live face preflight for undeclared symbols, browser-measured text overflow,
  estimated family-wide fit, minimum readable type, and static-color contrast;
- exact live rendering while a card value changes;
- drag, eight-handle resize, 0.5 mm snap, keyboard nudge/resize, undo, layers,
  shift multi-select, persistent named groups, group movement,
  align/distribute/equal-size controls, structured border and shadow controls,
  reusable named typography with layer/family/card blast-radius counts and
  appearance-preserving detach, family proofing, and before/draft comparison;
  named groups, effects, and text-style relationships survive Git, exact print
  rendering, and the bounded SVG working-copy adapter; named styles flatten
  explicitly for nanDECK;
- one three-way dry run and one validated commit or credited fork + pull request
  for the combined card and layout candidate;
- direct CSV plus traced ZIP handoff for Dextrous, Component Studio, and Sheets,
  and bounded SVG, PnPInk, and nanDECK working copies for visual tools.
- a visual, versioned print planner for exact stable-card selection, physical
  quantities, fronts-only or mirrored-duplex home sheets, 0–10 mm gutters,
  grid/corner/no crop marks, Japanese opaque-sleeve inserts, shared-back press
  inclusion, and sRGB one-face-per-page press candidates;
- deterministic print builds that reopen their own PDFs and record page counts,
  TrimBox/BleedBox, font resources, embedded PDF-owned text fonts, 100% K
  vector notices/crop marks, raster resolution/color mode, exact source ref,
  and explicit color/output-standard boundaries in `preflight.json`;
- a profile-driven CMYK/PDF-X-1a candidate path that versions a rights-tracked
  printer ICC, output condition, rendering intent, and ink limit; converts and
  measures every face; embeds the exact profile once; and structurally checks
  the completed PDF without claiming independent certification;
- an optional generic spot finishing path whose exact name, alternate CMYK,
  stroke, offset, and page sides are versioned; it follows committed component
  trim/radius geometry and is structurally verified as a full-tint Separation
  stroke with overprint enabled;
- append-only printer delivery receipts that bind a named printer/job and one
  approved/rejected decision to a frozen release artifact's exact SHA-256 and
  byte count. Private evidence can be hashed locally, and every receipt states
  that the record is creator-attested rather than independently verified.
- a versioned, source-cited The Game Crafter Poker target that validates trim,
  emits exact 825 × 1125 pixel RGB PNG fronts/back, hashes every delivered
  file, and labels the result as a checked handoff rather than native publishing.
- a visual saved-build editor that separates gameplay card identities from
  exact physical printings, continuously previews format legality without
  writing, commits legal or explicitly marked work-in-progress builds, rejects
  stale revisions and accidental stable-ID overwrites, and carries one build's
  exact face quantities into the print planner and frozen output.

### P0 before a beginner-design pilot

The planned beginner-facing card-editor capabilities are implemented. The
remaining P0 work is validation with unfamiliar creators: measure whether they
can start a project, create or edit a reusable style, review its blast radius,
and produce an exact-version print artifact without coaching. Treat failures
from those sessions as product blockers rather than adding speculative controls.

### P1 production parity

- independently issued or authenticated PDF/X validation receipts,
  manufacturer-supplied dieline templates, broader overprint controls, and
  additional named manufacturer targets;
  Forge now has a source-cited, machine-checked TGC Poker handoff plus a real
  project-supplied ICC conversion path, but does not claim structural preflight
  is third-party certification or that a file handoff is native publishing;
- flow/auto-fit layout and press-profile-specific overflow/accessibility
  thresholds; shared backs are now editable, proofed, versioned, reviewed, and
  rendered through the same canonical region engine as fronts;
- verified Tabletop Simulator and Tabletop Playground publishing receipts for
  cards, tokens, dice, boards, snap points, and setup—not merely downloads;
- the same approachable content-plus-layout shell for rules, tokens, tiles,
  boards, dials, counters, standees, and player aids. The component studio now
  covers those flat printable pieces; richer rulebook pagination and assembled
  3D/manufacturing-specific editors remain separate work.

The sequencing is intentional: the P0 items make Forge usable by a first-time
designer; the P1 items make its outputs trustworthy in professional production.

## Explicit non-goals for this milestone

- parsing or merging proprietary Affinity, Adobe, or Dextrous project internals;
- promising color-managed press output without a declared printer profile;
- treating a PDF or rendered PNG as editable canonical source;
- automatic two-way synchronization that bypasses review and authorship;
- a single universal visual schema that erases component-specific behavior.

## Implemented component slice

The first component vertical slice now includes stable piece rows, reusable
circle/rectangle/hexagon families, live Forge editing, traced CSV handoff,
before/after review, an atomic validated commit, individual editable SVG faces,
and quantity-aware A4/Letter cut sheets frozen at an exact Git ref. A separate
family-template SVG bridge now carries named layout regions to Inkscape,
Affinity Designer, Illustrator, or another standards-based editor and returns
geometry plus flat family colors through a field-level dry run. It rejects
active content, external links, arbitrary object mapping, rotation, skew, and
silent region deletion while preserving canonical bindings, typography,
symbols, artwork, size, and production settings. The same registry already
accepts tiles, dials, boards, standees, dice, counters, and player aids without
turning them into fake cards. Two-sided pieces are now one versioned row with
an optional reverse face: Forge reviews front and back together, validates
same-size family pairing, emits paired face SVGs, and mirrors the back placement
onto a same-numbered long-edge duplex sheet. Missing reverse artwork and symbol
references fail or warn through the same validation path as the front.
Per-player quantities are now resolved by a player count selected in Piece
Studio and committed inside the production design. The exact-ref export records
both the declared quantity and the resolved manufacturing quantity, preventing
an untracked export-time choice from producing two different artifacts for the
same commit. Existing projects without that setting still export their declared
counts and are explicitly marked unresolved in the manifest.
Large boards and other over-page pieces now leave the same renderer as labelled
poster tiles. Their overlap is a versioned production setting, every page
records its row, column, and exact source offset, and assembly crosses survive
into the frozen kit. This is a home-print assembly surface, not a claim of
manufacturer dieline or press-PDF support.
Existing playable setup documents now accept non-card component placements.
Piece Studio can stage and position a selected piece on the first setup, then
validate and commit the setup file with its inventory and shared family design.
Exact-ref production kits include one top-down SVG setup map per setup and keep
the component IDs, quantity, face, rotation, and coordinates in the manifest.
This deliberately remains an authoring/release map for the open-source
VirtualTabletop adapter. The Tabletop Simulator adapter now consumes the same
setup, stages its card stacks and non-card component placements, lays out the
remaining resolved inventory, and emits exact-ref texture and placement
receipts. Custom-art dice remain fail-closed until a validated TTS atlas and
rotation map are supplied.
Component face artwork now has an in-studio upload path rather than a raw path
field alone. The server validates the media, assigns it to the chosen front or
back face, and records creator/license/source/redistribution rights in the same
commit. Exact-ref component manifests include the source artwork hash and the
resolved rights rule for every declared component-art dependency.
Piece creation now starts with a guided physical-component picker. Token,
counter, tile, dial-face, board, standee, and player-aid presets choose a
matching reusable family plus editable starter dimensions without writing a
commit. Kind-specific guidance keeps the boundary visible: dial and standee
outputs are printed faces rather than assembled hardware, large boards use
poster tiling, and all final dimensions still require a manufacturer check or a
100%-scale print proof. Game-defined kinds remain valid and editable after the
preset is created.
The inspector also exposes a family's edit blast radius. If a style is shared,
it names the affected pieces and can clone the selected piece into an
independent, stable family before any appearance change. Explicit family IDs
now resolve before kind fallbacks in browser and production renderers, so the
family selected in the UI is the family committed, reviewed, and exported.
Manufacturing settings no longer require hand-editing the design JSON. Piece
Studio exposes paper size, bleed, safe inset, page margin, piece gap, and poster
overlap as one versioned sheet setup. Its green safe-area overlay is a local
preview guide—not printed artwork—while validation identifies text or symbols
outside the declared inset. Cut-sheet and poster packing continue to use the
committed settings recorded in the exact-version manifest.
Counters and dials now expose their production data directly in the inspector.
Counter starting values render on the face; a dial's start, maximum, and step
generate the same labelled scale and center-hole guide in the browser proof and
frozen SVG output. Invalid or overly dense dial ranges fail validation instead
of producing ambiguous hardware artwork. Forge caps this surface at 36 printed
positions and still does not manufacture the pointer, spindle, rivet, or cover.
The component review gate now proves the whole manufacturing impact, not only
one selected face. It submits the local inventory, family design, production
settings, and setup placement to a read-only candidate workspace; the normal
validator and canonical component renderer produce the first front, mirrored
back, and poster-tile sheets plus exact page and quantity totals. Git HEAD and
the working tree remain unchanged. Commit stays disabled until that proof
succeeds, so review and release packing cannot silently use different browser
math. The reviewed base ref is checked again at commit time; if another editor
has advanced the component source, Forge rejects the stale draft without
overwriting their work.

Card Studio now treats a card and its physical appearances as one authoring
surface. Designers can add or duplicate a card without losing its stable
identity contract; Forge creates or clones the corresponding set printing and
removes composed source-face scans that cannot truthfully represent a new card.
The content panel exposes set, quantity, collector number, artist, flavor, and
variant data. Raw artwork can be selected from the repository or staged from a
local PNG, JPEG, WebP, or safe SVG with creator, license, source, rights status,
and redistribution terms. Fit, focal X/Y, and zoom are stored in
`printing.art_crop`, leaving original pixels untouched. The dry run validates
card rows, printings, asset bytes, the rights manifest, and family geometry in
one materialized candidate; the commit or contributor fork/PR then contains
that exact group of files. External table adapters preserve the crop object as
JSON instead of silently flattening it.

Card print production now has a repository-owned `templates/print.yaml` rather
than a collection of export-time switches. New card systems commit the default
profile beside their cards, layout, shared back, and printings. Existing games
receive the same backwards-compatible profile until a maintainer reviews and
commits it. The visual planner resolves a stable card ID to all its physical
printings and quantities, dry-runs the complete project without writing, then
commits the exact selection, fronts/backs behavior, gutter, crop marks, sleeve
fit, and RGB or profile-driven CMYK press settings against the reviewed base ref. The print exporter
consumes that file and emits the profile plus a machine-readable preflight
receipt inside the frozen kit. It reopens generated PDFs to verify their
structure and boxes rather than trusting the generation call alone. A
contributor without write access uses that same review to commit the profile to
an attributed edition and open a source-file pull request.

Still deliberately next: independently issued/authenticated prepress evidence,
additional source-cited manufacturing targets, and manufacturer-supplied
non-rectangular dieline templates. Forge now records a maintainer's exact-byte
printer handoff and immutable approval/rejection evidence, but does not claim to
authenticate the named printer.
