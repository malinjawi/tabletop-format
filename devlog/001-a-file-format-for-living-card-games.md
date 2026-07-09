# Devlog #1 — A file format for living card games

*(Draft — edit into your own voice before posting. Suggested venues: your own site first, then r/tabletopgamedesign, BGDF, the Break My Game Discord.)*

I've believed in one idea for years: board games deserve what software got — version
control, forking, and communities that can keep a game alive no matter what happens
to its publisher.

The communities already exist. Null Signal Games has kept Netrunner alive for eight
years, maintaining every card as JSON on GitHub. The ArkhamDB family does the same
for half a dozen LCGs. BSData maintains 169 repos of wargame data. They all invented
the same workflow independently — game data as version-controlled files, reviewed
by pull request — and they all did it with raw JSON and no tooling built for them.

So the first thing I'm building isn't a platform. It's the missing standard: an open
file format for card games, with tools.

This week the format reached v0.1, and it does this, today, from a terminal:

- **Import** a designer's spreadsheet (CSV) — or an NRDB-family JSON repo — into a
  structured game directory in one command
- **Validate** it: schemas plus the checks that matter (every printing points at a
  real card and set, banned cards exist, attributes match their declared types)
- **Render** every card face at print resolution
- **Export** a print-and-play PDF with crop marks, and a working Tabletop Simulator mod
- **Diff** two versions the way a designer thinks: `Wildfire: cost 3 → 4`, not JSON noise
- **Gate publishing** on licensing and asset provenance — every asset declares whether
  it's human-made or AI, and imported content is blocked until its license is resolved

The design choices are stolen from the people who already solved this: two-tier card
identity (rules vs printing) the way Scryfall and NRDB v2 do it; ban lists as dated,
immutable documents; localization as sidecar files; a genre-agnostic attribute system.
As a proof, I imported a real Null Signal pack — their `[credit]` symbols, keywords,
and reprint structure mapped onto the format without losing a byte, then rendered
and exported to TTS through the same pipeline as my own test game.

Everything is open source (Apache-2.0/CC0) and will stay that way. The format has to
be trustworthy before anything built on top of it can be.

What's next: polishing the CLI into a single installable binary, then showing this
to designers and asking the only question that matters — would you switch? If you
maintain a game as a spreadsheet or a JSON repo and want to try importing it, I'd
love to hear what breaks: [contact/repo link].
