# Forge controlled-beta pilot

The first outside cohort is a product test, not a public launch. Invite exactly
five tabletop creators and give them a stable HTTPS Forge instance. Arrange
them into two creator/collaborator runs; the fifth production-minded participant
joins both runs so every person uses the product. Do not coach the main task
unless a participant is completely blocked; record where that happens.

## Promise under test

> Bring a card game from the tool you already use. Forge turns a deliberate
> snapshot into a reviewable semantic and visual change, preserves credit and
> licensing, and releases that exact version ready to print or play online.

The beta remains card-game first. Boards, figures, manufacturer fulfillment,
public jam creation, and payment are outside this cohort even though their
source files can already live in a Forge repository.

## Cohort and roles

- 2 working tabletop designers, each bringing a small original prototype.
- 2 collaborators who did not create those prototypes.
- 1 production-minded tester who routinely uses Sheets, CSV, image editors,
  or print-and-play files and participates in both runs.
- One named Forge operator owns support, moderation, and rights reports for the
  full invitation window.

Use rights-cleared originals or explicitly licensed fixtures only. System
Gateway may be used as a private fidelity stress test, not as evidence of an
NSG partnership or permission to publish its protected material.

## Unassisted journey

Each pair should complete this on its own:

1. Creator signs in, imports a small game from CSV or connects a Google Sheet,
   checks the candidate diff, and makes a deliberate commit.
2. Creator chooses or imports a card design, adds one piece of art with credit,
   and downloads a proof.
3. Collaborator creates an independent edition, changes one card and one
   non-card source file (rules, setup, deck, or design), then proposes both.
4. Creator understands the semantic/file/visual diff, requests or approves the
   change, and merges it.
5. Creator cuts a rights-checked release and downloads that exact version as
   PnP plus one VTT or portable-project artifact.
6. Both people can find who authored the accepted change and reproduce the
   release after a later edit to the game.

## Evidence to capture

Record events and outcomes, never unpublished game text:

- invitation accepted;
- project created/import started/import committed;
- first valid render;
- edition created/proposal opened/reviewed/merged;
- release attempted, blocked reason if any, and release completed;
- exact artifact downloaded;
- time to each milestone, error category, and whether human help was required.

Build and qualify the pinned connector using
[`google-sheets-deployment.md`](google-sheets-deployment.md). Copy
`deploy/pilot-cohort.example.json` outside the repository and update that
private record during the sessions using only pseudonymous participant IDs.
Evaluate it with:

```sh
npm run pilot:report -- /encrypted/off-host/evidence/alpha-01.json
```

The report is deliberately fail-closed: an integrity stop condition produces
`HOLD` even when completion numbers look good.

Afterward ask only: what did you expect to happen, where did you lose trust,
what tool would you return to instead, and would you use Forge for the next
iteration of this same game?

## Success threshold

Proceed to a second cohort only if the recorded Apps Script version has created
one attributed private-Sheet commit against the deployed candidate, at least
four of five participants complete
their assigned journey, at least three do so without developer intervention,
both paired runs reach a reproducible release, no integrity stop condition is
triggered, and at least three of five say they would use Forge again on the same
project. Fix the largest common drop-off before adding integrations or opening
a public jam.

## Stop conditions

Pause invitations immediately if private content is visible while signed out,
a reviewed Sheet candidate differs from the committed snapshot, author credit
is lost, rights-unknown material ships, an exact release cannot be reproduced,
an export exceeds its resource budget, the restore drill fails, or the named
operator cannot respond to support/moderation reports.

## Before every cohort

1. Deploy one digest-pinned candidate behind HTTPS and complete the documented
   three-store restore drill.
2. Run `node tools/alpha-readiness.mjs https://forge.example --production`.
3. Run `node deploy/preflight.mjs --env deploy/.env --online` and retain its
   secret-free evidence next to the restore record.
4. Execute one internal two-person journey on the deployed build.
5. Confirm the operator/contact policy text, record the release commit and
   image digests, then issue one expiring single-use invitation per named pilot
   with `node tools/pilot-invite.mjs create`. Revoke any invitation that will
   not be delivered; never retain its raw token in the evidence sheet.
6. Package and install one pinned Google Sheets connector, complete its live
   qualification, and record its deployment evidence without exposing the raw
   script ID.
7. Copy the pilot evidence template outside Git and invite exactly five people.
   Record only each invitation ID and status, never the bearer token.
8. If account recovery is needed, issue a one-hour token with
   `node tools/pilot-account.mjs reset --handle …`; record only its reset ID.
   Confirm the old sessions stopped working after redemption.
