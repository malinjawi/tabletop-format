# Version-controlled card design families

The composable YAML format is Forge's native design engine. It is not meant to
exclude visual editors: `templates/card-design/engines.yaml` can register other
versioned adapters while keeping this engine active until a proof passes the
promotion gate. See [Card design engine adapters](design-engine-adapters.md).

Forge treats production design as game source. A card is data; it selects a
family template; that family composes reusable frame components and one shared
design system. Every input is an ordinary Git asset, so forks, commits, pull
requests, credits, and releases cover design work as well as card text.

## Repository contract

`templates/card-design/manifest.yaml` is the entry point:

```yaml
version: 1
system: templates/card-design/system.yaml
components:
  - id: foundation
    label: Shared foundation
    source: templates/card-design/components/foundation.yaml
    applies_to: "*"
families:
  - id: program
    label: Program
    match: { type: program }
    source: templates/card-design/families/program.yaml
    specimens: [example_program]
region_order: [shell, art, title, rules, footer]
```

- `system.yaml` owns physical dimensions, bleed, fonts, and palette tokens.
- `components/*.yaml` own regions reused by multiple families.
- `families/*.yaml` own family-specific regions or same-id overrides.
- `region_order` makes composition deterministic regardless of file layout.
- `remove_regions` in a fragment can deliberately remove an inherited region.

The first matching family wins, and validation requires every card to match
exactly one family. A release pins the manifest and every referenced source at
the release commit. It therefore cannot silently pick up a later frame change.

## Migrating an existing layout

```sh
node tools/split-layout-families.mjs path/to/game
node tools/validate.mjs path/to/game
```

The splitter retains `templates/layout.yaml` as a migration snapshot, extracts
shared components, creates one family per card type (and per side when needed),
and preserves the original paint order. Once the manifest exists, the hub and
headless print renderer prefer the composed family sources.

Use `node tools/test-card-design.mjs path/to/game` while the legacy snapshot is
present. It proves that every real card resolves once and that its visible
regions remain identical through the migration.

## Review model

A family source is intentionally small enough to review as one design decision.
For example, moving program strength changes `families/program.yaml`; correcting
a shared cost dial changes a component used by the declared families. Forge's
Assets tab exposes each file's history and normal fork/PR workflow, while the
Card design tab renders one real specimen for every resolved family.
