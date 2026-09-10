# Versioned artwork library

Forge stores reusable artwork as ordinary project files under `assets/` and
stores project-owned discovery metadata in `design/art-library.json`. The
library file is deliberately small and editor-neutral:

```json
{
  "format": "forge-art-library",
  "version": 1,
  "assets": [
    {
      "path": "assets/card-art/night-market.png",
      "tags": ["location", "night"]
    }
  ]
}
```

This does not duplicate the other asset facts:

- bytes and Git/LFS history stay at the asset path;
- license, creator, source, and redistribution stay authoritative in
  `forge/rights.json`;
- artist credit, edition, quantity, and the assigned art path stay on each
  record in `components/printings.json`;
- cover/contain, focal point, and zoom stay in that printing's `art_crop`;
- rendered faces and releases are derived from the exact committed versions of
  all of the above.

The Studio picker can target one or more exact printing IDs. A designer may use
the current printing, reuse the table's selected cards (one active printing per
card), or check individual family printings. Assignment is local until the
combined dry run. Existing per-printing crops are preserved, so reusing one
image never flattens distinct composition choices.

New uploads collect rights before they are staged and remain visible at the
front of large libraries. Tags participate in search immediately, but become
shared only when the candidate commits. The server validates paths and image
types, ensures each tagged file exists, performs a record-level three-way merge,
and reports same-asset conflicts instead of overwriting current metadata.

External applications do not need to understand this file to remain useful.
Dextrous, Component Studio, Sheets, Affinity, Inkscape, Illustrator, and
nanDECK can continue to exchange the bounded data or visual artifacts they
actually support. The complete Forge project carries the library unchanged,
while returned CSV does not falsely claim to carry artwork-library metadata.
