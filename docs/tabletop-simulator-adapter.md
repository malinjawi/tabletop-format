# Tabletop Simulator adapter

Forge adapter version 4 turns one exact game ref into a staged Tabletop
Simulator save. The Forge repository remains the source of truth; the save and
its textures are deterministic, derived release artifacts.

## Versioned input and output

The adapter reads `game.yaml`, card data and printings, deck documents,
`components/tokens.json`, `templates/component-design.json`, artwork rights,
and the first `setups/*.yaml` document (or the setup explicitly selected on the
CLI). It emits:

- `tts.json`: the importable TTS save;
- `sheet[-N].png` and `back.png`: card deck textures, split at 70 unique faces;
- `tts-components/*.png`: transparent front/reverse component textures without
  manufacturing bleed or guides;
- `tts-components/component-assets.json`: render geometry, hashes, resolved
  quantities, and artwork rights;
- `tts-manifest.json`: exact ref, setup source, object counts, placements,
  texture URLs/hashes, rights, and explicit adapter boundaries.

Hosted texture URLs contain the immutable Forge commit. A published release
records every sibling artifact and can regenerate the whole family byte for
byte if derived storage is lost.

## Object mapping

| Forge kind | TTS object | Behavior |
|---|---|---|
| token, counter, marker, dial | `Custom_Token` | Transparent silhouette, stackable; dials expose declared values as rotations. |
| tile, player-aid | `Custom_Tile` | Rectangle, rounded rectangle, circle, or hex selected from the family shape. |
| board | `Custom_Board` | Starts locked and preserves physical aspect ratio. |
| standee, meeple, figurine | `Figurine_Custom` | Uses the Forge front/reverse texture pair. |
| die | standard `Die_N` | Only standard numeric D4/D6/D8/D10/D12/D20 are emitted. Custom art fails closed. |

Setup zones become tagged snap points. Setup card stacks use the referenced
versioned deck, explicit card placements are removed from those stacks, and
deterministic shuffle order is seeded from game, setup, stack, and ref.
Component placements consume the resolved inventory; the rest is laid out as
a supply. Placing more copies than the committed inventory contains is an
export error.
Setup counters become native interactive TTS `Counter` objects at their
versioned positions and initial values. Their declared minimum and maximum are
kept in object provenance; TTS's built-in counter does not enforce those bounds
without adding game-specific Lua.

## Honest boundaries

- Setup-counter bounds are not enforced with Lua; the built-in counter remains
  generic while its committed bounds stay inspectable in metadata.
- Forge does not fabricate custom-die atlases or face rotations. Those require
  a validated, versioned adapter asset.
- The automated contract proves save structure, texture geometry, rights
  propagation, placement, URL immutability, and byte-identical regeneration.
  Because TTS is proprietary, a human import smoke remains part of release
  operations rather than CI.
- Digital component textures are RGBA, omit print bleed and trim guides, and
  cap each side at 4096 pixels. Manufacturing SVG/PDF output remains separate.

These choices follow the official TTS custom-object and save-state contracts:
[custom objects](https://kb.tabletopsimulator.com/custom-content/about-custom-objects/),
[tokens](https://kb.tabletopsimulator.com/custom-content/custom-token/),
[tiles](https://kb.tabletopsimulator.com/custom-content/custom-tile/),
[boards](https://kb.tabletopsimulator.com/custom-content/custom-board/),
[dice](https://kb.tabletopsimulator.com/custom-content/custom-dice/), and
[save format](https://kb.tabletopsimulator.com/custom-content/save-file-format/).
