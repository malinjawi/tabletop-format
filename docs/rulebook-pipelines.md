# Native rulebook pipelines

Forge treats a production rulebook as source code plus a reproducible build, not as a styled Markdown page.

## Repository contract

`rules/pipeline.yaml` declares one active adapter, a source lock, game-owned overlays, accepted native inputs, and expected outputs. A Git source must use public HTTPS and an exact 40-character commit. The first adapter is `nsg-rules-yaml`.

Game-owned native files live below the declared `overlay_root`, for example:

```text
rules/
  pipeline.yaml
  native/nsg/
    data/input/12_community_appendix.yaml
```

These files participate in ordinary Forge commits, forks, pull requests, file history, and the full `.forge-project.zip` import/export round trip. The upstream formatter remains a locked dependency rather than an unreviewed copy in every game repository.

## Build contract

```bash
node tools/build-rulebook-pipeline.mjs examples/_fixtures/netrunner-sg output/rulebook --allow-network
```

The build fetches the exact source commit into Forge's source cache, applies only allowlisted overlays in a temporary checkout, runs the native generator, compiles its LaTeX, and writes:

- the normal PDF;
- the annotated-changes PDF;
- linkable HTML plus its assets;
- structured JSON;
- the generated LaTeX intermediate;
- a native source package containing the Forge manifest, source lock, and game-owned overlays; and
- `rulebook-build.json`, including input hashes, output hashes, and compiler provenance.

On a host with `latexmk`, Forge uses it. Otherwise it can use Tectonic plus `rsvg-convert`; Docker with the upstream build recipe is the final fallback. Derived outputs are immutable cache artifacts keyed by the game commit.

## Trust and licensing

The manifest records `declared`, `private`, or `permission-required` license status. The NSG proof of concept uses `permission-required` because the inspected public generator mirror does not contain a visible license. Forge can demonstrate a private/local integration, but the source or its derivatives must not be redistributed as a production feature until the copyright holder confirms the terms.

That boundary is part of the build metadata and visible in the Rules UI; it is not buried in setup documentation.
