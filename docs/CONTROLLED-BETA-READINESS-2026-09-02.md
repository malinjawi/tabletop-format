# Forge controlled-beta readiness audit

Status: 2026-09-02

Candidate commit: `0df1f5facfdf987565800bab4e60c762cde340ea`

Qualified local image: `sha256:a8742717018dba035c81a0be4045860cf2d7e831384ae59b64a4776be35c59f4`

Decision: **HOLD for outside invitations. The software candidate is qualified;
the deployed service and human product evidence do not exist yet.**

This audit distinguishes an implemented workflow from an operating beta. A
green local test cannot prove DNS/TLS, the real R2 account, off-host recovery,
the installed Google connector, operator response, or whether a stranger can
use the product without developer coaching.

## Requirement-by-requirement evidence

| Planned outcome | Authoritative current evidence | Verdict |
|---|---|---|
| Reproducible and maintainable application | `.github/workflows/quality.yml` defines a SHA-pinned two-leg gate. `deploy/qualified-images.env` pins six multi-platform dependencies. `npm run test:production-image` built the source-labelled candidate and passed 91 real Forgejo/PostgreSQL/S3 journey assertions plus a fresh-service restore. The strict clean-tree `launch-gate.sh` completed, and the production dependency audit reports zero vulnerabilities. | **Software PASS; operating evidence missing.** The candidate and this audit remain local, so hosted CI has not run them and no registry digest has been promoted. |
| Self-serve Sheets/CSV onboarding | Browser smoke created an owned two-card game from CSV, added artwork, captured creator/license/redistribution before upload, and repaired a fail-closed legacy rights blocker without direct API use. The functional suite passed the real `Code.gs` sign-in, private-tab attach, dirty indicator, candidate check, atomic commit, stale-review guard, and export behavior. | **CSV and rights onboarding PASS locally; Sheets deployment incomplete.** Google-hosted Apps Script needs the final stable HTTPS origin. The connector has not completed its live journey against this exact deployed candidate. |
| Polished two-person contribution-to-release flow | Local and protocol journeys passed 92 assertions: independent edition, isolated edits, semantic/file/visual proposal, protected review, proposer-authored merge, preflighted rights-blocked release, exact downloads, notifications, and later release reproduction. A real two-browser smoke now proves that the proposer sees only discussion/close, the owner sees review, merge stays disabled until approval, and accepted content lands exactly. The same core journey passed 91 assertions against real Forgejo during image recovery. | **Mechanism and browser path PASS; unaffiliated usability unproven.** Automated actors are not evidence that outside creators understand the flow. The required five-person record currently returns `HOLD` with 0/5 completions. |
| Enforceable rights and production-ready pilot operations | Artwork provenance is collected before bytes enter through the UI. Unknown/private/restricted files block release; licensed claims require a source or permission record. The exact-version preflight names blockers and lets the owner repair file declarations in place before any render work. Per-file hashes, protected tags, and receipts survive restore. Production startup is invite-only and HTTPS-only. `deploy/backup.sh` freezes writes and independently snapshots Forgejo, both PostgreSQL databases, and the remote LFS bucket; the disposable drill reproduced every frozen release byte through the exact candidate image. | **Mechanism PASS; real operations incomplete.** User declarations are auditable evidence, not legal verification. Policies still need a named operator/contact, the actual host/R2 online preflight and off-host restore evidence are absent, and no operator has accepted on-call responsibility. |

## Exact internal qualification result

The strict gate at the candidate commit produced:

- dependency audit: 0 production vulnerabilities;
- 13 adapter contracts: 5 stable, 8 explicitly limited;
- 183 functional integration tests;
- 92 local plus 92 protocol collaboration assertions, with 91 against real Forgejo in the production-image drill;
- 42 Store-2 contracts on SQLite and the same 42 on digest-pinned PostgreSQL 16;
- five bounded performance/concurrency checks;
- 29 production topology, secret, image, CI, and recovery invariants;
- one remote S3 LFS object independently backed up and restored;
- 52 post-restore checks, including the real restored Git remote and exact PnP, press/A4/Letter, TTC, TTS,
  portable-project, card-sheet, back, and rights-receipt bytes.

The final line was:

```text
PRODUCTION IMAGE QUALIFIED — sha256:a8742717018dba035c81a0be4045860cf2d7e831384ae59b64a4776be35c59f4 records 0df1f5facfdf987565800bab4e60c762cde340ea and reproduced the frozen release after restore.
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
