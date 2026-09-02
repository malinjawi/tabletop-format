# Official Secret Hitler print-and-play package

This directory is generated reproducibly from the official publisher PDF:

- Source: https://www.secrethitler.com/assets/Secret_Hitler_Print_and_Play.pdf
- Pinned SHA-256: `b835c7b1365f19448649db99a78b043f30f12a1805b62bf3a4e883562edd6829`
- Importer: `tools/import_secret_hitler_pnp.py`
- License: CC BY-NC-SA 4.0

`Secret_Hitler_Print_and_Play.pdf` is the authoritative print artifact.
`source-faces/` contains native-pixel gallery/VTT crops, `placards/` preserves
the complete flat foldable pieces, and `boards/` joins each pair of matching
publisher page halves without resampling. `manifest.json` records checksums,
page provenance, geometry, and the semantic baseline represented by the PDF.

The editable Forge layouts under `templates/card-design/` are a separate
ShareAlike derivative. Editing canonical component data never rewrites or
mislabels these immutable publisher assets.
