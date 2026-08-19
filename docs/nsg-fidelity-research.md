# Null Signal Games / Netrunner: What's Legally Reusable for High-Fidelity Card Rendering

Research date: 2026-08-19. Scope: can a third-party platform (this project) render or edit
NETRUNNER cards at high visual fidelity, legally, using something Null Signal Games (NSG)
or the surrounding community has actually made available for reuse?

## Verdict

**Partial.** There is no legal path to a third party hosting or serving pixel-identical
reproductions of official NSG card art, frames, or backs at platform scale — NSG's Visual
Assets page says this in plain language ("Card art, frames, and card backs are unavailable
for use by the public"). But three narrower, genuinely legal paths do exist and can be
combined: (1) NSG's official CC BY-ND 4.0 icon/glyph pack for authentic faction and game
symbols; (2) NSG's own free, pay-what-you-want Print-and-Play PDFs plus NetrunnerDB's and
proxynexus.net's print tools, which a platform can link to (or let a user download through)
for that user's own personal proxy printing — home-printed proxies are explicitly
tournament-legal; and (3) the community-maintained `netrunner-cards-json` text/data
repository, which is what NetrunnerDB itself runs on, for card names/costs/rules text —
though this is fan-tolerated infrastructure, not an openly licensed dataset (its own
COPYRIGHT.md still asserts FFG/WotC copyright over the contents). Full "looks exactly like
the official card" fidelity is only achievable either (a) per-user, out of app, when someone
prints/owns the real card, or (b) via an original, homage-style frame that borrows only the
openly licensed glyphs and the fan-tolerated text layer. No evidence of an NSG API, asset
license, or written permission grant for third-party commercial redistribution of card
images was found anywhere in official channels or GitHub.

## Sources Checked

| # | URL | What it provides | License | Usable for us? |
|---|-----|-------------------|---------|-----------------|
| 1 | https://nullsignal.games/about/frequently-asked-questions/ | FAQ: PnP explanation, proxy pointer, card-back policy | N/A (policy text, not a license) | Conditional — informs rules, grants nothing itself |
| 2 | https://nullsignal.games/about/nsg-visual-assets/ | Icon/glyph asset pack (SVG) | CC BY-ND 4.0 | Yes, for icons/glyphs only |
| 3 | https://access.nullsignal.games/Visual%20Assets/NSG-Visual-Assets_v1.5.zip | The actual asset zip (glyphs/symbols, SVG) | CC BY-ND 4.0 | Yes, for icons/glyphs only |
| 4 | https://nullsignal.games/ | Homepage, current news, product catalog entry point | N/A | Informational |
| 5 | https://nullsignal.games/products/ | Full current product catalog (System Gateway, Elevation, Vantage Point, etc.) | N/A | Informational |
| 6 | https://nullsignal.games/products/system-gateway/ | Exact PnP PDF links + purchase links for System Gateway | "Pay what you'd like" PnP; art still NSG-copyrighted | Conditional — personal-use print only |
| 7 | https://nullsignal.games/products/system-update-2021/ | Exact PnP PDF links for System Update 2021 | Same as above | Conditional — personal-use print only |
| 8 | https://nullsignal.games/products/vantage-point/ | Exact PnP PDF links for Vantage Point (latest set, March 2026) | Same as above | Conditional — personal-use print only |
| 9 | https://nullsignal.games/files/Organized_Play_Policies.pdf (NISEI OP Policies v1.3) | Tournament rules incl. proxy legality | N/A (rules doc) | Confirms proxies ARE tournament-legal |
| 10 | https://netrunnerdb.com/en/print/ | Official-adjacent print/proxy generator (NSG "enhanced and maintained") | Restricted to NSG-legal cards; images still copyrighted | Conditional — link-out tool, not a data source |
| 11 | https://proxynexus.net/ | Community proxy generator NSG links to from product pages | Site itself: unclear; see repo below | Conditional — link-out tool |
| 12 | https://github.com/Null-Signal-Games (org, 12 repos) | NSG's actual GitHub org (correct name is hyphenated) | Mixed, per-repo | See rows below |
| 13 | https://github.com/Null-Signal-Games/netrunner-cards-json | Card TEXT/metadata (names, costs, factions, rules text) as JSON; powers NetrunnerDB | GitHub shows "Other/NOASSERTION"; repo's `COPYRIGHT.md` asserts FFG/WotC copyright over the data | Conditional / gray area — de facto tolerated, not an open license |
| 14 | https://github.com/Null-Signal-Games/netrunnerdb | NetrunnerDB.com's actual deckbuilder application source (PHP/Symfony) | MIT | Yes, for app/rendering code — does NOT include card images (see README) |
| 15 | https://github.com/Null-Signal-Games/netrunner-font | Reserved repo name for a font | Apache-2.0 | No — repo is an empty stub (title-only README, boilerplate LICENSE, no font files) |
| 16 | https://github.com/Null-Signal-Games/netrunnerdb-api-server | NetrunnerDB API server code | Apache-2.0 | Yes, for API/server code architecture; no card art |
| 17 | https://github.com/NetrunnerDB (legacy org, all repos "Public archive") | Predecessor/archived org | Mixed | Superseded by Null-Signal-Games org; not actively maintained |
| 18 | https://github.com/NetrunnerDB/netrunnerdb-font | Font/glyph webfont used by NetrunnerDB's old site | Unconfirmed — fetch attempts (raw LICENSE/README at master and main) returned empty | Unverified — do not assume reusable |
| 19 | https://github.com/jbargu/netrunner-extractor | Script that extracts card images directly out of NSG's own System Gateway PnP PDF and adds print bleed | None (all rights reserved by default) | No — repackages NSG's copyrighted art; grants no new rights |
| 20 | https://github.com/lukifer/selfmodcard | Browser-based Netrunner-style card creator/editor | Code: Unlicense (public domain). Visual templates: credited to Reddit user "Mnemic," license not independently verified | Conditional — code freely reusable; template art provenance/license unverified, treat as risky |
| 21 | https://github.com/CryptoGraham278/ANR-Proxy-PDF-Generator | Jupyter notebook that lays out a proxy PDF from a JSON lookup ("cards not included") | None | No — layout tool only, includes no card art itself |
| 22 | https://github.com/axmccx/proxynexus | Original (archived) Proxy Nexus web app | None | No — archived, unlicensed |
| 23 | https://github.com/axmccx/proxynexus-rs | Active Rust rewrite of Proxy Nexus (powers proxynexus.net); generalized proxy generator for multiple LCGs | AGPL-3.0 | Yes, the *code* (compositing/print-sheet engine) is reusable under AGPL copyleft — does not solve card-art sourcing |
| 24 | https://github.com/mcwookie/proxynexus-set-card-lists | Card/set list metadata companion to Proxy Nexus | CC0-1.0 (public domain) | Yes, for this third party's own compiled list data (not an NSG grant) |
| 25 | https://www.reddit.com/r/Netrunner/comments/beu869/ (cited by row 2, not independently fetchable — blocked by fetch tool) | Community-made generic card backs ("System Backup Proxy Backs") | CC BY-NC 4.0 per NSG's own description | Conditional — non-commercial only per its license |

## The Print-and-Play (PnP) Files

Every current NSG Netrunner product ships a free "Print and Play" section with the identical
disclaimer, confirmed verbatim on three separate product pages (System Gateway, System
Update 2021, Vantage Point — spanning old and brand-new releases, so this is a stable,
ongoing policy, not a one-off):

> "Pay what you'd like and print on your own printer! This file contains full-color art of
> card faces, with no bleed or card backs. We recommend that you cut the cards out and sleeve
> them in opaque sleeves using a standard-sized game card as backing."
> — https://nullsignal.games/products/system-gateway/ (identical text on system-update-2021
> and vantage-point product pages)

Exact current URLs (each set has 4 variants: A4 vs Letter paper, 1x vs 3x/playset quantity):

**System Gateway – Remastered Edition**
- https://access.nullsignal.games/Gateway/English/English/SystemGatewayEnglish-A4%20Printable%20Sheets%201x.pdf
- https://access.nullsignal.games/Gateway/English/English/SystemGatewayEnglish-A4%20Printable%20Sheets%203x.pdf
- https://access.nullsignal.games/Gateway/English/English/SystemGatewayEnglish-Letter%20Printable%20Sheets%201x.pdf
- https://access.nullsignal.games/Gateway/English/English/SystemGatewayEnglish-Letter%20Printable%20Sheets%203x.pdf

**System Update 2021 – Remastered Edition**
- https://access.nullsignal.games/Update/english/English/SystemUpdate2021English-A4%20Printable%20Sheets%201x.pdf
- https://access.nullsignal.games/Update/english/English/SystemUpdate2021English-A4%20Printable%20Sheets%203x.pdf
- https://access.nullsignal.games/Update/english/English/SystemUpdate2021English-Letter%20Printable%20Sheets%201x.pdf
- https://access.nullsignal.games/Update/english/English/SystemUpdate2021English-Letter%20Printable%20Sheets%203x.pdf

**Vantage Point** (latest set, released March 2026 — note the URL *structure* changed from
the older `/<Set>/English/...` pattern to `/Sets/PnPs/<Set Name>/English/...`, so a platform
cannot assume a stable predictable URL formula across sets; each must be looked up per
product page):
- https://access.nullsignal.games/Sets/PnPs/Vantage%20Point/English/Vantage-Point-English-A4-PNP-x3.pdf
- https://access.nullsignal.games/Sets/PnPs/Vantage%20Point/English/Vantage-Point-English-A4-PNP-x1.pdf
- https://access.nullsignal.games/Sets/PnPs/Vantage%20Point/English/Vantage-Point-English-PNP-Letter-x3.pdf
- https://access.nullsignal.games/Sets/PnPs/Vantage%20Point/English/Vantage-Point-English-PNP-Letter-x1.pdf

**Are proxies from these PnP files tournament-legal?** Yes, explicitly and repeatedly
confirmed:

> "Home-printed proxies are accepted at all levels of organized play."
> — https://nullsignal.games/products/vantage-point/ (2026)

> "A 'proxy' is a stand-in for a legal card in a player's deck that the participant does not
> physically have with them. Proxies are permitted at all NISEI events... Proxies that are
> professionally printed on cardstock so as to closely resemble ordinary cards are also
> acceptable."
> — Organized Play Policies v1.3, https://nullsignal.games/files/Organized_Play_Policies.pdf

Important limits on what this actually grants:
- The PnP files explicitly **exclude card backs** — NSG FAQ: "We don't distribute our card
  backs, as we'd prefer to retain control over what gets put opposite them."
  (https://nullsignal.games/about/frequently-asked-questions/)
- This is a "download the PDF and print it yourself" grant, not a redistribution license.
  The FAQ recommends, for printing individual cards rather than a whole set, using
  NetrunnerDB's print tool or proxynexus.net — i.e. NSG's own guidance is to link out to
  tools, not to re-host the art yourself.
- The art in the PDF is still NSG's copyrighted card art. Nothing in the PnP program grants
  a third party the right to extract, rehost, or serve that art through its own platform to
  other users — it grants each *individual* the right to print for their own play.

## Visual Assets Pack — Exactly What's Included/Excluded

Full pack: https://access.nullsignal.games/Visual%20Assets/NSG-Visual-Assets_v1.5.zip
(SVG format), described at https://nullsignal.games/about/nsg-visual-assets/.

License: **Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0)**.

What's included (per the page): faction/game symbols and icons/glyphs — the small graphic
elements used throughout NSG's cards and UI (e.g., faction icons, click/credit/subroutine
icons), not full card layouts.

Explicit exclusion, quoted verbatim (this is the single most important sentence for this
research):

> "Please note that the license extends only to the assets included in this pack, and does
> not include other Null Signal Games art assets (such as artwork, card frames, or card
> backs). Card art, frames, and card backs are unavailable for use by the public, and their
> use constitutes a violation of Null Signal Games's intellectual property rights and those
> of the artists commissioned by Null Signal Games."
> — https://nullsignal.games/about/nsg-visual-assets/

Also explicit:

> "Please use your own card templates and card backs... Do not use Null Signal Games
> templates or card backs for your alt art card designs."

> "You may not distribute derivative work (remixes) of these assets. ... Editing these
> symbols in a more substantial way, to create a new symbol based on the original, does
> constitute a derivative work, and you are not allowed to distribute it."
> (the ND / NoDerivatives clause — minor recoloring is fine, building a new symbol from it
> is not)

Practical read: this pack lets a platform show *correct, authentic faction/game symbols*
(with attribution, per CC BY-ND term 1(a)) inside an otherwise original card frame. It does
**not** get you official card frames, card backs, or card art under any circumstances.

## Card Data Licensing (NetrunnerDB / netrunner-cards-json) — Can We Host Card Text Publicly?

Short answer: **not with a clean, explicit license — but with a decade of de facto community
tolerance that NSG itself now participates in.**

The canonical card-data repository is
https://github.com/Null-Signal-Games/netrunner-cards-json (120 stars, 92 forks, 2,772
commits, actively updated same week as this research, TypeScript/JSON, described as: "Used
by http://netrunnerdb.com and more"). GitHub's license detector shows "Other/NOASSERTION" —
meaning it found a license-shaped file but couldn't map it to a standard permissive license.
That file is `COPYRIGHT.md`, and it reads, in full:

> "The information in this repository is copyrighted by Fantasy Flight Games and/or Wizards
> of the Coast. This repository is not maintained, produced, endorsed, supported, or
> affiliated with Fantasy Flight Games and/or Wizards of the Coast."
> — https://github.com/Null-Signal-Games/netrunner-cards-json/blob/main/COPYRIGHT.md

This is a copyright *disclaimer*, not a license grant — and it's stale (it doesn't even
mention that NSG itself now owns the org and authors most of the newer card text; the repo
predates NSG's takeover, originally `Alsciende/netrunner-cards-json`). Net effect: the card
names/rules text/flavor text are still asserted as someone else's copyright, and no explicit
permission to redistribute/host that text is granted to third parties. This is the same
posture the whole ecosystem operates under — NetrunnerDB itself runs on this exact data and
carries this footer on every page:

> "The information presented on this site about Android: Netrunner, both literal and
> graphical, is copyrighted by Fantasy Flight Games and/or Null Signal Games. This website
> is not produced, endorsed, supported, or affiliated with Fantasy Flight Games."
> — https://netrunnerdb.com/en/print/

Mitigating factors worth weighing:
- NSG itself now owns and actively maintains the `Null-Signal-Games/netrunner-cards-json`
  repo (2,772 commits, most recent within days of this research) and the NetrunnerDB.com
  site ("Enhanced and maintained by Null Signal Games" — same print page). That's a strong
  signal of tacit, ongoing institutional tolerance for exactly this kind of reuse — but
  tolerance of a specific downstream (NetrunnerDB, a nonprofit-adjacent community tool) is
  not the same as a general public license usable by any third-party (including commercial)
  platform.
- The JSON *schema/structure* (field names, cycle/pack conventions documented in the repo's
  README) is not copyrightable and is freely reusable as a data format.
- The card *mechanical* facts (cost, faction, type, strength numbers) are functional game
  data, generally treated as less protectable than expressive text (flavor text, card
  names, rules-text phrasing) under the idea/expression distinction — but this is a legal
  nuance, not a bright line, and hasn't been tested against NSG specifically.

Separately, `Null-Signal-Games/netrunnerdb` (the actual NetrunnerDB.com deckbuilder
application, PHP/Symfony) **is MIT licensed** (LICENSE: Copyright (c) 2012-2016 Cédric
Bertolini). That covers the *application code* — routing, deckbuilding logic, templating
engine — freely reusable. It explicitly does **not** include card images; its own README
says:

> "How to add card images - Put the card images in `web/card_image/` (`web/card_image/01001.png`, etc.)"
> — https://github.com/Null-Signal-Games/netrunnerdb (README.md)

i.e., every NetrunnerDB deployment has to source card images itself, out of band, from
somewhere else — the MIT license was never meant to (and does not) cover the images.

## Community Tools — Open Frame Templates?

No community tool was found with an unambiguous open license covering actual card-frame
*artwork* (as opposed to code):

- **lukifer/selfmodcard** (https://github.com/lukifer/selfmodcard) — a working browser card
  creator "for Null-Signal-era Netrunner." Its code is Unlicense (public domain). But per its
  own README it uses "Mnemic's high-quality templates," a Reddit community member's fan-made
  card frame graphics — a separate, third-party asset whose license the code's Unlicense
  does not and cannot extend to. (The source Reddit thread could not be independently
  fetched — blocked by this environment's fetch tool — so treat the template art's status as
  unverified rather than confirmed-open.)
- **axmccx/proxynexus-rs** (https://github.com/axmccx/proxynexus-rs, AGPL-3.0, active,
  powers proxynexus.net which NSG's own product pages link to) — the compositing/print-sheet
  *engine* is genuinely open source (AGPL-3.0: reusable, even commercially, but copyleft —
  any modified/hosted version must share source). This solves "how do I lay out a print
  sheet," not "where do I get legal card art" — it's a generic proxy engine also used for
  L5R/AGoT/LotR LCG per a downstream fork's description, meaning it composites whatever card
  images it's given; it doesn't ship or license Netrunner art itself.
- **jbargu/netrunner-extractor** and **CryptoGraham278/ANR-Proxy-PDF-Generator** — both are
  personal automation scripts for extracting/laying out proxies from NSG's own copyrighted
  PnP PDFs. Neither carries a license, and more importantly neither *could* grant new rights
  over NSG's art even if it had one — running someone's extraction script on NSG's PDF does
  not change what you're legally allowed to do with the output.
- NSG's own Visual Assets guidance points to one genuinely-licensed community asset: generic
  card backs shared under **CC BY-NC 4.0** ("these card backs were created by a community
  member and made free for anyone else to use, licensed under CC BY-NC 4.0" —
  https://nullsignal.games/about/nsg-visual-assets/, referencing a 2019 Reddit post). CC
  BY-NC forbids commercial use, which would matter if this platform is or becomes commercial.

Net: no open, verified, ready-to-use Netrunner card *frame* template exists in the wild.
Code for compositing/generating proxies does exist under real open licenses (Unlicense,
AGPL-3.0), but the visual templates layered on top of that code are either unlicensed fan
art or third-party-credited art of unconfirmed status.

## Recommendation — Ranked Paths to "Looks Authentically Netrunner," Legally

1. **Best: original frame + official glyphs + user/community-sourced art, no official art
   hosted server-side.** Build our own card frame (original layout, typography, color
   language distinct enough not to be a copy of NSG's specific templates — NSG explicitly
   asks fan projects to do exactly this: "please create your own card templates and card
   backs"). Pull in the CC BY-ND 4.0 faction/game glyphs for correctness and instant visual
   authenticity on the one asset class that's actually clean. Source card *text* from
   `netrunner-cards-json` on the same fan-tolerance basis the rest of the ecosystem
   (including NSG-maintained NetrunnerDB) already operates on, with attribution and a
   copyright disclaimer matching NSG's own footer language. For card *art*, never host NSG's
   art ourselves — either let each user supply/scan their own owned card images (their
   personal copy, their personal use — mirrors the PnP/proxy model NSG already blesses) or
   deep-link out to the official PnP PDFs / NetrunnerDB print tool / proxynexus.net for the
   user to generate their own proxy. This is the only option that gets both "in-app fidelity"
   and a defensible legal posture, because it never puts us in the business of redistributing
   NSG's copyrighted images to third parties. Tradeoff: our default/no-user-image state won't
   look identical to an official card — it'll look like a well-made compatible tool (the
   NetrunnerDB/Jinteki.net model), not a mirror of the official product.

2. **Good, lower effort: link-out only, render abstractions in-app.** Don't attempt in-app
   card-face rendering at all beyond text + glyph. For anything resembling "see the real
   card," send the user to NSG's official PnP PDFs, NetrunnerDB's print tool, or
   proxynexus.net. Zero infringement risk, zero art pipeline to build or maintain, but the
   in-app experience is visibly not "the real card" until the user leaves the platform.

3. **Partial, monitor over time: NSG's `netrunner-font` repo.** NSG has already reserved an
   Apache-2.0 (permissive, commercial-friendly) license for a font at
   `Null-Signal-Games/netrunner-font`, but as of this research the repo is an empty stub (a
   one-line README and boilerplate LICENSE, no actual font files). If/when NSG populates it,
   this becomes a clean, free typography asset worth revisiting — it's the strongest signal
   we found that NSG is moving toward open-sourcing *some* production assets over time.
   Action: no code change now, but worth a periodic check.

4. **Not recommended: direct extraction or rehosting of official PnP/card art**
   (e.g., adapting tools like `netrunner-extractor` to serve card images through our
   platform). This is the one thing NSG's own policy explicitly and unambiguously prohibits
   for third parties ("Card art, frames, and card backs are unavailable for use by the
   public, and their use constitutes a violation of Null Signal Games's intellectual
   property rights"). The PnP program's "pay what you'd like, print at home" framing is
   personal-use permission, not a redistribution license, and NSG's own guidance (pointing
   people to NetrunnerDB/proxynexus for single-card proxies rather than offering a bulk/API
   download) reinforces that they intend this to stay individual, not platform-scale.

5. **Not viable today: a full official card-image API or bulk license.** No such offering,
   API, or written permission was found anywhere in NSG's public materials, GitHub
   organization, or the broader community. If genuinely needed, the only path is directly
   asking NSG (a small volunteer-run nonprofit — contact via their site/Discord/Ko-fi
   channels) for a specific written grant; nothing in this research suggests such a request
   would be precedented or expected to succeed, but NSG has shown a clear pattern of
   incrementally open-sourcing infrastructure (MIT deckbuilder, Apache API server, CC BY-ND
   glyphs, a reserved-but-empty Apache font repo), so it is not a closed door.

### Context for this repo

This platform already has a Netrronner System Gateway implementation
(`examples/_fixtures/netrunner-sg`, `examples/netrunner-urbp`,
`beta-site/editor-netrunner.html`). This research should be read as the legal grounding for
whatever card-frame approach that implementation already takes: if it renders an original
frame, option 1 above confirms that's the correct legal posture and shows exactly which NSG
assets (glyphs) can be pulled in directly, and which (frames/backs/art) must stay
original. If it currently embeds any extracted/official NSG art, that should be revisited
against the "Not recommended" section above.
