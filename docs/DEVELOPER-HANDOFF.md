# Forge developer team handoff

This document gives a five-person engineering team a shared starting point. It records a historical qualified software baseline on **2026-09-11**, the boundaries that must survive changes, and five proposed first-week slices. The slices are assignments to agree on, not completed work. These five developers are separate from the five independent creators required for the product pilot.

Forge has a substantial design-to-release workflow and a qualified published image. It is not yet a demonstrated public service: complete publication reconciliation, actual-host evidence, native/physical output checks, and independent-user evidence remain open.

The [v1 execution plan](V1-PLAN.md) tracks the accepted scope, ordered engineering
slices, and remaining evidence gates from September 20 onward. Use its execution
record for current work; the qualification receipts below remain historical.

## Start from the recorded baseline

Use the repository's current protected `main` for new branches and inspect its [latest qualification runs](https://github.com/malinjawi/tabletop-format/actions/workflows/quality.yml). The following is the prior qualified baseline beneath this developer-onboarding work, not a claim that `e2f0618` remains the latest commit or image after this handoff merges:

| Evidence | Recorded identity or result |
| --- | --- |
| Repository | [malinjawi/tabletop-format](https://github.com/malinjawi/tabletop-format) |
| Source commit | [`e2f06188056e965f551574cde15d0ad5b5a7e146`](https://github.com/malinjawi/tabletop-format/commit/e2f06188056e965f551574cde15d0ad5b5a7e146) |
| Change at the recorded baseline | [PR #4: creator workflow and connector outcome cleanup](https://github.com/malinjawi/tabletop-format/pull/4), following [PR #3: preview assets and launch checks](https://github.com/malinjawi/tabletop-format/pull/3) and [PR #2: authoring and durable releases](https://github.com/malinjawi/tabletop-format/pull/2) |
| Qualification run | [34592469112](https://github.com/malinjawi/tabletop-format/actions/runs/34592469112), a push to `main`; product/protocol, exact-image/recovery, and image publication all succeeded |
| Registry deployment reference | `ghcr.io/malinjawi/forge-platform@sha256:dca97049319c977993aa0cf980295108b175c27e946b2415ff84ed820f1d3004` |
| Qualified local image ID in that run | `sha256:0712deabfd203e6e8dc44a443c82eb07a054e5d6a7ccf73ba3e6464195770b60` |
| CI toolchain | Node **24.20.0**, Python **3.11**, locked dependencies; production dependency image digests in [qualified-images.env](../deploy/qualified-images.env) |

The registry digest and local image ID identify different layers of the image system; do not substitute one for the other. The workflow checks the image's OCI source revision, preserves the image used for recovery, and publishes those same bytes after both gates pass. A later commit needs its own qualification and image receipt. Image publication does not deploy Forge.

The recorded run passed **207 functional checks**, the full browser workflow, focused preview/Sheets/download browser checks, **109 local journey assertions**, **112 protocol-mock journey assertions**, and **111 storage checks on each of SQLite and PostgreSQL**. The separate exact-image job ran a real Forgejo journey and **64 restore checks**, serving the fixture's frozen release files from the restored vault with an empty disposable cache. These counts describe separate suites; they are not interchangeable coverage measures.

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
- Browser recovery is account/project/version scoped. Exact-base drafts may restore; older drafts currently remain keep/discard copies. Do not silently apply one over newer source or expose it to another signed-in account.
- The loopback private-fixture preview exception is development-only and read-only. It does not make normal private projects public. Production refuses internal test fixtures, and restricted historical assets remain `private, no-store`.
- Preserve the release order: **exact exports → sealed vault → pending publication journal → protected Git tag → finalized records**. Retries use original sealed evidence and publisher identity. Broken or mixed evidence refuses service.
- Keep cache and vault separate. A backup needs coordinated Git/Forgejo, both application/Forgejo databases, LFS object storage, the release vault, and separately protected installation identity. A source bundle is not a complete product backup.

## Five proposed ownership areas

Agree on one owner and one reviewer for each slice. These are first-week outcomes; broader ownership does not authorize unrelated rewrites. Coordinate edits to `server.mjs`, the browser template, migrations, and CI before working concurrently.

### 1. Studio draft recovery

**Own:** Studio recovery functions in the browser template and their focused browser coverage. Consult the authoring reviewer before changing save semantics.

**First-week outcome:** a discoverable list of this account's retained Studio drafts, including older versions, with a usable recovery export and an explicit explanation of the original base. Preserve staged artwork and metadata. Keep replay into newer source out of this first slice unless a reviewed conflict design is agreed.

**Accept when:** an interrupted session's older draft can be found and exported without developer tools; another account cannot see it; listing/exporting writes no game source; existing exact-base restoration still passes. The interface must continue to say that exporting an old draft has not applied it.

### 2. First-project and spreadsheet workflow

**Own:** new-game onboarding, column mapping and the creator guidance around those actions. Coordinate with the Sheets contract owner rather than changing sync semantics as a UX shortcut.

**First-week outcome:** shorten the idea path so creating a named private project does not require completing the entire design brief first. Keep the existing brief editor and preserve existing brief data. Retain explicit CSV mapping and the attach → review → commit sequence for Sheets.

**Accept when:** a new creator can create the project, build one card system, save it and download a first proof; existing CSV/XLSX imports and failed Sheet attachment remain recoverable; no success message claims cards were committed merely because a project or connection exists. Record where a person unfamiliar with Forge needs help, without treating that one session as a completed pilot.

### 3. Publication reconciliation and recovery

**Own:** release-vault/Store-2 reconciliation, release publication routes and backup/restore integration. Another backend developer reviews every change affecting immutable evidence.

**First-week outcome:** a read-only inventory report comparing finalized and pending publication records, all sealed vault manifests and required blobs, and corresponding Git/tag identities. Classify missing, contradictory, recoverable and unreferenced states explicitly. Establish an interface the recovery UI can consume later.

**Accept when:** fixtures cover finalized-with-missing-blob, pending-but-sealed, sealed-before-journal, wrong tag/manifest binding and healthy publication on both DB drivers. The report never invents replacement bytes or deletes orphans. This closes the public-launch blocker only after the same audit is required before accepting a backup and after restore, and the resulting exact image passes recovery qualification.

### 4. Large release-download delivery

**Own:** one exact-release download path through the vault and gateway, its integrity checks, and performance measurement.

**First-week outcome:** establish a reproducible large-PDF benchmark, then replace whole-file synchronous buffering on that path with bounded delivery while preserving receipt verification and access checks. Scope cancellation and range behavior explicitly; unsupported ranges must have deliberate HTTP behavior.

**Accept when:** memory and unrelated-request latency are measured against the baseline with a representative large file; valid complete/range responses have correct bytes and headers; cancellation closes resources; unauthorized or corrupt content is refused. Do not gain speed by skipping hash verification or treating a disposable cache entry as publication authority.

### 5. Integration and qualification

**Own:** clean-clone onboarding verification, focused browser/contract suites, CI receipts and the team's integration checklist. Review the release and download slices with their owners.

**First-week outcome:** reproduce the README setup on a clean machine/checkout with the qualified toolchain, run one original-game two-user workflow, and maintain a compact receipt linking the accepted commit, CI run, image digest and tested outputs. Add a focused failure case for any new user-visible path, rather than relying only on a successful API response.

**Accept when:** a second developer follows the documented setup without inherited local files; decoded image/font failures fail preview checks; Sheets and selected downloads survive sign-in/failure as specified; the merged candidate passes both protected gates. Record actual-host, native-app, printer and cohort checks as pending until their specific evidence exists. This role does not authorize production deployment.

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

1. **Complete publication reconciliation remains unfinished engineering.** The deployment runbook explicitly blocks public deployment until the all-release audit passes on backup and restore. The existing single-fixture image restore does not prove a whole production inventory is consistent.
2. **Actual-host readiness is separate.** Stable DNS/TLS, database/object/vault configuration, operator and support/rights contacts, off-host backups, restore ownership and anonymous public-preview evidence still need a real deployment record.
3. **Private Sheets needs deployment-specific proof.** A historical private-Sheet commit worked through a disposable tunnel. The operator's pinned add-on on the stable origin must repeat an attributed commit before that deployment is qualified. Controlled-response UI tests do not replace Google-hosted evidence.
4. **Native clients and physical outputs still need smoke tests.** Record app/version, exact artifact hash and result for TTPG/TTS, selected external editors and printer proofs. TTPG packages are file handoffs, not mod.io publishing; TGC presets do not publish or order through an account.
5. **Creator adoption is unproven.** No completed five-unaffiliated-creator cohort is established by the current records. Use [the pilot protocol](CONTROLLED-ALPHA-PILOT.md) and measure completion, assistance and a second iteration.
6. **Retained drafts and interrupted releases lack complete discovery/reapply UI.** Preservation exists, but keep/discard is not finished recovery and retrying a known release tag is not a discoverable recovery center.
7. **Large-PDF serving still buffers and verifies whole files synchronously.** See the vault's `readArtifact` path and the server's released-artifact response path before making performance claims.
8. **Documentation/catalog history needs care.** Older reports contain superseded counts and statuses. The adapter catalog omits a standalone TTPG entry and has some older fidelity descriptions; inspect the actual exporter and its contract. Use the [September 11 UX review](FORGE-UX-REVIEW-2026-09-11.md) for completed UX fixes, so the old retrospective's Sheets-success and hardcoded-card-count findings are not reopened as new work.
9. **Fixture presence is not permission to distribute it.** Third-party fixtures remain in the currently tracked source as well as repository history. Cloning the repository grants no additional permission for their content. Use the Ember development seed or other rights-cleared original material for public demonstrations; inspect each asset's own terms. Excluding fixtures from the production image isolates them but does not resolve their distribution or historical rights questions.

Use [FORGE-HANDOFF.md](FORGE-HANDOFF.md) for recovered decisions and source lineage, [the retrospective](FORGE-RETROSPECTIVE-2026-09-11.md) for why these gaps matter, and [deploy/DEPLOY.md](../deploy/DEPLOY.md) for operations. Record each completed slice with its concrete behavior, acceptance evidence and remaining limit. Do not carry an older commit's green result forward to new code.
