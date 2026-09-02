# Forge Netrunner font bundle

The original commercial Netrunner production fonts are not distributed with
this fixture. Forge uses metrically and stylistically compatible open fonts so
the renderer stays reproducible on every machine:

- Cinzel for the classical display role used by card names.
- Source Serif 4 for rules and italic flavor text.
- Orbitron for the squared technical numerals used in card hardware.
- Lato for compact labels and production metadata.

Each family is bundled under the SIL Open Font License; see the adjacent
`OFL-*.txt` files. The font files came from the upstream Google Fonts
repository. This bundle is an independent production substitute, not an
official Null Signal Games font kit.

For a local production workstation, `layout.yaml` may also name an ignored
`*.local.ttf` override. Forge uses it only when the file already exists on that
machine and otherwise renders with the versioned open fallback. The local file
is never committed or distributed by this project.
