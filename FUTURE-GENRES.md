# Future Genres — Board Games & Wargames Without Breaking Changes
*Research-backed (July 2026): primary-source reads of TTS save format, VASSAL
Reference Manual, 18xx.games map data, BSData catalogue schema, Tabletop
Playground templates, HexJSON. Full citations at bottom.*

## The verdict

Every data concept board games and wargames need falls into exactly three buckets,
and **none require breaking the v0.1 format**:

### Bucket 1 — Already fits (rows + typed attributes; ship today)
The industry converged on our exact model. BSData's ProfileType→Characteristics
IS our `attribute_definitions`→`attributes` (a 40k unit statline = a component row).
TTS unifies every object as *kind + instance + properties* — our token `kind` enum
maps 1:1. Proven fits, no schema change:
- **Wargame unit counters** (attack/defense/movement = typed attributes; BSData proves at 169-repo scale)
- **Points/cost systems** (BSData CostTypes = attributes; our legality checker already enforces budgets)
- **OOB hierarchy** → optional `parent` on tokens (ADDED v0.1, additive)
- **Custom dice** → optional `faces[]` on `kind: die` tokens (ADDED v0.1, additive)
- Tile manifests w/ counts, companies/trains (18xx), categories/tags, prototypes
  (= our per-game types), publication refs

### Bucket 2 — Structured documents (new sibling schemas, v0.2/v0.3 — reserved paths)
Additive files beside components; nothing existing changes:
- **`boards/*.json`** — grid (`hex-odd-r|hex-axial|square|graph|none` — HexJSON/Red Blob
  vocabulary), per-cell features as keyed rows with attributes (18xx proves even
  economic maps reduce to this), zones (VASSAL), slots/snap-points (TTS/TTPG), tracks
- **`scenarios/*.yaml`** — setup as data: map ref + placements
  `(component, count, location, state)` + reinforcement schedules + variable-setup
  options (VASSAL At-Start Stacks / Predefined Setups shape)
- **`tables/*.json`** — CRTs, terrain-effects charts, reference tables as
  `row-dim × col-dim → cell` grids + dice spec. **No open standard exists anywhere**
  (Cyberboard is closed binary; VASSAL ships images) — this schema would be a
  first, and wargame communities' strongest adoption hook
- Component-instance extensions: containment (bags/decks holding pieces),
  multi-state (step-loss flips = VASSAL Layers, TTS States)

### Bucket 3 — Code-like (permanently out of scope; text is the format's answer)
VASSAL trait expressions, BGA state machines, TTS Lua, BSData modifier logic.
Rules stay prose (`rules.md`) + structured *data* the engines can consume; we
never ship a rules language (the graveyard of universal formats — see GDL/CGDL).

## Why no lock-in exists (the structural argument)

1. `attributes` was never card-specific — nothing in cards.json knows what "cost"
   means. A counter's defense factor and a train's revenue are the same shape.
2. `game.yaml attribute_definitions` makes each GAME define its own columns —
   BSData independently evolved the identical design for wargames.
3. tokens.json already carries kinds (board/tile/die/meeple/standee) with size_mm.
4. Sets/formats/restrictions/rulings/playtests/community are genre-blind (a
   scenario book is a set; a tournament OOB restriction is a banlist).
5. New genres arrive as NEW FILES (Bucket 2), never edits to existing schemas —
   the SPEC's minor-version rule ("additive, old repos stay valid") covers all of it.

## Sequencing (unchanged by this research — it de-risks, not accelerates)
Cards remain the wedge (locked D1). Bucket-1 additions ship now because they're
free and additive. Bucket-2 schemas are built **when a real community asks** —
BSData importer first (their data maps cleanly: profiles→attributes,
catalogues→sets, rosters→decks), boards/tables schemas alongside the first
wargame/18xx pilot community. Show a BSData contributor the demo at Gate 1
(already in the validation plan).

## Sources
[TTS save format](https://kb.tabletopsimulator.com/custom-content/save-file-format/) ·
[VASSAL Concepts](https://vassalengine.org/doc/latest/ReferenceManual/Concepts.html) ·
[18xx map data](https://github.com/tobymao/18xx) ·
[BSData structure](https://github.com/BSData/catalogue-development/wiki/Data-structure-overview) ·
[TTPG schemas](https://github.com/plasticity-studios/tabletop-playground-schemas) ·
[HexJSON](https://open-innovations.org/projects/hexmaps/hexjson) ·
[BGA material/states](http://en.boardgamearena.com/doc/Game_material_description:_material.inc.php)

## Rulebooks & InDesign

The book engine (`rulebookHtml`/`rbCompile` in `tools/hub_template.html`, plus
Paged.js pagination for print) renders `rules.md` directly to a formatted
booklet on-screen and on paper. That's the whole rendering story, and it stays
that way — IDML doesn't change it, it only bridges the edges:

- **Import IDML content, never render it.** A future `import-idml.mjs`
  (symmetric with the existing `import-nrdb.mjs` / `import-tts.mjs`) would
  read an `.idml` package's `Stories/*.xml` for TEXT and enough structure
  (paragraph styles as a heading-level hint) to write a `rules.md` — a
  one-time migration for a studio bringing an existing InDesign rulebook
  *into* the format. It would never parse or reproduce IDML's spread/frame
  layout XML; that's real page layout, the same Bucket 3 ("code-like,
  permanently out of scope") logic as rules engines above, for the same
  reason — a deep, ongoing maintenance burden for a feature `rules.md` +
  the book engine already cover for every game in this repo.
- **Export structured content, not a fake layout.** The reverse direction is
  one-way for the same reason: a `rules.md` → IDML/ICML export would hand a
  layout artist plain structured content — headings, paragraphs, lists, the
  `::: example` / `::: sidebar` / image blocks above as tagged text — to
  place with their own house style, not a facsimile of InDesign's own
  layout engine.
- **No Adobe runtime, ever.** Nothing in this repo executes, embeds, or
  shells out to InDesign, the Adobe SDK, ExtendScript, or any Creative Cloud
  service. IDML/ICML are plain XML-in-zip interchange formats Adobe
  publishes openly; reading/writing them is a data transform like any other
  importer/exporter in `tools/`, not an integration with Adobe's product.

`rules.md` stays the one diffable, engine-rendered source for every
screen/print rulebook this platform produces itself. InDesign is a
content-bridge partner at the edges, never a dependency.

