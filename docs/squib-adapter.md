# Squib working-copy adapter

Forge's Squib adapter is a deterministic, version-pinned handoff for designers
who prefer a real programming language and text files. It targets the published
Squib 0.19.0 CSV, YAML-layout, Ruby DSL, PNG, and PDF contracts.

## What leaves Forge

`POST /api/games/:slug/export/squib` produces one ZIP containing:

- `manifest.json`: game, source hash, tested upstream version, and fidelity boundary;
- `Gemfile` and `Gemfile.lock`: pin Squib 0.19.0 and its resolved dependency graph;
- `families/<family>/cards.csv`: editable canonical card data with permanent IDs;
- `families/<family>/layout.yml`: named Squib layout entries in millimetres;
- `families/<family>/deck.rb`: a runnable starter that reads adjacent data and writes local PNG/PDF previews;
- `families/<family>/forge-source.json`: region-source identity and three-way merge baselines;
- `base-cards.json` and `render.csv`: baseline and reproducible-preview support.

The ZIP itself is byte deterministic. An immutable Forge export URL therefore
continues to identify the exact same working copy.
The same tree is also carried under `adapters/squib/` in a complete Forge design
project, so the documented project escape hatch does not omit this editor path.

## What can return

Forge reads only manifest-declared JSON, `cards.csv`, and `layout.yml`. It never
loads or executes `deck.rb`, Bundler, gems, generated output, or undeclared
files. The return path supports card-field changes by stable ID plus literal
region geometry, flat colors, stroke width, and corner radius.

Every return begins as a dry run. Forge compares it to both its exported Git
baseline and current repository state, shows semantic and rendered impact, and
only then permits one validated commit. A contributor without write access gets
a credited fork and pull request through the same endpoint.

Missing named regions are preserved rather than deleted. New undeclared layout
entries are ignored with a warning. Card deletion requires separate explicit
permission, and card creation stays in Forge's canonical card/printing flow.

## Explicit fidelity boundary

The generated Squib project is an editable preview, not Forge's release
renderer. Forge keeps these production concerns canonical and unchanged:

- artwork rights, assets, cropping, and image fit;
- dynamic faction palettes, gradients, and motifs;
- layer opacity and compositing;
- conditional visibility, exported as precomputed Ruby ranges;
- shared typography links and versioned font assets;
- rich-text composition, inline game symbols, and effects.

This avoids claiming a lossless conversion between different rendering
engines. Production output is still generated from the reviewed Forge commit.

## Local use

From the unpacked ZIP root:

```sh
bundle install
bundle exec ruby families/<family>/deck.rb
```

Forge does not install Ruby or Squib on the server. `bundle install` is a local
user action governed by that user's environment and trust policy.
