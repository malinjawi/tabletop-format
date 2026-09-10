# Card formatting pipelines: how card data actually becomes a print-ready card

**Question:** how does a spreadsheet/CSV of card rows actually become ready-to-publish,
print-ready card art in the real world — the true mechanism and UX, not the marketing
description — across every serious tool the industry and the hobby actually use?

**Why this document exists:** this platform currently makes designers hand-write layout
coordinates directly in `templates/layout.yaml` — e.g. Arcmage's title region is
`{ id: title, type: text, src: "card.name", x: 4.5, y: 3.0, w: 42, h: 7.5, font: title,
size_pt: 10, align: left, valign: middle, color: "#ffffff", bg: "#00000066" }`
(`examples/arcmage/templates/layout.yaml`). A designer authors a layout by typing numbers
into a YAML file, saving, rebuilding the hub, and looking at the result — an edit/rebuild/
inspect loop, not a drag-a-box-and-see-it-move loop. We suspected this is not how the rest
of the world does it. This document is the evidence.

**Method:** four parallel research passes (professional DTP tools; hobbyist/scripting
tools; modern web/SaaS spreadsheet-driven tools; code/SVG/print-ground-truth), each using
only web search and direct page fetches — real vendor docs, package READMEs, source code,
and forum/GitHub-issue threads, not marketing copy. Every claim below carries a source URL.
Where a claim could not be independently verified by direct fetch (a recurring, specific
limitation of this session's fetch tool against JS-heavy megamenu pages — Adobe's own
help pages returned only site navigation shells, not article bodies, the same failure mode
already recorded in `docs/layout-engine.md`'s "What this session's tools could (and
couldn't) do"), that is flagged inline rather than silently presented as confirmed.

---

## TL;DR

- **Every serious tool splits "the shape of one card" (template) from "the content of many
  cards" (spreadsheet)**, and binds them by **field name** — `<<fieldname>>`, `[colname]`,
  `{{row.name}}`, `%VAR_name%`, a layer literally named `#card_name` — never by an author
  typing raw x/y coordinates as the primary act of template creation.
- **In every tool designers actually reach for by choice** (InDesign, Affinity, Canva,
  Figma, Dextrous, Component Studio, nanDECK's Visual Editor, Scribus's base canvas), the
  geometry is the **byproduct of dragging a box on a visible canvas**, not a hand-typed
  number. The x/y/w/h numbers still exist in every underlying file format — but nobody
  authors them by typing digits and reloading to check.
- **Our `layout.yaml` already has the right half** (named dot-path binding: `src:
  "card.name"`) **and the wrong half** (hand-typed `x`/`y`/`w`/`h`, with no visual authoring
  surface at all) — which places our layout-*authoring* UX at the bottom of the popularity-
  correlated spectrum below, next to Squib/LaTeX/raw-Pillow-script territory, despite this
  project's own stated goal that designers should feel met "in their tools," not forced into
  a text editor (`NORTH-STAR.md`, adoption doctrine).
- **The fix is not to abandon the YAML file** — plain-text, diffable, schema-validated
  storage is a genuine, uncommon strength this platform already has over InDesign's opaque
  `.indd`, Component Studio's hosted-only projects, or Figma's proprietary format, and it is
  exactly what makes `git`-based PR review of a card layout possible at all. The fix is to
  put a **visual, two-way-bound box editor on top of the same file** — precisely nanDECK's
  own solution (its Visual Editor reads/writes the identical script text via a
  `VISUAL...ENDVISUAL` block), proven over two decades in exactly this niche.

---

## Part 1 — Professional desktop publishing ("data merge")

### 1.1 Adobe InDesign Data Merge — the professional standard

**(a) The template.** An ordinary `.indd` document, built visually with the standard Type
tool, Rectangle Frame tool, Layers panel, and paragraph/character styles — there is no
separate "template" file format. A real card-game walkthrough starts by creating "a new
document named **Cards** that's the same size as the Illustrator file... **2.75in x
3.75in**" before touching Data Merge at all.
Source: [We Heart Games](https://weheart.games/datamerge/); [Pagination.com](https://pagination.com/tutorials/data-merge-indesign/).

**(b) Binding syntax — confirmed verbatim from two independent, directly-fetched
tutorials** (Adobe's own help page for this exact feature returned only a site-navigation
shell to this session's fetch tool, not the article body — the same known limitation
already documented in this repo's `docs/layout-engine.md`; the syntax below is standard,
well-known InDesign behavior and is independently corroborated twice, not a single-source
claim):

```
<<fieldname>>
```

Text placeholders are inserted by **clicking or dragging a field name from the Data Merge
panel** into a text frame — never hand-typed character by character. Images use a distinct
convention: **prefix the CSV column header with `@`** (e.g. `@Artwork`), which makes Data
Merge treat every value in that column as an image file path instead of literal text,
shown with a picture icon instead of a text icon in the panel:

> "To make a column into an image reference, you must add the @ character before the name
> of the column." — real card CSV header row: `Card Name, @Card Background, @Artwork,
> @Cost, Cost Stat, @Attack, Attack Stat, @Defence, Defence Stat, Card Type, Description`

Source: [We Heart Games](https://weheart.games/datamerge/); independently confirmed by
[Pagination.com](https://pagination.com/tutorials/data-merge-indesign/) ("It is important
to define image fields with the @ symbol prefix (e.g. @Image). The @ symbol is a special
character in Excel — add an apostrophe before it if it errors, e.g. `'@Image`").

**(c) Who makes it.** A designer, entirely visually — the card-game tutorial never opens a
script panel. (Adobe separately exposes the same merge engine as a headless cloud REST API,
`indesign.adobe.io/v3/merge-data`, for developers automating merges outside the GUI — an
optional layer, not required for normal use. [Adobe Developer](https://developer.adobe.com/firefly-services/docs/indesign-apis/guides/working-with-datamerge-api/).)

**(d) Step-by-step flow.**
1. Prepare a `.csv`/`.txt` (header row = field names, `@`-prefixed for images; will not
   accept `.xlsx` directly).
2. `Window > Utilities > Data Merge` → flyout menu → **Select Data Source…**.
3. Insert `<<field>>` text placeholders and link `@`-fields to empty graphic frames.
4. **Preview** in the panel — swaps in one record's real data live, in place, without
   generating a new document.
5. Flyout → **Create Merged Document**: choose Single Record vs. **Multiple Records** (a
   grid of many cards per page — Rows First/Columns First fill order, Between
   Columns/Between Rows spacing), plus image-fit and missing-image-report options.
6. This produces a **brand-new, separate `.indd` document**, one record per page (or grid
   cell) — Data Merge never outputs a PDF directly.
7. Export that new document: `File > Export > Adobe PDF (Print)`, configuring the **Marks
   and Bleeds** pane (crop marks, bleed) and **Output** pane (CMYK conversion, PDF/X-1a or
   PDF/X-4 preset).

Editing the source spreadsheet afterward is **not live** — re-export the CSV, **Update Data
Source**, and re-run Create Merged Document; already-generated output is a static snapshot.
Source: [We Heart Games](https://weheart.games/datamerge/); [Pagination.com](https://pagination.com/tutorials/data-merge-indesign/); [Adobe, printer's marks](https://helpx.adobe.com/indesign/using/printers-marks-bleeds.html).

**(e) Output.** Always generate-then-export, never a direct PDF. Multiple Records yields an
imposed grid of cards per page. Notably, nothing in the native feature auto-inserts crop
marks *between* individual cards on a shared page (only page-level marks) — significant
enough that the We Heart Games tutorial author, despite using Data Merge for everything
else, hand-built a **separate imposition document** with its own crop-mark layer, manually
re-placing each merged card, rather than trust the native grid as the cutter-ready artifact.

**(f) Real friction.** A **years-persistent Preview-corruption bug**, reported independently
seven years apart: 2018 — *"Once you have previewed a multiple item per page merge, it is
often permanently corrupted. The only fix is to copy your template to a new document and
create the merge without previewing"* ([Adobe Community](https://community.adobe.com/questions-671/data-merge-multiple-records-nightmare-pls-help-830671)).
2025 — *"Datamerge has a history of being buggie, particularly the preview function"*
([Adobe Community](https://community.adobe.com/t5/indesign-discussions/indesign-data-merge-is-driving-me-insane/td-p/15151633)).
Other well-corroborated complaints: **overset text** (one record = one frame, no auto-
resize — a 17-year-old commercial plugin, TextStitch, exists purely to work around this;
[Rorohiko](https://rorohiko.com/wordpress/2024/11/19/indesign-data-merge-and-textstitch-an-unexpected-partnership/));
**crashes on image-heavy merges** ([Adobe Community, open since 2022](https://community.adobe.com/t5/indesign-discussions/data-merge-images-crashing-indesign-on-preview-or-create-merged-document/m-p/12930728/highlight/true));
**severe slowdown on larger datasets** ([Adobe Community](https://community.adobe.com/questions-671/data-merge-is-really-slow-833142)).
Tellingly, a BoardGameGeek thread titled "Card Game Data Merge (Multiple Cards on Same
Page)" gets answered with *"Use CardMaker instead. Free open-source program that does
exactly what you're looking for"* — real evidence that card designers specifically route
around Data Merge's grid friction. [BoardGameGeek](https://boardgamegeek.com/thread/1692437/card-game-data-merge-multiple-cards-on-same-page).

### 1.2 Photoshop Variables & Data Sets

**(a)** A `.psd` with content on named layers (not the Background layer).
**(b)** `Image > Variables > Define` per layer: **Visibility**, **Pixel Replacement**
(image swap, with Fit/Fill/As Is/Conform), or **Text Replacement**. A Data Set
(`Image > Variables > Data Sets`) imports a delimited file whose header row must exactly
match variable names:
```
Variable 1, Variable 2, Variable 3
true, TULIP, c:\My Documents\tulip.jpg
false, SUNFLOWER, c:\My Documents\sunflower.jpg
```
**(c)** A designer, visually — layer names and dialogs, no code for core use.
**(d)** Define variables → import Data Sets → preview via `Image > Apply Data Set` →
`File > Export > Data Sets As Files`.
**(e) Output is PSD/TIFF/PSB only** — "The output generated will be in the form of PSD
files," because layered output requires a layer-capable format; an Adobe Community
"Legend" explains plainly: *"JPEG, PNG, etc do not support layers."* Not a flattened
raster, not a print-ready PDF — this is a web-banner/product-shot feature, not a prepress
one. Source: [Adobe](https://helpx.adobe.com/photoshop/using/creating-data-driven-graphics.html); [Adobe Community feature request](https://community.adobe.com/feature-requests-713/variables-export-data-sets-as-files-655443).
**(f)** Not deprecated — still documented and discussed in 2024–2025 threads — but the
export-format limitation is a live, unresolved 1941-view feature request (opened Apr 2024).
The documented modern workaround is classic **ExtendScript automation**: a free community
script, "Data Sets to Files" (updated Sep 2025), exports directly to JPEG/PNG/WebP/TIFF via
`File > Scripts` — i.e. professionals now reach for scripting, not the raw native feature.

### 1.3 Illustrator Variables

**(a)** A `.ai` file with objects individually named to match spreadsheet headers.
**(b) Binding is not typed text — it's a two-part GUI action**: name an object, select it,
then click a type-specific button in the Variables panel: **"Make Text Dynamic,"** **"Make
Visibility Dynamic,"** or **"Make Object Dynamic"** (linked-file/image). Import via
`Window > Variables` → **Load Variable Library** accepts **CSV or XML only** — notably not
tab-delimited `.txt` the way Photoshop is, which is exactly why a popular third-party
script, `VariableImporter.jsx`, exists to convert `.txt`/`.csv` into valid XML first.
Sources: [ai-scripting.docsforadobe.dev](https://ai-scripting.docsforadobe.dev/objectmodel/dynamic/); [prepression.blogspot.com](https://prepression.blogspot.com/2015/03/illustrator-introducing.html).
**(c)** A designer visually for basic binding; scripting commonly enters via batch export.
**(d)** Name objects → Make-Dynamic buttons → import Load Variable Library → preview via
data-set dropdown. **There is no native one-click "export all data sets"** (unlike
InDesign) — the documented professional workaround is recording an **Action**
(`File > Save a Copy…`) then running **Batch…** with Source = "Data Sets." Sources:
[cg.algonquindesign.ca](https://cg.algonquindesign.ca/topics/variable-data.html); [christianda.com](https://www.christianda.com/blog-variable-data.html).
**(e)** Whatever the recorded Action's save step targets (PDF in both sourced tutorials).
**(f)** A 2020 Adobe Community thread titled *"I need a way to print 1000 card with
variables data merge and photos"* gets answered by a Community Expert redirecting the
asker away from Illustrator entirely: *"you might want to consider using InDesign's data
merge."* ([Adobe Community](https://community.adobe.com/t5/illustrator-discussions/i-need-a-way-to-print-1000-card-with-variables-data-merge-and-photos-in-a-practical-and-easy-way/m-p/11541420)).
Multiple long-open UserVoice requests (no live CSV re-link, a broken "Update Data Set"
command, a literal feature request titled **"Data merge like Indesign"**) plus outside
course material calling it *"a little-know[n] feature"* together indicate a neglected,
secondary path relative to InDesign's. [illustrator.uservoice.com](https://illustrator.uservoice.com/forums/333657-illustrator-desktop-feature-requests/suggestions/32308366-data-merge-like-indesign).

### 1.4 Affinity Publisher Data Merge

**(a)** A normal `.afpub` file — "Design to a single spread or grid layout" using ordinary
text/picture frames, then wire fields in. [affinity.help](https://affinity.help/publisher2/en-US.lproj/pages/Advanced/dataMerge.html).
**(b)** Panel-driven token insertion (closer to Word's "Insert Merge Field" than typed
syntax): **Data Merge Manager** connects the source (plain text/CSV/TSV, XLSX, or flat
JSON); the **Fields panel** lists columns, and *"Fields can be inserted at a text insertion
point by double-clicking a field name in the panel."* Image fields work the same way on a
selected picture frame. [affinity.help](https://affinity.help/publisher2/en-US.lproj/pages/Panels/fieldsPanel.html).
**(c)** A designer, visually — *"Add a text object and insert data fields… add supporting
static imagery"* is the documented authoring step.
**(d)** Add source → design the grid layout → insert fields → optional record-range filter
→ **Preview with record** → **Generate**, which — architecturally identical to InDesign —
*"merge[s] the source data and your original publication to **a new Publisher document**"*
before any export/print happens on that new document. [affinity.help](https://affinity.help/publisher2/en-US.lproj/pages/Advanced/dataMerge.html); confirmed independently by [makeadigitalplanner.com](https://makeadigitalplanner.com/affinity-publisher-data-merge/).
**(e)** Full PDF/X-1a, PDF/X-3, PDF/X-4 presets with explicit **Include bleed** / **Include
printers marks** toggles; a dedicated **Data Merge Layout Tool** (Rows, Columns, Gutter,
Record Offset/Advance/Origin) gives true multi-record grid support, confirmed in real
production use for 9-up TTRPG cards. [Plane Sailing Games](https://planesailinggames.com/post/2026-03-23-data-merge-cards/).
**(f)** A professional's direct verdict in trade press: *"Data-merge, a feature I use daily
in InDesign, is available in Publisher but is much 'clunkier.'"* ([National Newspaper
Association, Sep 2024](https://www.nna.org/is-it-finally-time-to-make-the-switch-from-adobe-indesign-to-affinity-publisher)).
Documented issues: a CSV UTF-8 encoding bug (mirroring an almost identical long-running
InDesign bug); **the Layout Tool only accepts one gutter value for both axes**, breaking
standard Avery label layouts and forcing a manual guide-based workaround ([Elaine Giles,
hands-on](https://elainegiles.co.uk/affinity-publisher-data-merge-hack-unequal-gutters-in-a-data-merge-layout/));
and no scripting/automation hook comparable to InDesign's `DataMerge` object until v3.2
(Apr 2026). Context: Data Merge only arrived in Publisher 1.9 (Feb 2021) — roughly two
decades after InDesign's — plausibly explaining the maturity gap.

### 1.5 Scribus + ScribusGenerator

**(a)** **Scribus itself has no built-in data merge at all** — confirmed directly by the
community: *"You would have to write a script for it... a table in Scribus is just a bunch
of text frames"* ([forums.scribus.net](https://forums.scribus.net/index.php?topic=988.0)).
The template is **both** a native `.sla` file (genuinely XML: `<?xml version="1.0"
encoding="UTF-8"?><SCRIBUSUTF8NEW Version="1.4.5">…`) **and** a third-party Python engine
that processes it — the de facto community standard is
[ScribusGenerator](https://github.com/berteh/ScribusGenerator).
**(b) Exact syntax, read from source:**
```
%VAR_name%
```
matching a CSV column header, typed as literal text inside a normal text frame; **`%SG_NEXT-RECORD%`**
places multiple records on one page; **`%VAR_COUNT%`** is a row counter. Confirmed live in a
real fetched template: `<ITEXT FONT="%VAR_font%" FONTSIZE="9" FCOLOR="%VAR_color1%"
CH="%VAR_name%"/>`. **Images bind by filename convention**, not text substitution: a
placeholder image is renamed e.g. `%VAR_pic%` and inserted normally via *Insert Image
Frame*; the CSV supplies the real filename (`PFILE="images/%VAR_logo%"`, CSV column `logo`
containing `sun.pdf`). The engine itself is a two-part mechanism: (1) literal regex
substitution directly on the `.sla` XML text, then (2) the real Scribus Scripter Python API
for document lifecycle/export:
```python
import scribus
scribus.openDoc(sla_file)
pdf_exporter = scribus.PDFfile()
pdf_exporter.file = str(pdf_file)
pdf_exporter.save()
scribus.closeDoc()
```
Sources: [ScribusGenerator README](https://raw.githubusercontent.com/berteh/ScribusGenerator/master/README.md); [ScribusGeneratorBackend.py](https://raw.githubusercontent.com/berteh/ScribusGenerator/master/ScribusGeneratorBackend.py).
**(c)** For basic use, a designer never writes code — plain text `%VAR_x%` typed into the
normal canvas, images picked through the ordinary Get Image dialog. But a programmer is
structurally required somewhere in the chain (someone built and maintains the ~500-line
Python engine), and Scribus Team member Greg Pittman states the philosophy directly: *"use
the graphical environment when that is the most efficient way of working, but use scripting
when you are doing repetitive, tedious, or difficult tasks."* [opensource.com](https://opensource.com/life/16/10/python-scripting-scribus).
**(d)** Design `template.sla` visually with `%VAR_x%` placeholders → prepare `data.csv`
matching those names → `Script > Execute Script` → `ScribusGenerator.py` (or the CLI) →
configure source/data/output pattern/format (Scribus or PDF)/one-file-per-row vs. merged →
engine parses+substitutes+advances on `%SG_NEXT-RECORD%` → optional live-Scribus PDF export.
**(e)** Only two output modes: **one `.sla`/`.pdf` per CSV row**, or an opt-in **"Merge in
Single File"** stacking records into one combined multi-page document. **Bleed and print
marks are entirely manual** — the export code only ever sets `.info`/`.file`/`.pages` on
the `PDFfile()` object, never bleed/marks settings; those come from whatever the designer
already configured in the source document's own Document Setup.
**(f)** Requires programming literacy exactly when things break — *"my skills with
programing languages are pretty much limited, I have no idea what the report is trying to
say"* ([GitHub issue #54](https://github.com/berteh/ScribusGenerator/issues/54)). Fragile
across Scribus versions (the same issue shows 1.4.6 working but 1.5.1 crashing; the
`NEXT-RECORD` token itself was renamed for a v1.5.3 GUI change). *"Over and over, I've heard
complains about the Scripter documentation"* ([forums.scribus.net](https://forums.scribus.net/index.php?topic=3771.0)).
A years-old, still-unfixed limitation: *"works very well for up to four pages and only if
the layout is set to 4-across. It does not work if the layout is stacked. This problem has
been documented in ScribusGenerator since 2016 but a fix is not available"* ([mailing
list, Sep 2020](https://www.mail-archive.com/scribus@lists.scribus.net/msg53620.html)).

**What's common across 1.1–1.5:** the template is always a normal, visually-authored native
document, never a plain-text file a designer hand-writes by choice. Binding is either typed
placeholders dropped into real text frames via click/drag (InDesign, Scribus) or pure
GUI object-linking with no typed syntax (Photoshop, Illustrator, Affinity). Image binding is
the universal special case — every tool bolts on a more fragile, distinct mechanism for
images than for text, and image handling is consistently the most-complained-about part.
**None of the five merges "live" through to output** — every one requires an explicit
generate/batch step producing new document(s) before export; editing the source spreadsheet
never retroactively updates already-generated output. Bleed/marks are uniformly deferred to
the ordinary PDF export dialog, never configured by the merge step itself.


---

## Part 2 — Hobbyist / indie scripting tools

### 2.1 nanDECK

**(a) The template.** A plain-text **script file** (`.txt`, edited in nanDECK's own script
editor pane) written in a line-based "directive" language — `LINK=`, `FONT=`, `TEXT=`,
`IMAGE=`. nanDECK *also* has a true visual/graphical mode (see (c)).

**(b) Binding syntax — real, verbatim, from the official manual.** `LINK = Data.xlsx` (also
`.xls`/`.ods`/CSV/Google Sheets) attaches a spreadsheet where row 1 = column headers.
Any directive's data column is referenced as **`[columnname]`** in square brackets:
```
LINK = Data.xlsx
FONT = Arial, 24, , #000000
TEXT = 1-3, [name], 0, 0, 100%, 20%
IMAGE = 1-3, [img], 0, 20%, 100%, 40%, 0, P
FONT = Arial, 10, , #000000
TEXT = 1-3, [desc], 5%, 65%, 90%, 30%, left, wordwrap
```
Every directive's first parameter is a **range** selecting which cards it applies to
(`1-3`, `"1,3,5,7"`, `10#5`, or blank = all). `LINKMULTI = num` duplicates each card by a
quantity column. Named labels act as reusable variables (`[alldeck]="1-10"`), and
pipe-delimited sequences (`"1|2|3|4"`) cycle a value per card. There's a constrained
expression system (FILTER, CONCAT, EVAL, CASESTRING) but no general-purpose loop/if-else
language. Source: [nanDECK Manual PDF](https://www.nandeck.com/wp-content/uploads/2022/05/nandeck-manual.pdf).

**(c) Who authors it — and the non-coder path.** Real designers report the raw script as
genuinely hard: *"I have looked at NanDeck on several occasions and it always defeats
me... I find the scripting language positively cryptic!"* — and nanDECK's own creator
replied on the same thread, *"I agree that nanDECK can be cryptic, but the basic commands
are really simple,"* offering `IMAGE=1-10,heart.gif,0,0,2,2` as a minimal example.
([BGDF "Card Layout Tools" thread](https://www.bgdf.com/forum/game-creation/prototyping/card-layout-tools)).
To address exactly this, nanDECK ships a **Visual Editor** (F4): drag-and-drop placement of
text/image boxes with resize handles directly on a rendered card, confirmed by a BGG thread
about drag-resize behavior ([boardgamegeek.com/thread/2655991](https://boardgamegeek.com/thread/2655991/elements-in-visual-editor-get-slight-size-change-w)),
plus a right-click **Keyword Wizard** that fills a directive's parameters via a form instead
of hand-typed syntax. **Critically, the Visual Editor is two-way bound to the same script**:
*"When you press the 'Confirm' button, all the objects are inserted in the source, between
VISUAL/ENDVISUAL, so there is a two-way interaction between source and GUI."* This is the
single clearest real-world precedent for "keep a plain-text diffable file, but never make a
human type coordinates into it by hand" — see the recommendation in Part 6.

**(d) Flow.** Build data in Excel/ODS/Sheets/CSV → `LINK=` it (script) or use the Visual
Editor/New-Deck Wizard to place boxes and pick columns from a menu (no typing required) →
add FONT/TEXT/IMAGE/ICON directives → Validate deck → Build deck → iterate card-by-card →
export.

**(e) Output.** Printer, PDF, single PNG/BMP/JPG/GIF/TIFF, multi-page TIFF/animated GIF, a
composite sheet formatted for Tabletop Simulator/Screentop.gg, a **direct write into a TTS
`.json` save** (`Export > TTS > Export decks`, or `/EXPORTTTS` CLI flag), or direct upload
to The Game Crafter. [nandeck.com/features](https://nandeck.com/features).

**(f) Friction.** "Cryptic" scripting syntax (confirmed by the tool's own author, above);
real accounts of total non-coders giving up before discovering the Visual Editor existed
(*"I had no idea how to code anything... I was discouraged and quickly gave up"* —
[streamlinedgaming.com](https://streamlinedgaming.com/make-trading-cards-using-nandeck/));
the Visual Editor itself has rough edges (elements subtly resize on drag, per the BGG
thread above); reused elements across multiple decks are "a bit annoying to manage"
([BGG thread 3440922](https://boardgamegeek.com/thread/3440922/nandeck-project-organization-recommendations)).

> **Implemented:** `tools/export-nandeck.mjs` emits a family-aware, `[colname]`-bound
> `.txt` + CSV set from committed cards, printings, and compiled design families. Every
> script declares `UNIT=MM`, carries a projected and canonical merge baseline, and returns
> through `tools/import-nandeck-layout.mjs` or the Forge Design page. Import is bounded,
> declarative, dry-run first, field-level three-way merged, and validated before commit/PR.
> Forge does not run nanDECK; designers open the generated source in their own installation.

### 2.2 Magic Set Editor (MSE)

**(a) The template.** An **`.mse-style` package** — a directory containing a plain-text
file literally named `style` plus image assets — paired with an `.mse-game` package
defining the card schema. Distributed zipped, or as MSE's own self-installing
`.mse-installer`; internally it is plain text + images, not one monolithic binary.

**(b) Binding.** "MSE script," a small functional/expression language living inside the
`style` file — `:=` assignment, `if/then/else`, dotted field access against MSE's own
in-memory card object (`card.rule_text`, `card_style.name.content_width`). **There is no
CSV/column binding at all** — the "data source" is MSE's own card object, referenced
directly by field name. Real snippet from a genuine, in-use fan template:
```
text_shape := {
if card.rule_text == ""
and card.flavor_text == "<i-flavor></i-flavor>" then "0" # no textbox
else if styling.one_textline_tokens
and card_style.text.content_lines == 2
and card.flavor_text == "<i-flavor></i-flavor>" then "1" # small textbox
else "2" # large textbox
}
```
and computed positioning:
```
name:
  left: { if card_style.name.content_width > 269 then 50
          else card_style.name.content_width * -0.5 + 184.5 }
  top: 23
```
Source: [yeago/magic-set-editor, style file](https://github.com/yeago/magic-set-editor/blob/master/data/magic-new-token-clear.mse-style/style).

**(c) Who authors it.** Predominantly **hand-editing this text/script file** (community
guides recommend Notepad++); a "Style Editor" panel exists for basic click-and-position
tweaks, but conditional logic like the example above must be written as text — MSE's
visual affordances for *building* a template are much thinner than nanDECK's. Fan templates
are authored by remixing an existing style's script/images and sharing the zipped result on
SourceForge's "Magic Set Editor Templates" project or GitHub packs. A non-programmer can
plausibly **re-skin** a template (swap art, tweak numbers); writing a new style with real
conditional logic is programmer-adjacent. *Using* a finished template, by contrast, is
thoroughly non-programmer-friendly.

**(d) Flow.** New Set → pick an installed style → **for each card**, click "New Card," type
directly into the WYSIWYG preview, pick rarity from a dropdown, double-click the art box to
crop. Cards auto-appear in a sortable card-list pane. **There is no built-in CSV/bulk
import** — confirmed by a real designer on BGDF: *"I'm not really wanting to put everything
into MSE... the import tools are horrible."* ([BGDF](https://www.bgdf.com/forum/game-creation/prototyping/card-layout-tools)).
The community built separate tools to compensate (e.g. [mse-importer](https://github.com/IgnacioRV/mse-importer),
reading a plain card-name list). File → Export → Card Image (single) or All Card Images.

**(e) Output.** Per-card or whole-set raster images (`.jpg` by default) — not a native
print-ready multi-card PDF sheet. Also exports to digital-tabletop clients and HTML/XML
spoiler files.

**(f) Friction.** No bulk CSV import (above); output resolution/text rendering below
Photoshop/InDesign quality ([mtg.wiki](https://mtg.wiki/page/Magic_Set_Editor)); anything
beyond swapping images/simple values means hand-editing script text, with community threads
routinely pointing users to manual file edits rather than a GUI control.

### 2.3 Squib

**(a) The template.** A **Ruby script** (`deck.rb`, scaffolded by `squib new
my-cool-game`) — literal general-purpose Ruby code — plus an optional companion
**`layout.yml`** used to pull x/y/w/h and style options out of the Ruby. No GUI, no visual
document at all.

**(b) Binding, real snippet:**
```ruby
require 'squib'
Squib::Deck.new(cards: 2) do
  background color: :white
  data = csv file: 'sample.csv'          # Hash of Arrays, keyed by CSV header
  text str: data['Type'],  x: 250, y: 55, font: 'Arial 18'
  text str: data['Level'], x: 65,  y: 65, font: 'Arial 24'
  save format: :png, prefix: 'sample_csv_'
end
```
and the layout-file alternative:
```yaml
# custom-layout.yml
bleed: { x: 0.25in, y: 0.25in, width: 2.5in, height: 3.5in }
```
```ruby
Squib::Deck.new(layout: 'custom-layout.yml') { rect layout: 'bleed', x: 50 }
```
A `qty` CSV column auto-duplicates a row N times. Sources: [squib.readthedocs.io/dsl/csv](https://squib.readthedocs.io/en/latest/dsl/csv.html), [.../layouts](https://squib.readthedocs.io/en/latest/layouts.html).

**(c) Who uses it — important comparison point.** Squib is explicitly code-first: its own
README states **"Think of it like nanDeck done 'the Ruby way.'"** There is no drag-and-drop
GUI anywhere. **Squib fundamentally uses the same raw x/y/w/h coordinate model our
`layout.yaml` uses — just expressed as Ruby keyword arguments instead of YAML keys.** Its
"low-code" escape hatch is a set of pre-built YAML layout files (`fantasy.yml`,
`economy.yml`, `playing_card.yml`) a non-programmer collaborator could tweak numbers in —
not a visual tool. A non-programmer cannot author a deck from scratch without a programmer
first wiring up `deck.rb`.

**(d) Flow.** `gem install squib` → `squib new my-cool-game` → prepare CSV/XLSX →
`data = Squib.csv file: 'data.csv'` inside `deck.rb` → `text`/`png`/`svg`/`rect` DSL calls
referencing `data['column']` and/or `layout:` keys → `ruby deck.rb` from the command line →
inspect PNGs in `_output/` → `save_pdf`/`save_sheet` for a print-ready sheet.

**(e) Output.** PNG, PDF, SVG — individual files or assembled print sheets, with built-in
bleed/trim support for print-on-demand vendors like The Game Crafter.

**(f) Friction (real GitHub issues).** Native-dependency install pain — [issue #382](https://github.com/andymeneely/squib/issues/382),
an Ubuntu 22.04 crash from the glib2/Nokogiri chain; a dedicated [Windows wiki
page](https://github.com/andymeneely/squib/wiki/Windows) exists because Nokogiri causes
recurring Windows problems; [issue #186](https://github.com/andymeneely/squib/issues/186),
a user couldn't find/understand the `rake` command; [issue #313](https://github.com/andymeneely/squib/issues/313),
the maintainer's own admission that "a deck is many of the same card" breaks down once
cards legitimately differ. Classic *developer-tooling* friction (native gem/OS pain, needing
Ruby fluency), not a "cryptic mini-language" complaint.

### 2.4 cards.py

The real, exact-name project is [jhauberg/cards.py](https://github.com/jhauberg/cards.py)
("Generate Print-and-Play cards for your board games") — **archived/read-only since Nov
30, 2020**, itself a relevant finding.

**(a) The template.** Unusually, **the CSV file is effectively the primary authored
artifact** — no separate visual layout file is required. Card shape/size comes from a
built-in CSS renderer selectable only via a size preset (`--card-size=standard|domino|
jumbo|token`). Optional extras: a custom HTML/CSS "presentation template"
(`--include-header=<template>`) and a "definitions" CSV for reusable text/icon
substitutions.

**(b) Binding.** Column headers become field names; a special **`@count`** column controls
copies. Inside a CSV cell, **`{{ columnname }}`** self-substitutes that row's own value, and
**`{{ columnname #N }}`** cross-references a *different* numbered card. Real example from
the bundled Love Letter deck:
```csv
@count,rank,name,text
5,1,"Guard","Name a non-**{{ name }}** card and choose another player..."
1,7,"Countess","If you have this card and the **{{ name #7 }}** or **{{ name #6 }}**..."
```
Markdown `**bold**` works directly in CSV cell text. [Source](https://raw.githubusercontent.com/jhauberg/cards.py/master/example/love-letter/cards.csv).

**(c) Who authors it.** With no per-field coordinate step for a standard deck, a
non-programmer can plausibly author a whole simple deck by editing only the CSV. Going
beyond the built-in size presets requires editing the tool's HTML/CSS template — ordinary
front-end coding. The README's own design intent: existing tools like nanDECK/Squib "are
more complicated than I think they need to be... you first have to get past the (steep)
learning curve" — this tool deliberately keeps data entry spreadsheet-simple **in exchange
for giving up per-field positioning control entirely.**

**(d) Flow.** `python3 setup.py install` → write `cards.csv` (+ optional `defs.csv`) →
`cards make cards.csv` → outputs a single `index.html` with cards laid out in cuttable
pages → open in **Safari or Chrome only** (officially supported) → browser Print dialog →
"Save as PDF."

**(e) Output.** Static **HTML**, not PDF/PNG natively — the user manually prints to PDF via
the browser. Self-description: *"It's like a static site generator, but for cards!"*

**(f) Friction.** Project archived/unmaintained. Real open issues: [#159](https://github.com/jhauberg/cards.py/issues/159)
a Windows crash; [#157](https://github.com/jhauberg/cards.py/issues/157) Markdown applied
incorrectly; [#156](https://github.com/jhauberg/cards.py/issues/156) "Card backs not
aligned properly for two-sided printing" — filed by the maintainer himself, a core PnP pain
point; print pipeline hard-dependent on the browser's own print engine.

### 2.5 LaTeX/TikZ card decks

**(a) The template.** A `.tex` file with hand-written TikZ drawing macros at absolute
coordinates, usually refactored into `\newcommand` macros collected into an included file.
Dedicated CTAN packages exist for card primitives (`playcards`, `ticket`, `jeuxcartes`).

**(b) Binding, two real CTAN packages.** `csvsimple`
([github.com/T-F-S/csvsimple](https://github.com/T-F-S/csvsimple)):
`\csvreader[options]{file.csv}{col=\macro,...}{body}`. `datatool`'s `\DTLloaddb`/
`\DTLforeach`, used in a real, working, GitHub-hosted card game —
[ramabile/latex-against-humanity](https://github.com/ramabile/latex-against-humanity), a
full playable Cards Against Humanity clone. Verbatim from its main `.tex`:
```latex
\DTLloaddb{Questions}{questions.csv}
\DTLforeach{Questions}{\Flag=QA,\Pic=Picture,\Text=Text}{%
    \card{\Flag}{\Text}{\Pic}%
}
```
with `\card` defined as `\newcommand{\card}[3]{\ifthenelse{#1 = 0}{\Question{#2}{#3}}
{\Answer{#2}}}`, built on the `ticket` package plus `tikz`.

**(c) Who authors it.** Firmly programmer territory — zero visual/WYSIWYG editing surface
in any real example found. The LaTeX Against Humanity README states the labor split
explicitly: *"even a LaTeX total newcomer can [edit the CSV]... [but] you are not intended
to modify the main tex file."* On the widely-cited [tex.stackexchange "Creating playing
cards using TikZ" thread](https://tex.stackexchange.com/questions/47924/creating-playing-cards-using-tikz)
(132 upvotes, reused by at least four other real projects), multiple self-described
beginners got stuck on undocumented compile errors before the template would even build.

**(d) Flow.** Adapt an existing community template → write CSV matching the loop's column
keys → `\csvreader`/`\DTLforeach` iterates, calling the card macro per row → `pdflatex`/
`xelatex` via CLI, TeXstudio, or Overleaf → one multi-page PDF.

**(e) Output.** **PDF, directly from the compiler** — no separate export/print-dialog step.

**(f) Friction.** Classic compile-error opacity: the widely-reused TikZ template required a
chain of community patches over years (duplicated `shadow` key, an invisible copy-pasted
character, a missing `\end{center}`) before newcomers could get a clean build. A
self-identified professional coder frames his LaTeX pipeline as something he did *because*
he's "a coder," and still hit tooling snags (`pdfjam` refusing to output outside its own
working directory). No built-in validate/preview loop — a bad CSV row surfaces only as a
raw compile error or an overflowing box discovered after a full recompile.

**What's common across 2.1–2.5:** underneath any convenience layer, **every one of these
tools is fundamentally coordinate-based (x, y, w, h) at the template level** — even the ones
that try hardest to hide it. nanDECK's Visual Editor still writes literal `x, y, w, h`
directives into its `VISUAL/ENDVISUAL` block; Squib's `layout.yml` is structurally almost
identical to a region object; MSE and LaTeX/TikZ express coordinates as script/macro
arguments. Only cards.py meaningfully escapes this — by *giving up* per-field positioning
control entirely, a genuine trade-off, not a free lunch. All five split into a
**template** (authored by someone comfortable in a text editor or script, regardless of how
"visual" the tool claims to be) and a **data source** a non-programmer can much more
plausibly own day-to-day. Column-to-placeholder binding by name is convergent across every
independently-built tool here (`[colname]`, `{{ colname }}`, `data['colname']`,
`col=\macro`), as is a "quantity" column that duplicates a card N times (`LINKMULTI`, `qty`,
`@count`).

---

## Part 3 — Modern web/SaaS spreadsheet-driven tools

### 3.1 Component Studio (The Game Crafter)

**(a) The template.** Not a file the designer downloads — a hosted visual document
("**Design**") inside a **Game** project on component.studio's servers. Component Studio
explicitly splits a Game into two linked object types: *"Designs are the visual
representation of a set of components... Think of this like an image editor,"* and
*"Datasets are the data representation... Think of these like spreadsheets."*
[help.component.studio/article/560](https://help.component.studio/article/560-game-tabs).

**(b) Binding — literal gesture.** The canvas is a genuine drag/position visual editor
(layers have pixel X/Y/Width/Height fields, boxes have a "Drag to Move" toggle), but binding
a field to a column is **not** a dropdown or a dragged column chip — it's **typing a `{{ }}`
expression directly into the layer's content field**: `{{ row.name }}`, or combined with
icons: `{{row.strength}} <sword/>`. Images: `{{ images.dragon.url }}`, or dynamically per
row: `{{ images['character_' + row.type].url }}`. A discovery aid softens the typing
requirement: clicking the **Design** button in the properties panel shows "a menu of all
available design variables with their current values... click any variable to insert it."
Sources: [.../535-text-layer](https://help.component.studio/article/535-text-layer), [.../521-templating-language](https://help.component.studio/article/521-templating-language), [.../530-design-template-variables](https://help.component.studio/article/530-design-template-variables).

**(c) Who makes it.** A hybrid: primarily a visual designer (canvas layers, gradients,
corner styles — "like an image editor"), but full data binding requires comfort typing
small expressions, including ternaries (`{{ 'red' if alert == 'red' else 'black' }}`) and
conditionals (`{%- if rare -%} RARE {%- endif -%}`).

**(d) Flow.** Build data in Google Sheets (a `name` column and a `quantity` column are
required by name; non-numeric columns set to Plain Text; sheet Public) → Share > Publish to
web > CSV > copy URL → Dataset editor > Import from Google Sheets > paste URL > **"Pull
fresh data"**. Sync is **one-way, pull-based, not live**: *"Google sheets automatically
republishes... but it's on a 5-min rolling timer,"* and the user must manually re-trigger
the pull. [help.component.studio/article/558](https://help.component.studio/article/558-import-google-sheets).
**"Enumerations"** explode one row into many cards — mark a column's values comma-separated
(e.g. `suit`: "Hearts,Diamonds,Clubs,Spades") and Component Studio generates the full
cartesian product (52 cards from 1 row). [.../566-enumeration](https://help.component.studio/article/566-enumeration).
An **"Import Folder of Images"** feature auto-creates one dataset row per uploaded image.

**(e) Output.** One export pass can produce, simultaneously: a **ZIP of individual PNGs**
(Full-Bleed/No-Bleed, optional corner masks); a **Print & Play PDF** (Letter/A4/Legal/
Tabloid/A3, configurable cut lines/margins, "Rotate Backs 180°" for duplex); **direct
upload to The Game Crafter's print-on-demand pipeline** — a genuine order-to-print
integration, not just a file drop; and **Tabletop Simulator** hosted image grids. No DPI
figure is stated — resolution is pixel-based (TTS export up to 8192px).
[.../580-cs2-export-design](https://help.component.studio/article/580-cs2-export-design).

**(f) Friction.** Price vs. the nearest competitor — designer Matthew Denton: Component
Studio "was about twice as expensive ($10/month) as Dextrous ($48/year..., and a free
version)" and chose Dextrous instead ([finbargames.substack.com](https://finbargames.substack.com/p/a-software-update)).
Real learning curve, per Stonemaier Games covering a Kickstarter creator: *"Admittedly,
Component Studio has a learning curve, but the developers provide helpful tutorial videos
and a responsive Discord channel"* ([stonemaiergames.com](https://stonemaiergames.com/creating-hundreds-of-cards-in-component-studio)).
Forced migrations: the whole app was sunset twice on hard deadlines (1.0 → 2.0 → 3.0),
requiring designers to re-export and migrate active projects
([news.thegamecrafter.com](https://news.thegamecrafter.com/post/764694013629677568)). A
historical release needed "**over 40 bug fixes**" in one changelog; current docs still
maintain a dedicated performance-tuning article for large image libraries, implying slow
renders remain live for big decks. No perpetual local fallback: unexported designs are held
only 90 days post-cancellation.

### 3.2 Dextrous

**(a) The template.** A **"Layout"** — *"a visual template that a whole component (i.e. a
deck of cards) is based on"* — hosted in the designer's account. A **"Component" =
layout + data**. [docs.dextrous.com.au](https://docs.dextrous.com.au).

**(b) Binding — literal gesture, implicit name-matching set once at design time.** In the
Layout editor you draw text/image "zones" visually and *"Name your zones in the panel on
the right (they will match the table columns in the component editor)."* Once linked,
Dextrous auto-generates a spreadsheet with one column per zone (color-coded: white = text
zone, purple = image zone, blue = special column like Copies). Image binding: *"Click on the
little image icon in an image cell... click an image to select it."* Google Sheets import
rule, stated explicitly: *"Dextrous will fill out your deck of cards with data from each
column **where the cell in row 1 matches the zone name** in the Component's layout. All
other columns... are ignored."*

**(c) Who makes it.** A visual designer — draw text/image zones, name them, done; no
scripting for basic use.

**(d) Flow.** New Layout > blank > pick size (poker/tarot/hex/token) > draw+name zones →
create a Component attached to that layout → build data in Dextrous's own table (Ctrl+D to
duplicate rows) or via Google Sheets (Publish to web > CSV, per-tab, not Entire Document) →
"link this component to a csv" > paste URL > "Import data!" → "Refresh CSV" to re-pull
later (also a 5-minute one-way sync, not live) → preview → export.

**(e) Output.** CMYK-aware, bleed-aware **print-ready PDF sheets** for both home printing
and commercial POD (dedicated docs for POD/production printers, The Game Crafter, and
Longpack); individual PNG/JPG per card; and a genuine direct Tabletop Simulator
integration — *"Dextrous hosts your deck images so you can just drag your special deck
.json file into your TTS project folder... no uploading of individual images needed."*
[dextrous.com.au/blog](https://dextrous.com.au/blog/dextrous-the-online-card-game-maker).

**(f) Friction — honesty note.** Evidence here is genuinely thin next to the other tools in
this document. The only concretely sourced points: a real designer's pricing comparison is
actually *favorable* to Dextrous (see 3.1); and a structural, sourced limitation — the free
tier caps at "2 projects, 10 item layouts and 100MB of storage" — with no first-person
complaint found about hitting that cap. No substantive negative BGG/Reddit threads about
Dextrous specifically were found; stated plainly rather than padded.

> **This platform's `tools/import-tts.mjs` already imports Dextrous's *output*** — the
> comment reads: *"Simulator, Screentop, and **Dextrous** emit [a save JSON] when you
> export a deck. It's the [format this imports]."* That is a one-way ingestion of a
> **rendered sprite sheet**, not of a Dextrous *Layout* (template + zone bindings) — a
> materially different (and much less useful) thing than importing the template itself.
> See Part 6 for why the template is what's actually worth importing.

### 3.3 Canva Bulk Create

**(a) The template.** An ordinary Canva design — the same object type as any Canva file.

**(b) Binding — literal gesture.** Entirely drag-and-drop, **no typed syntax at all**:
*"Click and hold a data field from the side panel, then drag and drop it onto the design
element you want to connect. You can only connect one data field per element."* An AI
shortcut, **"Auto-match fields,"** analyzes the design and connects fields by best guess.
Images require a placeholder frame/grid element to already exist before a data field can be
dropped onto it. [canva.com/help/bulk-create](https://www.canva.com/help/bulk-create).

**(c) Who makes it.** Purely a visual designer, drag-and-drop — zero code, zero markup. The
most non-technical binding model of every tool in this document.

**(d) Flow.** Prepare data (Canva Sheet, CSV/XLSX upload, or typed directly) → open a
design > "Bulk create" in the side panel → upload/select data (cap: **300 rows × 150
columns**) → ensure one text box/frame already exists per field *before* connecting →
connect fields (drag, Auto-match, or select + "Connect data") → **Preview**, paging through
each row → choose "1 design with multiple pages" vs. "Individual designs" (auto-filed into
a Projects folder) → **Create N designs**.

**(e) Output.** A Canva **design file** (or batch of files) inside the account — **not**
an automatic PNG/PDF. Bulk Create generates editable Canva designs; flattening to PNG/PDF
is a separate, later, manual export step.

**(f) Friction.** Hard documented limits: "**Selections beyond [300 rows × 150 columns]
won't be accepted**"; "**Only one media item per cell is supported**"; image URLs "from
cloud photo storage are not supported and will be treated as plain text" — images must be
uploaded directly. AI mis-mapping is common enough to need its own documented fix path:
*"it can sometimes misinterpret the field names or element types. Manual correction is
occasionally needed."* [canva.com/help/bulk-create](https://www.canva.com/help/bulk-create), [.../bulk-create-data-autofill](https://www.canva.com/help/bulk-create-data-autofill).

### 3.4 Figma + "Google Sheets Sync" plugin

**(a) The template.** An ordinary Figma frame/Component — no special file format. The
bulk-content capability comes entirely from a third-party plugin, most commonly **"Google
Sheets Sync"** by Dave Williams. (Figma's own first-party "Content Reel" plugin is a
different, more generic placeholder-content tool — names/avatars/stock photos — not the
spreadsheet-column mechanism relevant here; worth not conflating the two.)

**(b) Binding — literal gesture.** **Renaming a Figma layer** to embed a `#` tag matching a
spreadsheet column — not a dropdown, not a drag. *"To specify which label to lookup, simply
include a `#` in your Figma's layer name, followed by the Label name."* Matching is fuzzy:
`#First name`, `#first_name`, `Layer #FIRST-NAME` all match a Sheet label "First name." No
`#` = no value applied. [docs.sheetssync.app](https://docs.sheetssync.app/naming-your-figma-layers).
A real card-game example (Ryan Iyengar): a rectangle layer named `#title_color`, a text
layer named `#card_title`, and image-as-variant swaps via a layer named e.g.
`#suit_variant` so the plugin picks the matching Component Variant rather than pasting a
raster image. "One frame per data row" works by pasting one Component instance per row into
a "Card Deck" frame in the same order as the sheet. [medium.com/@ryaniyengar](https://medium.com/@ryaniyengar/designing-card-decks-and-board-games-in-google-sheets-and-figma-463be0c3c8ca).

**(c) Who makes it.** A visual designer using native Figma tools — the "binding" step is
just typing into the ordinary layer-rename field, not code.

**(d) Flow.** Build a Sheet, one column per attribute → build a "Card Template" frame,
`#column_name` child layers, convert to Component → build supporting variant sets (e.g.
Suit) → paste one instance per row into a "Card Deck" frame, matching sheet order → run
plugin > paste Sheet URL > **Fetch & Sync**; re-run on changes → select the "Card Deck"
frame > native Export panel (4x scale recommended for print resolution). No built-in TTS
export — PNGs are typically pushed to external hosting by hand.

**(e) Output.** Whatever Figma's native Export panel produces per frame — PNG/PDF/SVG/JPG
at a chosen scale. **No built-in print-sheet layout and no POD integration** — combining
individual card frames into a sheet, or ordering physical cards, is entirely the designer's
own downstream process.

**(f) Friction.** The clearest, most concrete evidence in this whole cluster: the plugin's
public GitHub issue tracker currently shows **280 open issues**, including exactly the
failure modes that would hurt a card-binding workflow — "doesn't sync" (#315), "Plugin stuck
on processing" (#310), "Text replacement doesn't work if the node is a 'Text on a path'"
(#311), "Error: in remove: Removing this node is not allowed" (#319), "Hyperlinks are not
transferred from sheets" (#317), and an open feature request just to support Excel at all
("Excel sheet sync," #313 — confirming Google-Sheets-only).
[github.com/DWilliames/google-sheets-sync-figma/issues](https://github.com/DWilliames/google-sheets-sync-figma/issues).
A structural fragility called out by the workflow's own author: *"the order of the
components in the layer navigator... matters quite a bit. The Google Sheets Sync plugin
will operate on each of these layers from bottom to top"* — any row reorder/insert/delete
requires manually re-syncing Figma's layer order to the spreadsheet.

### 3.5 CardConjurer

**(a) The template.** A client-side web app, self-hosted from a GitHub repo (the original
hosted site was taken down — see (f)). "Frames" are image assets plus configuration,
organized into "Frame Groups"/"Frame Packs" chosen from dropdowns. A finished *card* (not
the template) can be saved as JSON, "which include all the images, text, and positioning
for the cards." [github.com/Investigamer/cardconjurer](https://github.com/Investigamer/cardconjurer).

**(b) Binding.** **There is no spreadsheet/dataset binding at all.** Text: click a textbox,
type directly, using inline "Text Codes" in curly brackets for symbols. Art: pick a frame
image and mask from dropdowns, click "Add Frame to Card"; custom art via upload or a
filename typed into a "Via URL" box. Fine positioning is per-card and visual: an "Edit
Bounds" button reveals a "Textbox Editor" to adjust size/placement.
[donsuth.ucc.asn.au/tutorial](https://donsuth.ucc.asn.au/tutorial).

**(c) Who makes it.** Two roles: authoring a *new frame/template* (new border art, new
default textbox layout) is a coder/asset task against the community repo; making an
individual *card* from an existing frame is purely visual/point-and-click.

**(d)/(e) Flow and output.** No spreadsheet-to-print flow exists. Self-host → pick a Frame
Group/Pack → add frame+mask → type text with `{codes}` → nudge via Edit Bounds → save JSON
or export one image → repeat entirely by hand for the next card. A separate community-fork
"Printing Tool" exists for laying proxies onto a sheet, but as a distinct add-on, not an
integrated bulk/CSV print-sheet generator.

**(f) Friction — and the real finding.** The dominant issue isn't UX, it's existential: *"In
November of 2022, Wizards of the Coast served the original creator and webhost of the site
with Cease and Desist paperwork, forcing the site offline,"* so it now survives only as
scattered self-hosted forks. For this research question, the more important finding is not
a complaint: **CardConjurer confirms, by absence, that a modern and popular web card tool
can be strictly one-card-at-a-time with zero data-binding concept** — a useful negative
data point, not a counter-example to the pattern (it simply serves a different job: one
custom card, not a printed set).

### 3.6 Card Creatr Studio

**(a) The template.** A bundle file, `.ccst`/`.ccsb` (a zip archive) containing hand-written
SVG/Pug markup, a `config.hjson`, and assets — authored/consumed inside a desktop
Electron+Vue app wrapping a separate open-source CLI render engine, `card-creatr`.
[github.com/sffc/card-creatr-studio](https://github.com/sffc/card-creatr-studio).

**(b) Binding.** A designer first defines a named "Field" in the app (Properties > Fields >
Add Field; a type like `img`, `uint`, text, or `dropdown`). The template author then
references that field **by name, in hand-written Pug/SVG code**: `+imageFill(myimage, m,
42, cw-2*m, 90)`, `+text(title)(align="center", font-family="title", font-size=17,
x=cw/2, y=28)`. This is code, typed by hand — not a dropdown, not drag-and-drop. The
end-user filling in card *content* does so in a grid the docs literally call "the
spreadsheet." [cardcreatr.sffc.xyz](https://cardcreatr.sffc.xyz/general/2018/04/15/building-blocks).

**(c) Who makes it.** Explicitly a programmer for the template (raw JavaScript `for` loops,
hand-chosen helper functions); a non-coder can then use the finished template through the
Fields/spreadsheet grid alone.

**(d) Flow.** (Programmer, once) write the SVG+Pug template, define Fields → (any user) fill
the per-card data grid, picking images via file browser → preview in-app → render via
`card-creatr -i example.ccsb -o example.png`. **No documented CSV/spreadsheet-file import**
was found in the README/Wiki/FAQ — data entry appears manual, card-by-card, inside the app
(flagged as an absence-of-evidence finding, not a confirmed hard "no"). Note: a different,
unrelated commercial Steam app also called "Card Creator" (Pixelatto) *does* have Excel/CSV
import — a separate product, easily confused by name.

**(e) Output.** SVG or PNG, one card at a time — no built-in print-sheet layout, no POD
integration. Coordinates are point-based (72pt/inch), not DPI-labeled.

**(f) Friction.** Small-scale open source (70 stars/7 forks, 33 open issues, 15 open PRs at
time of research) suggesting real unresolved bugs at hobby-project scale. The most relevant
friction for this research question is (d): no evident CSV/spreadsheet-import path makes
this the weakest fit of the six for "bind a Google Sheet to a visual template," despite
being genuinely template-based and free/open-source.

**What's common across 3.1–3.6:** every tool separates "the shape of one card" from "the
content of many cards" — the same split this platform already has — but the **binding
gesture** varies by audience: zero-syntax drag-and-drop (Canva), typed `{{ }}` expressions
with click-to-insert autocomplete (Component Studio), implicit name-matching set once at
design time (Dextrous's zone names, Figma's `#LayerName`), or fully hand-written code
(Card Creatr Studio). **None make a designer hand-type raw pixel coordinates as the primary
authoring act** — even the most code-like tools resolve position through a live visual
canvas, never a hand-edited numeric file. Every tool doing real bulk/data-driven generation
treats the spreadsheet connection as **one-way, pull-based, never live two-way** — a
Google Sheets change needs an explicit re-fetch, often after a multi-minute publish lag.
"Print-ready" is a spectrum: Component Studio and Dextrous get to "click export, land at a
print vendor"; Canva and Figma stop at "you now have a design, go export it yourself";
CardConjurer/Card Creatr Studio stop at "you now have one rendered card image." Real friction
clusters around performance on large decks, pricing, fragile name/order-matching (Figma
plugin's 280 open issues), and version churn/discontinuity risk (Component Studio's two
forced migrations; CardConjurer's legal takedown).

---

## Part 4 — Code/markup, SVG substitution, and print-ready ground truth

### 4.1 SVG-template + substitution approaches

At least seven real, working projects do SVG-template + CSV substitution — **they do not
converge on a shared convention; each reinvents its own binding mechanism.**

- **svglue** ([mbr/svglue](https://github.com/mbr/svglue), Python) uses a **custom
  `template-id` attribute**, explicitly not the native `id`: *"Add a custom attribute
  `template-id` to every `<tspan>` or `<rect>` element that you want to replace."*
  ```python
  tpl = svglue.load(file='sample-tpl.svg')
  tpl.set_text('sample-text', u'This was replaced.')
  tpl.set_image('pink-box', file='hello.png', mimetype='image/png')
  cairosvg.svg2pdf(bytestring=str(tpl), write_to=out)
  ```
- **jminor/cardmaker** (Python + Inkscape CLI) uses `{ColumnName}` tokens embedded either in
  text content or, as a workaround, placed directly as the element's `id` value; rasterized
  via Inkscape's `--dpi` flag. [Source](https://github.com/jminor/cardmaker).
- **vicksonzero/CardMaker** (JS/browser) uses `#hash` tokens in SVG text content matched
  against `#`-prefixed CSV headers (`<text>#name</text>` / CSV column `#name`), printed via
  the browser's own print-to-PDF. [Source](https://github.com/vicksonzero/CardMaker).
- **inkscape_merge** (Ruby, wraps the Inkscape CLI) uses **`%VAR_columnName%`** tokens:
  `inkscape_merge -f sourcefile.svg -d datafile.csv -o batch/badge_%d.pdf`, then combines
  output with Ghostscript. [github.com/borgand/inkscape_merge](https://github.com/borgand/inkscape_merge); [the-haystack.com writeup](https://www.the-haystack.com/2016/05/16/data-merged-print-design-with-open-source/).
- **svg-mail-merge** (Python3 + lxml + Inkscape + Ghostscript) uses the **`class`**
  attribute as the binding key, manually added via Inkscape's XML Editor: *"There must be a
  heading row with fields that match your field names (the `class` attributes you added
  earlier)."* [Source](https://github.com/basak/svg-mail-merge).
- A minimal blog approach (Jim DeLaHunt) skips XML parsing entirely: Python's
  `str.format()` on the **raw SVG file as text**, with `{name}`/`{mbid}` tokens hand-typed
  into the SVG source. [Source](https://blog.jdlh.com/en/2022/07/31/easy-svg-templates/).
- **py-svg-card-gen** ([ma8u/py-svg-card-gen](https://github.com/ma8u/py-svg-card-gen))
  doesn't use a template file with placeholders at all — code draws the card from scratch
  each row via `svgwrite`.

**Counter-evidence worth flagging:** a real production "batch card printing" writeup (Tai
Vong, Medium) skips SVG/templates entirely and uses Pillow with **hand-typed raw pixel
coordinates** — exactly the pattern this platform is trying to escape, just moved into
Python instead of YAML:
```python
draw.text((210, 570), name, (0, 0, 0), font=font)
```
[Source](https://vchitai.medium.com/batch-id-cards-printing-with-python-f4b3a64e48e1).

**Is there a standard?** No. Across seven real, independent projects there are **at least
five mutually incompatible binding conventions** (`template-id`, `class`, `{python-format}`
tokens, `#hash` tokens, `%VAR_name%` tokens) plus a "generate in code, no template file"
approach and a "raw `.format()` with no XML awareness" approach. Not one uses the native
SVG `id` attribute cleanly as a stable binding key. This matters directly for Part 6: "SVG
with named nodes" is not an existing standard to *target* for import — it is something this
platform would have to invent, same as every other project here already had to.

### 4.2 HTML/CSS + Paged.js / Puppeteer / wkhtmltopdf

**HCCD** ([vaemendis/hccd](https://github.com/vaemendis/hccd), 161 stars, Java desktop GUI):
Handlebars/Mustache-style `{{myVariable}}` placeholders in a raw HTML file matched to CSV
headers, with a documented physical-units requirement: *"the HTML file... contains
variables declared using mustaches (e.g. `{{myVariable}}`)... be careful to use physical
units (mm, pt...) instead of pixels."* Live-monitors the html/css/csv triplet and
auto-regenerates a browser print sheet.

**Oatear Cider (CIDEr)** ([oatear/cider](https://github.com/oatear/cider), 238 stars,
actively maintained) is the most sophisticated tool found in this entire research task — an
explicit "Card IDE" combining HTML + CSS + Handlebars + a built-in spreadsheet editor:
*"Structure with HTML... Style with CSS... Add Logic with Handlebars: Use data from a
spreadsheet to dynamically change names, stats, and abilities."* Live preview, a "Template
Wizard" for standard sizes, export to "PNGs or print-ready PDF sheets with crop marks and
low-ink modes," plus direct Tabletop Simulator export. The underlying project is still
plain files: *"The desktop app saves your project as a clean folder of `.html`, `.css`, and
`.csv` files. Use Git, VS Code, or any other tool."*

**Real CSS Paged Media bleed syntax**, from a dedicated tutorial (rendered via WeasyPrint,
the same primitives Paged.js polyfills for browsers):
```css
@page{ size:63.5mm 88.8mm; marks:crop; bleed:5mm; margin:5mm; }
.front{ page: front; } .back{ page: back; }
@page front{ margin:15mm; }
@top-left-corner{ line-height:15mm; text-align:center; font-size:36pt; content:"A"; }
```
[Source](https://dev.to/azettl/printcss-how-to-create-a-poker-card-14ia). Paged.js itself
documents `bleed`, `marks:crop`, and `@page` as the same standard CSS Paged Media
primitives its own issue tracker confirms real friction with (bleed + custom page
dimensions). [pagedjs.org docs](https://pagedjs.org/en/documentation/5-web-design-for-print/); [pagedjs issue #256](https://github.com/pagedjs/pagedjs/issues/256).

**Who authors these templates?** Overwhelmingly still someone who hand-writes HTML/CSS/
Handlebars. Even the friendliest tools found (HCCD, CIDEr) are orchestration/live-preview
apps wrapped around raw markup, not drag-and-drop tools that *export* HTML/CSS for a
non-coder. **No real example was found of a Figma/Illustrator-style visual tool exporting
card layouts to HTML/CSS** — that gap matters: "HTML/CSS templating" in the wild still
assumes a front-end-literate author. This cluster does show real convergence, unlike 4.1 —
essentially everyone here independently landed on `{{ }}` Handlebars/Mustache syntax.

> **This platform's own `render_html.py` + Paged.js print pipeline is methodologically in
> this exact family** — an HTML/CSS renderer (`layoutCard()`/`cardFrame()` in
> `tools/hub_template.html`) driven by a data-bound spec, with Paged.js providing true
> pagination for print (`docs/layout-engine.md`: "Paged.js true pagination in
> printRules()"). The gap versus CIDEr specifically is CIDEr's live spreadsheet-editor +
> visual template canvas bolted on top of the same file trio — the UX layer this platform
> is missing, not the rendering approach, which is already sound.

### 4.3 TTS / OCTGN sprite-sheet conventions

**Official Tabletop Simulator Knowledge Base** confirms exactly two non-InDesign paths:
*"**Card Sheet Template**: Place your card images in the relevant template and then save
the resulting image"* (a PSD-style template — manual copy-paste composition), and a bundled
third-party GUI, **Deck Builder** (by Froghut): *"Drag and Drop in your cards OR go to File
and choose Add Cards... File > Export to create the card sheet."*
[kb.tabletopsimulator.com](https://kb.tabletopsimulator.com/custom-content/custom-deck/).
Once built, a deck is imported by **Width × Height × Number** — cards are addressed by
**grid position**, not by name; "Card sheets use the last image on a card sheet for a
'hidden' image."

**ImageMagick `montage`** is a real, confirmed hobbyist technique: a one-line `montage
... -tile 10x7 -geometry ...` matches TTS's practical 10×7 (70-card) per-sheet limit;
multiple real GitHub utilities build on this (`lanroth/tts-playing-card-deck-generator`,
`tjakubo/Decker`).

**Squib**, per a detailed real hobbyist walkthrough (Toth Games), is explicitly positioned
against both nanDECK and "no tool at all": *"Many real published games have been built with
tools like nanDECK, or no tools at all. I've tried these approaches and found that having
the flexibility, documentation, and power of a standard programming language saved me the
most time."* Documented pipeline: CSV → `rake generate` → PNG sheet → Google Drive → TTS's
Custom Deck Face URL field. [tothgames.com](https://tothgames.com/posts/generating-cards/).

**ShuffleKit** ([shufflekit.com](https://shufflekit.com/tools/tabletop-simulator-card-maker),
not independently deep-verified) markets itself explicitly as a no-slicing, spreadsheet-in/
sprite-sheet-out visual tool for TTS — the closest thing to a genuinely non-technical,
visual answer found anywhere in this research task.

**OCTGN** uses a third, entirely different convention — **filename-as-key**, not template
substitution or grid position: image files must be named to match a GUID declared in
`set.xml` (`root/{gameGUID}/Sets/{SetGUID}/Cards/{cardGUID}.{alt}.{img}`), packaged as a
renamed `.zip` (`.o8c`). [octgn/OCTGN wiki](https://github.com/octgn/OCTGN/wiki/Card-Image-Package).
Real spreadsheet-to-OCTGN community pipelines do exist (`seastan/lotr-lcg-set-generator`,
`KenDdoox/arkhamlcg-octgn-set-builder`), confirmed as real repos though not fully verified
end-to-end here.

### 4.4 Print-ready technical requirements — ground truth

Verified directly against **three** primary vendor help-center pages (a fourth,
PrintPlayGames, is reported as a dead end below rather than papered over):

| Vendor | DPI | Bleed | Color mode | File format |
|---|---|---|---|---|
| **The Game Crafter** | 300 DPI | 1/8" (37px cut-line / 75px safe-zone offset at 300dpi) | **RGB required — CMYK explicitly rejected**: "Our website will only accept RGB images. CMYK images will be rejected." | **PNG or JPG only** |
| **MakePlayingCards.com** | 300 dpi (Poker size = 822x1122px) | 1/8" / 3mm (72px removed, 36px/side at 300dpi) | No hard gate stated — most permissive of the three | **Broadest**: JPG, BMP, TIF, PNG, GIF (+ EPS/PDF for box art) |
| **DriveThruCards** | 300 dpi | 1/8" (.125") on all sides | **CMYK required, ink coverage <=240%** — "Images... should not be png, as those files cannot be CMYK" | **PDF/X-1a:2003 only**, fonts embedded, strict face/back page order |

Sources: [help.thegamecrafter.com/article/33](https://help.thegamecrafter.com/article/33-dpi-dots-per-inch), [.../391-bleed](https://help.thegamecrafter.com/article/391-bleed), [.../39-templates](https://help.thegamecrafter.com/article/39-templates); [makeplayingcards.com/faq-photo.aspx](https://www.makeplayingcards.com/faq-photo.aspx); [help.drivethrupartners.com](https://help.drivethrupartners.com/hc/en-us/articles/12780748203543-Specifications-for-Print-Cards).

**PrintPlayGames.com — honest dead end.** As of this research, printplaygames.com fully
redirects to a generic Ad Magic marketing page with no DPI/bleed/color-mode content
reachable at that URL or its former sub-paths. Third-party snippets reference "8.5x11 at
300 DPI," but this could not be independently confirmed via a live primary source and is
not asserted as fact.

**Answers, confirmed:**
- **DPI**: genuinely universal — all three verified vendors agree on 300 DPI, no
  disagreement.
- **Bleed**: genuinely universal — all three agree on 1/8" (~3.2mm), not the 2mm this
  platform's own `layout.yaml` currently defaults to for Arcmage
  (`bleed_mm: 2` in `examples/arcmage/templates/layout.yaml`) — worth reconciling, though
  note `docs/layout-engine.md`'s own "What this doesn't do (yet)" already flags that
  `bleed_mm` is recorded but not currently painted as an actual margin at all, so this is a
  pre-existing, disclosed gap this research reinforces rather than a new one.
- **Color mode**: a **real, confirmed, direct disagreement** — not a myth. A one-size-
  fits-all "always convert to CMYK" or "always keep RGB" instruction would be flatly wrong
  for at least one of these three real, current vendors.
- **File format**: also genuinely divergent — flattened raster only (TGC) vs. one strict
  PDF/X-1a (DriveThruCards) vs. broadest-accepted (MakePlayingCards). None state a
  "no transparency" rule directly, but DriveThru's CMYK requirement de facto forces a
  flattened, non-transparent workflow.

**What this means for a template format:** "print-ready" cannot be one fixed export baked
into a template — it has to be a **parameterized export step** (pick a target vendor/
profile, get the matching DPI/bleed/color-mode/format), decoupled from how the template
itself was authored. Every tool surveyed in Parts 1-3 already treats bleed/marks/color this
way (configured at export/print time, never inside the merge/binding step itself) — this
platform's `layout.yaml` recording `bleed_mm` at the template level is consistent with that
industry norm as *data*, it is the missing *export-time* vendor-profile step that would
make the claim "print-ready" actually true end-to-end.

**Overall assessment of Part 4:** the core hypothesis — content bound to a reusable layout
by field name, not by re-typed raw coordinates — holds up strongly almost everywhere here:
every SVG tool lets a designer position elements once, visually, in Inkscape, with only the
data varying afterward; every HTML/CSS tool uses CSS's box/flow model plus `{{name}}`-style
tokens so coordinates are essentially never hand-entered; the print vendors are indifferent
to how the layout was authored as long as the final artifact is flattened correctly. But two
genuine counter-points temper a naive "just do named placeholders" conclusion. First, the
SVG ecosystem specifically shows **zero convergence** on a binding mechanism — adopting
"named SVG nodes" means inventing a convention, not following one. Second, raw hand-placed
coordinates are genuinely alive in two specific places: whenever someone reaches for a
raster-drawing API (Pillow) instead of a markup/box-model format, and at the very bottom of
the TTS pipeline, where a finished sprite sheet is addressed purely by grid row/column —
no names survive that final flattening step, no matter how the individual faces were
authored upstream.

---

## Part 5 — Synthesis

### 5.1 The common pattern

Three things hold across essentially every tool in Parts 1-4, professional and hobbyist
alike:

1. **Template and data are always two separate artifacts.** A reusable "shape of one card"
   (a document, a script, a hosted design, a `.sla`/`.mse-style`/`.ccst`) is authored once;
   a spreadsheet/CSV/Sheet/in-app table supplies the many rows of content merged into it.
   This project's own split — `templates/layout.yaml` vs. `components/cards.json` +
   `components/printings.json` — already matches this pattern exactly. **This part of the
   architecture is correct and should not change.**
2. **Binding is always by field NAME, never by re-deriving a coordinate from data.**
   `<<fieldname>>`, `[colname]`, `{{row.name}}`, `%VAR_name%`, a zone/layer literally named
   to match a column header — every independently-built tool converged on name-based
   binding. This project's `src: "card.name"` dot-path convention is the same idea, and is
   already right.
3. **But the GEOMETRY (x/y/w/h) is authored differently everywhere that matters, and this
   is where this project diverges from every tool designers actually choose.** In every
   tool with real, voluntary designer adoption — InDesign, Affinity, Canva, Figma,
   Dextrous, Component Studio, nanDECK's Visual Editor, even Scribus's base canvas — a
   human never hand-types an x/y/w/h number as the primary authoring act. They drag a box,
   resize a frame, and the numbers are written *for* them, into the file, as a byproduct.
   The numbers still exist in storage (every format above stores them somewhere) — what
   differs is whether a **person types them** or a **canvas writes them**. This project's
   `layout.yaml` currently requires the former for every region of every card template.

### 5.2 The UX spectrum, ranked

From "draws boxes visually" to "hand-types coordinates," with a real popularity signal
noted for each (GitHub stars, forum recommendation frequency, or vendor market position, as
found during this research):

| # | Tool | Authoring act | Real popularity signal |
|---|---|---|---|
| 1 | **Canva Bulk Create** | Pure drag-and-drop, zero syntax | Ubiquitous, free tier, huge general userbase — but shallow print/CMYK/bleed depth, not really a "card game" tool |
| 2 | **Figma + Sheets Sync plugin** | Drag layers; bind by renaming a layer (no coordinate typing) | Popular with design-literate creators; plugin has 280 open GitHub issues; no built-in print sheet/POD |
| 3 | **Dextrous** | Draw+name zones visually; auto name-matched to columns | Genuinely popular in tabletop-specific circles; cheaper than Component Studio per a real designer's comparison; built for this exact job (POD + TTS export) |
| 4 | **Component Studio** | Visual canvas + typed `{{ }}` expressions (autocomplete-assisted) | Very popular in the Kickstarter-era tabletop-design world specifically because of direct-to-print integration and Sheets sync, despite real learning-curve and pricing complaints |
| 5 | **Adobe InDesign Data Merge** | Visual document + click/drag-inserted `<<field>>` placeholders | *The* professional standard industry-wide (business cards, name tags, trading cards) — mature CMYK/bleed/PDF export, but real, years-old Preview-corruption bugs |
| 6 | **Affinity Publisher Data Merge** | Same shape as InDesign, panel-driven field insertion | Real but smaller adoption; a professional's direct verdict: "much clunkier" than InDesign; appeals on one-time-purchase price |
| 7 | **nanDECK (Visual Editor)** | Drag-and-drop boxes, two-way bound to the underlying script | The most-recommended free tool specifically within the board-game hobbyist niche (BGG/BGDF); its own creator admits the *script* is "cryptic," which is precisely why the Visual Editor exists |
| 8 | **Photoshop Variables / Illustrator Variables** | Name a layer, click a "Make Dynamic" button | Comparatively neglected/legacy inside their own apps for this specific job; real practitioners get redirected to InDesign or to scripting for serious batch work |
| 9 | **Scribus + ScribusGenerator** | Visual document authoring, but the merge itself is `%VAR_x%` typed as literal text + a bolted-on Python engine | Moderate adoption, confined to the free/open-source-committed crowd; Python tracebacks surface directly to non-programmer end users when things break |
| 10 | **CardConjurer** | Visual, but no data-merge concept at all — one card at a time | Popular within MTG custom-card hobbyist circles for a *different* job (one-off cards, not printed sets) |
| 11 | **cards.py** | No layout authoring at all — fixed size presets, CSV is the whole "template" | Real niche appeal (simplicity) traded directly against zero positioning control; now archived/unmaintained |
| 12 | **Card Creatr Studio** | Template = hand-written Pug/SVG code; data entry = friendly in-app grid | Small (70 GitHub stars), low real-world adoption |
| 13 | **Squib** | 100% Ruby code, x/y/w/h as keyword arguments or a YAML sidecar | Real but niche popularity specifically among programmer-designers who want a real language over nanDECK's proprietary one |
| 14 | **MSE (template authoring)** | 100% hand-written MSE-script text for anything beyond swapping images | Huge, genuine, long-running popularity for Magic-the-Gathering cards — but that popularity is entirely about the *data-entry/consumption* experience (excellent, one-card-at-a-time WYSIWYG) riding on a small number of expert-authored templates the community remixes; ordinary users never author from scratch |
| 15 | **LaTeX/TikZ** | 100% hand-written code, absolute coordinates, compiler-error-driven iteration | Real but confined entirely to people who already use LaTeX for other reasons; never the first tool a tabletop designer reaches for |
| 16 | **Raw Pillow/PIL scripts** | Hand-typed pixel coordinates in a general-purpose language | The genuine last resort "everyone eventually reinvents" — real (confirmed via a live production Medium writeup), but nobody markets it as good UX |

**This project's `layout.yaml` sits at rung 16 in authoring UX** (hand-typed coordinates,
no canvas) while wearing rung-5-9's clothing (a clean, named-field data-binding model). That
mismatch — a well-designed binding layer with zero visual authoring surface in front of
it — is precisely why this platform's stated goal that designers should feel met "in their
tools, not foreign" (`NORTH-STAR.md`) is not yet true for template *authoring*, even though
it already is true for card *data editing* (the live-updating card editor `docs/
layout-engine.md` describes is a real, working rung-1-3-grade experience — it's the layout
step underneath it that hasn't caught up).

**A real, load-bearing nuance from this ranking:** popularity does not correlate with
"visual" in a simple straight line — MSE is hugely popular *without* being visual to
author, because almost nobody authors an MSE template; they consume one someone else built.
That is itself informative: **a small number of well-made presets, consumed by many, is a
legitimate and popular alternative to "everyone gets a box-drawing canvas"** — see 6.4/6.7.

### 5.3 What a card template minimally needs to define

Cross-referencing every tool above, a template format needs, at minimum:

- **Regions** — text, rich/multi-line text, image, badge/chip, decorative rect/background,
  evenly-spaced row of cells — this project's `layout.yaml` region `type` enum already
  covers this set (`text`/`richtext`/`image`/`badge`/`row`/`rect`/`background`, per
  `docs/layout-engine.md`).
- **Fonts**, addressed by a named role (`title`/`body`) rather than repeated per region —
  already present.
- **An art/image frame** with a fit mode (cover/contain) and artist-credit chrome — already
  present (`image` region's `fit`/`credit`).
- **Symbol/icon substitution** inside text — a genuinely recurring pattern
  (`[spark]`-style tokens in this project's own `richtext.symbols`; Component Studio's
  `<sword/>` tags; nanDECK's own icon substitution to keep printed rules text sensible) —
  already present.
- **Text auto-fit** for variable-length rules text — the single most universally painful
  problem in this entire survey (InDesign's overset text needs a paid plugin to work
  around; Component Studio and CIDEr both build it in as a first-class feature) — already
  present as `text`/`richtext`/`body` `autoshrink`: a fast deterministic estimate followed
  by loaded-font DOM measurement shared by Studio and the canonical Chromium exporter
  (`docs/layout-engine.md`).
- **Data-driven color/palette** (faction-colored frames) — already present.
- **Per-type variants / conditional elements** — confirmed necessary by this project's own
  Arcmage import (Attack+Defense on Creature cards, Defense-only on City cards, neither on
  Events) — already present as `show_if`.
- **A quantity/copies concept** — recurring across nearly every data-side format surveyed
  (nanDECK's `LINKMULTI`, Squib's `qty`, cards.py's `@count`, Dextrous's reserved `Copies`
  column) — a data-schema concern more than a layout one, but worth flagging since every
  competitor treats "how many physical copies of this row" as first-class, not incidental.
- **Bleed recorded as data, painted/exported per target vendor** — see 4.4; this project
  already records `bleed_mm` but (per `docs/layout-engine.md`'s own disclosed gap) does not
  yet paint it as an actual margin, and no tool surveyed bakes a *fixed* color-mode/format
  choice into the template layer at all, since real vendors disagree.

**None of the above is missing from this project's schema.** The schema is not the
problem. The absence of a visual authoring surface in front of it is.

---

## Part 6 — Recommendation for our platform

### 6.1 Where the current design is already right

- The **template/data split** (`templates/layout.yaml` vs. `components/cards.json` +
  `printings.json`) matches the universal pattern in Part 5.1 exactly. Keep it.
- **Named-path binding** (`src: "card.name"`, `palette.by: "attributes.faction"`) is the
  same idea as `<<fieldname>>`/`[colname]`/`{{row.name}}`. Keep it.
- **Plain-text, schema-validated, git-diffable storage** is a genuine, uncommon advantage
  over most of the tools surveyed. `.indd`/`.afpub`/`.ccst` are opaque binaries; Component
  Studio/Dextrous/Canva/Figma projects live only on someone else's server; even nanDECK's
  own `.txt` script and MSE's `style` file are the closest analogues to what this project
  already has. This is *exactly* what makes `NORTH-STAR.md`'s "see the PR as a visual card
  diff, comment, merge" possible at all — no tool in Parts 1-3 offers that, because none of
  them store layout as a reviewable diff. **Do not trade this away for a hosted/proprietary
  visual-only format.**
- **One renderer for every surface** (`layoutCard()` in `tools/hub_template.html` drawing
  the grid tile, modal, live editor preview, PR diff, and print sheet from the same spec)
  avoids a failure mode several tools above hit: InDesign's Preview and Create Merged
  Document can visibly diverge (the corruption bug in 1.1(f)); Figma's canvas and its
  exported PNG can drift if layer order/scale assumptions differ. A single source of truth
  for rendering is a real strength worth explicitly preserving in whatever replaces the
  current authoring UX.

### 6.2 Where it's wrong, specifically

**The authoring *act* for geometry is hand-typing numbers into a text file and reloading to
check** — `docs/layout-engine.md`'s own "Writing a layout for another game" section
describes exactly this loop: edit YAML -> rebuild the hub -> open the Cards tab -> look ->
edit YAML again. Every tool in rungs 1-9 of the Part 5.2 table replaces that loop with
"drag a box, see it move." That is the concrete, mechanism-level thing to fix — not the
file format, not the binding syntax, both of which are already correct.

### 6.3 Proposed file format: keep `layout.yaml`'s shape, don't replace it

Do not invent a new template file format. `schemas/layout.schema.json`'s `card` / `fonts` /
`palette` / `regions[]` shape already contains everything Part 5.3 lists as necessary. The
recommendation is architectural, not a schema rewrite: **build a visual editor whose only
job is to read and write this exact YAML**, the same way nanDECK's Visual Editor reads and
writes the identical script text through a `VISUAL...ENDVISUAL` block (Part 2.1(c)) — this
is the single closest, most directly copyable precedent found in this entire survey,
proven over two decades in exactly this hobby. A JSON twin (or in-memory object — the
schema is already JSON Schema) is all a browser editor needs; no new on-disk format.

### 6.4 Proposed editor interaction model

1. **The canvas *is* the live card.** Render the exact same `layoutCard()` output already
   used for the grid/modal/print, but with each region drawn as a selectable, draggable,
   resizable box (selection handles, like any design tool). This is strictly better than
   nanDECK's separate Visual Editor window or InDesign's Preview toggle (which can desync
   or corrupt, per 1.1(f)) — there is only ever one rendering, so "what you see while
   editing" and "what prints" cannot drift apart by construction.
2. **Add a region by drawing a box**, exactly like drawing a rectangle in any design tool —
   not by hand-adding a YAML array entry.
3. **Bind it via a picklist, not typed syntax.** Since this project's data model already
   separates card/printing/game with resolvable dot paths (`docs/layout-engine.md`'s "Data
   paths" section), the editor can *introspect* the actual keys present on a chosen sample
   card (`card.name`, `card.attributes.cost`, `printing.art_url`, ...) and offer them as a
   dropdown/autocomplete — solving the same "how do I know the field name" problem Component
   Studio solves with its "click Design to see all available variables" panel (3.1(b)) and
   Dextrous solves by auto-generating a spreadsheet column per named zone (3.2(b)). A
   designer should never need to memorize this project's dot-path grammar to bind a box.
4. **Drag/resize writes `x`/`y`/`w`/`h` back into the region object**, in mm, with
   alignment/snap guides (card edge, other regions, a safe-print-margin line) — the numbers
   still end up in the YAML exactly as today, they are simply never the thing a human types.
5. **Keep a raw-YAML/code view as an explicit power-user toggle**, not the default —
   nanDECK's script/Visual duality and this project's own precision work (Part 2.1's
   Arcmage case study hand-tuning anchors against *confirmed* official measurements) both
   show real, ongoing value in direct text editing for exact numeric control. The goal is
   removing the *requirement* to hand-type coordinates, not removing the *option*.
6. **A "preview as" sample-card selector** for conditional (`show_if`) regions — since a
   box's visibility can depend on data (Arcmage's Attack/Defense badges), the designer needs
   to check the layout against more than one real card (a Creature, a City, an Event) without
   hand-editing test data — pair this with a lightweight visual condition builder ("show this
   box only when `attributes.attack` is present") instead of hand-typed `show_if` strings.
7. **A small preset gallery for the zero-layout-work path** — new-game creators (and
   players who just want to try the platform) should never be required to open the box
   editor at all: ship several ready-made `layout.yaml` files (an MTG-style frame, a
   Hearthstone-style frame, a minimalist text-card, a Netrunner-style frame) a newcomer picks
   from, then only remaps field *names* to their own data (this mirrors nanDECK's New-Deck
   Wizard and the "start from a template gallery" onboarding nearly every SaaS tool in Part
   3 uses, and is the same mechanism that makes MSE popular — Part 5.2's rung-14 finding —
   without requiring visual-authoring skill from every user).

### 6.5 Import paths: what's realistic to bring an existing template in from

Ranked by real feasibility, based on what Parts 1-4 actually found about each format:

- **nanDECK script (`.txt`) — implemented first.** The directive grammar is
  small, line-based, and regular (`LINK=`, `TEXT=,"[col]",x,y,w,h,align`, `IMAGE=`,
  `FONT=`) — a bounded parser, not a general-programming-language problem. This project
  now emits and safely re-imports this format through a family-aware adapter. Arbitrary
  scripts land as non-writing candidates; Forge-generated scripts carry the source metadata
  required for a field-level three-way merge back into component/family YAML.
- **InDesign IDML content — second most realistic, and already partly planned.** Unlike
  binary `.indd`, IDML is a documented, open, XML-based zip format. A parser scoped
  specifically to *Data-Merge-tagged* IDML documents (not arbitrary layouts) can recover:
  text-frame geometry (points, convertible to mm), the literal `<<fieldname>>` strings via
  a regex over the Stories XML, and basic paragraph/character style (font family/size/
  color) mapping onto `fonts`/region `font`/`size_pt`/`color`. `NORTH-STAR.md` already
  lists "IDML *content* import for rulebooks (planned)" — extending that same investment to
  card-layout geometry is a low-marginal-cost extension of work already scoped, not a new
  initiative from zero.
- **PSD — medium feasibility, high designer demand.** PSD is a genuinely parseable, common
  format (via libraries like `psd-tools`), and a lot of card *art direction* happens in
  Photoshop even when final merge doesn't. A PSD import can realistically recover **layer
  name + pixel bounding box** (converted to mm via document DPI) and rough text-layer
  content — but Photoshop's Variables/Data-Set-to-layer mapping is not reliably recoverable
  from a plain PSD (most designers never used that feature at all — 1.2(f) shows real
  practitioners bypass it via scripting instead). Realistic scope: import produces
  **unlabeled boxes with a suggested name from the layer**, then the designer confirms each
  binding in the visual editor's picklist (6.4.3) — the same "geometry + a human confirms
  binding" shape as the other two imports below, not a magic one-click conversion.
- **SVG with named text nodes — plausible but there is no standard to target (Part 4.1).**
  Since five-plus independent projects each invented incompatible conventions
  (`template-id`, `class`, `#hash`, `%VAR%`, repurposed `id`), importing an arbitrary
  designer-supplied SVG cannot assume any particular tagging convention exists. Realistic
  scope: (a) always support SVG as a flattened background/art-frame image (safe, no
  semantics needed), and (b) define *this platform's own* convention (a `data-field`
  attribute, not `id`, to avoid XML-uniqueness and Illustrator/Figma auto-ID collisions) and
  document it for designers willing to hand-tag text objects in Inkscape/Illustrator before
  export — an opt-in convention, not a universal importer.
- **Not realistic as a near-term file-import target:** Component Studio, Dextrous, Canva,
  and Figma projects are hosted/proprietary with no accessible file that carries both
  geometry and binding info together (Figma's API could theoretically support a
  plugin-based import for consenting, authenticated users later — a "later," not a file-
  import path). MSE's `.mse-style` binds to MSE's own in-app card object, not a spreadsheet,
  so there is no "data" side to import — at best, its script could be traced as a visual
  reference. Squib/LaTeX/Card Creatr Studio templates are executable code — safely
  recovering geometry would mean running untrusted Ruby/LaTeX/Pug, not a practical import.

**Every realistic import path above shares the same honest shape**: recover geometry (and,
where possible, a suggested field name) automatically; require a human to confirm each
data binding in the visual editor. This is not a compromise unique to imports — it is the
same "confirmed vs. approximated, and don't blur them" discipline this project already
applied to its own Arcmage layout (`docs/layout-engine.md`'s "Importing an official
template" case study). Don't oversell any of these three as "one-click import your
InDesign file" — no tool surveyed in this entire document, including Adobe's own products
talking to each other, achieves lossless template round-tripping.

### 6.6 What's hard — flagged plainly

- **Text auto-fit is a real rendering problem, not a solved one, anywhere in this survey.**
  Forge now reconciles its preview and print paths: the same measured 0.25pt fitting loop
  runs after fonts load in normal card views, Studio, and the canonical Chromium renderer.
  What remains hard is policy rather than hidden clipping: teams must choose an honest
  minimum readable size, and change copy or geometry when text still overflows at that
  floor. Forge reports that as a blocking review/export error rather than silently scaling
  below the declared minimum.
- **Conditional/per-type layouts are inherently harder to author visually than a single
  fixed template**, because a box's presence depends on data, not just position (6.4.6).
  This is real added design work — a visual condition-builder plus a multi-sample-card
  preview — not a byproduct that falls out of adding drag-and-drop for free.
- **"Print-ready" must be a parameterized export, not a template property**, because real
  vendors genuinely disagree on color mode and file format (Part 4.4's table: The Game
  Crafter RGB-only/PNG-JPG-only vs. DriveThruCards CMYK-only/PDF-X-1a-only). A single
  "Export" button producing one fixed artifact will be wrong for at least one real print
  partner; this needs a small set of named export profiles, decoupled from the layout editor
  itself. Bleed painting is a related, already-disclosed gap (`bleed_mm` is recorded but not
  yet rendered as an actual margin, per `docs/layout-engine.md`) worth closing alongside
  this, since Part 4.4 confirms the correct value is 1/8" (~3.2mm), not the 2mm this
  project's Arcmage layout currently uses.
- **Import fidelity has a hard ceiling.** Even Adobe's own tools don't losslessly exchange
  visual nuance with each other (shadows, gradients, masks); a PSD/IDML/nanDECK import will
  always be "recovered geometry + best-guess labels, human confirms," never "pixel-identical
  reproduction, zero review." Scope the feature's promise to match that reality from the
  start, the same way this project's Arcmage README already separates "OFFICIAL, sourced
  directly" from "APPROXIMATED" rather than claiming blanket fidelity.
- **Multi-record imposition with crop marks *between* cards on a shared print sheet** is a
  real gap even in InDesign itself (1.1(e) — a Data-Merge power user still hand-built a
  separate imposition document to get this right). Worth explicitly verifying this
  project's own `printSheet()`/Paged.js pipeline actually handles it — `docs/
  layout-engine.md` describes it as rendering "true physical size, cut lines included,"
  which, if accurate, would be a genuine advantage over stock InDesign behavior and is
  worth confirming and stating plainly rather than assuming.

### 6.7 Concrete next steps, in order

1. Ship the **box-drag + picklist-bind visual editor** described in 6.4, reading/writing
   the existing `layout.yaml`/`schemas/layout.schema.json` shape unchanged — this is the
   single highest-leverage fix, since it directly targets the mechanism gap identified in
   6.2 without touching anything already proven correct in 6.1.
2. Ship a **small preset gallery** (6.4.7) so newcomers never need the editor at all —
   this is the cheapest way to make "zero layout work" literally true today, ahead of the
   editor.
3. **Done:** family-aware nanDECK export/import (6.5), including dry-run, conflict
   detection, safe parser limits, browser commit/fork/PR, and explicit fidelity reports.
4. Close the **bleed-painting gap** and correct the **default bleed value** (2mm -> 1/8"/
   ~3.2mm, per Part 4.4) before making any "print-ready" claim to a designer.
5. Scope and build **IDML content import** for Data-Merge-tagged documents, riding on the
   rulebook-IDML-import work already planned in `NORTH-STAR.md`.
6. Only after 1-5: evaluate PSD import and a documented "tabletop-format SVG" convention
   (6.5) — both real, both lower-leverage than the visual editor itself, since neither
   matters if there's still no visual surface to land the recovered geometry in for
   confirmation.

---

## Sources consulted

**InDesign Data Merge:** [weheart.games/datamerge](https://weheart.games/datamerge/) - [pagination.com/tutorials/data-merge-indesign](https://pagination.com/tutorials/data-merge-indesign/) - [rorohiko.com](https://rorohiko.com/wordpress/2024/11/19/indesign-data-merge-and-textstitch-an-unexpected-partnership/) - [developer.adobe.com data-merge API](https://developer.adobe.com/firefly-services/docs/indesign-apis/guides/working-with-datamerge-api/) - [Adobe Community: preview corruption 2018](https://community.adobe.com/questions-671/data-merge-multiple-records-nightmare-pls-help-830671) / [2025](https://community.adobe.com/t5/indesign-discussions/indesign-data-merge-is-driving-me-insane/td-p/15151633) - [overset text thread](https://community.adobe.com/questions-671/what-is-causing-this-overset-text-issue-in-my-data-merged-document-877256) - [crash thread](https://community.adobe.com/t5/indesign-discussions/data-merge-images-crashing-indesign-on-preview-or-create-merged-document/m-p/12930728/highlight/true) - [slow merge thread](https://community.adobe.com/questions-671/data-merge-is-really-slow-833142) - [BGG thread routing to CardMaker](https://boardgamegeek.com/thread/1692437/card-game-data-merge-multiple-cards-on-same-page) - [Adobe printer's marks](https://helpx.adobe.com/indesign/using/printers-marks-bleeds.html) - [CreativePro CMYK export](https://creativepro.com/import-rgb-images-indesign-convert-cmyk-export/).
**Photoshop:** [helpx.adobe.com data-driven graphics](https://helpx.adobe.com/photoshop/using/creating-data-driven-graphics.html) - [Adobe Community feature request](https://community.adobe.com/feature-requests-713/variables-export-data-sets-as-files-655443).
**Illustrator:** [ai-scripting.docsforadobe.dev](https://ai-scripting.docsforadobe.dev/objectmodel/dynamic/) - [prepression.blogspot.com](https://prepression.blogspot.com/2015/03/illustrator-introducing.html) - [VariableImporter.jsx](https://github.com/Silly-V/Adobe-Illustrator/blob/master/Variable%20Importer/VariableImporter.jsx) - [illustrator.uservoice.com](https://illustrator.uservoice.com/forums/333657-illustrator-desktop-feature-requests/suggestions/32308366-data-merge-like-indesign) - [cg.algonquindesign.ca](https://cg.algonquindesign.ca/topics/variable-data.html) - [christianda.com](https://www.christianda.com/blog-variable-data.html) - [Adobe Community "1000 cards" thread](https://community.adobe.com/t5/illustrator-discussions/i-need-a-way-to-print-1000-card-with-variables-data-merge-and-photos-in-a-practical-and-easy-way/m-p/11541420).
**Affinity Publisher:** [affinity.help data merge](https://affinity.help/publisher2/en-US.lproj/pages/Advanced/dataMerge.html) - [affinity.help fields panel](https://affinity.help/publisher2/en-US.lproj/pages/Panels/fieldsPanel.html) - [affinity.help export settings](https://affinity.help/publisher2/English.lproj/pages/Publishing/exportSettings.html) - [affinity.help layout tool](https://affinity.help/publisher2/en-US.lproj/pages/Tools/tools_dataMergeNode.html) - [makeadigitalplanner.com](https://makeadigitalplanner.com/affinity-publisher-data-merge/) - [Plane Sailing Games](https://planesailinggames.com/post/2026-03-23-data-merge-cards/) - [Elaine Giles](https://elainegiles.co.uk/affinity-publisher-data-merge-hack-unequal-gutters-in-a-data-merge-layout/) - [NNA.org](https://www.nna.org/is-it-finally-time-to-make-the-switch-from-adobe-indesign-to-affinity-publisher).
**Scribus:** [forums.scribus.net](https://forums.scribus.net/index.php?topic=988.0) - [ScribusGenerator README](https://raw.githubusercontent.com/berteh/ScribusGenerator/master/README.md) - [ScribusGeneratorBackend.py](https://raw.githubusercontent.com/berteh/ScribusGenerator/master/ScribusGeneratorBackend.py) - [GitHub issue #54](https://github.com/berteh/ScribusGenerator/issues/54) - [opensource.com](https://opensource.com/life/16/10/python-scripting-scribus) - [mail-archive.com](https://www.mail-archive.com/scribus@lists.scribus.net/msg53620.html).
**nanDECK:** [nanDECK manual PDF](https://www.nandeck.com/wp-content/uploads/2022/05/nandeck-manual.pdf) - [nandeck.com/features](https://nandeck.com/features) - [BGDF card layout tools thread](https://www.bgdf.com/forum/game-creation/prototyping/card-layout-tools) - [BGG visual editor thread](https://boardgamegeek.com/thread/2655991/elements-in-visual-editor-get-slight-size-change-w) - [BGG project org thread](https://boardgamegeek.com/thread/3440922/nandeck-project-organization-recommendations) - [streamlinedgaming.com](https://streamlinedgaming.com/make-trading-cards-using-nandeck/).
**Magic Set Editor:** [yeago/magic-set-editor](https://github.com/yeago/magic-set-editor/blob/master/data/magic-new-token-clear.mse-style/style) - [mtg.wiki](https://mtg.wiki/page/Magic_Set_Editor) - [MagicSetEditorPacks/Full-Magic-Pack](https://github.com/MagicSetEditorPacks/Full-Magic-Pack) - [mse-importer](https://github.com/IgnacioRV/mse-importer).
**Squib:** [andymeneely/squib README](https://github.com/andymeneely/squib/blob/dev/README.md) - [squib.readthedocs.io](https://squib.readthedocs.io/en/latest/layouts.html) - [issue #382](https://github.com/andymeneely/squib/issues/382) - [issue #186](https://github.com/andymeneely/squib/issues/186) - [issue #313](https://github.com/andymeneely/squib/issues/313).
**cards.py:** [jhauberg/cards.py](https://github.com/jhauberg/cards.py) - [example CSV](https://raw.githubusercontent.com/jhauberg/cards.py/master/example/love-letter/cards.csv).
**LaTeX/TikZ:** [ctan.org/pkg/csvsimple](https://ctan.org/pkg/csvsimple) - [ramabile/latex-against-humanity](https://github.com/ramabile/latex-against-humanity) - [tex.stackexchange.com/questions/47924](https://tex.stackexchange.com/questions/47924/creating-playing-cards-using-tikz) - [bgdf.com blog](https://www.bgdf.com/blog/creating-game-markdown-pandoc-latex-and-pdfjam).
**Component Studio:** [help.component.studio](https://help.component.studio/article/560-game-tabs) (articles 521/530/535/540/558/566/580/617) - [finbargames.substack.com](https://finbargames.substack.com/p/a-software-update) - [stonemaiergames.com](https://stonemaiergames.com/creating-hundreds-of-cards-in-component-studio) - [news.thegamecrafter.com](https://news.thegamecrafter.com/post/764694013629677568).
**Dextrous:** [docs.dextrous.com.au](https://docs.dextrous.com.au) - [dextrous.com.au/blog](https://dextrous.com.au/blog/dextrous-the-online-card-game-maker).
**Canva:** [canva.com/help/bulk-create](https://www.canva.com/help/bulk-create) - [canva.com/help/bulk-create-data-autofill](https://www.canva.com/help/bulk-create-data-autofill).
**Figma:** [docs.sheetssync.app](https://docs.sheetssync.app/naming-your-figma-layers) - [medium.com/@ryaniyengar](https://medium.com/@ryaniyengar/designing-card-decks-and-board-games-in-google-sheets-and-figma-463be0c3c8ca) - [google-sheets-sync-figma issues](https://github.com/DWilliames/google-sheets-sync-figma/issues).
**CardConjurer:** [github.com/Investigamer/cardconjurer](https://github.com/Investigamer/cardconjurer) - [donsuth.ucc.asn.au/tutorial](https://donsuth.ucc.asn.au/tutorial).
**Card Creatr Studio:** [github.com/sffc/card-creatr-studio](https://github.com/sffc/card-creatr-studio) - [cardcreatr.sffc.xyz](https://cardcreatr.sffc.xyz/general/2018/04/15/building-blocks).
**SVG substitution:** [mbr/svglue](https://github.com/mbr/svglue) - [jminor/cardmaker](https://github.com/jminor/cardmaker) - [vicksonzero/CardMaker](https://github.com/vicksonzero/CardMaker) - [borgand/inkscape_merge](https://github.com/borgand/inkscape_merge) - [the-haystack.com](https://www.the-haystack.com/2016/05/16/data-merged-print-design-with-open-source/) - [basak/svg-mail-merge](https://github.com/basak/svg-mail-merge) - [blog.jdlh.com](https://blog.jdlh.com/en/2022/07/31/easy-svg-templates/) - [ma8u/py-svg-card-gen](https://github.com/ma8u/py-svg-card-gen) - [Medium Pillow ID cards](https://vchitai.medium.com/batch-id-cards-printing-with-python-f4b3a64e48e1).
**HTML/CSS + Paged.js/Puppeteer:** [vaemendis/hccd](https://github.com/vaemendis/hccd) - [oatear/cider](https://github.com/oatear/cider) - [dev.to/azettl print CSS](https://dev.to/azettl/printcss-how-to-create-a-poker-card-14ia) - [pagedjs.org docs](https://pagedjs.org/en/documentation/5-web-design-for-print/) - [pagedjs issue #256](https://github.com/pagedjs/pagedjs/issues/256).
**TTS/OCTGN:** [kb.tabletopsimulator.com](https://kb.tabletopsimulator.com/custom-content/custom-deck/) - [tothgames.com](https://tothgames.com/posts/generating-cards/) - [shufflekit.com](https://shufflekit.com/tools/tabletop-simulator-card-maker) - [octgn/OCTGN wiki](https://github.com/octgn/OCTGN/wiki/Card-Image-Package) - [seastan/lotr-lcg-set-generator](https://github.com/seastan/lotr-lcg-set-generator).
**Print-ready ground truth:** [help.thegamecrafter.com](https://help.thegamecrafter.com/article/33-dpi-dots-per-inch) (articles 33/391/39) - [makeplayingcards.com/faq-photo.aspx](https://www.makeplayingcards.com/faq-photo.aspx) - [help.drivethrupartners.com](https://help.drivethrupartners.com/hc/en-us/articles/12780748203543-Specifications-for-Print-Cards).
**This platform's own prior art, referenced throughout:** `docs/layout-engine.md`, `schemas/layout.schema.json`, `examples/arcmage/templates/layout.yaml`, `examples/arcmage/README.md`, `tools/export_nandeck.py`, `tools/import-tts.mjs`, `tools/plugins.json`, `NORTH-STAR.md`.
