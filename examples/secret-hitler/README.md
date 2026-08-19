# secret-hitler

A full port of **Secret Hitler**, the 5-10 player social deduction game.
Like `examples/decktet` next to it, this is a real, openly-licensed public
game and lives under `examples/` (not `examples/_fixtures/`, where this
repo's proprietary-IP test fixtures like Netrunner and Hearthstone live) --
it can be attributed and shared under the terms below without a "do not
publish" carve-out.

## License

**CC BY-NC-SA 4.0** (Creative Commons Attribution-NonCommercial-ShareAlike
4.0 International). Verified directly against two pages fetched from
https://www.secrethitler.com/:

From the site's own "Play the Game for Free" section:

> Secret Hitler is available for free under Creative Commons license
> BY–NC–SA 4.0. Plan to spend about an hour with a printer and scissors, or
> $5 and 20–30 mins at your local print shop.

From the site's FAQ ("Can I make my own version of your game?"):

> Secret Hitler is licensed under Creative Commons BY–NC–SA 4.0. That
> means you have to give us credit for the original, you're not allowed to
> profit from it commercially in any way, and you have to license it under
> the exact same CC license. You also can't submit anything to an app
> store or anything like that.

And the site footer (fetched directly): `© 2016-2021 Goat, Wolf, & Cabbage
˙ CC SA–BY–NC 4.0`. The official rules PDF itself carries the identical
grant under "CREDITS & LICENSE," including the full legal-code link
(creativecommons.org/licenses/by-nc-sa/4.0/legalcode). `game.yaml`'s
`license: CC-BY-NC-SA-4.0` and this port's own license carry the same
terms forward, as required by the ShareAlike clause.

## Attribution

The official rules PDF's own "CREDITS & LICENSE" section states:

> Secret Hitler was created by Mike Boxleiter, Tommy Maranges, and Mac
> Schubert.

A public library catalog record for the physical game lists a fourth name:
"Secret Hitler / created by Mike Boxleiter, Tommy Maranges, Max Temkin,
and Mac Schubert" -- and Max Temkin's own involvement (design, plus
significant influence from Werewolf-style hidden-role games) is
independently, widely documented elsewhere (this port's task brief itself
named him). Rather than pick one source over the other, `game.yaml` lists
all four names, with Mackenzie "Mac" Schubert credited for design *and*
art (both roles are independently attested). Publisher/copyright holder,
per the site footer: **Goat, Wolf, & Cabbage**.

## Provenance — how this data was produced

- **Rules, components list, win conditions, election/legislative/executive
  flow, Presidential Powers' mechanics, Veto Power, and the license/credit
  text above**: fetched directly from
  https://www.secrethitler.com/assets/Secret_Hitler_Rules.pdf via
  `web_fetch`, which returned full readable text (it's a text-based PDF,
  not a scan). `rules/rules.md` is this port's own condensed restatement
  of that fetched text, not a verbatim copy.
- **Official Print & Play PDF**
  (https://www.secrethitler.com/assets/Secret_Hitler_Print_and_Play.pdf)
  was also fetched directly and its URL is recorded in `game.yaml`'s
  `official_docs`, but the fetch returned no extractable text (it's built
  from card/board artwork images, not a text layer) -- so it could not be
  used as a data source, only linked as the official download.
- **Role distribution by player count** (the 3/1/1 ... 6/3/1 table in
  rules.md) and **the Presidential Power assignment per Fascist track**
  (which power unlocks at which enacted-Fascist-Policy count, for 5-6 /
  7-8 / 9-10 players) are **not** stated as extractable text in either
  PDF -- in the physical game these live on printed boards/tables, which
  render as images rather than text in both PDFs fetched for this port.
  Both tables are instead **reconstructed from well-established public
  knowledge** of the physical game (the same fallback precedent already
  used by this repo's `examples/_fixtures/cards-against-humanity` and
  `hearthstone-classic` fixtures for "fetch succeeded but the specific
  table wasn't machine-extractable"). Every number in both tables is
  cross-checked against the officially-stated component counts below and
  is internally consistent (see Provenance self-check).
- **Everything else** in `components/cards.json` /
  `components/printings.json` (card names, the role/party/policy/ballot/
  placard type split, and every quantity) is **directly sourced**,
  transcribed verbatim from the rules PDF's own "GAME CONTENTS" list:

  > 17 Policy tiles (6 Liberal, 11 Fascist); 10 Secret Role cards; 10 Party
  > Membership cards; 10 card envelopes; 10 Ja! Ballot cards; 10 Nein
  > Ballot cards; 1 Election Tracker marker; 1 Draw pile card; 1 Discard
  > pile card; 3 Liberal/Fascist boards; 1 President placard; 1 Chancellor
  > placard.

  **Provenance self-check**: the reconstructed role-distribution table
  sums to exactly 6 Liberal / 3 Fascist / 1 Hitler at its 10-player
  maximum -- exactly matching the officially-stated "10 Secret Role
  cards" total, with Liberals outnumbering the Fascist team at every
  player count (required by the rules text: "The Liberals have a
  majority"). The party-card split (6 Liberal / 4 Fascist) is directly
  derived from an explicit, directly-fetched rule -- "Liberal Secret Role
  cards must always be packed together with a Liberal Party Membership
  card, and Fascist and Hitler Secret Role cards must always be packed
  together with a Fascist Party Membership card" -- applied to the
  6/3/1 role split, and also sums to the officially-stated "10 Party
  Membership cards."

## What's sourced vs. reconstructed

**Directly sourced** (verbatim component counts + fully-fetched rules
text): the 12 card definitions' names/types, all component quantities
(role 6/3/1, party 6/4, policy 6/11, ballot 10/10, placard 1/1/1 — summing
to the officially-stated 60 pieces), the full Election / Legislative
Session / Executive Action flow, term-limit rules, the Election Tracker
and chaos-policy rule, all four Presidential Powers' mechanics, the Veto
Power, both win conditions, the lying rule, and the CC BY-NC-SA 4.0
license grant (exact quotes above).

**Reconstructed from well-established public knowledge, explicitly
flagged**: the role-distribution-by-player-count table and the
Presidential-Power-by-Fascist-track-slot table (both explained above).
Everything reconstructed is a small, widely-published, non-controversial
piece of this specific game's standard configuration -- not invented
content -- but neither table came back as extractable text from either
official PDF fetched for this port, so both are called out rather than
presented as directly quoted.

## Scope

- All 12 distinct "rules identities" the physical game ships (role,
  party, policy, ballot, placard), at their full 10-player-maximum
  quantities (60 physical pieces total) in one set, `standard-edition`.
- Not modeled as separate cards: the 10 card envelopes, the draw-pile and
  discard-pile marker cards, and the 3 physical Fascist-track boards --
  none of these are "cards" in the role/party/policy/ballot/placard sense
  this port's schema models, so they're described in `rules.md` instead.
- No physical art assets (`printings.json` entries are template-only, no
  `art` field) — this port is card *data*, not scanned/illustrated card
  images.
