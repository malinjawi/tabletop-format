# Production templates: one field map, every output

`templates/production.json` is Forge's renderer-neutral bridge between canonical
game data and a professional card document. It exists to prevent the exact drift
that occurs when a browser preview, a print renderer, and a native editor each
maintain their own list of editable fields.

The contract selects a template by semantic card fields, declares its physical
size and resources, and binds dot paths such as `name`, `text`, or
`attributes.cost` to named objects in an SVG. Forge then uses that one binding
list for:

- the live card editor;
- card grids and visual diffs;
- rendered PNG faces and print-and-play export; and
- optional native-editor adapters such as Affinity.

The SVG is a portable production interchange document, not a Forge-specific
canvas. Every bound object has a stable `data-forge-field` value, while
`layer`/`aliases` identify the corresponding native-editor layer. Transforms
such as `join`, `uppercase`, and `type-label` are declared once. Token-aware
text reflows a vector symbol after the changed text. `choice` bindings select an
exact named layer such as `choice:5`; they are useful when a visual value must
come from an approved native-pixel or vector asset rather than a synthesized
font glyph. Optional `font_family`, `font_weight`, and `font_postscript`
metadata gives browser and native-editor adapters the same type identity.

## Safety and correctness

Each supported card has a baseline containing the original values of all bound
fields plus a signature over every unbound field. A bound edit re-renders the
production document immediately. An unbound edit fails closed: Forge names the
exact missing path and switches to an editable fallback instead of presenting
stale artwork as current.

This is also why the contract is versioned with the game. A pull request can
review changes to data, template geometry, fonts, symbols, and bindings together.
The spreadsheet or visual editor remains a working surface; the Forge commit is
the reproducible candidate.

A source-derived template can make each editable field a self-contained overlay.
When a value equals its baseline, Forge and Affinity hide that overlay, so the
underlying lossless face is the complete output. This is stronger than drawing
the original text a second time: the Offworld proof's baseline Affinity export
is 744×1030 and pixel-identical to the lossless PDF crop. The SVG canvas uses
those exact pixel dimensions; physical millimetres remain in the production
contract, avoiding fractional-pixel resampling during native export.

## Native-editor adapters

An adapter contains only editor-specific transport settings. For Affinity,
`templates/affinity/forge-affinity.json` points to the shared contract and a
template id:

```json
{
  "schema_version": 2,
  "kind": "forge-affinity-binding",
  "production": "templates/production.json",
  "production_template": "offworld_office",
  "card_id": "offworld_office",
  "printing_id": "p_offworld_office_sg"
}
```

It does not repeat `bindings`, `resources`, or `template`. Another native editor
can implement the same contract without changing the game's canonical data or
Forge's preview/export behavior.

`private_only` and `notice` communicate distribution restrictions; they do not
grant a license. A production template may reference only files declared inside
the game directory, and Forge transports its SVG as a non-executable image.

Validate and render the System Gateway proof with:

```sh
node tools/fmt.mjs validate examples/_fixtures/netrunner-sg
node tools/render_cards.mjs examples/_fixtures/netrunner-sg
node tools/test-affinity-bridge.mjs
```
