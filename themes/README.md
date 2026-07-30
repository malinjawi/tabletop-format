# Card layout themes

A card layout is a **versioned template**: a fixed card DOM (rendered by
`tools/render_html.py`) plus a swappable CSS **theme**. Themes are plain `.css`
files, so they diff, fork, and PR like the rest of a game.

## Use a theme
    python3 tools/render_html.py <game-dir> --theme classic    # or minimal, foil
    python3 tools/render_html.py <game-dir> --png               # + Chromium PNG faces

A game can pin its default: add `theme: foil` to `game.yaml`, or ship a fully
custom `templates/card.css` inside the game (resolved before the built-ins).
Resolution order: `--theme` flag > game's `templates/card.css` > `game.yaml theme:` > classic.

## Built-ins
- `classic` — parchment TCG frame, Cinzel display face
- `minimal` — clean flat card, Inter, lots of whitespace
- `foil`    — dark digital card with a neon type-accent glow

## Write your own
Copy a built-in, rename it (`themes/mytheme.css`), and restyle. The DOM you
target is stable:

    .deck > .card[data-type] > .frame >
        .banner  (.cardname, .cost)
        .art     (.mark)
        .typebar
        .textbox > .rules   (rules symbols become .sym.<symbol> chips)
        .bottom  (.kw, .power[data-p])

Per-type colour comes from `.card[data-type=ember]{--accent:…;--accent2:…}`.
Then render with `--theme mytheme`. Chromium screenshots each `.card` to a
print-ready PNG face (`--png`), feeding the same exporters as `render_cards.py`.
