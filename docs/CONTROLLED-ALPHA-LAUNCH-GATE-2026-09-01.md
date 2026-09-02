# Forge controlled-alpha launch gate

Status: 2026-09-01
Candidate: working tree based on `956ea85`
Decision: **GO to package and deploy an invite-only, staff-supported card-game designer alpha. NO-GO for open public registration or an unattended public jam.**

This is the current decision record. The earlier findings and broader roadmap in
`SHIP-READINESS-2026-09-01.md` remain useful context, but this file supersedes
its implementation-status claims.

## What the alpha proves

Forge's launch claim is deliberately narrow:

> Bring a card game from the tool you already use. Forge turns a deliberate
> snapshot into a reviewable semantic and visual change, preserves credit and
> licensing, and releases that exact version ready to print or play online.

The candidate now supports that claim across Git repositories, Sheets/CSV,
portable design projects, card and rulebook production assets, protected
proposals, rights-checked releases, isolated exports, and release-pinned jam
submissions.

## Evidence recorded on 2026-09-01

| Gate | Result | Evidence |
|---|---:|---|
| Type safety | PASS | `npm run typecheck` |
| Dependency integrity | PASS | `npm audit --omit=dev`: 0 vulnerabilities; pinned Python environment: no broken requirements |
| Functional integration | PASS | `./e2e.sh`: 172 passed, 0 failed |
| Designer/community golden path | PASS | `./journey.sh`: 85 assertions, 0 failures |
| Forge protocol path | PASS | `./journey-forgejo.sh`: 85 assertions, 0 failures against the protocol-faithful mock with real Git repositories |
| Real Forgejo compatibility | PASS | The same 85 assertions passed twice against an isolated Forgejo 16.0.3 server, including the guarded fixture reset, LFS, fork, review, merge, annotated tag, release, and archive behavior |
| PostgreSQL Store 2 | PASS | 41 conformance checks on both SQLite and a throwaway PostgreSQL 16.15 cluster |
| Adapter contracts | PASS | 12 contracts validated: 5 stable, 7 explicitly limited |
| Portable design project | PASS | HTTP export/import dry-run, fork, commit, PR, and merge verified |
| Explore/mobile smoke | PASS | Live topic filter/search; no horizontal overflow at 320/390 px; visible controls meet 44 px touch target; no browser errors |
| Sheets connector | PASS for private alpha | 25 connector/harness checks inside the functional gate; atomic cards/printings snapshot and durable receipt |
| Security behavior | PASS for private alpha | 13 focused checks inside the functional gate, plus production startup guards, session revocation, origin policy, rate limits, private-project isolation, and media/ZIP limits |
| Delivery budget | PASS | 150-card import+validation: 288 ms; 24 reference faces: 4.2 s; concurrent PUTs left Git and source data valid |
| Production Compose | PASS (configuration) | Digest-only immutable images, loopback gateway, internal database network, read-only/non-root services, bounded resources; `docker compose ... config --quiet` passes |
| One-command gate | PASS | `./launch-gate.sh` completed after all checks above; only the optional live-Forgejo rerun was skipped because that evidence was collected separately against the isolated native server |

The repeatable command is:

```sh
./launch-gate.sh
```

For a release candidate, require both a clean commit and dedicated production
backend test services:

```sh
FORGE_REQUIRE_CLEAN_TREE=1 \
FORGE_CONFORMANCE_PG_URL='postgres://…/forge_conformance' \
FORGE_LIVE_URL='https://git.staging.example' \
FORGE_LIVE_ADMIN_USER='launch-gate' \
FORGE_LIVE_ADMIN_PASS='…' \
REQUIRE_PRODUCTION_BACKENDS=1 \
./launch-gate.sh
```

The PostgreSQL URL and Forgejo server must both be dedicated disposable test
services. The live journey purges its exact `alice`, `bob`, and `charlie`
fixture accounts before running and refuses to start without an explicit
fixture-deletion guard.

## P0 work now implemented

- Stable project IDs and owner/slug namespaces; two owners may use the same slug.
- Real Git repositories, fork isolation, semantic multi-file proposals,
  path-aware review roles, stale-approval invalidation, and target identity
  preservation on merge.
- Protected annotated release tags with immutable artifact and per-file rights
  receipts; unknown or incompatible rights block public release.
- Small lazy app/catalog/project/card payloads instead of embedding the entire
  catalog and every production face in the initial response.
- Isolated, deduplicated, bounded export jobs with checked manifests and
  immutable cache responses.
- HttpOnly browser sessions, revocation, request IDs, safe origins and headers,
  production error hiding, rate limits, request/upload/ZIP bounds, and private
  project non-disclosure.
- Sheets Cards plus optional Printings mapping, tab isolation, atomic snapshot
  promotion, stable IDs, durable source fingerprint/receipt, and token revoke.
- Server-derived jam lifecycle, release-pinned submissions, eligibility
  receipts, team credit, history, and organizer audit records.
- Versioned universal design/rulebook adapter contracts, with stable and
  limited capability levels shown honestly rather than implied round-trip
  fidelity.

## Before the first outside invite

These are deployment operations, not additional product feature projects:

1. Review the current working tree, commit it as one immutable release
   candidate, and rerun `FORGE_REQUIRE_CLEAN_TREE=1 ./launch-gate.sh`.
2. Resolve exact image digests and deploy the documented stack behind a real
   HTTPS domain. Run the gate against the exact pinned Forgejo image, not only
   the protocol mock or the forward-compatibility Forgejo 16 run.
3. Replace `{{OPERATOR}}`, `{{CONTACT}}`, and example addresses in the policy
   runtime configuration. Assign one human to support, moderation, and rights
   reports during every invitation window.
4. Enable off-host encrypted backups and object-store deletion protection, restore all
   three stores into a disposable environment, and reproduce one release. A
   failed restore is a stop condition.
5. Run the post-deploy smoke: health, login/logout/revoke, anonymous private
   404, Sheet dry-run and commit, fork/proposal/approval/merge, isolated export,
   release receipt, and immutable download.
6. Invite 5–10 designers only. Seed only rights-cleared projects. Keep the
   Google connector privately installed; do not claim Marketplace availability.

## Alpha operating boundaries

- Card games first. Boards, punchouts, packaging, custom dice, and manufacturer
  fulfillment remain later component profiles.
- One curated jam, created and moderated by Forge staff. No public jam creation.
- Invite code registration only; no paid service and no promise of durable
  general availability.
- No untrusted contributor CI with platform secrets. Export workers remain
  isolated from internal networks and have hard disk/time/resource budgets.
- Policies are operational alpha text, not jurisdiction-specific legal advice.
  Obtain legal review before open registration, payment, or broad public
  indexing.

## Stop conditions

Pause invitations immediately if private content is visible signed out, a
release cannot be reproduced from its receipt, a rights-unknown file ships,
Sheet promotion differs from the reviewed candidate, an export crosses its
budget, the restore drill fails, or no accountable support/moderation contact
is available.

## Public-launch work intentionally deferred

- Account recovery, email verification, stronger identity/2FA/OIDC, and public
  abuse automation.
- Full accessibility and mobile validation with outside users.
- Public Google Workspace Marketplace review/OAuth verification.
- Public jam creation, scalable moderation staffing, and appeals operations.
- Broad non-card component production and direct manufacturer publishing.
- Evidence from five unaffiliated designers completing the golden path without
  developer coaching. This is the alpha's primary product test, not a claim code
  can prove in advance.
