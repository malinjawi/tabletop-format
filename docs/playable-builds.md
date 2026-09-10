# Versioned playable builds

Forge treats a deck, scenario loadout, or fixed card assortment as source—not
as a temporary export checkbox. A saved build records rules identities in
`cards` and may separately lock the physical faces to manufacture in
`printings`.

```json
{
  "id": "first-public-playtest",
  "name": "First public playtest",
  "format_id": "standard",
  "author": "maya",
  "cards": {
    "kindling": 3,
    "wildfire": 1
  },
  "printings": {
    "p_kindling_promo": 3,
    "p_wildfire_core": 1
  }
}
```

`cards` answers “what game pieces are in this build?” using permanent card
IDs. `printings` answers “which exact art/edition files and how many copies are
being tested or manufactured?” Counts grouped by each printing's `card_id`
must exactly equal `cards`. A renamed card therefore keeps its history, while
an alt-art or translated face can be selected without pretending it is a new
gameplay object.

## Creator workflow

1. Open **Decks** and choose **New playable build**.
2. Set card quantities and, when alternatives exist, choose the exact physical
   printing. Forge validates the whole candidate and its selected format
   without writing.
3. Commit a legal build or deliberately commit a visibly marked work in
   progress. The stable ID, author, notes, counts, printing choices, and
   legality result are reviewable together.
4. Choose **Plan exact print run**. The print planner carries the locked
   printing IDs and quantities into `templates/print.yaml`.
5. Review and commit that production contract. Exact-version export emits only
   those faces and records the same counts in `quantities.csv`,
   `preflight.json`, and the frozen release manifest.

Creating a build is fail-closed when its stable ID already exists. Editing an
existing build keeps the ID fixed. Both preview and commit compare the draft's
base Git ref with current HEAD so another collaborator's intervening change
cannot be silently overwritten.

## Portable contract

- Schema: `schemas/deck.schema.json`
- Source: `decks/<stable-id>.json`
- Read workspace: `GET /api/games/:slug/decks`
- Non-writing validation: `POST /api/games/:slug/decks/preview`
- Validated commit: `PUT /api/games/:slug/decks/:stable-id`
- Production lock: `templates/print.yaml` under
  `selection.printing_quantities`

External deckbuilders can write this small JSON contract directly. They do not
need Forge's UI and Forge does not claim to round-trip their private project
format. The committed document remains ordinary Git source that can be forked,
reviewed, merged, tagged, and reconstructed without the hosted service.

## Honest boundaries

- Format legality is only as complete as the game's versioned format,
  restriction, and per-card limit data.
- A work-in-progress build may be committed on purpose; it is never labelled
  legal when checks fail.
- Selecting a printing does not grant rights to its art. Release still fails
  closed against the repository rights ledger.
- A print-service target remains a checked file handoff unless its adapter
  explicitly implements and records publishing.
- Setups and VTT adapters can reference stable deck IDs, but Forge does not
  claim that every third-party deckbuilder or tabletop service supports this
  contract natively.
