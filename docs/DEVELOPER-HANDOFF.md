# Forge developer team handoff

Updated **2026-09-20** for the v1 private-pilot candidate. The five-person
engineering team is separate from the five independent creators required for
the product pilot. The active scope and evidence gates are in [V1-PLAN](V1-PLAN.md).

Forge can create, review, collaborate on and release an exact game version.
This milestone improves the reliability of that workflow: stable artwork loading,
saved home-print recipes, account-scoped draft export, whole-publication auditing,
bounded verified downloads, title-only private projects and interrupted-release
recovery. Actual-host, native-app, printer and independent-user evidence remain
open. A qualified image is not a deployed service or proof of adoption.

## Start from qualified source

Use protected `main` from [malinjawi/tabletop-format](https://github.com/malinjawi/tabletop-format).
Before calling a checkout qualified, find its exact commit in the
[qualification runs](https://github.com/malinjawi/tabletop-format/actions/workflows/quality.yml)
and require both **Product and protocol gate** and **Exact image and recovery
gate** to pass. A main run also publishes the same recovered image to GHCR.
The `qualification-receipt-<commit>` artifact connects the source commit, CI run,
local image ID, immutable registry deployment reference and actual restored-file
hashes. Fixture output hashes describe the rights-cleared Tidepool journey, not
a user's Netrunner release. PR receipts have no registry deployment reference.

Work entered through PRs [#6](https://github.com/malinjawi/tabletop-format/pull/6)
(artwork), [#7](https://github.com/malinjawi/tabletop-format/pull/7) (printing),
[#8](https://github.com/malinjawi/tabletop-format/pull/8) (draft discovery),
[#9](https://github.com/malinjawi/tabletop-format/pull/9) (publication inventory),
[#10](https://github.com/malinjawi/tabletop-format/pull/10) (simple start),
[#11](https://github.com/malinjawi/tabletop-format/pull/11) (download delivery),
and [#12](https://github.com/malinjawi/tabletop-format/pull/12) (release recovery
and integration). PR status and its exact checks govern acceptance; this list
alone does not establish that the running service includes them.

Keep Node **24.20.0**, Python **3.11** and locked dependencies. Production service
image pins live in [qualified-images.env](../deploy/qualified-images.env).
Registry digests and local image IDs identify different layers; never substitute
one for the other. Historical milestone reports remain useful history, but their
counts and digests do not qualify new code.

Follow [Development setup](DEVELOPMENT.md), starting with the Node **24.20.0** pin in [.nvmrc](../.nvmrc), then `npm run setup:dev` and `npm run dev`. The development launcher binds to loopback on port **8420** and uses an ignored, isolated `data/dev` runtime seeded with Ember only. Each developer should have their own checkout and runtime, rather than a shared live authoring store.

Use [README](../README.md) for the entry point and [CONTRIBUTING](../CONTRIBUTING.md) for the contribution process. Developers can fork this public repository and submit pull requests without a project invitation; merge access is a separate maintainer permission. Check the actual remote URL before pushing; a remote's name alone does not prove where it points.

## Understand one complete change

Read the [Creator guide](CREATOR-GUIDE.md) and perform one small original-game workflow before editing the implementation:

1. Create or import cards; keep their permanent IDs.
2. Change content, art, or a shared layout and inspect the affected cards.
3. Review a candidate without changing accepted source.
4. Save directly when authorized, or save to an edition and propose it for review.
5. Inspect the resulting commit, then download or release that exact version.

Studio drafts, committed game source, release metadata, and published artifact bytes are separate states. A Sheet attachment does not import its cards; its reviewed commit does. A download does not include unsaved browser edits. An editor handoff does not establish a lossless native-editor round trip or a publication to an external account.

## Architecture and code map

The application code and the games it hosts are separate repositories/state. A game directory contains its card identities, printings, assets, rules, layouts, decks, setup, attribution, and rights. [SPEC.md](../SPEC.md) and [schemas](../schemas) define those files. `components/cards.json` stores rules identities; `components/printings.json` stores physical appearances and refers to stable card IDs. `forge/project.json` protects project identity independently of display names and storage keys.

| Boundary | Main sources | What to preserve |
| --- | --- | --- |
| HTTP routing, authorization, orchestration | [server.mjs](../server.mjs), [gateway.mjs](../platform/gateway.mjs), [auth.mjs](../platform/auth.mjs) | Access checks and exact source versions at read and write boundaries. |
| Browser authoring, review, navigation, card rendering | [hub_template.html](../tools/hub_template.html) | Edit this template, never generated `hub.html`. Its card renderer also supplies exported card faces. |
| Generated application shell and exact project views | [build_hub.py](../tools/build_hub.py), [card_design.py](../tools/card_design.py), [creator_help.py](../tools/creator_help.py) | Live project payloads carry `source_ref`; generated asset URLs stay pinned to that version. Help is bundled from maintained Markdown. |
| Headless card output | [render_cards.mjs](../tools/render_cards.mjs) | Uses the shared renderer in Chromium; do not create a second approximate print renderer. |
| Store 1: source and collaboration | [store1-local.mjs](../platform/store1-local.mjs), [store1-forgejo.mjs](../platform/store1-forgejo.mjs), [collaboration.mjs](../platform/collaboration.mjs) | Standard Git, exact snapshots, expected-version writes, credited proposals and merges. Large assets use the configured LFS backend. |
| Project identity, visibility, indexes | [project-ref.mjs](../platform/project-ref.mjs), [project-access.mjs](../platform/project-access.mjs), [project-reindex.mjs](../platform/project-reindex.mjs), [rights.mjs](../platform/rights.mjs) | A stale index or current public visibility must not grant access to restricted historical bytes. |
| Store 2: persistent application records | [db.mjs](../platform/db.mjs), [db-pg.mjs](../platform/db-pg.mjs), [migrations](../migrations) | SQLite and PostgreSQL implement the same contract. Accounts, permissions, discussion, approvals and publication journals are durable; only derived indexes are rebuildable. |
| Store 3: derived output | [cache.mjs](../platform/cache.mjs), [export-job-race.mjs](../platform/export-job-race.mjs) | Cache is disposable. Export versions and completion receipts prevent partial or changed bytes from becoming a successful immutable result. |
| Published release storage | [release-vault.mjs](../platform/release-vault.mjs), [vault CLI](../tools/release-vault.mjs) | Separate create-only manifests and content-addressed bytes; never repair a release by silently rendering replacements. |
| Components, layouts, external editors | [tools/lib](../tools/lib), [adapter catalog](../integrations/adapters/catalog.json), [Connectors](CONNECTORS.md) | Preserve declared adapter subsets, baselines, field types, source ownership and rights. Returned scripts are data to inspect, not code to execute. |
| Sheets | [integrations/google-sheets](../integrations/google-sheets), [sheetsync.mjs](../tools/lib/sheetsync.mjs) | Three-way comparison, exact reviewed tokens, explicit credit, no automatic write-back to Sheets. |
| Operations and qualification | [deploy/DEPLOY.md](../deploy/DEPLOY.md), [RESTORE-DRILL.md](../deploy/RESTORE-DRILL.md), [quality.yml](../.github/workflows/quality.yml) | Qualify the candidate image, all durable stores, and actual host separately. |

The server and browser template are large files. Extract a narrow module when needed for a slice, with behavior covered first. A general rewrite would add migration risk without closing the current evidence gaps.

## Invariants for every pull request

- Read related authored state from one exact snapshot, validate the candidate, then recheck its baseline inside the write boundary. A dry run writes no game source. Related content, design, assets, rights, and setup changes land together.
- Preserve card/printing IDs, project identity, provenance, and contributor credit across imports, editions, reviews, and releases.
- Cover both a maintainer's direct save and a contributor's no-write-access path when changing authoring. A proposal must not silently overwrite the upstream edition.
- Browser recovery is account/project/version scoped. Exact-base drafts may restore; older drafts can be found and exported through account-menu Recovery with their original base and staged assets. Do not silently apply one over newer source or expose it to another signed-in account.
- The loopback private-fixture preview exception is development-only and read-only. It does not make normal private projects public. Production refuses internal test fixtures, and restricted historical assets remain `private, no-store`.
- Preserve the release order: **exact exports → sealed vault → pending publication journal → protected Git tag → finalized records**. Retries use original sealed evidence and publisher identity. Broken or mixed evidence refuses service.
- Keep cache and vault separate. A backup needs coordinated Git/Forgejo, both application/Forgejo databases, LFS object storage, the release vault, and separately protected installation identity. A source bundle is not a complete product backup.

## Five proposed ownership areas

Agree on an owner and reviewer for each area. Coordinate edits to the large
server and browser template. These assignments maintain and validate the
implemented milestone; they do not authorize deployment or unrelated rewrites.

| Owner | First useful outcome | Evidence to record |
| --- | --- | --- |
| Creator experience | Observe a newcomer creating a private project, reviewing a card and downloading a proof; fix the highest-impact friction. | Completion, assistance, failure/retry behavior, keyboard and small-screen checks. |
| Print and adapters | Verify saved dimensions, shared cuts and calibration on the actual printer; smoke-test the selected native app. | Measured sheet/card sizes, printer/app version and exact artifact hashes; update only support claims actually proved. |
| Recovery and integrity | Exercise account-menu draft export and interrupted-release resume; operate the whole-publication audit. | Original base/art retained, no cross-account disclosure, unchanged sealed bytes, stopped-writer source/restored inventories. |
| Runtime and deployment | Prepare the single supported private deployment within the zero-spend constraint; measure representative concurrent jobs on that host. | Access/TLS, resource and disk budgets, contacts, off-host backup/restore ownership and actual host latency/memory. No paid activation or invitations without authorization. |
| Integration and pilot | Reproduce clean setup and the original-game two-person flow; keep the current receipt and coordinate the independent creator cohort. | Accepted commit and both gates, image/output hashes, second-developer setup result, pilot completion/assistance/repeat-use outcomes. |

Use [Draft recovery in the creator guide](CREATOR-GUIDE.md),
[Release recovery](RELEASE-RECOVERY.md), [Publication inventory](PUBLICATION-INVENTORY.md),
[Verified download delivery](DOWNLOAD-DELIVERY.md) and [Home printing](HOME-PRINTING.md)
for the implemented contracts. Reopening a completed slice requires a concrete
failure or new acceptance need. Preserve the current Node/Python architecture;
consider a narrow Rust worker only after a measured bottleneck and compatibility
proof justify it.

## Choose validation for the changed boundary

| Change | Relevant existing checks |
| --- | --- |
| Browser authoring/navigation/recovery | `npm run test:ui`; focused tests under `tools/ui-*.mjs` and the affected studio tests |
| Preview/source assets or permissions | `npm run test:ui-preview-assets`, `npm run test:local-private-preview`, `npm run test:private-cache`, `npm run test:project-access`, `npm run test:preview-assets` |
| Sheets or downloaded working copies | `npm run test:ui-sheets`, `npm run test:ui-exports`, `npm run test:workbook`, `npm run test:forge-project:server`, the relevant adapter test |
| Git/Store-2/collaboration | `./journey.sh`, `./journey-forgejo.sh`, `./store2-pg-test.sh`, plus identity/concurrency tests for the changed contract |
| Vault or publication | Vault, snapshot, backup-guard tests; the complete exact-image recovery gate for a release candidate |
| Print or tabletop output | The target export test and a representative rendered proof; actual-client/printer checks remain separate |

Run type checks and the functional suite as required by the contribution workflow. [launch-gate.sh](../launch-gate.sh) prints skipped optional host, real-Forgejo and restore checks: its green default is not proof that those checks ran. The CI product job uses the protocol mock; the separate image/recovery job supplies real disposable Forgejo. Never point destructive test fixtures or migration/conformance suites at a live user database.

The deployed preview preflight checks one selected public card project, samples at most 32 emitted asset URLs across available formats, verifies exact refs and bytes, and records the sample size. It complements decoded browser tests. It does not certify every asset in the entire catalog or native tabletop behavior.

## Open evidence and product boundaries

1. **Actual-host readiness:** stable HTTPS, private access, durable stores,
   operator/support/rights contacts, off-host backups and a demonstrated restore
   need a deployment record. A passing disposable restore is engineering
   evidence; repeat the mandatory whole-publication audit on the real backup.
2. **Private Sheets:** repeat an attributed private-Sheet commit using the
   pinned add-on against the deployed origin. Controlled-response tests and a
   historical tunnel session do not qualify a new deployment.
3. **Native apps and printing:** record target version, exact artifact hash and
   result. TTPG is a beta file handoff, not mod.io publishing; TGC presets do not
   publish or order through an account. PDF geometry cannot establish physical
   printer accuracy or sleeve fit.
4. **Creator adoption:** no completed five-independent-creator cohort is claimed.
   Use [the pilot protocol](CONTROLLED-ALPHA-PILOT.md), including a second
   iteration, rather than equating developer tests with user success.
5. **Recovery limits:** old draft export preserves evidence without applying it
   to newer source. Release resume requires the original publisher and verified
   seal. Contradictory, missing and legacy evidence can require operator work;
   the UI never silently repairs it with a new render.
6. **Capacity limits:** download snapshots and vault workers are bounded per
   process. Local benchmark numbers are not host guarantees. Small synchronous
   metadata/Git operations still exist; profile actual workloads before claiming
   every request is nonblocking or considering an architecture rewrite.
7. **Rights:** third-party fixtures remain in tracked source and history. Their
   presence grants no distribution permission. Use Ember or original,
   rights-cleared material for demonstrations. Excluding fixtures from a
   production image does not resolve the terms of content elsewhere in the repo.

Use [FORGE-HANDOFF.md](FORGE-HANDOFF.md) for source lineage and older decisions,
[the retrospective](FORGE-RETROSPECTIVE-2026-09-11.md) for earlier findings,
and [deploy/DEPLOY.md](../deploy/DEPLOY.md) for operations. Older findings must
be checked against the current implementation before reopening them.
