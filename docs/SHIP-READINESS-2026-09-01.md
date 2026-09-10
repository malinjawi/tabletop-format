# Forge ship-readiness deep dive

Status: 2026-09-01
Audited code: `956ea85` plus the current working tree

> **Implementation update:** the P0 foundation pass described by this audit has
> now been implemented and verified. The authoritative current gate, evidence,
> operating limits, and remaining deployment actions are in
> [`CONTROLLED-ALPHA-LAUNCH-GATE-2026-09-01.md`](CONTROLLED-ALPHA-LAUNCH-GATE-2026-09-01.md).
> The detailed findings below are retained as the baseline that drove the work;
> where an implementation-status statement conflicts, the launch-gate document
> is newer.

## Executive verdict

Forge is ready to become a **small, staff-supported alpha for card-game designers** after one foundation pass. It is not ready for an open public game jam or a broad “all tabletop games” launch yet.

That distinction matters. The core product is real:

- a designer can start from an idea, CSV, or Sheet;
- a game is stored as versioned source rather than an opaque editor file;
- cards, layouts, rules, artwork, and publications can be reviewed as source changes;
- a contributor can fork, propose, receive credit, and merge;
- exact commits can produce print, VTT, and portable editor artifacts;
- the Google Sheets working-copy boundary has been exercised end to end.

The blockers are now trust and scale, not another impressive renderer. A public launch would currently put too much weight on a non-reproducible test gate, a 11.9 MB catalog-shaped HTML response, custom collaboration rules that are weaker than the Git story Forge promises, synchronous export jobs, incomplete authentication/security, and an asset model that is production-capable for cards but not yet complete for arbitrary tabletop games.

The launch promise should be:

> Bring a card game from the tool you already use. Forge turns a deliberate snapshot into a reviewable semantic and visual change, preserves credit and licensing, and releases that exact version ready to print or play online.

Do not launch as “GitHub for every tabletop game” yet. Launch as the best collaboration and release pipeline for **card games**, prove it with one curated community jam, then expand component types.

## What was verified

### The product surface

The current homepage clearly offers four useful entrances:

1. start from a rough idea;
2. paste or upload CSV;
3. connect a Google Sheet as a working copy;
4. create an independent edition of an existing game.

The new-game modal is one of the strongest parts of the product. It asks for the player experience, the smallest playable prototype, the design question, optional card data, and a deliberate license choice. This is much better than starting with repository terminology.

The current jam detail has machine-checkable constraints and a one-click starter. However, on 2026-09-01 the Spark Jam still displays “Running” even though its end date is 2026-08-31. There is no organizer-facing jam creation or moderation path visible in the product.

At a 390 × 844 viewport the homepage is close to fitting, but still overflows horizontally by 6–7 px and several primary controls are only 27–32 px tall. The catalog also puts complete card faces into the initial DOM. That is costly and overwhelming on mobile even when the CSS technically collapses.

### Tests and operational behavior

`npm run doctor` passes. The documented `./e2e.sh` invocation does not select the repository virtual environment, causing dependency failures. Running with `.venv/bin` selected passed the schema, validator, renderer, core exporter, licensing, jam, Git porcelain, server, fork, LFS, and early Store-2 checks.

The same run then exposed a second launch blocker: it consumed **12 GB** in one disposable scratch directory and failed with `ENOSPC`. Most of the final 32 failures were cascading failures after the disk filled, not independent product regressions. The run was creating large hub files, print packages, generated caches, and repeated full repository packs inside fork fixtures.

The test harness therefore proves substantial functionality, but it is not a reliable release gate until it:

- selects one declared Python runtime itself;
- uses small fixtures for ordinary collaboration tests;
- has explicit scratch/cache budgets;
- cleans on success, failure, and interruption;
- separates expensive visual/export tests from the fast merge gate;
- reports root causes instead of counting cascades;
- runs from a clean checkout in CI;
- makes `npm run typecheck` real (`tsc` is currently declared but not installed).

### Measured delivery cost

The local `GET /` response is about **11.9 MB** with only three runtime games and takes roughly 1.5 seconds before completion on the same machine. The runtime cache is already hundreds of megabytes. An earlier full generated hub was hundreds of megabytes.

This happens because the app shell is also a serialized catalog and card renderer. It will not scale to dozens of games, and it prevents good caching boundaries.

## Launch scorecard

| Area | Current | Launch interpretation |
|---|---:|---|
| Start/import onboarding | B | The intent-first modal is good; import needs resumable mapping and better error recovery. |
| Card source and rendering | B+ | Strong and unusually capable; production preflight and performance still need hard gates. |
| Rules/publications | B | Correct source/publication split; external round trips and large-document jobs need hardening. |
| Sheets workflow | B | Valuable working-copy boundary; installer, OAuth, stable hosting, and multi-table mappings remain. |
| Fork/PR/credit loop | B- | Real three-way merge and attribution exist; protection and Git-native interoperability do not yet match the promise. |
| Releases | C- | Frozen artifact records exist, but the hosted release endpoint does not create a real annotated Git tag. |
| Discovery | C | `genre`, `tags`, and `/api/discover` exist in code; the UI, taxonomy, and scalable index do not. |
| Jams | C | Good constraint model and starter; status, submission pinning, judging, moderation, and organizer tools are incomplete. |
| Non-card tabletop assets | D+ | A generic token schema exists, but boards, punchouts, boxes, player aids, and setup-ready exports are not end-to-end. |
| Mobile/accessibility | C- | Usable shape, but touch sizing, overflow, keyboard/screen-reader QA, and responsive heavy views remain. |
| Performance | D | The 11.9 MB initial response and synchronous generation are stop-ship issues. |
| Security/abuse readiness | D | Fine for local proof; insufficient for public registration and untrusted uploads. |
| Operations/recovery | D+ | Production-shaped notes exist; immutable builds, worker isolation, observability, and restore drills do not. |

## P0: what must be true before inviting strangers

### 1. Make the repository story true

Forge currently has two collaboration truths:

- Store 1 is a real Forgejo repository;
- pull requests and their snapshots are custom Store-2 records managed by Forge.

That was a reasonable prototype, but a public product must have one authoritative model. The recommended model is:

- Forgejo owns commits, branches/forks, annotated tags, and pull requests;
- Forge owns the tabletop-aware diff, render checks, licensing checks, credits, and friendly UX;
- Store 2 indexes those objects and stores discussion/notification state that Git cannot represent;
- every Forge PR links to an actual Git head and base ref, so CLI users and external Git tools see the same history.

This is the difference between “Git-backed storage” and the fully fledged Git product Forge wants to be.

Required protection defaults:

- `main` is protected;
- outside contributors cannot push into the upstream repository;
- contribution path is fork/branch → PR;
- at least one non-author approval for protected repositories;
- unresolved “request changes,” conflicts, or a changed head invalidate approval;
- validation, licensing, and representative render checks must pass;
- `CODEOWNERS`-equivalent rules can require design, rules, or licensing review by path;
- `v*` release tags are protected and are real annotated Git tags;
- merge commits created by Forge are signed;
- permission, license, visibility, merge, and release changes are auditable.

Forgejo supports pull-request review requests through `CODEOWNERS`, commit signing, and protected-branch-aware merge signing. Its own security documentation also warns that branch protection is not enough when untrusted users can push arbitrary workflow branches; untrusted fork workflows require explicit trust controls. Use containerized, ephemeral workers with no repository secrets for any contributor-controlled build. See the [Forgejo pull-request guide](https://forgejo.org/docs/v15.0/user/collaboration/pull-requests-and-git-flow/), [PR workflow security](https://forgejo.org/docs/latest/user/actions/security-pull-request/), and [instance commit signing](https://forgejo.org/docs/latest/admin/advanced/signing/).

Roles should be understandable without Git knowledge:

| Forge role | Capability |
|---|---|
| Viewer | Read public/private project as invited. |
| Contributor | Fork, propose, comment, and upload within quota. |
| Designer | Maintain working branches and review game content. |
| Maintainer | Merge, manage releases, collaborators, and protection policy. |
| Owner | Transfer/archive/delete project and change legal/visibility settings. |

The current owner/collaborator boolean can be migrated into these roles. Ownerless demo repositories should be explicitly labeled disposable sandboxes, never behave like ordinary community-owned games, and never produce citable releases.

### 2. Repair project identity and discovery

The specification says a project is `{owner}/{slug}`, but the production registry currently keys repositories by bare slug. Two designers cannot safely own games with the same slug. Forgejo discovery is also limited to the first 50 topic results, while catalog requests fetch metadata repository by repository.

Before launch:

- introduce an internal immutable project UUID;
- make `(owner_id, slug)` unique;
- route projects as `/g/:owner/:slug` with redirects for renamed slugs;
- store the Forgejo repository ID, not only its name;
- page through all Forgejo results and process webhooks into a Postgres search index;
- serve catalog summaries from that index, not by opening every repository on every request.

The user’s “AI / big data”-style tags idea is correct, but call them **topics** or **facets**, not Git tags. Git tags already mean immutable release references.

Keep `game.yaml` canonical, then index a controlled discovery model:

- game type: card game, board game, roleplaying, wargame;
- mechanisms: drafting, deckbuilding, trick-taking, deduction, worker placement;
- mode: competitive, cooperative, solo, teams;
- theme: cyberpunk, fantasy, historical, abstract;
- players, playtime, complexity;
- maturity: idea, prototype, playtest, release;
- remixability/license;
- language and translation availability;
- tool compatibility: Sheets, nanDECK, TTS, print-ready;
- accessibility: color-independent, large-text, screen-reader rules.

Free-form aliases can coexist with controlled values, but the UI should present facets, not an empty tag box. Forgejo repository topics can mirror a subset for interoperability; they should not become the canonical schema.

### 3. Replace the giant generated application with a small shell

The first response should contain navigation and catalog skeletons, not every card and embedded asset.

Introduce APIs such as:

```text
GET /api/catalog?cursor=&q=&topic=&license=&players=
GET /api/projects/:owner/:slug
GET /api/projects/:owner/:slug/cards?cursor=&q=&type=&changed_since=
GET /api/projects/:owner/:slug/activity?cursor=
GET /api/projects/:owner/:slug/assets?cursor=&kind=
```

Use thumbnail URLs from object storage/CDN, responsive AVIF/WebP where appropriate, and lazy-load card faces. Do not base64-inline the catalog’s artwork.

Initial targets:

- less than 250 KB compressed app shell plus first catalog page;
- no full card renderer on the homepage;
- a paginated catalog and card grid;
- no main-thread render of dozens of production cards;
- clear loading, empty, retry, and partial-failure states;
- 44 × 44 px minimum primary touch targets;
- no horizontal overflow at 320, 390, 768, and desktop widths.

### 4. Move rendering and exports into bounded jobs

`execFileSync` currently lets a PDF or VTT export block the gateway. Cache generation can race, and a partially populated render directory can be mistaken for a cache hit.

Add an export-job model:

```text
job id
project id + commit sha
export kind + exporter version
status/progress/attempt
input hash
output manifest + checksums
created_by
resource budget
```

Workers must:

- materialize into a bounded temporary directory;
- run without platform secrets or access to internal networks;
- enforce CPU, memory, wall-time, file-count, pixel-count, and decompressed-size limits;
- write to a temporary object prefix;
- verify a manifest and checksums;
- publish atomically only after success;
- deduplicate `(project, commit, kind, exporter_version)`;
- retry known transient failures without duplicating artifacts;
- expose progress and a useful failure receipt;
- clean scratch space in `finally` and through a scheduled orphan sweeper.

Store generated files in object storage behind a CDN. Keep source artwork/fonts/native editor files in Git LFS. Add the actual `assets/** filter=lfs diff=lfs merge=lfs -text` rule to project scaffolds so CLI pushes follow the same policy as Forge’s API. Enforce the declared per-file and per-project quotas—the 2 GB repository cap currently exists as a constant but is not enforced.

The 12 GB test failure is the acceptance test for this work: a standard CI run must have a declared maximum disk budget and fail immediately with the responsible job if it exceeds it.

### 5. Make releases citable and atomic

The hosted release route currently writes a Postgres release row and warms derived artifacts. It does not create the annotated Git tag promised by the specification. Export warm failures are swallowed.

A release transaction should:

1. require protected-head checks and permission;
2. validate the entire project at the exact full SHA;
3. build required artifacts and preflight them;
4. record artifact names, sizes, hashes, exporter versions, and license receipts;
5. create and protect an annotated Git tag;
6. publish the immutable release record and event;
7. never move or overwrite that tag or artifact prefix.

If a required artifact fails, the release is not created. Optional artifacts may be marked failed with a visible receipt, but cannot silently disappear.

### 6. Put licensing at file and release level

One `license` string on `game.yaml` cannot describe a real project containing rules text, card text, commissioned artwork, fonts, icons, publisher source files, code, and third-party reference material.

Adopt a machine-readable rights manifest inspired by SPDX expressions and REUSE’s per-file licensing model. SPDX expressions can represent `AND`, `OR`, and exceptions; REUSE defines how copyright and licensing information can be attached to individual files. See [SPDX license handling](https://spdx.dev/learn/handling-license-info/) and the [REUSE 3.3 specification](https://reuse.software/spec/).

Forge needs:

- project-level default license for original expression;
- per-path or per-asset override;
- copyright holder and contributor attribution;
- source URL and exact imported revision/hash;
- asset status: original, commissioned, licensed, public domain, permission-only, unknown;
- trademark/brand notice separate from copyright license;
- font license and redistribution permission;
- whether forks, commercial use, and redistribution of source assets are allowed;
- a `LicenseRef-*` path for custom/proprietary terms;
- license compatibility checks when combining or remixing work;
- a publish gate that blocks unknown or incompatible assets;
- an immutable license/credits receipt in every release.

Private research fixtures may exist, but they must be excluded from public discovery, forking, and distributable releases unless their rights are documented. A “Proprietary test fixture” in the public catalog is not a launch-safe default.

Changing a project from private/proprietary to an open license is a high-impact owner action. It needs an explicit confirmation, audit event, and a clear explanation that already published releases cannot be un-published by changing the current branch.

### 7. Harden authentication, uploads, and network boundaries

The current password/session implementation is appropriate for a local prototype, not public registration. Session tokens live in browser local storage; all responses allow `Access-Control-Allow-Origin: *`; production exceptions can return raw internal messages; there is no email verification, recovery, session list/revocation, or 2FA.

P0 security work:

- use Forgejo OAuth/OIDC or a hardened identity provider instead of provisioning a parallel password identity when possible;
- use `HttpOnly`, `Secure`, `SameSite` cookies for browser sessions;
- implement logout, session revocation, email verification, recovery, and optional 2FA;
- exact same-origin CORS by default;
- CSP without a giant inline application script;
- HSTS, `X-Content-Type-Options`, frame policy, and referrer policy;
- request IDs and non-leaking production error envelopes;
- trusted-proxy-aware rate limits, with stricter auth/upload/export limits;
- service credentials with minimum scope and rotation, not one all-powerful long-lived token;
- SSRF protection for Sheet/URL imports across redirects and DNS rebinding;
- SVG sanitization, archive traversal/zip-bomb protection, image dimension limits, and media decoding in isolated workers;
- malware/content scanning hooks for public uploads;
- report, block, takedown, and moderator audit paths;
- Terms, privacy policy, community rules, support, and rights/takedown contact before public indexing.

Pin production images by digest and build an immutable gateway image. The current production Compose installs operating-system packages and `pg` at container startup and mounts the source tree. It also pins a floating Forgejo 11 image while current official documentation is for Forgejo 16. Upgrade only through a tested migration, but do not ship on an untracked floating major. Forgejo’s [current documentation](https://forgejo.org/docs/latest/) should be the compatibility baseline.

### 8. Finish the jam as a governed release workflow

A jam entry must be an immutable release, not whatever happens to be on a mutable project head when a judge opens it.

Minimum jam lifecycle:

- draft → scheduled → open → submission freeze → judging → published results → archived;
- server-derived status from timezone-aware timestamps, with an organizer override and audit event;
- organizer UI for theme, constraints, rubric, dates, team rules, licenses, and starter project;
- join creates a correctly licensed starter under the entrant’s namespace;
- eligibility can be checked continuously without submitting;
- submission pins a release/tag and preflight receipt;
- resubmission replaces the selected entry before the deadline but preserves history;
- team membership and credit are explicit;
- external entries are either fully supported and frozen by URL/hash, or removed from the launch UI;
- judging assignments, rubric scoring, comments, conflicts of interest, and finalization;
- optional blind judging and community choice with abuse controls;
- moderation, disqualification reason, appeal/contact path, and organizer audit log;
- a downloadable jam archive and permanent results page.

For the first alpha, Forge should host one curated card-game jam itself. Do not yet let any new account create a public jam.

## Third-party pipeline strategy

Forge should not try to replace every editor. It should define one safe promotion contract:

```text
external working copy
  → dry-run import/mapping
  → semantic + visual + license diff
  → validation/preflight
  → deliberate commit or PR
  → commit-pinned exports/publishers
```

Every adapter needs a manifest declaring:

- adapter ID and version;
- upstream tool/version tested;
- import, export, working-copy, or publish capability;
- supported component kinds and fields;
- fidelity/round-trip limitations;
- deterministic inputs and output hashes;
- credentials and network access required;
- file, memory, and time limits;
- license and provenance behavior.

There are five distinct connector types. Do not blur them:

1. **Snapshot importer** — CSV, XLSX, NRDB JSON, TTS save.
2. **Working-copy connector** — Google Sheets; changes remain draft until promoted.
3. **Source adapter** — nanDECK, Squib, Affinity, PnPInk; layout/source files round-trip with a fidelity report.
4. **Artifact exporter** — PnP, print package, TTS, Tabletop Playground.
5. **Publisher connector** — itch.io, The Game Crafter, mod.io; creates an external side effect and needs user authorization plus a release.

### Connector priority matrix

| Integration | Current state | Ship decision | Next exact move |
|---|---|---|---|
| CSV/TSV | Working | P0 | Add column mapping, typed preview, stable-ID warnings, saved mappings, and multi-table bundle import. |
| Google Sheets | Proven PoC | P0 private alpha | Stable HTTPS, Forge OAuth, multi-tab component mapping, installer package, privacy/support pages. Public Marketplace review comes later. |
| XLSX | Working file adapter | P0 complete | Keep deterministic multi-table export, Git-ref baseline recovery, bounded parser, atomic rendered dry run, and commit/PR regression coverage. Native Excel/LibreOffice automation remains out of scope. |
| Forge project ZIP | Working | P0 | Make it the documented backup/escape hatch; add format migration tests and an import receipt. |
| nanDECK | Working, family-aware | P0 | Keep; pin tested version and run golden visual round trips for all declared families. |
| Affinity | Production-template bridge exists | P0/P1 | Keep as a native source asset + binding bridge; do not promise lossless `.afpub` round trip unless the adapter proves it. |
| PnPInk | Beta working copy; v0.57 package pinned, 11 System Gateway families, deterministic data + SVG-source return | P1 | Certify real Inkscape/PnPInk reopen and golden print output on each supported platform before considering it an active renderer. |
| Squib | Implemented beta | P1 validation | Deterministic family ZIPs now carry canonical `cards.csv`, declarative `layout.yml`, a pinned Squib 0.19.0 starter, explicit fidelity, and three-way CSV/YAML return into dry-run → validation → commit/fork/PR. Forge never executes returned Ruby. Remaining work is human smoke testing in current Ruby/Squib installations and broader production-template fixtures. See [the adapter contract](squib-adapter.md). |
| Dextrous | File boundary only | P1 | Support its normal published-Sheet/CSV workflow and face/TTS outputs; do not invent a proprietary project round trip. Dextrous explicitly accepts CSV or published Google Sheets links ([official site](https://www.dextrous.com.au/)). |
| Component.Studio | File boundary only | P1 | Import/export canonical datasets, individual face ZIPs, PDFs, and TTS artifacts. It already exports images, PDF, TTS, and The Game Crafter ([official help](https://help.component.studio/article/580-cs2-export-design)); direct project sync is unnecessary unless a stable API appears. |
| Magic Set Editor | Missing | P2 | Add only after real user demand; sandbox parser and preserve templates as external source because the format is application-specific. The [official repository](https://github.com/twanvl/MagicSetEditor2) confirms its card/set and image-export role. |
| Tabletop Simulator | Working | P0 | Add preflight for RGB, sheet dimensions, hidden-card/back semantics, hosted URL reachability, and a smoke-tested setup save. TTS recommends RGB and roughly 4096 px textures ([asset guide](https://kb.tabletopsimulator.com/custom-content/asset-creation/)); custom decks use card sheets and special back behavior ([deck guide](https://kb.tabletopsimulator.com/custom-content/custom-deck/)). |
| Tabletop Playground | Working file adapter | P1 high value | Keep stable object-template GUIDs, local textures, exact deck/component staging, `.vts` state, deterministic ZIP, and receipt. Next evidence is a human import in the proprietary app and a captured receipt; mod.io publishing remains a separate authorized connector. Its packages are structured JSON/templates/assets and game states reference template IDs ([official package docs](https://tabletop-playground.com/knowledge-base/packages/)). |
| Tabletop Club | Working | Keep | Maintain, but do not prioritize over setup-ready TTS/Tabletop Playground without user demand. |
| VirtualTabletop.io | Working | Keep | Keep version-pinned staging and bundle faces; isolate its runtime and be explicit about GPL separation. |
| The Game Crafter | Working file adapter | P1 | Maintain the named 825×1125 RGB/300-DPI poker-card handoff, quantities, preflight, checksums, and printer-approval boundary. Direct API publishing remains a separate authorized connector. TGC requires individual PNG/JPG files, exact templates, safe zones, and bleed ([official card guide](https://help.thegamecrafter.com/article/399-how-to-make-a-card-game-tarot-deck), [templates](https://help.thegamecrafter.com/article/39-templates)). |
| itch.io | Missing | P1 | Export one deterministic release folder and show the exact `butler push` command. Server-side publishing can wait. Butler accepts a directory or ZIP and uses a user/game channel ([official manual](https://itch.io/docs/butler/pushing.html)). |
| BoardGameGeek | Missing | P2 metadata only | Search/link metadata after API registration; never treat BGG data or images as importable game assets. Public apps require registration/authorization and attribution ([official API guide](https://boardgamegeek.com/using_the_xml_api)). |
| Figma/Canva | Missing | Not now | Generic design-tool integration does not improve Forge’s commit boundary enough to justify OAuth, mapping, and fidelity complexity before traction. |

The Google add-on should remain private during alpha. Public Marketplace publication has a separate app review and OAuth verification process, expects a bug-free intuitive workflow, sign-out/revocation, support/privacy materials, and the narrowest scopes. Forge’s current scopes are appropriately narrow (`spreadsheets.currentonly`, container UI, and outbound request), but public distribution still requires the formal process. See Google’s [Marketplace review criteria](https://developers.google.com/workspace/marketplace/about-app-review) and [OAuth publication guide](https://developers.google.com/workspace/marketplace/configure-oauth-consent-screen).

## Assets Forge still needs to model

Forge can honestly launch card-game jams now. It cannot honestly claim complete board-game production until these are versioned, rendered, diffed, exported, and released end to end:

- boards and mats with folds/sections;
- tiles and punchout sheets;
- tokens, dials, trackers, and custom dice;
- standees/meeples and optional 3D models;
- boxes, tuck boxes, inserts, and packaging dielines;
- player aids, score sheets, campaign sheets, and stickers;
- component inventories/BOM and quantities by player count;
- setup diagrams and setup-ready VTT state;
- localization strings, translated layouts, and font fallback;
- accessibility metadata and alternative component treatments;
- audio or application code where a game genuinely requires it.

The existing generic `tokens.json` is a useful seed, but treating a board, die, and meeple as the same lightly typed record will become limiting. Evolve toward a component registry with shared identity/provenance plus kind-specific schemas and production profiles.

Printer/manufacturer profiles should be data, not hard-coded exporters:

```text
component kind + stock
trim and bleed
safe area
resolution and color space
front/back pairing
sheet imposition
cut/fold/score lines
file format and naming rules
quantity/packaging constraints
```

That lets one committed game build to home PnP, a local printer, or The Game Crafter without changing canonical content.

## Database and storage corrections

Before scale:

- replace full duplicated PR JSON snapshots with immutable Git refs/SHAs plus a derived diff cache;
- add foreign keys/cascades and indexes for sessions, events, notifications, jam entries, and project namespace;
- expire/revoke sessions and periodically remove expired rows;
- add project visibility, archive state, roles/invites, protection rules, moderation state, and audit events;
- add export jobs/artifacts and webhook delivery/idempotency tables;
- add typed topic tables with aliases and a Postgres search index;
- use full SHAs internally; short SHAs are display values only;
- make repository/webhook reindexing resumable and idempotent;
- record upstream connector IDs, revisions, adapter versions, and last successful promotion;
- encrypt OAuth/publisher credentials outside Git and never include them in portable project exports.

Backups must cover both truths:

- Store 1: Forgejo database, repositories, and LFS/object storage;
- Store 2: people, permissions, discussions, notifications, jam governance, and release/audit index.

“Rebuildable index” is only true for game metadata. Users, reviews, moderation, and conversations are not rebuildable from Git. Run and document a restore drill before launch, including a restore into a clean environment and verification of a release download.

## UX required for the golden paths

Forge should present four paths, each ending at the same trusted release boundary:

### Start from an idea

Intent brief → tiny playable scaffold → edit → first playtest → commit findings → release candidate.

### Bring an existing prototype

Choose source (Sheet, workbook, CSV, project ZIP) → map tables/columns → preview cards/components → resolve errors → commit import → connect optional layout source.

### Remix a permitted game

See what the license allows → choose exact release/commit → create independent edition → change any allowed source → optionally propose selected changes upstream → retain provenance and credit.

### Join a jam

Read machine-checkable constraints → fork starter or submit owned project → continuous eligibility status → pin exact release → judge/play/download that immutable entry.

Across all four:

- use “edition,” “proposal,” and “release” first; reveal branch/PR/tag terminology as secondary detail;
- show where work is saved and whether it is draft, committed, proposed, merged, or released;
- always display the exact version being previewed/exported/tested;
- make import and export failures recoverable without losing mapping work;
- show semantic, visual, rules, layout, asset, credit, and license changes in one review;
- explain permissions at the point of action;
- provide an activity/inbox path that lands on the thing requiring attention;
- support keyboard operation, visible focus, screen-reader labels, reduced motion, contrast, and non-color-only status;
- remove demo/test language and fixtures from the public experience.

## Recommended build order

### Launch slice A — trust the repository

1. owner/slug + immutable project ID;
2. Git-native branches/PR refs and protected `main`;
3. approvals/checks/path owners;
4. real annotated protected release tags;
5. per-file rights manifest and public publish gate;
6. tests for fork → multi-file PR → approval → merge → release → clone/verify.

This slice proves the central claim of Forge.

### Launch slice B — bounded delivery

1. small lazy app shell and catalog API;
2. paginated cards/assets/activity;
3. job queue and isolated render workers;
4. atomic object-storage artifacts;
5. quotas, GC, disk budgets, and clean CI;
6. auth/session/CORS/CSP/security hardening;
7. backup and restore drill, structured logs, metrics, and alerts.

### Launch slice C — designer alpha

1. CSV/XLSX/Sheets multi-table mapping;
2. private Google add-on installer with Forge OAuth;
3. TTS production preflight and setup-ready save;
4. portable project import/export recovery path;
5. topics/facets and maturity/license filters;
6. mobile and accessibility pass;
7. onboarding telemetry limited to funnel events, never unpublished game content.

Invite 5–10 designers here. Observe them without coaching.

### Launch slice D — first community jam

1. dynamic jam lifecycle and organizer console;
2. immutable release submissions and eligibility receipts;
3. team credit, judging, moderation, and results archive;
4. one curated card-game jam;
5. support response process and post-jam interviews.

Only after this succeeds should Forge add public jam creation, Tabletop Playground/TGC publishing, or broad non-card component support.

## Go/no-go checklist

Do not open public registration until all of these are true:

- [ ] A fresh clone can set up and pass the mandatory suite with one documented command.
- [ ] The fast merge gate is 100% green and stays within its declared time/disk/memory budgets.
- [ ] Expensive render/export tests run separately with clear artifact and budget reports.
- [ ] Two users can own the same slug under different namespaces.
- [ ] An external contributor cannot write upstream `main` or merge their own unapproved proposal.
- [ ] A reviewer sees semantic, visual, asset, rules, credit, and license changes at the exact current head.
- [ ] A release creates a real protected annotated Git tag and immutable checksummed artifacts.
- [ ] Public projects have complete rights/provenance; unknown assets are blocked.
- [ ] The initial catalog is small, paginated, and does not inline production card faces.
- [ ] Mobile has no overflow and primary controls meet touch-size/accessibility requirements.
- [ ] Exports run in isolated bounded workers and cannot fill the gateway disk.
- [ ] Session revocation, recovery, rate limiting, CSP, safe CORS, upload scanning, and non-leaking errors work.
- [ ] A backup restore reproduces a repository, its permissions/conversation, and one release.
- [ ] Sheet, CSV/XLSX, browser edit, and portable-project import all pass the same promotion contract.
- [x] TTS output passes automated structural, rights, texture-size, deterministic-regeneration, and setup-staging tests as an exact version. A human import smoke in the proprietary TTS client remains an operational launch check.
- [ ] Jam dates/statuses are server-derived; submission pins an immutable release; judging and moderation are auditable.
- [ ] Five unaffiliated designers complete the golden path without developer intervention.

## What not to build yet

- another bespoke card renderer before performance and worker isolation;
- continuous two-way Sheets synchronization;
- generic Figma or Canva OAuth integrations;
- lossless claims for proprietary native design formats that cannot prove round trip;
- server-held itch.io or manufacturer credentials before release bundles work;
- public arbitrary jam creation;
- AI generation as a discovery tag or launch headline;
- a social feed beyond activity directly tied to collaboration.

The highest-leverage next step is **Launch slice A: trust the repository**. Sheets and the production renderer proved Forge can connect creation tools to game output. Now Forge has to prove that every change, permission, review, license, and release behaves as reliably as the Git metaphor promises.
