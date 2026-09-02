# Forge controlled-alpha pilot

The first outside cohort is a product test, not a public launch. Invite 5–10
tabletop designers across three small teams and give them a stable HTTPS Forge
instance. Do not coach the main task unless a participant is completely
blocked; record where that happens.

## Promise under test

> Bring a card game from the tool you already use. Forge turns a deliberate
> snapshot into a reviewable semantic and visual change, preserves credit and
> licensing, and releases that exact version ready to print or play online.

The beta remains card-game first. Boards, figures, manufacturer fulfillment,
public jam creation, and payment are outside this cohort even though their
source files can already live in a Forge repository.

## Cohort and roles

- 2–3 working tabletop designers bringing a small original prototype.
- 2–3 collaborators who did not create the prototype.
- 1–2 production-minded testers who routinely use Sheets, CSV, image editors,
  or print-and-play files.
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

Afterward ask only: what did you expect to happen, where did you lose trust,
what tool would you return to instead, and would you use Forge for the next
iteration of this same game?

## Success threshold

Proceed to a second cohort only if at least four of five tested pairs complete
the full journey, at least three do so without developer intervention, every
release is reproducible from its receipt, no private source leaks, and at least
half say they would use Forge again on the same project. Fix the largest common
drop-off before adding integrations or opening a public jam.

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
3. Execute one internal two-person journey on the deployed build.
4. Rotate the invite code, confirm the operator/contact policy text, and record
   the release commit and image digests.
5. Invite only the cohort size the operator can personally support.
