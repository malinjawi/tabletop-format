# Forge controlled-beta readiness audit

Status: 2026-09-03

Candidate commit: `700c2cf28b39f22b0e9e655844413e48fd36f209`

Qualified local image: `sha256:5fbf5711b47ae6e11d362c1c53d3cff335b29c0c04e60e5344d05eae01ca2f0d`

Decision: **HOLD for outside invitations. The software candidate is qualified;
the deployed service and human product evidence do not exist yet.**

This audit distinguishes an implemented workflow from an operating beta. A
green local test cannot prove DNS/TLS, the real R2 account, off-host recovery,
the installed Google connector, operator response, or whether a stranger can
use the product without developer coaching.

## Requirement-by-requirement evidence

| Planned outcome | Authoritative current evidence | Verdict |
|---|---|---|
| Reproducible and maintainable application | `.github/workflows/quality.yml` defines a SHA-pinned two-leg gate. `deploy/qualified-images.env` pins six multi-platform dependencies. `deploy/bootstrap.mjs` atomically creates a new shell-safe deployment configuration and ten mode-protected secret files, defaults to the qualified infrastructure digests, ingests R2 credentials without disclosure, leaves the first-boot service token empty, and refuses overwrite. Forgejo installation secrets are generated through its real pinned CLI in a networkless, read-only, capability-free container; both the simulated safety test and real CLI path pass. Its output passes the production preflight. `npm run test:production-image` built the source-labelled candidate and passed 95 real Forgejo/PostgreSQL/S3 journey assertions plus a 54-check fresh-service restore. The strict clean-tree `launch-gate.sh` completed, and the production dependency audit reports zero vulnerabilities. | **Software PASS; operating evidence missing.** The candidate and this audit remain local, so hosted CI has not run them and no registry digest has been promoted. |
| Self-serve Sheets/CSV onboarding | Browser smoke imports non-Forge CSV headers only after a visible mapping and typed up-to-three-card preview, blocks an unreviewed commit, verifies permanent IDs, preserves the exact mapping/source hashes in the repository, adds artwork, captures creator/license/redistribution before upload, and repairs a fail-closed legacy rights blocker without direct API use. Mapping choices persist by header shape without retaining unpublished rows. The real sidebar withholds Attach until a public endpoint, identity, target game, mapping, and commit access pass. It rejects localhost before credentials are sent, explains dead tunnels, preserves a user-private resumable proof, rolls shared Sheet properties back after failed attachment, clears the password field, links back to the exact game, and always returns from Connection to the candidate. The real `Code.gs` passes 37 assertions; Chrome exercises the visible failure and success states. A deterministic private-beta packager pins the public Forge origin, Apps Script allowlist, three OAuth scopes, exact Git revision, exact `clasp` version, and every shipped file hash; 18 package/install-safety assertions pass. | **CSV, connector UX, and private-beta distribution package PASS locally; live Sheets deployment incomplete.** An operator must supply the stable HTTPS origin and operator-owned Apps Script/Cloud project, deploy the package, and complete one real Sheet-to-Forge commit. Marketplace review is deliberately not a pilot prerequisite. |
| Polished two-person contribution-to-release flow | Local and protocol journeys passed 96 assertions: explicit account-policy evidence, private-data export controls, independent edition, isolated edits, semantic/file/visual proposal, protected review, proposer-authored merge, preflighted rights-blocked release, exact downloads, notifications, and later release reproduction. A real two-browser smoke proves that the proposer sees only discussion/close, the owner sees review, merge stays disabled until approval, and accepted content lands exactly. The same core journey passed 95 assertions against real Forgejo during image recovery. | **Mechanism and browser path PASS; unaffiliated usability unproven.** Automated actors are not evidence that outside creators understand the flow. The required five-person record currently returns `HOLD` with 0/5 completions. |
| Enforceable rights and production-ready pilot operations | Artwork provenance is collected before bytes enter through the UI. Unknown/private/restricted files block release; licensed claims require a source or permission record. The exact-version preflight names blockers and lets the owner repair file declarations in place before any render work. Per-file hashes, protected tags, and receipts survive restore. Production startup is HTTPS-only and uses expiring, revocable, single-use invitations whose bearer tokens are never stored. Registration presents conspicuous links and an unchecked acceptance control; the server requires the current policy-set identifier and atomically snapshots the exact rendered Terms, Privacy Notice, Community Rules, hashes, notice, timestamp, account, and application build with invitation redemption. Missing acceptance cannot consume an invitation, and each participant can inspect the receipt through `/api/me`. The operator can run `pilot-account policy --handle … --require-current` to cryptographically verify the stored snapshot against the deployment's current rendered policy set without printing policy bodies, account email, credentials, or token digests; changed runtime policy values and tampering both fail closed. A signed-in participant can download an allowlisted, non-cacheable JSON copy of their platform account, policy evidence, authorship, social, connector, and operator-event data from the account menu. Anonymous access fails, and password/token material, repository snapshots, and generated artifact bodies are structurally excluded; portable game source remains a separate project download. Correction, deletion, retained-log requests, and provenance-preserving exceptions stay with the named operator instead of being silently automated. Operator-assisted password recovery also uses expiring, revocable, single-use bearer tokens stored only as digests; redemption atomically changes the password and revokes every active session. An operator can suspend and restore a participant without deleting identity, authored work, or credit: suspension atomically revokes sessions and recovery tokens, blocks login without disclosing account state, and records an immutable operator/reason event. The pilot evaluator opens the production preflight and Sheets package receipts and forces `HOLD` if their commit, origin, image digests, clean-source claim, package files, or hashes do not match the cohort candidate. A real 390-pixel browser proves acceptance, data download, registration, and recovery, while invalid/replay/expiry/revocation, simultaneous invitation redemption, and concurrent login/suspension cases pass on both database engines. `deploy/backup.sh` freezes writes and independently snapshots Forgejo, both PostgreSQL databases, acceptance, invitation, recovery, and access-event history, plus the remote LFS bucket; the disposable drill restored the personal-data export, reproduced every frozen release byte, and independently reverified the operator receipt through the exact candidate image. | **Mechanism PASS; real operations incomplete.** These records are stronger evidence of assent and content rights, not jurisdiction-specific legal verification. The deployed policy set still needs the real named operator/contact, the actual host/R2 online preflight and off-host restore evidence are absent, and no operator has accepted on-call responsibility. |

## Exact internal qualification result

The strict gate at the candidate commit produced:

- dependency audit: 0 production vulnerabilities;
- 13 adapter contracts: 5 stable, 8 explicitly limited;
- 186 functional integration tests, including 37 assertions through the real
  Apps Script connector plus browser-executed sidebar recovery states;
- 12 focused CSV mapping contract checks plus a real-browser noncanonical-header
  import, 320-pixel layout check, and exact committed-receipt verification;
- 18 deterministic private-beta add-on package checks covering origin locking,
  OAuth scopes, URL allowlisting, Git/source receipt integrity, and safe failure;
- 96 local plus 96 protocol collaboration assertions, with 95 against real Forgejo in the production-image drill;
- 69 Store-2 contracts on SQLite and the same 69 on digest-pinned PostgreSQL 16,
  including atomic policy acceptance, single-use invite redemption, password recovery, and
  suspension; expiry, revocation, replay rejection, full session invalidation,
  plus simultaneous invitation-redemption and login/suspension races;
- one real narrow-browser account-access flow proving conspicuous unchecked
  acceptance, exact policy snapshots, safe personal-data download, invitation registration, credential
  clearing, assisted recovery, old-session invalidation, new-password
  login, one-use token rejection, suspension, restoration, and safe access-event
  inspection;
- five bounded performance/concurrency checks;
- 29 production topology, secret, image, CI, and recovery invariants;
- one remote S3 LFS object independently backed up and restored;
- 54 post-restore checks plus an independent operator receipt verification,
  including retained account-policy receipts, the real restored Git remote and exact PnP, press/A4/Letter, TTC, TTS,
  portable-project, card-sheet, back, and rights-receipt bytes.

The final line was:

```text
PRODUCTION IMAGE QUALIFIED — sha256:5fbf5711b47ae6e11d362c1c53d3cff335b29c0c04e60e5344d05eae01ca2f0d records 700c2cf28b39f22b0e9e655844413e48fd36f209 and reproduced the frozen release after restore.
```

The local developer service was restarted afterward and passed all 13 read-only
readiness probes at `http://127.0.0.1:4897`. Its intended catalog is Cards
Against Humanity, Secret Castro, Secret Hitler, and private System Gateway.

## Inputs required to finish the controlled beta

These require the owner/operator; they cannot be safely invented in code:

1. Authorization to push the qualified local history to the GitHub remote and
   observe both hosted qualification jobs.
2. A deployment host plus two controlled DNS names: one for Forge and one for
   Forgejo. The operator must control TLS renewal and retain the public origin
   because released play packages embed it.
3. A Cloudflare R2 account ID and a dedicated empty LFS bucket. Put the scoped
   access and secret keys in the documented local secret files; never paste
   them into a chat, command history, Git, or `.env`.
4. The accountable operator name, public support/privacy/moderation/takedown
   email, and ACME alert email for runtime policy/configuration.
5. An operator-owned Google Apps Script/Cloud project for the private connector.
   Run the package command from `docs/google-sheets-deployment.md` with the
   stable origin and operator script ID, then follow the generated receipt and
   runbook. Marketplace publication and OAuth verification
   can remain post-pilot. The live connector must target the stable Forge
   origin, not a disposable tunnel.
6. Exactly five outside participants matching the roles in
   `CONTROLLED-ALPHA-PILOT.md`.

Once those inputs exist, completion evidence is: hosted CI green; registry
digest promoted; online preflight JSON green; synchronized real-host backup
restored into fresh services and a fresh R2 bucket; deployed two-person smoke
green; live Sheet commit green; and `npm run pilot:report` returning `PROCEED`
under the v2 cohort contract, with no integrity stop condition.
