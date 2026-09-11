# Contributing

Start with the [developer setup](docs/DEVELOPMENT.md) and [team handoff](docs/DEVELOPER-HANDOFF.md). Forge connects authoring, visual review, collaboration, playtesting, and exact-version production. Prioritize reliable workflows, clearer UX, and remaining release-integrity work. Agree on a bounded change before adding an adapter or starting a large rewrite.

## Branches and review

The source of truth is protected `main`. A normal clone calls its remote `origin`; the original founder workspace uses `github`. Check `git remote -v` before pushing. Branch from current main using `codex/<short-change>`. Developers without write access can fork the public repository and open a PR.

Describe the problem, resulting behavior, tests actually run, and limitations. Include browser evidence for UI changes and negative/concurrent-write cases for integrity changes. Coordinate shared-file edits in `server.mjs` and `tools/hub_template.html`. **Edit the template, never generated `hub.html`.**

Both **Product and protocol gate** and **Exact image and recovery gate** must pass against the current candidate before merge. Do not bypass protection or merge stale candidates. Have another developer review changes; protection currently does not require a human approval. Main qualifies and publishes its own exact image; it does not deploy automatically.

## Validation and invariants

Run `npm run doctor`, `npm run typecheck`, and focused checks for the surface. Schema, platform, renderer, and tool changes must also keep `./e2e.sh` green. UI changes need the actual browser workflow, including narrow screens and keyboard use where relevant.

| Surface | Focused checks |
| --- | --- |
| Developer startup | `npm run test:dev` |
| Creator workflows | `npm run test:ui`, `npm run test:forge-project:server` |
| Decoded images, symbols, fonts | `npm run test:ui-preview-assets` |
| Sheets/download handling | `npm run test:ui-sheets`, `npm run test:ui-exports` |
| Data/layout round trips | `npm run test:workbook`, `npm run test:svg-design`, `npm run test:squib` |
| Identity and permissions | `npm run test:project-access`, `npm run test:project-ref`, `npm run test:project-reindex`, `npm run test:private-cache` |
| Releases and recovery | `npm run test:release-vault`, `npm run test:release-vault-snapshot`, `npm run test:backup-guards` and the production-image gate |

Read conformance/deployment scripts before supplying a database or Forgejo endpoint; never aim destructive test setup at a real team's stores. [CI](.github/workflows/quality.yml), rather than historical test counts, defines release qualification.

- Review one exact source snapshot, validate the candidate, and recheck the baseline before writing. Stale writes cannot silently overwrite another person.
- Related data, layout, art, rights, and setup changes commit together. Dry runs cannot write. Contributors without permission get a credited proposal or a clear refusal.
- Browser previews and exports share the canonical renderer. Check actual decoded images/fonts, not just HTTP success.
- Sealed releases retain their original bytes. Cache is regenerable; the release vault and publication records are durable. Contradictory evidence fails closed.
- Keep authorization server-side. Fixture access and local exceptions must not broaden production visibility.
- Returned external code is untrusted. Squib imports read supported declared data and never execute returned Ruby.

**The format is portable.** Schema changes need a written rationale and a
migration note — games in the wild must never be stranded (`format_version`
exists for this). When in doubt, open a discussion before a PR.

**Importers/exporters are plugins.** Agreed new format bridges should preserve core boundaries.
Match the pattern in `tools/import-nrdb.mjs`: zero/minimal deps, round-trip
tested against a fixture in `examples/`.

**Content vs code.** Code and schemas are Apache-2.0; the spec text and the
Ember example game are CC0. Existing third-party fixtures have separate rights,
including proprietary and unconfirmed metadata; they are not licensed by the
code license or approved launch assets. Don't contribute game content you don't have the
right to license (see `tools/check_licenses.py` — imports are gated for a
reason). Declare AI-generated assets in provenance metadata; PRs with
undeclared AI content will be closed.

**Conduct.** Be the kind of contributor a volunteer maintainer is glad to see
in the queue. Disagreements about rules text are fun; disagreements about
people are not tolerated.
