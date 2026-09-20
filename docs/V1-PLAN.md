# Forge v1 execution plan

Accepted direction: 2026-09-20. This is the active engineering plan, not a
qualification receipt. Historical test counts and image digests do not qualify
the changes below.

## Product promise and scope

A small tabletop team can create, collaborate, review, and release an exact
version of its game, and recover its work, without developer intervention.
The next milestone is a dependable private pilot with five independent creators.
The five-person engineering team is separate from that cohort.

Keep the current Node/Python/browser architecture through v1. Profile expensive
operations, isolate blocking work, and extract narrow modules as needed. A Rust
worker needs a demonstrated bottleneck, a measured improvement, an output
compatibility proof, and an owner; a backend rewrite is outside this plan.

Use original or rights-cleared games. Keep card-game authoring, CSV/XLSX/Sheets,
review, exact releases, printing and selected playable/portable outputs in scope.
Do not add marketplaces, payments, school accounts, speculative connectors or
general infrastructure rewrites. A simple exact-release playtest page is a
candidate after the pilot identifies the largest remaining need.

## Ordered engineering slices

Each slice must have a bounded diff, focused positive and failure checks,
documentation of the resulting behavior, and an evidence entry below. Preserve
the invariants in [the handoff](DEVELOPER-HANDOFF.md) and use the protected PR
workflow in [CONTRIBUTING](../CONTRIBUTING.md).

| ID | State | Deliverable | Acceptance evidence |
| --- | --- | --- | --- |
| V1-01 | Merged and image published | Finish existing artwork loading and exact-file preview changes | Reserved image geometry; decoded pixels before ready; retry for missing/corrupt images; keyboard/mobile/reduced-motion coverage; filtering preserves focus and images; late responses cannot overwrite navigation; historical blobs and LFS preserve access/version boundaries. |
| V1-02 | Merged and main qualification passed; physical proof open | Repeatable home printing | Persisted, reviewed print recipe with actual insert dimensions distinct from sleeve exterior size, A4/Letter, gutters/shared cuts, fronts/duplex as supported, and calibration output. Verify exported geometry, frozen recipe identity, and a physical proof. Extend existing print infrastructure rather than adding a competing renderer. |
| V1-03 | Implemented; exact candidate qualification required | Discoverable recovery | This account's retained drafts can be found and exported with original base and staged artwork/metadata. Another account cannot see them; export changes no source. Exact-base restoration survives. Interrupted release states are visible with safe, evidence-based next steps. No silent replay of old drafts over newer source. |
| V1-04 | Merged; main qualification passed | Complete publication reconciliation | Read-only inventory across finalized/pending database publications, every sealed manifest/blob, and Git tag/source identity. Classify missing, contradictory, recoverable and unreferenced states. Both database drivers and failure fixtures pass; require the audit for backup acceptance and after restore; qualify the exact resulting image. |
| V1-05 | Implemented; exact candidate qualification required | Responsive long operations | Measure representative large-download memory, first-byte time and unrelated-request latency. Bound verification/delivery without serving unverified/corrupt bytes. Deliberate range/cancellation behavior, bounded concurrent jobs, and remaining request-time blocking work moved off HTTP handling. Show truthful progress/failure/retry. |
| V1-06 | Merged; main qualification passed | Simple first useful workflow | A named private project does not require a full design brief. A newcomer imports/reviews/commits cards, adds credited artwork, and downloads a proof. Preserve brief data, explicit import review, and Sheet attach versus commit distinctions. |
| V1-07 | Gate and receipt implemented; green merged-image run required | Integrate and qualify candidate | Clean-checkout setup; original-game two-user journey; current functional, type, browser and relevant storage/protocol tests; both protected CI gates; pinned commit, CI run, image digest, and output hashes in one receipt. Update maintained docs/catalog to match tested support. |

## V1 evidence gates beyond local engineering

These stay open until the actual evidence exists. Do not replace physical or
human evidence with a passing automated test.

- [ ] One supported private deployment: stable HTTPS, private access, configured
  durable stores, updates, named operator/support/rights contact, off-host backup
  and demonstrated restore. Respect the user's zero-spend constraint; do not
  activate paid infrastructure or send invitations without authorization.
- [ ] Validate advertised native outputs in the actual target app and record
  app/version, artifact hash and result. Label unqualified adapters experimental.
- [ ] Print and measure a calibration/proof sheet using the intended printer,
  paper and actual-size settings; record actual card fit separately from PDF
  geometry. Tiny nominal dimension changes are not physical measurement proof.
- [ ] The pinned Google Sheets add-on produces an attributed private-Sheet
  commit against the deployed candidate, as required by the current pilot.
- [ ] Complete [the five-creator protocol](CONTROLLED-ALPHA-PILOT.md): at least
  four finish, three without developer intervention, both paired runs produce
  reproducible releases, three express repeat-use intent, zero integrity stop
  conditions. Record a second iteration separately from stated intent.
- [ ] All accepted changes have fresh qualification evidence. No unpublished
  local fix, historical image receipt or skipped optional check is counted as
  deployed/qualified work.

## Execution record

### 2026-09-20 — baseline and start

- GitHub main and local base both identify `3f93573535725e802437d5309cf69f057d7e32c0`.
- Existing `codex/artwork-loading` work is uncommitted and is being preserved
  and reviewed. It includes browser loading/retry coverage and exact repository
  blob reads. No current-candidate qualification is claimed yet.
- The shell selects Node 26 and the shared Python environment selects 3.14;
  prepare an isolated qualified toolchain before treating results as matching
  the documented Node 24.20.0 / Python 3.11 baseline.
- Selected an isolated, checksum-verified Node 24.20.0 and a checkout-local
  Python 3.11 environment with repository dependency pins. The shared original
  Python environment and live runtime data were preserved.
- V1-01 local evidence: doctor and typecheck passed; 67 exact repository-file
  checks passed; all seven artwork loading browser scenarios passed, including
  320/390px layouts, reduced motion, corrupt images, retained focus and stale
  responses. Added a native keyboard-operable asset detail button.
- Decoded preview asset checks passed, including deliberate corrupt font/image
  failures. Full creator browser workflow passed. Functional suite: **208 passed,
  0 failed**. These are local candidate checks, not image/host qualification.
- Next action: submit V1-01 through both protected CI gates; begin V1-02 on a
  separate branch while preserving the reviewed candidate.
- PR #6's first image gate stopped at the unavailable Docker Hub MinIO
  repository before running recovery. The official Quay registry resolves the
  **same** pinned digest (including amd64 and arm64 manifests); the registry
  location is corrected without changing image bytes. Fresh CI qualification
  remains required; the failed run is not a recovery pass.
- The next image run reached the real Forgejo journey and exposed an expired
  sample-jam window. The drill now mounts an isolated, current-dated copy of
  jam content into both production-mode containers. Production clock guards
  and actual repository event dates remain intact; the restored copy uses the
  exact same fixture. A future-date regression covers this test setup.

### V1-02 — home printing merged

- Extend the existing saved print profile with optional orientation and explicit
  custom insert dimensions. See [Home printing](HOME-PRINTING.md) for the user
  workflow; the format rationale appears below.
- Direct home downloads must follow the saved insert selection. New exporter
  filenames keep existing URLs and sealed release bytes unchanged.
- Local geometry checks cover A4/Letter shared cuts, exact dimensions, partial
  sheets, landscape/portrait duplex mirroring, and two-axis calibration.
- The real browser workflow passes at 390 px: unit conversion, shared cuts,
  review/revise/commit, saved-size downloads, calibration, unchanged older cache
  bytes, and bundled help. Python PDF checks and strict JavaScript schema
  validation pass. A4/Letter cards and calibration sheets were rendered and
  visually inspected, including the last A4 card sheet.
- PR #7 passed both protected gates at `772a13d` (run `35509702979`) and
  merged as `bdf4aaaaab608b5d8b7181048ffb85522e896aec`. Main run
  `35510245242` qualifies its own image. Local evidence: 209 functional tests,
  full creator browser flow, both journeys, performance checks, and 111 checks
  on each database driver. The local Docker PostgreSQL fixture exited early;
  conformance passed on an isolated native PostgreSQL 16 instance.
- Physical printing and sleeve fit remain pending human evidence.

## Format compatibility and release identity

The optional `home.orientation` defaults to `portrait` for existing recipes.
`home.sleeve_profile: custom` requires `home.insert_mm.w_mm` and `h_mm`; those
fields are rejected for another profile to avoid ambiguous active dimensions.
Custom dimensions must fit both supported papers with at least 6 mm margins.
Existing recipes need no migration. Older Forge versions cannot validate the
new choices; upgrade Forge before editing projects that use them.

Print exporter version 3 uses `v3-print-…` artifact names. Changing the exporter
does not replace an older artifact at the same URL. Published old releases
continue to use their sealed files and receipts. The manifest's `home_downloads`
records which sheet, orientation, cut dimensions and calibration files were
selected; PDF geometry and actual physical fit are separate evidence.

- V1-01: PR #6 merged as `f1d61953cc7c7da9b5a10fd229931cca9c60c79c`.
  Both protected PR checks passed at `e012250`; main run `35509157013`
  passed and published `ghcr.io/malinjawi/forge-platform` at digest
  `sha256:e8b63c97f93f9c9e86e1b3d4f2eb286d0364bc0acabfabe245b7da1873c6da1e`.
  This receipt qualifies that artwork commit, not newer source or a live host.
### V1-03 — retained draft discovery

- The account menu opens a browser-local recovery list for the signed-in account,
  including older card-family and Piece Studio records. Exports retain the
  original envelope, exact base, source hash when present, staged artwork bytes,
  credit/rights metadata, card/layout data and piece/setup state.
- Recovery JSON is an uncommitted copy, not an automatic import or a shared
  project commit. Original records remain intact. Older-base replay still needs
  a deliberate comparison; exact-base Studio restoration remains the existing
  explicit action.
- Focused browser evidence covers account isolation, real original-base card
  drafts, export byte/metadata preservation, piece/setup state, keyboard and
  mobile use, stale navigation, storage failure/retry and no source writes.
- Interrupted-release discovery depends on the cross-store inventory in V1-04.
  It remains open; this draft slice does not complete V1-03.

- V1-03 local browser qualification also passed the complete creator workflow,
  including exact-base restoration and stale-base refusal. The focused test
  verifies expired-session refusal and keeps the account menu within a phone
  viewport. Integration with current main still requires protected CI.

### V1-04 — complete publication inventory candidate

- Read-only audit joins finalized and pending database records to every sealed
  manifest/blob and exact Git source/tag evidence, including original publisher,
  event identity, protected tag object and original publication metadata.
- Frozen Forgejo mode reads its existing PostgreSQL schema and bare repositories
  while both writers remain stopped. Production backup requires this audit;
  the exact-image restore drill repeats it before either restored writer starts.
- Local evidence: 21 inventory checks passed on SQLite and PostgreSQL; existing
  storage conformance passed 111 checks per driver. Real bare-Git adapter checks,
  backup failure/restart guards, and static types passed. Real Forgejo/image
  qualification is still required; these checks do not prove a deployed host.
- Draft recovery PR #8 passed both protected gates at `f73ddbc` (run
  `35510379101`) and merged as `bc12e59eae99802bbc5fd813a1ebc64a4bc290d5`.
  Main qualification is separate. Print main run `35510245242` passed.
### V1-06 — a smaller first step

- Empty-game creation needs a working title and keeps the private default.
  Optional briefs remain available and preserve the full existing schema.
  Empty projects contain no invented card or brief, and open the existing
  first-card review/commit workflow. Sheet attachment also starts empty.
- Creation is a named keyboard-accessible dialog. A late CSV preview cannot
  enable a commit after its source text changes or after a different modal opens.
- Real-browser title-only private creation, first-card review and commit,
  optional brief preservation, 320/390px sizing, keyboard focus, stale CSV
  refusal and the existing Sheets connector failure suite passed. Static types
  passed. Protected integration qualification remains pending; no deployment or
  creator study is claimed by these implementation changes.

- Publication inventory PR #9 passed both protected gates at `f23e11c`
  (run `35511293860`) and merged as `0ef07c09e3643ac517b3d8e1819dda5db879fdc6`.
  Source and restored inventories passed against the real pinned Forgejo image.
- The first V1-06 product check found an old browser assertion for the renamed
  starting option. It now verifies the new empty-game default and hidden optional
  brief. A fresh full product run is required; the prior image pass alone does
  not qualify the new commit.

### V1-03 / V1-05 / V1-07 — final engineering integration

- Release recovery discovers owner-visible interruptions through a read-only
  inventory worker and resumes only the original publisher's exact sealed
  manifest. Browser tests cover source advancing, absent/corrupt evidence,
  account isolation, original bytes, mobile layout and stale navigation. The
  complete creator browser workflow also passed locally.
- Download delivery verifies before serving, streams bounded snapshots, handles
  cancellation and overload, and isolates whole-release work in bounded workers.
  See [the contract and measured fixture results](DOWNLOAD-DELIVERY.md).
- Publication inventory main run `35511932458` passed and published its image.
  Simple-start PR #10 passed run `35512103087` and merged as `a1dc8a7`.
- A later CI functional run hit an occupied random port: Forge moved to the next
  port, while the harness still queried the old one. The harness now follows
  only its own child's announced port before health checks. This is a test
  reliability fix; no failed run is counted as a qualification pass.
- The adapter catalog now records the TTPG beta file contract and CSV receipt
  version 3. The handoff describes implemented work and remaining external
  evidence. CI receipts retain actual restored artifact hashes alongside the
  exact source/image identities. Fresh integrated gates are required before
  this candidate can be marked qualified; public launch remains outside this
  engineering milestone.

- Simple-start main run `35512711224` passed both gates and image publication.
  Release-recovery PR run `35512865578` passed both gates before the final
  handoff/receipt changes; those additions require a fresh run. The plan's state
  table records implementation, while the downloadable receipt qualifies one
  exact commit. It must not be inferred from the table alone.
