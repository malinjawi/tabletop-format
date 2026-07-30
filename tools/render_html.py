#!/usr/bin/env python3
"""render_html.py - HTML/CSS card renderer with pluggable themes, v0.2.
Usage: python3 tools/render_html.py <game-dir> [--theme NAME] [-o out.html] [--png]

Card layouts are versioned templates: a fixed card DOM + a swappable CSS theme.
Built-in themes live in themes/<name>.css (classic, minimal, foil); a game picks
one via game.yaml `theme:` or ships its own templates/card.css. Emits a self-
contained sheet. With --png (Playwright + Chromium installed) it screenshots each
.card to exports/html/faces/<id>.png - the Block-D canonical face renderer.
Zero dependency for the HTML itself.
"""
import html, json, re, sys
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parent.parent
TYPE_GLYPH = {"ember": "✦", "ward": "❖", "tool": "⚙", "figure": "☗"}
FONTS = ("https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700"
         "&family=EB+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600;700;800&display=swap")

def esc(s): return html.escape(str(s if s is not None else ""))

def resolve_theme(gd, game, cli):
    themes = ROOT / "themes"
    avail = ", ".join(sorted(t.stem for t in themes.glob("*.css")))
    if cli:
        p = themes / f"{cli}.css"
        if not p.exists(): sys.exit(f"render_html: no theme '{cli}' (available: {avail})")
        return cli, p.read_text()
    local = gd / "templates" / "card.css"
    if local.exists(): return "local", local.read_text()
    name = game.get("theme") or "classic"
    p = themes / f"{name}.css"
    return (name, p.read_text()) if p.exists() else ("classic", (themes / "classic.css").read_text())

def main():
    a = sys.argv[1:]
    if not a: sys.exit("Usage: python3 tools/render_html.py <game-dir> [--theme NAME] [-o out.html] [--png]")
    gd = Path(a[0])
    opt = lambda n: a[a.index(n) + 1] if n in a else None
    out = Path(opt("-o")) if "-o" in a else gd / "exports" / "html" / "cards.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    game = yaml.safe_load((gd / "game.yaml").read_text())
    cards = json.loads((gd / "components/cards.json").read_text())
    syms = {s["key"]: s.get("glyph", "◆") for s in (game.get("symbols") or [])}
    theme, css = resolve_theme(gd, game, opt("--theme"))

    def rich(t):
        return re.sub(r"\[([a-z0-9_]+)\]",
                      lambda m: f'<span class="sym {esc(m.group(1))}">{esc(syms.get(m.group(1), m.group(1)))}</span>',
                      esc(t))

    def card(c):
        typ = c.get("type", ""); at = c.get("attributes") or {}
        cost = at.get("cost"); power = at.get("power")
        sub = " · ".join(c.get("subtypes") or [])
        costs = f'<span class="cost">{esc(cost)}</span>' if cost is not None else ""
        powers = f'<span class="power" data-p="{esc(power)}"></span>' if power is not None else ""
        kw = " · ".join(c.get("keywords") or [])
        return ('<div class="card" data-type="' + esc(typ) + '"><div class="frame">'
                f'<div class="banner"><span class="cardname">{esc(c.get("name",""))}</span>{costs}</div>'
                f'<div class="art"><span class="mark">{TYPE_GLYPH.get(typ,"◆")}</span></div>'
                f'<div class="typebar">{esc(typ)}{(" · " + esc(sub)) if sub else ""}</div>'
                f'<div class="textbox"><div class="rules">{rich(c.get("text",""))}</div></div>'
                f'<div class="bottom"><span class="kw">{esc(kw)}</span>{powers}</div></div></div>')

    grid = "\n".join(card(c) for c in cards)
    doc = (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
           f'<title>{esc(game.get("title",""))} — cards ({esc(theme)})</title>'
           f'<link rel="preconnect" href="https://fonts.googleapis.com">'
           f'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
           f'<link href="{FONTS}" rel="stylesheet"><style>'
           '*{box-sizing:border-box}'
           'body{margin:0;padding:30px;background:#e9edf2;font-family:Inter,-apple-system,sans-serif}'
           'h1{font:700 21px/1.2 Inter,sans-serif;margin:0 0 3px;color:#232830}'
           '.sub{color:#66707c;font-size:13px;margin:0 0 22px;max-width:760px}'
           f'{css}</style></head><body>'
           f'<h1>{esc(game.get("title",""))}</h1>'
           f'<p class="sub">HTML/CSS render · theme: <b>{esc(theme)}</b> · {len(cards)} cards. '
           f'The card template is versioned in the repo — swap the theme CSS to restyle every card.</p>'
           f'<div class="deck" data-theme="{esc(theme)}">{grid}</div></body></html>')
    out.write_text(doc, encoding="utf-8")
    print(f"HTML cards ({theme} theme) -> {out}  ({len(cards)} cards)")

    if "--png" in a:
        try:
            from playwright.sync_api import sync_playwright
            fdir = out.parent / "faces"; fdir.mkdir(exist_ok=True)
            with sync_playwright() as p:
                b = p.chromium.launch(); pg = b.new_page(device_scale_factor=3)
                pg.goto(out.resolve().as_uri()); pg.wait_for_timeout(400)
                for i, el in enumerate(pg.query_selector_all(".card")):
                    el.screenshot(path=str(fdir / f"{cards[i].get('id','card'+str(i))}.png"))
                b.close()
            print(f"  rasterized {len(cards)} PNG faces -> {fdir} (Chromium)")
        except Exception as e:
            print(f"  --png skipped ({e}); install: pip install playwright && playwright install chromium")

if __name__ == "__main__":
    main()
