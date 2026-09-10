# Named print targets

Forge keeps print intent in `templates/print.yaml`. A production target is not
just a dropdown label: it names a checked set of file requirements from
`production/print-targets.json`, and the exact-version export records the
registry revision, source links, normalized files, pixels, color mode, DPI, and
SHA-256 hashes in `preflight.json`.

Home and generic press PDFs also version `crop_mark_sides`: `fronts`, `backs`,
or `both`. This supports front-only cutting guides over clean shared backs and
the inverse workflow without changing face order or silently dropping a side.
Impossible combinations—such as back-only marks in a fronts-only build—fail
validation before review, commit, or export. The chosen side scope is repeated
in the dry-run summary, packaged profile, README, and `preflight.json`.

## The Game Crafter · Poker Deck

The first named target is `the-game-crafter-poker`. The current registry is
based on The Game Crafter's Poker Deck component data and official template
guidance. It requires 63.5 × 88.9 mm finished cards and produces:

- one 825 × 1125 pixel, 300 DPI, RGB PNG per selected printing;
- one matching shared-back PNG when the committed profile includes a back;
- stable printing IDs as filenames plus the normal Forge quantity manifest;
- a per-file hash and pass/fail record inside the frozen release package.

The normalized files live under
`manufacturer/the-game-crafter-poker/` in the print-ready ZIP. Real renderer
bleed is centered when sufficient. When an older layout has less bleed, Forge
uses its existing non-distorting edge-extension path and records that fact in
the receipt.

This is deliberately a **file handoff**, not a native TGC account integration.
Forge does not hold a user's TGC credentials, create a product, choose stock,
place an order, or claim TGC certification. The designer must recheck the
linked vendor requirements and inspect a physical proof before sale.

Sources checked on 2026-09-06:

- <https://www.thegamecrafter.com/developer/TGC.html>
- <https://help.thegamecrafter.com/article/39-templates>

## Generic sRGB

`generic-srgb` retains Forge's existing 300 DPI faces and one-face-per-page
press PDF. It is explicitly unqualified because printers disagree on RGB vs.
CMYK, bleed, file order, PDF/X, ink limits, and dielines. A generic package is
useful for proofing and negotiation, but it must not be presented as approval
from an unnamed printer.

## Custom printer · CMYK PDF/X-1a

`custom-cmyk-pdfx1a` is a profile-driven file handoff, never a generic color
preset. The maintainer uploads the exact `.icc` or `.icm` supplied or approved
by the receiving printer through the normal Assets workflow. Forge admits only
ICC v2/v4 `prtr` profiles whose data color space is CMYK, and the asset must have
documented redistribution rights because its bytes are embedded in the PDF.

The committed profile also records the output-condition identifier and label,
registry URL, perceptual or relative-colorimetric intent, and a 100–400% total
ink limit. The frozen build:

- converts each 300 DPI RGB render through that exact output profile;
- measures every converted pixel and fails if declared total ink is exceeded;
- embeds the ICC bytes once as `/DestOutputProfile` and records their SHA-256;
- self-identifies as PDF/X-1a:2003 and emits only CMYK/gray image objects;
- checks page-box nesting, output-intent fields, forbidden active catalog
  features, unembedded fonts, transparency, RGB operators, and soft masks;
- preserves the existing RGB, A4, Letter, quantities, and ZIP outputs alongside
  the CMYK candidate.

The profile can optionally add a cut path derived from the committed component
trim and corner radius. Its exact spot name, alternate CMYK preview, stroke
width, trim offset, and front/back page selection are versioned. Forge writes a
full-tint named `/Separation` stroke with stroke overprint enabled, then reopens
every page and fails the build unless the declared separation and overprint are
actually present. This is a generic finishing primitive: the receiving printer
must supply the required swatch name and approve the geometry.

Forge labels this a **structurally preflighted candidate**, not certified
conformance. The exact PDF still needs approval from the receiving printer or
an independent prepress validator. Printer-specific dieline templates, fill
overprint, stock/finishing decisions, and account publishing remain outside this
target.

## Exact printer delivery receipts

Forge can close the operational loop after a release without pretending to be
the printer. A release owner chooses a frozen PDF or `print-ready.zip`; Forge
copies its name, byte count, and SHA-256 from the immutable release artifact
receipt. The owner then records a printer name and job reference. Optional
submission evidence and required approval/rejection evidence can be hashed
locally in the browser, so private email or portal exports do not have to be
uploaded to Forge.

Each delivery begins as `submitted` and accepts exactly one append-only terminal
decision: `approved` or `rejected`. The decision records the named reviewer,
organization, evidence digest, and optional HTTPS evidence location. It cannot
be rewritten; a changed file requires a new release and delivery. The JSON
receipt explicitly reports `independently_verified: false`. This proves what a
Forge owner recorded about exact bytes, not that Forge authenticated the named
printer or independently validated the evidence.

Normative background checked on 2026-09-06:

- <https://www.color.org/whitepapers/ICC_White_Paper36-Embedding_and_referencing_profiles.pdf>
- <https://pdfa.org/technical-side-and-requirements-of-pdfx/>

Adding another named target requires authoritative current sources, exact
machine-checkable constraints, an output fixture, a negative mismatch test,
and honest publishing boundaries. A CMYK/PDF-X target must additionally name a
real output profile and state whether validation is structural, independent, or
receiving-printer approved.
