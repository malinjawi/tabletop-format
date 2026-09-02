# Production source packages

A complete tabletop game is more than card rows. It can include editable card
families, boards, a publication layout, fonts, sound, table setup, and miniature
models. `assets/manifest.json` declares those authoritative source packages in
the same repository as the rules and card data.

The manifest is intentionally tool-neutral. It records which adapter/application
owns a package, whether the bridge is native, round-tripping, import-only,
export-only, or reference-only, and which release targets consume it. Forge
checks that every required path exists and calculates a deterministic input hash.
A fork or pull request therefore carries a reviewable answer to “what files make
this part of the game, and what changed?”

```json
{
  "format": "forge-source-assets",
  "version": 1,
  "packages": [{
    "id": "hero-miniatures",
    "label": "Hero miniatures",
    "kind": "model-3d",
    "status": "experimental",
    "adapter": {
      "id": "blender-gltf",
      "version": 1,
      "direction": "round-trip",
      "application": "Blender"
    },
    "distribution": "release",
    "targets": ["3d-print", "virtualtabletop", "archive"],
    "source_files": [
      { "path": "assets/models/heroes.blend", "role": "editable scene", "primary": true },
      { "path": "assets/models/heroes.glb", "role": "portable preview" }
    ],
    "previews": [
      { "path": "assets/models/heroes.webp", "role": "browser thumbnail" }
    ]
  }]
}
```

## Fidelity rules

- Portable formats such as Forge YAML/JSON, SVG, HTML/CSS, glTF, OBJ, and STL
  can have format-aware validation or adapters.
- Proprietary files such as Affinity, Blender, Krita, or Scribus sources can be
  versioned and round-tripped byte-for-byte. Forge does not pretend it can merge
  their internal layer/object graphs. A change appears as a binary source diff
  plus declared preview/output changes.
- Generated PDFs, card sheets, and tabletop saves remain release artifacts, not
  editable sources. A publisher PDF can be declared `reference-only` when it is
  genuinely an upstream reference.
- `forge/rights.json` remains authoritative for licensing, copyright, and
  redistribution. The package manifest describes workflow; it never grants
  permission.

## 3D is optional and rights-gated

Forge accepts glTF 2.0, GLB, OBJ, STL, and opaque Blender source under the same
25 MB browser-upload cap as other source assets. These files are never executed
server-side. glTF/OBJ references must stay within the repository, and STL/GLB
bytes receive inexpensive format checks before entering Git LFS.

A miniature configurator is not automatically a lawful public asset source.
For example, Hero Forge says its downloadable models are for personal,
non-commercial use and may not be redistributed, and it explicitly says its
models are not licensed for use in a commercial board game. A Forge project may
keep a lawful private working reference, but it must be `private-only` in the
rights ledger and cannot pass the release gate without separate permission.

- Hero Forge terms: https://www.heroforge.com/ToS/
- Hero Forge partnership/board-game guidance:
  https://heroforge.com/content/support-docs/partnerships/

This is the correct connector boundary: Forge can preserve a creator's own or
properly licensed models and send them to play/print targets without turning a
third-party personal-use download into redistributable community source.
