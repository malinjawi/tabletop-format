# Forge project handoff

Reconciled on **2026-09-11**. This is a continuation guide, not a production qualification. It combines prior project records, current source, local Git/runtime inspection, and GitHub evidence. See [the retrospective](FORGE-RETROSPECTIVE-2026-09-11.md) for the current assessment and verification rules. Machine-specific paths and backup details are preserved in the local workspace, outside the public repository.

## 1. Start here

**Continue from the latest protected `github/main`.** The six-commit application baseline through **d7bc4bad7a4709e58399d6d60f81404706d9797b** was merged in [PR #2](https://github.com/malinjawi/tabletop-format/pull/2) as **8aa6cf12d33672737d5122698da8f02b5c8098e0**. Its [main qualification and image publication](https://github.com/malinjawi/tabletop-format/actions/runs/34582258008) succeeded. The subsequent preview repair and launch regression coverage are tracked in [PR #3](https://github.com/malinjawi/tabletop-format/pull/3); use that PR and Git for their exact current state.

The user's development direction is **“ignore the beta host now just make the software work and make it work well.”** On September 11 they also requested pushing and merging every open PR and preventing the missing-preview-assets failure at launch. Real-host deployment and speculative feature expansion remain outside this request.

The two pasted milestones at 1d6cc7f and 6e1b8e2 are real historical checkpoints, but they are no longer the latest work. The newer line adds six substantial product and durability commits after the published beta baseline.

Current assessment: **a capable local product with qualified, published source and images; an actual public deployment still needs its own evidence.** Adoption, native-client behavior, physical production, and full production-inventory recovery still need evidence. “Complete Dextrous parity” remains too broad a claim.

## 2. Product intent and decisions to preserve

Forge is the workshop where tabletop games are authored, changed collaboratively, reviewed visually, credited, tested, and released at exact versions. Its distinctive promise is that cards, layouts, rules, art, rights, decks, components, and playable/print outputs remain connected to the same source version.

The intended loop is:

1. Start from an idea, bring an existing game, or import spreadsheet data.
2. Edit cards, rules, visual design, pieces, decks, or setup.
3. See the actual rendered change and review it before saving.
4. Commit directly with permission, or create a credited proposal without permission.
5. Review and merge the exact proposed result.
6. Release a playable/printable version and preserve its exact downloadable bytes.
7. Record playtest evidence against the version actually played, then repeat.

Founder decisions recovered from the prior task:

- Forge should be approachable to first-time designers and should do its core authoring work well in-house. On September 5 the user explicitly requested stronger editors and progress toward Dextrous's design-to-production capability. Do not quietly redefine this as an export-only service.
- Existing tools remain welcome: CSV, Sheets, XLSX, SVG, Squib, Affinity and other bridges should connect source material to reviewable changes. A broad adapter list is not proof of a lossless native round trip.
- On September 10 the user authorized rescuing/publishing the candidate and preparing deployment so they could conduct the five-person pilot. Candidate publication was completed; a real hosted deployment still needed operator inputs.
- Later on September 10 the user redirected work to local software quality. That is the latest development priority.
- Preserve complete vertical workflows and honest limitations. No speculative adapter expansion, showcase games, marketplace, school accounts, payments, enterprise work, or large rewrite merely to increase apparent scope.
- The prior local catalog intentionally used Cards Against Humanity, Secret Hitler, and a loopback-only System Gateway workbench. System Gateway is an internal complexity/fidelity fixture, not a public launch flagship or permission to redistribute proprietary content.

[NORTH-STAR.md](../NORTH-STAR.md) records the stranger-usable vertical-slice discipline and player → designer → publisher adoption order. Its older slice numbering is historical. An older May V1_LOCK.md in the local planning workspace proposes a narrower product with no Git, visual editor, or forks. Later user decisions and the implemented Forge architecture supersede those cuts; do not use that old lock to remove the existing product.

## 3. Source lineage and continuation

The application repository is [malinjawi/tabletop-format](https://github.com/malinjawi/tabletop-format). The September 10 published baseline is **e1c2d9c78e2ad0052677ee47571df8435a4405b3**. The local sanitized release candidate **9c38821** has an identical Git tree. Six subsequent application commits lead to **d7bc4ba** on **codex/software-golden-path**.

The older development history at **6e1b8e2** was archived, then consolidated into the sanitized beta result. Its 67 archive-only commits include enormous generated hub.html versions. **Do not merge that archived history blindly into the current line.** The new line already contains the intended application result and stronger authorization enforcement.

The working environment has several Git worktrees and a separate legacy runtime repository. Multiple worktrees sharing one Git object store are not independent backups. Check the selected repository, branch, actual remote URL and dirty state before any changes. In the original environment the GitHub remote is named **github**, while **origin** points to an old local bundle.

A verified incremental source bundle preserves the six application commits and requires the published e1c2d9c base. A separate private local archive preserves the stopped preview's game repository, database and release vault. These are same-machine recovery copies, not a complete off-host backup or hosted recovery qualification. The local workspace entry point records their locations. Never commit runtime accounts, databases, archives, private fixtures or credentials as handoff material.

## 4. Milestones and what their evidence actually covers

| Checkpoint | Completed result | Evidence boundary |
| --- | --- | --- |
| 1d6cc7f, September 6 | Exact Tabletop Playground package, local textures, staged .vts, deterministic package, release/restore integration. | Prior task reports 193 functional tests, browser workflow, 103-step two-user journey, and exact package reproduction after restore. Proprietary TTPG import still unverified. |
| 6e1b8e2, September 6 | Safe Squib round trip after XLSX, broad visual authoring/production, frozen exports. | Prior task reports 194 functional checks, three collaboration journeys, 72 DB checks per engine, production restore reproduction. Historical clean-tree claim no longer describes its checkout today. |
| e1c2d9c, September 10 | Sanitized controlled-beta baseline, private-project access fixes, protected main, published image. | GitHub PR #1 and successful main workflow independently rechecked during this handoff. This is software publication, not an internet deployment. |
| 8614dc2 | First card-system golden path. | First-project/style/review workflow in the current source line. |
| 2e078c3 | Proposals connected to exact releases. | Exact versions flow through contribution and publication paths. |
| b07fa1f | Protected/recoverable authored drafts and real contributor proposals. | Studio/rules proposals, account-scoped recovery, exact baselines, accumulated reviewed edits. |
| 2b2655d | Resilient visual studios and first playable setup. | Mouse/touch/keyboard, Piece Studio recovery, create a first table, preview and atomically commit pieces/design/setup, local expected-version write guard. |
| 4e530f0 | Frozen playable-component evidence. | Required component kits in exact releases; append-only pinned playtests; browser component table; historical-art/access safety; hostile-text and offline-hub handling. |
| d7bc4ba, September 11 | Crash-safe durable releases. | Prior task reports 205 functional checks, 112 Forgejo journey assertions, 111 DB checks on SQLite and real PostgreSQL, full UI/browser journeys, and concurrent PostgreSQL startup. A fresh retrospective run reproduced 205 functional checks, 109 local journey assertions and the full browser workflow; Forgejo counts remain separate. See PR #2 for production-toolchain qualification. |

The original full-context task ended at d7bc4ba. Matching retained full logs for all of its historical 205/112/111 counts were not located during initial handoff. The retrospective then independently reproduced 205 functional, 109 local journey and 234 browser assertions, preserving complete logs outside temporary storage. [PR #2](https://github.com/malinjawi/tabletop-format/pull/2) passed its final CI and merged; the first run exposed a test navigation race despite the local pass.

The following local Netrunner preview exposed a second coverage gap: `/ui` succeeded while its exact-ref artwork and symbols returned 404. The explicit loopback fixture permission now also applies to its versioned assets, and restricted historical bytes stay `private, no-store`. Regression checks follow generated asset URLs and decode rendered card images/fonts. Before pilot approval, the online deployment preflight must additionally record public-origin preview asset evidence; a healthy server alone is insufficient.

### Qualified image identities

- TTPG historical image: sha256:2f039fcf72d5bfcb50dacaaf07599225c6d963b989be0e7d1e59099c2202e18d, reported against 1d6cc7f in the prior task.
- September 6 image: sha256:6b998a883f0ce7c76e9932e5f415818df727ea92f6dde2e3c330e3cfb348e5af. Local Docker presence and OCI revision 6e1b8e272f67f731b57328a9f85ffdfb8ceff1f2 were rechecked.
- Published beta: **ghcr.io/malinjawi/forge-platform@sha256:e8d19c6aedd48e00e6235f38650a288c22cde1c6133271ff8456c331f77e3ed3**, OCI revision e1c2d9c78e2ad0052677ee47571df8435a4405b3. Local pulled-image identity was also checked.
- The later merged baseline **8aa6cf1** passed its own product/protocol and exact-image/recovery checks and was published by [run 34582258008](https://github.com/malinjawi/tabletop-format/actions/runs/34582258008). Use that run's immutable image receipt, or the latest successful main run, rather than attaching an older image to newer source.

[PR #1](https://github.com/malinjawi/tabletop-format/pull/1) and [PR #2](https://github.com/malinjawi/tabletop-format/pull/2) are merged. Both have successful main qualification and publication records. Main's two required checks, administrator enforcement, strict branch currency, and disabled force pushes/deletions were rechecked. No merge or image publication substitutes for deploying and preflighting the actual public host.

## 5. What is built, and where the boundaries are

| Surface | Implemented capability | Remaining qualification or limitation |
| --- | --- | --- |
| Card and component authoring | Visual cards; shared/family layouts; art; tokens, tiles, boards, dials, counters; cut sheets; decks; rules and publications; first-table setup. | Continue stranger-facing usability and mobile/keyboard review. Existing controls do not prove an unassisted workflow. |
| Data workflows | CSV mapping, versioned XLSX working copies, Google Sheets commits, data imports/exports. | A real Google-hosted private-Sheet commit worked historically through a disposable tunnel; the stable deployed origin/add-on still needs its own attributed-commit test. |
| Collaboration | Standard Git, stable project identity, access checks, editions/forks, proposals, visual impact, approval/merge, credited commits and release metadata. | Preserve exact-baseline and concurrent-write guarantees; test both direct-author and no-write-access paths for changes. |
| External authoring | Safe declared-data/layout round trips; native-source preservation; SVG/Affinity/nanDECK/Squib/PnPInk contracts. | Arbitrary native project files are not magically parsed or losslessly merged. Squib 0.19.0 return imports read declared CSV/YAML; never execute returned Ruby or install supplied gems. |
| Print | CMYK, structural PDF/X, embedded fonts, print profiles, card selection, backs, crop marks, spot paths, printer presets, exact proof/approval receipts. | Independent prepress/native-editor and physical printer acceptance remain external evidence. These capabilities already exist; do not list them all as unimplemented. |
| TTPG | Deterministic exact-ref ZIP, case-sensitive Manifest.json, local textures, decks/pieces/placements, staged .vts and schema/rights receipts. | Human import/play smoke remains. Counters preserve initial values/bounds metadata rather than enforcing bounds with scripts. Flat pieces use card models; unsupported custom dice fail closed. No mod.io publication. |
| TTS / TTC / VTT / PnP | TTS stages decks, components and setup. VirtualTabletop stages cards, decks, zones and setup counters; non-card inventory auto-staging is unsupported. TTC exports card faces and quantity-aware deck stacks. PnP and portable projects preserve their documented exact-version contracts. | Each adapter has its own native-app/hosting qualification. TTS texture availability depends on its immutable asset origin; restoration must preserve that origin. |
| Publisher handoff | Checked production files and exact artifact receipts, including TGC presets. | No direct TGC account publishing, ordering, or manufacturer certification. |
| Browser playtest | Exact-version component table with seats/zones/stacks, movement, flips, counters and reset; pinned non-overwriting playtest records. | Table interactions are temporary session state and must not mutate game source. This is not evidence of a complete multiplayer/rules-engine product. |
| Durable releases | Separate immutable-byte vault, metadata, crash recovery, protected-tag verification, corruption refusal. | Application-enforced append-only storage, not provider-enforced WORM. Full DB/vault reconciliation and latest hosted recovery remain open. |

[Adapter catalog](../integrations/adapters/catalog.json) currently contains 19 entries: 5 stable and 14 beta. Stable entries are CSV, XLSX, Forge design-project ZIP, PnP PDF, and Tabletop Club. TTPG exists in the exporter/contracts but has no standalone entry in this catalog; the count is not an exhaustive exporter inventory.

## 6. Architecture and non-negotiable invariants

### Source model

[SPEC.md](../SPEC.md), [schemas](../schemas), and each game directory define the portable format. A card's rules identity lives in components/cards.json; its physical appearance lives in components/printings.json. Keep stable IDs across renames and reorders. Data, prose, layouts, and binary assets have distinct representations.

Typical game sources include game.yaml, rules/rules.md, rules/publications/, decks/, setups/, components/tokens.json, templates/card-design/manifest.yaml and family files, templates/component-design.json, templates/production.json, templates/print.yaml, assets/manifest.json, design/art-library.json, and forge/rights.json. Protected forge/project.json identity separates project ID from mutable namespace/name and storage location.

### Code map

| Responsibility | Edit/read these sources |
| --- | --- |
| HTTP application and product routes | [server.mjs](../server.mjs), [platform/gateway.mjs](../platform/gateway.mjs) |
| Browser UI and shared card renderer | [tools/hub_template.html](../tools/hub_template.html) |
| Generate hub and render cards | [tools/build_hub.py](../tools/build_hub.py), [tools/render_cards.mjs](../tools/render_cards.mjs) |
| Git backends and collaboration | [store1-local.mjs](../platform/store1-local.mjs), [store1-forgejo.mjs](../platform/store1-forgejo.mjs), [collaboration.mjs](../platform/collaboration.mjs) |
| Protected identity/access/index | [project-access.mjs](../platform/project-access.mjs), [project-ref.mjs](../platform/project-ref.mjs), [project-reindex.mjs](../platform/project-reindex.mjs) |
| SQLite / PostgreSQL | [db.mjs](../platform/db.mjs), [db-pg.mjs](../platform/db-pg.mjs), [migrations](../migrations) through 027 |
| Regenerable output cache | [platform/cache.mjs](../platform/cache.mjs) |
| Durable release bytes and tooling | [platform/release-vault.mjs](../platform/release-vault.mjs), [tools/release-vault.mjs](../tools/release-vault.mjs) |
| Components and TTPG | [tools/lib/component-design.mjs](../tools/lib/component-design.mjs), [tools/export_ttpg.py](../tools/export_ttpg.py) |
| Deployment/recovery | [deploy/DEPLOY.md](../deploy/DEPLOY.md), [deploy/RESTORE-DRILL.md](../deploy/RESTORE-DRILL.md), [deploy/backup.sh](../deploy/backup.sh), [deploy/release-vault-snapshot.mjs](../deploy/release-vault-snapshot.mjs) |

**Edit tools/hub_template.html, never generated hub.html or beta-site copies.** Root hub.html is ignored and generated on demand. The live editor, card grid, visual diff and export rendering share the actual renderer extracted by tools/render_cards.mjs and run in Chromium. Do not introduce an independently approximated print renderer.

The server and frontend template are still large monolithic files. Keep changes scoped; decomposition should preserve behavior and source identity, not become an unrelated rewrite.

### Storage

- **Store 1:** Git source through local repositories or Forgejo; large assets through the configured LFS backend.
- **Store 2:** accounts, permissions, conversations, publication/journal records, and project indexes through SQLite locally or PostgreSQL in production. Project indexes are rebuildable, but people, approvals, publication records and conversations are not disposable.
- **Store 3:** content-addressed, regenerable render/export cache. Cache and release-vault paths must not overlap.
- **Release vault:** separate durable content-addressed bytes and sealed publication metadata. Production uses a separately named external volume. Preserve it independently of ordinary app teardown and cache cleanup.

Current publication order is **exact exports → sealed durable vault → pending Store-2 publication journal → protected Git tag → finalized evidence**. Native vault format v2 records original publisher and exact publication metadata. Crashes can resume from sealed evidence, including a crash before a pending row was recorded. A changed exporter or cache deletion must not change an existing release. Downloads and release-tag forks verify both the sealed evidence and live tag; corrupted/mixed evidence must refuse service rather than silently regenerate replacement bytes.

Backups require coordinated Git/Forgejo, platform and Forgejo databases, LFS/object storage, and the release vault, plus separately protected installation signing/encryption identity. A source bundle and a regenerated cache do not restore the product's release guarantees.

### Change/review rules

- Load related authored state from one exact source snapshot. Validate and preview against that baseline; recheck it at the write boundary.
- Draft recovery is scoped by account, project and exact version. Switching accounts must not expose someone else's draft.
- Dry runs cannot write to the source repository. A related change's data, layout, art, rights and setup land atomically.
- Stale edits must conflict or merge deliberately; never silently overwrite. Preserve append-only playtest identities under concurrent submission.
- Contributors without write access receive a real fork/proposal and land on the review. Accumulated authored proposals must retain earlier intended edits without including unrelated fork experiments.
- Review and merge refer to the exact candidate, dismiss stale approvals, preserve attribution, and enforce permission checks on the server.
- Protected project identity comes from Store 1; an old database index must not grant access to deleted, changed or quarantined projects. Ownerless private projects are not public sandboxes.
- Artifact version constants and filenames participate in identity. Bump relevant versions when required contents change. Never overwrite bytes at an existing immutable URL.
- Validate rights and historical access, not just present-day visibility. Fixture isolation is not a legal license grant.

## 7. Runtime and development workflow

### Local preview and persistent data

During initial handoff inspection, historical ports 4897 and 4901 were stopped and an older application answered on 4898. During the retrospective the latest application was relaunched on **http://localhost:4901/** using a separate persistent copy of the preserved preview data. The legacy instance and its dirty game data were left intact.

The current preview is loopback-only and deliberately enables internal fixtures; do not copy these settings to a public deployment. Its application commit is d7bc4ba; the separate game-store commit at preservation was e151d05. A successful health response alone does not identify the application revision.

Use explicit LOCAL_STORE_ROOT, DB_PATH, CACHE_DIR, FARM_DIR, FORGE_HUB_PATH, RELEASE_VAULT_DIR and FORGE_PUBLIC_ORIGIN values when starting a local preview. Keep cache and vault separate, use a durable state directory, and verify the real browser route. Exact machine paths, process/log information and the recovered startup recipe are kept in the local workspace's private context document.

### Toolchain and checks

Use the [CI-qualified toolchain](../.github/workflows/quality.yml): Node 24.20.0 and Python 3.11. package.json's Node >=20 declaration is too broad for the local node:sqlite backend. The original development worktree shares node_modules and .venv by symlink with its archive checkout; inspect those paths before removing legacy directories.

From the current development checkout:

~~~sh
npm run doctor
npm run typecheck
# Run the focused test(s) for the changed surface first.
npm run test:ui
./e2e.sh
./journey.sh
~~~

Use npm run setup:dev when dependencies actually need bootstrapping; it installs dependencies and should not be a habitual read-only status check. Rendering needs Chromium; adapter-specific tools have additional runtime requirements described by doctor/contracts.

Important targeted suites include test:forge-project:server, test:project-access, test:project-ref, test:project-reindex, test:private-cache, test:component-design, test:ttpg, test:squib, test:workbook, test:release-vault, test:release-vault-cli, test:release-vault-snapshot, and test:backup-guards. Store-2 parity lives in tools/store2-conformance.mjs and store2-pg-test.sh.

For a release candidate, use the full launch/image/protocol/recovery gates with the required environment and disposable infrastructure. Inspect launch-gate.sh before running: its green default can skip actual-host preflight, Forgejo and disaster recovery unless required flags/inputs are present. CI separates product/protocol and exact-image/recovery checks. Promotion on main publishes the tested image; it does not deploy it.

Do not run destructive cleanup/reset scripts or the old root DEPLOY.md's nightly-reset deployment against real game data. The maintained deployment instructions are under deploy/.

## 8. Remaining work and sensible continuation order

### Immediate local continuation

1. Recheck branch/status and this handoff, then inspect or restore the latest local runtime using its existing data locations. Verify the actual application build, not just an HTTP 200. Keep legacy data and archived work intact.
2. Walk one complete newcomer workflow in the browser: new/imported game → edit → actual proof → review → commit/proposal → merge → exact release → playtest/second version. Include a contributor without write access and narrow-screen use. Select the next concrete failure from that journey; do not assume every item from an older audit is still missing.
3. Continue the known software backlog: efficient large-PDF delivery/streaming; onboarding and editor clarity; and complete publication/recovery reconciliation described below. These are remaining work, not features implemented by this handoff.
4. Preserve focused milestones, appropriate regression tests, and browser evidence. The six application commits and current project records are pushed in [PR #2](https://github.com/malinjawi/tabletop-format/pull/2). Its latest protected checks and merge record identify the source publication state; a resulting main image has its own revision/digest. Do not attach the old beta image to newer code.

### Concrete release-integrity gap

[deploy/DEPLOY.md](../deploy/DEPLOY.md) explicitly records that current backup checks validate each durable store but **do not yet reconcile every finalized and interrupted Store-2 publication against the complete vault inventory in one report**. It says public deployment remains blocked until that reconciliation is automated and passes on both backup and restore.

This is unfinished engineering, not merely missing operator credentials. The present vault audit takes a vault directory and checks that store; it is not a complete cross-store publication audit. A proposed next slice should compare finalized and pending publication records, sealed manifests/receipts, and the corresponding Git/tag identities, detect missing/mismatched required artifacts, report recoverable sealed-but-unfinalized publications, and run the same checks on restored state. Define orphan-retention/recovery policy deliberately; do not repair missing evidence by generating new release bytes. Then run a fresh complete hosted/disposable recovery drill for the resulting exact image.

### External gates, deferred while the user wants local work

- Real Docker host, stable Forge and Forgejo DNS/TLS, dedicated R2/object storage, named operator/support/privacy/takedown contacts, off-host backup destination and monitored recovery ownership.
- Operator-owned Google Apps Script/Cloud project and the pinned Sheets connector on the stable origin; prove one private Sheet creates one attributed commit on that deployed candidate.
- Native TTPG/TTS and selected external-editor smoke tests, independent print/prepress checks and at least one physical proof. Record the exact app/version/artifact tested.
- A rights-cleared public flagship and explicit treatment of proprietary fixtures. Prior task notes say pre-existing proprietary Netrunner materials remain in public repository history even though excluded from the production image; do not equate exclusion with permission or claim this has been resolved.
- Five unaffiliated creators completing the workflow with measured assistance and repeat-use intent. No completed cohort evidence was found; do not infer demand from test counts.

[Pilot protocol](CONTROLLED-ALPHA-PILOT.md) acceptance: at least 4/5 finish, at least 3 without developer intervention, both paired runs reproduce their releases, at least 3 intend to reuse Forge, the deployed Sheets commit succeeds, and no integrity stop condition occurs. Repeat-use behavior after creating version two is more useful than adapter counts or feature comparisons.

## 9. Documentation and history traps

- README's 186/96 counts, CONTRIBUTING's early counts, and September 1–3 readiness reports predate current HEAD. Use their procedures with care; never label their old hashes/images as current.
- Root DEPLOY.md describes an obsolete static/communal beta, including a resetting container. Use deploy/DEPLOY.md and deploy/RESTORE-DRILL.md.
- HONEST-AUDIT.md mixes early missing features with subsequent fixes. It is an audit history, not a ready-made current backlog.
- Some adapter and pilot text describes rebuilding all release files from a cache or a “three-store restore.” Current durable-vault publication supersedes that model.
- db.mjs's introductory “people and conversation only” comment is older than its durable publication/journal tables. Store 2 is not wholly rebuildable.
- The September 10 conversational answer listed CMYK/PDF-X/embedded fonts/printer presets as missing even though the code and September 6 milestone implement them. The remaining gap is qualification and usability, not rebuilding these from zero.
- The May V1 lock is historical and conflicts with later user-authorized scope. The ambitious feature history does not supersede the latest local-quality priority either.
- Do not turn “production-qualified image,” “published image,” “local app works,” “native app accepted it,” “hosted service recovered,” and “strangers successfully used it” into one interchangeable claim.

## 10. What to read before the next change

1. This handoff, then [NORTH-STAR.md](../NORTH-STAR.md) and [README.md](../README.md).
2. [Production milestone](CARD-DESIGN-PRODUCTION-MILESTONE.md) for intended authoring/production scope, with dates in mind.
3. The contract for the touched surface: [playable builds](playable-builds.md), [TTPG](tabletop-playground-adapter.md), [TTS](tabletop-simulator-adapter.md), [Squib](squib-adapter.md), [XLSX](workbook-adapter.md), [Sheets](google-sheets-sync.md), [printing](print-targets.md), or [design engines](design-engine-adapters.md).
4. [Deployment](../deploy/DEPLOY.md) and [restore](../deploy/RESTORE-DRILL.md) for any release/storage change.
5. The relevant source and regression tests. Current code and direct evidence outrank old summary language.

The prior task ended at d7bc4ba on September 11, then its continuation failed because conversation context was full. Machine-local history locators are preserved outside this repository. Retrieve only the specific historical question needed rather than loading the full transcript.

Suggested restart instruction: “Read docs/FORGE-HANDOFF.md in forge-product-polish, confirm current Git and runtime state, and continue Forge's local software-quality work from the latest code. Preserve exact-version review, attribution, rights, and durable-release guarantees. Pick the next concrete unfinished workflow or integrity slice, verify it in the real browser and relevant tests, and update the handoff when the milestone changes.”
