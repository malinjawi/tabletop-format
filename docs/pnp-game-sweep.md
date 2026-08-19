# Print-and-Play & Open-License Card Game Sweep

Research date: 2026-08-19. Scope: every card game (or card-adjacent dataset/source) we could
**legitimately host or port** on an open platform, prioritizing production-grade games with
official print-and-play (PnP) permission or explicit open licenses — the kind that make the
platform look credible to a publisher partner (Null Signal Games is the named benchmark).
Method: `mcp__workspace__web_fetch` and `WebSearch` only, no `curl`. Where a claim rests on a
directly fetched primary source, it is quoted. Where it rests only on a secondary/aggregator
page (not independently re-fetched from the publisher), that is flagged inline — **treat
those as leads to confirm, not cleared rights.** No games were ported as part of this sweep;
this is a research + queue document only.

This repo already has a deep, single-publisher version of this exact exercise at
[`docs/nsg-fidelity-research.md`](./nsg-fidelity-research.md) (Null Signal Games / Netrunner,
25 sources, same day). This document is the wide sweep across everyone else, using the same
rigor and the same verdict scale, and folds the NSG findings back in as entry #1.

## Verdict legend

- **PUBLIC-HOSTABLE** — explicit open license (CC/GPL/CC0/PD/Unlicense) covers hosting,
  editing, and redistributing this on an open community platform.
- **FIXTURE-ONLY** — usable as an internal/dev fixture the way this repo already treats
  Netrunner and Hearthstone (`NORTH-STAR.md`: "internal fixture only, never shipped
  publicly") — data is fan-tolerated or facts-not-copyrightable, but the underlying IP
  (art, sometimes text) is not openly licensed, so it cannot be a public showcase.
- **LINK-ONLY** — genuinely free and official, but the publisher's own terms say personal
  use / no redistribution / no rehosting. We can link to it; we cannot serve the files
  ourselves.
- **NO** — no evidence of usable permission, or explicitly restricted. Listed anyway so the
  gap is documented, not silently skipped.

Total recorded below: **80 individually verdicted games/sources** across 5 categories (plus
~29 further individually-named free Cheapass Games titles bundled inside entry #13, and
several thousand more mine-able from the aggregator sources in Category 5 — this sweep
stops at a representative, verified sample of those, not the full depth).

---

## Category 1 — Publisher-official free print-and-play (21 entries)

**1. Null Signal Games — Netrunner: System Gateway / System Update 2021 / Vantage Point (PnP PDFs).**
Publisher of the official Netrunner LCG continuation. Full-art, pay-what-you-want PnP PDFs
for every current product (no card backs). URL: nullsignal.games/products/system-gateway/
(+ system-update-2021, vantage-point). Quote: *"Pay what you'd like and print on your own
printer! This file contains full-color art of card faces, with no bleed or card backs."*
Also: *"Card art, frames, and card backs are unavailable for use by the public."*
**Verdict: LINK-ONLY.** Full 25-source breakdown already in `docs/nsg-fidelity-research.md`.

**2. Null Signal Games — official visual-asset pack (icons/glyphs).**
URL: nullsignal.games/about/nsg-visual-assets/, zip at
access.nullsignal.games/Visual%20Assets/NSG-Visual-Assets_v1.5.zip. License: **CC BY-ND
4.0**, SVG format — faction icons, click/credit/subroutine glyphs, etc. **Verdict:
PUBLIC-HOSTABLE** (glyphs/symbols only — not full cards, not art, not frames).

**3. Fantasy Flight Games — KeyForge: Mass Mutation (4 free Archon Decks + quickstart).**
URL: fantasyflightgames.com/en/news/2020/4/16/play-keyforge-for-free/ (PDFs on
images-cdn.fantasyflightgames.com). Quote: *"All files are the property of Fantasy Flight
Games and may only be used for personal and private purposes. All forms of commercial
operation are excluded."* **Verdict: LINK-ONLY.**

**4. Fantasy Flight Games — Arkham Horror: The Card Game solo/PnP promos.**
("Read or Die with Daisy Walker," solo campaign rules; base game/expansion required.) URL:
fantasyflightgames.com/en/news/2020/5/5/beyond-our-dimension/ and .../2020/5/13/prepared-for-the-worst-1/.
**Verdict: LINK-ONLY** (base-game-gated).

**5–12. Asmodee Group official Print & Play portal** (print-and-play.asmodee.fun) — full,
free, OFFICIAL versions of major card games across Asmodee's studios:
- **5. Love Letter** — print-and-play.asmodee.fun/love-letter/
- **6. Citadels** — print-and-play.asmodee.fun/citadels/
- **7. Splendor** (+ add-ons) — print-and-play.asmodee.fun/files/splendor/splendor_pnp_ml.pdf
- **8. 7 Wonders Duel** — print-and-play.asmodee.fun/7-wonders-duel/
- **9. Dobble / Spot It!** — print-and-play.asmodee.fun/dobble/
- **10. Dixit** — print-and-play.asmodee.fun/dixit/
- **11. Concept** — print-and-play.asmodee.fun/files/concept/concept_pnp_en.pdf
- **12. Timeline Classic** — print-and-play.asmodee.fun/timeline/

License (print-and-play.asmodee.fun/en/legal/terms): *"shared for personal use exclusively,
not for commercial purposes... shall not sell, rent, lease, transfer, license or sublicense,
or distribute the free downloadable demo... not authorized to publicly display or perform,
or republish."* **Verdict (all 8): LINK-ONLY** — genuinely full/free/official, explicitly
no-rehost.

**13. Cheapass Games / Crab Fragment Labs — free catalog (~30 titles).**
Publisher: Cheapass Games (James Ernest), now Crab Fragment Labs. Full rules+cards hosted
directly at cheapass.com/free-games/originals/. Confirmed titles (fetched the catalog page
directly): Kill Doctor Lucky, Give Me the Brain, Unexploded Cow, Save Doctor Lucky, Before I
Kill You Mister Spy, Lord of the Fries, Devil Bunny Bunnanza, The Big Cheese, Escape from
Elba, Witch Trial, Agora, Renfield, Huzzah!, Nexus, Fight City, The Great Brain Robbery,
Captain Park's Imaginary Polar Expedition, Freeloader, One False Step for Mankind, Jacob
Marley Esq., Secret Tijuana Deathmatch, Enemy Chocolatier, Chief Herman, Spree!, Get Out, Ben
Hvrt, Bleeding Sherwood, The Very Clever Pipe Game, Parts Unknown, The Doctor Lucky
Ambivalence Pack, U.S. Patent No. 1. Fetched the Kill Doctor Lucky page directly: it states
"print-and-play version," "download... free," with no explicit CC/redistribution grant on
the page itself. A third-party summary (not independently confirmed) claims a "copy and
distribute, don't sell or alter" orderware norm historically. **Verdict: LINK-ONLY** —
confirmed free-to-download-and-print; redistribution rights not confirmed from a primary
source. Recommend a direct license-confirmation email to Crab Fragment Labs before treating
any title as PUBLIC-HOSTABLE — high upside if confirmed (huge, beloved, license-simple
catalog).

**14. Tuesday Knight Games — Two Rooms and a Boom.**
Full free-forever PnP (6–30+ player social deduction, card-driven). URL:
tuesdayknightgames.com/products/two-rooms-and-a-boom, mirrored at
pnparcade.com/products/two-rooms-and-a-boom. Quote (site copy, via search): *"has always been
and always will be totally free."* **Verdict: LINK-ONLY** (no explicit CC grant located;
"free forever" is a business-model statement, not a redistribution license — worth an email
to confirm, high credibility payoff if cleared).

**15. Wise Wizard Games — Hero Realms backer PnP.**
Kickstarter-era files now sitting in BGG's file library. URL:
boardgamegeek.com/thread/1605244 ("Hero Realms Print and Play Unlocked for ALL Backers").
**Verdict: LINK-ONLY / UNCONFIRMED** — could not verify current non-backer public
availability or terms from Wise Wizard Games directly.

**16. Wise Wizard Games — Star Realms official PnP.**
Searched directly on wisewizardgames.com, starrealms.com, and BGG; found only a printable
scorepad and a 2014-era Kickstarter mention, no current official free PnP. **Verdict: NO**
(insufficient evidence — do not claim).

**17. Asmadi Games — One Deck Dungeon.**
Official rules + full PnP PDF. URL: asmadigames.com/rules/OneDeckDungeon_Rules.pdf,
asmadigames.com/ODD_PnP.pdf. **Verdict: LINK-ONLY.**

**18. Button Shy Games — Twin Stars: Adventure Series I** (1st scenario, official free PnP).
URL: boardgamegeek.com/filepage/171071. **Verdict: LINK-ONLY.**

**19. Button Shy Games — Seasons of Rice** (official free PnP).
URL: boardgamegeek.com/filepage/171646. **Verdict: LINK-ONLY.** (General note: Button Shy's
wider wallet-game catalog is mostly *paid* digital PnP via buttonshygames.com/PNPArcade.com,
personal-use only — the on-site "Print and Play Games" collection returned 0 products at
fetch time, site reorg in progress.)

**20. Renegade Game Studios — Wonderland print-and-play / Power Rangers: Heroes of the Grid free scenarios.**
URL: renegadegamestudios.com/news/print-play-wonderland,
renegadegamestudios.com/power-rangers-scenarios. **Verdict: LINK-ONLY** (base-game-gated).

**21. Looney Labs — Fluxx Print & Play Rulesheet / Solo Fluxx Rulesheet.**
Narrow: a rules supplement for using a blank card, not a free full card set (Fluxx itself
stays a paid product). URL: looneylabs.com/solofluxx, faq.looneylabs.com. **Verdict:
LINK-ONLY**, narrow scope.

---

## Category 2 — Explicitly open-licensed games (CC / GPL / PD) (12 entries)

**22. Arcmage** (Wtactics / arcmage.org) — full open-source MTG-style TCG.
Complete card rules text, card database, browser deckbuilder (github.com/wtactics/arcmage).
URL: arcmage.org/license/. Quote: *"The game license... is under the Creative Commons
Attribution-ShareAlike 4.0 International License... each card frontside in itself is
licensed under [CC BY-SA 4.0]... Software... is under GPL3."* Art partly sourced from Battle
for Wesnoth (GPLv2 / CC BY-SA 4.0) and CC0. **Verdict: PUBLIC-HOSTABLE** — the closest thing
to a full "open LCG" this sweep found; structurally the best NSG-credibility proof (see
queue below).

**23. Cards Against Humanity** — already this platform's Slice-1 public demo per
`NORTH-STAR.md`. URL: cardsagainsthumanity.com, s3.amazonaws.com/cah/CAH_MainGame.pdf.
License: **CC BY-NC-SA 2.0**. **Verdict: PUBLIC-HOSTABLE** (already in use —
`examples/_fixtures/cards-against-humanity`).

**24. Secret Hitler** (Max Temkin — also a CAH co-creator — with Mike Boxleiter & Tommy
Maranges). Full rules + all card text/layout (role cards, policy cards, board). URL:
secrethitler.com. Quote (fetched directly): *"Secret Hitler is available for free under
Creative Commons license BY–NC–SA 4.0... you have to give us credit for the original, you're
not allowed to profit from it commercially in any way, and you have to license it under the
exact same CC license."* **Verdict: PUBLIC-HOSTABLE.** Same license family as CAH, same
design pedigree, very high name recognition (Shut Up & Sit Down, Mashable, Playboy coverage
cited on the game's own site) — one of the strongest single finds of this sweep.

**25. The Decktet** (P.D. Magnus). The deck itself (36 cards, 6 suits) + an entire
third-party game catalog. URL: fecundity.com/pmagnus/decktet/, decktet.com,
wiki.decktet.com. Quote: *"offered as open content under a Creative Commons Attribution
NonCommercial ShareAlike 3.0 License"* (a 4.0 restatement is also referenced elsewhere).
**Verdict: PUBLIC-HOSTABLE** (non-commercial only).

**26–29. Named games playable on the Decktet** (all inherit the deck's CC BY-NC-SA license,
each with its own rules text also open per the Decktet Wiki's stated norms):
- **26. Magnate** — fecundity.com/pmagnus/decktet/magnate.php — PUBLIC-HOSTABLE
- **27. Quincunx** — wiki.decktet.com/game:quincunx — PUBLIC-HOSTABLE
- **28. Emu Ranchers** — wiki.decktet.com/game:emu-ranchers — PUBLIC-HOSTABLE
- **29. Chicane** — referenced via fecundity.com/pmagnus/decktet/games.php — PUBLIC-HOSTABLE
(Dozens more are catalogued on wiki.decktet.com — this sweep verified 4 by name as a
representative sample.)

**30. Regicide** (Badgers From Mars, NZ; originally released 2015). Full rules PDF; the
"deck" is an ordinary 52-card deck + 2 jokers — attack/health values come from standard card
ranks per the rules, not from custom-printed numbers. URL: regicidegame.com/how-to-play/ →
.../site_files/33132/upload_files/RegicideRulesA4.pdf. No CC/open-license statement found on
the current site; framed as a free personal-use download. **Verdict: FIXTURE-ONLY** — the
ruleset itself is conventionally copyrighted, but because the game runs on an ordinary PD
deck (see Category 3 PD art), an *original* from-rules implementation with attribution + a
buy-link to the official edition is the same legal posture this repo already uses for
Hearts/Bridge-style traditional games — just don't copy the rulebook's exact wording/layout.

**31. Sovereign** (Ruben Hopmans, opensourceboardgame.org). Full rules + printable
components. URL: thegamecrafter.com/games/sovereign:-open-source-board-game,
opensourceboardgame.org. License: **CC BY-SA 3.0**. **Verdict: PUBLIC-HOSTABLE** (board game
with card components — useful precedent beyond pure card games).

**32. Fifth Aeon** — described as a free/open-source CCG (~135+ cards), found via
opensource.com coverage and an itch.io listing, not independently re-fetched from a
primary license file this sweep. **Verdict: LINK-ONLY pending verification** — promising,
flagged to confirm the exact license before treating as PUBLIC-HOSTABLE.

**33. itch.io Creative Commons Jam / Card Game Jam / Print & Play Club.**
URL: itch.io/jam/creative-commons-jam, itch.io/c/2598257/print-n-play,
itch.io/physical-games/tag-card-game/tag-print-and-play. Dozens of jam entries, each
individually licensed. **Verdict: source, not a single verdict — LINK-ONLY as a category**
until specific entries are pulled and checked one by one. Flagged as the single richest
un-mined vein for a follow-up sweep.

---

## Category 3 — Traditional / public-domain games + PD art sources (31 entries)

All traditional-game rules below are treated as PD (facts/rules of long-established folk
games are not copyrightable); pagat.com (Wikipedia: "the largest and most authoritative
website about the rules of card games," run by John McLeod since 1995) is used as the
reference rules source for each. **Every row needs its own card art** — either an original
platform frame, or one of the PD/CC0 art sources listed underneath the table.

| # | Game | Family / origin | Reference | Verdict |
|---|------|------------------|-----------|---------|
| 34 | Baloot | Trick-taking, Gulf states | pagat.com/jass/baloot.html | PUBLIC-HOSTABLE |
| 35 | Tarneeb | Trick-taking, Levant | pagat.com/boston/tarneeb.html | PUBLIC-HOSTABLE |
| 36 | Trex / Trix | Compendium, Middle East | pagat.com/compendium/trex.html | PUBLIC-HOSTABLE |
| 37 | Hearts | Trick-taking | pagat.com/reverse/hearts.html | PUBLIC-HOSTABLE (already ported: `examples/_fixtures/hearts`) |
| 38 | Whist | Trick-taking | pagat.com/whist/whist.html | PUBLIC-HOSTABLE |
| 39 | Bridge (Contract) | Trick-taking | pagat.com/auctionwhist/bridge.html | PUBLIC-HOSTABLE |
| 40 | Euchre | Trick-taking | pagat.com/euchre/ | PUBLIC-HOSTABLE |
| 41 | Pinochle | Trick-taking/melding | pagat.com/marriage/pinochle.html | PUBLIC-HOSTABLE |
| 42 | Skat | Trick-taking, Germany | pagat.com/schafk/skat.html | PUBLIC-HOSTABLE |
| 43 | Briscola | Trick-taking, Italy | pagat.com/aceten/briscola.html | PUBLIC-HOSTABLE |
| 44 | Scopa | Fishing, Italy | pagat.com/fishing/scopa.html | PUBLIC-HOSTABLE |
| 45 | Durak | Shedding, Russia | pagat.com/beating/durak.html | PUBLIC-HOSTABLE |
| 46 | President / Daihinmin family | Shedding | pagat.com/climbing/ | PUBLIC-HOSTABLE |
| 47 | Rummy / Gin Rummy family | Melding | pagat.com/rummy/ | PUBLIC-HOSTABLE |
| 48 | Cribbage | Adding/pegging | pagat.com/adders/cribbage.html | PUBLIC-HOSTABLE |
| 49 | Canasta | Melding | pagat.com/rummy/canasta.html | PUBLIC-HOSTABLE |
| 50 | Golf | Adding | pagat.com/adders/golf.html | PUBLIC-HOSTABLE |
| 51 | Crazy Eights | Shedding | pagat.com/eights/crazy8s.html | PUBLIC-HOSTABLE (note: "Uno" the brand/card-back design is trademarked — implement as Crazy Eights, not a re-skinned Uno) |
| 52 | Spades | Trick-taking | pagat.com/auctionwhist/spades.html | PUBLIC-HOSTABLE |
| 53 | French Tarot (card game) | Trick-taking w/ tarot pack | pagat.com/tarot/frtarot.html | PUBLIC-HOSTABLE mechanics; pairs with PD Tarot art below |
| 54 | Hanafuda (Koi-Koi, Hachi-Hachi) | Japan, matching | fudawiki.org, Wikipedia | PUBLIC-HOSTABLE mechanics; traditional-era designs PD, but modern Nintendo hanafuda art is NOT PD — use original/traditional-style art |
| 55 | Karuta (Iroha karuta, Hyakunin Isshu uta-garuta) | Japan, matching/poetry | fudawiki.org/en/mekurifuda/history | PUBLIC-HOSTABLE (the classical Hyakunin Isshu poems are centuries-old PD text) |
| 56 | Ganjifa | India/Persia, trick-taking | Wikipedia | PUBLIC-HOSTABLE mechanics; historic hand-painted art PD by age, modern revival art is not |

**PD / CC0 / permissive card-art sources** (to skin any traditional game above without
infringing anything):

| # | Source | License | URL | Verdict |
|---|--------|---------|-----|---------|
| 57 | Rider–Waite–Smith Tarot (Pamela Colman Smith, 1909) | Public domain (US/UK, life+70) | archive.org/details/rider-waite-tarot (400+dpi scan), commons.wikimedia.org/wiki/Category:Rider-Waite_tarot_deck, picryl.com | PUBLIC-HOSTABLE |
| 58 | notpeter/Vector-Playing-Cards (github) | Public domain (orig. Byron Knoll) | github.com/notpeter/Vector-Playing-Cards | PUBLIC-HOSTABLE |
| 59 | letele/playing-cards (github) | CC0 1.0 | github.com/letele/playing-cards | PUBLIC-HOSTABLE |
| 60 | saulspatz/SVGCards (github) | Public domain | github.com/saulspatz/SVGCards | PUBLIC-HOSTABLE |
| 61 | htdebeer/SVG-cards (github) | LGPL | github.com/htdebeer/SVG-cards | PUBLIC-HOSTABLE (LGPL attribution/source obligations apply) |
| 62 | cardmeister/cardmeister.github.io (github) | Unlicense (PD) | github.com/cardmeister/cardmeister.github.io | PUBLIC-HOSTABLE |
| 63 | Metropolitan Museum of Art Open Access (incl. 1888 "Playing Cards" series N84) | CC0 | metmuseum.org/hubs/open-access | PUBLIC-HOSTABLE |
| 64 | Rijksmuseum Open Access | CC0 / public-domain policy (per Met's own citation; not independently re-fetched this sweep) | rijksmuseum.nl | PUBLIC-HOSTABLE, flagged to independently confirm next sweep |

---

## Category 4 — Fan/community open datasets: DATA license vs ART license (9 entries)

The pattern across this entire category is consistent and important: **the code/schema is
usually open, the card data is usually "fan-tolerated," and the art is essentially always
still owned by the original publisher.** This repo's own `docs/nsg-fidelity-research.md`
already found exactly this for Netrunner; this sweep confirms the same shape holds across
the whole "Alsciende family" and the major TCG data APIs.

**65. netrunner-cards-json** (Null-Signal-Games, github.com/Null-Signal-Games/netrunner-cards-json).
Card names/costs/text/factions as JSON; powers NetrunnerDB. Fetched `COPYRIGHT.md` directly:
*"The information in this repository is copyrighted by Fantasy Flight Games and/or Wizards
of the Coast. This repository is not maintained, produced, endorsed, supported, or
affiliated with [them]."* **Verdict: FIXTURE-ONLY** (matches this repo's existing posture —
`NORTH-STAR.md`'s "internal fixture only, never shipped publicly" rule for Netrunner).

**66. ArkhamDB** (Kamalisk, built on Alsciende's ThronesDB framework;
github.com/Kamalisk/arkhamdb). Data + card images for Arkham Horror LCG. Fetched
arkhamdb.com/about directly: *"The information presented on this site... both literal and
graphical, is copyrighted by Fantasy Flight Games. This website is not produced, endorsed,
supported, or affiliated with Fantasy Flight Games."* **Verdict: FIXTURE-ONLY.**

**67. MarvelCDB** (zzorba/marvelsdb, github.com/zzorba/marvelsdb) — same Alsciende-descended
pattern for Marvel Champions: The Card Game. **Verdict: FIXTURE-ONLY** (family resemblance
to #66; not independently re-confirmed this sweep — high confidence, flagged as such).

**68. ThronesDB** (Alsciende, github.com/Alsciende/thronesdb +
ThronesDB/thronesdb-json-data) — same pattern for A Game of Thrones 2nd Ed. LCG. **Verdict:
FIXTURE-ONLY.**

**69. Scryfall** (Magic: The Gathering) — data + images via REST API. URL:
scryfall.com/docs/api, scryfall.com/docs/terms. Operates under Wizards of the Coast's Fan
Content Policy: *"not approved/endorsed by Wizards... may not use Magic data to create new
games... may not claim any products... as official."* **Verdict: FIXTURE-ONLY** (excellent
for an internal MTG-style dev fixture; the Fan Content Policy's non-commercial,
don't-imply-a-different-game terms rule out a public "free MTG cards" host).

**70. HearthstoneJSON** (HearthSim; multiple mirrors, e.g. github.com/cwestleyj/HearthstoneJSON).
Code: MIT. Data/art: *"all card images and names are copyright © Blizzard Entertainment...
Hearthstone® is a registered trademark."* **Verdict: FIXTURE-ONLY** (this repo already treats
its Hearthstone expansion this way — `examples/_fixtures/hearthstone-classic`).

**71. pokemontcg.io / PokemonTCG/pokemon-tcg-data** (github.com/PokemonTCG/pokemon-tcg-data).
Community REST API + open data repo; images hotlinked from official assets. Terms:
dev.pokemontcg.io/terms — "AS-IS" API, no official Pokémon Company affiliation. **Verdict:
FIXTURE-ONLY.**

**72. YGOPRODeck API + yaml-yugi** (DawnbrandBots/yaml-yugi, github). Community Yu-Gi-Oh!
database; yaml-yugi code is AGPL-3.0, card data/art remains Konami-owned. **Verdict:
FIXTURE-ONLY.**

**73. KeyForge Master Vault** (official, Ghost Galaxy). API access is gated behind an
approved key: *"Submitting a request for an API Key does not guarantee approval, and API Key
use will be monitored and may be revoked if deemed to be abused... at the full discretion of
Ghost Galaxy."* **Verdict: NO** for open hosting — this is the one entry in Category 4 that
isn't even fan-open; it's a permissioned official system. LINK-ONLY at best (point users to
keyforgegame.com).

---

## Category 5 — Anything else notable (7 entries)

**74. Agent Decker** (gr9yfox, itch.io) — 18-card solo/co-op deduction PnP. URL:
gr9yfox.itch.io/agent-decker. **Verdict: LINK-ONLY** (itch.io page terms not individually
re-checked this sweep — flag to confirm; a strong "solo PnP darling" per the brief's ask).

**75. Oh, Sheep!** (independent) — small PnP card game. URL: ohsheepcards.com/print-and-play/.
**Verdict: LINK-ONLY** (license unconfirmed).

**76. BoardGameGeek "Public Domain" games list/geeklist.** URL:
boardgamegeek.com/geeklist/211477/public-domain-games-rank,
boardgamegeek.com/boardgamepublisher/171/public-domain. Community-curated PD-game index — a
good recurring source for expanding Category 3. **Verdict: source/aggregator**, not itself a
single verdictable game.

**77. BoardGameGeek Print & Play file library** (per-game "Files" tabs). This is where a
large share of this sweep's concrete Independent PnP titles actually live (Two Rooms and a
Boom mirror, Button Shy's Twin Stars/Seasons of Rice, a Secret Hitler mirror, dozens more).
**Verdict: source/aggregator** — BGG hosting a file is not itself a license grant; check each
file's own stated terms.

**78. Randomskill Games' "comprehensive list of free Print and Play games"**
(randomskill.games/a-comprehensive-list-of-free-print-and-play-games/) — the single richest
aggregator found this sweep: organized by publisher (Asmodee, Cheapass, CMON, Czech Games
Edition, Days of Wonder, Fantasy Flight, Hans im Glück, Portal Games, Z-Man, 25+ more), 150+
linked titles, most of Category 1 above was cross-checked against it. **Verdict: source** —
recommend a follow-up pass on the ~120 titles not covered in this report (mostly
board-games-with-some-cards; each still needs its own license confirmed directly from the
publisher, since this is a third-party fan aggregator, not the publishers themselves).

**79. Sentinels of the Multiverse** (Greater Than Games) — searched the publisher's shop,
Wikipedia, and general web directly; no free PnP or demo found. **Verdict: NO** (insufficient
evidence — noted specifically because the brief's own category list suggested it as a lead;
don't assume it exists without a direct confirmation from Greater Than Games).

**80. Sentinel Comics: The Roleplaying Game** (Greater Than Games) — Starter Kit and Core
Rulebook are paid PDF products; no free quickstart confirmed. **Verdict: NO** (insufficient
evidence).

---

## Tally by verdict (80 entries)

| Verdict | Count | Notes |
|---|---|---|
| PUBLIC-HOSTABLE | 41 | Nearly all of Category 3 (traditional PD games + PD/CC0 art) plus Arcmage, CAH, Secret Hitler, Decktet + 4 named Decktet games, Sovereign, the NSG glyph pack |
| FIXTURE-ONLY | 9 | Regicide (ruleset) + all 8 "data-open-art-closed" fan datasets in Category 4 |
| LINK-ONLY | 26 | Nearly all of Category 1 (official-but-personal-use PnPs), the aggregator sources in Category 5 |
| NO | 4 | Star Realms PnP, KeyForge Master Vault API, Sentinels of the Multiverse, Sentinel Comics RPG — all "insufficient evidence found," listed for completeness rather than silently dropped |

Already implemented in this repo (excluded from the port queue below): Cards Against
Humanity (`examples/_fixtures/cards-against-humanity`), Hearts
(`examples/_fixtures/hearts`), Netrunner: System Gateway (`examples/_fixtures/netrunner-sg`,
internal-only per NORTH-STAR.md), Hearthstone Classic
(`examples/_fixtures/hearthstone-classic`, internal-only).

---

## TOP 12 PORT QUEUE

Ranked for partner-credible breadth, license safety, and effort. **First 3 to build = #1–#3.**

1. **Secret Hitler** — CC BY-NC-SA 4.0, same license family and even co-creator lineage as
   the platform's own CAH demo; extremely well-known name. Cheapest possible credibility win.
   **(DO FIRST)**
2. **Arcmage** — full CC BY-SA 4.0 + GPL3 open TCG with its own card database/deckbuilder;
   the single best structural proof that this platform can host something shaped like a real
   LCG, which is exactly what an NSG-style partner needs to see. **(DO FIRST)**
3. **The Decktet** (deck) + **Magnate** and **Quincunx** (2 of its catalog games) — CC
   BY-NC-SA, one deck/many games story is a great "platform flexibility" showcase and a light
   lift (36 cards, no faction/set complexity). **(DO FIRST)**
4. **Classic trick-taking pack: Spades, Euchre, Whist, Bridge** — public domain, pairs with
   the PD/CC0 SVG playing-card repos already catalogued (#58–62), near-zero legal risk,
   quick multiplayer wins alongside the existing Hearts fixture.
5. **Middle Eastern trick-taking pack: Baloot, Tarneeb, Trex** — public domain, regionally
   resonant, well-documented on pagat.com, differentiates the platform from "just Western
   card games."
6. **Regicide** — original from-rules implementation on a PD 52-card deck, with attribution
   and a buy-link to the official edition; modern-indie-darling name recognition at PD-game
   legal risk.
7. **Sovereign** — CC BY-SA 3.0 full open-source game; shows range beyond pure card games and
   gives the platform a second "fully open, not just PD" showcase besides Arcmage.
8. **French Tarot**, skinned with the **Rider-Waite-Smith 1909 PD art** (#57) — visually
   striking, plays directly into this platform's own stated obsession with cards that "look
   exactly like the physical card" (NORTH-STAR.md).
9. **Two Rooms and a Boom** — pending a direct license-confirmation email to Tuesday Knight
   Games (currently LINK-ONLY); high social/party-game appeal and an easy multiplayer demo if
   cleared.
10. **Cheapass classics: Kill Doctor Lucky + Give Me the Brain** — pending a direct
    license-confirmation email to Crab Fragment Labs (currently LINK-ONLY); huge nostalgia
    and indie-designer credibility once cleared.
11. **Null Signal Games CC BY-ND 4.0 glyph integration into the existing Netrunner fixture** —
    not a new game, but directly strengthens the platform's *existing* Netrunner work's legal
    footing using NSG's own openly-licensed assets — the most literal "impress NSG
    specifically" action on this list.
12. **Hanafuda Koi-Koi**, with original/traditional-style (not modern Nintendo) art —
    visually distinctive, culturally different from the rest of the queue, signals breadth
    beyond Western card traditions.

---

## What would impress a publisher partner (NSG-style)

- **Provable IP discipline, not just enthusiasm.** This sweep and `docs/nsg-fidelity-research.md`
  both separate DATA license from ART license from CODE license per source, and land on
  FIXTURE-ONLY (not "public") for anything fan-tolerated but not actually granted — the exact
  distinction a publisher's legal team checks first.
- **A real, working open LCG already hosted (Arcmage), not just a promise.** Proof the
  platform's tech stack (card database, deckbuilder, faction/set structure) already works on
  a game shaped like the one NSG makes, before ever discussing NSG's own IP.
- **A license-clean public demo people can actually try (CAH today, Secret Hitler next)** so
  a partner can walk the full loop — browse, edit, propose, merge, print — without any of
  *their* IP being at risk in the trial.
- **Evidence of having engineered specifically around NSG's own stated boundaries** — the CC
  BY-ND glyph pack integration (#2/#11), linking to official PnP instead of rehosting it,
  respecting "no card backs" — shows the platform did its homework on THIS publisher's actual
  policy, not a generic "we host cards" pitch.
- **A breadth story across eras and publishers (Cheapass, Decktet, PD classics, Secret
  Hitler, regional games like Baloot/Tarneeb), not a single-publisher tech demo** — the
  bottom-up "communities already prove the loop" signal `NORTH-STAR.md`'s own adoption
  doctrine says publishers need to see *before* being sold anything.

---

## Sources & method notes

- Network access: `mcp__workspace__web_fetch` (direct page fetches, quoted where used) and
  `WebSearch` (broader discovery; treated as secondary evidence, flagged where a claim is
  WebSearch-only and not independently re-fetched).
- No `curl`, no bypassing of fetch failures — where a fetch returned empty or the tool
  declined (e.g. a raw GitHub LICENSE file, a JS-heavy storefront collection page), that is
  noted next to the affected entry rather than silently papered over.
- Entries are deliberately conservative: several plausible-sounding leads (Fifth Aeon,
  MarvelCDB/ThronesDB by family resemblance, Two Rooms and a Boom's exact redistribution
  terms, Cheapass's exact license, Sentinels of the Multiverse PnP) are marked LINK-ONLY or
  NO rather than PUBLIC-HOSTABLE precisely because a primary-source license grant could not
  be independently confirmed in this pass — re-verify before upgrading any verdict.
