# Forge retrospective — September 11, 2026

Forge has become a connected authoring and collaboration product with substantial safeguards around exact versions. Its strongest next opportunity is helping a small creator team complete repeated iterations with less confusion and rework. That is a product hypothesis to test, not evidence that adoption is already solved.

This review covers the six application commits from published beta baseline **e1c2d9c** through **d7bc4ba**. It draws on the source, the prior task record, independent product/integrity reviews, and a fresh local preview. Synchronization and qualification are tracked in [PR #2](https://github.com/malinjawi/tabletop-format/pull/2). See [the handoff](FORGE-HANDOFF.md) for architecture and historical evidence. Current code, published code, qualified image and deployed service are separate states.

## Where we are

| Area | Current assessment | What proves the next step |
| --- | --- | --- |
| Authoring engine | Broad capabilities: cards, shared design, rules, art, decks, pieces and table setup. | Ordinary creators complete the useful path without needing the internal model explained. |
| Review and collaboration | Exact-baseline drafts, real contributor proposals, credited merge and release paths. | New creator and contributor can each identify what is draft, saved, proposed and released. |
| Production and interoperability | Extensive print/data/tabletop outputs with explicit supported subsets. | Native application smoke tests, physical proof acceptance and selected complete outside-editor workflows. |
| Release integrity | Durable bytes, original publisher metadata, protected-tag checks and interrupted-publication recovery. | Complete inventory reconciliation across database, Git and vault, followed by latest-image backup/restore. |
| Public software baseline | e1c2d9c passed protected CI and was published to GHCR. | Newer source must pass its own exact-head product and image/recovery checks. |
| Local usability | First-card, first-table, recovery and input handling improved substantially. | Repeated unassisted task completion; source and automated browser checks cannot establish this alone. |
| Demand | No completed outside-creator cohort evidence was located. | Creators voluntarily return and produce version two of their own game. |

The latest direction remains to improve the software locally and leave real-host deployment aside. Do not turn this retrospective into another expansion of editor, adapter, marketplace or enterprise scope.

## What went well

**We connected the parts.** The six-commit sequence moved from the first card-system workflow to exact proposals, recoverable drafts, the first playable table, pinned component/playtest evidence, and durable releases. The useful unit of progress became a creator's complete task.

**The same version follows the work.** The strongest product promise is change → visual review → accepted version → output → playtest evidence. Stable identities and explicit baselines reduce the ambiguity of which file or card version someone actually reviewed or played.

**Reliability addressed real failure modes.** Work survives reloads, accounts cannot share recovery drafts accidentally, stale saves cannot silently replace newer work, proposals preserve accumulated intended edits, and releases refuse corrupted evidence rather than quietly regenerate different bytes. Tests exercise interruption, changing source HEAD, tag replacement and mixed metadata. These are more meaningful than a large count of isolated helper tests.

**Storage was corrected when the product promise demanded it.** A render cache can be discarded; a published game's files cannot. The separate vault and publication journal make that distinction explicit. Older vault bytes remain compatible while the newer envelope seals publication and publisher metadata.

**Existing creator tools still fit.** CSV, XLSX, Sheets and bounded native-editor handoffs preserve familiar ways of working. The in-house editor remains central, consistent with the founder's direction, while external formats do not need to become universal or lossless to be useful.

**Limitations are increasingly explicit.** File handoff is not account publishing. Structural PDF/X checks are not independent printer acceptance. A schema-valid TTPG package is not a human import/play test. Preserving those distinctions makes future qualification more credible.

## What cost us time or made the project harder to understand

| Pattern | Consequence | Change to how we work |
| --- | --- | --- |
| Readiness summaries outlived their commits | Old counts, URLs and image digests looked current; features already built appeared in later “missing” lists. | Record application SHA, test environment, run link and remaining boundary together. Update one current handoff per milestone. |
| Multiple worktrees and temporary runtimes | Latest source, published source and the listening application diverged. Game state remained in a temporary directory. | Keep one explicit active development line and persistent preview state; preserve historical branches as archives. |
| Broad capability preceded unfamiliar-user evidence | It became easy to improve another editor while the actual adoption obstacle remained unknown. | Measure one repeated end-to-end iteration before adding scope. |
| Engineering language reached the first-run UI | New creators face permanent IDs, Git references, versioned paths and component-system concepts before the payoff is clear. | Keep the technical model available for advanced users; teach draft, saved change and released version in the ordinary path. |
| Green tests were sometimes treated as a completion verdict | Important review findings still appeared after passing suites, and operational evidence was generalized too far. | Independent review plus observed workflow; state exactly what each gate does and skips. |
| Long sessions accumulated too much narrative | Context failures made recovery depend on archaeology. | Short milestone record: result, evidence, open work, next step. Keep machine details and private state outside public docs. |

The large server and frontend files add change risk, but a general rewrite is not the immediate answer. Extract a narrow boundary when an actual change needs it, and preserve the existing workflow through tests.

## What was still in the works

These findings are confirmed in source or explicitly documented. They are not all reproduced user failures, and no new undocumented data-loss defect was established by this review.

| Priority | Work item | Current boundary | Acceptance for a completed slice |
| --- | --- | --- | --- |
| P1, public-launch gate | Complete publication reconciliation | Vault audit checks files it can see; backup/restore do not inventory every finalized, pending and sealed-only publication against DB and Git/tag evidence. | Classify all publication states, detect missing/mismatched evidence, preserve recoverable records, and run the same audit before accepting backup and after restore. |
| P1, user trust | Truthful Sheets creation outcome | New-game flow catches failed connection/pull, then unconditionally announces the Sheet working copy was connected. | Separate project creation, successful connection and successful pull outcomes; failed setup offers an accurate recoverable next action. |
| P1, usability | Discover and resume interrupted releases | Recovery exists when the same release POST/tag is retried; the UI has no pending/recovery discovery flow. | Maintainer can see an interrupted publication, understand its state and resume from original evidence without re-exporting. |
| P2, performance | Large-PDF delivery | Release reads and hashes an entire file synchronously and responds with a whole Buffer; no range handling in those download routes. | Measure bounded memory and unrelated-request latency, cancellation and ranges with representative PDFs while preserving integrity/access guarantees. |
| P2, onboarding | Remove fixture-specific guidance | Shared-design help contains hardcoded “77-card impact” and “77 copied cards” for arbitrary games. | Guidance reflects the current game or uses accurate generic language; test a small original prototype. |
| P2, workflow | Recover older-version drafts deliberately | The recovery dialog says an older draft needs comparison but offers keep/discard without a direct compare/reapply action. | A creator can compare, apply compatible changes and resolve conflicts without losing the recovery copy. |

Relevant evidence: [deployment reconciliation boundary](../deploy/DEPLOY.md), [vault CLI](../tools/release-vault.mjs), [restore verifier](../tools/restore-verify.mjs), [release storage](../platform/release-vault.mjs), [server](../server.mjs), and [browser template](../tools/hub_template.html).

The current first-run source also shows four idea fields before the first card, technical first-card review language, and seven primary plus seven additional project tabs. Those are observable interface facts. Whether each harms completion is a usability hypothesis requiring a browser session with someone unfamiliar.

## What can plausibly work

These are hypotheses grounded in what Forge already does; this retrospective does not claim new market research or established demand.

| User and job | Why the fit is plausible | Evidence that would change our confidence |
| --- | --- | --- |
| One designer and one collaborator iterating a card prototype | Spreadsheet import, shared visual changes, credited review and exact PnP output cover one recurring job. | They create a second version with less coordination and voluntarily return for the next iteration. |
| A player proposing one card wording or balance correction | A visible card change and safe proposal reduce contribution risk. | An unfamiliar player succeeds without being taught forks, branches or commits. |
| A designer distributing a consistent playtest version | Frozen output and pinned reports connect feedback to the materials actually used. | Testers reopen the original build after later edits and can identify the version their feedback concerns. |

The first is the most practical immediate test because it needs one small team and an existing prototype, not a public network. It still supports the player-to-designer adoption direction. Broad Dextrous parity can remain a long-term capability ambition without becoming the weekly success measure.

## The next useful local iteration

Use one small original prototype already supplied or created for testing. Keep the sequence fixed:

1. Bring twelve cards or create the first small card set.
2. Change content and shared style, then inspect the actual proof.
3. Reload and recover unfinished work.
4. Have a collaborator propose one change; review and merge it.
5. Release an exact PnP version.
6. Make a later edit, then download the old release and record the next playtest against the correct version.

Proposed usability targets, not existing certification: first correct proof within ten minutes, first reviewed change within fifteen, complete paired loop within forty-five, and both people can explain draft/saved/released state. Zero lost edits, false success, stale overwrites or artifact mismatches. Record time and assistance before deciding what to simplify.

For engineering, finish publication reconciliation as one bounded integrity slice. Fix truthful outcome/recovery guidance alongside the corresponding user path. Then improve large-file delivery with measured resource limits. Avoid bundling a new editor or another export format into those changes.

The later [five-person pilot](CONTROLLED-ALPHA-PILOT.md) retains its existing thresholds: at least four complete, at least three unassisted, both paired runs reproduce releases, at least three intend reuse, deployed Sheets works, and no integrity stop condition occurs. Observed return for version two is stronger evidence than stated intention alone.

## Verification and publication record

- Historical d7bc4ba task result: 205 functional checks, 112 Forgejo journey assertions, 111 database checks on both engines, browser journeys and concurrent PostgreSQL startup. These are prior-run claims, not automatically fresh qualification.
- September 11 retrospective verification uses a detached d7bc4ba checkout so documentation commits and the live preview cannot alter the source-under-test. Local tools are Node 26.0.0 and Python 3.14.7; doctor and typecheck passed at review start. Fresh local verification completed: 205 functional checks, 109 local two-user assertions, and 234 browser assertions passed with no browser errors. The local journey has three fewer assertions than the Forgejo variant; do not conflate the counts.
- The first PR CI attempt passed the exact-image recovery job, including 64 restore checks, but exposed a browser-harness race after saving a print profile: hash-only navigation left an 800 ms page reload pending, and a subsequent test call reached the new document before its functions loaded. The follow-up waits for the actual save-triggered navigation before continuing; assertions remain intact. Current-head CI must pass after that correction. This illustrates why local green and production-toolchain qualification remain separate.
- The protected CI toolchain is Node 24.20.0 / Python 3.11. Use the latest pull request's exact-head results for product/protocol and exact-image/recovery status. A green earlier commit does not qualify a later code change.
- Current GitHub evidence is discoverable from [pull requests](https://github.com/malinjawi/tabletop-format/pulls) and [Forge qualification runs](https://github.com/malinjawi/tabletop-format/actions/workflows/quality.yml). Final fresh results belong in the task completion record and the corresponding PR checks, rather than an undated test-count badge.
- Publication is not a real-host deployment. Even a green exact-image fixture restore does not remove the explicitly documented all-publication reconciliation gate, native/physical qualification or outside-user evidence requirements.

The desired outcome of the next phase is a creator independently saying: “I changed my game, my collaborator understood the change, and we can reliably play and retrieve the version we meant.”
