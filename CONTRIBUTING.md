# Contributing

Thanks for caring about open tabletop. Ground rules, short version:

**The format is the product.** Schema changes need a written rationale and a
migration note — games in the wild must never be stranded (`format_version`
exists for this). When in doubt, open a discussion before a PR.

**Importers/exporters are plugins.** New format bridges (Cockatrice, MTGJSON,
decklists, Screentop, …) are the most welcome PRs and shouldn't touch core.
Match the pattern in `tools/import-nrdb.mjs`: zero/minimal deps, round-trip
tested against a fixture in `examples/`.

**Every PR that touches schemas or tools must keep `./e2e.sh` green** —
35 checks covering every pipeline (imports, validation, render, exports,
decks, licensing, semantic diffs, git porcelain, the fork loop). It runs
in a scratch copy and never mutates the repo. `./demo.sh` is the narrated
version for humans; `e2e.sh` is the law.

**Content vs code.** Code and schemas are Apache-2.0; the spec text and the
Ember example game are CC0. Don't contribute game content you don't have the
right to license (see `tools/check_licenses.py` — imports are gated for a
reason). Declare AI-generated assets in provenance metadata; PRs with
undeclared AI content will be closed.

**Conduct.** Be the kind of contributor a volunteer maintainer is glad to see
in the queue. Disagreements about rules text are fun; disagreements about
people are not tolerated.
