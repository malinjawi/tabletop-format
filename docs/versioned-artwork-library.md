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

## Card artwork workflow

Open a card from **Cards**, choose **Edit artwork**, or use the **Artwork** tab
in Studio. **Change artwork** opens the library beside the complete card.
Selecting an image and adjusting its crop is a temporary preview; **Cancel**
leaves the existing draft intact. **Use artwork** is enabled only after that
card preview finishes and applies the choice to the selected printing only.
Uploads collect the existing credit and rights declaration before previewing.
Previewing an upload alone does not add it to the save payload or recovery file.

**Review changes** compares the saved and proposed versions of each changed
printing, including alternate printings. It names the destination game, shows
the artist and crop, and retains the detailed validation report. **Save changes**
uses Studio's existing base revision, candidate fingerprint, validation and
commit/fork workflow. A failed save keeps the draft. A successful direct save
reopens the same card and inspector tab. Once **Use artwork** has been pressed,
the existing browser draft recovery includes the assignment and uploaded bytes.
Unaccepted previews are intentionally temporary.

The **Content**, **Layout**, and **Colors** tools remain available. No card,
printing, layout, source face, or release migration is required. Previously
existing text-fit issues are reported but do not block an unrelated artwork
edit; new or affected text-fit errors still block saving.

**Printing details & advanced artwork** retains printing metadata, alternate
printings, removal, tags, and the batch library. Shared backs remain in the Back
layout tools. The advanced Studio picker can target one or more exact printing IDs. A designer may use
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
