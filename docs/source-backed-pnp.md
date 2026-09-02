# Source-backed print-and-play

Forge normally renders a card from semantic data plus `templates/layout.yaml`.
That is the right path when a game owns editable frame, art, and font assets.
When a project has an editable SVG or native production document, prefer the
shared `templates/production.json` contract described in
[`production-templates.md`](production-templates.md); it can bind every declared
field across live preview, export, and native-editor automation. The source
overlay below remains the narrower fallback for flattened faces.
Some communities instead publish only composed print-and-play faces. In that
case Forge can preserve the source face and replace deliberately mapped regions
with transparent card-specific patches or a bounded live text reconstruction.
Clean field backgrounds can be recovered declaratively from inspected native
pixels, while finite values can use exact donor patches. A live text region is
honest about using a declared font asset; it does not claim that an open
substitute is the rights holder's production font.

## The user flow

1. Import composed faces into each printing's `scan` field.
2. Declare supported regions for each inspected target card and immutable card
   baselines in `templates/source-overlay.yaml`.
3. Open **Cards → Edit cards**. Fields marked **source-backed field** update the
   same production face with either a verified patch or a configured text
   layer. **Versioned · not printed** fields commit without changing the face.
   **Frame-defining · new template** fields fail closed instead of pretending a
   local patch can turn one production frame into another.
4. Commit the candidate. The semantic change, author, and original baseline are
   now reviewable in Git.
5. Use **Print cards** or `export_pnp.py`. Browser preview, visual diff, face PNG,
   and PDF all call the same renderer.

The System Gateway proof covers every one of the 77 cards and all ten
structural families in the set:
identity, agenda, asset, upgrade, operation, ICE, program, hardware, resource,
and event. A declarative profile generator expands reviewed family geometry
into card-specific regions, then the profile compiler produces the renderer
contract. Those profiles exercise
names, subtype/type lines, rules text, flavor text, and the numeric fields that
apply to each family: cost, program memory, program/ICE strength, trash cost,
advancement requirement, agenda points, identity deck size/influence limit/link,
and the five-state influence-pip track. Pip tracks are generic finite source
fields: the game profile declares their geometry plus inspected empty/filled
donors, and Forge produces card-specific states without teaching the renderer
anything about Netrunner.

Mappings are never shared merely because two cards have the same type. Changing
Sure Gamble from cost 5 to cost 4, or Offworld Office from 4/2 to 5/3, uses an
integer-aligned transparent patch prepared for that exact card. Editable text
uses independently recovered clean rectangles. It auto-shrinks only to a
declared readability floor, supports bounded emphasis, and resolves symbols
such as `[credit]` to the game's declared SVG. Text that does not fit and finite
numeric values without an approved donor patch fail closed to the community
frame. Private-proxy warnings live in Forge and on the print sheet, not across
the card artwork itself.

At the current fixture revision, all 77 source faces reproduce their historical
baseline losslessly, all 77 have card-specific source-backed field profiles,
and an exhaustive bounded mutation run renders all 77 without falling back to
the community frame. Against current card data, 28 cards remain exact and 49
apply their mapped current-data differences. The editor contract audit covers
all 892 field instances present across the set: 430 source-backed, 154
versioned/non-printed, 308 frame-defining, and zero unclassified. A separate
finite-state matrix strict-renders all 1,015 declared patch states across 616
rendered faces. Side, faction, uniqueness, and conversions between structural
types are not source-overlay edits. They require a matching production template
or the community frame.

## The safety rule

Forge never guesses which region is editable. A baseline signature covers every
field that is not mapped by an applicable source region. If a user changes an
unmapped field, asks for a number without a verified patch, or edits text on a
card without a configured text region, the source-backed path stops and Forge shows the
distinct community frame. It will not print an attractive card whose face
contains stale game information.

## What an import can preserve

An imported PnP face can be preserved exactly as a flattened, immutable image.
That does not automatically make its name, rules text, art, frame, or icons
editable. Production-exact text still requires the separated frame and art
assets, production fonts, text-box geometry, paragraph styles, and symbol map.
When those sources are unavailable, a maintainer can explicitly approve a
bounded reconstruction using an open font and official standalone symbols, as
the Offworld proof does. It remains a reconstruction, not a general faithful
text importer. The safe default is still to fail closed and use the distinct
community frame.

`private_only: true` adds an explicit warning in the Cards and print views. It is
a product boundary, not a license grant: composed faces may be used or shared only
when the source license or rights holder permits it.

## Files

```text
components/cards.json             semantic source of truth
components/printings.json         `scan` path + scan provenance
assets/source-faces/              lossless card faces + extraction provenance
assets/source-patches/            generated transparent per-card field patches
assets/source-fonts/              licensed fonts used by declared text regions
templates/source-patch-sources.yaml numeric patch provenance and pixel geometry
templates/source-patch-sources.generated.yaml generated per-card donor recipes
templates/source-background-sources.yaml clean-field recovery recipes
templates/source-background-sources.generated.yaml generated clean-field recipes
templates/source-field-profiles.yaml reviewed structural profile definitions
templates/source-field-profiles.generated.yaml generated per-card profiles
templates/source-profile-families.yaml reviewed family geometry and donor maps
templates/source-baseline-data.json  historical semantic data shown by the PDF
templates/source-baseline-overrides.yaml reviewed corrections to imported history
templates/source-overlay-stress.json changed-card cases for every structural type
templates/source-overlay-stress-all.json bounded simultaneous edits for all 77 cards
templates/source-overlay.yaml     compiled regions + immutable baseline signatures
templates/layout.yaml             distinct editable fallback/community frame
```

Validate the whole contract with:

```sh
node tools/fmt.mjs validate examples/_fixtures/netrunner-sg
python3 tools/extract_pnp_face.py tmp/pdfs/system-gateway-official-1x.pdf examples/_fixtures/netrunner-sg --all --size 744x1030 --update-printings
python3 tools/generate_source_profiles.py examples/_fixtures/netrunner-sg
python3 tools/build_source_backgrounds.py examples/_fixtures/netrunner-sg
python3 tools/build_source_patches.py examples/_fixtures/netrunner-sg
python3 tools/compile_source_profiles.py examples/_fixtures/netrunner-sg
python3 tools/refresh_source_baselines.py examples/_fixtures/netrunner-sg
python3 tools/check_source_baseline.py examples/_fixtures/netrunner-sg
node tools/source-overlay-coverage.mjs examples/_fixtures/netrunner-sg output/nsg-source-overlay-coverage.json
node tools/source-overlay-field-audit.mjs examples/_fixtures/netrunner-sg output/nsg-source-overlay-field-audit.json
node tools/source-overlay-stress.mjs examples/_fixtures/netrunner-sg examples/_fixtures/netrunner-sg/templates/source-overlay-stress.json output/nsg-source-overlay-stress
node tools/generate_source_stress_cases.mjs examples/_fixtures/netrunner-sg examples/_fixtures/netrunner-sg/templates/source-overlay-stress-all.json
node tools/source-overlay-stress.mjs examples/_fixtures/netrunner-sg examples/_fixtures/netrunner-sg/templates/source-overlay-stress-all.json output/nsg-source-overlay-stress-all
node tools/source-overlay-finite-stress.mjs examples/_fixtures/netrunner-sg output/nsg-source-overlay-finite-stress.json
FMT_SOURCE_STRICT=1 node tools/render_cards.mjs examples/_fixtures/netrunner-sg output/nsg-source-current-strict
```

The one-card proofing option exports one copy per repeated `--card` argument.
Whole-deck export still honors printing quantities.
