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
| V1-01 | Locally verified; integration pending | Finish existing artwork loading and exact-file preview changes | Reserved image geometry; decoded pixels before ready; retry for missing/corrupt images; keyboard/mobile/reduced-motion coverage; filtering preserves focus and images; late responses cannot overwrite navigation; historical blobs and LFS preserve access/version boundaries. |
| V1-02 | Pending | Repeatable home printing | Persisted, reviewed print recipe with actual insert dimensions distinct from sleeve exterior size, A4/Letter, gutters/shared cuts, fronts/duplex as supported, and calibration output. Verify exported geometry, frozen recipe identity, and a physical proof. Extend existing print infrastructure rather than adding a competing renderer. |
| V1-03 | Pending | Discoverable recovery | This account's retained drafts can be found and exported with original base and staged artwork/metadata. Another account cannot see them; export changes no source. Exact-base restoration survives. Interrupted release states are visible with safe, evidence-based next steps. No silent replay of old drafts over newer source. |
| V1-04 | Pending | Complete publication reconciliation | Read-only inventory across finalized/pending database publications, every sealed manifest/blob, and Git tag/source identity. Classify missing, contradictory, recoverable and unreferenced states. Both database drivers and failure fixtures pass; require the audit for backup acceptance and after restore; qualify the exact resulting image. |
| V1-05 | Pending | Responsive long operations | Measure representative large-download memory, first-byte time and unrelated-request latency. Bound verification/delivery without serving unverified/corrupt bytes. Deliberate range/cancellation behavior, bounded concurrent jobs, and remaining request-time blocking work moved off HTTP handling. Show truthful progress/failure/retry. |
| V1-06 | Pending | Simple first useful workflow | A named private project does not require a full design brief. A newcomer imports/reviews/commits cards, adds credited artwork, and downloads a proof. Preserve brief data, explicit import review, and Sheet attach versus commit distinctions. |
| V1-07 | Pending | Integrate and qualify candidate | Clean-checkout setup; original-game two-user journey; current functional, type, browser and relevant storage/protocol tests; both protected CI gates; pinned commit, CI run, image digest, and output hashes in one receipt. Update maintained docs/catalog to match tested support. |

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
