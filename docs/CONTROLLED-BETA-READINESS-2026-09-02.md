# Forge controlled-beta readiness audit

Status: 2026-09-02  
Candidate commit: `ccc883cc36a05e9b7c1d7e5e9bec45cacf146896`  
Qualified local image: `sha256:92f53df9c5cad7276e4150a5d71bee9e9f06667a0a08f401779449ea84fe8d15`

Decision: **HOLD for outside invitations. The software candidate is qualified;
the deployed service and human product evidence do not exist yet.**

This audit distinguishes an implemented workflow from an operating beta. A
green local test cannot prove DNS/TLS, the real R2 account, off-host recovery,
the installed Google connector, operator response, or whether a stranger can
use the product without developer coaching.

## Requirement-by-requirement evidence

| Planned outcome | Authoritative current evidence | Verdict |
|---|---|---|
| Reproducible and maintainable application | `.github/workflows/quality.yml` defines a SHA-pinned two-leg gate. `deploy/qualified-images.env` pins six multi-platform dependencies. `npm run test:production-image` built the source-labelled candidate and passed 85 real Forgejo/PostgreSQL/S3 journey assertions plus a fresh-service restore. The strict clean-tree `launch-gate.sh` completed. | **Software PASS; operating evidence missing.** GitHub `main` is still at `956ea85869a1dfacec456871eb9191b4a33d0001`; the candidate and this audit remain local, so hosted CI has not run them and no registry digest has been promoted. |
| Self-serve Sheets/CSV onboarding | Browser smoke created an owned two-card game from CSV without direct API use. The functional suite passed the real `Code.gs` sign-in, private-tab attach, dirty indicator, candidate check, atomic commit, stale-review guard, and export behavior. | **CSV PASS locally; Sheets deployment incomplete.** Google-hosted Apps Script needs the final stable HTTPS origin. The connector has not completed its live journey against this exact deployed candidate. |
| Polished two-person contribution-to-release flow | Both local and protocol journeys passed 86 assertions: independent edition, isolated edits, semantic/file/visual proposal, protected review, proposer-authored merge, rights-blocked release, exact downloads, notifications, and later release reproduction. The same core journey passed against real Forgejo during image recovery. Responsive browser smoke passed at 320 and 390 px. | **Functional PASS; usability unproven.** Automated actors are not evidence that unaffiliated creators understand the flow. The required five-person record currently returns `HOLD` with 0/5 completions. |
| Enforceable rights and production-ready pilot operations | Unknown asset rights block release before tag/export creation; per-file declarations, hashes, protected tags, and receipts survive restore. Production startup is invite-only and HTTPS-only. `deploy/backup.sh` now freezes writes and independently snapshots Forgejo, both PostgreSQL databases, and the remote LFS bucket. The disposable drill removed and restored S3 LFS, then reproduced every frozen release byte through the exact candidate image. | **Mechanism PASS; real operations incomplete.** Policies still need a named operator/contact, the actual host/R2 online preflight and off-host restore evidence are absent, and no operator has accepted on-call responsibility. |

## Exact internal qualification result

The strict gate at the candidate commit produced:

- dependency audit: 0 production vulnerabilities;
- 13 adapter contracts: 5 stable, 8 explicitly limited;
- 183 functional integration tests;
- 86 local plus 86 protocol/real-service collaboration assertions;
- 42 Store-2 contracts on SQLite and the same 42 on digest-pinned PostgreSQL 16;
- five bounded performance/concurrency checks;
- 29 production topology, secret, image, CI, and recovery invariants;
- one remote S3 LFS object independently backed up and restored;
- 51 post-restore checks, including exact PnP, press/A4/Letter, TTC, TTS,
  portable-project, card-sheet, back, and rights-receipt bytes.

The final line was:

```text
CONTROLLED-ALPHA LAUNCH GATE GREEN — including PostgreSQL and real Forgejo.
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
5. Exactly five outside participants matching the roles in
   `CONTROLLED-ALPHA-PILOT.md`.

Once those inputs exist, completion evidence is: hosted CI green; registry
digest promoted; online preflight JSON green; synchronized real-host backup
restored into fresh services and a fresh R2 bucket; deployed two-person smoke
green; live Sheet commit green; and `npm run pilot:report` returning `PROCEED`
with no integrity stop condition.
